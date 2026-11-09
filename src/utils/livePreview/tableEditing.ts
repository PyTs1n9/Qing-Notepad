import { Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { handleMarkdownLinkClick, isLinkClickModifier } from "../markdownLinkActions";
import { encodeCellText, readTable, type TableCell, type TableData } from "./tableWidget";
import { columnCount } from "./tableSizing";

/**
 * In-place cell editing for a rendered table.
 *
 * The whole feature exists because a `Decoration.replace` makes its own range
 * unreachable: a table widget normally refuses every event so a click lands in
 * CodeMirror, moves the caret into the block and falls the table back to source
 * (L3). 纯预览编辑 mode needs the opposite — the table stays rendered, the text
 * can be selected across cells, and a double-click edits one cell without ever
 * showing the Markdown — so the widget ignores events and this module takes the
 * pointer and the keyboard for itself.
 *
 * Three hard constraints shape the code:
 *
 * 1. **Positions are never captured.** The document can change under the edit
 *    (another window, an autosave reload). Every commit re-derives the table
 *    from `posAtDOM` + a fresh `readTable`, exactly like `tableResize.ts` does
 *    for its width comment.
 * 2. **Never dispatch from inside a CodeMirror update.** A widget is created
 *    while the view is updating, so nothing here runs on mount; every write
 *    happens from a DOM event or the next frame.
 * 3. **One transaction per edit.** The widget is rebuilt by the change, which
 *    destroys the DOM the user was typing in — so focus is restored on the next
 *    animation frame by looking the cell up again through its coordinates.
 */

/** `row` is `-1` for the header; `column` is 0-based like the DOM contract. */
interface CellCoords {
  row: number;
  column: number;
}

interface Point {
  x: number;
  y: number;
}

interface EditSession {
  view: EditorView;
  wrap: HTMLElement;
  cellEl: HTMLElement;
  row: number;
  column: number;
}

/**
 * The cell being edited, per view — one at a time, because a second cell can
 * only be entered after the first one has been committed.
 *
 * Deliberately *not* created on mount: an idle table stores nothing, so a
 * rebuilt widget cannot leave a session pointing at detached DOM.
 */
const ACTIVE = new WeakMap<EditorView, EditSession>();

/**
 * The 6px strip at a column's right edge belongs to the drag handles
 * (`docs/decisions-table-resize.md` A1: double-click there resets the column
 * widths). A double-click inside that strip must not open a cell editor, or the
 * two gestures would fight over the same pixels.
 */
const COLUMN_EDGE_HOT_ZONE = 6;

/* ------------------------------------------------------------------ locating */

interface TableLocation {
  node: SyntaxNode;
  from: number;
  to: number;
}

/**
 * Where this widget starts in the document, computed now.
 *
 * A widget that has been rebuilt throws here, hence the guard — the same
 * pattern the resize gesture uses, for the same reason.
 */
function tableStart(view: EditorView, wrap: HTMLElement): number | null {
  if (!wrap.isConnected) return null;
  for (const offset of [undefined, 1] as const) {
    try {
      const position = offset === undefined ? view.posAtDOM(wrap) : view.posAtDOM(wrap, offset);
      if (position >= 0) return position;
    } catch {
      // Fall through to the next attempt / give up.
    }
  }
  return null;
}

function locateTable(view: EditorView, wrap: HTMLElement): TableLocation | null {
  const position = tableStart(view, wrap);
  if (position === null) return null;
  const tree = syntaxTree(view.state);
  // The widget sits at a block boundary, where `resolveInner` can legitimately
  // hand back the node on either side. Both sides are tried before giving up.
  for (const [offset, side] of [
    [position, 1],
    [position, 0],
    [position - 1, 1],
  ] as const) {
    if (offset < 0) continue;
    for (let node: SyntaxNode | null = tree.resolveInner(offset, side); node; node = node.parent) {
      if (node.name === "Table") return { node, from: node.from, to: node.to };
    }
  }
  return null;
}

/** The widget root for the table that starts at `tableFrom`, after a rebuild. */
function findWrap(view: EditorView, tableFrom: number): HTMLElement | null {
  const wraps = view.contentDOM.querySelectorAll<HTMLElement>("[data-qing-table]");
  for (const wrap of wraps) {
    if (tableStart(view, wrap) === tableFrom) return wrap;
  }
  return null;
}

function sessionOf(view: EditorView): EditSession | null {
  const session = ACTIVE.get(view) ?? null;
  if (!session) return null;
  // The widget was rebuilt under the session (another writer, a reload): the
  // DOM the user typed into is gone, so there is nothing left to commit.
  if (!session.wrap.isConnected || !session.cellEl.isConnected) {
    ACTIVE.delete(view);
    return null;
  }
  return session;
}

/* ------------------------------------------------------------------ data */

function cellAt(data: TableData, row: number, column: number): TableCell | null {
  if (row < 0) return data.header[column] ?? null;
  return data.rows[row]?.[column] ?? null;
}

function readData(view: EditorView, wrap: HTMLElement): TableData | null {
  const located = locateTable(view, wrap);
  return located ? readTable(located.node, view.state) : null;
}

/** Every cell a caret may legally sit in, in Tab order (header first). */
function cellTargets(data: TableData): CellCoords[] {
  const columns = columnCount(data.header, data.rows);
  const targets: CellCoords[] = [];
  for (let column = 0; column < columns; column += 1) targets.push({ row: -1, column });
  data.rows.forEach((_row, index) => {
    for (let column = 0; column < columns; column += 1) {
      targets.push({ row: index, column });
    }
  });
  return targets.filter((target) => cellAt(data, target.row, target.column)?.editable === true);
}

function parseCoords(value: string | undefined): CellCoords | null {
  if (!value) return null;
  const [row, column] = value.split(",").map((part) => Number(part));
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null;
  return { row, column };
}

function coordsOf(el: HTMLElement): CellCoords | null {
  return parseCoords(el.dataset.cell);
}

function sameCoords(a: CellCoords, b: CellCoords): boolean {
  return a.row === b.row && a.column === b.column;
}

/* ------------------------------------------------------------------ caret */

/**
 * Puts the caret where the gesture asked for.
 *
 * Called *after* `focus()`, which on its own jumps the caret to the start of the
 * field. Two things therefore have to be measured before focusing and passed in:
 *
 * - `kept` — the selection the double-click just made. Without it, a double-click
 *   on `alpha` would enter editing with the caret at 0 instead of the word.
 * - the hit point, so a click inside a longer cell lands where the pointer was.
 *
 * A keyboard entry (Tab / Enter) has neither, and gets the end of the text —
 * never a full selection: replacing the whole cell is not what entering an edit
 * means.
 */
function placeCaret(
  cellEl: HTMLElement,
  kept: Range | null,
  point: Point | null,
): void {
  const selection = document.getSelection();
  if (!selection) return;

  if (kept) {
    selection.removeAllRanges();
    selection.addRange(kept);
    return;
  }

  if (point) {
    const range = caretRangeFromPoint(point);
    if (range && cellEl.contains(range.startContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }

  const range = document.createRange();
  range.selectNodeContents(cellEl);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The selection inside `cellEl`, if the gesture left one there. */
function selectionInside(cellEl: HTMLElement): Range | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const anchor = selection.anchorNode;
  if (!anchor || !cellEl.contains(anchor)) return null;
  return selection.getRangeAt(0).cloneRange();
}

/**
 * Chromium's hit-test helper. Typed locally because it is not in `lib.dom`
 * (the standardised name is `caretPositionFromPoint`, which WebView2 does not
 * implement).
 */
function caretRangeFromPoint(point: Point): Range | null {
  const host = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  return host.caretRangeFromPoint?.(point.x, point.y) ?? null;
}

/* ------------------------------------------------------------------ enter/commit */

function enterCell(
  view: EditorView,
  wrap: HTMLElement,
  cellEl: HTMLElement,
  coords: CellCoords,
  point: Point | null,
): boolean {
  const data = readData(view, wrap);
  const cell = data ? cellAt(data, coords.row, coords.column) : null;
  if (!cell || !cell.editable) return false;

  // Read the gesture's selection *before* focusing: `focus()` moves the caret to
  // the start of the field, and the double-click's word would be gone by then.
  // Cloning is safe because nothing below rewrites this cell's DOM.
  const kept = selectionInside(cellEl);

  // The rendered pieces are left exactly as they are. Flattening them to one
  // text node here would be a silent edit: a double-click on `**1**` would turn
  // the cell into plain `1` on the way out even if nothing was typed. The
  // browser can select and place a caret inside `<strong>` / `<code>` / `<a>`
  // just fine, and the commit compares visible text before writing anything.
  cellEl.setAttribute("contenteditable", "plaintext-only");
  cellEl.classList.add("cm-md-table-cell-editing");
  cellEl.focus({ preventScroll: true });
  placeCaret(cellEl, kept, point);

  ACTIVE.set(view, { view, wrap, cellEl, row: coords.row, column: coords.column });
  return true;
}

function exitEditDom(cellEl: HTMLElement): void {
  cellEl.removeAttribute("contenteditable");
  cellEl.classList.remove("cm-md-table-cell-editing");
}

/**
 * Writes the edited cell back into the document.
 *
 * The cell's range is re-read here rather than remembered: between the
 * double-click and the commit the document may have moved (a save reload, a
 * second window, the resize comment above the table shrinking). `encodeCellText`
 * keeps `|` and `\` from changing the table's structure, and the transaction is
 * isolated so Ctrl+Z steps over one cell edit, not a keystroke at a time.
 *
 * The first comparison is on **visible text**, not on source: a cell rendered
 * from `**1**` has the text `1`, so comparing the encoded text against the
 * source would always differ and every double-click would quietly rewrite the
 * cell as plain text. Untouched cells keep their inline formatting and produce
 * no transaction — no dirty flag, no rebuild.
 */
function commitSession(session: EditSession): boolean {
  const { view, wrap, cellEl, row, column } = session;
  ACTIVE.delete(view);

  const visible = (cellEl.textContent ?? "").replace(/\r?\n/g, " ").trim();
  exitEditDom(cellEl);

  const data = readData(view, wrap);
  const cell = data ? cellAt(data, row, column) : null;
  if (!cell || !cell.editable) return false;
  // Nothing typed: leave the source alone. This is what keeps an unedited cell's
  // `**粗体**` / `<code>` / `[label](url)` intact.
  if (visible === cell.text) return false;

  // Edited: the cell becomes plain text. Losing the inline formatting of the
  // cell being rewritten is the accepted cost (a text run cannot be re-derived
  // from edited prose), and it is scoped to that one cell.
  const text = encodeCellText(visible);
  if (view.state.sliceDoc(cell.from, cell.to) === text) return false;

  view.dispatch({
    changes: { from: cell.from, to: cell.to, insert: text },
    annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.table.cell")],
    scrollIntoView: false,
  });
  return true;
}

/* ------------------------------------------------------------------ moving */

/**
 * Enters `target` on the next frame.
 *
 * The commit rebuilds the widget, so the element under the pointer is detached
 * by the time the click finishes bubbling. One frame later the replacement is in
 * the DOM and can be found by the table's start offset — which the edit itself
 * never moves, because a cell edit can only shrink or grow text *inside* the
 * table.
 */
function moveInto(
  view: EditorView,
  wrap: HTMLElement,
  tableFrom: number | null,
  target: CellCoords,
  point: Point | null,
): void {
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    const nextWrap = tableFrom === null ? (wrap.isConnected ? wrap : null) : findWrap(view, tableFrom);
    const cellEl =
      nextWrap?.querySelector<HTMLElement>(`[data-cell="${target.row},${target.column}"]`) ?? null;
    if (!nextWrap || !cellEl) {
      // The table is gone (deleted, or the note switched): leave the caret to
      // the editor rather than pretending the cell still exists.
      view.focus();
      return;
    }
    enterCell(view, nextWrap, cellEl, target, point);
  });
}

/** Commit, then edit `target`. */
function advance(session: EditSession, target: CellCoords, point: Point | null = null): void {
  const { view, wrap } = session;
  const tableFrom = tableStart(view, wrap);
  commitSession(session);
  moveInto(view, wrap, tableFrom, target, point);
}

/** Commit, then put the caret in the block after the table (Tab/Enter past the end). */
function exitPastTable(session: EditSession): void {
  const { view, wrap } = session;
  const tableFrom = tableStart(view, wrap);
  commitSession(session);
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    const nextWrap = tableFrom === null ? (wrap.isConnected ? wrap : null) : findWrap(view, tableFrom);
    const located = nextWrap ? locateTable(view, nextWrap) : null;
    const anchor = Math.min((located?.to ?? view.state.doc.length) + 1, view.state.doc.length);
    view.focus();
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
  });
}

/** Commit and hand the caret back to the editor without moving it (Escape). */
function leaveEditing(session: EditSession): void {
  commitSession(session);
  session.view.focus();
}

/* ------------------------------------------------------------------ attach */

export interface TableInteraction {
  /** Idempotent: every listener this table installed goes away. */
  destroy(): void;
}

/**
 * Wires one rendered table for in-place editing.
 *
 * Listeners live on the widget root (event delegation), never on the cells:
 * the cells are recreated on every rebuild, and a listener per cell would leak
 * with them.
 */
export function attachTableInteraction(wrap: HTMLElement, view: EditorView): TableInteraction {
  let destroyed = false;

  const owns = (): EditSession | null => {
    const session = sessionOf(view);
    return session && session.wrap === wrap ? session : null;
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (destroyed) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // The drag handles own their strip; they also handle their own double-click
    // (reset column widths) and must keep it.
    if (target.closest(".cm-md-table-handle")) return;
    const cellEl = target.closest("[data-cell]");
    if (!(cellEl instanceof HTMLElement) || !wrap.contains(cellEl)) return;

    const rect = cellEl.getBoundingClientRect();
    if (rect.right - event.clientX <= COLUMN_EDGE_HOT_ZONE) return;

    const session = owns();
    if (session && session.cellEl === cellEl) return;

    const coords = coordsOf(cellEl);
    if (!coords) return;
    // A different cell may still be in edit mode (the second click of a
    // double-click on another cell): commit it, then take this one. The commit
    // rebuilds the table, so the entry has to go through the same next-frame
    // lookup a move uses.
    if (session) {
      const tableFrom = tableStart(view, wrap);
      commitSession(session);
      moveInto(view, wrap, tableFrom, coords, { x: event.clientX, y: event.clientY });
      return;
    }
    enterCell(view, wrap, cellEl, coords, { x: event.clientX, y: event.clientY });
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (destroyed || event.button !== 0) return;
    const session = owns();
    if (!session) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const cellEl = target.closest("[data-cell]");
    if (!(cellEl instanceof HTMLElement) || !wrap.contains(cellEl)) return;
    // Same cell: the browser keeps its own selection behaviour inside the field.
    if (cellEl === session.cellEl) return;

    const coords = coordsOf(cellEl);
    if (!coords) return;
    const data = readData(view, wrap);
    const cell = data ? cellAt(data, coords.row, coords.column) : null;
    if (!cell || !cell.editable) return;

    // The commit rebuilds this DOM, which would eat the click: swallow it now
    // and enter the target on the next frame instead.
    event.preventDefault();
    advance(session, coords, { x: event.clientX, y: event.clientY });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (destroyed) return;
    // Every other key belongs to the field: typing must not pay for a table
    // re-read on each keystroke.
    if (event.key !== "Tab" && event.key !== "Enter" && event.key !== "Escape") return;
    // IME composition owns the keyboard outright; a Tab or Enter there belongs
    // to the candidate window.
    if (event.isComposing || event.keyCode === 229) return;
    const session = owns();
    if (!session) return;

    // CodeMirror must not hear these: `basicSetup` binds Tab (insert a tab) and
    // Enter, and the note would change behind the editor's back.
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      // 提交并退出，不是取消：Esc 丢掉的会是用户刚敲的字。
      leaveEditing(session);
      return;
    }

    const data = readData(view, wrap);
    if (!data) {
      leaveEditing(session);
      return;
    }
    const self: CellCoords = { row: session.row, column: session.column };

    if (event.key === "Enter") {
      const next: CellCoords = { row: self.row + 1, column: self.column };
      const cell = cellAt(data, next.row, next.column);
      if (cell && cell.editable) advance(session, next);
      else exitPastTable(session);
      return;
    }

    // Tab / Shift+Tab walk the table in reading order and leave it at the ends.
    const targets = cellTargets(data);
    const index = targets.findIndex((target) => sameCoords(target, self));
    if (index < 0) return;
    const next = targets[index + (event.shiftKey ? -1 : 1)];
    if (next) {
      advance(session, next);
      return;
    }
    // Shift+Tab on the first cell: stay put. Tab on the last one: leave the
    // table, which is what the key does everywhere else in the editor.
    if (!event.shiftKey) exitPastTable(session);
  };

  const onFocusOut = (event: FocusEvent): void => {
    if (destroyed) return;
    const session = owns();
    if (!session) return;
    const next = event.relatedTarget;
    if (next instanceof Node && wrap.contains(next)) return;
    // Deferred: a commit dispatches, and dispatching inside CodeMirror's own
    // mousedown handling would rebuild the DOM the event is still travelling
    // through. The microtask re-checks that focus really left.
    queueMicrotask(() => {
      if (destroyed) return;
      const still = owns();
      if (!still) return;
      const active = document.activeElement;
      if (active instanceof Node && wrap.contains(active)) return;
      commitSession(still);
    });
  };

  const onLinkActivate = (event: MouseEvent): void => {
    if (destroyed) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (!anchor || !wrap.contains(anchor)) return;
    if (isLinkClickModifier(event)) {
      handleMarkdownLinkClick(event, { view, requireModifier: true });
      return;
    }
    // A plain click only selects text. Without this the WebView follows the
    // `href` and navigates the whole app away — there is no way back.
    event.preventDefault();
  };

  wrap.addEventListener("dblclick", onDoubleClick);
  wrap.addEventListener("mousedown", onMouseDown);
  wrap.addEventListener("keydown", onKeyDown);
  wrap.addEventListener("focusout", onFocusOut);
  wrap.addEventListener("click", onLinkActivate);
  wrap.addEventListener("auxclick", onLinkActivate);

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      wrap.removeEventListener("dblclick", onDoubleClick);
      wrap.removeEventListener("mousedown", onMouseDown);
      wrap.removeEventListener("keydown", onKeyDown);
      wrap.removeEventListener("focusout", onFocusOut);
      wrap.removeEventListener("click", onLinkActivate);
      wrap.removeEventListener("auxclick", onLinkActivate);
      // The DOM is being thrown away; a session pointing at it would write the
      // text of a detached node into the note on the next save.
      if (sessionOf(view)?.wrap === wrap) ACTIVE.delete(view);
    },
  };
}

/**
 * Commit the open cell synchronously.
 *
 * For callers that act *outside* the widget's own lifecycle: saving (the file
 * must contain what the user sees), leaving 纯预览编辑, running a command. No
 * focus is restored — whoever asked is about to move the caret itself.
 */
export function flushTableEdit(view: EditorView): boolean {
  const session = sessionOf(view);
  if (!session) return false;
  return commitSession(session);
}
