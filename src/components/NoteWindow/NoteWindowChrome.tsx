import type { ReactNode } from "react";
import { ArrowLeft, Maximize2, Minus, Square, X } from "lucide-react";
import type { LangType } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

interface NoteWindowChromeProps {
  lang: LangType;
  /** Note title shown in the custom window header. */
  title: string;
  /** Optional state chip next to the app name (e.g. "not in the notebook yet"). */
  hint?: string;
  /** Tooltip for `hint`; the chip itself is too narrow to explain the action. */
  hintDetail?: string;
  isMaximized: boolean;
  /** The menu bar (文件 / 编辑 / 段落 / 格式 / 视图). */
  toolbar: ReactNode;
  /** The editor's bottom bar, unchanged from the in-app surface. */
  statusBar: ReactNode;
  children: ReactNode;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  /** Double-click on the top edge: fill the screen vertically, keeping width. */
  onToggleVerticalFill: () => void;
  onClose: () => void;
  /** Flush, focus the main app, then close this window. */
  onReturn: () => void;
}

const CONTROL_CLASS =
  "group flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-150";

/**
 * The detached note window's own chrome.
 *
 * Deliberately Typora-shaped — icon + document title on top, the menu strip
 * directly under it, then the text — because that is the mental model the user
 * pointed at. The shell's `h-9` top bar and single `border-b` invariant is kept
 * (docs: decisions-note-window.md): the window draws no second frame around the
 * text, and the menu strip stays 28px like the editor's own menu row so the two
 * surfaces read as the same editor rather than two different products.
 *
 * Presentational only: window state and persistence belong to `NoteWindowView`,
 * which lets the layout be rendered in the browser preview bench without Tauri.
 */
export default function NoteWindowChrome({
  lang,
  title,
  hint,
  hintDetail,
  isMaximized,
  toolbar,
  statusBar,
  children,
  onMinimize,
  onToggleMaximize,
  onToggleVerticalFill,
  onClose,
  onReturn,
}: NoteWindowChromeProps) {
  const displayTitle = title.trim() || t(lang, "untitled");

  return (
    <div className="note-window note-editor-surface flex h-screen w-screen flex-col overflow-hidden bg-bg-primary text-text-primary">
      {/* Window header. The icon is what makes the window identifiable in the
          taskbar and in a screenshot; the title is the note, not the app. */}
      <header
        className="note-window-titlebar flex h-9 shrink-0 select-none items-center border-b border-border bg-bg-secondary"
        onDoubleClick={onToggleMaximize}
      >
        <div className="flex h-full w-10 shrink-0 items-center justify-center" aria-hidden="true">
          <img
            src="/default-icon.png"
            alt=""
            className="note-window-icon h-5 w-5 rounded-md object-cover"
          />
        </div>

        <div data-tauri-drag-region className="relative flex h-full min-w-0 flex-1 items-center gap-2 pr-2">
          {/* Same top-edge slot as the main title bar: 8px of double-click that
              fills the screen vertically, no `data-tauri-drag-region` so
              Tauri's own maximise-on-drag-region never fires here first. */}
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 z-10 h-2 cursor-ns-resize"
            onDoubleClick={(event) => {
              event.stopPropagation();
              onToggleVerticalFill();
            }}
          />
          <span
            data-tauri-drag-region
            className="truncate text-xs font-medium text-text-primary"
            title={displayTitle}
          >
            {displayTitle}
          </span>
          <span
            data-tauri-drag-region
            className="shrink-0 text-[11px] font-normal text-text-muted"
          >
            Qing Notepad
          </span>
          {hint && (
            <span
              data-tauri-drag-region
              title={hintDetail}
              className="shrink-0 rounded-full border border-border px-1.5 text-[10px] leading-4 font-normal text-text-muted"
            >
              {hint}
            </span>
          )}
        </div>

        <div
          className="flex h-full items-center gap-0.5 pr-1.5"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={`${CONTROL_CLASS} hover:bg-bg-hover`}
            onClick={onMinimize}
            title={t(lang, "minimize")}
            aria-label={t(lang, "minimize")}
          >
            <Minus size={14} strokeWidth={2.5} className="text-text-muted group-hover:text-text-primary" />
          </button>
          <button
            type="button"
            className={`${CONTROL_CLASS} hover:bg-bg-hover`}
            onClick={onToggleMaximize}
            title={isMaximized ? t(lang, "restore") : t(lang, "maximize")}
            aria-label={isMaximized ? t(lang, "restore") : t(lang, "maximize")}
          >
            {isMaximized ? (
              <Square size={11} strokeWidth={2.5} className="text-text-muted group-hover:text-text-primary" />
            ) : (
              <Maximize2 size={13} strokeWidth={2} className="text-text-muted group-hover:text-text-primary" />
            )}
          </button>
          <button
            type="button"
            className={`${CONTROL_CLASS} hover:bg-danger`}
            onClick={onClose}
            title={t(lang, "close")}
            aria-label={t(lang, "close")}
          >
            <X size={14} strokeWidth={2.5} className="text-text-muted group-hover:text-on-danger" />
          </button>
        </div>
      </header>

      {/* Menu strip. 28px, same as the in-app editor's menu row; the return
          button is the one control the in-app surface does not have. */}
      <div className="note-editor-toolbar flex h-7 shrink-0 items-center gap-1 px-4">
        {toolbar}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onReturn}
          title={t(lang, "returnToMainApp")}
          className="note-window-return flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent/45 hover:bg-bg-hover hover:text-text-primary"
        >
          <ArrowLeft size={12} aria-hidden="true" />
          {t(lang, "returnToMainApp")}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      {statusBar}
    </div>
  );
}
