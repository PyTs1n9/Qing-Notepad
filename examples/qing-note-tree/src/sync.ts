/**
 * Body excerpts and the AI-summary cache.
 *
 * Two different budgets are at stake:
 *
 * - An **excerpt** is free: it is the first slice of the note itself, computed
 *   on every sync, never stored.
 * - A **summary** costs an API call against the user's own key, so it is cached
 *   by content hash. A note that has not changed since the last summary never
 *   pays twice.
 *
 * Bodies arrive as Markdown. Node cards are plain text, so the markers are
 * stripped first — a card that reads `## 会议记录 - [ ]` is noise, not a title.
 */

const CACHE_KEY = "note-tree.summaries";
const CACHE_LIMIT = 500;
const EXCERPT_LIMIT = 160;

export interface SummaryEntry {
  hash: string;
  text: string;
}

export function hashText(text: string): string {
  // FNV-1a, 32-bit. Not a security boundary — it only answers "did this note
  // change since the cached summary was made", and a collision costs one stale
  // summary, not data.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>~]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerptOf(markdown: string): string {
  const plain = stripMarkdown(markdown);
  return plain.length > EXCERPT_LIMIT ? `${plain.slice(0, EXCERPT_LIMIT)}…` : plain;
}

export async function loadSummaryCache(): Promise<Record<string, SummaryEntry>> {
  try {
    const raw = await qing.storage.get(CACHE_KEY);
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, SummaryEntry> = {};
    for (const [noteId, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as Partial<SummaryEntry> | null;
      if (!entry || typeof entry.hash !== "string" || typeof entry.text !== "string") continue;
      out[noteId] = { hash: entry.hash, text: entry.text };
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveSummaryCache(cache: Record<string, SummaryEntry>): Promise<void> {
  // Trim to the most recently written entries rather than growing without
  // bound: the host gives storage 1 MB and a long-lived library would fill it.
  const entries = Object.entries(cache);
  if (entries.length > CACHE_LIMIT) {
    const trimmed = entries.slice(entries.length - CACHE_LIMIT);
    cache = Object.fromEntries(trimmed);
  }
  await qing.storage.set(CACHE_KEY, cache);
}
