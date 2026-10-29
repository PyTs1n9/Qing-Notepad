/**
 * Where a note's display title comes from.
 *
 * The graph canvas labels a node with one string, and before this module that
 * string was "first `#` heading, else the file name". For an imported Obsidian
 * vault whose files are named `25f9f43b-1078-484f-8a6d-18b951f4f106.md` and
 * whose bodies start with prose (no H1 at all), that rule produced a canvas
 * full of UUIDs — the exact bug this module exists to fix.
 *
 * The chain is applied in this order, first hit wins:
 *
 * | # | source | why here |
 * | --- | --- | --- |
 * | 1 | frontmatter `title` / `name` / `aliases[0]` | the user already curated a title by hand; nothing can beat that |
 * | 2 | first ATX `# ` heading | the author's own section heading, and the historical behaviour |
 * | 3 | first ATX `## `–`######` heading | a note that opens with a section still has a human-readable name |
 * | 4 | first readable body line | prose-first notes (imported exports, meeting dumps) |
 * | 5 | file name | percent-decoded, extension stripped |
 * | 6 | parent dir + first 8 chars | only when (5) is still a machine name (UUID / long hex / long digits) |
 *
 * Two rules keep this honest:
 *
 * - **Nothing here touches the body offsets.** Frontmatter is still removed by
 *   overwriting it with spaces (see `stripFrontmatter`), so line numbers in the
 *   scanner and in "跳到第 N 行" stay exact.
 * - **`fileNameTitle` is the single implementation of steps 5 and 6.** The
 *   indexer's `fallbackTitle` delegates to it, so a rename repair cannot end up
 *   with a different title than the first parse would have produced.
 *
 * The YAML reader is a deliberately tiny subset (`key: value`, `key: [a, b]`,
 * `key:` + `- a` lines). A real YAML parser is a new dependency for a feature
 * whose only need is "read a title", and the frontmatter block is 5 lines long.
 */
import {
  basenameOf,
  decodePercentSafe,
  dirnameOf,
  stripNoteExtension,
} from "@/utils/graph/linkResolver";

/** 与 `GraphNode.title` 的实际显示上限一致；画布另有 24 字截断（渲染层）。 */
export const MAX_TITLE_LENGTH = 200;

/** 正文首行的可接受长度：比 2 短的是符号碎片，比 120 长的是一整段。 */
const MIN_READABLE_LENGTH = 2;
const MAX_READABLE_LENGTH = 120;
/**
 * 整篇只有一个超长段落时的截断长度。
 *
 * 中文 Markdown 极少硬换行，"整篇就一段"的快记 / 摘录 / 导入稿很常见，而 120 字
 * 大约两行就写满。若这种笔记**没有第二行可退**，跳过整行就等于回退到文件名 ——
 * UUID 文件名的笔记会因此重新显示成 UUID（原 bug 的复发路径）。
 * 所以 `firstReadableLine` 分两趟：先找 ≤120 字的行；一行都没有时，把第一段
 * 截到 40 字当标题。用户自己的话永远比 `收件箱 · 25f9f43b` 有用。
 */
const PARAGRAPH_TRUNCATE_LENGTH = 40;

/** 候选来自哪一级；`filename` 表示"没有候选，调用方回退到文件名"。 */
export type TitleSource = "frontmatter" | "heading" | "text-line" | "filename";

/** 一级命中结果。`source` 不包含 `filename`：那一级由调用方走回退。 */
export interface TitlePick {
  title: string;
  source: Exclude<TitleSource, "filename">;
}

/** frontmatter 里与标题有关的三个键（其余键忽略）。 */
export interface FrontmatterMeta {
  title: string | null;
  name: string | null;
  aliases: string[];
}

export const EMPTY_FRONTMATTER_META: FrontmatterMeta = { title: null, name: null, aliases: [] };

/** `---` frontmatter，允许 BOM 与 CRLF。必须从索引 0 开始（见 `stripFrontmatter`）。 */
const FRONTMATTER_PATTERN = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*$/m;

/** `key: value` / `key:`（值留到下面的 `- item` 行里）。 */
const FRONTMATTER_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;
/** YAML 块状数组的一项：`- a`（`-` 后面必须跟空白，否则 `-5` 是数字）。 */
const FRONTMATTER_ITEM_PATTERN = /^[ \t]*-(?:[ \t]+(.*))?$/;
/**
 * 块标量指示符：`|`、`>`、`|-`、`>+`、`|2`…… 它的值在**下面的缩进行里**，
 * 不是这个字符本身。把 `|` 当标题会在画布上留一个孤零零的竖线。
 */
const BLOCK_SCALAR_PATTERN = /^[|>][0-9+-]*$/;
/**
 * 值以 `{` / `[` 开头的是流式集合（`{a: 1}`、`[a, b]`），不是标量字符串。
 * 内联数组在上面的分支里已单独处理，这里挡的是"列表项本身是映射/嵌套数组"。
 */
const FLOW_COLLECTION_PATTERN = /^[{[]/;

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const H1_PATTERN = /^ {0,3}#[ \t]+(.*)$/;
const SUBHEADING_PATTERN = /^ {0,3}#{2,6}[ \t]+(.*)$/;

/** `|---|:---:|` 之类的表格分隔线。 */
const TABLE_SEPARATOR_PATTERN = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/;
/** 表格数据行 `| a | b |`：不是标题，跳过。 */
const TABLE_ROW_PATTERN = /^[ \t]*\|.*\|[ \t]*$/;
/** `---` / `***` / `___` 水平分割线。 */
const HORIZONTAL_RULE_PATTERN = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** 独占一行的图片 `![](x.png)`。 */
const IMAGE_ONLY_PATTERN = /^[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*$/;
/** 独占一行的链接 `[文字](x.md)`。 */
const LINK_ONLY_PATTERN = /^[ \t]*\[[^\]]*\]\([^)]*\)[ \t]*$/;
/** 独占一行的 HTML 注释或单个标签。 */
const HTML_ONLY_PATTERN = /^[ \t]*(?:<!--[\s\S]*|<[A-Za-z!/][^>]*>)[ \t]*$/;
/** 裸元数据 `tags: [a, b]`：键必须是 ASCII 标识符，避免吃掉中文句子的冒号。 */
const BARE_METADATA_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,40}[ \t]*:[ \t]*\S/;
/** 至少一个字母 / 汉字 / 数字：纯符号行不算标题。 */
const READABLE_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;

/** `8-4-4-4-12` 十六进制 UUID。 */
const UUID_NAME_PATTERN =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** 32 位以上连续 hex（sha1/md5 文件名、内容寻址的导出）。 */
const LONG_HEX_NAME_PATTERN = /^[0-9a-f]{32,}$/i;
/** 8 位以上纯数字（时间戳型导出、`20241029`）。 */
const LONG_DIGITS_NAME_PATTERN = /^[0-9]{8,}$/;

/** 用等长空格覆盖 [start, end)，换行符原样保留。 */
function blankRange(text: string, start: number, end: number): string {
  const blanked = text.slice(start, end).replace(/[^\n]/g, " ");
  return text.slice(0, start) + blanked + text.slice(end);
}

/**
 * Frontmatter 只在文件最开头算。用 `^...$` + `m` 定位，但要求它从索引 0 开始，
 * 所以这里显式检查 `startsWith`，避免把正文中间的分隔线误当 frontmatter。
 */
export function stripFrontmatter(text: string): string {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match || match.index !== 0) return text;
  return blankRange(text, 0, match[0].length);
}

/** 去掉值两侧的成对引号（单/双），保留内部内容。 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/**
 * frontmatter 值的"去修饰"，比 `stripInlineMarkdown` 窄一层。
 *
 * 只用 `stripInlineMarkdown` 不行：它会顺手吃掉行首的列表 / 引用 / 编号前缀，
 * 而 `title: 3. 版本说明` 里的 `3.` 是标题的一部分。这里只处理**行内**修饰：
 * HTML 标签、wiki / markdown 链接、`**`、`*`、`` ` ``、`~~`（不碰 `_`，别名里
 * 的下划线是内容），最后再剥一层"整串被单层方括号包住"的残留。
 *
 * 那层残留来自 `aliases: [[会议]]`：YAML 里它是"数组套数组"，内联数组分支切开
 * 后每项是 `[会议]`，wiki 语法已经没有了，只剩一对裸方括号。不剥的话画布上是
 * `[会议]`，和用户写的别名差两对方括号，看着像编码残留。
 *
 * 只清候选值，body 与 frontmatter 原文一个字节都不动。
 */
function cleanMetaValue(value: string): string {
  let out = value;
  out = out.replace(/<[^>]*>/g, " ");
  out = out.replace(/!\[\[([^\]]*)\]\]/g, "$1");
  out = out.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  out = out.replace(/\[\[([^\]]*)\]\]/g, "$1");
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/[*`~]+/g, "");
  out = out.replace(/[ \t\u3000]+/g, " ").trim();
  // `[会议]` → `会议`。只在整串被一对单层方括号包住、且内部没有别的方括号时剥，
  // 免得把 `[[a]](b)` 这类混排越剥越乱。
  if (out.length >= 2 && out.startsWith("[") && out.endsWith("]")) {
    const inner = out.slice(1, -1).trim();
    if (inner && !inner.includes("[") && !inner.includes("]")) return inner;
  }
  return out;
}

/** 行首缩进宽度（空格与 tab 各算 1，只用于比较大小）。 */
function indentOf(line: string): number {
  let width = 0;
  while (width < line.length && (line[width] === " " || line[width] === "\t")) width += 1;
  return width;
}

/**
 * 读 frontmatter 里与标题有关的键。
 *
 * 只支持三种写法（够 Obsidian / Jekyll 导出实际用到的全部）：
 *
 * ```
 * title: "会议纪要"
 * aliases: [纪要, 会议]
 * aliases:
 *   - 纪要
 * ```
 *
 * 其余结构一律**忽略而不是猜**：猜错的标题比文件名更难排查。具体是
 *
 * - 块标量（`title: |` / `title: >`）：值是下面的缩进块，`|` 本身不是标题，
 *   整个缩进块一起跳过；
 * - 嵌套映射（`meta:` 下面再来一层 `title:`）：只有**顶层**（无缩进）的键算数；
 * - 流式集合（`- {a: 1}`、`- [a, b]`）：不是标量字符串，丢弃。
 *
 * 这三条都有对应的断言（`scripts/verify-graph-title.mjs` 的 `[2]` 节）。
 */
export function readFrontmatterMeta(text: string): FrontmatterMeta {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match || match.index !== 0) return { ...EMPTY_FRONTMATTER_META };

  const lines = match[0].split(/\r?\n/);
  // lines[0] 是起始 `---`，最后一段是结束 `---`，中间才是内容。
  const limit = Math.max(lines.length - 1, 1);
  const collected = new Map<string, string[]>();
  let currentKey: string | null = null;
  /** 正在跳过的块标量缩进层级；-1 = 不在块标量里。 */
  let blockIndent = -1;

  for (let index = 1; index < limit; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const indent = indentOf(line);

    if (blockIndent >= 0) {
      // 块标量的内容：缩进比键更深的所有行（含块内空行）都属于它。
      if (!trimmed || indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;

    const item = FRONTMATTER_ITEM_PATTERN.exec(line);
    if (item && currentKey) {
      const value = cleanMetaValue(unquote(item[1] ?? ""));
      // `- {a: 1}` / `- [a, b]`：列表项本身是集合，不是别名字符串。
      if (value && !FLOW_COLLECTION_PATTERN.test(value)) {
        const list = collected.get(currentKey) ?? [];
        list.push(value);
        collected.set(currentKey, list);
      }
      continue;
    }

    // 缩进的行只可能是嵌套结构（或上面已处理的列表项）：不是顶层键。
    if (indent > 0) {
      currentKey = null;
      continue;
    }

    const entry = FRONTMATTER_KEY_PATTERN.exec(trimmed);
    if (!entry) {
      // 不认识的写法：不再把后续 `- item` 归到上一个键上。
      currentKey = null;
      continue;
    }
    const key = entry[1].toLowerCase();
    const inline = (entry[2] ?? "").trim();
    currentKey = key;
    if (!inline) {
      if (!collected.has(key)) collected.set(key, []);
      continue;
    }
    if (BLOCK_SCALAR_PATTERN.test(inline)) {
      // `title: |` —— 值在下面的缩进块里，这一行没有标量内容。
      if (!collected.has(key)) collected.set(key, []);
      currentKey = null;
      blockIndent = indent;
      continue;
    }
    if (inline.startsWith("[")) {
      // 内联数组：不处理引号内的逗号（`[a, b]` 里没有这种写法）。
      const inner = inline.replace(/^\[/, "").replace(/\]$/, "");
      const values = inner
        .split(",")
        .map((part) => cleanMetaValue(unquote(part)))
        .filter((part) => part.length > 0);
      collected.set(key, values);
      continue;
    }
    if (FLOW_COLLECTION_PATTERN.test(inline)) {
      // `title: {a: b}` —— 流式映射，不是字符串。
      collected.set(key, []);
      continue;
    }
    collected.set(key, [cleanMetaValue(unquote(inline))]);
  }

  const firstOf = (key: string): string | null => {
    const list = collected.get(key);
    if (!list) return null;
    return list.find((value) => value.length > 0) ?? null;
  };

  return {
    title: firstOf("title"),
    name: firstOf("name"),
    aliases: (collected.get("aliases") ?? []).filter((value) => value.length > 0),
  };
}

/**
 * 在正文里找第一个匹配的 ATX 标题，跳过围栏代码块里的 `#…`（讲 Markdown 语法
 * 的笔记里到处都是），也跳过 frontmatter（已被前置调用清成空格）。
 *
 * `skipEmptyFirst = false` 保留 H1 的历史行为：首个 `#`（`# ` 后没内容）直接
 * 认为"没有 H1"，不再往后找。
 */
function matchHeading(
  body: string,
  pattern: RegExp,
  skipEmptyFirst: boolean,
): string | null {
  let fence: { char: string; length: number } | null = null;
  for (const line of body.split("\n")) {
    if (fence) {
      const close = FENCE_CLOSE_PATTERN.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN_PATTERN.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    const heading = pattern.exec(line);
    if (!heading) continue;
    // ATX 允许尾随 `###`（`# 标题 ##`），它不是标题的一部分。
    const title = heading[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (!title) {
      if (!skipEmptyFirst) return null;
      continue;
    }
    return title.slice(0, MAX_TITLE_LENGTH);
  }
  return null;
}

/** 首个 H1（`# `）。没有则 null，调用方继续走下一级。 */
export function firstHeading(body: string): string | null {
  return matchHeading(body, H1_PATTERN, false);
}

/** 首个 H2–H6（无 H1 时的次选）。空的 `##` 跳过，继续找。 */
export function firstSubheading(body: string): string | null {
  return matchHeading(body, SUBHEADING_PATTERN, true);
}

/** 去掉行内 markdown 修饰，留下人能读的那部分。 */
function stripInlineMarkdown(line: string): string {
  let value = line;
  // 行内 HTML 标签先换成空格，免得 `<br>` 粘进标题。
  value = value.replace(/<[^>]*>/g, " ");
  // `![[图.png]]` 与 `[[目标|别名]]`：保留可读的那一半。
  value = value.replace(/!\[\[([^\]]*)\]\]/g, "$1");
  value = value.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  value = value.replace(/\[\[([^\]]*)\]\]/g, "$1");
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 引用前缀、标题井号、列表项前缀。
  value = value.replace(/^[ \t]*(?:>[ \t]?)+/, "");
  value = value.replace(/^[ \t]*#{1,6}[ \t]+/, "");
  value = value.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, "");
  // `**`、`*`、`` ` ``、`~~` 这类修饰符（不碰 `_`：文件名里的下划线是内容）。
  value = value.replace(/[*`~]+/g, "");
  return value.replace(/[ \t\u3000]+/g, " ").trim();
}

/** 这一行是否整行都不该当标题（图片/链接/裸元数据/表格/分割线/HTML）。 */
function isSkippableLine(line: string): boolean {
  if (HORIZONTAL_RULE_PATTERN.test(line)) return true;
  if (TABLE_SEPARATOR_PATTERN.test(line)) return true;
  if (TABLE_ROW_PATTERN.test(line)) return true;
  if (HTML_ONLY_PATTERN.test(line)) return true;
  if (IMAGE_ONLY_PATTERN.test(line)) return true;
  if (LINK_ONLY_PATTERN.test(line)) return true;
  if (BARE_METADATA_PATTERN.test(line.trim())) return true;
  return false;
}

/**
 * 截断到 `limit` 个字符并追加 `…`，英文尽量在词边界断开（中文没有空格，硬切）。
 *
 * 省略号是刻意的：标题被截断却看不出来，用户会以为笔记第一句就到此为止。
 * 它只是 1 个字符，离 `MAX_TITLE_LENGTH` 很远，不会把标题挤爆。落在 tooltip 里
 * 也多一个"这是节选"的信号；`buildCandidateTable.byTitle` 用归一化后的串做键，
 * 多一个 `…` 不影响任何按标题解析的既有边（那个键本来就只匹配精确标题）。
 */
function truncateForTitle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  const head = boundary >= Math.floor(limit * 0.6) ? cut.slice(0, boundary).trim() : cut.trim();
  return head ? `${head}…` : "";
}

/**
 * 正文里第一行"像标题"的文本。
 *
 * 跳过：空行、frontmatter（已被清成空格）、围栏代码块、纯符号、`key: value`
 * 形态的裸元数据、图片/链接独占行、HTML 独占行、表格、分割线。命中后去掉行内
 * markdown 修饰，长度必须落在 2–120 且至少含一个字母/汉字/数字。
 *
 * **两趟**：先整篇找一行 ≤120 字（宁要"下一行的短句"也不要截断），一行都没有
 * 时再回头取第一段超长文本、截到 40 字。只有一趟的话，"整篇一个段落"的笔记会
 * 直接回退到文件名 —— 对 UUID 文件名的导入笔记就是原 bug 复发。
 */
export function firstReadableLine(body: string): string | null {
  let fence: { char: string; length: number } | null = null;
  /** 第一段"可读但过长"的文本：留到第二趟用。 */
  let paragraph: string | null = null;
  for (const line of body.split("\n")) {
    if (fence) {
      const close = FENCE_CLOSE_PATTERN.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN_PATTERN.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    if (!line.trim()) continue;
    if (isSkippableLine(line)) continue;
    const candidate = stripInlineMarkdown(line);
    if (candidate.length < MIN_READABLE_LENGTH) continue;
    if (!READABLE_CHARACTER_PATTERN.test(candidate)) continue;
    if (candidate.length <= MAX_READABLE_LENGTH) return candidate.slice(0, MAX_TITLE_LENGTH);
    if (paragraph === null) paragraph = candidate;
  }
  if (paragraph === null) return null;
  return truncateForTitle(paragraph, PARAGRAPH_TRUNCATE_LENGTH);
}

export interface TitleChainOptions {
  /**
   * `.txt` 没有 ATX 语义（`# 标题` 在纯文本里就是那一行字），所以跳过第 2 级，
   * 直接用第 3/4 级；首行里的井号由 `stripInlineMarkdown` 去掉。
   */
  allowHeading1?: boolean;
}

/**
 * 第 1–4 级：frontmatter → H1 → H2–H6 → 正文首行。第 5/6 级（文件名）由调用方
 * 用 `fileNameTitle` 补，因为那一步与解析结果无关，重命名修补也要用同一套规则。
 */
export function pickTitle(
  body: string,
  meta: FrontmatterMeta,
  options: TitleChainOptions = {},
): TitlePick | null {
  const fromMeta = meta.title ?? meta.name ?? (meta.aliases.length > 0 ? meta.aliases[0] : null);
  if (fromMeta) return { title: fromMeta.slice(0, MAX_TITLE_LENGTH), source: "frontmatter" };

  if (options.allowHeading1 !== false) {
    const heading = firstHeading(body);
    if (heading) return { title: heading, source: "heading" };
  }
  const subheading = firstSubheading(body);
  if (subheading) return { title: subheading, source: "heading" };

  const line = firstReadableLine(body);
  if (line) return { title: line, source: "text-line" };
  return null;
}

/**
 * 文件名本身是否还是一个"机器名"：UUID、32 位以上连续 hex、8 位以上纯数字。
 *
 * 只认这三类，而不是"看起来随机"的启发式：真正的中文/英文标题绝不会命中，
 * 而把 `K3n8Qz` 这种用户自己起的短名字改成"父目录 · K3n8Qz"是一种退步。
 */
export function looksLikeCodedName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    UUID_NAME_PATTERN.test(trimmed) ||
    LONG_HEX_NAME_PATTERN.test(trimmed) ||
    LONG_DIGITS_NAME_PATTERN.test(trimmed)
  );
}

/**
 * 第 5/6 级：文件名 → 标题。
 *
 * 顺序：percent-decode（`%E4%B8%AD%E6%96%87.md` → `中文.md`，非法转义保留原串）
 * → 去扩展名 → 若仍是编码名，改用 `父目录 · 前 8 位`。父目录为空时保留文件名：
 * 一个根目录下名为 UUID 的笔记没有更好的名字，宁可显示全串也不要显示空标题。
 *
 * 这是第 5/6 级的**唯一实现**：`graphIndexer.fallbackTitle` 直接转发到这里，
 * 所以首次解析与重命名修补不可能给出不同的标题。
 */
export function fileNameTitle(relPath: string | null | undefined): string {
  if (!relPath) return "";
  const decoded = decodePercentSafe(basenameOf(relPath));
  const stem = stripNoteExtension(decoded);
  if (!stem) return "";
  if (!looksLikeCodedName(stem)) return stem.slice(0, MAX_TITLE_LENGTH);

  const parentDir = dirnameOf(relPath);
  const parentName = parentDir ? stripNoteExtension(decodePercentSafe(basenameOf(parentDir))) : "";
  if (!parentName) return stem.slice(0, MAX_TITLE_LENGTH);
  return `${parentName} · ${stem.slice(0, 8)}`.slice(0, MAX_TITLE_LENGTH);
}
