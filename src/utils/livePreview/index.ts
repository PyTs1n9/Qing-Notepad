import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { buildLivePreviewDecorations } from "./decorations";

/**
 * Live preview (L1): hides Markdown markers and paints block-level visuals
 * while the document stays plain Markdown.
 *
 * The layer is a `ViewPlugin` rather than a state field on purpose — it depends
 * on the viewport, and the viewport is a view concern. Only `view.visibleRanges`
 * is walked, so scrolling a long note costs a screenful, not the document.
 *
 * It coexists with `pluginDecorations` (a state field that provides the same
 * `EditorView.decorations` facet): CodeMirror merges providers and sorts the
 * union, so neither the order in the extension list nor overlapping ranges —
 * a plugin mark inside a hidden marker, say — can throw.
 */
const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildLivePreviewDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate) {
      // `syntaxTree` changes without a doc or viewport change when the parser
      // catches up asynchronously; without this the first screen stays raw.
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildLivePreviewDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

/** Extension to mount for the 实时渲染 view; absent in 源码 view. */
export const livePreview: Extension = livePreviewPlugin;
