/**
 * "Scroll this CodeMirror view so `position` sits near the top" — one formula,
 * three callers (outline jump, in-note anchor click, link jump in a read-only
 * preview).
 *
 * Two traps live here, both already paid for elsewhere:
 *
 * 1. `.cm-content` carries its own `padding-top`, while `lineBlockAt().top` is
 *    measured inside that content box. Comparing block tops with `scrollTop`
 *    directly is off by that padding, so the padding is added back on.
 * 2. A read-only preview sets `.cm-scroller { overflow: visible }` and lets the
 *    *window* scroll (`MarkdownReadonlyView`). Its scroller therefore has no
 *    range of its own, and writing `scrollTop` into it does nothing at all —
 *    an anchor click in a tile window would silently not move. When the scroller
 *    cannot scroll, the jump is rebased onto the nearest ancestor that can.
 */
import type { EditorView } from "@codemirror/view";
import { animateScrollTop, type ScrollAnimation } from "@/utils/smoothScroll";

/**
 * Gap between the viewport top and the line a jump lands on. The outline jump
 * uses the same 8px for its viewport-sample point, so a heading reached by a
 * link and by the outline panel parks in an identical spot.
 */
export const JUMP_MARGIN = 8;

/** At most one jump is in flight app-wide; a second one replaces the first. */
let activeScroll: ScrollAnimation | null = null;

const watched = new WeakSet<HTMLElement>();

/**
 * Bind the takeover signals to a scroller exactly once.
 *
 * The previous draft added `{ once: true }` listeners on every jump and never
 * removed them when the animation finished, so a window that jumped twenty times
 * accumulated forty listeners; the array only grew. A persistent listener per
 * container has no lifetime to leak, and it cancels whatever is in flight rather
 * than its own captured handle.
 */
function watchInterruption(scroller: HTMLElement): void {
  if (watched.has(scroller)) return;
  watched.add(scroller);
  const abort = () => cancelEditorScrollJump();
  scroller.addEventListener("wheel", abort, { passive: true });
  scroller.addEventListener("touchstart", abort, { passive: true });
}

/** Stop the current glide where it is. Safe to call when nothing is running. */
export function cancelEditorScrollJump(): void {
  activeScroll?.cancel();
  activeScroll = null;
}

/** Nearest ancestor that really scrolls vertically, or `null`. */
function scrollableAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * Bring `position` into view with the app's own glide. Callers place the
 * selection themselves: this only owns the scroll.
 */
export function scrollEditorToPosition(view: EditorView, position: number): void {
  cancelEditorScrollJump();

  const paddingTop = parseFloat(getComputedStyle(view.contentDOM).paddingTop) || 0;
  const topWithinView = view.lineBlockAt(position).top + paddingTop - JUMP_MARGIN;

  const scroller = view.scrollDOM;
  if (scroller.scrollHeight > scroller.clientHeight + 1) {
    watchInterruption(scroller);
    activeScroll = animateScrollTop(scroller, topWithinView);
    return;
  }

  // Auto-height preview: the scroller is a pass-through and the outer container
  // owns the range. `topWithinView` is still valid — it is measured from the top
  // of the document, which is where the scroller sits inside the outer scroller.
  const outer = scrollableAncestor(scroller);
  if (!outer) return;
  watchInterruption(outer);
  const offsetWithinOuter =
    outer.scrollTop + scroller.getBoundingClientRect().top - outer.getBoundingClientRect().top;
  activeScroll = animateScrollTop(outer, offsetWithinOuter + topWithinView);
}
