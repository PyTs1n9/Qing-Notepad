/**
 * Outline jump + viewport highlight for a CodeMirror note surface.
 *
 * Extracted from `NoteEditor` when the detached note window grew the same
 * outline column. The two surfaces must agree on *both* coordinate traps
 * documented in `docs/decisions-editor-statusbar.md` — the 16px gap between
 * `.cm-content`'s padding and the scroller's `scrollTop`, and the 8px landing
 * margin that makes a naive sample point read the section you just left. A
 * second copy would drift the moment either one is tuned.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import type { OutlineHeading } from "@/utils/noteOutline";
import { cancelEditorScrollJump, scrollEditorToPosition } from "@/utils/editorScrollJump";

/**
 * Gap between the viewport top and the heading a jump lands on.
 *
 * The landing margin itself is `editorScrollJump`'s business now; this copy is
 * for the viewport sample point below, which must sit just *under* that margin.
 */
const SCROLL_TOP_MARGIN = 8;

export interface OutlineNavigation {
  /** Line of the heading the viewport is inside, or `null` at the top. */
  activeLine: number | null;
  jumpTo: (heading: OutlineHeading) => void;
}

/**
 * @param viewRef  Live CodeMirror view; `null` until the editor's own effect runs.
 * @param headings Headings of the current buffer, already filtered by the panel.
 * @param enabled  Whether the column is open. Closing it drops the highlight.
 * @param resetKey Changes when the document is replaced; re-binds the scroller
 *                 listener to the new view instead of a destroyed one.
 */
export function useOutlineNavigation(
  viewRef: RefObject<EditorView | null>,
  headings: OutlineHeading[],
  enabled: boolean,
  resetKey: string | number,
): OutlineNavigation {
  const [activeLine, setActiveLine] = useState<number | null>(null);
  // The scroll listener reads the newest outline through a ref: re-binding it
  // on every keystroke would tear down the listener while the user types.
  const headingsRef = useRef(headings);
  headingsRef.current = headings;

  /**
   * Abort whatever glide is in flight.
   *
   * The animation itself now belongs to `editorScrollJump` (link clicks scroll
   * through the same primitive), so this defers to it instead of holding a
   * handle. The listeners below still matter: `pointerdown` and `keydown` are
   * takeover signals the shared primitive does not watch.
   */
  const stopAnimation = useCallback(() => {
    cancelEditorScrollJump();
  }, []);

  /**
   * Jump to a heading and leave the caret there, so the next keystroke edits
   * the section the user just picked instead of wherever the caret was.
   *
   * The scroll is animated rather than assigned: a 2000px teleport loses the
   * reader's place, while a 300ms glide keeps the relationship between "where I
   * clicked" and "where I landed". The curve, the 8px landing margin and the
   * abort handle live in `editorScrollJump`, because an in-note link click has to
   * land in exactly the same place.
   */
  const jumpTo = useCallback(
    (heading: OutlineHeading) => {
      const view = viewRef.current;
      if (!view) return;
      const lineNumber = Math.min(heading.line + 1, view.state.doc.lines);
      const position = view.state.doc.line(lineNumber).from;

      stopAnimation();
      // Optimistic highlight: a heading that is already at the top produces no
      // scroll event, so the listener alone would never mark it.
      setActiveLine(heading.line);
      // Selection only — `EditorView.scrollIntoView` would jump instantly and
      // fight the animation that starts on the next line.
      view.dispatch({ selection: { anchor: position } });
      view.focus();

      scrollEditorToPosition(view, position);
    },
    [stopAnimation, viewRef],
  );

  /**
   * Highlight the section the viewport is inside.
   *
   * Bound to the scroller, not to the document: scrolling and typing produce
   * the same answer, and the listener must survive keystrokes.
   */
  useEffect(() => {
    if (!enabled) {
      setActiveLine(null);
      return;
    }
    const view = viewRef.current;
    if (!view) return;

    const scroller = view.scrollDOM;
    let frame = 0;

    const measure = () => {
      frame = 0;
      const current = headingsRef.current;
      if (current.length === 0) {
        setActiveLine(null);
        return;
      }
      // Ask the view what sits at the top edge instead of comparing block tops
      // with `scrollTop`: `.cm-content` carries its own padding, so the two
      // coordinate systems differ by 16px and a heading exactly at the edge
      // would never match. A position also survives wrapped lines, where a
      // "line" covers several visual rows.
      //
      // The sample point sits *below* `SCROLL_TOP_MARGIN`: every outline jump
      // parks its heading exactly that far down, and sampling at the margin
      // itself reads the tail of the previous line, which reports the section
      // you just left as the active one.
      const rect = scroller.getBoundingClientRect();
      const sampleY = rect.top + SCROLL_TOP_MARGIN + 6;
      const topPosition = view.posAtCoords({ x: rect.left + 24, y: sampleY }, false);
      if (topPosition === null) return;

      let line: number | null = null;
      for (const heading of current) {
        if (heading.line + 1 > view.state.doc.lines) continue;
        if (view.state.doc.line(heading.line + 1).from > topPosition) break;
        line = heading.line;
      }
      setActiveLine((previous) => (previous === line ? previous : line));
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    // A jump animation must yield to the user the moment they take over. The
    // scroll event cannot tell "my rAF wrote this" from "the wheel did", so the
    // takeover signals are listened for explicitly.
    const abort = () => stopAnimation();
    scroller.addEventListener("wheel", abort, { passive: true });
    scroller.addEventListener("touchstart", abort, { passive: true });
    scroller.addEventListener("pointerdown", abort);
    window.addEventListener("keydown", abort, true);

    return () => {
      scroller.removeEventListener("scroll", schedule);
      scroller.removeEventListener("wheel", abort);
      scroller.removeEventListener("touchstart", abort);
      scroller.removeEventListener("pointerdown", abort);
      window.removeEventListener("keydown", abort, true);
      // Leaving the panel (or the note) mid-flight would otherwise keep writing
      // `scrollTop` into a scroller that no longer belongs to this view.
      stopAnimation();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, resetKey, stopAnimation, viewRef]);

  return { activeLine, jumpTo };
}
