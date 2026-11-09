import type { EditorState } from "@codemirror/state";

/**
 * Where a table's column widths live.
 *
 * GFM has no place for a width: the only columns it knows are the `|` separators.
 * `docs/decisions-table-resize.md` records why the carrier is an HTML comment on
 * the line *above* the table — a `<colgroup>` in the Markdown would parse as one
 * `HTMLBlock` and swallow the table, so it is only ever used in the rendered DOM.
 *
 * This module is deliberately pure: no DOM, no `EditorView`. Everything here can
 * be asserted headlessly (`scripts/verify-table-sizing.mjs`), and the drag
 * gesture in `tableResize.ts` decides *when* to call it, not *what* it means.
 */

/** Two Chinese characters plus cell padding; below this a header always wraps. */
export const MIN_COL_WIDTH = 48;

/** Everything `formatSizing` writes starts with this, so a line can be spotted cheaply. */
export const SIZING_PREFIX = "<!-- qing-table:";

export interface TableSizing {
  /** Offset of the comment line's first character. */
  from: number;
  /** Offset one past its last character. The line break is *not* included. */
  to: number;
  /**
   * Widths in px, in column order, or `null` when they do not fit this table
   * (column count changed by hand). The comment is still reported — it has to be
   * hidden and it is still what a double-click on a handle deletes.
   */
  cols: number[] | null;
}

/**
 * `w=` and the numbers, nothing else. `\d+` alone rejects negatives, decimals
 * and letters; the anchors reject a comment with extra prose; the explicit
 * `-->` rejects an unterminated comment. `[:0]` is checked separately below
 * because `\d+` happily matches `0`.
 */
const SIZING_PATTERN = /^<!--\s*qing-table\s*:\s*w\s*=\s*(\d+(?:\s*,\s*\d+)*)\s*-->$/;
const SIZING_HEAD = /^<!--\s*qing-table\s*:/;

/** `[180, 220, 160]` → `<!-- qing-table:w=180,220,160 -->`. */
export function formatSizing(cols: readonly number[]): string {
  return `${SIZING_PREFIX}w=${cols.join(",")} -->`;
}

/** Cheap prefix test, for a line that has not been parsed yet. */
export function looksLikeSizing(text: string): boolean {
  return SIZING_HEAD.test(text.trim());
}

/**
 * Widths out of a comment, or `null` if the line is anything else.
 *
 * Whitespace around `=` and after each comma is tolerated: the comment is
 * hand-editable, and a user who adds a space should not lose their table sizes.
 */
export function parseSizingColumns(text: string): number[] | null {
  const match = SIZING_PATTERN.exec(text.trim());
  if (!match) return null;
  const cols = match[1].split(",").map((part) => Number(part.trim()));
  if (cols.length === 0) return null;
  if (cols.some((value) => !Number.isInteger(value) || value < 1)) return null;
  return cols;
}

/**
 * The sizing comment belonging to the table that starts at `tableFrom`.
 *
 * Only the line immediately above counts: a blank line in between means the
 * comment belongs to whatever came before, not to this table. A table on the
 * document's first line therefore has none.
 */
export function findSizingComment(state: EditorState, tableFrom: number): TableSizing | null {
  const first = state.doc.lineAt(Math.max(0, Math.min(tableFrom, state.doc.length)));
  if (first.number <= 1) return null;
  const previous = state.doc.line(first.number - 1);
  if (!looksLikeSizing(previous.text)) return null;
  const cols = parseSizingColumns(previous.text);
  if (!cols) return null;
  return { from: previous.from, to: previous.to, cols };
}

/**
 * Columns a table really has: the longest row wins.
 *
 * A GFM table lets a row carry fewer cells than the header (`| a | b |` then
 * `| 1 |`), and a stored width list has to cover the cells that exist.
 */
export function columnCount(header: readonly unknown[], rows: readonly (readonly unknown[])[]): number {
  let columns = header.length;
  for (const row of rows) columns = Math.max(columns, row.length);
  return columns;
}

/**
 * Stored widths, or `null` when the table no longer matches them.
 *
 * A mismatch is not an error to repair — it means the user edited the Markdown
 * by hand. The table falls back to auto layout and the comment is left alone;
 * nothing here rewrites the document.
 */
export function normalizeSizing(cols: number[] | null, columns: number): number[] | null {
  if (!cols) return null;
  if (columns <= 0 || cols.length !== columns) return null;
  if (cols.some((width) => !Number.isInteger(width) || width < MIN_COL_WIDTH)) return null;
  if (totalOf(cols) < minTotal(columns)) return null;
  return [...cols];
}

export function totalOf(cols: readonly number[]): number {
  let total = 0;
  for (const width of cols) total += width;
  return total;
}

export function minTotal(columns: number): number {
  return Math.max(0, columns) * MIN_COL_WIDTH;
}

/** Shrink a table that is wider than `maxTotal`; never grow one. */
export function clampTotal(cols: readonly number[], maxTotal: number): number[] {
  if (totalOf(cols) > maxTotal) return scaleTo(cols, maxTotal);
  return cols.map((width) => Math.round(width));
}

/**
 * Drag the boundary between column `boundary` and `boundary + 1`.
 *
 * The pair keeps its total, so the table's width does not move — the same feel
 * as Typora's inner handles, and the reason a drag cannot push the table past
 * the pane. Both columns stay at or above the floor.
 */
export function resizeInner(cols: readonly number[], boundary: number, delta: number): number[] {
  const next = cols.map((width) => Math.round(width));
  if (boundary < 0 || boundary + 1 >= next.length) return next;

  const pair = next[boundary] + next[boundary + 1];
  // A pair narrower than two floors has no legal split; leave it alone rather
  // than hand back a column under the minimum.
  if (pair < MIN_COL_WIDTH * 2) return next;

  const wanted = Math.round(next[boundary] + Math.round(delta));
  next[boundary] = Math.min(pair - MIN_COL_WIDTH, Math.max(MIN_COL_WIDTH, wanted));
  next[boundary + 1] = pair - next[boundary];
  return next;
}

/**
 * Rescale the whole table to `targetTotal`, keeping the proportions.
 *
 * A target below `columns × MIN_COL_WIDTH` cannot be honoured: the floor wins,
 * because an unusable 30px column is a worse outcome than a few pixels of
 * overflow. Within the legal range the sum is exact — the rounding remainder is
 * taken from (or given to) the widest column.
 */
export function scaleTo(cols: readonly number[], targetTotal: number): number[] {
  const columns = cols.length;
  if (columns === 0) return [];

  const total = totalOf(cols);
  const target = Math.max(Math.round(targetTotal), minTotal(columns));
  const next =
    total > 0
      ? cols.map((width) => Math.round((width * target) / total))
      : cols.map(() => Math.floor(target / columns));

  // Rounding can land a column under the floor. Lift it, then take those pixels
  // back from the widest columns — which may have to happen more than once,
  // because a donor can end up under the floor itself.
  let spent = 0;
  for (let index = 0; index < columns; index += 1) {
    if (next[index] < MIN_COL_WIDTH) {
      spent += MIN_COL_WIDTH - next[index];
      next[index] = MIN_COL_WIDTH;
    }
  }
  while (spent > 0) {
    const donor = widestIndex(next);
    if (donor < 0) break;
    const spare = next[donor] - MIN_COL_WIDTH;
    if (spare <= 0) break;
    const take = Math.min(spare, spent);
    next[donor] -= take;
    spent -= take;
  }

  // Exact total. `excess` is normally a handful of px from the rounding step.
  let excess = totalOf(next) - target;
  if (excess < 0) {
    const widest = widestIndex(next);
    if (widest >= 0) next[widest] -= excess;
    return next;
  }
  while (excess > 0) {
    const donor = widestIndex(next);
    if (donor < 0) break;
    const spare = next[donor] - MIN_COL_WIDTH;
    if (spare <= 0) break;
    const take = Math.min(spare, excess);
    next[donor] -= take;
    excess -= take;
  }
  return next;
}

/** Index of the widest column; first one wins, so results are deterministic. */
function widestIndex(cols: readonly number[]): number {
  let index = -1;
  let width = -1;
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] > width) {
      width = cols[i];
      index = i;
    }
  }
  return index;
}

export interface SizingChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * The one change that stores widths for the table at `tableFrom`.
 *
 * Existing comment: replaced in place, so the note keeps a single source of
 * truth. No comment: inserted as a line of its own directly above the table —
 * the text ends with `\n`, so the table keeps starting on a line boundary and
 * stays a top-level `Table` for the parser.
 */
export function insertSizingChange(
  state: EditorState,
  tableFrom: number,
  cols: readonly number[],
): SizingChange {
  const first = state.doc.lineAt(Math.max(0, Math.min(tableFrom, state.doc.length)));
  const previous = first.number > 1 ? state.doc.line(first.number - 1) : null;
  if (previous && looksLikeSizing(previous.text)) {
    return { from: previous.from, to: previous.to, insert: formatSizing(cols) };
  }
  return { from: first.from, to: first.from, insert: `${formatSizing(cols)}\n` };
}

/**
 * Removing the comment returns the table to auto layout.
 *
 * The line break goes with it, otherwise the reset would leave the blank line it
 * used to occupy — a visible edit that the user did not ask for.
 */
export function removeSizingChange(state: EditorState, tableFrom: number): SizingChange | null {
  const sizing = findSizingComment(state, tableFrom);
  if (!sizing) return null;
  const to = sizing.to < state.doc.length ? sizing.to + 1 : sizing.to;
  return { from: sizing.from, to, insert: "" };
}
