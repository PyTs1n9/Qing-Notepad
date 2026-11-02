import { Annotation, ChangeSet, Prec, type EditorState, type Extension, type Line, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import type { SyntaxNode } from "@lezer/common";

/**
 * Markdown input rules (L2).
 *
 * Every rule is a plain function from a caret context to a `TransactionSpec`,
 * registered in `INPUT_RULES` under one id. Nothing is bound implicitly: the
 * keymap at the bottom is the only entry point, so a rule can be switched off by
 * id without touching the others, and every rule can be tested by applying its
 * spec to a state — no view, no key events.
 *
 * Every dispatch carries two annotations:
 * - `inputRuleSource` records which rule produced it;
 * - `isolateHistory.of("full")` puts the conversion in its own undo group, so one
 *   Ctrl+Z undoes one whole conversion. A rule must therefore never emit two
 *   transactions for one keystroke.
 *
 * Markers are read from their syntax-tree nodes where the parser has them
 * (ListMark, CodeMark, TaskMarker). Only constructs the parser cannot represent
 * *before* the keystroke are recognised from the line text: `#` with no space
 * yet, `$$`, and `---`.
 */
export const INPUT_RULE_IDS = [
  "headingShortcut",
  "quoteContinue",
  "listContinue",
  "listExit",
  "listIndent",
  "fenceClose",
  "mathClose",
  "hrBreak",
  "inlineWrap",
  "imageDrop",
  "taskToggle",
] as const;

export type InputRuleId = (typeof INPUT_RULE_IDS)[number];

/** Rule 10 has no text rule: it lives in the paste/drop handler. */
export type TextRuleId = Exclude<InputRuleId, "imageDrop">;

/** Which rule produced a transaction. */
export const inputRuleSource = Annotation.define<InputRuleId>();

export interface RuleContext {
  state: EditorState;
  /** Caret position (main selection head). */
  pos: number;
  /** Line containing the caret. */
  line: Line;
  /** Text of that line before the caret. */
  before: string;
  collapsed: boolean;
}

export interface InputRule {
  readonly id: TextRuleId;
  /** One line, used by the docs and the verification table. */
  readonly trigger: string;
  run(context: RuleContext): TransactionSpec | null;
}

export function ruleContext(state: EditorState): RuleContext {
  const { from, to, head } = state.selection.main;
  const line = state.doc.lineAt(head);
  return {
    state,
    pos: head,
    line,
    before: state.sliceDoc(line.from, head),
    collapsed: from === to,
  };
}

// ---------------------------------------------------------------------------
// 1 · 行首 `#` + 空格 → 标题
// ---------------------------------------------------------------------------

/**
 * Space after 1–6 hashes at the start of a line turns that line into a heading.
 *
 * The parser already reads `# ` as an ATX heading, so what this rule adds is the
 * normalisation the parser refuses: up to three leading spaces are dropped
 * (otherwise the line stays a paragraph) and the level is capped at six —
 * `#######` is not a heading, so the rule declines and the space is typed as a
 * plain space.
 */
const headingShortcut: InputRule = {
  id: "headingShortcut",
  trigger: "Space at line start after #{1,6}",
  run({ pos, line, before, collapsed }) {
    if (!collapsed || pos !== line.to) return null;
    const match = /^( {0,3})(#{1,6})$/.exec(before);
    if (!match) return null;
    const hashes = match[2];
    return {
      changes: { from: line.from, to: pos, insert: `${hashes} ` },
      selection: { anchor: line.from + hashes.length + 1 },
    };
  },
};

// ---------------------------------------------------------------------------
// 2 · 引用续行
// ---------------------------------------------------------------------------

/**
 * Enter inside a quote starts the next line with the same `>` chain. On a line
 * that holds nothing but the marker it removes the marker instead, which is how a
 * quote is left; a nested quote drops one level at a time.
 */
const quoteContinue: InputRule = {
  id: "quoteContinue",
  trigger: "Enter inside a blockquote",
  run({ state, pos, line }) {
    const prefix = quotePrefixOf(line.text);
    if (prefix.length === 0) {
      // Lazy continuation (`> a` then `b`): the tree still says quote, but there
      // is no marker to copy, so let the default newline handle it.
      return null;
    }
    if (line.text.slice(prefix.length).trim() === "") {
      // Drop one `>` level, not the last character: `> ` must become `""`, and
      // `> > ` must become `> ` rather than `>`.
      const levels = prefix.match(/>[ \t]?/g) ?? [];
      const outer = levels.slice(0, -1).join("");
      return {
        changes: { from: line.from, to: pos, insert: outer },
        selection: { anchor: line.from + outer.length },
      };
    }
    const inQuote = hasAncestor(state, pos, "Blockquote");
    if (!inQuote) return null;
    return {
      changes: { from: pos, insert: `\n${prefix}` },
      selection: { anchor: pos + 1 + prefix.length },
    };
  },
};

// ---------------------------------------------------------------------------
// 3 · 列表续行（有序递增）
// ---------------------------------------------------------------------------

/**
 * Enter inside a list item starts the next item: same bullet, or the next number
 * for ordered lists. A task item continues as a fresh unchecked task, and an item
 * inside a quote keeps the quote prefix.
 *
 * Splitting mid-line works too — the remainder keeps the new marker.
 */
const listContinue: InputRule = {
  id: "listContinue",
  trigger: "Enter at the end of a list item",
  run({ state, pos, line, before }) {
    const item = ancestorNamed(state, pos, LIST_ITEM_NAMES);
    if (!item) return null;
    // Only the item's first line carries the marker; deeper lines are wrapped
    // prose and get a plain newline.
    if (line.from !== state.doc.lineAt(item.from).from) return null;
    // Enter on an item that has no content is rule 4's job.
    if (before.trim() === "" || isEmptyItem(line, before)) return null;

    const marker = item.firstChild?.name === "ListMark" ? item.firstChild : null;
    if (!marker) return null;

    const quote = quotePrefixOf(line.text);
    const indent = /^[ \t]*/.exec(line.text.slice(quote.length))?.[0] ?? "";
    const next = nextMarker(state.sliceDoc(marker.from, marker.to), isTask(item));

    return {
      changes: { from: pos, insert: `\n${quote}${indent}${next} ` },
      selection: { anchor: pos + 1 + quote.length + indent.length + next.length + 1 },
    };
  },
};

// ---------------------------------------------------------------------------
// 4 · 空列表项退出
// ---------------------------------------------------------------------------

/**
 * Enter on an item that holds nothing but its marker removes the marker and the
 * indent, so the list ends instead of growing another empty item. Inside a quote
 * the `>` prefix stays; a second Enter then leaves the quote (rule 2).
 */
const listExit: InputRule = {
  id: "listExit",
  trigger: "Enter on an empty list item",
  run({ state, pos, line, before }) {
    const item = ancestorNamed(state, pos, LIST_ITEM_NAMES);
    if (!item) return null;
    if (line.from !== state.doc.lineAt(item.from).from) return null;
    if (!isEmptyItem(line, before)) return null;
    if (line.text.slice(before.length).trim() !== "") return null;

    const quote = quotePrefixOf(line.text);
    const keep = quote.length <= before.length ? quote : "";
    return {
      changes: { from: line.from, to: pos, insert: keep },
      selection: { anchor: line.from + keep.length },
    };
  },
};

// ---------------------------------------------------------------------------
// 5 · Tab / Shift-Tab 调整列表层级
// ---------------------------------------------------------------------------

/**
 * Tab indents the whole item — nested children included — by one document unit;
 * Shift-Tab removes one unit. The unit comes from the item itself, else from the
 * first indented list line in the document, else two spaces, so a note never ends
 * up mixing tab-indented and space-indented list levels.
 */
const listIndent: InputRule = {
  id: "listIndent",
  trigger: "Tab / Shift-Tab inside a list item",
  run({ state, pos }) {
    const item = ancestorNamed(state, pos, LIST_ITEM_NAMES, 1);
    if (!item) return null;
    return indentItem(state, item, 1);
  },
};

const listOutdent: InputRule = {
  id: "listIndent",
  trigger: "Shift-Tab inside a list item",
  run({ state, pos }) {
    const item = ancestorNamed(state, pos, LIST_ITEM_NAMES, 1);
    if (!item) return null;
    return indentItem(state, item, -1);
  },
};

// ---------------------------------------------------------------------------
// 6 · 围栏代码块补闭合
// ---------------------------------------------------------------------------

/**
 * Enter right after an opening fence that has no closing fence yet inserts the
 * closing fence and leaves the caret on the empty line between the two. A closed
 * fence — or any other line inside the block — gets a plain newline.
 */
const fenceClose: InputRule = {
  id: "fenceClose",
  trigger: "Enter after an unclosed ``` / ~~~ fence",
  run({ state, pos, line, before }) {
    const fence = ancestorNamed(state, pos, FENCE_NAMES);
    if (!fence) return null;
    if (line.from !== state.doc.lineAt(fence.from).from) return null;
    if (line.text.slice(before.length).trim() !== "") return null;
    const opener = fence.firstChild;
    if (!opener || opener.name !== "CodeMark") return null;
    if (hasClosingFence(fence)) return null;

    const delimiter = state.sliceDoc(opener.from, opener.to);
    return {
      changes: { from: pos, insert: `\n\n${delimiter}` },
      selection: { anchor: pos + 1 },
    };
  },
};

// ---------------------------------------------------------------------------
// 7 · $$ 补闭合
// ---------------------------------------------------------------------------

/**
 * Enter on a line that is exactly `$$` opens a display-math block and closes it
 * one line below. `$$` is not CommonMark, so this one is textual; an odd number of
 * `$$` lines above means the caret is already inside a math block and that `$$`
 * is the closer, so the rule declines.
 */
const mathClose: InputRule = {
  id: "mathClose",
  trigger: "Enter after a line that is exactly $$",
  run({ state, pos, line, before }) {
    if (before !== "$$") return null;
    if (line.text.slice(before.length).trim() !== "") return null;
    if (insideMathBlock(state, line.from)) return null;
    return {
      changes: { from: pos, insert: "\n\n$$" },
      selection: { anchor: pos + 1 },
    };
  },
};

// ---------------------------------------------------------------------------
// 8 · --- 转分隔线
// ---------------------------------------------------------------------------

/**
 * Enter after a `---` / `***` / `___` line keeps the rule on its own paragraph.
 * If the parser had merged that line into the paragraph above as a Setext
 * underline, the same transaction opens a blank line before it — otherwise the
 * "rule" would quietly stay an H2 underline.
 */
const hrBreak: InputRule = {
  id: "hrBreak",
  trigger: "Enter after a --- / *** / ___ line",
  run({ state, pos, line, before }) {
    if (!isRuleLine(before) || line.text.slice(before.length).trim() !== "") return null;
    const underline = ancestorNamed(state, pos, SETEXT_NAMES) !== null;
    if (!underline) {
      return { changes: { from: pos, insert: "\n" }, selection: { anchor: pos + 1 } };
    }
    return {
      changes: [
        { from: line.from, insert: "\n" },
        { from: pos, insert: "\n" },
      ],
      selection: { anchor: pos + 2 },
    };
  },
};

// ---------------------------------------------------------------------------
// 9 · Ctrl+B / Ctrl+I
// ---------------------------------------------------------------------------

/**
 * Wrap the selection in `**` / `*`, or unwrap it when the markers are already
 * there (outside the selection, or included in it). With an empty selection the
 * pair is inserted and the caret left between them.
 */
function wrapRule(marker: string): InputRule {
  return {
    id: "inlineWrap",
    trigger: `Mod-b / Mod-i wraps or unwraps the selection with ${marker}`,
    run({ state }) {
      const { from, to } = state.selection.main;
      const doc = state.doc;
      const outerFrom = from - marker.length;
      const outerTo = to + marker.length;
      if (
        outerFrom >= 0 &&
        outerTo <= doc.length &&
        state.sliceDoc(outerFrom, from) === marker &&
        state.sliceDoc(to, outerTo) === marker
      ) {
        return {
          changes: [
            { from: outerFrom, to: from },
            { from: to, to: outerTo },
          ],
          selection: { anchor: outerFrom, head: outerFrom + (to - from) },
        };
      }
      if (
        from < to &&
        state.sliceDoc(from, from + marker.length) === marker &&
        state.sliceDoc(to - marker.length, to) === marker
      ) {
        return {
          changes: [
            { from, to: from + marker.length },
            { from: to - marker.length, to },
          ],
          selection: { anchor: from, head: to - marker.length * 2 },
        };
      }
      if (from === to) {
        return {
          changes: { from, insert: marker + marker },
          selection: { anchor: from + marker.length },
        };
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        selection: { anchor: from + marker.length, head: to + marker.length },
      };
    },
  };
}

const wrapStrong = wrapRule("**");
const wrapEmphasis = wrapRule("*");

// ---------------------------------------------------------------------------
// 11 · 任务复选框
// ---------------------------------------------------------------------------

export interface TaskMarkerHit {
  /** `TaskMarker` range, brackets included. */
  from: number;
  to: number;
  checked: boolean;
}

/** The task checkbox at `pos`, or `null` when the position is not on one. */
export function taskMarkerAt(state: EditorState, pos: number): TaskMarkerHit | null {
  const marker = ancestorNamed(state, pos, TASK_MARKER_NAMES);
  if (!marker) return null;
  const text = state.sliceDoc(marker.from, marker.to);
  if (text.length < 3 || text[0] !== "[" || text[text.length - 1] !== "]") return null;
  return { from: marker.from, to: marker.to, checked: text[1] !== " " };
}

/** Flip `[ ]` ↔ `[x]` for the task at `pos`. */
export function taskToggleAt(state: EditorState, pos: number): TransactionSpec | null {
  const hit = taskMarkerAt(state, pos);
  if (!hit) return null;
  return { changes: { from: hit.from + 1, to: hit.from + 2, insert: hit.checked ? " " : "x" } };
}

const taskToggle: InputRule = {
  id: "taskToggle",
  trigger: "Click a task checkbox",
  run({ state, pos }) {
    return taskToggleAt(state, pos);
  },
};

// ---------------------------------------------------------------------------
// Registry and binding
// ---------------------------------------------------------------------------

/**
 * Every text rule by id. One id can hold several functions when one rule covers
 * several keys — `inlineWrap` is Mod-b and Mod-i — and a disabled id switches all
 * of them off together.
 */
export const INPUT_RULES: Readonly<Record<TextRuleId, readonly InputRule[]>> = {
  headingShortcut: [headingShortcut],
  quoteContinue: [quoteContinue],
  listContinue: [listContinue],
  listExit: [listExit],
  listIndent: [listIndent, listOutdent],
  fenceClose: [fenceClose],
  mathClose: [mathClose],
  hrBreak: [hrBreak],
  inlineWrap: [wrapStrong, wrapEmphasis],
  taskToggle: [taskToggle],
};

/** Order matters: the most specific context wins. */
const ENTER_RULES: readonly InputRule[] = [fenceClose, mathClose, hrBreak, listExit, listContinue, quoteContinue];

export interface InputRulesOptions {
  /** Rule ids switched off for this editor instance. */
  disabled?: readonly InputRuleId[];
  /** Where a pasted or dropped image goes. Rule 10 is inert without it. */
  insertImage?: (file: File) => void;
}

/**
 * All eleven rules as one extension: a keymap for the keystroke rules and DOM
 * handlers for the two that are not keystrokes (image paste/drop, checkbox click).
 * Mounted at `Prec.highest` so the language's own Enter keymap cannot run a second
 * continuation on top of ours.
 */
export function markdownInputRules(options: InputRulesOptions = {}): Extension {
  const off = new Set(options.disabled ?? []);
  const enabled = (id: InputRuleId): boolean => !off.has(id);

  const run = (view: EditorView, rule: InputRule): boolean => {
    if (!enabled(rule.id)) return false;
    const spec = rule.run(ruleContext(view.state));
    if (!spec) return false;
    view.dispatch(withRuleAnnotations(rule.id, spec));
    return true;
  };

  return [
    Prec.highest(
      keymap.of([
        {
          key: "Enter",
          run: (view) => {
            for (const rule of ENTER_RULES) if (run(view, rule)) return true;
            return false;
          },
        },
        { key: "Space", run: (view) => run(view, headingShortcut) },
        { key: "Tab", run: (view) => run(view, listIndent) },
        { key: "Shift-Tab", run: (view) => run(view, listOutdent) },
        { key: "Mod-b", run: (view) => run(view, wrapStrong) },
        { key: "Mod-i", run: (view) => run(view, wrapEmphasis) },
      ]),
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!enabled("taskToggle") || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const spec = taskToggleAt(view.state, pos);
        if (!spec) return false;
        // Clicking the box must not also drop the caret between the brackets.
        event.preventDefault();
        view.dispatch(withRuleAnnotations("taskToggle", { ...spec, scrollIntoView: true }));
        return true;
      },
    }),
    imageDropExtension(enabled, options.insertImage),
  ];
}

export function withRuleAnnotations(id: InputRuleId, spec: TransactionSpec): TransactionSpec {
  return { ...spec, annotations: [inputRuleSource.of(id), isolateHistory.of("full")] };
}

/**
 * Rule 10 is the event side only: deciding that a paste/drop carries an image.
 * The bytes go through the caller's existing attachment path (`insertImageBytes`
 * in `NoteEditor`), so no second directory rule exists.
 */
function imageDropExtension(enabled: (id: InputRuleId) => boolean, insertImage?: (file: File) => void): Extension {
  const pick = (files: FileList | null | undefined): File | null => {
    if (!files) return null;
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) return file;
    }
    return null;
  };
  const take = (event: ClipboardEvent | DragEvent, files: FileList | null | undefined): boolean => {
    if (!enabled("imageDrop") || !insertImage) return false;
    const file = pick(files);
    if (!file) return false;
    event.preventDefault();
    insertImage(file);
    return true;
  };

  return EditorView.domEventHandlers({
    paste(event) {
      return take(event, event.clipboardData?.files);
    },
    drop(event) {
      return take(event, event.dataTransfer?.files);
    },
    dragover(event) {
      if (!enabled("imageDrop") || !event.dataTransfer?.types.includes("Files")) return false;
      event.preventDefault();
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Tree and text helpers
// ---------------------------------------------------------------------------

const LIST_ITEM_NAMES = new Set(["ListItem"]);
const FENCE_NAMES = new Set(["FencedCode"]);
const TASK_MARKER_NAMES = new Set(["TaskMarker"]);
const SETEXT_NAMES = new Set(["SetextHeading1", "SetextHeading2"]);

/**
 * Nearest ancestor with one of `names`.
 *
 * `bias` decides which side wins when the caret sits exactly on a node edge:
 * `-1` is the node that *ends* here (Enter at the end of a list line), `+1` the
 * node that *starts* here (Tab at the beginning of an item). The other side is
 * tried before giving up, because a position on a boundary resolves outside both
 * nodes on the preferred side.
 */
function ancestorNamed(
  state: EditorState,
  pos: number,
  names: ReadonlySet<string>,
  bias: 1 | -1 = -1,
): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (const side of [bias, bias === 1 ? -1 : 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (names.has(node.name)) return node;
    }
  }
  return null;
}

function hasAncestor(state: EditorState, pos: number, name: string): boolean {
  return ancestorNamed(state, pos, new Set([name])) !== null;
}

/** `> `, `> > `, or `""` — the quote markers at the start of a line. */
function quotePrefixOf(text: string): string {
  return /^(?:[ \t]*>[ \t]?)+/.exec(text)?.[0] ?? "";
}

/** `- `, `1. `, `- [ ] ` — everything up to the caret that is only markup. */
function isEmptyItem(line: Line, before: string): boolean {
  const rest = line.text.slice(before.length);
  if (rest.trim() !== "") return false;
  return /^[ \t]*(?:> ?)*(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?[ \t]*$/.test(before);
}

function isTask(item: SyntaxNode): boolean {
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name === "Task") return true;
  }
  return false;
}

/** Next marker for a continued item: same bullet, or `n + 1` for ordered lists. */
function nextMarker(marker: string, task: boolean): string {
  const ordered = /^(\d+)([.)])$/.exec(marker);
  if (!ordered) return task ? `${marker} [ ]` : marker;
  return `${Number(ordered[1]) + 1}${ordered[2]}`;
}

function hasClosingFence(fence: SyntaxNode): boolean {
  const last = fence.lastChild;
  return Boolean(last && last.name === "CodeMark" && last.from > fence.from);
}

function insideMathBlock(state: EditorState, from: number): boolean {
  // Bounded look-back: a full-document scan on every Enter is not worth it.
  const start = Math.max(0, from - 4000);
  const lines = state.sliceDoc(start, from).split("\n");
  lines.pop(); // the current line's own prefix
  let count = 0;
  for (const line of lines) if (line.trim() === "$$") count += 1;
  return count % 2 === 1;
}

function isRuleLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const char = trimmed[0];
  if (char !== "-" && char !== "*" && char !== "_") return false;
  for (let index = 1; index < trimmed.length; index += 1) {
    if (trimmed[index] !== char) return false;
  }
  return true;
}

/** Indent or outdent every line of the item by one document unit. */
function indentItem(state: EditorState, item: SyntaxNode, direction: 1 | -1): TransactionSpec | null {
  const doc = state.doc;
  const firstLine = doc.lineAt(item.from);
  const lastLine = doc.lineAt(Math.max(item.from, item.to - 1));
  const leading = /^[ \t]*/.exec(firstLine.text)?.[0] ?? "";

  if (direction === -1 && leading.length === 0) return null;
  const unit = direction === 1 ? documentIndentUnit(state, leading) : leading;

  const changes: { from: number; to?: number; insert?: string }[] = [];
  for (let number = firstLine.number; number <= lastLine.number; number += 1) {
    const line = doc.line(number);
    if (line.length === 0) continue;
    if (direction === 1) {
      changes.push({ from: line.from, insert: unit });
      continue;
    }
    const own = /^[ \t]*/.exec(line.text)?.[0] ?? "";
    if (own.length === 0) continue;
    changes.push({ from: line.from, to: line.from + outdentWidth(own, unit) });
  }
  if (changes.length === 0) return null;
  // Keep the caret *after* the unit it just added (and after the removed one when
  // outdenting): mapping with assoc 1, because a Tab pressed at column 0 would
  // otherwise leave the caret in front of the indentation it created.
  const mapped = ChangeSet.of(changes, doc.length).mapPos(state.selection.main.head, 1);
  return { changes, selection: { anchor: mapped } };
}

/**
 * Tab vs spaces, and how many: the item's own indent decides, then the first
 * indented list line in the document, then two spaces. Mixing is the thing to
 * avoid — a tab inside a space-indented list turns the item into a code block.
 */
function documentIndentUnit(state: EditorState, ownLeading: string): string {
  if (ownLeading.startsWith("\t")) return "\t";
  if (ownLeading.startsWith(" ")) return " ".repeat(Math.min(Math.max(ownLeading.length, 2), 4));

  const doc = state.doc;
  const limit = Math.min(doc.lines, 300);
  for (let number = 1; number <= limit; number += 1) {
    const match = /^([ \t]+)(?=(?:[-*+]|\d+[.)])[ \t])/.exec(doc.line(number).text);
    if (!match) continue;
    return match[1].startsWith("\t") ? "\t" : " ".repeat(Math.min(match[1].length, 4));
  }
  return "  ";
}

/** How many characters of `own` one outdent removes. */
function outdentWidth(own: string, unit: string): number {
  if (own.startsWith("\t") || unit.startsWith("\t")) return 1;
  return Math.min(Math.max(unit.length, 2), own.length);
}
