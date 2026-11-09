import type { EditorState, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { highlightRanges } from "../highlight";
import { ListMarkerWidget, TaskCheckboxWidget } from "./listWidget";
import { CodeLanguageWidget } from "./codeLanguageWidget";
import { codeFenceInfoAt } from "./codeBlock";

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
  | { kind: "line"; from: number; className: string }
  /**
   * A marker replaced by rendered DOM: the list bullet, the ordinal, or the task
   * checkbox. `text` is what the widget shows (`""` for a checkbox) and
   * `checked` only means something for `cm-md-task`.
   */
  | {
      kind: "widget";
      from: number;
      to: number;
      className: string;
      text: string;
      checked?: boolean;
    }
  /**
   * The language chip at the end of a code card's last visible line.
   *
   * A zero-width anchor (`from === to`), not a replaced marker: there is no
   * source text at that position — the chip is an insertion point that happens to
   * carry DOM. `blockFrom` is the `FencedCode.from` the picker rewrites, so the
   * chip does not have to guess which block it belongs to.
   */
  | {
      kind: "codeLang";
      from: number;
      to: number;
      label: string;
      mode: "menu" | "static";
      blockFrom: number;
    };

/** The slice of `view.visibleRanges` this layer needs. */
export interface VisibleRange {
  from: number;
  to: number;
}

/**
 * Label for a code block that has no language, when the caller did not supply
 * one. Lives here because this is the layer that would otherwise paint an empty
 * chip: `toDecorationRanges` is a public entry point that takes no options, and
 * a `""` fallback would produce a chip with no text and nothing to click.
 */
export const DEFAULT_CODE_PLAIN_TEXT = "纯文本";

export interface LivePreviewOptions {
  /**
   * Inline markers inside this range stay visible. The block the caret sits in
   * is passed here: a `Decoration.replace` makes its own content unreachable,
   * so the block being edited has to show its source. Block-level styling —
   * heading size, quote bar, code tint — is kept, only the hides are dropped.
   */
  reveal?: VisibleRange;
  /**
   * The code-card language chip. Absent → no chip at all, which is what 源码
   * view gets (no live-preview layer there either way).
   */
  codeLanguage?: {
    /** `menu` opens the picker; `static` only labels the block. */
    mode: "menu" | "static";
    /** Label used when a fence has no language yet (`纯文本`). */
    plainText: string;
  };
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
    // The block being edited shows its source: hides and marker widgets inside
    // it are dropped, so the caret can reach every character. Marks and line
    // styles stay.
    //
    // The language chip drops with the widgets, and that is correct rather than
    // incidental: a revealed block shows its own info string as editable text, so
    // a second affordance for the same value would be a competing control. It
    // only ever *is* inside `reveal` when the caller forgot to skip it — this
    // keeps the invariant in one place.
    if (
      (range.kind === "hide" || range.kind === "widget" || range.kind === "codeLang") &&
      reveal &&
      range.from >= reveal.from &&
      range.to <= reveal.to
    ) {
      return;
    }
    const key =
      range.kind === "line"
        ? `line:${range.from}:${range.className}`
        : range.kind === "widget"
          ? `widget:${range.from}:${range.to}:${range.className}:${range.text}:${range.checked ? "x" : "-"}`
          : range.kind === "codeLang"
            ? `codeLang:${range.from}:${range.label}:${range.mode}:${range.blockFrom}`
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
      enter: (ref) => visitNode(ref.node, state, range, options, push),
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
  return Decoration.set(
    toDecorationRanges(collectLivePreviewRanges(state, ranges, options), options),
    true,
  );
}

/**
 * Spec list → CodeMirror ranges. Exported because the plugin patches a subset of
 * an existing set (`RangeSet.update({ add })`) when the caret crosses a block
 * boundary, and that path needs the same mapping without rebuilding the world.
 *
 * `options` is threaded through only for the language chip: a widget has to carry
 * the "plain text" label (it opens the picker itself, with no option object in
 * scope). Every other decoration is independent of the options.
 */
export function toDecorationRanges(
  specs: readonly LivePreviewRange[],
  options?: LivePreviewOptions,
): Range<Decoration>[] {
  const codeLanguage = options?.codeLanguage;
  return specs.map((range) => {
    switch (range.kind) {
      case "hide":
        return HIDE.range(range.from, range.to);
      case "mark":
        return markDecoration(range.className).range(range.from, range.to);
      case "line":
        return lineDecoration(range.className).range(range.from);
      case "widget":
        return decorationWithWidget(range).range(range.from, range.to);
      case "codeLang":
        // `side: 1` puts the chip after anything else anchored at the same
        // offset (a token mark can end exactly at the line's end). Zero width:
        // `range(from)`, never `range(from, to)`.
        return Decoration.widget({
          widget: new CodeLanguageWidget(
            range.label,
            range.mode,
            range.blockFrom,
            codeLanguage?.plainText ?? DEFAULT_CODE_PLAIN_TEXT,
          ),
          side: 1,
        }).range(range.from);
    }
  });
}

/** Shared instances: CodeMirror compares decorations by identity on rebuild. */
const HIDE = Decoration.replace({});
const marks = new Map<string, Decoration>();
const lines = new Map<string, Decoration>();

/**
 * A marker replaced by its rendered form. Not cached: the widget carries the
 * ordinal / checked state, and `WidgetType.eq` is what decides whether the DOM
 * is reused, not decoration identity.
 */
function decorationWithWidget(range: Extract<LivePreviewRange, { kind: "widget" }>): Decoration {
  const widget =
    range.className === "cm-md-task"
      ? new TaskCheckboxWidget(range.from, Boolean(range.checked))
      : new ListMarkerWidget(range.text, range.className);
  return Decoration.replace({ widget });
}

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
  options: LivePreviewOptions,
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
      addFencedCode(node, state, visible, options, push);
      // Token colours are a separate pass for a separate reason: they need the
      // block's text, not its markers, and they are emitted as ordinary marks so
      // the source stays coloured while the caret is inside the block.
      if (node.name === "FencedCode") addCodeHighlight(node, state, visible, push);
      return false;
    case "Blockquote":
      addLineClasses(state, Math.max(node.from, visible.from), Math.min(node.to, visible.to), "cm-md-quote", visible, push);
      // Descend for inline marks inside the quote.
      return;
    // Rendering lives in `tableField.ts`: a block replacement may only be
    // provided by a state field, and this layer is a view plugin. What is left
    // here is the caret-inside case — the source view still needs its inline
    // marks hidden, so descend instead of stopping.
    case "Table":
      return;
    case "HorizontalRule":
      if (contains(visible, node.from, node.to)) push({ kind: "hide", from: node.from, to: node.to });
      addLineClasses(state, node.from, node.to, "cm-md-hr", visible, push);
      return false;
    // A fixed-width marker column is what makes `-` and `1.` line up with the
    // text that follows them instead of each shifting it by its own width.
    case "ListMark":
      addListMark(node, state, visible, push);
      return false;
    case "TaskMarker":
      addTaskCheckbox(node, state, visible, push);
      return false;
    // Block markers are hidden only outside the caret's block: `push` drops
    // hides inside `reveal`, so the caret's heading shows its `#` and its quote
    // shows its `>` again — the same rule list markers and inline marks obey.
    case "HeaderMark":
      addHeaderMark(node, state, visible, push);
      return false;
    case "QuoteMark":
      addQuoteMark(node, state, visible, push);
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

/** Bullet glyph by nesting level — the three Typora cycles through. */
const BULLET_GLYPHS = ["•", "◦", "▪"];

/**
 * A list marker (`-`, `*`, `+`, `1.`, `1)`) and the single space after it become
 * rendered DOM: a bullet, an incrementing ordinal, or — for a task item —
 * nothing, because the checkbox that follows is the marker.
 *
 * Only outside the caret's block: `push` drops widgets inside the revealed
 * range, so the source `-` comes back when the caret enters the item. That is
 * not cosmetic — `Decoration.replace` makes its own range unreachable for the
 * caret, so a marker that stayed a widget could never be edited or deleted.
 */
function addListMark(node: SyntaxNode, state: EditorState, visible: VisibleRange, push: Push): void {
  const item = node.parent;
  // Defensive: a `ListMark` outside a `ListItem` has no list to classify.
  if (!item || item.name !== "ListItem") return;
  // Include the space after the marker: the widget supplies its own gap, so
  // leaving the source space in place would double it.
  const end = includeTrailingSpace(state, node.to);
  if (!contains(visible, node.from, end)) return;

  if (hasChildNamed(item, "Task")) {
    // `- [ ]` renders as a checkbox, not as "• ☐".
    push({ kind: "hide", from: node.from, to: end });
    return;
  }

  const list = item.parent;
  if (list?.name === "OrderedList") {
    const text = `${orderedOrdinal(state, item)}${delimiterOf(state, node)}`;
    push({ kind: "widget", from: node.from, to: end, className: "cm-md-ordered", text });
    return;
  }

  const level = listDepthOf(node);
  push({
    kind: "widget",
    from: node.from,
    to: end,
    className: "cm-md-bullet",
    text: BULLET_GLYPHS[(level - 1) % BULLET_GLYPHS.length],
  });
}

/**
 * The `#` run of an ATX heading (and a closing `###`), hidden together with the
 * single space after it so the text starts at the line's left edge.
 *
 * A Setext heading's `HeaderMark` is the `===` underline, which sits on the
 * *next* line; hiding it would leave an empty line where it was, so the line
 * check below keeps Setext headings as they are. Only `#` is in scope here.
 */
function addHeaderMark(node: SyntaxNode, state: EditorState, visible: VisibleRange, push: Push): void {
  const heading = node.parent;
  if (!heading || headingLevelOf(heading.name) === 0) return;
  const markLine = state.doc.lineAt(node.from).number;
  if (markLine !== state.doc.lineAt(heading.from).number) return;
  const end = includeTrailingSpace(state, node.to);
  if (!contains(visible, node.from, end)) return;
  push({ kind: "hide", from: node.from, to: end });
}

/**
 * `>` plus the space after it. The line keeps `.cm-md-quote` (left bar +
 * indent), which is what replaces the marker visually — hiding `>` without
 * that indent would leave the text glued to the bar.
 *
 * Multi-line quotes have one `QuoteMark` per line, and a lazily continued line's
 * mark lives *inside* the paragraph; hiding them all is what makes a quote read
 * as one block instead of a stack of `>`.
 */
function addQuoteMark(node: SyntaxNode, state: EditorState, visible: VisibleRange, push: Push): void {
  const end = includeTrailingSpace(state, node.to);
  if (!contains(visible, node.from, end)) return;
  push({ kind: "hide", from: node.from, to: end });
}

/** `[ ]` / `[x]` → a checkbox; the `- ` in front of it is hidden above. */
function addTaskCheckbox(node: SyntaxNode, state: EditorState, visible: VisibleRange, push: Push): void {
  // `TaskMarker` → `Task` → `ListItem`; anything else is not a checkbox.
  const item = node.parent?.parent;
  if (!item || item.name !== "ListItem") return;
  const end = includeTrailingSpace(state, node.to);
  if (!contains(visible, node.from, end)) return;
  push({
    kind: "widget",
    from: node.from,
    to: end,
    className: "cm-md-task",
    text: "",
    checked: state.sliceDoc(node.from + 1, node.from + 2) !== " ",
  });
}

/** `to` plus one following space/tab, if there is one. */
function includeTrailingSpace(state: EditorState, to: number): number {
  const next = state.sliceDoc(to, Math.min(to + 1, state.doc.length));
  return next === " " || next === "\t" ? to + 1 : to;
}

function hasChildNamed(node: SyntaxNode, name: string): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return true;
  }
  return false;
}

/** 1-based nesting of the list a marker belongs to. */
function listDepthOf(node: SyntaxNode): number {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "BulletList" || parent.name === "OrderedList") depth += 1;
  }
  return Math.max(1, depth);
}

/**
 * The number the *reader* sees: the list's start plus the item's index.
 * `1. 1. 1.` therefore renders 1. 2. 3., which is what the Markdown means —
 * the digits in the source are only a hint to the parser.
 */
function orderedOrdinal(state: EditorState, item: SyntaxNode): number {
  let index = 0;
  for (let sibling = item.prevSibling; sibling; sibling = sibling.prevSibling) {
    if (sibling.name === "ListItem") index += 1;
  }
  const list = item.parent;
  const firstItem = list?.firstChild;
  const firstMark = firstItem?.name === "ListItem" ? firstItem.firstChild : null;
  const start =
    firstMark?.name === "ListMark"
      ? Number.parseInt(state.sliceDoc(firstMark.from, firstMark.to), 10)
      : 1;
  return (Number.isFinite(start) ? start : 1) + index;
}

/** `.` or `)` — kept as written, so `1)` does not silently become `1.`. */
function delimiterOf(state: EditorState, mark: SyntaxNode): string {
  return state.sliceDoc(Math.max(mark.from, mark.to - 1), mark.to);
}

/**
 * Everything a code block contributes: the card's line classes, the hidden
 * fences, the info label and the language chip.
 *
 * One function rather than three passes, because the decisions are entangled:
 * *which* lines are the card's first and last depends on whether the fences are
 * hidden, and whether the fences are hidden depends on whether the block has a
 * body at all.
 *
 * Three states, all driven by `options.reveal`:
 *
 * 1. **Revealed** (the caret is in this block) — byte-for-byte the old
 *    behaviour: every line of the node is a card line, the info string keeps its
 *    `cm-md-code-info` mark, and the ```` ``` ```` lines are ordinary editable
 *    text. Nothing is collapsed, because `Decoration.replace` would make the
 *    fence unreachable and the block uneditable.
 * 2. **Hidden with a body** — the two fence lines collapse and their text is
 *    replaced; the card's first/last classes move to the first/last *body* line;
 *    the chip goes at the end of the last body line.
 * 3. **Hidden and empty** — only the opening fence collapses. The closing fence
 *    stays as the card's single visible row (its text is still replaced, but it
 *    keeps its height), so an empty block is a clickable placeholder instead of
 *    a block that vanishes and cannot be reached again.
 *
 * An indented block (`CodeBlock`) has no fence and no info string, so it is
 * always case 1 minus the label: zero hiding, no chip.
 */
function addFencedCode(
  node: SyntaxNode,
  state: EditorState,
  visible: VisibleRange,
  options: LivePreviewOptions,
  push: Push,
): void {
  if (node.name !== "FencedCode") {
    addCodeBlockLines(node, state, visible, push);
    return;
  }

  const doc = state.doc;
  const openLine = doc.lineAt(node.from).number;
  const blockLastLine = doc.lineAt(Math.max(node.to, node.from + 1) - 1).number;

  let open: SyntaxNode | null = null;
  let close: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "CodeMark") continue;
    // First `CodeMark` opens, a second one closes; an unclosed fence runs to
    // the end of the document with no closing mark at all.
    if (open) close = child;
    else open = child;
  }
  const closeLine = close ? doc.lineAt(close.from).number : 0;

  const reveal = options.reveal;
  const revealed = Boolean(reveal && node.from >= reveal.from && node.to <= reveal.to);
  if (revealed) {
    addCodeBlockLines(node, state, visible, push);
    addCodeInfoMark(node, visible, push);
    return;
  }

  const bodyFirst = openLine + 1;
  const bodyLast = close ? closeLine - 1 : blockLastLine;
  // Blank lines are not a body. ```` ``` ```` / an empty line / ```` ``` ```` is a
  // block the user has not typed into yet, and rendering it as a two-row card
  // would put the clickable row below an unexplained gap.
  let hasBody = false;
  for (let number = bodyFirst; number <= bodyLast; number += 1) {
    if (doc.line(number).text.trim() !== "") {
      hasBody = true;
      break;
    }
  }

  // A lone ```` ``` ```` with no newline yet: there is nothing to collapse, and
  // collapsing the only line would hide the fence the user is still typing.
  if (!close && !hasBody) {
    addCodeBlockLines(node, state, visible, push);
    addCodeInfoMark(node, visible, push);
    return;
  }

  if (hasBody) {
    if (open) collapseLine(state, openLine, visible, push, open.from);
    if (close) collapseLine(state, closeLine, visible, push, close.from);
    // The card's corners belong to the body now: the fence lines are gone, so
    // rounding them (or rounding the topmost *painted* line when the block is
    // scrolled) would draw a cap around nothing.
    addCardLines(state, visible, push, bodyFirst, bodyLast);
    addLanguageChip(state, visible, options, node, doc.line(bodyLast).to, push);
    return;
  }

  // Empty block. The opening fence and any blank body line collapse; the closing
  // fence line becomes the card.
  if (open) collapseLine(state, openLine, visible, push, open.from);
  for (let number = bodyFirst; number <= bodyLast; number += 1) {
    collapseLine(state, number, visible, push);
  }
  const lastLine = doc.line(closeLine);
  if (contains(visible, lastLine.from, lastLine.to)) {
    push({ kind: "line", from: lastLine.from, className: "cm-md-code-block cm-md-code-single" });
  }
  // Still replaced — only the line *class* differs, so the row keeps its height
  // and the chip has something to sit on. Without this the closing fence would
  // be the one piece of raw Markdown left on a rendered card.
  const hideFrom = Math.max(lastLine.from, close ? close.from : lastLine.from);
  if (lastLine.to > hideFrom && contains(visible, hideFrom, lastLine.to)) {
    push({ kind: "hide", from: hideFrom, to: lastLine.to });
  }
  addLanguageChip(state, visible, options, node, lastLine.to, push);
}

/**
 * Collapse one line: the `cm-md-code-block cm-md-code-fence-hidden` pair (four
 * classes with `.cm-line`, which is what it takes to beat the three-class card
 * rules) plus a hide over its text.
 *
 * `textFrom` starts the hide at the fence characters rather than at the line
 * start: a fence nested in a list item or a quote carries its `- ` / `> ` prefix
 * outside the node, and hiding it would take the container marker with it.
 *
 * The hide never crosses a line break — `[line.from, line.to]` is one line by
 * construction, which is also CodeMirror's hard requirement: a `Decoration` that
 * spans a line break throws at paint time, not at build time, so it would reach
 * production as a blank editor.
 */
function collapseLine(
  state: EditorState,
  lineNumber: number,
  visible: VisibleRange,
  push: Push,
  textFrom?: number,
): void {
  const line = state.doc.line(lineNumber);
  if (!contains(visible, line.from, line.to)) return;
  push({ kind: "line", from: line.from, className: "cm-md-code-block cm-md-code-fence-hidden" });
  const from = Math.max(line.from, textFrom ?? line.from);
  // A blank line has no text to replace; the line class alone collapses it.
  if (line.to > from) push({ kind: "hide", from, to: line.to });
}

/**
 * The language chip, at the end of the card's last visible line.
 *
 * `from === to` (a zero-width anchor) because there is no character for it to
 * cover — the value it edits lives up on the fence line. `blockFrom` is the node
 * start, which is what the picker hands to `codeBlockLanguageSpec`.
 *
 * Elided when a `static` chip would have nothing to say: in a read-only window
 * (or 纯预览编辑) there is no picker, so an unlabelled block would grow a
 * permanent "纯文本" tag on every example in the note. A *labelled* block still
 * gets one — that is the useful half of the label.
 */
function addLanguageChip(
  state: EditorState,
  visible: VisibleRange,
  options: LivePreviewOptions,
  node: SyntaxNode,
  at: number,
  push: Push,
): void {
  const codeLanguage = options.codeLanguage;
  if (!codeLanguage) return;
  // A zero-width range is visible when the line break it sits on is: compare the
  // point, not `contains`, which would need `to > from`.
  if (at < visible.from || at > visible.to) return;

  const info = codeFenceInfoAt(state, node.from);
  const word = info ? state.sliceDoc(info.wordFrom, info.wordTo) : "";
  if (!word && codeLanguage.mode === "static") return;

  push({
    kind: "codeLang",
    from: at,
    to: at,
    label: word || codeLanguage.plainText,
    mode: codeLanguage.mode,
    blockFrom: node.from,
  });
}

/**
 * One line decoration per visible line of a code block, with the first and last
 * line marked so CSS can round the corners.
 *
 * The first/last decision uses the *node's* bounds, not the visible slice: when
 * the top of a block scrolls out of view the topmost painted line is mid-block,
 * and rounding it would draw a stray cap in the middle of the block.
 */
function addCodeBlockLines(
  node: SyntaxNode,
  state: EditorState,
  visible: VisibleRange,
  push: Push,
): void {
  const doc = state.doc;
  addCardLines(
    state,
    visible,
    push,
    doc.lineAt(node.from).number,
    doc.lineAt(Math.max(node.to, node.from + 1) - 1).number,
  );
}

/**
 * `cm-md-code-block` on every visible line of `[blockFirstLine, blockLastLine]`,
 * plus `first` / `last` / `single` on the card's ends.
 *
 * Split out of `addCodeBlockLines` because the hidden-fence case re-anchors the
 * card's ends onto the body: same geometry, different bounds.
 */
function addCardLines(
  state: EditorState,
  visible: VisibleRange,
  push: Push,
  blockFirstLine: number,
  blockLastLine: number,
): void {
  const doc = state.doc;
  if (blockLastLine < blockFirstLine) return;

  const from = Math.max(doc.line(blockFirstLine).from, visible.from);
  const to = Math.min(doc.line(blockLastLine).to, visible.to);
  if (to <= from) return;

  const firstLine = Math.max(doc.lineAt(from).number, doc.lineAt(visible.from).number);
  const lastLine = Math.min(doc.lineAt(to - 1).number, doc.lineAt(Math.max(visible.from, visible.to - 1)).number);

  for (let number = Math.max(firstLine, blockFirstLine); number <= Math.min(lastLine, blockLastLine); number += 1) {
    const isFirst = number === blockFirstLine && number === firstLine;
    const isLast = number === blockLastLine && number === lastLine;
    const className =
      isFirst && isLast
        ? "cm-md-code-block cm-md-code-single"
        : isFirst
          ? "cm-md-code-block cm-md-code-first"
          : isLast
            ? "cm-md-code-block cm-md-code-last"
            : "cm-md-code-block";
    push({ kind: "line", from: doc.line(number).from, className });
  }
}

/**
 * The info string of a fence (`js` in ```` ```js ````) as a mark, so CSS can
 * render it as a label instead of as the first word of the code.
 *
 * A mark, never a hide: the info string is the only place a language can be
 * typed (nothing here guesses one), so it stays ordinary editable text — the
 * class is purely visual. Only emitted for a *revealed* block: when the fences
 * are collapsed the whole line is replaced, and a mark inside a hide would break
 * the "hide and mark never overlap" invariant this layer keeps.
 */
function addCodeInfoMark(node: SyntaxNode, visible: VisibleRange, push: Push): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "CodeInfo" || child.to <= child.from) continue;
    if (!contains(visible, child.from, child.to)) continue;
    push({ kind: "mark", from: child.from, to: child.to, className: "cm-md-code-info" });
    return;
  }
}

/**
 * Token colours for a fenced block, reusing the highlighter the preview and the
 * exporters already use (`highlight.js`), so a block looks the same everywhere.
 *
 * The highlighter needs text, so this is the one place the layer reads the
 * document — read-only, never written back. Runs are emitted as ordinary marks
 * and are therefore *not* dropped when the caret enters the block: the source
 * stays coloured while it is being edited, which is what makes dropping the
 * hidden markers acceptable.
 */
function addCodeHighlight(
  node: SyntaxNode,
  state: EditorState,
  visible: VisibleRange,
  push: Push,
): void {
  let info = "";
  let text: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeInfo") info = state.doc.sliceString(child.from, child.to);
    else if (child.name === "CodeText") text = child;
  }
  if (!text) return;

  const code = state.doc.sliceString(text.from, text.to);
  for (const run of highlightRanges(code, info)) {
    const from = text.from + run.from;
    const to = text.from + run.to;
    // Clipping at the viewport edge would paint half a token on the wrong
    // character once the block scrolls; skip it and let the next paint catch it.
    if (!contains(visible, from, to)) continue;
    push({ kind: "mark", from, to, className: run.className });
  }
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
