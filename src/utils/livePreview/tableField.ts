import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { blockAtPosition } from "../editorBlocks";
import { readTable, TableWidget, type TableData } from "./tableWidget";

/** A table that should be rendered, in document order. */
export interface TableSpec {
  from: number;
  to: number;
  data: TableData;
}

/**
 * Tables that should render, given whether the caret's block falls back to
 * source.
 *
 * Split out from the field so it can be asserted without a view — the same
 * reason `decorations.ts` emits plain specs.
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
    if (data) specs.push({ from: node.from, to: node.to, data });
  }

  return specs;
}

function build(state: EditorState, revealActive: boolean): DecorationSet {
  const ranges: Range<Decoration>[] = collectTableSpecs(state, revealActive).map((spec) =>
    Decoration.replace({ block: true, widget: new TableWidget(spec.data) }).range(spec.from, spec.to),
  );
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
export function tablePreview(config: { revealActiveBlock?: boolean } = {}): Extension {
  const revealActive = config.revealActiveBlock !== false;
  return StateField.define<DecorationSet>({
    create: (state) => build(state, revealActive),
    update(value, tr) {
      if (tr.docChanged || tr.selection) return build(tr.state, revealActive);
      return value.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
