import { Code, Columns2, Eye, PenLine, type LucideIcon } from "lucide-react";

/**
 * - `live`: real-time rendering of the same Markdown buffer (Typora-style).
 *   Wired to the source editor today, so it differs from `source` only in its
 *   label until the decoration layer lands (`docs/typora-editor-impl-plan.md` M2).
 * - `source`: raw Markdown with syntax highlighting.
 * - `preview`: read-only render through `renderMarkdown`.
 * - `split`: source and preview side by side.
 */
export type MarkdownViewMode = "live" | "source" | "preview" | "split";

/**
 * Pane set of the cloud editor, which keeps the pre-`live` three panes. Callers
 * own their own set now: the segmented control no longer assumes three slots.
 */
export const MARKDOWN_VIEW_ORDER = ["source", "preview", "split"] as const;

const VIEW_ICONS: Record<MarkdownViewMode, LucideIcon> = {
  live: PenLine,
  source: Code,
  preview: Eye,
  split: Columns2,
};

/** `p-0.5` on the track: 0.125rem = 2px per side at the default 16px root. */
const TRACK_INSET_PX = 2;

interface MarkdownViewSwitchProps<Mode extends MarkdownViewMode> {
  /** Modes rendered, in visual order. Pill geometry derives from the length. */
  modes: readonly Mode[];
  value: MarkdownViewMode;
  onChange: (mode: Mode) => void;
  /** Accessible names / tooltips, one per rendered mode. Icon-only otherwise. */
  labels: Record<Mode, string>;
  /** Extra classes for the track, e.g. spacing tweaks in a given toolbar. */
  className?: string;
  iconSize?: number;
}

/**
 * Icon-only Markdown view switch shared by the local and cloud editors.
 * Labels live in `title` / `aria-label` so the toolbar only costs one row and
 * roughly half the horizontal space the text version needed.
 *
 * The track is a grid of `modes.length` equal slots and the pill is one slot
 * wide, so both the pill width and its step follow the caller's mode count.
 */
const MarkdownViewSwitch = <Mode extends MarkdownViewMode>({
  modes,
  value,
  onChange,
  labels,
  className,
  iconSize = 15,
}: MarkdownViewSwitchProps<Mode>) => {
  const slotCount = modes.length;
  if (slotCount === 0) return null;

  // `value` is normally one of `modes`. If a caller ever narrows its set while
  // state still holds a dropped mode, park the pill on the first slot instead
  // of rendering it at a negative offset.
  const activeIndex = Math.max(
    0,
    modes.findIndex((mode) => mode === value),
  );

  return (
    <div
      role="group"
      style={{ gridTemplateColumns: `repeat(${slotCount}, minmax(0, 1fr))` }}
      className={`relative grid h-8 shrink-0 items-center overflow-hidden rounded-full bg-bg-secondary p-0.5 ${
        className ?? ""
      }`}
    >
      <div
        className="markdown-view-pill pointer-events-none absolute inset-y-0.5 left-0.5 rounded-full"
        style={{
          width: `calc((100% - ${TRACK_INSET_PX * 2}px) / ${slotCount})`,
          // Percentages resolve against the pill's own width, which is exactly
          // one slot, so one step is one slot at any slot count.
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      >
        <span key={value} className="markdown-view-pill-fill" />
      </div>
      {modes.map((mode) => {
        // Annotated: with a generic `Mode`, the indexed lookup stays a deferred
        // access type, and TS then fails to resolve the icon's own props.
        const Icon: LucideIcon = VIEW_ICONS[mode];
        const active = mode === value;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            title={labels[mode]}
            aria-label={labels[mode]}
            aria-pressed={active}
            className={`relative z-10 flex h-7 w-9 cursor-pointer items-center justify-center rounded-full leading-none transition-colors duration-150 ${
              active
                ? "text-on-accent"
                : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            }`}
          >
            <Icon size={iconSize} />
          </button>
        );
      })}
    </div>
  );
};

export default MarkdownViewSwitch;
