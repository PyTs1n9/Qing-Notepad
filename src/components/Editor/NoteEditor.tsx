import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { message, open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useNoteStore } from "@/stores/noteStore";
import { useTabStore } from "@/stores/tabStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { toast } from "@/stores/toastStore";
import { t, tWithParams } from "@/utils/i18n";
import {
  saveNoteContent,
  loadNoteContent,
  savePolishSnapshot,
  saveImageAttachment,
} from "@/utils/storage";
import { useAiStore } from "@/stores/aiStore";
import { NOTE_EXTERNAL_SAVE_EVENT } from "@/utils/ai/noteWrite";
import type { EditorView } from "@codemirror/view";
import { Save, Pin, FileDown, AppWindow } from "lucide-react";
import { createStickyNote, closeStickyNote, isStickyOpen } from "@/utils/stickyManager";
import { NOTE_WINDOW_MAIN_SAVED_EVENT, NOTE_WINDOW_SAVED_EVENT, openNoteWindow } from "@/utils/noteWindow";
import { useEditorZoom } from "@/utils/editorZoom";
import { registerNoteFlusher } from "@/utils/noteFlush";
import { setActiveEditor } from "@/utils/editorHandle";
import MarkdownSourceEditor from "@/components/Editor/MarkdownSourceEditor";
import EditorMenuBar from "@/components/Editor/EditorMenuBar";
import EditorStatusBar, { type SaveState } from "@/components/Editor/EditorStatusBar";
import NoteOutlinePanel from "@/components/Editor/NoteOutlinePanel";
import { extractOutline, type OutlineHeading } from "@/utils/noteOutline";
import { computeMarkdownStats } from "@/utils/markdownStats";
import { useOutlineNavigation } from "@/hooks/useOutlineNavigation";
import { htmlToMarkdown, isStoredEditorHtml } from "@/utils/htmlToMarkdown";
import { imageExtensionOf, insertImageMarkdown } from "@/utils/noteImages";
import { insertTable } from "@/utils/markdownCommands";
import { flushTableEdit } from "@/utils/livePreview/tableEditing";

// Configure marked

const DERIVED_TITLE_MAX_LENGTH = 40;

/**
 * Local notes offer two panes: live rendering and the raw-source escape hatch.
 * `preview` / `split` stay in the cloud editor only, so the switch is handed
 * this set instead of a hard-coded three.
 */
const LOCAL_MARKDOWN_VIEWS = ["live", "source"] as const;
type LocalMarkdownView = (typeof LOCAL_MARKDOWN_VIEWS)[number];

/** Stable identity so a closed outline does not invalidate the memo every render. */
const NO_HEADINGS: OutlineHeading[] = [];

/**
 * The note page no longer has a title field. A note keeps whatever title it was
 * created with (imported files carry their file name); a note whose title is
 * still blank adopts its first non-empty body line so the sidebar, tab strip and
 * sticky windows stay readable instead of all showing "untitled".
 */
function deriveTitleFromContent(content: string): string {
  const firstLine = content
    .slice(0, 600)
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  if (!firstLine) return "";

  return firstLine
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DERIVED_TITLE_MAX_LENGTH)
    .trim();
}

interface NoteEditorProps {
  /**
   * Export is a note-level action: it used to sit in the title-bar portal, which
   * was the only way to reach it. The editor toolbar is its owner now.
   */
  onExportNote?: () => void;
}

const NoteEditor: React.FC<NoteEditorProps> = ({ onExportNote }) => {
  const { notes, activeNoteId, updateNote } = useNoteStore();
  const lang = useSettingsStore((s) => s.lang);
  const autoSaveInterval = useSettingsStore((s) => s.autoSaveInterval);
  const codeMirrorViewRef = useRef<EditorView | null>(null);


  // Refs to avoid stale closures in editor callbacks
  const activeNoteIdRef = useRef<string | null>(null);
  const mdContentRef = useRef("");

  // Live rendering is the default surface for a note. It shares the source
  // editor until the decoration layer lands, so switching to `source` only
  // removes the rendering, never the document.
  const [markdownViewMode, setMarkdownViewMode] = useState<LocalMarkdownView>("live");
  const [mdContent, setMdContent] = useState("");
  const [editorSessionVersion, setEditorSessionVersion] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Dirty state is tracked per note in the tab store, so each tab can show its
  // own unsaved dot and switching notes can never leak a stale flag.
  const dirtyIds = useTabStore((s) => s.dirtyIds);
  const markDirty = useTabStore((s) => s.markDirty);
  const [isSaving, setIsSaving] = useState(false);
  const [stickyOpen, setStickyOpen] = useState(false);
  // Outline column. Session-scoped on purpose: switching notes must not lose
  // the user's choice, but a restart starts quiet rather than reopening a
  // 220px column over yesterday's document.
  const [outlineOpen, setOutlineOpen] = useState(false);
  // 纯预览编辑: content stays rendered everywhere and a table cell is edited in
  // place. Session-scoped like the outline column — switching notes keeps the
  // choice, a restart starts in the ordinary two-mode editor.
  const [purePreview, setPurePreview] = useState(false);
  // The status bar shows when the file was last written, not when a key was
  // last pressed: `noteStore.updateNote` touches `updatedAt` on every
  // keystroke, so the store value would tick while the user types.
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const { fontSize: editorFontSize, zoomIn, zoomOut, resetZoom } = useEditorZoom(editorContainerRef, {
    initialSize: 16,
  });
  // Body typeface lives in settings; the editor reconfigures in place when it
  // changes, so switching fonts never tears the view down.
  const editorFontFamily = useSettingsStore((s) => s.editorFontFamily);
  const isSavingRef = useRef(false);

  const activeNote = notes.find((n) => n.id === activeNoteId);
  const isDirty = activeNoteId ? dirtyIds.includes(activeNoteId) : false;

  // Both derive from the buffer, so they move with every keystroke — that is
  // the requirement ("实时响应当前编辑内容"). The outline is only scanned while
  // the column is open: a full heading pass on every keystroke of a 5000-line
  // note is work nobody can see. The statistics are always live.
  const outline = useMemo(
    () => (outlineOpen ? extractOutline(mdContent) : NO_HEADINGS),
    [mdContent, outlineOpen],
  );
  const stats = useMemo(() => computeMarkdownStats(mdContent), [mdContent]);
  // Jump + highlight live in a hook: the detached note window renders the same
  // column and must share the 16px/8px coordinate corrections rather than
  // re-derive them.
  const { activeLine: outlineActiveLine, jumpTo: handleOutlineSelect } = useOutlineNavigation(
    codeMirrorViewRef,
    outline,
    outlineOpen,
    editorSessionVersion,
  );
  const saveState: SaveState = isSaving ? "saving" : isDirty ? "dirty" : "saved";

  const resetEditorContent = useCallback((value: string) => {
    mdContentRef.current = value;
    setMdContent(value);
    setCanUndo(false);
    setCanRedo(false);
    setEditorSessionVersion((version) => version + 1);
  }, []);

  const getCurrentEditorContent = useCallback(() => {
    // An open table cell holds text that is not in the document yet. Every caller
    // of this (Ctrl+S, autosave, `registerNoteFlusher`, the sample taken when
    // switching notes) means "what the user can see", so the cell is committed
    // first — the commit dispatches, which refreshes `mdContentRef` synchronously.
    const view = codeMirrorViewRef.current;
    if (view) flushTableEdit(view);
    return mdContentRef.current;
  }, []);

  // Track sticky window open state via polling (lightweight check)
  useEffect(() => {
    if (!activeNoteId) { setStickyOpen(false); return; }
    setStickyOpen(isStickyOpen(activeNoteId));
    const timer = setInterval(() => {
      setStickyOpen(isStickyOpen(activeNoteId));
    }, 500);
    return () => clearInterval(timer);
  }, [activeNoteId]);

  // Keep refs in sync with state
  useEffect(() => {
    activeNoteIdRef.current = activeNoteId;
  }, [activeNoteId]);

  useEffect(() => {
    mdContentRef.current = mdContent;
  }, [mdContent]);

  // Save function: persists current content to disk and notifies sticky windows
  const doSave = useCallback(async () => {
    const noteId = activeNoteIdRef.current;
    if (!noteId || isSavingRef.current) return;
    const contentToSave = getCurrentEditorContent();
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const result = await saveNoteContent(noteId, contentToSave);
      if (result.status !== "ok") {
        // A linked note's file can be changed or locked by another program. The
        // tab strip must keep its dirty dot: reporting a write that never
        // happened is the one failure mode this editor cannot recover from.
        markDirty(noteId, true);
        toast(
          t(
            lang,
            result.status === "conflict"
              ? "externalSaveConflictEditor"
              : result.status === "missing"
                ? "externalFileMissing"
                : result.status === "unsupported"
                  ? "externalEncodingUnsupported"
                  : "externalFileReadOnly",
          ),
          "danger",
        );
        return;
      }
      markDirty(noteId, false);
      // Notify open sticky windows to update
      emit("sticky:note-updated", { noteId, content: contentToSave });
      // The detached note window is a second editor for the same file: push the
      // revision so it does not save a stale buffer back over this one.
      emit(NOTE_WINDOW_MAIN_SAVED_EVENT, { noteId, content: contentToSave });
      // The status bar shows write time, not typing time.
      setSavedAt(Date.now());
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [getCurrentEditorContent, lang, markDirty]);

  // Expose a flush hook so the sidebar can persist pending edits before deleting.
  useEffect(() => {
    registerNoteFlusher(async (noteId) => {
      if (noteId !== activeNoteIdRef.current) return;
      await doSave();
    });
    return () => registerNoteFlusher(null);
  }, [doSave]);

  // Track previous activeNoteId to detect switches
  const prevNoteIdRef = useRef<string | null>(null);
  // Guard against stale async loadNoteContent callbacks (race condition)
  const loadingNoteIdRef = useRef<string | null>(null);
  // Note id whose content is actually sitting in the buffer right now. The
  // buffer is cleared before a load resolves, so "which note does the buffer
  // belong to" cannot be derived from activeNoteId alone.
  const loadedNoteIdRef = useRef<string | null>(null);

  // When activeNoteId changes: persist the previous note, then load the new one.
  // The two steps are serialized on purpose. With a tab strip, switching is a
  // one-click operation users repeat quickly; letting the load run ahead of the
  // pending write made the editor re-read stale disk content and drop keystrokes.
  useEffect(() => {
    const prevId = prevNoteIdRef.current;
    const currentId = activeNoteId;
    prevNoteIdRef.current = currentId;

    let cancelled = false;
    // Capture the outgoing buffer before the editor is cleared below.
    const pendingContent =
      prevId && prevId !== currentId ? getCurrentEditorContent() : null;

    const persistPrevious = async () => {
      if (!prevId || prevId === currentId || pendingContent === null) return;
      // The buffer only holds prevId's text once that note finished loading.
      // Two tabs closed in quick succession (Ctrl+W, or a fast double click on
      // the close button) leave the buffer empty while the next note is still
      // being read; writing it back would truncate that note on disk.
      if (loadedNoteIdRef.current !== prevId) return;
      // Never resurrect a note that was just deleted (it may already live in the
      // recycle bin); writing it back would create an orphan .md file.
      const stillExists = useNoteStore.getState().notes.some((note) => note.id === prevId);
      if (!stillExists) return;
      try {
        const result = await saveNoteContent(prevId, pendingContent);
        // Only clear the flag once the write landed, otherwise a failed save
        // would silently look saved in the tab strip.
        if (result.status === "ok") {
          markDirty(prevId, false);
        } else {
          console.error("Failed to save the previous note:", prevId, result.message);
        }
      } catch (e) {
        console.error("Failed to save previous note:", e);
      }
    };

    if (!currentId) {
      loadingNoteIdRef.current = null;
      resetEditorContent("");
      setSavedAt(null);
      void persistPrevious();
      // Clear the marker only after the flush above has been invoked: it reads
      // this ref to decide whether the buffer belonged to the closing note.
      loadedNoteIdRef.current = null;
      return;
    }

    // Clear editor immediately before loading. The dirty flag belongs to the
    // note, not the component, so it is intentionally left alone here.
    resetEditorContent("");
    // The bar must never show the previous note's write time while this one
    // loads.
    setSavedAt(null);
    loadingNoteIdRef.current = currentId;

    void persistPrevious()
      .then(() => loadNoteContent(currentId))
      .then((content) => {
        // Discard stale result if user already switched to another note
        if (cancelled || loadingNoteIdRef.current !== currentId) return;
        let markdownContent = "";
        if (content) {
          markdownContent = isStoredEditorHtml(content) ? htmlToMarkdown(content) : content;
        }
        resetEditorContent(markdownContent);
        loadedNoteIdRef.current = currentId;
        // A note stored without a title (older data, quick capture) picks up its
        // first line here too, so opening it is enough to make it identifiable.
        const loadedNote = useNoteStore.getState().notes.find((note) => note.id === currentId);
        const storedUpdatedAt = loadedNote ? Date.parse(loadedNote.updatedAt) : Number.NaN;
        // Reopening a note is not an edit: the bar keeps the file's own time,
        // which `updateNote(..., { touchUpdatedAt: false })` below preserves.
        setSavedAt(Number.isNaN(storedUpdatedAt) ? null : storedUpdatedAt);
        const derivedTitle =
          loadedNote && !loadedNote.title.trim() ? deriveTitleFromContent(markdownContent) : "";
        updateNote(
          currentId,
          derivedTitle ? { content: markdownContent, title: derivedTitle } : { content: markdownContent },
          { touchUpdatedAt: false },
        );
        markDirty(currentId, false);
      })
      .catch((e) => console.error("Failed to load note:", e));

    return () => {
      cancelled = true;
    };
  }, [activeNoteId, getCurrentEditorContent, resetEditorContent]); // eslint-disable-line

  useEffect(() => {
    if (!autoSaveInterval || !activeNoteId) return;
    const timer = setInterval(() => {
      if (!activeNoteIdRef.current || !isDirty) return;
      doSave();
    }, autoSaveInterval);
    return () => clearInterval(timer);
  }, [autoSaveInterval, activeNoteId, isDirty, doSave]);

  // External writes reload the open buffer: sticky-window saves and AI note
  // edits (permission mode "full") both land here.
  useEffect(() => {
    const handler = (event: { payload: { noteId: string; content: string } }) => {
      const { noteId: savedId, content } = event.payload;
      if (savedId !== activeNoteIdRef.current) return;
      if (typeof content !== "string") return;
      if (isStoredEditorHtml(content)) {
        resetEditorContent(htmlToMarkdown(content));
      } else {
        resetEditorContent(content);
      }
      markDirty(savedId, false);
    };
    const unlisten = [
      listen<{ noteId: string; content: string }>("sticky:note-saved", handler),
      listen<{ noteId: string; content: string }>(NOTE_EXTERNAL_SAVE_EVENT, handler),
    ];
    return () => {
      unlisten.forEach((pending) => pending.then((fn) => fn()));
    };
  }, [resetEditorContent]);

  // A save from the detached note window. Sticky saves reload unconditionally
  // because a sticky is a companion view of a note the user is not editing
  // here; the detached window is a full editor, so an unsaved buffer in *this*
  // window wins. Reloading it would discard text the user is still typing,
  // which is worse than the two windows briefly disagreeing.
  useEffect(() => {
    const unlisten = listen<{ noteId: string; content: string }>(
      NOTE_WINDOW_SAVED_EVENT,
      (event) => {
        const { noteId: savedId, content } = event.payload;
        if (typeof content !== "string") return;
        const isActive = savedId === activeNoteIdRef.current;
        const hasLocalEdits = useTabStore.getState().dirtyIds.includes(savedId);

        if (isActive) {
          // The buffer here wins over a background window while it is dirty.
          // The pending save below will refresh the metadata on its own.
          if (hasLocalEdits) return;
          resetEditorContent(isStoredEditorHtml(content) ? htmlToMarkdown(content) : content);
          markDirty(savedId, false);
          setSavedAt(Date.now());
        }
        // The detached window writes the .md file directly, so nothing else
        // refreshes this note's metadata. Without this the sidebar, the tab
        // strip and the status bar would keep the pre-detached timestamp (and
        // the assistant would read a stale body) until the note is reopened.
        updateNote(savedId, { content }, { touchUpdatedAt: true });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [resetEditorContent, markDirty, updateNote]);

  // Ctrl+S / Cmd+S save handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isSaveShortcut =
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key.toLowerCase() === "s" || e.code === "KeyS");

      if (isSaveShortcut) {
        e.preventDefault();
        e.stopPropagation();
        void doSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [doSave]);

  // Save markdown content on change (update store only, no disk write)
  const handleMdChange = useCallback(
    (value: string) => {
      if (value === mdContentRef.current) return;
      mdContentRef.current = value;
      setMdContent(value);
      const noteId = activeNoteIdRef.current;
      if (!noteId) return;
      // Ownership guard. A commit fired by `getCurrentEditorContent` can land one
      // change *after* a note switch, while the editor still holds the previous
      // document; without this the outgoing note's text would be written into the
      // incoming note's store entry (and marked dirty).
      //
      // Only a *known* previous owner blocks the write: while nothing has loaded
      // yet (`null`, a failed load included) the buffer can only hold what the
      // user just typed into this note, and dropping it would lose keystrokes.
      const loaded = loadedNoteIdRef.current;
      if (loaded !== null && loaded !== noteId) return;
      // Only a still-blank title is filled in; an existing one (imported file
      // name, previously derived value) is never overwritten by later edits.
      const current = useNoteStore.getState().notes.find((note) => note.id === noteId);
      const derivedTitle = current && !current.title.trim() ? deriveTitleFromContent(value) : "";
      updateNote(noteId, derivedTitle ? { content: value, title: derivedTitle } : { content: value });
      markDirty(noteId, true);
    },
    [updateNote],
  );

  // AI polish entry: capture the source editor's current selection and hand the
  // rewrite flow to the AI sidebar. The rewrite is written back through the
  // CodeMirror change pipeline, so autosave, dirty tracking and undo history
  // all stay intact.
  const handleAiPolish = useCallback(() => {
    const view = codeMirrorViewRef.current;
    const noteId = activeNoteIdRef.current;
    if (!view || !noteId) return;
    const selection = view.state.selection.main;
    const originalText = view.state.sliceDoc(selection.from, selection.to);
    let appliedSpan: { from: number; to: number; current: string } | null = null;

    useAiStore.getState().startPolish({
      noteId,
      originalText,
      apply: (newText: string) => {
        const expected = appliedSpan ? appliedSpan.current : originalText;
        let from = appliedSpan ? appliedSpan.from : selection.from;
        let to = appliedSpan ? appliedSpan.to : selection.to;
        // The remembered span is plain offsets; intervening edits can shift it.
        // Fall back to locating the passage once, and refuse when ambiguous.
        if (view.state.sliceDoc(from, to) !== expected) {
          const doc = view.state.doc.toString();
          const index = doc.indexOf(expected);
          if (index < 0 || doc.indexOf(expected, index + 1) >= 0) return false;
          from = index;
          to = index + expected.length;
        }
        void savePolishSnapshot(noteId, mdContentRef.current);
        view.dispatch({ changes: { from, to, insert: newText } });
        appliedSpan = { from, to: from + newText.length, current: newText };
        return true;
      },
      undo: () => {
        if (!appliedSpan) return;
        const { from, to, current } = appliedSpan;
        // Later manual edits own the text now; leave it to the editor's undo.
        if (view.state.sliceDoc(from, to) !== current) return;
        view.dispatch({ changes: { from, to, insert: originalText } });
        appliedSpan = null;
      },
    });
    useAiStore.getState().setSidebarOpen(true);
  }, []);

  /** Same store action the tab strip uses, so closing never diverges. */
  const handleCloseTab = useCallback(() => {
    const noteId = activeNoteIdRef.current;
    if (noteId) useTabStore.getState().closeTab(noteId);
  }, []);

  /**
   * The single view-mode setter. 源码档优先: choosing the source view turns
   * 纯预览编辑 off and does not bring it back on the way out, so the two
   * controls can never disagree about what is on screen.
   */
  const handleViewModeChange = useCallback((mode: LocalMarkdownView) => {
    if (mode === "source") setPurePreview(false);
    setMarkdownViewMode(mode);
  }, []);

  /**
   * Source ↔ live. Declared before `Ctrl+/` because the key handler and the
   * status-bar button must drive the same state machine; two independent
   * togglers would eventually disagree about which mode is current.
   */
  const handleToggleSourceMode = useCallback(() => {
    handleViewModeChange(markdownViewMode === "source" ? "live" : "source");
  }, [handleViewModeChange, markdownViewMode]);

  /**
   * 纯预览编辑 toggle.
   *
   * The open table cell is committed before the layer is swapped: switching modes
   * rebuilds the table widget, and its DOM — the field the user is typing in —
   * goes with it.
   */
  const handleTogglePurePreview = useCallback(() => {
    const view = codeMirrorViewRef.current;
    if (view) flushTableEdit(view);
    const next = !purePreview;
    setPurePreview(next);
    // Defensive: the button is disabled in 源码 view, but the mode can also be
    // changed from the menu while this handler is in flight.
    if (next) setMarkdownViewMode((mode) => (mode === "source" ? "live" : mode));
  }, [purePreview]);

  /**
   * Ctrl+/ toggles 实时渲染 ↔ 源码; Ctrl+= / Ctrl+- / Ctrl+Shift+0 zoom.
   *
   * These cannot live in the editor keymap: Ctrl+/ has to work while a menu item
   * or a toolbar button owns the focus. Capture phase plus a containment check
   * keeps them scoped to the note card, so typing in the AI panel never resizes
   * or re-renders the note.
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const container = editorContainerRef.current;
      if (!container || !(event.target instanceof Node) || !container.contains(event.target)) return;

      // Physical codes, not `event.key`: Ctrl+= reports "+" on some layouts and
      // Ctrl+Shift+0 reports ")" — both would miss a character-based check.
      if (event.code === "Slash") {
        event.preventDefault();
        handleToggleSourceMode();
        return;
      }
      if (event.code === "Equal") {
        event.preventDefault();
        zoomIn();
        return;
      }
      if (event.code === "Minus") {
        event.preventDefault();
        zoomOut();
        return;
      }
      if (event.code === "Digit0" && event.shiftKey) {
        event.preventDefault();
        resetZoom();
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [handleToggleSourceMode, zoomIn, zoomOut, resetZoom]);

  // Shared by the toolbar button and Mod-Alt-t, so both paths insert exactly
  // the same skeleton at the caret and leave the caret in the first header cell.
  const handleInsertTable = useCallback(() => {
    const view = codeMirrorViewRef.current;
    if (!view) return;
    view.dispatch(insertTable(view.state));
    view.focus();
  }, []);

  /**
   * Put an attachment reference where the caret is. The note stores only the
   * generated file name, so moving the data directory never breaks a note.
   */
  const insertImageReference = useCallback((filename: string) => {
    const view = codeMirrorViewRef.current;
    if (!view) {
      // Preview-only mode has no caret: append to the end instead of no-oping.
      const snippet = `![](attachment://${filename})`;
      const current = mdContentRef.current;
      const separator = !current || current.endsWith("\n") ? "" : "\n";
      handleMdChange(`${current}${separator}${snippet}\n`);
      return;
    }
    insertImageMarkdown(view, filename);
  }, [handleMdChange]);

  /** Copy the bytes into data/img, then reference the generated file name. */
  const insertImageBytes = useCallback(async (bytes: Uint8Array, extension: string) => {
    const filename = await saveImageAttachment(bytes, extension);
    insertImageReference(filename);
  }, [insertImageReference]);

  const handleInsertImage = useCallback(async () => {
    if (!activeNoteIdRef.current) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      const bytes = new Uint8Array(await readFile(selected));
      await insertImageBytes(bytes, imageExtensionOf(selected));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("Failed to insert an image:", error);
      void message(tWithParams(lang, "insertImageFailed", { message: detail }), {
        title: t(lang, "insertImage"),
        kind: "error",
      }).catch(() => undefined);
    }
  }, [insertImageBytes, lang]);

  /**
   * A pasted screenshot or a dropped image file takes the same route as the
   * toolbar button, so nothing ever lands in the note as an inline base64 blob.
   *
   * The *event* side moved into `inputRules.ts` (rule 10), which listens on the
   * CodeMirror surface — the container listener used to cover the preview pane as
   * well, but the preview pane is no longer reachable in the local editor. This
   * callback stays here because it owns the write path, not the trigger.
   */
  const insertImageFile = useCallback(
    (file: File) => {
      void file
        .arrayBuffer()
        .then((buffer) => insertImageBytes(new Uint8Array(buffer), imageExtensionOf(file.name || file.type)))
        .catch((error) => console.error("Failed to insert an image file:", error));
    },
    [insertImageBytes],
  );

  const handleHistoryChange = useCallback((undoAvailable: boolean, redoAvailable: boolean) => {
    setCanUndo(undoAvailable);
    setCanRedo(redoAvailable);
  }, []);

  const handleCodeMirrorViewChange = useCallback((view: EditorView | null) => {
    codeMirrorViewRef.current = view;
    // The single publication point for "which document do plugins act on".
    // `onViewChange` fires on mount and again with `null` on unmount, which is
    // exactly the lifetime `qing.editor` needs — no second effect, and no way
    // for the two to disagree.
    setActiveEditor(view);
  }, []);

  useEffect(() => {
    requestAnimationFrame(() => codeMirrorViewRef.current?.requestMeasure());
  }, [editorFontSize]);

  /**
   * Outline toggle. Opening or closing the column changes the editor's width;
   * CodeMirror measures itself on resize, but one explicit measure on the next
   * frame removes the single-frame lag where wrapping is still the old one.
   */
  const handleToggleOutline = useCallback(() => {
    setOutlineOpen((open) => !open);
    requestAnimationFrame(() => codeMirrorViewRef.current?.requestMeasure());
  }, []);

  /**
   * Menu → zoom. Must stay above the `!activeNote` early return, together with
   * every other hook: the editor renders the placeholder first (no note open) and
   * only then the note surface, so a hook placed below that return would change
   * the hook count between the two renders — React throws "Rendered more hooks
   * than during the previous render" and unmounts the tree (black window).
   */
  const handleZoom = useCallback(
    (action: "in" | "out" | "reset") => {
      if (action === "in") zoomIn();
      else if (action === "out") zoomOut();
      else resetZoom();
    },
    [zoomIn, zoomOut, resetZoom],
  );

  if (!activeNote) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl bg-bg-secondary flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </div>
          <p className="text-sm">{t(lang, "selectNote")}</p>
          <p className="text-xs mt-1 opacity-70">{t(lang, "orCreateNote")}</p>
        </div>
      </div>
    );
  }

  const parsedUpdatedAt = activeNote ? Date.parse(activeNote.updatedAt) : Number.NaN;
  const updatedAtValue = savedAt ?? (Number.isNaN(parsedUpdatedAt) ? null : parsedUpdatedAt);

  return (
    <div ref={editorContainerRef} className="note-editor-surface flex min-h-0 min-w-0 h-full flex-1 flex-col overflow-hidden">
      {/* Menu bar: 文件 / 编辑 / 段落 / 格式 / 视图. It replaces the icon row on
          purpose — nine icons had no room left for the structural Markdown
          commands, and a menu is the only container that stays honest as that
          list grows. The three state-bearing controls stay outside: a menu item
          cannot show "unsaved" at a glance.
          Height is 2px + 24px + 2px = 28px, one step tighter than the 36px tab
          strip above it: the editor's two own bars (this and the status bar)
          frame the text, so they read as one frame rather than as two more
          app-level strips. The padding is split evenly so the controls stay
          optically centred; `.cm-content` brings its own top padding. */}
      <div className="note-editor-toolbar flex flex-wrap items-center gap-1 gap-y-1 px-4 py-0.5">
        <EditorMenuBar
          lang={lang}
          getView={() => codeMirrorViewRef.current}
          hasEditor={Boolean(activeNote)}
          canUndo={canUndo}
          canRedo={canRedo}
          isDirty={isDirty}
          isSaving={isSaving}
          viewMode={markdownViewMode}
          onViewModeChange={handleViewModeChange}
          onSave={doSave}
          onExport={onExportNote}
          onCloseTab={handleCloseTab}
          onOpenInWindow={() => void openNoteWindow(activeNote.id, activeNote.title)}
          onInsertTable={handleInsertTable}
          onInsertImage={() => void handleInsertImage()}
          onAiPolish={handleAiPolish}
          onZoom={handleZoom}
        />
        <div className="flex-1" />
        <button
          type="button"
          onClick={doSave}
          disabled={!isDirty || isSaving}
          aria-busy={isSaving}
          title={t(lang, "save")}
          aria-label={t(lang, "save")}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${
            isDirty
              ? "bg-accent text-on-accent hover:bg-accent-hover"
              : "text-text-muted cursor-not-allowed opacity-50"
          }`}
        >
          <Save size={14} className={isSaving ? "animate-pulse" : undefined} />
        </button>
        <button
          type="button"
          aria-pressed={stickyOpen}
          onClick={() => {
            if (!activeNoteId) return;
            if (stickyOpen) {
              closeStickyNote(activeNoteId);
            } else {
              createStickyNote(activeNoteId);
            }
          }}
          title={t(lang, stickyOpen ? "unpinSticky" : "pinSticky")}
          aria-label={t(lang, stickyOpen ? "unpinSticky" : "pinSticky")}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${
            stickyOpen
              ? "bg-accent text-on-accent hover:bg-accent-hover"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          }`}
        >
          <Pin size={14} />
        </button>
        <button
          type="button"
          onClick={() => void openNoteWindow(activeNote.id, activeNote.title)}
          title={t(lang, "openInNewWindow")}
          aria-label={t(lang, "openInNewWindow")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <AppWindow size={14} />
        </button>
        <button
          type="button"
          onClick={onExportNote}
          disabled={!onExportNote}
          title={t(lang, "exportFile")}
          aria-label={t(lang, "exportFile")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FileDown size={14} />
        </button>
      </div>

      {/* The shell already frames the editor, so the text surface is flush with
          the card: no second border, radius or tinted panel inside it.
          `relative` is what lets the outline column become an overlay on a
          narrow card (index.css, container query) without a second wrapper. */}
      <div className="note-body relative flex min-h-0 flex-1 overflow-hidden">
        {/* Outline: a real column, so expanding it narrows the text instead of
            covering it. Below 560px the container query flips it to an overlay
            — 220px of a 480px card would leave an unreadable text column. */}
        {outlineOpen && (
          <NoteOutlinePanel
            // Remounting per note drops the filter and the list's scroll
            // offset: a query typed for 昨天's note should not silently hide
            // today's headings.
            key={activeNote.id}
            headings={outline}
            activeLine={outlineActiveLine}
            onSelect={handleOutlineSelect}
            onClose={() => setOutlineOpen(false)}
            lang={lang}
          />
        )}

        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Editor content. One pane: 分屏 is gone — the rendered state is a
              property of this same buffer, not a second view of it. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ fontSize: editorFontSize }}>
            <MarkdownSourceEditor
              key={`${activeNote.id}:${editorSessionVersion}`}
              value={mdContent}
              placeholder={t(lang, "mdPlaceholder")}
              onChange={handleMdChange}
              onHistoryChange={handleHistoryChange}
              onViewChange={handleCodeMirrorViewChange}
              fontSize={editorFontSize}
              fontFamily={editorFontFamily}
              livePreview={markdownViewMode === "live"}
              previewEditing={markdownViewMode === "live" && purePreview}
              onPasteImage={insertImageFile}
              onInsertTable={handleInsertTable}
              lang={lang}
            />
          </div>

          {activeNote.tags.length > 0 && (
            <div className="pointer-events-none absolute bottom-1.5 left-2.5 z-10 flex max-w-[55%] flex-wrap items-center gap-1">
              {activeNote.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-accent-light/85 px-1.5 py-0.5 text-[10px] leading-none text-accent-text"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* The status bar owns updated time, save state and the four counts; the
          floating pill it replaced duplicated them and covered the last line of
          text. Order is fixed (left cluster → gap → right cluster) and is the
          contract for future additions: structure on the left, document state
          on the right. */}
      <EditorStatusBar
        lang={lang}
        outlineOpen={outlineOpen}
        onToggleOutline={handleToggleOutline}
        sourceMode={markdownViewMode === "source"}
        onToggleSourceMode={handleToggleSourceMode}
        purePreview={purePreview}
        onTogglePurePreview={handleTogglePurePreview}
        updatedAt={updatedAtValue}
        saveState={saveState}
        stats={stats}
      />
    </div>
  );
};

export default NoteEditor;
