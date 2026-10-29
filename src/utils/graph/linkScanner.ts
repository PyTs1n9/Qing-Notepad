/**
 * Link scanner: one pass over a note body, six syntaxes, no IO.
 *
 * Two phases, both pure:
 *
 * 1. **Mask verbatim regions** (fenced code, inline code, HTML comments,
 *    `<pre>` / `<code>` blocks) by replacing every character with a space while
 *    keeping `\n` in place. Masking is *length preserving* on purpose (§3.3.4):
 *    a broken link has to be highlighted at its exact column and opened at its
 *    exact line, and a length change would force every downstream offset
 *    through a second mapping table.
 * 2. **Scan** the masked body for the six supported syntaxes.
 *
 * Why a hand-written scanner instead of `marked`'s token stream: `marked` does
 * not recognise `[[…]]` at all (it lands in `Tokens.Text`, so wiki links need a
 * second scanner anyway), it reports no character offsets, and it does not mask
 * anything. Two parsers disagreeing about one note is exactly the bug this
 * module exists to avoid (§3.3.5).
 */
import type { GraphEdgeKind, ParsedLink } from "@/types/graph";
import {
  decodePercentSafe,
  fileExtension,
  isNoteExtension,
  joinVaultPath,
  normalizeTarget,
} from "@/utils/graph/linkResolver";

/** Counters the graph page shows in its footer; none of these become edges. */
export interface ScanStats {
  /** `[[#锚点]]` 与 `[[本文]]` 之外，只数"只有锚点"的自引用。 */
  selfReferences: number;
  /** `[文字](https://…)` —— 外链不是知识关联。 */
  externalLinks: number;
  /** `![[图片.png]]`、`![](...)` —— 非笔记嵌入，不建边。 */
  nonNoteEmbeds: number;
}

export interface ScanResult {
  links: ParsedLink[];
  stats: ScanStats;
}

export interface ScanOptions {
  /**
   * 来源笔记所在目录（相对 vault 根，"" 表示根）。用于判断 `[x](../y.md)`
   * 解析后是否仍在 vault 内 —— 越界的不算边，连悬空节点都不建。
   */
  dir?: string | null;
  /**
   * `.txt` 只当节点、不解析链接（§3.3.1 末尾的明确结论）：纯文本没有链接
   * 语法，"谁出现谁的标题就成边"在 5000 篇规模上会造出数千条假边。
   */
  linksParsable?: boolean;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/g;
const MAX_WIKI_INNER = 512;

interface Line {
  /** 行首偏移（含）。 */
  start: number;
  /** 行尾偏移（不含换行符）。 */
  end: number;
  text: string;
}

function sliceLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text.charCodeAt(index) === 10) {
      lines.push({ start, end: index, text: text.slice(start, index) });
      start = index + 1;
    }
  }
  return lines;
}

/** 把 `mask` 里标记的区间换成等长的空格，`\n` 原样保留。 */
function applyMask(text: string, mask: Uint8Array): string {
  let out = "";
  let last = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (mask[index] === 0) continue;
    out += text.slice(last, index);
    out += text[index] === "\n" ? "\n" : " ";
    last = index + 1;
  }
  return out + text.slice(last);
}

function markRange(mask: Uint8Array, start: number, end: number): void {
  for (let index = start; index < end; index += 1) mask[index] = 1;
}

interface Fence {
  char: string;
  length: number;
  info: string;
}

function matchFence(line: string): Fence | null {
  const match = FENCE_PATTERN.exec(line);
  if (!match) return null;
  const marker = match[1];
  const info = match[2];
  // A backtick fence's info string may not contain a backtick (CommonMark),
  // which is what keeps an inline `` `code` `` opening a fence.
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0], length: marker.length, info: info.trim() };
}

/** 围栏代码块，含未闭合到文末的情况（一次粘贴事故就会产生）。 */
function maskFencedCode(text: string): string {
  const mask = new Uint8Array(text.length);
  let open: Fence | null = null;
  let blockStart = 0;
  for (const line of sliceLines(text)) {
    const fence = matchFence(line.text);
    if (!open) {
      if (fence && fence.length >= 3) {
        open = fence;
        blockStart = line.start;
      }
      continue;
    }
    if (fence && fence.char === open.char && fence.length >= open.length && fence.info === "") {
      markRange(mask, blockStart, line.end);
      open = null;
    }
  }
  if (open) markRange(mask, blockStart, text.length);
  return applyMask(text, mask);
}

/** HTML 注释、`<pre>`、`<code>` 段。原生笔记正文可能是 TipTap 落盘的 HTML。 */
function maskHtmlRegions(text: string): string {
  const mask = new Uint8Array(text.length);
  for (const match of text.matchAll(HTML_COMMENT_PATTERN)) {
    markRange(mask, match.index, match.index + match[0].length);
  }
  for (const tag of ["pre", "code"]) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, "gi");
    for (const match of text.matchAll(pattern)) {
      markRange(mask, match.index, match.index + match[0].length);
    }
  }
  return applyMask(text, mask);
}

function restOfLineIsBlank(text: string, index: number): boolean {
  for (let scan = index; scan < text.length; scan += 1) {
    const char = text[scan];
    if (char === "\n") return true;
    if (char !== " " && char !== "\t" && char !== "\r") return false;
  }
  return true;
}

/**
 * 行内代码。A run of `n` backticks closes only on another run of exactly `n`,
 * and a code span cannot cross a blank line — both are CommonMark rules, and
 * both matter here because `` `` ` `` `` (escaping a backtick) is common in
 * notes that talk about Markdown.
 */
function maskInlineCode(text: string): string {
  const mask = new Uint8Array(text.length);
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let openLength = 0;
    while (text[index + openLength] === "`") openLength += 1;
    const openStart = index;
    let scan = index + openLength;
    let closeStart = -1;
    while (scan < text.length) {
      if (text[scan] === "`") {
        let closeLength = 0;
        while (text[scan + closeLength] === "`") closeLength += 1;
        if (closeLength === openLength) {
          closeStart = scan;
          break;
        }
        scan += closeLength;
        continue;
      }
      if (text[scan] === "\n" && restOfLineIsBlank(text, scan + 1)) break;
      scan += 1;
    }
    if (closeStart >= 0) {
      markRange(mask, openStart, closeStart + openLength);
      index = closeStart + openLength;
    } else {
      // 未闭合反引号按 CommonMark 是普通文本，不当代码处理。
      index = openStart + openLength;
    }
  }
  return applyMask(text, mask);
}

/**
 * 等长屏蔽。顺序是有意的：围栏先吃掉整段（里面常有注释或反引号），
 * 再吃 HTML 段，最后吃行内代码。每一趟都是等长的，所以偏移始终对得上。
 */
export function maskVerbatim(text: string): string {
  return maskInlineCode(maskHtmlRegions(maskFencedCode(text)));
}

/** 行首偏移表，供 offset → line/column 二分查找。 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

const WIKI_PATTERN = /(!?)\[\[([^[\]\n]*)\]\]/g;
const MARKDOWN_LINK_PATTERN =
  /(!?)\[([^\][\n]{0,256})\]\(\s*<?([^()<>\s]{1,512})>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function makeLink(
  kind: GraphEdgeKind,
  raw: string,
  rawTarget: string,
  alias: string | null,
  anchor: string | null,
  offset: number,
  starts: readonly number[],
): ParsedLink {
  const { line, column } = positionAt(starts, offset);
  return { kind, raw, rawTarget, alias, anchor, line, column, offset };
}

/** 拆分 `目标#锚点`（锚点只在第一个 `#` 处切）。 */
function splitAnchor(value: string): { target: string; anchor: string | null } {
  const hash = value.indexOf("#");
  if (hash < 0) return { target: value, anchor: null };
  return { target: value.slice(0, hash), anchor: value.slice(hash + 1) || null };
}

function scanWikiLinks(
  masked: string,
  starts: readonly number[],
  links: ParsedLink[],
  stats: ScanStats,
): void {
  for (const match of masked.matchAll(WIKI_PATTERN)) {
    const offset = match.index ?? 0;
    const embed = match[1] === "!";
    const inner = match[2];
    if (inner.length > MAX_WIKI_INNER) continue;

    const pipe = inner.indexOf("|");
    const targetPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const aliasPart = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
    const { target, anchor } = splitAnchor(targetPart);
    const rawTarget = target.trim();

    // `[[#锚点]]` 只有锚点 = 自引用，不建边（§3.3.1 #3）。
    if (!rawTarget) {
      stats.selfReferences += 1;
      continue;
    }

    // `![[图片.png]]` 目标是图片/PDF 等非笔记文件 → 不建边（§3.3.1 #4）。
    // 没有扩展名的 `![[笔记]]` 按笔记处理（Obsidian 也这么认）。
    if (embed) {
      const extension = fileExtension(rawTarget);
      if (extension && !isNoteExtension(extension)) {
        stats.nonNoteEmbeds += 1;
        continue;
      }
    }

    links.push(
      makeLink(
        embed ? "embed" : "wiki",
        match[0],
        rawTarget,
        aliasPart || null,
        anchor,
        offset,
        starts,
      ),
    );
  }
}

function scanMarkdownLinks(
  masked: string,
  starts: readonly number[],
  dir: string,
  links: ParsedLink[],
  stats: ScanStats,
): void {
  for (const match of masked.matchAll(MARKDOWN_LINK_PATTERN)) {
    const offset = match.index ?? 0;
    const image = match[1] === "!";
    const destination = match[3];

    // `![](...)` 是图片嵌入，不是笔记关联（§3.3.1 六种语法里没有它）。
    if (image) {
      stats.nonNoteEmbeds += 1;
      continue;
    }
    // `[文字](https://…)`、`mailto:`、`obsidian://` —— 外链不是知识关联。
    if (URI_SCHEME_PATTERN.test(destination)) {
      stats.externalLinks += 1;
      continue;
    }
    // 同页锚点不是边。
    if (destination.startsWith("#")) continue;

    const decoded = decodePercentSafe(destination);
    const extension = fileExtension(decoded);
    // 只有 md / markdown / txt 目标算边（§3.3.1 #5）。
    if (!isNoteExtension(extension)) continue;

    // 解析后必须仍在 vault 内：指向 vault 外部的相对路径不是边。
    const inside = decoded.startsWith("/")
      ? joinVaultPath("", decoded.replace(/^\/+/, ""))
      : joinVaultPath(normalizeTarget(dir), normalizeTarget(decoded));
    if (inside === null) continue;

    links.push(makeLink("markdown", match[0], decoded, null, null, offset, starts));
  }
}

/**
 * 扫一篇正文。`links` 按出现顺序（offset 升序）排序，同一条链接出现两次是
 * 两条事实（不同行号），调用方按 (source, target) 去重时不要丢掉行号。
 */
export function scanNoteLinks(text: string, options: ScanOptions = {}): ScanResult {
  const stats: ScanStats = { selfReferences: 0, externalLinks: 0, nonNoteEmbeds: 0 };
  if (!text || options.linksParsable === false) return { links: [], stats };

  const masked = maskVerbatim(text);
  const starts = lineStarts(masked);
  const links: ParsedLink[] = [];
  scanWikiLinks(masked, starts, links, stats);
  scanMarkdownLinks(masked, starts, options.dir ?? "", links, stats);
  links.sort((left, right) => left.offset - right.offset);
  return { links, stats };
}

/** 只要链接的便捷入口，签名与 §3.2.4 的 `LinkScanner.scan(text, ctx)` 一致。 */
export function scanLinks(text: string, options: ScanOptions = {}): ParsedLink[] {
  return scanNoteLinks(text, options).links;
}
