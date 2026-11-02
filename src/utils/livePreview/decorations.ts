import type { EditorState, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/**
 * Live preview (L1) decoration specs, sorted by document position.
 *
 * Kept as plain data rather than `Decoration` objects so the whole visual layer
 * can be checked headlessly: the repository has no GUI on this machine, and the
 * three things that can silently go wrong here — a marker that stays visible, a
 * decoration that lands outside the viewport, an inline range that eats a
 * neighbouring character — are all visible in this list.
 */
export type LivePreviewRange =
  /** Marker characters that the rendered form does not show. */
  | { kind: "hide"; from: number; to: number }
  /** Inline styling over the content a marker used to wrap. */
  | { kind: "mark"; from: number; to: number; className: string }
  /** Whole-line styling; `from` is always a line start. */
  | { kind: "line"; from: number; className: string };

/** The slice of `view.visibleRanges` this layer needs. */
export interface VisibleRange {
  from: number;
  to: number;
}

export interface LivePreviewOptions {
  /**
   * Inline markers inside this range stay visible. The block the caret sits in
   * is passed here: a `Decoration.replace` makes its own content unreachable,
   * so the block being edited has to show its source. Block-level styling —
   * heading size, quote bar, code tint — is kept, only the hides are dropped.
   */
  reveal?: VisibleRange;
}

/** Inline nodes whose markers are hidden and whose content is restyled. */
const INLINE_CLASSES: Record<string, string | undefined> = {
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-code",
  Link: "cm-md-link",
};

/** Nodes whose children are the marker runs we hide, keyed by node name. */
const MARKER_CHILD_NAMES = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
  "URL",
]);

/**
 * Everything the decoration layer renders, derived from the syntax tree that
 * already exists for `state`. Only `ranges` are walked, so a 10 000-line note
 * costs the same as a one-screen note.
 *
 * Nothing here touches the document: the result is positions, never text.
 */
export function collectLivePreviewRanges(
  state: EditorState,
  ranges: readonly VisibleRange[],
  options: LivePreviewOptions = {},
): LivePreviewRange[] {
  const tree = syntaxTree(state);
  const reveal = options.reveal;
  const result: LivePreviewRange[] = [];
  const seen = new Set<string>();

  const push = (range: LivePreviewRange): void => {
    // The block being edited shows its source: hides inside it are dropped, so
    // the caret can reach every character. Marks and line styles stay.
    if (range.kind === "hide" && reveal && range.from >= reveal.from && range.to <= reveal.to) return;
    const key =
      range.kind === "line"
        ? `line:${range.from}:${range.className}`
        : `${range.kind}:${range.from}:${range.to}:${range.kind === "mark" ? range.className : ""}`;
    // Two visible ranges can meet inside one block (the tree is walked once per
    // range), and a line can be shared by a quote and a code block.
    if (seen.has(key)) return;
    seen.add(key);
    result.push(range);
  };

  for (const range of ranges) {
    if (range.to <= range.from) continue;
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => visitNode(ref.node, state, range, push),
    });
  }

  // The walk emits a mark before the markers it sits between, and visits each
  // visible range separately, so the list is sorted here: callers (and the
  // headless spec test) get document order, `Decoration.set` gets a cheap sort.
  result.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    const aTo = a.kind === "line" ? a.from : a.to;
    const bTo = b.kind === "line" ? b.from : b.to;
    if (aTo !== bTo) return aTo - bTo;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
  return result;
}

/**
 * Turns the specs into a `DecorationSet`. Every value is a mark, a line or a
 * hide (`Decoration.replace` with nothing in it) — the document itself is never
 * written, and `Decoration.set(..., true)` tolerates the unsorted order the
 * per-range walk produces.
 */
export function buildLivePreviewDecorations(
  state: EditorState,
  ranges: readonly VisibleRange[],
  options?: LivePreviewOptions,
): DecorationSet {
  return Decoration.set(toDecorationRanges(collectLivePreviewRanges(state, ranges, options)), true);
}

/**
 * Spec list → CodeMirror ranges. Exported because the plugin patches a subset of
 * an existing set (`RangeSet.update({ add })`) when the caret crosses a block
 * boundary, and that path needs the same mapping without rebuilding the world.
 */
export function toDecorationRanges(specs: readonly LivePreviewRange[]): Range<Decoration>[] {
  return specs.map((range) => {
    switch (range.kind) {
      case "hide":
        return HIDE.range(range.from, range.to);
      case "mark":
        return markDecoration(range.className).range(range.from, range.to);
      case "line":
        return lineDecoration(range.className).range(range.from);
    }
  });
}

/** Shared instances: CodeMirror compares decorations by identity on rebuild. */
const HIDE = Decoration.replace({});
const marks = new Map<string, Decoration>();
const lines = new Map<string, Decoration>();

function markDecoration(className: string): Decoration {
  let decoration = marks.get(className);
  if (!decoration) {
    decoration = Decoration.mark({ class: className });
    marks.set(className, decoration);
  }
  return decoration;
}

function lineDecoration(className: string): Decoration {
  let decoration = lines.get(className);
  if (!decoration) {
    decoration = Decoration.line({ class: className });
    lines.set(className, decoration);
  }
  return decoration;
}

type Push = (range: LivePreviewRange) => void;

/**
 * Returns `false` to stop the walk from descending into a node — code content
 * has no inline Markdown, so there is nothing below it to decorate.
 */
function visitNode(
  node: SyntaxNode,
  state: EditorState,
  visible: VisibleRange,
  push: Push,
): boolean | void {
  const headingLevel = headingLevelOf(node.name);
  if (headingLevel > 0) {
    // Setext headings end with their `===` underline on a line of its own; that
    // line keeps the body size, only the text line is styled.
    const end = Math.min(lastHeadingOffset(node), visible.to - 1);
    if (end > node.from) {
      addLineClasses(state, Math.max(node.from, visible.from), end + 1, `cm-md-h${headingLevel}`, visible, push);
    }
    // Descend: `# **bold**` still needs its inline marks hidden.
    return;
  }

  switch (node.name) {
    case "FencedCode":
    case "CodeBlock":
      addLineClasses(state, Math.max(node.from, visible.from), Math.min(node.to, visible.to), "cm-md-code-block", visible, push);
      return false;
    case "Blockquote":
      addLineClasses(state, Math.max(node.from, visible.from), Math.min(node.to, visible.to), "cm-md-quote", visible, push);
      // Descend for inline marks inside the quote.
      return;
    case "HorizontalRule":
      if (contains(visible, node.from, node.to)) push({ kind: "hide", from: node.from, to: node.to });
      addLineClasses(state, node.from, node.to, "cm-md-hr", visible, push);
      return false;
    // A fixed-width marker column is what makes `-` and `1.` line up with the
    // text that follows them instead of each shifting it by its own width.
    case "ListMark":
      if (contains(visible, node.from, node.to)) {
        push({ kind: "mark", from: node.from, to: node.to, className: "cm-md-list-mark" });
      }
      return false;
    default:
      break;
  }

  const className = INLINE_CLASSES[node.name];
  if (className) {
    addInline(node, className, visible, push);
    // Inline code holds raw text; emphasis and links can hold other inline
    // nodes, but those are already inside the marked content range.
    return node.name !== "InlineCode";
  }

  return;
}

/**
 * Hides the marker runs around an inline node and marks the content between
 * them. The content is bare text in the tree (`**粗**` only exposes the two
 * `EmphasisMark` children), so it is derived from the markers instead of from a
 * content child.
 *
 * Ranges are only emitted when they sit fully inside the visible range: a
 * half-hidden marker would be worse than a marker that shows for one more frame.
 */
function addInline(
  node: SyntaxNode,
  className: string,
  visible: VisibleRange,
  push: Push,
): void {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
  if (children.length === 0) return;

  const contentFrom = children[0].to;
  // A link closes its label at the second `LinkMark` (`[label](url)`); the rest
  // of the children are the destination and its brackets.
  const contentTo =
    node.name === "Link" ? secondLinkMarkFrom(children, node.to) : children[children.length - 1].from;

  if (contentTo > contentFrom && contains(visible, contentFrom, contentTo)) {
    push({ kind: "mark", from: contentFrom, to: contentTo, className });
  }

  for (const child of children) {
    if (child.to > contentFrom && child.from < contentTo) continue; // inside the label
    if (!MARKER_CHILD_NAMES.has(child.name)) continue;
    if (!contains(visible, child.from, child.to)) continue;
    push({ kind: "hide", from: child.from, to: child.to });
  }
}

function secondLinkMarkFrom(children: readonly SyntaxNode[], fallback: number): number {
  let seenFirst = false;
  for (const child of children) {
    if (child.name !== "LinkMark") continue;
    if (seenFirst) return child.from;
    seenFirst = true;
  }
  return fallback;
}

/** Emits one line decoration per visible line of `[from, to)`. */
function addLineClasses(
  state: EditorState,
  from: number,
  to: number,
  className: string,
  visible: VisibleRange,
  push: Push,
): void {
  if (to <= from) return;
  const doc = state.doc;
  const firstLine = Math.max(doc.lineAt(from).number, doc.lineAt(visible.from).number);
  const lastLine = Math.min(doc.lineAt(to - 1).number, doc.lineAt(Math.max(visible.from, visible.to - 1)).number);
  for (let number = firstLine; number <= lastLine; number += 1) {
    push({ kind: "line", from: doc.line(number).from, className });
  }
}

/** Heading level from an `ATXHeading1`…`ATXHeading6` / `SetextHeading1`…`2` node. */
function headingLevelOf(name: string): number {
  if (!name.startsWith("ATXHeading") && !name.startsWith("SetextHeading")) return 0;
  return name.charCodeAt(name.length - 1) - 48;
}

/**
 * Last offset the heading's own text covers. A trailing `HeaderMark` is either
 * the Setext underline or a closing `###`, neither of which should carry the
 * heading size.
 */
function lastHeadingOffset(node: SyntaxNode): number {
  const last = node.lastChild;
  if (last && last.name === "HeaderMark" && last.from > node.from) return last.from - 1;
  return node.to - 1;
}

function contains(visible: VisibleRange, from: number, to: number): boolean {
  return from >= visible.from && to <= visible.to;
}
