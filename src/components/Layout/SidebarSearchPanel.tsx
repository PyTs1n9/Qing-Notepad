import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Search, X } from "lucide-react";
import EmptyState from "@/components/Layout/EmptyState";
import { useNoteStore } from "@/stores/noteStore";
import type { LangType } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import { loadNoteContent } from "@/utils/storage";
import {
  MAX_BODY_READS,
  MAX_COUNT,
  NOTE_SEARCH_LIMIT,
  buildSearchIndex,
  searchIndex,
  type NoteSearchRange,
} from "@/utils/noteSearch";

interface SidebarSearchPanelProps {
  lang: LangType;
  query: string;
  onQueryChange: (next: string) => void;
  onExit: () => void;
  onOpenNote: (noteId: string) => void;
}

/**
 * Bodies fetched on demand, keyed by note id, module-level on purpose.
 *
 * `noteStore.notes[].content` is empty for every note until that note has been
 * opened (`notes/index.json` carries no body), so searching text without this
 * cache would only ever match titles — and it would do so silently. Living
 * outside the store keeps it out of persistence and out of the Zustand
 * subscribers; the panel bumps a local version counter when a batch lands.
 */
const bodyCache = new Map<string, string>();

/** Six at a time: enough to feel instant, small enough not to stall the UI. */
const BODY_READ_CONCURRENCY = 6;

/** Same class string as `Sidebar`'s `headerActionButton` (24px target). */
const iconButton =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted/70 transition-colors cursor-pointer enabled:hover:bg-bg-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

/** Match highlight, identical to `NoteOutlinePanel`'s — tint, never text colour. */
function Highlighted({ text, ranges }: { text: string; ranges: NoteSearchRange[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, text.length);
    if (end <= start) return;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={index} className="rounded-[2px] bg-accent/25 px-0.5 text-inherit">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * Inline search state for the explorer: a filter field on top, ranked hits below.
 *
 * Both blocks are siblings inside the sidebar's `flex-col`, so the input row
 * stays put while the list scrolls. Enter is intentionally unbound — an IME
 * candidate confirmation is also Enter, and acting on it would jump the user to
 * a note they were only typing about.
 */
const SidebarSearchPanel = ({
  lang,
  query,
  onQueryChange,
  onExit,
  onOpenNote,
}: SidebarSearchPanelProps) => {
  const notes = useNoteStore((s) => s.notes);
  const activeNoteId = useNoteStore((s) => s.activeNoteId);
  const [bodyVersion, setBodyVersion] = useState(0);
  const [pendingReads, setPendingReads] = useState(0);
  // The query whose prefetch pass has finished. The empty state waits for it,
  // otherwise the first keystroke paints "no matches" before the bodies land.
  const [settledQuery, setSettledQuery] = useState<string | null>(null);

  const trimmed = query.trim();
  const deferred = useDeferredValue(trimmed);
  const index = useMemo(() => buildSearchIndex(notes, bodyCache), [notes, bodyVersion]);
  const result = useMemo(() => searchIndex(index, deferred, NOTE_SEARCH_LIMIT), [index, deferred]);

  // Prefetch bodies for notes the index never loaded. Failures are silent: a
  // note linked to an unplugged drive simply degrades to a title-only hit.
  useEffect(() => {
    if (!deferred) {
      setPendingReads(0);
      setSettledQuery(null);
      return;
    }
    const missing = notes
      .filter((note) => note.content === "" && !bodyCache.has(note.id))
      .slice(0, MAX_BODY_READS)
      .map((note) => note.id);
    if (missing.length === 0) {
      setPendingReads(0);
      setSettledQuery(deferred);
      return;
    }

    let cancelled = false;
    let remaining = missing.length;
    setPendingReads(remaining);

    void (async () => {
      for (let i = 0; i < missing.length; i += BODY_READ_CONCURRENCY) {
        const batch = missing.slice(i, i + BODY_READ_CONCURRENCY);
        await Promise.all(
          batch.map(async (id) => {
            try {
              bodyCache.set(id, (await loadNoteContent(id)) ?? "");
            } catch {
              bodyCache.set(id, "");
            }
          }),
        );
        if (cancelled) return;
        remaining -= batch.length;
        setPendingReads(remaining);
        setBodyVersion((version) => version + 1);
      }
      setSettledQuery(deferred);
    })();

    return () => {
      cancelled = true;
    };
  }, [deferred, notes]);

  const truncated = result.totalMatched > result.hits.length;
  const showEmptyState =
    result.hits.length === 0 && pendingReads === 0 && settledQuery === deferred;

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <Search size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
        <input
          autoFocus
          type="text"
          spellCheck={false}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter is deliberately unbound: IME candidate confirmation is also
            // Enter, and jumping to a note mid-composition is a data-entry trap.
            if (event.key === "Escape") {
              event.preventDefault();
              onExit();
            }
          }}
          placeholder={t(lang, "sidebarSearchPlaceholder")}
          aria-label={t(lang, "sidebarSearchPlaceholder")}
          className="h-7 min-w-0 w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
        />
        <button
          type="button"
          onClick={() => onQueryChange("")}
          className={iconButton}
          title={t(lang, "sidebarSearchClear")}
          aria-label={t(lang, "sidebarSearchClear")}
        >
          <X size={12} />
        </button>
      </div>

      {trimmed !== "" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {pendingReads > 0 && (
            <p className="px-2 pb-1 pt-1 text-[10px] text-text-muted">
              {t(lang, "sidebarSearchIndexing")}
            </p>
          )}

          {showEmptyState && (
            <EmptyState
              icon={<Search size={16} />}
              title={t(lang, "searchNoResults")}
              description={t(lang, "searchNoResultsHint")}
            />
          )}

          {result.hits.length > 0 && (
            // `role="listitem"` sits on a wrapper, not on the button: putting it
            // on the button itself replaces the button role, and screen readers
            // then stop announcing "clickable" for the only interactive row.
            <div role="list">
              {result.hits.map((hit) => {
                // Ranges index the raw title; the row renders a trimmed copy, so
                // the highlight shifts by the dropped leading space.
                const leading = hit.title.length - hit.title.trimStart().length;
                const titleText = hit.title.trim() || t(lang, "untitled");
                const titleRanges =
                  leading === 0
                    ? hit.titleRanges
                    : hit.titleRanges
                        .map((range) => ({ start: range.start - leading, end: range.end - leading }))
                        .filter((range) => range.start >= 0);
                const countLabel = tWithParams(lang, "sidebarSearchMatchCount", {
                  count: hit.matchCount,
                });
                return (
                  <div role="listitem" key={hit.noteId}>
                    <button
                      type="button"
                      data-sidebar-search-result={hit.noteId}
                      onClick={() => onOpenNote(hit.noteId)}
                      className={`mb-0.5 flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors cursor-pointer hover:bg-bg-hover ${
                        activeNoteId === hit.noteId ? "flat-active-row" : ""
                      }`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium text-text-primary">
                          <Highlighted text={titleText} ranges={titleRanges} />
                        </span>
                        {hit.snippet && (
                          <span className="line-clamp-2 text-[11px] leading-relaxed text-text-muted">
                            {hit.snippet.clippedHead && "…"}
                            <Highlighted text={hit.snippet.text} ranges={hit.snippet.ranges} />
                            {hit.snippet.clippedTail && "…"}
                          </span>
                        )}
                      </span>
                      <span
                        className="inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full border border-border/70 bg-bg-primary/70 px-1.5 text-[10px] font-semibold tabular-nums text-text-muted"
                        aria-label={countLabel}
                      >
                        {/* Capped at the exported constant, so the label and the
                            ranking cap can never drift apart. */}
                        {hit.matchCount > MAX_COUNT ? `${MAX_COUNT}+` : hit.matchCount}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {truncated && (
            <p className="px-2 py-1 text-[10px] text-text-muted">
              {tWithParams(lang, "sidebarSearchTruncated", {
                total: result.totalMatched,
                shown: result.hits.length,
              })}
            </p>
          )}
        </div>
      )}
    </>
  );
};

export default SidebarSearchPanel;
