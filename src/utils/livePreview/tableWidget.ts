import type { EditorState } from "@codemirror/state";
import { WidgetType, type EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { attachTableResizer, type TableResizer } from "./tableResize";
import { columnCount, totalOf } from "./tableSizing";

/** A run of cell text with the inline styles the Markdown source gave it. */
export interface InlinePiece {
  text: string;
  strong?: boolean;
  em?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Set for `[label](url)`; the label is the text of the pieces around it. */
  href?: string;
}

export type ColumnAlign = "left" | "center" | "right" | null;

/**
 * One cell of a rendered table, tied back to the source it came from.
 *
 * `from`/`to` cover the cell's **content only** — never the pipes or the spaces
 * that surround it — which is what lets an edit replace exactly the cell text
 * and leave the table's shape (column count, alignment, pipes) untouched.
 */
export interface TableCell {
  /** Source range of the cell content; an empty slot has `from === to`. */
  from: number;
  to: number;
  /** Decoded visible text; the initial value when the cell is edited. */
  text: string;
  /** Render pieces. An untouched cell keeps its inline formatting. */
  pieces: InlinePiece[];
  /**
   * `false` for a cell this row does not have (GFM lets a row be short). It is
   * drawn as an empty cell and refuses to be edited: there is no source range to
   * write to, and inventing one would add a column to the file.
   */
  editable: boolean;
}

export interface TableData {
  header: TableCell[];
  align: ColumnAlign[];
  rows: TableCell[][];
  /**
   * Column widths in px from the sizing comment, or `null` for a table that is
   * sized by the pane. Only ever set when the count matches the table.
   */
  cols: number[] | null;
  /** Identity for `WidgetType.eq`: same text, same render, no DOM rebuild. */
  key: string;
}

/** Nodes that only exist to mark up their parent; their text is not content. */
const MARKER_NODES = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
  "URL",
  "TableDelimiter",
]);

/**
 * Reads a GFM table into plain data.
 *
 * The cell text is taken from the syntax tree rather than re-parsed: the
 * `TableCell` may contain `StrongEmphasis`, `InlineCode` and friends, and the
 * tree already knows where each of those starts. Building the widget from
 * structure (instead of from an HTML string) means no `innerHTML` and therefore
 * no way for note content to inject markup.
 */
export function readTable(node: SyntaxNode, state: EditorState): TableData | null {
  let header: TableCell[] | null = null;
  let align: ColumnAlign[] = [];
  const rows: TableCell[][] = [];

  for (let child = node.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
      case "TableHeader":
        header = readCells(child, state, 0);
        break;
      case "TableDelimiter":
        align = parseAlign(state.doc.sliceString(child.from, child.to));
        break;
      case "TableRow":
        // Pad to the header's width here rather than in the DOM: a short row is
        // a fact about the source, and the widget must not have to guess.
        rows.push(readCells(child, state, header?.length ?? 0));
        break;
      default:
        break;
    }
  }

  if (!header && rows.length === 0) return null;

  const data: TableData = {
    header: header ?? [],
    align,
    rows,
    cols: null,
    key: "",
  };
  data.key = tableKey(data);
  return data;
}

/**
 * The same table with stored widths (or without any).
 *
 * `header` / `align` / `rows` are shared by reference — only the width list and
 * the identity key change, so an already-rendered cell keeps its DOM until the
 * table's own text actually differs.
 */
export function withCols(data: TableData, cols: readonly number[] | null): TableData {
  const next: TableData = {
    header: data.header,
    align: data.align,
    rows: data.rows,
    cols: cols ? [...cols] : null,
    key: "",
  };
  next.key = tableKey(next);
  return next;
}

/**
 * Identity for `WidgetType.eq`.
 *
 * Built from the *rendered* content only: the pieces, the alignment, the column
 * count and the stored widths. Absolute offsets are deliberately absent — the
 * same table moved down by three paragraphs must keep its identity, or every
 * keystroke above it would rebuild the whole table. Editing needs a source
 * range, and it computes one on demand (`posAtDOM` + a fresh `readTable`).
 */
function tableKey(data: Omit<TableData, "key">): string {
  return JSON.stringify([
    data.header.map((cell) => cell.pieces),
    data.align,
    data.rows.map((row) => row.map((cell) => cell.pieces)),
    columnCount(data.header, data.rows),
    data.cols,
  ]);
}

/** One `|`-delimited slot of a row: the content range, before trimming. */
interface RowSlot {
  from: number;
  to: number;
}

/**
 * Splits a row's source into its `|`-delimited slots.
 *
 * The tree cannot answer this on its own: an **empty cell has no `TableCell`
 * node**, so reading cells straight off the children silently drops a column and
 * shifts every following cell one position left. Splitting the line is the only
 * way to know how many slots a row really has.
 *
 * `\|` is content, not a boundary (the parser agrees: it keeps the pair inside
 * one `TableCell`), so the walk skips the character after a backslash. A slot
 * that is empty *and* sits against the row's leading or trailing pipe is a
 * separator artefact, not a column — GFM allows both pipes to be omitted.
 */
function splitRowSlots(state: EditorState, row: SyntaxNode): RowSlot[] {
  const line = state.doc.lineAt(row.from);
  const text = line.text;
  const start = Math.max(0, row.from - line.from);
  const end = Math.min(text.length, row.to - line.from);

  const slots: RowSlot[] = [];
  let slotStart = start;
  for (let index = start; index < end; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "|") continue;
    slots.push({ from: line.from + slotStart, to: line.from + index });
    slotStart = index + 1;
  }
  slots.push({ from: line.from + slotStart, to: line.from + end });

  const trimmed = slots.map((slot) => slotBounds(state, slot));
  if (trimmed.length > 1 && trimmed[0].from === trimmed[0].to) trimmed.shift();
  if (trimmed.length > 1 && trimmed[trimmed.length - 1].from === trimmed[trimmed.length - 1].to) {
    trimmed.pop();
  }
  return trimmed;
}

/**
 * Where a slot's content starts and ends.
 *
 * A cell with text keeps its trimmed range — the padding GFM allows around a
 * cell is not content. An **empty** cell has no range at all, so it becomes a
 * zero-width insertion point instead, and where that point sits decides what the
 * write-back looks like: taking the trimmed edge (after the spaces) turns
 * `|  |` into `|  填|`, so the point is placed right after the first leading
 * space, which writes `| 填 |`.
 */
function slotBounds(state: EditorState, slot: RowSlot): RowSlot {
  const trimmed = trimSlot(state, slot);
  if (trimmed.from !== trimmed.to) return trimmed;

  const first = slot.from < slot.to ? state.doc.sliceString(slot.from, slot.from + 1) : "";
  const at = first && /\s/.test(first) ? slot.from + 1 : slot.from;
  return { from: at, to: at };
}

/** Drops the spaces GFM allows around a cell; the pipes are already gone. */
function trimSlot(state: EditorState, slot: RowSlot): RowSlot {
  let { from, to } = slot;
  while (from < to && /\s/.test(state.doc.sliceString(from, from + 1))) from += 1;
  while (to > from && /\s/.test(state.doc.sliceString(to - 1, to))) to -= 1;
  return { from, to };
}

/**
 * Cells of one row, paired with the `TableCell` nodes that describe them.
 *
 * The node's own range is authoritative where it exists: it is what the parser
 * decided the content is. A slot without a node is a cell the source left empty,
 * so it becomes a zero-width insertion point at the slot's start.
 */
function readCells(row: SyntaxNode, state: EditorState, columns: number): TableCell[] {
  const slots = splitRowSlots(state, row);
  const nodes: SyntaxNode[] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableCell") nodes.push(child);
  }

  const cells: TableCell[] = [];
  let next = 0;
  for (const slot of slots) {
    const candidate = nodes[next] ?? null;
    const node = candidate && candidate.from >= slot.from && candidate.from <= slot.to ? candidate : null;
    if (node) next += 1;

    const from = node ? node.from : slot.from;
    const to = node ? node.to : slot.to;
    const pieces: InlinePiece[] = [];
    if (node) {
      collectPieces(node, state, {}, pieces);
    } else if (to > from) {
      // No node but visible characters: keep them as plain text rather than
      // reporting an empty cell and losing what the user typed.
      pieces.push({ text: state.doc.sliceString(from, to) });
    }
    cells.push({ from, to, text: pieces.map((piece) => piece.text).join(""), pieces, editable: true });
  }

  // A row with fewer slots than the header gets phantom cells: the table keeps
  // its column count, and the missing columns stay uneditable instead of being
  // invented in the Markdown.
  while (cells.length < columns) {
    cells.push({ from: row.to, to: row.to, text: "", pieces: [], editable: false });
  }
  return cells;
}

/**
 * A cell's text, as Markdown that lands back in the same shape.
 *
 * Newlines cannot survive inside a table row (a line break ends the row), and
 * the two characters that would change the table's structure are escaped:
 * `|` would be read as a column boundary and `\` would swallow whatever follows
 * it. Trimming happens first so a cell never grows padding on every edit.
 */
export function encodeCellText(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

/**
 * Walks a cell, carrying the styles of the enclosing inline nodes downward.
 *
 * Text that sits *between* children has no node of its own: `**粗**` exposes
 * only its two `EmphasisMark`s, and the content lives in the gap between them.
 * So the walk emits gaps as well as leaves — the same fact `addInline` in
 * `decorations.ts` works around for hidden markers.
 */
function collectPieces(
  node: SyntaxNode,
  state: EditorState,
  style: Omit<InlinePiece, "text">,
  out: InlinePiece[],
): void {
  if (MARKER_NODES.has(node.name)) return;

  // `\|` inside a cell is an `Escape` leaf: the backslash is syntax, the
  // character after it is content. Emitting the pair verbatim would show the
  // user a `\|` that is not in the rendered cell at all.
  if (node.name === "Escape") {
    const raw = state.doc.sliceString(node.from, node.to);
    if (raw.length > 1) out.push({ ...style, text: raw.slice(1) });
    return;
  }

  const first = node.firstChild;
  if (!first) {
    // A leaf holds bare text.
    if (node.to > node.from) {
      out.push({ ...style, text: state.doc.sliceString(node.from, node.to) });
    }
    return;
  }

  let next = style;
  switch (node.name) {
    case "StrongEmphasis":
      next = { ...style, strong: true };
      break;
    case "Emphasis":
      next = { ...style, em: true };
      break;
    case "Strikethrough":
      next = { ...style, strike: true };
      break;
    case "InlineCode":
      next = { ...style, code: true };
      break;
    case "Link": {
      const url = urlOf(node, state);
      // A link with an unsafe scheme renders as plain text: the label survives,
      // the destination is dropped. Same rule as `utils/markdown.ts`.
      next = url ? { ...style, href: url } : style;
      break;
    }
    default:
      break;
  }

  let cursor = node.from;
  let child: SyntaxNode | null = first;
  while (child) {
    if (child.from > cursor) {
      const gap = state.doc.sliceString(cursor, child.from);
      if (gap) out.push({ ...next, text: gap });
    }
    collectPieces(child, state, next, out);
    cursor = Math.max(cursor, child.to);
    child = child.nextSibling;
  }
  if (cursor < node.to) {
    const tail = state.doc.sliceString(cursor, node.to);
    if (tail) out.push({ ...next, text: tail });
  }
}

function urlOf(link: SyntaxNode, state: EditorState): string | null {
  for (let child = link.firstChild; child; child = child.nextSibling) {
    if (child.name !== "URL") continue;
    const href = state.doc.sliceString(child.from, child.to).trim();
    if (!href) return null;
    if (!/^([a-z][a-z0-9+.-]*:)/i.test(href)) return href; // relative target
    return /^(?:https?|mailto|tel):/i.test(href) ? href : null;
  }
  return null;
}

function parseAlign(text: string): ColumnAlign[] {
  return text
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
    .map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return null;
    });
}

/**
 * Live resizers by widget root.
 *
 * A widget may only hand back DOM, so the resizer cannot live on `this` without
 * leaking listeners between rebuilds: `destroy(dom)` looks it up by the same node
 * that `toDOM` registered.
 */
const RESIZERS = new WeakMap<HTMLElement, TableResizer>();

/**
 * Cell-editing listeners by widget root, same lifetime argument as `RESIZERS`.
 * Typed structurally so this module never has to import the editing layer.
 */
const INTERACTIONS = new WeakMap<HTMLElement, { destroy(): void }>();

/**
 * Mounts the in-place editing listeners on a rendered table.
 *
 * Injected instead of imported: `tableEditing.ts` reads tables with the very
 * functions below, so a direct import would be a cycle — and `verify:architecture`
 * forbids one outright. `tableField.ts` is the single place that knows both.
 */
export type TableInteractionMount = (wrap: HTMLElement, view: EditorView) => { destroy(): void };

export interface TableWidgetOptions {
  /**
   * Mount drag handles. Off for read-only surfaces and the sticky window: they
   * have no business writing column widths into the note file.
   */
  resizable: boolean;
  /**
   * 纯预览编辑模式: the table takes the pointer for itself — text can be dragged
   * across cells, a double-click edits one in place, and CodeMirror must not
   * move the caret into the block (which would reveal the source). Requires
   * `resizable` for the column-edge gesture; the two are independent knobs.
   */
  interactive?: boolean;
  /** Mounted only when `interactive`; omitted means "render, do not edit". */
  mountInteraction?: TableInteractionMount;
}

/**
 * The rendered table, as a block replacement.
 *
 * `ignoreEvent` returns false for everything except the drag handles, so a click
 * on a cell lands in the editor's mouse handling and moves the caret to the
 * block — which reveals the source (L3), the same way a click on a fenced block
 * does. Returning true for a handle makes CodeMirror ignore that event
 * completely (no caret, no selection drag), which is what a resize gesture needs.
 *
 * In the interactive mode every event is ignored instead: the widget keeps its
 * rendered form under the pointer, the browser's own selection does the
 * highlighting, and `tableEditing.ts` owns the double-click. `widget.editable`
 * is not the tool here — it makes CodeMirror drive contenteditable, and the
 * whole point is that it must not.
 */
export class TableWidget extends WidgetType {
  constructor(
    readonly data: TableData,
    readonly options: TableWidgetOptions,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return (
      other.data.key === this.data.key &&
      other.options.resizable === this.options.resizable &&
      other.options.interactive === this.options.interactive
    );
  }

  get estimatedHeight(): number {
    return 34 + this.data.rows.length * 34;
  }

  ignoreEvent(event: Event): boolean {
    if (this.options.interactive) return true;
    const target = event.target;
    return target instanceof Element && target.closest(".cm-md-table-handle") !== null;
  }

  toDOM(view: EditorView): HTMLElement {
    const interactive = this.options.interactive === true;
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    // Frozen DOM contract: the editing layer finds the table through these
    // attributes, never through positions.
    wrap.dataset.qingTable = "";
    wrap.dataset.interactive = interactive ? "true" : "false";

    const table = document.createElement("table");
    table.className = "cm-md-table";
    if (interactive) table.dataset.interactive = "true";

    if (this.data.header.length > 0) {
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      this.data.header.forEach((cell, index) => {
        const th = document.createElement("th");
        applyAlign(th, this.data.align[index]);
        renderCell(th, cell, -1, index);
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    if (this.data.rows.length > 0) {
      const tbody = document.createElement("tbody");
      this.data.rows.forEach((row, rowIndex) => {
        const tr = document.createElement("tr");
        row.forEach((cell, index) => {
          const td = document.createElement("td");
          applyAlign(td, this.data.align[index]);
          renderCell(td, cell, rowIndex, index);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
    }

    const columns = columnCount(this.data.header, this.data.rows);
    const cols = this.data.cols;

    // A width list that does not match the table is ignored rather than
    // partially applied: half-fixed, half-auto reads as a rendering bug. The
    // comment itself is untouched — only the layout falls back.
    if (cols && cols.length === columns) {
      const colgroup = document.createElement("colgroup");
      for (const width of cols) {
        const col = document.createElement("col");
        col.style.width = `${width}px`;
        colgroup.appendChild(col);
      }
      table.insertBefore(colgroup, table.firstChild);
      table.style.tableLayout = "fixed";
      table.style.width = `${totalOf(cols)}px`;
      table.classList.add("cm-md-table--fixed");
    }

    wrap.appendChild(table);

    if (this.options.resizable && columns > 0) {
      wrap.classList.add("cm-md-table-wrap--resizable");
      RESIZERS.set(
        wrap,
        attachTableResizer({ wrap, table, view, cols: this.data.cols, enabled: true }),
      );
    }

    if (interactive && this.options.mountInteraction) {
      INTERACTIONS.set(wrap, this.options.mountInteraction(wrap, view));
    }

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    RESIZERS.get(dom)?.destroy();
    RESIZERS.delete(dom);
    INTERACTIONS.get(dom)?.destroy();
    INTERACTIONS.delete(dom);
  }
}

/**
 * A cell element, plus the coordinates the editing layer uses to find it again
 * after the widget has been rebuilt: `-1` is the header row.
 */
function renderCell(el: HTMLElement, cell: TableCell, row: number, column: number): void {
  el.dataset.cell = `${row},${column}`;
  if (!cell.editable) {
    // A column this row does not have. Kept empty on purpose: rendering the
    // header's text again would look like data the file does not contain.
    return;
  }
  renderCellPieces(el, cell.pieces);
}

function applyAlign(cell: HTMLElement, align: ColumnAlign): void {
  if (align) cell.style.textAlign = align;
}

/** Writes a cell's inline pieces as DOM. Never an HTML string, never `innerHTML`. */
export function renderCellPieces(parent: HTMLElement, pieces: readonly InlinePiece[]): void {
  for (const piece of pieces) {
    let node: Node = document.createTextNode(piece.text);

    if (piece.code) {
      const code = document.createElement("code");
      code.textContent = piece.text;
      node = code;
    } else if (piece.href) {
      const link = document.createElement("a");
      link.href = piece.href;
      link.textContent = piece.text;
      node = link;
    }

    if (piece.strong || piece.em || piece.strike) {
      const span = document.createElement("span");
      if (piece.strong) span.style.fontWeight = "700";
      if (piece.em) span.style.fontStyle = "italic";
      if (piece.strike) span.style.textDecoration = "line-through";
      span.appendChild(node);
      node = span;
    }

    parent.appendChild(node);
  }
}
