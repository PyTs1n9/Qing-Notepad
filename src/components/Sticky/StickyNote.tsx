import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { Pin, PinOff, X } from "lucide-react";
import {
  loadNoteContent,
  loadNoteList,
  loadSettings,
  saveNoteContent,
} from "@/utils/storage";
import { applyTheme } from "@/utils/theme";
import {
  DEFAULT_STICKY_OPACITY,
  MAX_STICKY_OPACITY,
  normalizeStickyOpacity,
} from "@/stores/settingsStore";
import type { ThemeType, CustomColors, LangType } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import { linkUrlAt } from "@/utils/markdownLinks";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, placeholder as codeMirrorPlaceholder } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeMirrorTypographyTheme, themeAwareMarkdownHighlighting } from "@/utils/codeMirror";
import { useSettingsStore } from "@/stores/settingsStore";
import { livePreview } from "@/utils/livePreview";
import { markdownInputRules } from "@/utils/livePreview/inputRules";

/** Marks a document replacement that came from the main window, not the user. */
const externalDocumentUpdate = Annotation.define<boolean>();

/** Same decorations as the editor, caret fallback included — this window edits. */
const STICKY_PREVIEW = livePreview();

/**
 * The window already owns the frame and the padding (`.sticky-content`), so the
 * editor is only the text surface: no gutters, transparent background, and a
 * scroller of its own so a long note does not stretch the window.
 */
const stickyEditorTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--color-text-primary)", backgroundColor: "transparent" },
  ".cm-scroller": {
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "0", caretColor: "var(--color-accent-text)" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 34%, transparent) !important",
  },
  ".cm-placeholder": { color: "color-mix(in srgb, var(--color-text-muted) 40%, transparent)" },
});

const MIN_FONT = 10;
const MAX_FONT = 32;
const DEFAULT_FONT = 13;
const FONT_STEP = 1;

interface StickyNoteProps {
  noteId: string;
}

export default function StickyNote({ noteId }: StickyNoteProps) {
  const [title, setTitle] = useState("");
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(true);
  const [fontSize, setFontSize] = useState<number>(DEFAULT_FONT);
  const [stickyOpacity, setStickyOpacity] = useState(DEFAULT_STICKY_OPACITY);
  // The empty-note hint is painted by CSS `::before`, but the text lives in the
  // i18n table like every other string, so this window has to know the language.
  const [lang, setLang] = useState<LangType>("zh");
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fontSizeCompartment = useMemo(() => new Compartment(), []);
  const editorFontFamily = useSettingsStore((s) => s.editorFontFamily);
  const editorFontFamilyRef = useRef(editorFontFamily);
  editorFontFamilyRef.current = editorFontFamily;
  const placeholderCompartment = useMemo(() => new Compartment(), []);
  // The editor is created once; the debounce lives below it, so route it through
  // a ref instead of rebuilding the view whenever a callback identity changes.
  const scheduleAutoSaveRef = useRef<() => void>(() => {});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const isDirtyRef = useRef(false);
  const isComposingRef = useRef(false);
  // Track whether we initiated a save (to ignore our own echo event)
  const selfSaveRef = useRef(false);
  const appWindow = getCurrentWindow();

  /**
   * Replacing the whole document from outside (initial load, or the main window
   * pushing an edit) must not mark this window dirty, or the debounce would write
   * the same text straight back.
   */
  const replaceDocument = useCallback((content: string) => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    const head = Math.min(view.state.selection.main.head, content.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: head },
      annotations: [externalDocumentUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }, []);

  // The text surface: a CodeMirror view, so the sticky window renders Markdown
  // with the same decorations as the editor instead of an HTML round-trip.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [
          markdown({ base: markdownLanguage, addKeymap: false }),
          themeAwareMarkdownHighlighting,
          stickyEditorTheme,
          STICKY_PREVIEW,
          markdownInputRules(),
          fontSizeCompartment.of(codeMirrorTypographyTheme(DEFAULT_FONT, editorFontFamilyRef.current)),
          placeholderCompartment.of(codeMirrorPlaceholder("")),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const external = update.transactions.some((tr) => tr.annotation(externalDocumentUpdate));
            if (external) return;
            isDirtyRef.current = true;
            if (!isComposingRef.current) scheduleAutoSaveRef.current();
          }),
          EditorView.domEventHandlers({
            // Links are rendered as text by the preview, so the target comes from
            // the syntax tree rather than from an `<a href>`.
            click(event, view) {
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null) return false;
              const url = linkUrlAt(view.state, pos);
              if (!url) return false;
              void openInDefaultBrowser(url);
              return true;
            },
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;

    // Composition is handled by CodeMirror; the window only needs to know when
    // not to flush a half-composed line.
    const onCompositionStart = () => {
      isComposingRef.current = true;
    };
    const onCompositionEnd = () => {
      isComposingRef.current = false;
      isDirtyRef.current = true;
      scheduleAutoSaveRef.current();
    };
    view.contentDOM.addEventListener("compositionstart", onCompositionStart);
    view.contentDOM.addEventListener("compositionend", onCompositionEnd);

    return () => {
      view.contentDOM.removeEventListener("compositionstart", onCompositionStart);
      view.contentDOM.removeEventListener("compositionend", onCompositionEnd);
      view.destroy();
      viewRef.current = null;
    };
  }, [fontSizeCompartment, placeholderCompartment]);

  // Ctrl+wheel zoom and the empty-note hint are reconfigurations, not rebuilds.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: fontSizeCompartment.reconfigure(codeMirrorTypographyTheme(fontSize, editorFontFamily)),
    });
  }, [fontSize, editorFontFamily, fontSizeCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: placeholderCompartment.reconfigure(codeMirrorPlaceholder(t(lang, "stickyEmptyHint"))),
    });
  }, [lang, placeholderCompartment]);

  // Set sticky body class for transparent background
  useEffect(() => {
    document.body.classList.add("sticky-body");
    return () => {
      document.body.classList.remove("sticky-body");
    };
  }, []);

  // Load theme from settings.json and apply CSS variables
  useEffect(() => {
    const initTheme = async () => {
      try {
        const settings = await loadSettings();
        const theme = (settings.theme as ThemeType) || "blue";
        const customColors = (settings.customColors as CustomColors | null) || null;
        applyTheme(theme, customColors);
        setStickyOpacity(normalizeStickyOpacity(settings.stickyOpacity));
        setLang((settings.lang as LangType) === "en" ? "en" : "zh");
      } catch (e) {
        console.error("Failed to load theme for sticky:", e);
      }
    };
    initTheme();
  }, []);

  // Keep open sticky windows in sync with appearance settings.
  useEffect(() => {
    const unlisten = listen<{
      theme: ThemeType;
      customColors: CustomColors | null;
      stickyOpacity: number;
    }>("sticky:appearance-updated", (event) => {
      applyTheme(event.payload.theme, event.payload.customColors);
      setStickyOpacity(normalizeStickyOpacity(event.payload.stickyOpacity));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Load note content into the editor (external change: no dirty flag).
  useEffect(() => {
    const loadNote = async () => {
      try {
        const noteIndex = await loadNoteList();
        const noteMeta = noteIndex.notes.find((n: { id: string }) => n.id === noteId);
        if (noteMeta) {
          setTitle(noteMeta.title || "Untitled");
        }

        const rawContent = await loadNoteContent(noteId);
        if (rawContent) replaceDocument(rawContent);
      } catch (e) {
        console.error("Failed to load sticky note:", e);
      }
    };
    loadNote();
  }, [noteId, replaceDocument]);

  // Listen for content updates from main editor
  useEffect(() => {
    const unlisten = listen<{ noteId: string; content: string }>(
      "sticky:note-updated",
      (event) => {
        if (event.payload.noteId !== noteId) return;
        // Ignore if this update was triggered by our own save
        if (selfSaveRef.current) {
          selfSaveRef.current = false;
          return;
        }
        const rawContent = event.payload.content;
        if (rawContent) replaceDocument(rawContent);
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [noteId, replaceDocument]);

  const saveDirtyContent = useCallback(async () => {
    if (savePromiseRef.current) {
      await savePromiseRef.current;
    }
    const view = viewRef.current;
    if (!isDirtyRef.current || !view) return;

    // The document *is* Markdown now, so the note file gets the source text
    // instead of the rendered HTML the old contentEditable produced.
    const content = view.state.doc.toString();
    isDirtyRef.current = false;
    const savePromise = (async () => {
      try {
        await saveNoteContent(noteId, content);
        // Notify main editor only when the sticky note was actually edited.
        selfSaveRef.current = true;
        await emit("sticky:note-saved", { noteId, content });
      } catch (error) {
        isDirtyRef.current = true;
        throw error;
      }
    })();
    savePromiseRef.current = savePromise;
    try {
      await savePromise;
    } finally {
      if (savePromiseRef.current === savePromise) {
        savePromiseRef.current = null;
      }
    }
  }, [noteId]);

  // Debounced auto-save with event emission
  const scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveDirtyContent().catch((error) => {
        console.error("Failed to auto-save sticky note:", error);
      });
    }, 800);
  }, [saveDirtyContent]);

  scheduleAutoSaveRef.current = scheduleAutoSave;

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Ctrl + wheel to zoom font size
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setFontSize((prev) => {
        const delta = e.deltaY < 0 ? FONT_STEP : -FONT_STEP;
        return Math.min(MAX_FONT, Math.max(MIN_FONT, prev + delta));
      });
    },
    [],
  );

  // Close: flush real edits, notify main window, and destroy window.
  // Do not rewrite untouched rendered HTML: doing so converts Markdown on the
  // main editor side and can insert an extra blank line between every block.
  const closeSticky = useCallback(async () => {
    try {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      await saveDirtyContent();
      // Notify main window to clear tracking before destroying
      await emit("sticky:closed", { noteId });
      await appWindow.close();
    } catch (e) {
      console.error("Failed to close sticky:", e);
    }
  }, [appWindow, noteId, saveDirtyContent]);

  // The main editor's pin button uses the same safe close path as this
  // window's close button, so a pending debounced edit cannot be lost.
  useEffect(() => {
    const unlisten = listen<{ noteId: string }>("sticky:request-close", (event) => {
      if (event.payload.noteId === noteId) {
        void closeSticky();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [closeSticky, noteId]);





  const handleTitleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLSpanElement>) => {
      e.preventDefault();
      e.stopPropagation();
      closeSticky();
    },
    [closeSticky],
  );

  const handleTogglePin = async () => {
    try {
      const newValue = !isAlwaysOnTop;
      await appWindow.setAlwaysOnTop(newValue);
      setIsAlwaysOnTop(newValue);
    } catch (e) {
      console.error("Failed to toggle pin:", e);
    }
  };

  return (
    <div
      className="sticky-mode h-screen w-screen"
      style={{
        "--sticky-bg-opacity": `${stickyOpacity}%`,
        "--sticky-header-opacity": `${Math.min(MAX_STICKY_OPACITY, stickyOpacity + 5)}%`,
      } as CSSProperties}
    >
      <div className="sticky-container h-full flex flex-col">
        {/* Draggable Title Bar — double-click to close */}
        <div
          className="sticky-header flex items-center gap-2 select-none"
        >
          <span className="flex-shrink-0 cursor-move" data-tauri-drag-region>
            <Pin size={12} className="text-accent-text" />
          </span>
          <span
            className="sticky-title max-w-[55%] truncate text-text-primary text-xs font-semibold cursor-pointer"
            onDoubleClick={handleTitleDoubleClick}
            title={title}
          >
            {title}
          </span>
          <span className="flex-1 self-stretch cursor-move" data-tauri-drag-region />
          <span className="text-[11px] font-medium text-text-muted tabular-nums select-none">
            {fontSize}px
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleTogglePin}
              className={`p-1 rounded hover:bg-bg-hover transition-colors cursor-pointer ${isAlwaysOnTop ? "text-accent-text" : "text-text-muted hover:text-text-primary"}`}
              title={isAlwaysOnTop ? "Unpin" : "Pin"}
            >
              {isAlwaysOnTop ? <PinOff size={11} /> : <Pin size={11} />}
            </button>
            <button
              onClick={closeSticky}
              className="p-1 rounded hover:bg-danger/20 text-text-muted hover:text-danger transition-colors cursor-pointer"
              title="Close"
            >
              <X size={11} />
            </button>
          </div>
        </div>

        {/* Editable note content: CodeMirror with the live preview decorations. */}
        <div
          ref={hostRef}
          className="sticky-content min-h-0 flex-1 text-text-primary"
          onWheel={handleWheel}
        />
      </div>
    </div>
  );
}
