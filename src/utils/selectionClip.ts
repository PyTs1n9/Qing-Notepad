import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Keeps the selection band inside the editor's content column.
 *
 * `drawSelection` sizes a line-wise band from the `.cm-content` *border* box
 * plus the first `.cm-line`'s padding (`rectanglesForRange`). A fenced block's
 * card, on the other hand, is a `.cm-line` with no margin, so its border box
 * *is* the content padding box. The band therefore painted about 20px past the
 * card on each side — over the gutter and under the scrollbar — and filled the
 * card's rounded corners as a rectangle.
 *
 * Clipping the layer at the content padding box puts the band back on the card's
 * border box, which is exactly where the card's own surface starts. The insets
 * are measured instead of hard-coded to the 20px in `noteEditorTheme` because
 * the layer's origin is the scroller, not the content: it also contains the
 * gutter, and that widens when the line count gains a digit (9 → 10 → 100).
 *
 * Layout metrics (`offsetLeft` / `offsetWidth`) are the base, not
 * `getBoundingClientRect()`: the layer is anchored to the scroller's padding
 * edge while the content scrolls inside it, so a viewport-space difference
 * drifts as soon as the document scrolls sideways. They are also already in the
 * CSS pixels that `clip-path` consumes, so page zoom needs no `view.scaleX`
 * correction.
 *
 * Only the editor installs this. The read-only view and the sticky note set
 * `.cm-content` padding to 0, where the insets measure 0 and the clip is a
 * no-op either way.
 */
export function selectionBandClip() {
  return [
    // The rule lives here rather than in `index.css` on purpose: it is only
    // meaningful next to the measurements below, and a theme is scoped to the
    // editor that installs this extension (`index.css` would hit the read-only
    // view and the sticky note as well, whose content padding is 0 and which
    // never set the variables).
    EditorView.theme({
      ".cm-selectionLayer": {
        // Negative vertical insets are load-bearing: the layer sits at the
        // content origin and scrolls with it, so a clip box of the layer's own
        // (zero) height would slide out of the viewport as soon as the note
        // scrolls. Only the horizontal edges are meant to clip.
        clipPath:
          "inset(-100000px var(--cm-sel-clip-right, 0px) -100000px var(--cm-sel-clip-left, 0px))",
      },
    }),
    ViewPlugin.fromClass(
      class {
        private readonly observer: ResizeObserver;
        private frame = 0;

        constructor(private readonly view: EditorView) {
          // The gutter is observed as well as the content: a line-count change
          // can widen the gutter before (or without) the content's own box
          // resizing, and the clip is anchored to the content's left edge.
          this.observer = new ResizeObserver(() => this.schedule());
          this.observer.observe(view.contentDOM);
          const gutters = view.dom.querySelector(".cm-gutters");
          if (gutters) this.observer.observe(gutters);
          this.schedule();
        }

        update(update: ViewUpdate) {
          if (update.geometryChanged || update.docChanged) this.schedule();
        }

        destroy() {
          this.observer.disconnect();
          if (this.frame) cancelAnimationFrame(this.frame);
        }

        /**
         * One measurement per frame at most. A scroll fires `update` with
         * `geometryChanged` on every viewport shift, and each measurement is a
         * forced layout read; coalescing keeps that off the scroll path.
         */
        private schedule() {
          if (this.frame) return;
          this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.apply();
          });
        }

        private apply() {
          const layer = this.view.dom.querySelector<HTMLElement>(".cm-selectionLayer");
          // The layer is created by `drawSelection`'s own plugin; if this one
          // runs first (extension order is not guaranteed by the API), the next
          // update or resize schedules another pass.
          if (!layer) return;
          const content = this.view.contentDOM;
          const style = getComputedStyle(content);
          const padLeft = Number.parseFloat(style.paddingLeft) || 0;
          const padRight = Number.parseFloat(style.paddingRight) || 0;
          // `.cm-layer` is a zero-size positioned box (`contain: size` in the
          // base theme), and `clip-path` resolves its reference box against that
          // size — a percentage width does not give the box an area here, so the
          // width is written in pixels. It is the scroller's padding box, which
          // is also the layer's containing block, so the two coordinate systems
          // line up.
          const width = this.view.scrollDOM.clientWidth;
          // `.cm-scroller` is the offsetParent (`position: relative` in the base
          // theme) and the layer sits at its padding edge, so both offsets share
          // one origin. `offsetWidth` includes the padding, hence the
          // subtraction.
          const left = content.offsetLeft + padLeft;
          const right = Math.max(0, width - (content.offsetLeft + content.offsetWidth - padRight));
          layer.style.width = `${width}px`;
          layer.style.setProperty("--cm-sel-clip-left", `${left}px`);
          layer.style.setProperty("--cm-sel-clip-right", `${right}px`);
        }
      },
    ),
  ];
}
