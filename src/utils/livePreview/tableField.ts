import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { blockAtPosition } from "../editorBlocks";
import { readTable, TableWidget, withCols, type TableData } from "./tableWidget";
import { attachTableInteraction } from "./tableEditing";
import { columnCount, findSizingComment, normalizeSizing, type TableSizing } from "./tableSizing";

/** A table that should be rendered, in document order. */
export interface TableSpec {
  from: number;
  to: number;
  data: TableData;
  /**
   * The sizing comment above it, if any. Present even when `sizing.cols` is
   * `null` (the stored widths no longer fit the table): the comment still has to
   * be hidden, and it is still what a double-click on a drag handle deletes.
   */
  sizing: TableSizing | null;
}

/**
 * Tables that should render, given whether the caret's block falls back to
 * source.
 *
 * Split out from the field so it can be asserted without a view — the same
 * reason `decorations.ts` emits plain specs. The two-argument signature is load
 * bearing: `scripts/verify-live-preview.mjs` calls it directly. Widths are read
 * here rather than in the widget so the "does this comment still fit the table"
 * decision stays a pure function of the document.
 */
export function collectTableSpecs(state: EditorState, revealActive: boolean): TableSpec[] {
  const specs: TableSpec[] = [];
  const tree = syntaxTree(state);
  const active = revealActive ? blockAtPosition(state, state.selection.main.head) : null;

  // Top-level nodes only. A table nested inside a quote or a list item keeps
  // its source form: the block that owns it is the quote, so rendering it would
  // break the caret fallback the quote relies on.
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "Table") continue;
    if (active && node.from >= active.from && node.to <= active.to) continue;

    // A block replacement must cover whole lines. A table sharing a line with
    // other content is not one, and replacing it throws.
    if (state.doc.lineAt(node.from).from !== node.from) continue;
    if (state.doc.lineAt(node.to).to !== node.to) continue;

    const data = readTable(node, state);
    if (!data) continue;

    const comment = findSizingComment(state, node.from);
    const sizing = comment
      ? { ...comment, cols: normalizeSizing(comment.cols, columnCount(data.header, data.rows)) }
      : null;
    specs.push({ from: node.from, to: node.to, data: withCols(data, sizing?.cols ?? null), sizing });
  }

  return specs;
}

const HIDE = Decoration.replace({});
const META_LINE = Decoration.line({ class: "cm-md-table-meta-hidden" });

function build(
  state: EditorState,
  revealActive: boolean,
  resizable: boolean,
  interactive: boolean,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const specs = collectTableSpecs(state, revealActive);
  // A caret sitting on the comment has to see it, or the width could never be
  // edited by hand (A7). The comment is tested by **range**, not through
  // `blockAtPosition`: inside a `CommentBlock` the resolve chain runs
  // `Comment → Document → CommentBlock`, and `blockFromChain` stops at the first
  // `Document`, so it answers `null` for every offset inside an HTML comment.
  //
  // `interactive` counts as "this surface edits" too: an interactive table keeps
  // the pointer and never falls back to source, so `revealActive` is false there
  // and gating on it alone would leave the comment permanently invisible — the
  // one thing A7 asks for would be unreachable in the main editor.
  const selection = state.selection.main;
  const editable = revealActive || interactive;
  const revealsComment = (from: number, to: number): boolean =>
    editable && selection.to >= from && selection.from <= to + 1;

  for (const spec of specs) {
    if (spec.sizing && !revealsComment(spec.sizing.from, spec.sizing.to)) {
      // Zero height + hidden text: the comment occupies no space in the rendered
      // document but still exists for the caret. Two decorations because a
      // `replace` alone would leave an empty line of normal line height.
      ranges.push(META_LINE.range(spec.sizing.from));
      ranges.push(HIDE.range(spec.sizing.from, spec.sizing.to));
    }
    ranges.push(
      Decoration.replace({
        block: true,
        widget: new TableWidget(spec.data, {
          resizable,
          interactive,
          // The only spot that knows both halves; see `TableWidgetOptions`.
          mountInteraction: interactive ? attachTableInteraction : undefined,
        }),
      }).range(spec.from, spec.to),
    );
  }

  return Decoration.set(ranges, true);
}

/**
 * Table rendering as its own extension.
 *
 * It cannot live in the `livePreview` ViewPlugin: CodeMirror refuses block
 * decorations from a plugin (`Block decorations may not be specified via
 * plugins`) because a block replacement changes the document's height, which
 * only a state field may do. Everything else in the live preview is inline or
 * per-line, so the split is exactly at this boundary.
 *
 * No viewport is involved, and none is needed: a table is a top-level node, so
 * the walk is over the document's block list — tens of nodes — and CodeMirror
 * itself decides what to draw.
 */
export function tablePreview(
  config: { revealActiveBlock?: boolean; resizable?: boolean; interactive?: boolean } = {},
): Extension {
  const revealActive = config.revealActiveBlock !== false;
  // Off unless asked: writing column widths into the note file is an editor
  // capability, and a preview or a multi-writer window must not have it.
  const resizable = config.resizable === true;
  // 纯预览编辑: the widget keeps taking the pointer (see `tableEditing.ts`).
  const interactive = config.interactive === true;
  return StateField.define<DecorationSet>({
    create: (state) => build(state, revealActive, resizable, interactive),
    update(value, tr) {
      if (tr.docChanged || tr.selection) return build(tr.state, revealActive, resizable, interactive);
      return value.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
