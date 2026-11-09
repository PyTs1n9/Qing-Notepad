/**
 * Body/title search for the sidebar search panel.
 *
 * Pure functions only: `import type` of `Note` and nothing else. The panel owns
 * the async body prefetch (cold start has empty `content`), this module only
 * turns text into ranked hits, so it stays testable in plain Node.
 *
 * Two invariants worth stating up front, both of them loader bugs in disguise:
 *
 * 1. **Never build a RegExp from the query.** A user typing `(` or `*.` must
 *    degrade to "no matches", not to a thrown exception in a render path.
 * 2. **Offsets always refer to the original text.** Snippets are re-scanned
 *    after cleaning, because a highlight range computed on raw markdown points
 *    into characters that cleaning already removed (`[text](url)` loses `url`).
 */
import type { Note } from "@/types";

export const NOTE_SEARCH_LIMIT = 10;
export const SNIPPET_WINDOW = 140;
export const SNIPPET_LEAD = 32;
export const MAX_BODY_CHARS = 200_000;
export const MAX_COUNT = 999;
export const MAX_BODY_READS = 800;

/** Half-open `[start, end)` slice of the text it is returned with. */
export interface NoteSearchRange {
  start: number;
  end: number;
}

export interface NoteSearchDoc {
  note: Note;
  titleLower: string;
  /** `null` when lower-casing changes length (e.g. `İ`), i.e. offsets drift. */
  bodyLower: string | null;
  /** Effective body text, already truncated to `MAX_BODY_CHARS`. */
  body: string;
}

export interface NoteSearchSnippet {
  text: string;
  ranges: NoteSearchRange[];
  clippedHead: boolean;
  clippedTail: boolean;
}

export interface NoteSearchHit {
  noteId: string;
  title: string;
  titleMatched: boolean;
  titleRanges: NoteSearchRange[];
  matchCount: number;
  snippet: NoteSearchSnippet | null;
}

export interface NoteSearchResult {
  hits: NoteSearchHit[];
  totalMatched: number;
}

/** `haystackLower === null` means "offsets unreliable" → positional re-scan. */
function findNext(haystack: string, haystackLower: string | null, needle: string, from: number): number {
  if (haystackLower !== null) return haystackLower.indexOf(needle, from);
  for (let i = from; i + needle.length <= haystack.length; i += 1) {
    if (haystack.slice(i, i + needle.length).toLowerCase() === needle) return i;
  }
  return -1;
}

/**
 * Every non-overlapping occurrence, in ascending order.
 *
 * `needle` must already be trimmed + lower-cased by the caller.
 */
function collectRanges(haystack: string, haystackLower: string | null, needle: string): NoteSearchRange[] {
  if (!needle || !haystack) return [];
  const safeLower = haystackLower !== null && haystackLower.length === haystack.length ? haystackLower : null;
  const ranges: NoteSearchRange[] = [];
  let cursor = 0;
  let index = findNext(haystack, safeLower, needle, cursor);
  while (index >= 0) {
    ranges.push({ start: index, end: index + needle.length });
    cursor = index + needle.length;
    index = findNext(haystack, safeLower, needle, cursor);
  }
  return ranges;
}

/** Non-overlapping hit count, capped at `MAX_COUNT`. */
export function countOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower || !haystackLower) return 0;
  let count = 0;
  let cursor = 0;
  let index = haystackLower.indexOf(needleLower, cursor);
  while (index >= 0 && count < MAX_COUNT) {
    count += 1;
    cursor = index + needleLower.length;
    index = haystackLower.indexOf(needleLower, cursor);
  }
  return count;
}

function countIn(haystack: string, haystackLower: string | null, needle: string): number {
  if (!needle || !haystack) return 0;
  const safeLower = haystackLower !== null && haystackLower.length === haystack.length ? haystackLower : null;
  let count = 0;
  let cursor = 0;
  let index = findNext(haystack, safeLower, needle, cursor);
  while (index >= 0 && count < MAX_COUNT) {
    count += 1;
    cursor = index + needle.length;
    index = findNext(haystack, safeLower, needle, cursor);
  }
  return count;
}

/**
 * Strip enough markdown/HTML that a 140-char window reads as prose.
 *
 * Single `*` / `_` are deliberately left alone: `2*3` and `snake_case` are far
 * more common in notes than single-char emphasis.
 */
export function cleanSnippetText(raw: string): string {
  let text = raw;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Fenced code delimiters take the whole line with them.
  text = text.replace(/^[ \t]*(?:```|~~~).*$/gm, " ");
  text = text.replace(/^[ \t]*#{1,6}\s+/gm, "");
  text = text.replace(/^[ \t]*>\s?/gm, "");
  text = text.replace(/^[ \t]*[-*+]\s+/gm, "");
  text = text.replace(/^[ \t]*\d{1,3}[.)]\s+/gm, "");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/_([^_\n]+)_/g, "$1");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
  return text.replace(/\s+/g, " ").trim();
}

/** Whitespace folding only — the fallback when cleaning ate the match. */
function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function buildSnippet(body: string, bodyLower: string | null, needle: string): NoteSearchSnippet | null {
  const first = findNext(body, bodyLower, needle, 0);
  if (first < 0) return null;

  let start = Math.max(0, first - SNIPPET_LEAD);
  let end = start + SNIPPET_WINDOW;
  if (end > body.length) {
    end = body.length;
    start = Math.max(0, end - SNIPPET_WINDOW);
  }
  // Start on a word boundary when we clipped, but never step past the hit.
  if (start > 0) {
    const window = body.slice(start, Math.min(start + 12, end));
    const space = window.search(/\s/);
    if (space > 0 && start + space + 1 <= first) start += space + 1;
  }

  const raw = body.slice(start, end);
  const clippedHead = start > 0;
  const clippedTail = end < body.length;

  let text = cleanSnippetText(raw);
  let ranges = collectRanges(text, text.toLowerCase(), needle);
  if (ranges.length === 0) {
    // The hit landed inside a URL/tag/marker that cleaning deleted: show the
    // raw window with only whitespace folded. Still empty → keep the text.
    text = collapseWhitespace(raw);
    ranges = collectRanges(text, text.toLowerCase(), needle);
  }
  return { text, ranges, clippedHead, clippedTail };
}

function lowerBody(content: string): { body: string; bodyLower: string | null } {
  const body = content.length > MAX_BODY_CHARS ? content.slice(0, MAX_BODY_CHARS) : content;
  const lowered = body.toLowerCase();
  return { body, bodyLower: lowered.length === body.length ? lowered : null };
}

/**
 * Per-note projection cache, keyed by the (immutable) `Note` object.
 *
 * The panel rebuilds the index once per body-prefetch batch, so without this a
 * 1,000-note library would re-lower-case several megabytes of text on every
 * batch — the search field would stutter while bodies stream in. Keying on the
 * `Note` object is safe because the store replaces it on edit; the source string
 * is compared too, which covers the prefetch map filling in behind the note.
 *
 * It has no observable effect other than speed, so the module stays a set of
 * pure functions from the caller's point of view.
 */
interface ProjectionCache {
  title: string;
  source: string;
  titleLower: string;
  body: string;
  bodyLower: string | null;
}
const projectionCache = new WeakMap<Note, ProjectionCache>();

/**
 * Build the searchable projection once per note-list/body-cache change.
 *
 * `bodies` is the panel's prefetch cache: on cold start `note.content` is empty
 * for every note (the index file stores no body), so without it body search
 * would silently match nothing at all.
 */
export function buildSearchIndex(notes: Note[], bodies?: Map<string, string>): NoteSearchDoc[] {
  return notes.map((note) => {
    const title = note.title ?? "";
    const inline = note.content ?? "";
    const source = inline.length > 0 ? inline : bodies?.get(note.id) ?? "";
    const cached = projectionCache.get(note);
    if (cached && cached.title === title && cached.source === source) {
      return { note, titleLower: cached.titleLower, bodyLower: cached.bodyLower, body: cached.body };
    }
    const { body, bodyLower } = lowerBody(source);
    const titleLower = title.toLowerCase();
    projectionCache.set(note, { title, source, titleLower, body, bodyLower });
    return { note, titleLower, bodyLower, body };
  });
}

function updatedAtMs(note: Note): number {
  const parsed = Date.parse(note.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Title hit first, then more hits, then fresher, then stable by id. */
function compareEntries(
  a: { hit: NoteSearchHit; note: Note },
  b: { hit: NoteSearchHit; note: Note },
): number {
  if (a.hit.titleMatched !== b.hit.titleMatched) return a.hit.titleMatched ? -1 : 1;
  if (a.hit.matchCount !== b.hit.matchCount) return b.hit.matchCount - a.hit.matchCount;
  const byUpdated = updatedAtMs(b.note) - updatedAtMs(a.note);
  if (byUpdated !== 0) return byUpdated;
  return a.hit.noteId < b.hit.noteId ? -1 : a.hit.noteId > b.hit.noteId ? 1 : 0;
}

export function searchIndex(
  index: NoteSearchDoc[],
  query: string,
  limit: number = NOTE_SEARCH_LIMIT,
): NoteSearchResult {
  const needle = query.trim().toLowerCase();
  if (!needle) return { hits: [], totalMatched: 0 };

  const matched: Array<{ hit: NoteSearchHit; note: Note }> = [];
  for (const doc of index) {
    const titleRanges = collectRanges(doc.note.title ?? "", doc.titleLower, needle);
    const titleMatched = titleRanges.length > 0;
    const bodyCount = doc.body ? countIn(doc.body, doc.bodyLower, needle) : 0;
    if (!titleMatched && bodyCount === 0) continue;

    const snippet = bodyCount > 0 ? buildSnippet(doc.body, doc.bodyLower, needle) : null;
    matched.push({
      note: doc.note,
      hit: {
        noteId: doc.note.id,
        title: doc.note.title ?? "",
        titleMatched,
        titleRanges,
        // Title and body are capped separately so a 200k-char body can never
        // overflow the badge; the sum therefore tops out at 2 × MAX_COUNT.
        // Deliberately *not* re-capped: re-capping would make `999` mean both
        // "exactly 999" and "999 or more". The row renders `${MAX_COUNT}+` above
        // the cap, which keeps the number honest and the branch reachable.
        matchCount: Math.min(titleRanges.length, MAX_COUNT) + bodyCount,
        snippet,
      },
    });
  }

  matched.sort(compareEntries);

  const hits = matched.slice(0, Math.max(0, limit)).map((entry) => entry.hit);
  return { hits, totalMatched: matched.length };
}

/** Convenience for callers that hold the note list only (title-only when cold). */
export function searchNotes(
  notes: Note[],
  query: string,
  limit: number = NOTE_SEARCH_LIMIT,
): NoteSearchResult {
  return searchIndex(buildSearchIndex(notes), query, limit);
}
