import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { loadNoteContent, loadNoteList, loadSettings } from "@/utils/storage";
import { applyTheme } from "@/utils/theme";
import type { ThemeType, CustomColors } from "@/stores/settingsStore";
import { X } from "lucide-react";
import { handleExternalLinkClick } from "@/utils/externalLinks";
import { renderStoredNoteContent } from "@/utils/markdown";

interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

const TileView: React.FC = () => {
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState("");
  const [htmlContent, setHtmlContent] = useState("");
  const [loading, setLoading] = useState(true);

  const params = new URLSearchParams(window.location.search);
  const noteId = params.get("noteId") || "";

  useEffect(() => {
    const init = async () => {
      if (!noteId) {
        setLoading(false);
        return;
      }

      // Load note metadata
      try {
        const noteIndex = await loadNoteList();
        const meta: NoteMeta | undefined = noteIndex.notes.find((n) => n.id === noteId);
        if (meta) {
          setTitle(meta.title || "Untitled");
          setTags(meta.tags);
          setUpdatedAt(meta.updatedAt);
        }
      } catch {
        // ignore
      }

      // Load note content
      try {
        const raw = await loadNoteContent(noteId);
        if (raw) {
          const html = await renderStoredNoteContent(raw);
          setHtmlContent(html);
        }
      } catch {
        // ignore
      }

      // Load and apply theme
      try {
        const settings = await loadSettings();
        const theme = (settings.theme as ThemeType) || "blue";
        const customColors = (settings.customColors as CustomColors | null) || null;
        applyTheme(theme, customColors);
      } catch {
        // ignore
      }

      setLoading(false);
    };
    init();
  }, [noteId]);

  // Listen for theme sync events from main window
  useEffect(() => {
    const unlisten = listen<{ theme: ThemeType; customColors: CustomColors | null }>(
      "tile-theme-sync",
      (event) => {
        applyTheme(event.payload.theme, event.payload.customColors);
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg-primary">
        <span className="text-text-muted text-sm">Loading...</span>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-bg-primary overflow-hidden">
      {/* Drag bar + close button */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between h-8 px-3 flex-shrink-0 bg-bg-secondary select-none"
      >
        <span className="text-xs text-text-muted truncate flex-1" data-tauri-drag-region>
          {title}
        </span>
        <button
          onClick={handleClose}
          className="ml-2 w-5 h-5 flex items-center justify-center rounded
            text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Note header */}
      <div className="px-4 pt-3 pb-2 flex-shrink-0">
        <h1 className="text-lg font-bold text-text-primary leading-tight">{title || "Untitled"}</h1>
        {(updatedAt || tags.length > 0) && (
          <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
            {updatedAt && (
              <span>{new Date(updatedAt).toLocaleString()}</span>
            )}
            {tags.length > 0 && (
              <span className="flex gap-1">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 rounded bg-bg-secondary text-text-muted"
                  >
                    {tag}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Note content */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {htmlContent ? (
          <div
            className="tile-content text-sm text-text-primary leading-relaxed
              [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-lg [&_img]:my-2
              [&_a]:text-accent-text [&_a]:underline"
            onClick={handleExternalLinkClick}
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        ) : (
          <p className="text-text-muted text-sm italic">Empty note</p>
        )}
      </div>
    </div>
  );
};

export default TileView;
