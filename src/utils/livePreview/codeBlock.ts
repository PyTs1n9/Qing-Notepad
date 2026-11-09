import { Prec, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { blockAtPosition } from "../editorBlocks";

/**
 * Code-block interactions (L2): what Ctrl+A selects inside a block, and turning a
 * pasted run of code into a fenced block instead of a paragraph.
 *
 * Both are deliberately *document* operations, not decoration-layer ones: they
 * have to behave the same in 源码 view, where no live-preview layer is mounted.
 * The visual side (the bordered card) stays in `decorations.ts` + `index.css`.
 *
 * Nothing here writes to the document on its own behalf — every function returns
 * a `TransactionSpec` (or `null` to decline), which is also what makes both
 * behaviours testable headlessly: `scripts/verify-code-block.mjs` applies the
 * specs to a plain `EditorState`, no view, no key event.
 */

/** A code block, with the range a reader thinks of as its content. */
export interface CodeBlockRange {
  /** Whole node: opening fence line through closing fence line (or the whole
   *  indented block). */
  from: number;
  to: number;
  /** The code text only — fences and the info string excluded. */
  contentFrom: number;
  contentTo: number;
}

/**
 * The fenced (or indented) code block containing `pos`, or `null`.
 *
 * Same edge rule as `blockAtPosition`: a caret sits *between* characters, so
 * both biases are tried — forward finds a block that starts at `pos`, backward
 * one that ends there.
 */
export function codeBlockAt(state: EditorState, pos: number): CodeBlockRange | null {
  const node = codeNodeAt(state, pos);
  if (!node) return null;
  if (node.name === "CodeBlock") {
    // Indented code has no fence and no info string, so — unlike a fence — all of
    // it is content. "Content" here still means the code text inside the block,
    // not the whole node: the node spans the four-space indent, and the parser
    // splits the body into one `CodeText` per line, so the content is the first
    // run's start through the last run's end (`"    indented\n    code\n"` yields
    // two runs, 4-13 and 17-21). No runs at all → fall back to the node.
    let textFrom = -1;
    let textTo = -1;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== "CodeText" || child.to <= child.from) continue;
      if (textFrom < 0) textFrom = child.from;
      textTo = child.to;
    }
    if (textFrom < 0) {
      return { from: node.from, to: node.to, contentFrom: node.from, contentTo: node.to };
    }
    return { from: node.from, to: node.to, contentFrom: textFrom, contentTo: textTo };
  }

  let text: SyntaxNode | null = null;
  let last: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText" && child.to > child.from) text = child;
    last = child;
  }
  if (text) {
    // An *unclosed* fence runs to the end of the document, so its `CodeText`
    // carries the document's final newline while a closed fence's does not.
    // Dropping it keeps "the code text" the same shape in both cases — otherwise
    // Ctrl+A would select a trailing empty line only when the user had not typed
    // the closing fence yet.
    let contentTo = text.to;
    while (contentTo > text.from && state.sliceDoc(contentTo - 1, contentTo) === "\n") contentTo -= 1;
    return { from: node.from, to: node.to, contentFrom: text.from, contentTo };
  }

  // Empty body: a closed fence with nothing (or only blanks) between its marks.
  // Derive the gap from the lines instead of from a `CodeText` node, which the
  // parser omits entirely in that case.
  const doc = state.doc;
  const contentFrom = Math.min(doc.lineAt(node.from).to + 1, doc.length);
  const closed = Boolean(last && last.name === "CodeMark" && last.from > node.from);
  const contentTo = closed ? Math.max(contentFrom, doc.lineAt(last!.from).from - 1) : node.to;
  return { from: node.from, to: node.to, contentFrom, contentTo };
}

/**
 * Ctrl+A inside a code block, one stage at a time:
 *
 * 1. first press selects the block's code text (fences and language excluded);
 * 2. second press — the selection already *is* the content — returns `null`, so
 *    the default `selectAll` binding selects the whole document.
 *
 * The second stage is not a nicety: without it a caret parked in a block could
 * never reach the rest of the note, which is a trap, not a feature. An empty
 * block also falls through for the same reason — there is nothing to select, and
 * swallowing the key would leave the user stuck.
 */
export function codeBlockSelectSpec(state: EditorState): TransactionSpec | null {
  const { from, to, head } = state.selection.main;
  const block = codeBlockAt(state, head);
  if (!block) return null;
  // A selection that reaches outside the block is the user's own range; leave it
  // (and the default binding) alone.
  if (from < block.from || to > block.to) return null;
  if (block.contentTo <= block.contentFrom) return null;
  // A blank body has nothing to select, and selecting it is worse than useless:
  // `"```\n\n```\n"` exposes one bare newline, so typing right after Ctrl+A
  // gives `"```\nX```\n"` — the closing fence welds onto the code line, the
  // block is no longer closed, and every following line parses as code.
  if (state.sliceDoc(block.contentFrom, block.contentTo).trim() === "") return null;
  // The second press: the selection already *is* the content, so decline and let
  // `selectAll` take the whole document. Intentional — do not "optimise" this
  // into returning the content range again, that would trap the caret in the
  // block with no way to select the rest of the note.
  if (from === block.contentFrom && to === block.contentTo) return null;
  return { selection: { anchor: block.contentFrom, head: block.contentTo } };
}

/**
 * Paste of a code-looking run → one fenced block.
 *
 * Declines (`null`) — which means the editor's normal paste runs — when the text
 * is not code-shaped, when the caret is already inside a code block (there the
 * plain insert *is* the right behaviour), when the host block is not a
 * top-level paragraph, or when a non-empty selection spans more than one block.
 * Fencing inside a list item, quote, table or heading would either break that
 * container or end up as its literal text.
 */
export function codeBlockPasteSpec(state: EditorState, text: string): TransactionSpec | null {
  const code = normalizeCode(text);
  if (!looksLikeCode(code)) return null;

  const { from: selectedFrom, to: selectedTo } = state.selection.main;
  if (codeBlockAt(state, selectedFrom)) return null;
  if (selectedTo > selectedFrom && codeBlockAt(state, selectedTo)) return null;

  const host = blockAtPosition(state, selectedFrom);
  if (host && host.kind !== "paragraph") return null;
  // A non-empty selection must live inside a *single* paragraph. Replacing a
  // range that crosses a blank line would swallow the structure between the two
  // paragraphs — text the user never selected — and swap it for one fence.
  if (selectedTo > selectedFrom) {
    const endHost = blockAtPosition(state, selectedTo);
    if (
      !host ||
      !endHost ||
      host.kind !== "paragraph" ||
      endHost.kind !== "paragraph" ||
      host.from !== endHost.from ||
      host.to !== endHost.to
    ) {
      return null;
    }
  }

  const startLine = state.doc.lineAt(selectedFrom);
  const endLine = state.doc.lineAt(selectedTo);
  const before = state.sliceDoc(startLine.from, selectedFrom);
  const after = state.sliceDoc(selectedTo, endLine.to);

  // A fence has to begin at a line start. A caret after real text opens a blank
  // line first; a caret in whitespace-only indentation starts at the line start
  // and lets the fence replace that indentation.
  const changeFrom = before.trim() === "" ? startLine.from : selectedFrom;
  const lead = changeFrom === startLine.from ? "" : "\n\n";
  const trail = after.trim() === "" ? "" : "\n\n";

  const fence = fenceFor(code);
  const insert = `${lead}${fence}\n${code}\n${fence}${trail}`;
  // End of the pasted code: the user continues typing where they stopped reading.
  // The language is deliberately *not* inferred; it is typed on the fence line,
  // which the live preview keeps visible.
  const caret = changeFrom + lead.length + fence.length + 1 + code.length;

  return {
    changes: { from: changeFrom, to: selectedTo, insert },
    selection: { anchor: caret },
    scrollIntoView: true,
    userEvent: "input.paste",
  };
}

/**
 * Whether a pasted block reads as code rather than prose or Markdown.
 *
 * Scoring, not a single regex: pasted text is either obviously code (braces,
 * indentation, keywords) or obviously not (a Markdown list, a Chinese paragraph),
 * and every single-signal rule either wraps Markdown lists or refuses real
 * snippets. Positive signals add, Markdown/prose signals subtract; `3` is the
 * threshold. `scripts/verify-code-block.mjs` pins each case below.
 */
export function looksLikeCode(text: string): boolean {
  const lines = text.split("\n");
  const body = lines.filter((line) => line.trim() !== "");
  // "A large run of code": three lines at least, and at least two with content —
  // `a\n\n\nb` is not a snippet.
  if (lines.length < 3 || body.length < 2) return false;
  // Already a fenced block: nesting one inside another is never what was meant.
  if (/^[ \t]{0,3}(?:```|~~~)/m.test(text)) return false;

  let score = 0;
  if (body.some((line) => /^(?:\t| {2,})\S/.test(line))) score += 2;
  if (body.some((line) => /[;{}()[\]\]:,]$/.test(line.trim()))) score += 1;
  if (/\{[^}]*\}|\([^)]*\)|\[[^\]]*\]/.test(text)) score += 1;
  if (/\/\/|\/\*|\*\/|<!--|-->|#include|#define|#!/.test(text)) score += 2;
  // Counted per line, capped at 3: three statement-shaped lines are far stronger
  // evidence than one — a bare multi-line SQL query used to land exactly one
  // point below the threshold — while past three the extra lines say nothing
  // new. The tiers live above; a flat "any keyword present" score is what let
  // three lines of English prose become a code block.
  let keywordLines = 0;
  for (const line of body) {
    if (SQL_KEYWORD.test(line) || CODE_KEYWORD.test(line)) keywordLines += 1;
    else if (AMBIGUOUS_KEYWORD.test(line) && (CODE_SHAPE.test(line) || /^[ \t]/.test(line))) keywordLines += 1;
  }
  score += Math.min(keywordLines, 3);
  if (/=>|->|===?|!==?|&&|\|\||\+=|-=|\*=|\/=|::|\+\+|--/.test(text)) score += 1;
  if (HTML_TAG.test(text)) score += 2;
  if (jsonShaped(body)) score += 2;
  if (body.some((line) => SHELL_COMMAND.test(line))) score += 2;
  if (/(?:^|\s)--?[A-Za-z][\w-]*/.test(text)) score += 1;

  if (body.some((line) => MARKDOWN_BLOCK_LINE.test(line))) score -= 3;
  if (chineseProseRatio(body) > 0.4) score -= 2;

  return score >= 3;
}

/**
 * One keymap and one paste handler, at `Prec.highest`:
 * `basicSetup` already binds `Mod-a` to `selectAll`, and the editor's own paste
 * handling would otherwise consume the event before this handler sees it.
 */
export function codeBlockInteractions(): Extension {
  return [
    Prec.highest(keymap.of([{ key: "Mod-a", run: selectCodeBlockContent }])),
    Prec.highest(
      EditorView.domEventHandlers({
        paste(event, view) {
          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;
          const spec = codeBlockPasteSpec(view.state, text);
          if (!spec) return false;
          event.preventDefault();
          view.dispatch(spec);
          return true;
        },
      }),
    ),
  ];
}

function selectCodeBlockContent(view: EditorView): boolean {
  const spec = codeBlockSelectSpec(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

function codeNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = syntaxTree(state);
  const clamped = Math.max(0, Math.min(pos, state.doc.length));
  for (const bias of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(clamped, bias); node; node = node.parent) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") return node;
    }
  }
  return null;
}

/** CRLF → LF, surrounding blank lines dropped: the fence owns the line breaks. */
function normalizeCode(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");
}

/**
 * A fence longer than any backtick run inside the code, so a pasted snippet that
 * itself contains ```` ``` ```` still closes where it should.
 */
function fenceFor(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Keyword evidence is graded in three tiers, because "starts with a keyword" says
 * very different things depending on the keyword:
 *
 * 1. `SQL_KEYWORD` — upper-case SQL. Prose does not shout `SELECT` / `FROM`, and
 *    a query line like `FROM notes` has no punctuation and no indent to point at,
 *    so upper case alone is the evidence.
 * 2. `CODE_KEYWORD` — words that essentially never appear in prose (`import`,
 *    `def`, `const`…), plus the modifier run in front of them (`public static
 *    void`, `async function`). Unconditional: a plain `import os` run must not be
 *    refused just because it has no brackets.
 * 3. `AMBIGUOUS_KEYWORD` — ordinary English sentence openers. `if you read the
 *    docs` and `if x > 0:` begin identically, so the keyword alone proves nothing:
 *    what separates them is whether *the line* has a code shape — a bracket,
 *    brace, semicolon, equals, or an indent.
 */
const SQL_KEYWORD =
  /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|JOIN|GROUP|ORDER)\b/;

const CODE_KEYWORD =
  /^\s*(?:(?:export|public|private|protected|static|final|async|await)\s+)*(?:import|def|function|func|const|let|var|export|interface|enum|struct|namespace|package|using|elif|throw)\b/;

const AMBIGUOUS_KEYWORD =
  /^\s*(?:if|else|for|while|switch|case|try|catch|finally|return|new|type|class|from)\b/;

/** What "has a code shape" means for a high-ambiguity keyword line. */
const CODE_SHAPE = /[={}\[\]();]/;

const SHELL_COMMAND =
  /^\s*(?:\$|>)?\s*(?:cd|ls|dir|rm|cp|mv|mkdir|rmdir|cat|echo|git|npm|pnpm|yarn|npx|node|deno|python|pip|docker|curl|wget|ssh|scp|systemctl|sudo|apt|brew|chmod|chown|make|cmake|cargo|go|java|dotnet|kubectl|terraform)\b/;

const HTML_TAG = /<[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\/?>/;

/** A line that Markdown would read as a block marker, not as code. */
const MARKDOWN_BLOCK_LINE = /^ {0,3}(?:#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|\|)/;

function jsonShaped(body: readonly string[]): boolean {
  const first = body[0]?.trim() ?? "";
  const last = body[body.length - 1]?.trim() ?? "";
  return /^[{[]/.test(first) && /[}\]]$/.test(last);
}

/** Share of non-empty lines that end like a Chinese sentence. */
function chineseProseRatio(body: readonly string[]): number {
  if (body.length === 0) return 0;
  const prose = body.filter((line) => /[。！？；，]$/.test(line.trim())).length;
  return prose / body.length;
}
