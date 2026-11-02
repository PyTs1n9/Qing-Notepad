import type { EditorState } from "@codemirror/state";
import { blockAtPosition } from "../editorBlocks";

/**
 * Cross-block deletion semantics (M5).
 *
 * This module is a definition, not an interceptor. Marktext's four bugs (#5423,
 * #5400, #5389, #5385) all come from a block model that owns the document: a
 * delete is computed on the block tree, so the tree can move text the user did
 * not select. This editor has no such model — the document is the text, blocks
 * are a read-only derivation — so the behaviour below is what CodeMirror's own
 * character commands already do. What this file adds is the definition those
 * commands are held to, and the classification the tests assert against.
 *
 * Three cases, each defined in terms of characters:
 *
 * (a) Backspace at a block start — the caret is on the first character of a
 *     block that is not the document's first block. The character before it is
 *     the line break that ends the previous block, so Backspace deletes that one
 *     break and the two blocks become one. Nothing else moves: the block's own
 *     marker characters stay as literal text (`- 项` becomes part of the joined
 *     line), and the previous block is never re-parsed into something new before
 *     the delete happens.
 *
 * (b) Delete at a block end — the caret is right after the last character of a
 *     block that is not the last block. The next character is the break that
 *     starts the following block, so Delete removes that break: the following
 *     block's first line is appended to this one, and its marker text (`> `,
 *     `- `, `# `) survives as ordinary characters. This is exactly where #5423
 *     fails: the block model pulls the quote out of the quote instead of
 *     appending text.
 *
 * (c) A selection spanning two or more blocks — the selection is deleted as one
 *     run of characters, from `from` to `to`, and nothing else. #5385 is the
 *     block-model version of this: the selection is re-normalised to block
 *     boundaries and the tail of the last block is left behind selected. Here
 *     the only text removed is the text that was selected.
 *
 * Outside those three cases the editor deletes one character (or one selected
 * run) like any text editor; a delete never re-numbers a list, never lifts an
 * item out of a quote and never merges two blocks "intelligently".
 *
 * What is kept from the language package: `deleteMarkupBackward` still runs
 * first on Backspace, so pressing it right after a `- ` / `> ` / `## ` marker
 * removes that markup instead of a visible character. That is in-block markup
 * deletion — it never reads across a block boundary, never removes content, and
 * is one undo step. It is not one of the three cases above.
 */

export type BlockDeleteCase =
  /** (a) caret on a block's first character, block is not first in the document. */
  | "block-start-backspace"
  /** (b) caret right after a block's last character, block is not last. */
  | "block-end-delete"
  /** (c) selection whose two ends live in different blocks. */
  | "cross-block-selection"
  /** Selection inside one block; a plain run of characters. */
  | "selection-in-block"
  /** Ordinary character delete inside one block. */
  | "character";

export type DeleteDirection = "backward" | "forward";

/**
 * Which of the defined cases a keypress at the current selection falls into.
 * The tests use it to make sure every fixture actually exercises the case it
 * claims to, instead of quietly testing an ordinary character delete.
 */
export function classifyBlockDelete(state: EditorState, direction: DeleteDirection): BlockDeleteCase {
  const selection = state.selection.main;
  if (!selection.empty) {
    const start = blockAtPosition(state, selection.from);
    const end = blockAtPosition(state, selection.to);
    if (start && end && (start.from !== end.from || start.to !== end.to)) return "cross-block-selection";
    return "selection-in-block";
  }

  const block = blockAtPosition(state, selection.head);
  if (!block) return "character";
  if (direction === "backward" && selection.head === block.from && block.from > 0) return "block-start-backspace";
  if (direction === "forward" && selection.head === block.to && block.to < state.doc.length) return "block-end-delete";
  return "character";
}
