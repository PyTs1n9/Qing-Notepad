/**
 * Statistics for the editor's bottom status bar.
 *
 * Counting the raw source is the easy version and the wrong one: a heading's
 * `###`, a link's URL and a table's pipe characters are not glyphs a reader
 * ever sees. Every number here is therefore derived from the *visible* text, so
 * all four describe the same document the preview renders.
 */

export interface MarkdownStats {
  /** 行数：按换行符切分；空文档记 0，编辑器里那一行空行不算。 */
  lines: number;
  /** 词数：西文单词与数字串。CJK 不在此列，它们进「字数」。 */
  words: number;
  /** 字数：CJK 汉字个数。 */
  cjk: number;
  /** 字符数：去标记后的可见字符，含空格、不含换行。 */
  chars: number;
}

const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
/** `don't` / `state-of-the-art` stay one word; a bare hyphen does not join. */
const WORD_PATTERN = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

/** A fence opens with ``` or ~~~ (three or more); the first char identifies it. */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S+.*$/;
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** `| --- | :---: |` — a table's separator row is pure syntax. */
const TABLE_DELIMITER = /^\s*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/;
const ATX_HEADING = /^\s{0,3}#{1,6}[ \t]+/;
const BLOCK_QUOTE = /^\s{0,3}(?:>[ \t]?)+/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const TASK_CHECKBOX = /^\[[ xX]\][ \t]+/;

/**
 * Remove inline Markdown syntax while keeping the words it wraps.
 *
 * Order matters: images go before links (an image is a link with `!`), and the
 * fenced/inline code spans are unwrapped before emphasis runs, so `*a*` inside
 * backticks is not treated as emphasis.
 */
export function stripInlineMarkdown(text: string): string {
  return (
    text
      // HTML comments never render.
      .replace(/<!--[\s\S]*?-->/g, "")
      // ![alt](src) → alt: only the alt text is visible.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // [text](href) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // [text][ref] → text
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      // <https://…> renders its own URL, so only the brackets are syntax.
      .replace(/<(?:https?|mailto):[^>\s]+>/g, (match) => match.slice(1, -1))
      // Any other tag is structure, not text.
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      // `code` → code
      .replace(/`+([^`]*)`+/g, "$1")
      // **bold** / __bold__ / *em* / _em_ / ~~del~~
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      // Escaped punctuation keeps the character, drops the backslash.
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
  );
}

export type MarkdownLineKind =
  /** A ``` / ~~~ line: syntax, never content. */
  | "fence"
  /** Inside a fenced block: literal text the reader sees verbatim. */
  | "code"
  /** Ordinary Markdown that inline and line-level markers still apply to. */
  | "markup";

/**
 * Fence-aware line split. Both the statistics and the outline have to ignore
 * `#` inside a code block, and they must agree on where a block starts and
 * ends — one scanner, two consumers.
 */
export function classifyMarkdownLines(
  source: string,
): { text: string; kind: MarkdownLineKind; line: number }[] {
  const normalized = source.replace(/\r\n?/g, "\n");
  // Front matter is metadata: it is never part of the rendered document. The
  // block is blanked rather than removed, so every line index below still
  // points at the same line of the original file — the outline jumps by line.
  const body = normalized.replace(/^---\n[\s\S]*?\n---[ \t]*(\n|$)/, (match) =>
    "\n".repeat((match.match(/\n/g) ?? []).length),
  );

  let fence: string | null = null;

  return body.split("\n").map((text, line) => {
    const fenceMatch = text.match(FENCE_LINE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
        return { text, kind: "fence", line };
      }
      if (marker === fence) {
        fence = null;
        return { text, kind: "fence", line };
      }
      // A different fence character inside a block is still code content.
      return { text, kind: "code", line };
    }
    return { text, kind: fence === null ? "markup" : "code", line };
  });
}

/**
 * The text a reader actually sees, one output line per source line.
 *
 * Fenced code blocks are copied verbatim (their asterisks *are* visible), while
 * the fence lines themselves and every structural marker around them are
 * dropped.
 */
export function toVisibleText(source: string): string {
  const lines = classifyMarkdownLines(source).map(({ text: rawLine, kind }) => {
    if (kind === "fence") return "";
    if (kind === "code") return rawLine;

    if (
      REFERENCE_DEFINITION.test(rawLine) ||
      HORIZONTAL_RULE.test(rawLine) ||
      TABLE_DELIMITER.test(rawLine)
    ) {
      return "";
    }

    let line = rawLine
      // Quote first: `> # 标题` only becomes a heading after `>` is gone.
      .replace(BLOCK_QUOTE, "")
      .replace(ATX_HEADING, "")
      .replace(LIST_MARKER, "")
      .replace(TASK_CHECKBOX, "");

    line = stripInlineMarkdown(line);
    // Table cell separators are structure; a space keeps neighbouring cells
    // from fusing into one word.
    line = line.replace(/\|/g, " ");
    // Markdown rendering collapses runs of spaces, so the character count has
    // to collapse them too.
    return line.replace(/[ \t]{2,}/g, " ").trim();
  });

  return lines.join("\n");
}

export function computeMarkdownStats(source: string): MarkdownStats {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.length === 0 ? 0 : normalized.split("\n").length;
  const visible = toVisibleText(source);

  const cjk = (visible.match(CJK_PATTERN) ?? []).length;
  // CJK is counted by the character, so it must not be counted again as a word.
  const words = (visible.replace(CJK_PATTERN, " ").match(WORD_PATTERN) ?? []).length;
  const chars = visible.replace(/\n/g, "").length;

  return { lines, words, cjk, chars };
}
