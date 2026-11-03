import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import type { EditorView } from "@codemirror/view";
import EditorMenuBar, { type EditorViewMode } from "@/components/Editor/EditorMenuBar";
import EditorStatusBar, { type SaveState } from "@/components/Editor/EditorStatusBar";
import MarkdownSourceEditor from "@/components/Editor/MarkdownSourceEditor";
import NoteOutlinePanel from "@/components/Editor/NoteOutlinePanel";
import NoteWindowChrome from "@/components/NoteWindow/NoteWindowChrome";
import { useOutlineNavigation } from "@/hooks/useOutlineNavigation";
import { useEditorZoom } from "@/utils/editorZoom";
import { computeMarkdownStats } from "@/utils/markdownStats";
import { extractOutline, type OutlineHeading } from "@/utils/noteOutline";
import {
  NOTE_WINDOW_APPEARANCE_EVENT,
  NOTE_WINDOW_MAIN_SAVED_EVENT,
  NOTE_WINDOW_SAVED_EVENT,
  focusMainWindow,
} from "@/utils/noteWindow";
import { exportNoteFile } from "@/utils/exportNote";
import { commitExternalNote, type ExternalNoteInfo } from "@/utils/externalNotes";
import { toggleVerticalFill } from "@/utils/windowFill";
import { imageExtensionOf, insertImageMarkdown } from "@/utils/noteImages";
import { insertTable } from "@/utils/markdownCommands";
import {
  loadExternalDraft,
  loadNoteContent,
  loadNoteList,
  loadSettings,
  saveExternalDraft,
  saveImageAttachment,
  saveNoteContent,
} from "@/utils/storage";
import { applyTheme } from "@/utils/theme";
import { htmlToMarkdown, isStoredEditorHtml } from "@/utils/htmlToMarkdown";
import { t, tWithParams } from "@/utils/i18n";
import type { CustomColors, LangType, ThemeType } from "@/stores/settingsStore";

/** Stable identity so a closed outline does not invalidate the memo every render. */
const NO_HEADINGS: OutlineHeading[] = [];
/** Quiet window: the main editor's debounce is 800ms as well. */
const AUTOSAVE_DELAY = 800;

interface NoteWindowViewProps {
  noteId: string;
  /**
   * `"external"` = the file came from Explorer and is not in the notebook yet.
   * Content is read from the source file, autosave goes to
   * `<data>/external-drafts`, and only "返回主软件" adds it to 未分类笔记.
   */
  source?: "external";
}

/**
 * The note surface in its own window.
 *
 * Scope is deliberately narrow — "only the note" means no sidebar, no tabs, no
 * AI panel, no workspace chrome. What it does keep is the complete editing
 * surface: the five menus, the same CodeMirror instance and live preview, the
 * outline column, and every segment of the status bar. A detached view that
 * silently dropped a control would be a second, lesser editor.
 *
 * Persistence is the interesting part. Two windows can hold the same document,
 * so the buffer is written on a debounce and the write is broadcast; the main
 * editor applies it only when it has no unsaved edits of its own, and this
 * window applies the main window's writes under the same rule. No dialog, no
 * merge UI: the rule is "whoever typed last keeps the text until the other one
 * starts typing", which is predictable and never discards an active edit.
 *
 * The one exception is `source === "external"`: the file is not a note yet, so
 * there is no peer window and no index entry. Saves go to a draft file, and
 * "返回主软件" hands the buffer to the main window, which alone writes
 * `notes/index.json`.
 */
export default function NoteWindowView({ noteId, source }: NoteWindowViewProps) {
  const isExternal = source === "external";
  const [lang, setLang] = useState<LangType>("zh");
  const [title, setTitle] = useState("");
  const [mdContent, setMdContent] = useState("");
  const [ready, setReady] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<EditorViewMode>("live");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [editorFontFamily, setEditorFontFamily] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef("");
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<void> | null>(null);

  const { fontSize, zoomIn, zoomOut, resetZoom } = useEditorZoom(containerRef, { initialSize: 16 });

  const outline = useMemo(
    () => (outlineOpen ? extractOutline(mdContent) : NO_HEADINGS),
    [mdContent, outlineOpen],
  );
  const stats = useMemo(() => computeMarkdownStats(mdContent), [mdContent]);
  // `ready` is part of the reset key: the CodeMirror view is created by the
  // editor's own effect, and the outline listener must bind to that view once
  // the loading placeholder has been replaced.
  const { activeLine: outlineActiveLine, jumpTo: handleOutlineSelect } = useOutlineNavigation(
    viewRef,
    outline,
    outlineOpen,
    `${noteId}:${ready ? "ready" : "loading"}`,
  );
  const saveState: SaveState = isSaving ? "saving" : isDirty ? "dirty" : "saved";

  /**
   * Write the buffer. Concurrent callers queue behind the in-flight write, so a
   * debounce that fires while an explicit Ctrl+S is running cannot interleave
   * two writes of different revisions.
   */
  const saveNow = useCallback(async (): Promise<void> => {
    if (savePromiseRef.current) {
      await savePromiseRef.current.catch(() => undefined);
    }
    if (!dirtyRef.current) return;

    const content = contentRef.current;
    dirtyRef.current = false;
    setIsDirty(false);
    setIsSaving(true);

    const promise = (async () => {
      try {
        if (isExternal) {
          // Not a note yet: keep the edits recoverable without making the file
          // visible to `loadNoteList()` (which recovers every `.md` in notes/).
          await saveExternalDraft(noteId, content);
          setSavedAt(Date.now());
        } else {
          await saveNoteContent(noteId, content);
          setSavedAt(Date.now());
          // The main editor reloads only if it has no unsaved edits; see the
          // class comment. It also drives the tab strip's dirty dot.
          await emit(NOTE_WINDOW_SAVED_EVENT, { noteId, content });
        }
      } catch (error) {
        // `saveNoteContent` reports its own failures; this branch still matters
        // because a failed broadcast must not look like a successful save.
        dirtyRef.current = true;
        setIsDirty(true);
        console.error("Failed to save the detached note:", error);
      } finally {
        setIsSaving(false);
      }
    })();

    savePromiseRef.current = promise;
    try {
      await promise;
    } finally {
      if (savePromiseRef.current === promise) savePromiseRef.current = null;
    }
  }, [isExternal, noteId]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveNow();
    }, AUTOSAVE_DELAY);
  }, [saveNow]);

  // The editor callback must keep one identity for the life of the view, or
  // `MarkdownSourceEditor` would tear the document down on every keystroke.
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  const handleChange = useCallback((value: string) => {
    if (value === contentRef.current) return;
    contentRef.current = value;
    setMdContent(value);
    dirtyRef.current = true;
    setIsDirty(true);
    scheduleSaveRef.current();
  }, []);

  const handleHistoryChange = useCallback((undoAvailable: boolean, redoAvailable: boolean) => {
    setCanUndo(undoAvailable);
    setCanRedo(redoAvailable);
  }, []);

  const handleViewChange = useCallback((view: EditorView | null) => {
    viewRef.current = view;
  }, []);

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await saveNow();
  }, [saveNow]);

  // ---------------------------------------------------------------- window --
  const requestClose = useCallback(() => {
    // The actual flush happens in `onCloseRequested`, which is the one path
    // every close gesture (our X, Alt+F4, the taskbar) goes through.
    void getCurrentWindow().close().catch((error) => console.error("Failed to close the note window:", error));
  }, []);

  const minimizeWindow = useCallback(() => {
    void getCurrentWindow().minimize().catch(() => undefined);
  }, []);

  const toggleMaximize = useCallback(() => {
    void getCurrentWindow().toggleMaximize().catch(() => undefined);
  }, []);

  const toggleFill = useCallback(() => {
    void toggleVerticalFill().catch((error) => console.error("Vertical fill failed:", error));
  }, []);

  const returnToMain = useCallback(async () => {
    try {
      await flushSave();
      if (isExternal) {
        // Hand over the buffer we just flushed rather than letting the main
        // window read the draft: the debounce may not have fired yet, and an
        // unedited file has no draft at all.
        try {
          await commitExternalNote(noteId, contentRef.current);
        } catch (error) {
          // The draft is still on disk, so reopening the file resumes the work.
          console.error("Failed to queue the external note for import:", error);
        }
      }
      await focusMainWindow();
    } finally {
      // `destroy` rather than `close`: the close-requested handler would try to
      // flush again, and the write already happened above.
      await getCurrentWindow().destroy().catch(() => undefined);
    }
  }, [flushSave, isExternal, noteId]);

  // --------------------------------------------------------------- loading --
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      let initialContent = "";
      try {
        const settings = await loadSettings();
        if (cancelled) return;
        applyTheme(
          (settings.theme as ThemeType) || "blue",
          (settings.customColors as CustomColors | null) || null,
        );
        setLang(settings.lang === "en" ? "en" : "zh");
        setEditorFontFamily(
          typeof settings.editorFontFamily === "string" ? settings.editorFontFamily : "",
        );

        if (isExternal) {
          // The source file is read through Rust (the renderer has no fs scope
          // for arbitrary paths); an unreadable file must still show the draft.
          let info: ExternalNoteInfo | null = null;
          try {
            info = await invoke<ExternalNoteInfo>("external_note_read", { id: noteId });
          } catch (error) {
            console.warn("The external markdown file is no longer readable:", error);
          }
          const draft = await loadExternalDraft(noteId);
          if (cancelled) return;
          if (info) setTitle(info.title || "");
          if (draft !== null) {
            // Unsaved work from a previous visit beats the file on disk. That
            // is the whole point of the draft: closing the window without
            // pressing "返回主软件" must not lose the edit.
            initialContent = draft;
            setSavedAt(Date.now());
          } else if (info) {
            initialContent = info.content;
          }
        } else {
          const index = await loadNoteList();
          const meta = index.notes.find((note) => note.id === noteId);
          if (cancelled) return;
          if (meta) {
            setTitle(meta.title || "");
            const parsed = Date.parse(meta.updatedAt);
            setSavedAt(Number.isNaN(parsed) ? null : parsed);
          }

          const stored = await loadNoteContent(noteId);
          if (cancelled) return;
          initialContent = stored ? (isStoredEditorHtml(stored) ? htmlToMarkdown(stored) : stored) : "";
        }
      } catch (error) {
        console.error("Failed to load the detached note:", error);
      } finally {
        if (!cancelled) {
          contentRef.current = initialContent;
          setMdContent(initialContent);
          setReady(true);
        }
      }
    };

    void init();
    return () => {
      cancelled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [isExternal, noteId]);

  // ---------------------------------------------------------------- syncing --
  // Main window → this window. Unsaved local edits win; otherwise the disk
  // revision replaces the buffer (including the undo history, because the
  // document those steps referred to no longer exists).
  useEffect(() => {
    const unlisten = listen<{ noteId: string; content: string }>(
      NOTE_WINDOW_MAIN_SAVED_EVENT,
      (event) => {
        if (event.payload.noteId !== noteId) return;
        if (dirtyRef.current) return;
        const incoming = event.payload.content;
        contentRef.current = incoming;
        setMdContent(incoming);
        setSavedAt(Date.now());
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [noteId]);

  // Appearance changes made in the main window. The language is applied live
  // too: a window left open across a language switch must not keep the old
  // menu labels until it is reopened.
  useEffect(() => {
    const unlisten = listen<{
      theme: ThemeType;
      customColors: CustomColors | null;
      lang: LangType;
    }>(NOTE_WINDOW_APPEARANCE_EVENT, (event) => {
      applyTheme(event.payload.theme, event.payload.customColors);
      setLang(event.payload.lang === "en" ? "en" : "zh");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Every close gesture funnels through here: flush first, destroy after.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void appWindow
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await flushSave();
        if (!disposed) await appWindow.destroy().catch(() => undefined);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flushSave]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const sync = () => {
      void appWindow.isMaximized().then(setIsMaximized).catch(() => undefined);
    };
    sync();
    const unlisten = appWindow.onResized(sync);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ------------------------------------------------------------- shortcuts --
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;

      const isSave =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        (event.key.toLowerCase() === "s" || event.code === "KeyS");
      if (isSave) {
        event.preventDefault();
        event.stopPropagation();
        void saveNow();
        return;
      }

      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const container = containerRef.current;
      if (!container || !(event.target instanceof Node) || !container.contains(event.target)) return;

      // Physical codes for the same reason as the in-app editor: Ctrl+= reports
      // "+" and Ctrl+Shift+0 reports ")" on some layouts.
      if (event.code === "Slash") {
        event.preventDefault();
        setViewMode((mode) => (mode === "source" ? "live" : "source"));
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
  }, [resetZoom, saveNow, zoomIn, zoomOut]);

  // --------------------------------------------------------------- actions --
  const handleToggleOutline = useCallback(() => {
    setOutlineOpen((open) => !open);
    requestAnimationFrame(() => viewRef.current?.requestMeasure());
  }, []);

  const handleToggleSourceMode = useCallback(() => {
    setViewMode((mode) => (mode === "source" ? "live" : "source"));
  }, []);

  const handleZoom = useCallback(
    (action: "in" | "out" | "reset") => {
      if (action === "in") zoomIn();
      else if (action === "out") zoomOut();
      else resetZoom();
    },
    [zoomIn, zoomOut, resetZoom],
  );

  const handleInsertTable = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(insertTable(view.state));
    view.focus();
  }, []);

  const insertImageBytes = useCallback(async (bytes: Uint8Array, extension: string) => {
    const filename = await saveImageAttachment(bytes, extension);
    const view = viewRef.current;
    if (view) {
      insertImageMarkdown(view, filename);
      return;
    }
    // No caret (still loading): append rather than dropping the attachment.
    const snippet = `![](attachment://${filename})`;
    const current = contentRef.current;
    const separator = !current || current.endsWith("\n") ? "" : "\n";
    handleChange(`${current}${separator}${snippet}\n`);
  }, [handleChange]);

  const handleInsertImage = useCallback(async () => {
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

  const insertImageFile = useCallback(
    (file: File) => {
      void file
        .arrayBuffer()
        .then((buffer) => insertImageBytes(new Uint8Array(buffer), imageExtensionOf(file.name || file.type)))
        .catch((error) => console.error("Failed to insert an image file:", error));
    },
    [insertImageBytes],
  );

  const handleExport = useCallback(async () => {
    // Export what is on screen, not the last autosaved revision.
    await flushSave();
    await exportNoteFile({ title, content: contentRef.current, lang });
  }, [flushSave, lang, title]);

  return (
    <div ref={containerRef} className="h-screen w-screen">
      <NoteWindowChrome
        lang={lang}
        title={title}
        hint={isExternal ? t(lang, "externalNoteHint") : undefined}
        hintDetail={isExternal ? t(lang, "externalNoteHintDetail") : undefined}
        isMaximized={isMaximized}
        onMinimize={minimizeWindow}
        onToggleMaximize={toggleMaximize}
        onToggleVerticalFill={toggleFill}
        onClose={requestClose}
        onReturn={() => void returnToMain()}
        toolbar={
          <EditorMenuBar
            lang={lang}
            getView={() => viewRef.current}
            hasEditor={ready}
            canUndo={canUndo}
            canRedo={canRedo}
            isDirty={isDirty}
            isSaving={isSaving}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            onSave={() => void saveNow()}
            onExport={ready ? () => void handleExport() : undefined}
            onCloseTab={requestClose}
            closeEntryLabel={t(lang, "closeNoteWindow")}
            onInsertTable={handleInsertTable}
            onInsertImage={() => void handleInsertImage()}
            onZoom={handleZoom}
          />
        }
        statusBar={
          <EditorStatusBar
            lang={lang}
            outlineOpen={outlineOpen}
            onToggleOutline={handleToggleOutline}
            sourceMode={viewMode === "source"}
            onToggleSourceMode={handleToggleSourceMode}
            updatedAt={savedAt}
            saveState={saveState}
            stats={stats}
          />
        }
      >
        <div className="note-body relative flex min-h-0 flex-1 overflow-hidden">
          {outlineOpen && ready && (
            <NoteOutlinePanel
              headings={outline}
              activeLine={outlineActiveLine}
              onSelect={handleOutlineSelect}
              onClose={() => setOutlineOpen(false)}
              lang={lang}
            />
          )}

          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ fontSize }}>
              {ready ? (
                <MarkdownSourceEditor
                  value={mdContent}
                  placeholder={t(lang, "mdPlaceholder")}
                  onChange={handleChange}
                  onHistoryChange={handleHistoryChange}
                  onViewChange={handleViewChange}
                  fontSize={fontSize}
                  fontFamily={editorFontFamily}
                  livePreview={viewMode === "live"}
                  onPasteImage={insertImageFile}
                  onInsertTable={handleInsertTable}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
                  {t(lang, "loading")}
                </div>
              )}
            </div>
          </div>
        </div>
      </NoteWindowChrome>
    </div>
  );
}
