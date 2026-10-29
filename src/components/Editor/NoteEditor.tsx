import React, { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { message, open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useNoteStore } from "@/stores/noteStore";
import { useTabStore } from "@/stores/tabStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import {
  saveNoteContent,
  loadNoteContent,
  savePolishSnapshot,
  saveImageAttachment,
} from "@/utils/storage";
import { useAiStore } from "@/stores/aiStore";
import { NOTE_EXTERNAL_SAVE_EVENT } from "@/utils/ai/noteWrite";
import { redo as codeMirrorRedo, undo as codeMirrorUndo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { Save, Pin, Sparkles, Undo2, Redo2, Link2, Unlink2, Table, ImagePlus, FileDown } from "lucide-react";
import { createStickyNote, closeStickyNote, isStickyOpen } from "@/utils/stickyManager";
import { handleExternalLinkClick } from "@/utils/externalLinks";
import { renderMarkdown } from "@/utils/markdown";
import { useEditorZoom } from "@/utils/editorZoom";
import { registerNoteFlusher } from "@/utils/noteFlush";
import { setActiveEditor } from "@/utils/editorHandle";
import MarkdownSourceEditor from "@/components/Editor/MarkdownSourceEditor";
import MarkdownViewSwitch, { type MarkdownViewMode } from "@/components/Editor/MarkdownViewSwitch";
import { htmlToMarkdown, isStoredEditorHtml } from "@/utils/htmlToMarkdown";

// Configure marked
/** Extension for an image selected in the dialog or pasted from the clipboard. */
function imageExtensionOf(nameOrMime: string): string {
  if (nameOrMime.includes("/")) return nameOrMime.split("/")[1] || "png";
  const extension = nameOrMime.split(".").pop();
  return extension && extension.length <= 5 ? extension : "png";
}

const DERIVED_TITLE_MAX_LENGTH = 40;

/**
 * Empty 3x3 GFM table inserted by the toolbar button / `Mod-Alt-t`. Two spaces
 * between pipes keep every cell valid when the user types into it.
 */
const TABLE_MARKDOWN = "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n";
/** Offset of the first header cell's text, so the caret lands inside it. */
const TABLE_FIRST_CELL_OFFSET = 2;

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
  const previewRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);
  const scrollSyncEnabledRef = useRef(true);

  // Refs to avoid stale closures in editor callbacks
  const activeNoteIdRef = useRef<string | null>(null);
  const mdContentRef = useRef("");

  // Default to the Markdown source view when a note page is first opened.
  // The user can still switch to preview or split from the toolbar.
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>("source");
  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(true);
  const [mdContent, setMdContent] = useState("");
  const [editorSessionVersion, setEditorSessionVersion] = useState(0);
  const [previewHtml, setPreviewHtml] = useState("");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Dirty state is tracked per note in the tab store, so each tab can show its
  // own unsaved dot and switching notes can never leak a stale flag.
  const dirtyIds = useTabStore((s) => s.dirtyIds);
  const markDirty = useTabStore((s) => s.markDirty);
  const [isSaving, setIsSaving] = useState(false);
  const [showSaveStatus, setShowSaveStatus] = useState(false);
  const [stickyOpen, setStickyOpen] = useState(false);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorFontSize = useEditorZoom(editorContainerRef, { initialSize: 16 });
  const isSavingRef = useRef(false);

  const activeNote = notes.find((n) => n.id === activeNoteId);
  const isDirty = activeNoteId ? dirtyIds.includes(activeNoteId) : false;

  const resetEditorContent = useCallback((value: string) => {
    mdContentRef.current = value;
    setMdContent(value);
    setCanUndo(false);
    setCanRedo(false);
    setEditorSessionVersion((version) => version + 1);
  }, []);

  const getCurrentEditorContent = useCallback(() => {
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
      await saveNoteContent(noteId, contentToSave);
      markDirty(noteId, false);
      // Notify open sticky windows to update
      emit("sticky:note-updated", { noteId, content: contentToSave });
      // Brief flash of "saved" status
      setShowSaveStatus(true);
      setTimeout(() => setShowSaveStatus(false), 2000);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [getCurrentEditorContent, markDirty]);

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
        await saveNoteContent(prevId, pendingContent);
        // Only clear the flag once the write landed, otherwise a failed save
        // would silently look saved in the tab strip.
        markDirty(prevId, false);
      } catch (e) {
        console.error("Failed to save previous note:", e);
      }
    };

    if (!currentId) {
      loadingNoteIdRef.current = null;
      resetEditorContent("");
      void persistPrevious();
      // Clear the marker only after the flush above has been invoked: it reads
      // this ref to decide whether the buffer belonged to the closing note.
      loadedNoteIdRef.current = null;
      return;
    }

    // Clear editor immediately before loading. The dirty flag belongs to the
    // note, not the component, so it is intentionally left alone here.
    resetEditorContent("");
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
      if (noteId) {
        // Only a still-blank title is filled in; an existing one (imported file
        // name, previously derived value) is never overwritten by later edits.
        const current = useNoteStore.getState().notes.find((note) => note.id === noteId);
        const derivedTitle = current && !current.title.trim() ? deriveTitleFromContent(value) : "";
        updateNote(noteId, derivedTitle ? { content: value, title: derivedTitle } : { content: value });
        markDirty(noteId, true);
      }
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

  const handleUndo = useCallback(() => {
    const view = codeMirrorViewRef.current;
    if (view) codeMirrorUndo(view);
  }, []);
  const handleRedo = useCallback(() => {
    const view = codeMirrorViewRef.current;
    if (view) codeMirrorRedo(view);
  }, []);

  // Shared by the toolbar button and Mod-Alt-t, so both paths insert exactly
  // the same skeleton at the caret and leave the caret in the first header cell.
  const handleInsertTable = useCallback(() => {
    const view = codeMirrorViewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc.toString();
    // A table has to start on its own line, otherwise the paragraph above
    // swallows it and nothing renders as a table.
    const prefix = from > 0 && doc[from - 1] !== "\n" ? "\n" : "";
    view.dispatch({
      changes: { from, to, insert: `${prefix}${TABLE_MARKDOWN}` },
      selection: { anchor: from + prefix.length + TABLE_FIRST_CELL_OFFSET },
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  /**
   * Put an attachment reference where the caret is. The note stores only the
   * generated file name, so moving the data directory never breaks a note.
   */
  const insertImageReference = useCallback((filename: string) => {
    const snippet = `![](attachment://${filename})`;
    const view = codeMirrorViewRef.current;
    if (!view) {
      // Preview-only mode has no caret: append to the end instead of no-oping.
      const current = mdContentRef.current;
      const separator = !current || current.endsWith("\n") ? "" : "\n";
      handleMdChange(`${current}${separator}${snippet}\n`);
      return;
    }
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc.toString();
    const prefix = from > 0 && doc[from - 1] !== "\n" ? "\n" : "";
    view.dispatch({
      changes: { from, to, insert: `${prefix}${snippet}\n` },
      selection: { anchor: from + prefix.length + snippet.length + 1 },
      scrollIntoView: true,
    });
    view.focus();
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

  // A pasted screenshot or a dropped image file takes the same route as the
  // toolbar button, so nothing ever lands in the note as an inline base64 blob.
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;

    const insertFromBrowserFile = (file: File) => {
      void file.arrayBuffer()
        .then((buffer) => insertImageBytes(new Uint8Array(buffer), imageExtensionOf(file.name || file.type)))
        .catch((error) => console.error("Failed to insert an image file:", error));
    };
    const pickImageFile = (list: FileList | null | undefined) =>
      Array.from(list ?? []).find((file) => file.type.startsWith("image/"));

    const handlePaste = (event: ClipboardEvent) => {
      const file = pickImageFile(event.clipboardData?.files);
      if (!file) return;
      event.preventDefault();
      insertFromBrowserFile(file);
    };
    const handleDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const handleDrop = (event: DragEvent) => {
      const file = pickImageFile(event.dataTransfer?.files);
      if (!file) return;
      event.preventDefault();
      insertFromBrowserFile(file);
    };

    container.addEventListener("paste", handlePaste, true);
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("drop", handleDrop);
    return () => {
      container.removeEventListener("paste", handlePaste, true);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("drop", handleDrop);
    };
  }, [insertImageBytes]);

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

  // Sync scroll: CodeMirror -> preview
  const handleCodeMirrorScroll = useCallback((view: EditorView) => {
    if (!scrollSyncEnabledRef.current || isScrollingRef.current) return;
    isScrollingRef.current = true;

    const scroller = view.scrollDOM;
    const preview = previewRef.current;
    if (!preview) {
      isScrollingRef.current = false;
      return;
    }

    const ratio = scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight || 1);
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);

    requestAnimationFrame(() => {
      isScrollingRef.current = false;
    });
  }, []);

  // Sync scroll: preview -> CodeMirror
  const handlePreviewScroll = useCallback(() => {
    if (!scrollSyncEnabledRef.current || isScrollingRef.current) return;
    isScrollingRef.current = true;

    const scroller = codeMirrorViewRef.current?.scrollDOM;
    const preview = previewRef.current;
    if (!scroller || !preview) {
      isScrollingRef.current = false;
      return;
    }

    const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight || 1);
    scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);

    requestAnimationFrame(() => {
      isScrollingRef.current = false;
    });
  }, []);

  const toggleScrollSync = useCallback(() => {
    const nextEnabled = !scrollSyncEnabled;
    scrollSyncEnabledRef.current = nextEnabled;
    setScrollSyncEnabled(nextEnabled);
    if (nextEnabled) {
      requestAnimationFrame(() => {
        const view = codeMirrorViewRef.current;
        if (view) handleCodeMirrorScroll(view);
      });
    }
  }, [handleCodeMirrorScroll, scrollSyncEnabled]);

  useEffect(() => {
    if (markdownViewMode === "preview") return;
    requestAnimationFrame(() => codeMirrorViewRef.current?.requestMeasure());
  }, [editorFontSize, markdownViewMode]);

  // Resolve local image files asynchronously through Tauri's filesystem API.
  // Cancel stale renders so switching notes cannot paint an older preview.
  useEffect(() => {
    let cancelled = false;
    renderMarkdown(mdContent)
      .then((html) => {
        if (!cancelled) setPreviewHtml(html);
      })
      .catch((error) => {
        console.error("Failed to render Markdown preview:", error);
        if (!cancelled) setPreviewHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [mdContent]);

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

  const showMarkdownSource = markdownViewMode === "source" || markdownViewMode === "split";
  const showMarkdownPreview = markdownViewMode === "preview" || markdownViewMode === "split";

  const markdownViewLabels: Record<MarkdownViewMode, string> = {
    source: t(lang, "mdViewSource"),
    preview: t(lang, "mdViewPreview"),
    split: t(lang, "mdViewSplit"),
  };

  // Word count: Chinese characters + English words
  const currentText = mdContent;
  const chineseChars = (currentText.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const englishWords = (currentText.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ").match(/[a-zA-Z0-9]+/g) || []).length;
  const wordCountNum = chineseChars + englishWords;

  return (
    <div ref={editorContainerRef} className="note-editor-surface flex min-h-0 min-w-0 h-full flex-1 flex-col overflow-hidden">
      {/* Toolbar: view switch, history, then the document actions. Actions are
          icon-only by default, but the row must never clip: every control is
          `shrink-0`, so without wrapping the right-hand end (save / export) is
          the first thing a narrow editor card cuts off.
          Height is locked to the tab strip above it: 2px + 32px (`h-8` controls)
          + 2px = 36px, the same `h-9` every top strip uses. The padding is split
          evenly so the controls stay optically centred; `.cm-content` brings its
          own 16px top padding, so the row needs none below. */}
      <div className="note-editor-toolbar flex flex-wrap items-center gap-1 gap-y-1 px-5 py-0.5">
        <MarkdownViewSwitch
          value={markdownViewMode}
          onChange={setMarkdownViewMode}
          labels={markdownViewLabels}
        />
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border/70" />
        <button
          type="button"
          onClick={handleUndo}
          disabled={!canUndo}
          title={t(lang, "undo")}
          aria-label={t(lang, "undo")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors
            hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Undo2 size={15} />
        </button>
        <button
          type="button"
          onClick={handleRedo}
          disabled={!canRedo}
          title={t(lang, "redo")}
          aria-label={t(lang, "redo")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors
            hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Redo2 size={15} />
        </button>
        <button
          type="button"
          onClick={handleInsertTable}
          title={t(lang, "insertTable")}
          aria-label={t(lang, "insertTable")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors
            hover:bg-bg-hover hover:text-text-primary"
        >
          <Table size={15} />
        </button>
        <button
          type="button"
          onClick={() => void handleInsertImage()}
          title={t(lang, "insertImage")}
          aria-label={t(lang, "insertImage")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors
            hover:bg-bg-hover hover:text-text-primary"
        >
          <ImagePlus size={15} />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          aria-pressed={scrollSyncEnabled}
          onClick={toggleScrollSync}
          title={t(lang, scrollSyncEnabled ? "synchronizedScroll" : "independentScroll")}
          aria-label={t(lang, scrollSyncEnabled ? "synchronizedScroll" : "independentScroll")}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
            scrollSyncEnabled
              ? "border-accent/30 bg-accent/10 text-accent-text hover:bg-accent/15"
              : "border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          }`}
        >
          {scrollSyncEnabled ? <Link2 size={15} /> : <Unlink2 size={15} />}
        </button>
        <button
          type="button"
          onClick={handleAiPolish}
          title={t(lang, "aiPolishEntry")}
          aria-label={t(lang, "aiPolishEntry")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors
            hover:bg-bg-hover hover:text-text-primary"
        >
          <Sparkles size={15} />
        </button>
        <button
          type="button"
          onClick={doSave}
          disabled={!isDirty || isSaving}
          aria-busy={isSaving}
          title={t(lang, "save")}
          aria-label={t(lang, "save")}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
            isDirty
              ? "bg-accent text-on-accent hover:bg-accent-hover"
              : "text-text-muted cursor-not-allowed opacity-50"
          }`}
        >
          <Save size={15} className={isSaving ? "animate-pulse" : undefined} />
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
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
            stickyOpen
              ? "bg-accent text-on-accent hover:bg-accent-hover"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          }`}
        >
          <Pin size={15} />
        </button>
        <button
          type="button"
          onClick={onExportNote}
          disabled={!onExportNote}
          title={t(lang, "exportFile")}
          aria-label={t(lang, "exportFile")}
          className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FileDown size={15} />
          {/* Export is the only way to turn a note into a file, so it keeps a
              text label whenever the card is wide enough. Gated on the card's
              own container width — the left card is resizable, so a viewport
              media query would show the label at the wrong times. */}
          <span className="note-export-label">{t(lang, "exportFile")}</span>
        </button>
      </div>

      {/* The shell already frames the editor, so the text surface is flush with
          the card: no second border, radius or tinted panel inside it. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Editor Content */}
        <div className="flex min-h-0 flex-1 overflow-hidden" style={{ fontSize: editorFontSize }}>
          <div
            className={`${showMarkdownSource ? "flex" : "hidden"} ${showMarkdownPreview ? "w-1/2 border-r border-border" : "w-full"} min-h-0 flex-col overflow-hidden`}
          >
              {/* Pane captions only earn their space when both panes are visible. */}
              {markdownViewMode === "split" && (
                <div className="border-b border-border bg-bg-secondary px-3 py-1 text-[11px] font-medium text-text-muted">
                  {t(lang, "sourceEditor")}
                </div>
              )}
              <MarkdownSourceEditor
                key={`${activeNote.id}:${editorSessionVersion}`}
                value={mdContent}
                placeholder={t(lang, "mdPlaceholder")}
                onChange={handleMdChange}
                onHistoryChange={handleHistoryChange}
                onScroll={handleCodeMirrorScroll}
                onViewChange={handleCodeMirrorViewChange}
                fontSize={editorFontSize}
                onInsertTable={handleInsertTable}
              />
          </div>
          {showMarkdownPreview && (
            <div className={`${showMarkdownSource ? "w-1/2" : "w-full"} flex min-h-0 flex-col overflow-hidden`}>
              {markdownViewMode === "split" && (
                <div className="border-b border-border bg-bg-secondary px-3 py-1 text-[11px] font-medium text-text-muted">
                  {t(lang, "preview")}
                </div>
              )}
              <div
                ref={previewRef}
                onScroll={handlePreviewScroll}
                onClick={handleExternalLinkClick}
                className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-10"
              >
                <div
                  className="markdown-preview prose mr-auto w-full max-w-[820px] text-text-primary
                    [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-4
                    [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3
                    [&_h3]:text-lg [&_h3]:font-medium [&_h3]:mb-2 [&_h3]:mt-2
                    [&_p]:leading-[1.7]
                    [&_ul]:list-disc [&_ul]:pl-6
                    [&_ol]:list-decimal [&_ol]:pl-6
                    [&_blockquote]:border-l-4 [&_blockquote]:border-accent [&_blockquote]:pl-4
                    [&_blockquote]:italic [&_blockquote]:text-text-secondary
                    [&_hr]:border-border [&_hr]:my-4
                    [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-lg [&_img]:my-2
                    [&_strong]:font-bold [&_em]:italic [&_u]:underline [&_s]:line-through
                    [&_a]:text-accent-text [&_a]:underline
                    [&_code]:bg-bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Meta strip pinned to the bottom-right corner: updated time, save
            state and word count stay reachable without a dedicated header row. */}
        <div className="pointer-events-none absolute bottom-1.5 right-2.5 z-10 flex items-center gap-1.5 rounded-full bg-bg-primary/85 px-2 py-1 text-[11px] leading-none text-text-muted shadow-sm">
          <span className="tabular-nums">
            {t(lang, "updatedAt")} {new Date(activeNote.updatedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}
          </span>
          <span aria-hidden="true" className="opacity-50">·</span>
          <span className={isDirty ? "text-amber-500" : showSaveStatus ? "text-green-500" : "text-text-muted"}>
            {isDirty ? t(lang, "unsaved") : t(lang, "saved")}
          </span>
          <span aria-hidden="true" className="opacity-50">·</span>
          <span className="tabular-nums">{tWithParams(lang, "wordCount", { count: wordCountNum })}</span>
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
  );
};

export default NoteEditor;
