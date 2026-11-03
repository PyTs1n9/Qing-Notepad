import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import type { LangType } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import type { OutlineHeading } from "@/utils/noteOutline";

interface NoteOutlinePanelProps {
  headings: OutlineHeading[];
  /** Line of the heading the viewport is currently inside, or `null` at the top. */
  activeLine: number | null;
  onSelect: (heading: OutlineHeading) => void;
  onClose: () => void;
  lang: LangType;
}

/** Indent per heading level. 10px keeps six levels readable inside 220px. */
const INDENT_STEP = 10;
const BASE_INDENT = 8;

/**
 * Mark the search hits without changing the text colour.
 *
 * A tinted background rather than `text-accent-text`: the active row already
 * sits on `bg-bg-active`, where accent-coloured text drops to ~3.6:1. A
 * background wash keeps whatever colour the row already has and stays legible
 * on both.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={index} className="rounded-[2px] bg-accent/25 px-0.5 text-inherit">
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
    index = haystack.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * The outline column of the note editor, modelled on Typora's 大纲 panel.
 *
 * Three parts, top to bottom: a title row, a filter field, the heading list.
 * Rows wrap instead of truncating — a heading like
 * `③ pd.concat([表1, 表2], ignore_index=True) — 多表按行拼` is unreadable when
 * cut at 220px, and the shape of the list is half of what the panel is for.
 * Hierarchy is carried by indentation and text weight only; the `#` icons the
 * first version drew per row added noise without adding information.
 *
 * It is a real column, not an overlay: expanding it narrows the text instead of
 * covering it. Below 560px the card is too narrow to split, and `index.css`
 * flips this same element to an absolute overlay — the panel never squeezes the
 * text past readability.
 */
export default function NoteOutlinePanel({
  headings,
  activeLine,
  onSelect,
  onClose,
  lang,
}: NoteOutlinePanelProps) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmedQuery = query.trim();
  const visible = useMemo(() => {
    if (!trimmedQuery) return headings;
    const needle = trimmedQuery.toLowerCase();
    return headings.filter((heading) => heading.text.toLowerCase().includes(needle));
  }, [headings, trimmedQuery]);

  // Keep the highlighted row inside the panel without scrolling the editor:
  // `scrollIntoView` would walk every scrollable ancestor, including the page.
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeLine === null) return;
    const row = list.querySelector<HTMLElement>(`[data-outline-line="${activeLine}"]`);
    if (!row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top;
    else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
  }, [activeLine]);

  /**
   * Escape backs out one step: it clears a non-empty filter first and only
   * closes the panel when there is nothing left to undo.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (query) {
      setQuery("");
      inputRef.current?.focus();
      return;
    }
    onClose();
  };

  return (
    <aside
      className="note-outline flex w-[220px] shrink-0 flex-col overflow-hidden border-r border-border"
      aria-label={t(lang, "outlineTitle")}
      onKeyDown={handleKeyDown}
    >
      <div className="flex h-7 shrink-0 items-center px-2.5">
        <span className="text-[11px] font-medium tracking-wide text-text-secondary">
          {t(lang, "outlineTitle")}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-text-muted">
          {/* With a filter on, the plain total would contradict the list below
              it; `2/7` says both "two shown" and "seven exist". */}
          {trimmedQuery ? `${visible.length}/${headings.length}` : headings.length}
        </span>
      </div>

      <div className="shrink-0 px-2 pb-1.5">
        <div className="relative">
          <Search
            size={11}
            aria-hidden="true"
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(lang, "outlineSearch")}
            aria-label={t(lang, "outlineSearch")}
            spellCheck={false}
            className="h-6 w-full rounded-md border border-border/70 bg-bg-primary pl-6 pr-6 text-[11px] text-text-primary placeholder:text-text-muted/80"
          />
          {query && (
            <button
              type="button"
              aria-label={t(lang, "outlineClearSearch")}
              title={t(lang, "outlineClearSearch")}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute right-0.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-text-muted transition-colors hover:text-text-primary"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2">
        {visible.length === 0 ? (
          <div className="px-1 py-1 text-[11px] leading-5 text-text-muted">
            {trimmedQuery ? (
              <p>{t(lang, "outlineNoMatch")}</p>
            ) : (
              <>
                <p>{t(lang, "outlineEmpty")}</p>
                <p className="mt-1 text-text-muted/80">{t(lang, "outlineEmptyHint")}</p>
              </>
            )}
          </div>
        ) : (
          visible.map((heading) => {
            const active = heading.line === activeLine;
            return (
              <button
                key={`${heading.line}:${heading.text}`}
                type="button"
                data-outline-line={heading.line}
                aria-current={active ? "location" : undefined}
                onClick={() => onSelect(heading)}
                style={{ paddingLeft: BASE_INDENT + (heading.level - 1) * INDENT_STEP }}
                className={`block w-full break-words rounded-md py-[3px] pr-2 text-left text-[12px] leading-[18px] transition-colors ${
                  active
                    ? "bg-bg-active text-text-primary"
                    : heading.level === 1
                      ? "text-text-primary hover:bg-bg-hover/60"
                      : "text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary"
                }`}
              >
                <Highlighted text={heading.text} query={trimmedQuery} />
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
