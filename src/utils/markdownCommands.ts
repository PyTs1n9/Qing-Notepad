import { Annotation, type EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

/**
 * Markdown command layer.
 *
 * Every command is a plain function `(state) => TransactionSpec | null`:
 * - no `EditorView`, so the whole layer can be asserted in Node without a DOM
 *   (`scripts/verify-markdown-commands.mjs`);
 * - `null` means "nothing to do" — the caller decides whether that is a no-op
 *   or a disabled menu item, this module never guesses;
 * - one command = one transaction, carrying `isolateHistory.of("full")` so a
 *   single Ctrl+Z undoes the whole conversion instead of half of it.
 *
 * These are *structural* commands (headings, lists, quotes, fences): they edit
 * line prefixes only, never the user's prose. Wrapping commands (`inlineWrap`,
 * `insertLink`) preserve the selected text as the body.
 */

export type MarkdownCommandId =
  | "setHeading"
  | "toggleQuote"
  | "toggleList"
  | "insertCodeBlock"
  | "insertHorizontalRule"
  | "insertLink"
  | "inlineWrap"
  | "insertParagraph"
  | "insertTable";

/** Which command produced a transaction. */
export const markdownCommandSource = Annotation.define<MarkdownCommandId>();

export type ListKind = "bullet" | "ordered" | "task";
export type ParagraphPosition = "above" | "below";

interface LineInfo {
  /** 1-based document line number. */
  number: number;
  from: number;
  to: number;
  text: string;
}

interface PrefixChange {
  from: number;
  to: number;
  insert: string;
}

/** Every line touched by the main selection, in document order. */
function selectedLines(state: EditorState): LineInfo[] {
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const lines: LineInfo[] = [];
  for (let number = first; number <= last; number += 1) {
    const line = doc.line(number);
    lines.push({ number, from: line.from, to: line.to, text: line.text });
  }
  return lines;
}

/**
 * Lines a structural command may rewrite. A multi-line selection skips blank
 * lines: turning a deliberate gap into an empty heading or an empty bullet is
 * never what the user meant. A collapsed caret on a blank line is kept, because
 * that is exactly how an empty heading is typed.
 */
function editableLines(lines: LineInfo[]): LineInfo[] {
  if (lines.length === 1) return lines;
  return lines.filter((line) => line.text.trim() !== "");
}

function commandSpec(id: MarkdownCommandId, spec: TransactionSpec): TransactionSpec {
  return {
    ...spec,
    annotations: [markdownCommandSource.of(id), isolateHistory.of("full")],
  };
}

/**
 * Where a collapsed caret lands after a set of prefix edits.
 *
 * Prefix edits are whole-line, so the generic mapping would park the caret
 * before the marker that was just inserted (`|# 标题`). Applying the same delta
 * to the caret keeps it with the text it was sitting in, and a caret inside a
 * replaced marker snaps to the end of the new one.
 */
function caretThroughChanges(head: number, changes: readonly PrefixChange[]): number {
  let shift = 0;
  for (const change of changes) {
    const delta = change.insert.length - (change.to - change.from);
    if (change.to <= head) {
      shift += delta;
      continue;
    }
    if (change.from <= head) return change.from + shift + change.insert.length;
  }
  return head + shift;
}

/** Shared tail of the three prefix commands. */
function prefixSpec(
  id: MarkdownCommandId,
  state: EditorState,
  changes: PrefixChange[],
): TransactionSpec | null {
  const effective = changes.filter(
    (change) => state.sliceDoc(change.from, change.to) !== change.insert,
  );
  if (effective.length === 0) return null;

  const spec: TransactionSpec = { changes: effective, scrollIntoView: true };
  const selection = state.selection.main;
  if (selection.empty) {
    spec.selection = { anchor: caretThroughChanges(selection.head, effective) };
  }
  return commandSpec(id, spec);
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/**
 * ATX heading prefix. The trailing space is required: `#标题` is a paragraph in
 * CommonMark, so it must be treated as plain text and prefixed rather than
 * rewritten in place (otherwise the `#` silently disappears).
 */
const HEADING_PREFIX = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;

function headingLevel(text: string): number {
  const match = HEADING_PREFIX.exec(text);
  return match ? match[2].length : 0;
}

/** Offset of the first content character, i.e. the end of an existing marker. */
function headingContentOffset(text: string): number {
  const match = HEADING_PREFIX.exec(text);
  return match ? match[0].length : 0;
}

/**
 * Set the heading level of every selected line, or clear it with `level = 0`.
 *
 * Toggle semantics: applying the level a line already has turns it back into a
 * paragraph, which is how Typora's Ctrl+1..6 behave and what makes the command
 * usable twice without undoing.
 */
export function setHeading(state: EditorState, level: number): TransactionSpec | null {
  const target = Math.max(0, Math.min(6, Math.trunc(level)));
  const lines = editableLines(selectedLines(state));
  if (lines.length === 0) return null;

  // Only a real level can be toggled off. `Ctrl+0` on a paragraph is a no-op.
  const alreadyEverywhere =
    target > 0 && lines.every((line) => headingLevel(line.text) === target);
  const effective = alreadyEverywhere ? 0 : target;
  const marker = effective === 0 ? "" : `${"#".repeat(effective)} `;

  const changes = lines.map((line) => {
    const contentOffset = headingContentOffset(line.text);
    // Applying a level to an indented paragraph consumes the indent too:
    // `  ## 正文` is valid CommonMark but reads as a mistake in source mode.
    // Clearing a level (marker === "") must not touch indentation of a line that
    // never was a heading.
    const to =
      marker === "" || contentOffset > 0
        ? line.from + contentOffset
        : line.from + /^\s*/.exec(line.text)![0].length;
    return { from: line.from, to, insert: marker };
  });
  return prefixSpec("setHeading", state, changes);
}

// ---------------------------------------------------------------------------
// Blockquote
// ---------------------------------------------------------------------------

const QUOTE_ANY = /^\s*>/;
/** One level of quote marker, with the space that usually follows it. */
const QUOTE_LEVEL = /^(\s*)> ?/;

export function toggleQuote(state: EditorState): TransactionSpec | null {
  const lines = editableLines(selectedLines(state));
  if (lines.length === 0) return null;

  const remove = lines.every((line) => QUOTE_ANY.test(line.text));
  const changes: PrefixChange[] = [];
  for (const line of lines) {
    if (!remove) {
      changes.push({ from: line.from, to: line.from, insert: "> " });
      continue;
    }
    const match = QUOTE_LEVEL.exec(line.text);
    if (!match) continue;
    changes.push({
      from: line.from,
      to: line.from + match[0].length,
      insert: match[1],
    });
  }
  return prefixSpec("toggleQuote", state, changes);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * `bullet` carries a negative lookahead so a task line (`- [ ] x`) does not
 * count as "already a bullet": toggling an unordered list on it has to convert
 * it, not strip its marker.
 */
const LIST_PREFIX: Record<ListKind, RegExp> = {
  bullet: /^(\s*)([-*+])\s+(?!\[[ xX]\]\s)/,
  ordered: /^(\s*)(\d+[.)])\s+/,
  task: /^(\s*)([-*+])\s+\[[ xX]\]\s+/,
};

/** Any list marker, used only to find where the content starts. */
const ANY_LIST_PREFIX = /^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

function listMarker(kind: ListKind, index: number): string {
  if (kind === "ordered") return `${index + 1}. `;
  if (kind === "task") return "- [ ] ";
  return "- ";
}

export function toggleList(state: EditorState, kind: ListKind): TransactionSpec | null {
  const lines = editableLines(selectedLines(state));
  if (lines.length === 0) return null;

  const pattern = LIST_PREFIX[kind];
  const remove = lines.every((line) => pattern.test(line.text));

  const changes = lines.map((line, index) => {
    const match = ANY_LIST_PREFIX.exec(line.text);
    const indent = match ? match[1] : /^(\s*)/.exec(line.text)![1];
    const from = line.from + indent.length;
    const to = match ? line.from + match[0].length : from;
    return { from, to, insert: remove ? "" : listMarker(kind, index) };
  });
  return prefixSpec("toggleList", state, changes);
}

// ---------------------------------------------------------------------------
// Fenced code block
// ---------------------------------------------------------------------------

export function insertCodeBlock(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);

  if (from !== to) {
    // A selection that owns its whole lines can be fenced in place. A mid-line
    // start or end needs a newline on that side, otherwise the fence shares a
    // line with the prose and stops being a fence (````续行` closes nothing).
    const prefix = from === startLine.from ? "" : "\n";
    const suffix = to === state.doc.lineAt(to).to ? "" : "\n";
    const body = state.sliceDoc(from, to);
    const snippet = `${prefix}\`\`\`\n${body}\n\`\`\`${suffix}`;
    return commandSpec("insertCodeBlock", {
      changes: { from, to, insert: snippet },
      selection: { anchor: from + snippet.length },
      scrollIntoView: true,
    });
  }

  // Caret: the block goes *after* the caret's line, never in the middle of it.
  // Inserting at the caret would leave the rest of the line glued to the closing
  // fence. Only a caret on an empty line can host the fence where it stands.
  const onEmptyLine = startLine.text.trim() === "" && from === startLine.from;
  const at = onEmptyLine ? from : startLine.to;
  const prefix = onEmptyLine ? "" : "\n";
  const snippet = `${prefix}\`\`\`\n\n\`\`\``;
  return commandSpec("insertCodeBlock", {
    changes: { from: at, insert: snippet },
    // Inside the empty body line: start of the blank line between the fences.
    selection: { anchor: at + prefix.length + 4 },
    scrollIntoView: true,
  });
}

// ---------------------------------------------------------------------------
// Horizontal rule
// ---------------------------------------------------------------------------

/**
 * A `---` line directly under a paragraph is a Setext underline, not a rule, so
 * a non-empty line needs a blank line above it. On an empty line one newline
 * already separates them.
 */
export function insertHorizontalRule(state: EditorState): TransactionSpec | null {
  const { to } = state.selection.main;
  const line = state.doc.lineAt(to);
  const empty = line.text.trim() === "";
  const prefix = empty ? (to === line.from ? "" : "\n") : "\n\n";
  const snippet = `${prefix}---\n`;
  return commandSpec("insertHorizontalRule", {
    changes: { from: to, insert: snippet },
    selection: { anchor: to + snippet.length },
    scrollIntoView: true,
  });
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

/**
 * Selection → `[text](url)` with `url` selected, so typing replaces the
 * placeholder instead of appending to it. Empty selection → `[]()` with the
 * caret between the brackets: the label is what a user has to think about first.
 */
export function insertLink(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main;
  if (from === to) {
    return commandSpec("insertLink", {
      changes: { from, insert: "[]()" },
      selection: { anchor: from + 1 },
      scrollIntoView: true,
    });
  }
  const text = state.sliceDoc(from, to);
  const snippet = `[${text}](url)`;
  return commandSpec("insertLink", {
    changes: { from, to, insert: snippet },
    // Select the `url` placeholder.
    selection: { anchor: from + text.length + 3, head: from + text.length + 6 },
    scrollIntoView: true,
  });
}

// ---------------------------------------------------------------------------
// Inline wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap the selection in `marker`, or unwrap it when the markers are already
 * there — outside the selection (`**|text|**`) or included in it
 * (`|**text**|`). A collapsed caret gets an empty pair and sits between them.
 *
 * This is the single implementation: `livePreview/inputRules.ts` binds its
 * Ctrl+B / Ctrl+I rules to this function so the keyboard path and the menu path
 * cannot drift apart.
 */
export function inlineWrap(state: EditorState, marker: string): TransactionSpec | null {
  if (!marker) return null;
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const outerFrom = from - marker.length;
  const outerTo = to + marker.length;

  // Markers just outside the selection.
  if (
    outerFrom >= 0 &&
    outerTo <= doc.length &&
    state.sliceDoc(outerFrom, from) === marker &&
    state.sliceDoc(to, outerTo) === marker
  ) {
    return commandSpec("inlineWrap", {
      changes: [
        { from: outerFrom, to: from },
        { from: to, to: outerTo },
      ],
      selection: { anchor: outerFrom, head: outerFrom + (to - from) },
    });
  }

  // Markers inside the selection.
  if (
    from < to &&
    state.sliceDoc(from, from + marker.length) === marker &&
    state.sliceDoc(to - marker.length, to) === marker
  ) {
    return commandSpec("inlineWrap", {
      changes: [
        { from, to: from + marker.length },
        { from: to - marker.length, to },
      ],
      selection: { anchor: from, head: to - marker.length * 2 },
    });
  }

  if (from === to) {
    return commandSpec("inlineWrap", {
      changes: { from, insert: marker + marker },
      selection: { anchor: from + marker.length },
    });
  }

  return commandSpec("inlineWrap", {
    changes: [
      { from, insert: marker },
      { from: to, insert: marker },
    ],
    selection: { anchor: from + marker.length, head: to + marker.length },
  });
}

// ---------------------------------------------------------------------------
// Paragraph insertion
// ---------------------------------------------------------------------------

/** Open a blank line above or below the caret's line and move the caret into it. */
export function insertParagraph(state: EditorState, where: ParagraphPosition): TransactionSpec | null {
  const { head } = state.selection.main;
  const line = state.doc.lineAt(head);
  if (where === "above") {
    return commandSpec("insertParagraph", {
      changes: { from: line.from, insert: "\n" },
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
  }
  return commandSpec("insertParagraph", {
    changes: { from: line.to, insert: "\n" },
    selection: { anchor: line.to + 1 },
    scrollIntoView: true,
  });
}

// ---------------------------------------------------------------------------
// Table insertion
// ---------------------------------------------------------------------------

/**
 * Empty 3x3 GFM table, used by the toolbar button and `Mod-Alt-t`.
 *
 * Two spaces between pipes keep every cell valid the moment the user types into
 * it; one space would let `|a|` collapse into a paragraph on the next parse.
 */
export const TABLE_MARKDOWN = "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n";

/** Offset of the first header cell's text, so the caret lands inside it. */
const TABLE_FIRST_CELL_OFFSET = 2;

/**
 * Insert the table skeleton at the caret.
 *
 * A table has to start on its own line, otherwise the paragraph above swallows
 * it and nothing renders as a table — hence the optional leading newline.
 */
export function insertTable(state: EditorState): TransactionSpec {
  const { from, to } = state.selection.main;
  const prefix = from > 0 && state.sliceDoc(from - 1, from) !== "\n" ? "\n" : "";
  return commandSpec("insertTable", {
    changes: { from, to, insert: `${prefix}${TABLE_MARKDOWN}` },
    selection: { anchor: from + prefix.length + TABLE_FIRST_CELL_OFFSET },
    scrollIntoView: true,
  });
}
