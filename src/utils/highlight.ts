import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

/**
 * The one place languages are registered.
 *
 * Two consumers need the same set: the preview renderer (`utils/markdown.ts`,
 * which emits `<span class="hljs-*">`) and the live-preview decoration layer
 * (which needs *offsets*, not HTML). Registering in both places would double the
 * module graph for no reason, and registering in only one would leave the other
 * silently unhighlighted — which is exactly the bug this file fixes.
 */
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);

/** Aliases the fence info string may use instead of the canonical name. */
const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  ps1: "powershell",
  pwsh: "powershell",
  htm: "xml",
  html: "xml",
  svg: "xml",
  vue: "xml",
  "c++": "cpp",
  "c#": "csharp",
  md: "markdown",
};

/** Canonical language for a fence info string, or `""` when unknown. */
export function resolveLanguage(info: string): string {
  const raw = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!raw) return "";
  const canonical = ALIASES[raw] ?? raw;
  return hljs.getLanguage(canonical) ? canonical : "";
}

/** A highlighted run, as offsets into the source text that was passed in. */
export interface HighlightRange {
  from: number;
  to: number;
  /** hljs token class, e.g. `hljs-keyword`. Already a valid CSS class list. */
  className: string;
}

/**
 * Highlighted runs for `code`, in document order.
 *
 * `hljs.highlight` returns HTML; the editor needs positions, because a
 * `Decoration.mark` paints a source range and cannot hold markup. Rather than
 * re-tokenising (which would be a second, diverging implementation), this walks
 * the generated HTML and converts it back to offsets.
 *
 * Correctness rests on one invariant: the visible text of the HTML must be
 * exactly `code`. It is checked at the end, and any mismatch yields an empty
 * list — an unhighlighted block is a cosmetic loss, while misaligned offsets
 * would paint the wrong characters.
 */
export function highlightRanges(code: string, language: string): HighlightRange[] {
  const canonical = resolveLanguage(language);
  if (!canonical || !code) return [];

  let html: string;
  try {
    html = hljs.highlight(code, { language: canonical, ignoreIllegals: true }).value;
  } catch {
    return [];
  }

  const ranges: HighlightRange[] = [];
  /** Open `<span class="…">` runs; hljs nests for sub-languages. */
  const open: string[] = [];
  let index = 0;
  let offset = 0;

  const emitText = (text: string): void => {
    if (!text) return;
    const length = decodedLength(text);
    const className = open[open.length - 1];
    if (className && length > 0) ranges.push({ from: offset, to: offset + length, className });
    offset += length;
  };

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      emitText(html.slice(index));
      break;
    }
    if (lt > index) emitText(html.slice(index, lt));

    const gt = html.indexOf(">", lt);
    if (gt === -1) break;
    const tag = html.slice(lt + 1, gt);

    if (tag.startsWith("/")) {
      open.pop();
    } else if (tag.startsWith("span")) {
      open.push(/class="([^"]*)"/.exec(tag)?.[1] ?? "");
    }
    index = gt + 1;
  }

  // The visible text has to be byte-for-byte the source, or every offset below
  // is a lie. Cheap to check, and it is the only failure worth refusing to draw.
  if (offset !== code.length) return [];
  return ranges.filter((range) => range.to > range.from);
}

/**
 * Length of `text` once HTML entities are decoded: the offsets are in source
 * characters, but the HTML carries `&amp;` (5 chars) for one.
 *
 * hljs escapes exactly `& < > " '`, so only those forms need mapping.
 */
function decodedLength(text: string): number {
  let length = text.length;
  for (const match of text.matchAll(/&(?:amp|lt|gt|quot|#39|#x27|apos);/g)) {
    length -= match[0].length - 1;
  }
  return length;
}

export { hljs };
