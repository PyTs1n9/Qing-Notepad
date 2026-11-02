import type { EditorState } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

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

export interface TableData {
  header: InlinePiece[][];
  align: ColumnAlign[];
  rows: InlinePiece[][][];
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
  let header: InlinePiece[][] | null = null;
  let align: ColumnAlign[] = [];
  const rows: InlinePiece[][][] = [];

  for (let child = node.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
      case "TableHeader":
        header = readCells(child, state);
        break;
      case "TableDelimiter":
        align = parseAlign(state.doc.sliceString(child.from, child.to));
        break;
      case "TableRow":
        rows.push(readCells(child, state));
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
    key: "",
  };
  data.key = JSON.stringify([data.header, data.align, data.rows]);
  return data;
}

function readCells(row: SyntaxNode, state: EditorState): InlinePiece[][] {
  const cells: InlinePiece[][] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableCell") continue;
    const pieces: InlinePiece[] = [];
    collectPieces(child, state, {}, pieces);
    cells.push(pieces);
  }
  return cells;
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
 * The rendered table, as a block replacement.
 *
 * `ignoreEvent` returns false so a click lands in the editor's mouse handling
 * and moves the caret to the block — which reveals the source (L3), the same
 * way a click on a fenced block does.
 */
export class TableWidget extends WidgetType {
  constructor(readonly data: TableData) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.data.key === this.data.key;
  }

  get estimatedHeight(): number {
    return 34 + this.data.rows.length * 34;
  }

  ignoreEvent(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";

    const table = document.createElement("table");
    table.className = "cm-md-table";

    if (this.data.header.length > 0) {
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      this.data.header.forEach((cell, index) => {
        const th = document.createElement("th");
        applyAlign(th, this.data.align[index]);
        appendPieces(th, cell);
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    if (this.data.rows.length > 0) {
      const tbody = document.createElement("tbody");
      for (const row of this.data.rows) {
        const tr = document.createElement("tr");
        row.forEach((cell, index) => {
          const td = document.createElement("td");
          applyAlign(td, this.data.align[index]);
          appendPieces(td, cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    wrap.appendChild(table);
    return wrap;
  }
}

function applyAlign(cell: HTMLElement, align: ColumnAlign): void {
  if (align) cell.style.textAlign = align;
}

function appendPieces(parent: HTMLElement, pieces: readonly InlinePiece[]): void {
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
