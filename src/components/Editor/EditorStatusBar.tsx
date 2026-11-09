import { Code2, ListTree, Eye, PenLine } from "lucide-react";
import type { LangType } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import type { MarkdownStats } from "@/utils/markdownStats";

export type SaveState = "saved" | "dirty" | "saving";

interface EditorStatusBarProps {
  lang: LangType;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  /** `true` shows the raw source; the button switches back to live rendering. */
  sourceMode: boolean;
  onToggleSourceMode: () => void;
  /** `true` while 纯预览编辑 is on; the button flips it. */
  purePreview?: boolean;
  /**
   * Omit to leave the button out entirely. The detached note window does not
   * pass it: that surface keeps the two-mode editor, so a third button there
   * would promise something it cannot do.
   */
  onTogglePurePreview?: () => void;
  /** Epoch milliseconds, already resolved by the editor (saved time, not keystroke). */
  updatedAt: number | null;
  saveState: SaveState;
  stats: MarkdownStats;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Absolute timestamp, shortened by distance rather than by width: today shows
 * the clock, this year shows the date, anything older shows the year. A full
 * `2026/11/3 19:12` on every note spends 40px to say something the user already
 * knows, and truncating it instead would drop the minutes — the useful half.
 */
export function formatUpdatedAt(timestamp: number, lang: LangType, now = new Date()): string {
  const date = new Date(timestamp);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return clock;
  if (date.getFullYear() === now.getFullYear()) {
    return lang === "zh"
      ? `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
      : `${MONTHS_EN[date.getMonth()]} ${date.getDate()}, ${clock}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

/**
 * A 1px hairline, not a middle dot: at 11px a `·` renders 2px wide and nearly
 * disappears once it is set to a muted tone, while a hairline stays legible in
 * every theme and matches the bar's own `border-t`.
 *
 * Declared outside the component so its identity is stable — a nested component
 * would remount every divider on each keystroke.
 */
function Divider({ inset = false }: { inset?: boolean }) {
  // `border` alone is tuned for long hairlines; a 10px stub needs one step more
  // to survive a light theme's panel tint.
  return (
    <span
      aria-hidden="true"
      className={`h-2.5 w-px shrink-0 bg-text-muted/40 ${inset ? "mx-1.5" : ""}`}
    />
  );
}

/**
 * The editor's bottom bar.
 *
 * Layout is fixed by the owner's spec and must not drift: outline toggle →
 * source toggle → **optional** 纯预览编辑 toggle → flexible gap → updated time →
 * save state → statistics. The left cluster is document structure, the right
 * cluster is document state; anything that is neither belongs in the menu bar
 * above.
 *
 * The third switch exists only where the mode does: it renders when
 * `onTogglePurePreview` is passed (the main window) and is absent when it is not
 * (the detached note window keeps the two-mode editor, so a button there would
 * promise something it cannot do). "Six segments" therefore counts the bar's
 * *information* segments, and the left cluster may still grow — every addition
 * stays before the flexible gap and is a document-structure control.
 *
 * Buttons are 24px inside a 28px bar, matching the compressed menu row, so the
 * two bars frame the text at the same weight instead of competing with it.
 */
export default function EditorStatusBar({
  lang,
  outlineOpen,
  onToggleOutline,
  sourceMode,
  onToggleSourceMode,
  purePreview = false,
  onTogglePurePreview,
  updatedAt,
  saveState,
  stats,
}: EditorStatusBarProps) {
  const buttonClass = (pressed: boolean) =>
    `flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
      pressed
        ? "bg-bg-active text-text-primary"
        : "text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary"
    }`;

  const saveLabel =
    saveState === "saving"
      ? t(lang, "saveStateSaving")
      : saveState === "dirty"
        ? t(lang, "unsaved")
        : t(lang, "saved");

  const dotClass =
    saveState === "saved"
      ? "bg-text-muted/30"
      : saveState === "saving"
        ? "bg-accent animate-pulse"
        : "bg-accent";

  return (
    <div
      // `group`, not `toolbar`: half of this row is read-only text, and a
      // toolbar promises arrow-key navigation between controls only.
      role="group"
      aria-label={t(lang, "statusBarLabel")}
      className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-t border-border px-4 text-[11px] leading-none text-text-muted"
    >
      <button
        type="button"
        aria-pressed={outlineOpen}
        aria-label={t(lang, "outlineToggle")}
        title={t(lang, "outlineToggle")}
        onClick={onToggleOutline}
        className={buttonClass(outlineOpen)}
      >
        <ListTree size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-pressed={sourceMode}
        aria-label={t(lang, sourceMode ? "mdViewLive" : "mdViewSource")}
        title={t(lang, sourceMode ? "mdViewLive" : "mdViewSource")}
        onClick={onToggleSourceMode}
        className={buttonClass(sourceMode)}
      >
        {sourceMode ? <Eye size={14} aria-hidden="true" /> : <Code2 size={14} aria-hidden="true" />}
      </button>
      {/* 纯预览编辑: the third control of the left cluster. It is absent (not
          disabled) on surfaces that do not offer the mode, because a button that
          can never be pressed is worse than no button. 源码 mode disables it: the
          two views are exclusive, and the source view is the escape hatch that
          wins. */}
      {onTogglePurePreview && (
        <button
          type="button"
          aria-pressed={purePreview}
          aria-label={t(lang, "purePreviewEdit")}
          title={t(lang, "purePreviewEditHint")}
          onClick={onTogglePurePreview}
          disabled={sourceMode}
          className={`${buttonClass(purePreview)} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          <PenLine size={14} aria-hidden="true" />
        </button>
      )}

      <div className="flex-1" />

      {updatedAt !== null && (
        <>
          <span className="shrink-0 tabular-nums">
            <span className="note-statusbar__time-prefix">{t(lang, "updatedAt")} </span>
            {formatUpdatedAt(updatedAt, lang)}
          </span>
          <Divider />
        </>
      )}

      <span className="flex shrink-0 items-center gap-1" title={saveLabel} aria-live="polite">
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
        <span className={saveState === "dirty" ? "text-text-primary" : undefined}>{saveLabel}</span>
      </span>

      <Divider />

      <span className="flex shrink-0 items-center" title={t(lang, "statsHint")}>
        {/* The narrow layout drops the unit words, so the accessible name is
            spelled out separately instead of relying on the visible text. */}
        <span className="sr-only">
          {tWithParams(lang, "statsHintValues", {
            lines: String(stats.lines),
            words: String(stats.words),
            cjk: String(stats.cjk),
            chars: String(stats.chars),
          })}
        </span>
        <span aria-hidden="true" className="flex items-center tabular-nums">
          <span>{stats.lines}<span className="note-statusbar__stat-label"> {t(lang, "statLines")}</span></span>
          <Divider inset />
          <span>{stats.words}<span className="note-statusbar__stat-label"> {t(lang, "statWords")}</span></span>
          <Divider inset />
          <span>{stats.cjk}<span className="note-statusbar__stat-label"> {t(lang, "statCjk")}</span></span>
          <Divider inset />
          <span>{stats.chars}<span className="note-statusbar__stat-label"> {t(lang, "statChars")}</span></span>
        </span>
      </span>
    </div>
  );
}
