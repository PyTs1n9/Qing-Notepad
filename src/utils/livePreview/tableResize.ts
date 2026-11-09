import { Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import {
  MIN_COL_WIDTH,
  clampTotal,
  insertSizingChange,
  minTotal,
  removeSizingChange,
  resizeInner,
  scaleTo,
  totalOf,
  type SizingChange,
} from "./tableSizing";

/**
 * The drag handles of one rendered table.
 *
 * The gesture is Typora's: a 6px hotspot on every column's right edge, dragging
 * an inner edge trades width between the two columns (the table's total does not
 * move), dragging the last edge rescales the whole table. Nothing is written to
 * the document until the pointer is released — a drag is one undo step, not two
 * hundred (`docs/decisions-table-resize.md` §撤销粒度).
 *
 * Two rules from `topics/ui-rules.md` shape the plumbing:
 * - drag = live DOM update, one write on release, listeners on `window`,
 *   **no pointer capture** (a capture would swallow the events CodeMirror needs
 *   to end its own gestures);
 * - the size bubble is portalled to `document.body`, because `.cm-md-table-wrap`
 *   scrolls sideways and would clip an absolutely positioned child.
 */
export interface TableResizeOptions {
  /** The widget root; the handles layer lives here and positions against it. */
  wrap: HTMLElement;
  table: HTMLTableElement;
  view: EditorView;
  /** Stored widths, or `null` for a table that has never been resized. */
  cols: readonly number[] | null;
  enabled: boolean;
}

export interface TableResizer {
  /** Re-measure cell edges; called on resize, on first paint, before a drag. */
  relayout(): void;
  /** Idempotent: listeners, observer, bubble and the `body` class all go away. */
  destroy(): void;
}

const HANDLE_CLASS = "cm-md-table-handle";
const HANDLE_ACTIVE_CLASS = "cm-md-table-handle--active";
const BODY_DRAGGING_CLASS = "cm-md-table-dragging";
const BUBBLE_CLASS = "cm-md-table-size-bubble";

interface DragSession {
  /** Index of the column whose right edge is being dragged. */
  boundary: number;
  startX: number;
  /** Widths when the pointer went down; every frame recomputes from these. */
  startWidths: number[];
  startTotal: number;
  /** Upper bound for the whole table: the pane, or the width it started at. */
  maxTotal: number;
  nextWidths: number[];
  colElements: HTMLTableColElement[];
  handle: HTMLElement;
  bubble: HTMLElement;
  tableTop: number;
}

export function attachTableResizer(options: TableResizeOptions): TableResizer {
  const { wrap, table, view } = options;
  const columns = domColumnCount(table);
  if (!options.enabled || columns === 0) {
    return { relayout: () => {}, destroy: () => {} };
  }

  const layer = document.createElement("div");
  layer.className = "cm-md-table-handles";
  const handles: HTMLElement[] = [];
  for (let index = 0; index < columns; index += 1) {
    const handle = document.createElement("div");
    handle.className = HANDLE_CLASS;
    handle.dataset.col = String(index);
    layer.appendChild(handle);
    handles.push(handle);
  }
  wrap.appendChild(layer);

  let session: DragSession | null = null;
  let destroyed = false;
  let frame = 0;
  let observer: ResizeObserver | null = null;

  /**
   * Handles follow the widest row's cell edges, measured in `wrap`'s content
   * coordinates (so a sideways scroll does not invalidate them: the layer scrolls
   * with the table). Measuring the widest row — not the first one — keeps the
   * hotspot covering the border when a cell wraps and grows tall.
   */
  const relayout = (): void => {
    if (destroyed) return;
    const wrapRect = wrap.getBoundingClientRect();
    let widest: HTMLTableRowElement | null = null;
    let widestRight = Number.NEGATIVE_INFINITY;
    for (const row of Array.from(table.rows)) {
      const right = row.getBoundingClientRect().right;
      if (right > widestRight) {
        widestRight = right;
        widest = row;
      }
    }
    const cells = widest ? Array.from(widest.cells) : [];
    let edge = 0;
    for (let index = 0; index < columns; index += 1) {
      const cell = cells[index];
      if (cell) edge = cell.getBoundingClientRect().right - wrapRect.left + wrap.scrollLeft;
      const handle = handles[index];
      if (handle) handle.style.left = `${Math.round(edge)}px`;
    }
  };

  /** Column widths as they are painted right now. */
  const measureWidths = (): number[] => {
    const fallback =
      options.cols && options.cols.length === columns ? options.cols : null;
    const widths: number[] = [];
    for (let index = 0; index < columns; index += 1) {
      let width = 0;
      for (const row of Array.from(table.rows)) {
        const cell = row.cells[index];
        if (!cell) continue;
        width = Math.round(cell.getBoundingClientRect().width);
        if (width > 0) break;
      }
      // Nothing laid out yet (a drag that starts before the first paint): fall
      // back to the stored widths rather than starting from zeros.
      if (width <= 0) width = fallback?.[index] ?? MIN_COL_WIDTH;
      widths.push(width);
    }
    return widths;
  };

  const paint = (
    colElements: readonly HTMLTableColElement[],
    widths: readonly number[],
    tableWidth: number = totalOf(widths),
  ): void => {
    table.style.tableLayout = "fixed";
    table.classList.add("cm-md-table--fixed");
    for (let index = 0; index < colElements.length; index += 1) {
      const width = widths[index];
      if (width !== undefined) colElements[index].style.width = `${width}px`;
    }
    table.style.width = `${tableWidth}px`;
  };

  /**
   * Where the table starts in the document, computed *now*.
   *
   * The offset from the drag's first frame is stale: another window can edit the
   * note mid-drag, which moves the table. `posAtDOM` on a widget that has been
   * rebuilt throws, hence the guard.
   */
  const tablePosition = (): number | null => {
    if (!wrap.isConnected) return null;
    try {
      const position = view.posAtDOM(wrap);
      return position >= 0 ? position : null;
    } catch {
      return null;
    }
  };

  /**
   * The only write to the document in this file.
   *
   * `isolateHistory.of("full")` keeps the width change in an undo group of its
   * own, so Ctrl+Z steps back over the drag in one go instead of replaying the
   * animations — the same annotation `markdownCommands.ts` uses.
   */
  const commit = (change: SizingChange): void => {
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.table.resize")],
    });
  };

  const resetSizing = (): void => {
    const tableFrom = tablePosition();
    if (tableFrom === null) return;
    const change = removeSizingChange(view.state, tableFrom);
    if (!change) return;
    commit(change);
  };

  const cleanup = (): void => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    const active = session;
    session = null;
    document.body.classList.remove(BODY_DRAGGING_CLASS);
    if (!active) return;
    active.bubble.remove();
    active.handle.classList.remove(HANDLE_ACTIVE_CLASS);
  };

  const updateBubble = (
    bubble: HTMLElement,
    boundary: number,
    widths: readonly number[],
    clientX: number,
    tableTop: number,
  ): void => {
    // Inner edge reports the column being dragged; the last edge reports the
    // table's total, because that is the number the user is aiming at.
    const label =
      boundary >= columns - 1 ? `${totalOf(widths)}px` : `${widths[boundary] ?? 0}px`;
    bubble.textContent = label;
    bubble.style.left = `${Math.round(clientX + 12)}px`;
    bubble.style.top = `${Math.round(Math.max(4, tableTop - 26))}px`;
  };

  const onPointerMove = (event: PointerEvent): void => {
    const active = session;
    if (!active) return;
    // Always recompute from the snapshot: deltas accumulated per frame drift,
    // and the pointer can be dragged back past its origin.
    const delta = Math.round(event.clientX - active.startX);
    let next: number[];
    if (active.boundary >= columns - 1) {
      const ceiling = totalOf(clampTotal(active.startWidths, active.maxTotal));
      const target = Math.max(minTotal(columns), Math.min(ceiling, active.startTotal + delta));
      next = scaleTo(active.startWidths, target);
    } else {
      next = resizeInner(active.startWidths, active.boundary, delta);
    }
    active.nextWidths = next;
    paint(active.colElements, next);
    updateBubble(active.bubble, active.boundary, next, event.clientX, active.tableTop);
  };

  const onPointerUp = (): void => {
    const active = session;
    if (!active) return;
    const widths = active.nextWidths.slice();
    // A click on a handle, or a drag that ended where it started: nothing to
    // record. Writing a comment here would edit the note on a stray click.
    const unchanged = sameWidths(widths, active.startWidths);
    try {
      cleanup();
      if (unchanged) return;
      const tableFrom = tablePosition();
      if (tableFrom === null) return;
      commit(insertSizingChange(view.state, tableFrom, widths));
    } finally {
      // Whatever happened above, the full-screen `col-resize` cursor must not
      // outlive the gesture.
      cleanup();
    }
  };

  const onPointerCancel = (): void => {
    const active = session;
    if (active) {
      // Cancelled: put the table back to the widths it had before the gesture.
      paint(active.colElements, active.startWidths, active.startTotal);
    }
    cleanup();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (destroyed || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest(`.${HANDLE_CLASS}`);
    if (!(handle instanceof HTMLElement) || !wrap.contains(handle)) return;
    const boundary = Number(handle.dataset.col);
    if (!Number.isInteger(boundary) || boundary < 0 || boundary >= columns) return;

    event.preventDefault();
    event.stopPropagation();

    // Double-click resets the table to auto layout. Cancelling `pointerdown` is
    // not guaranteed to leave the native `dblclick` reachable, so the click
    // counter is checked here as well; `removeSizingChange` returns null the
    // second time, which makes the double path harmless.
    if (event.detail >= 2) {
      resetSizing();
      return;
    }

    relayout();

    const rect = table.getBoundingClientRect();
    const measured = measureWidths();
    // A column already narrower than the floor (a table squeezed into a very
    // narrow pane) cannot be stored — `normalizeSizing` would reject the comment
    // and the widths would silently spring back to auto. Lift the snapshot to
    // the legal minimum so every drag produces a storable list.
    const startWidths = measured.some((width) => width < MIN_COL_WIDTH)
      ? scaleTo(measured, Math.max(totalOf(measured), minTotal(columns)))
      : measured;
    // Collapsed borders leave the sum of the cell widths a pixel or two off the
    // table's own width. Folding the difference into the last column keeps the
    // switch to a fixed layout from moving anything on the first frame.
    const painted = Math.round(rect.width);
    if (painted > 0) {
      const last = columns - 1;
      const drift = painted - totalOf(startWidths);
      if (drift !== 0) startWidths[last] = Math.max(MIN_COL_WIDTH, startWidths[last] + drift);
    }
    const startTotal = totalOf(startWidths);

    const colElements = ensureColgroup(table, columns);
    // `<col>` widths only apply to a fixed layout, so the first drag pins it.
    // No transaction: the document is still untouched.
    paint(colElements, startWidths, startTotal);

    const bubble = document.createElement("div");
    bubble.className = BUBBLE_CLASS;
    document.body.appendChild(bubble);

    session = {
      boundary,
      startX: event.clientX,
      startWidths,
      startTotal,
      maxTotal: Math.max(wrap.clientWidth, startTotal),
      nextWidths: startWidths.slice(),
      colElements,
      handle,
      bubble,
      tableTop: rect.top,
    };
    handle.classList.add(HANDLE_ACTIVE_CLASS);
    document.body.classList.add(BODY_DRAGGING_CLASS);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    updateBubble(bubble, boundary, startWidths, event.clientX, rect.top);
  };

  const onDoubleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest(`.${HANDLE_CLASS}`);
    if (!(handle instanceof HTMLElement) || !wrap.contains(handle)) return;
    event.preventDefault();
    event.stopPropagation();
    resetSizing();
  };

  layer.addEventListener("pointerdown", onPointerDown);
  layer.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("resize", relayout);
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => relayout());
    observer.observe(table);
  }
  // The widget is measured before it is attached; one frame later the table has
  // a box and the handles can sit on the right cell edges.
  frame = requestAnimationFrame(() => {
    frame = 0;
    relayout();
  });

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    cleanup();
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    observer?.disconnect();
    observer = null;
    window.removeEventListener("resize", relayout);
    layer.removeEventListener("pointerdown", onPointerDown);
    layer.removeEventListener("dblclick", onDoubleClick);
    layer.remove();
  };

  return { relayout, destroy };
}

/** Columns in the rendered DOM; the authoritative count for the handles. */
function domColumnCount(table: HTMLTableElement): number {
  let columns = 0;
  for (const row of Array.from(table.rows)) columns = Math.max(columns, row.cells.length);
  return columns;
}

/** The `<colgroup>` the fixed layout needs; created once, then reused. */
function ensureColgroup(table: HTMLTableElement, columns: number): HTMLTableColElement[] {
  const existing = table.getElementsByTagName("colgroup")[0];
  let group = existing;
  if (!group) {
    group = document.createElement("colgroup");
    table.insertBefore(group, table.firstChild);
  }
  while (group.children.length < columns) group.appendChild(document.createElement("col"));
  return Array.from(group.children).filter(
    (child): child is HTMLTableColElement => child instanceof HTMLTableColElement,
  );
}

function sameWidths(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((width, index) => width === b[index]);
}
