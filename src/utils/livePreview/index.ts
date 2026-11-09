import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { blockAtPosition } from "../editorBlocks";
import { tablePreview } from "./tableField";
import {
  buildLivePreviewDecorations,
  collectLivePreviewRanges,
  toDecorationRanges,
  type LivePreviewOptions,
  type VisibleRange,
} from "./decorations";

/**
 * Live preview (L1 + L3): hides Markdown markers and paints block-level visuals,
 * except in the block the caret sits in, which falls back to source.
 *
 * That fallback is not a preference: `Decoration.replace` makes its own range
 * unreachable for the caret, so a rendered block could not be edited unless the
 * caret's block shows raw text.
 *
 * The layer is a `ViewPlugin` rather than a state field on purpose:
 * - it needs the viewport (`view.visibleRanges`), a view concern;
 * - note switching re-keys `MarkdownSourceEditor` and destroys the view, so all
 *   of this state has to die with it. Nothing here is cached outside the
 *   instance, and `destroy()` unhooks the DOM listeners it installed.
 *
 * It coexists with `pluginDecorations` (a state field providing the same
 * `EditorView.decorations` facet): CodeMirror merges providers and sorts the
 * union, so neither the order in the extension list nor overlapping ranges can
 * throw.
 */
class LivePreviewView {
  decorations: DecorationSet;

  /** The block the caret is in; `null` when it sits between blocks. */
  private active: VisibleRange | null;

  /** True between `compositionstart` and `compositionend`. */
  private composing = false;

  /** Set on `compositionend`; the next update rebuilds, or one is forced. */
  private settlePending = false;

  /** Switching notes destroys the view; the deferred settle must not touch it. */
  private destroyed = false;

  /** See `LivePreviewConfig.revealActiveBlock`. */
  private readonly revealActiveBlock: boolean;

  constructor(private readonly view: EditorView, revealActiveBlock: boolean) {
    this.revealActiveBlock = revealActiveBlock;
    this.active = this.computeActive(view.state);
    this.decorations = buildLivePreviewDecorations(view.state, view.visibleRanges, revealFor(this.active));
    view.contentDOM.addEventListener("compositionstart", this.onCompositionStart);
    view.contentDOM.addEventListener("compositionend", this.onCompositionEnd);
  }

  update(update: ViewUpdate): void {
    if (this.composing) {
      // Frozen. Only positions move: recomputing here would swap decorations
      // under the IME candidate window, and every rebuild makes CodeMirror
      // re-measure the line the composition is anchored to.
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      return;
    }

    const settling = this.settlePending;
    this.settlePending = false;

    if (
      settling ||
      update.docChanged ||
      update.viewportChanged ||
      // The parser catches up asynchronously; without this the first screen
      // stays raw until something else changes.
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.rebuild(update.state, update.view);
      return;
    }

    if (update.selectionSet) this.syncActive(update.state);
  }

  destroy(): void {
    this.destroyed = true;
    this.view.contentDOM.removeEventListener("compositionstart", this.onCompositionStart);
    this.view.contentDOM.removeEventListener("compositionend", this.onCompositionEnd);
  }

  private computeActive(state: EditorState): VisibleRange | null {
    return this.revealActiveBlock ? activeRange(state) : null;
  }

  private rebuild(state: EditorState, view: EditorView): void {
    const active = this.computeActive(state);
    this.active = active;
    this.decorations = buildLivePreviewDecorations(state, view.visibleRanges, revealFor(active));
  }

  /**
   * The caret crossed a block boundary: patch the two blocks involved instead of
   * rebuilding the viewport. One synchronous `RangeSet.update` produces one
   * paint, so the switch cannot flicker between "all rendered" and "this block
   * raw".
   *
   * Moving the caret *inside* the same block returns immediately — that is the
   * common case (every arrow key, every click in the same paragraph).
   */
  private syncActive(state: EditorState): void {
    const next = this.computeActive(state);
    if (sameRange(this.active, next)) return;

    const affected = spanOf(this.active, next);
    this.active = next;
    if (!affected) return;

    this.decorations = this.decorations.update({
      filterFrom: affected.from,
      filterTo: affected.to,
      // Keep what lies outside the two blocks; everything inside is recomputed.
      filter: (from, to) => from < affected.from || to > affected.to,
      add: toDecorationRanges(collectLivePreviewRanges(state, [affected], revealFor(next))),
      sort: true,
    });
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    this.settlePending = true;
    // The commit transaction lands right after `compositionend` and rebuilds on
    // its own. If the composition produced no change, nothing arrives, so one
    // empty transaction (no effects, no document change) settles the layer.
    requestAnimationFrame(() => {
      if (this.destroyed || this.composing || !this.settlePending) return;
      this.settlePending = false;
      this.view.dispatch({});
    });
  };
}

export interface LivePreviewConfig {
  /**
   * Fall the block under the caret back to source. On by default — that is the
   * editable experience. Read-only views turn it off: there is no caret to fall
   * back for, and a selection at offset 0 would otherwise leave the first block
   * permanently shown as source.
   */
  revealActiveBlock?: boolean;
  /**
   * Mount the table drag handles. Off by default: only the main editor writes
   * column widths into `.md`, and a read-only preview or the sticky window (a
   * second writer on the same file) must not offer that gesture.
   */
  resizable?: boolean;
  /**
   * 纯预览编辑: nothing falls back to source under the caret and tables take the
   * pointer themselves so a cell can be edited in place. The caret fallback is
   * off by construction — a rendered block that reveals its own Markdown is
   * exactly what this mode promises not to do.
   */
  interactive?: boolean;
}

/**
 * Extension for the 实时渲染 view; absent in 源码 view.
 *
 * A factory rather than a constant because read-only instances need the same
 * decorations without the caret behaviour. Each call creates its own plugin type,
 * so call it once per editor and keep the result.
 */
export function livePreview(config: LivePreviewConfig = {}): Extension {
  const interactive = config.interactive === true;
  // 纯预览编辑 wins over the caret fallback: the two cannot both be on.
  const revealActiveBlock = interactive ? false : config.revealActiveBlock !== false;
  const resizable = config.resizable === true;
  return [
    ViewPlugin.fromClass(
      class extends LivePreviewView {
        constructor(view: EditorView) {
          super(view, revealActiveBlock);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    // Tables are block replacements, which a view plugin may not provide; the
    // field is separate for that reason, not for organisation.
    tablePreview({ revealActiveBlock, resizable, interactive }),
  ];
}

/**
 * Block(s) the selection touches. A collapsed caret yields its block; a range
 * yields the span covering both ends, so nothing inside the selection stays
 * hidden from the user who is about to replace it.
 */
function activeRange(state: EditorState): VisibleRange | null {
  const { from, to } = state.selection.main;
  const start = blockAtPosition(state, from);
  const end = from === to ? start : blockAtPosition(state, to);
  if (!start) return end;
  if (!end) return start;
  return { from: Math.min(start.from, end.from), to: Math.max(start.to, end.to) };
}

function revealFor(range: VisibleRange | null): LivePreviewOptions | undefined {
  return range ? { reveal: range } : undefined;
}

function sameRange(a: VisibleRange | null, b: VisibleRange | null): boolean {
  if (!a || !b) return a === b;
  return a.from === b.from && a.to === b.to;
}

/** Smallest range covering both, or `null` when neither exists. */
function spanOf(a: VisibleRange | null, b: VisibleRange | null): VisibleRange | null {
  if (!a) return b;
  if (!b) return a;
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
}
