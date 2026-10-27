import { useEffect, useRef, useState, useCallback, type CSSProperties } from "react";
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
import { handleExternalLinkClick } from "@/utils/externalLinks";
import { renderStoredNoteContent, stripMarkdownSyntaxHighlighting } from "@/utils/markdown";

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
  const editorRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const isDirtyRef = useRef(false);
  const isComposingRef = useRef(false);
  // Track whether we initiated a save (to ignore our own echo event)
  const selfSaveRef = useRef(false);
  const appWindow = getCurrentWindow();

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

  // Load note content and inject into contentEditable
  useEffect(() => {
    const loadNote = async () => {
      try {
        const noteIndex = await loadNoteList();
        const noteMeta = noteIndex.notes.find((n: { id: string }) => n.id === noteId);
        if (noteMeta) {
          setTitle(noteMeta.title || "Untitled");
        }

        const rawContent = await loadNoteContent(noteId);
        if (rawContent && editorRef.current) {
          editorRef.current.innerHTML = await renderStoredNoteContent(rawContent);
        }
      } catch (e) {
        console.error("Failed to load sticky note:", e);
      }
    };
    loadNote();
  }, [noteId]);

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
        if (editorRef.current && rawContent) {
            // Markdown → HTML for display
          void renderStoredNoteContent(rawContent).then((html) => {
            if (editorRef.current) editorRef.current.innerHTML = html;
          });
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [noteId]);

  const saveDirtyContent = useCallback(async () => {
    if (savePromiseRef.current) {
      await savePromiseRef.current;
    }
    if (!isDirtyRef.current || !editorRef.current) return;

    const content = stripMarkdownSyntaxHighlighting(editorRef.current.innerHTML);
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

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const handleInput = () => {
    isDirtyRef.current = true;
    if (!isComposingRef.current) {
      scheduleAutoSave();
    }
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    isDirtyRef.current = true;
    scheduleAutoSave();
  };

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

        {/* Editable Note Content */}
        <div
          ref={editorRef}
          className="sticky-content flex-1 text-text-primary overflow-y-auto outline-none"
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onClick={handleExternalLinkClick}
          onWheel={handleWheel}
          style={{ fontSize: `${fontSize}px` }}
          spellCheck={false}
          data-placeholder={t(lang, "stickyEmptyHint")}
        />
      </div>
    </div>
  );
}
