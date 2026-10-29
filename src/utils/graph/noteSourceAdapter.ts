/**
 * Note body → parse-ready text.
 *
 * A note body reaches the graph in one of three shapes, and they are not
 * interchangeable:
 *
 * | shape | where it comes from | what this module does |
 * | --- | --- | --- |
 * | `markdown` | a vault `.md`, or a native note saved after the Markdown rewrite | strip frontmatter, keep the rest byte for byte |
 * | `html` | a native note saved by the TipTap era, and every imported `.txt` (App.tsx wraps each line in `<p>`) | convert with the existing `htmlToMarkdown` |
 * | `text` | a vault `.txt` | keep as-is, `linksParsable: false` |
 *
 * **Decision: HTML is converted, not scanned raw.** Scanning raw HTML would miss
 * `[文字](x.md)` entirely (it is an `<a href>` there) and would keep matching the
 * `<code>` blocks this scanner is supposed to mask. The cost is that line and
 * column numbers for an `html` note refer to the converted Markdown, not to the
 * stored HTML.
 *
 * That cost is accepted for two reasons, and it is a real limitation worth
 * stating plainly: turndown separates blocks with a blank line, so an imported
 * `.txt` (which `App.tsx` stores as one `<p>` per source line) ends up with two
 * output lines per input line. Line numbers for `html` notes are therefore for
 * *display* ("引用在第 12 行"), not for seeking — and that is fine, because
 * §4.4.2 sends native nodes to the editor, which seeks by stored content offset,
 * while vault nodes are Markdown and keep exact 1:1 line numbers.
 * Faking 1:1 here would mean a second turndown configuration whose output no
 * longer matches what the editor shows — the same class of divergence
 * `htmlToMarkdown.ts` documents at its top, only worse.
 *
 * Frontmatter is removed by overwriting it with spaces (newlines kept), for the
 * same offset-alignment reason the scanner masks instead of deletes: a `[[…]]`
 * inside `aliases:` must not become an edge, but line 30 of the note must stay
 * line 30.
 *
 * **Titles are no longer "first H1 only".** `titleCandidate` now comes from the
 * chain in `noteTitle.ts` (frontmatter → H1 → H2–H6 → first readable line), and
 * `null` means "none of those worked, use the file name via
 * `graphIndexer.fallbackTitle`". `titleSource` is carried alongside so a caller
 * (and `scripts/verify-graph-title.mjs`) can tell *why* a node is named a
 * certain way without re-parsing the body.
 */
import { isStoredEditorHtml, storedContentToMarkdown } from "@/utils/htmlToMarkdown";
import { fileExtension } from "@/utils/graph/linkResolver";
import {
  pickTitle,
  readFrontmatterMeta,
  stripFrontmatter,
  type TitleSource,
} from "@/utils/graph/noteTitle";

export type NoteBodyKind = "markdown" | "html" | "text";

export interface NoteSourceInput {
  /** 原始正文：vault 文件文本，或原生笔记的 `Note.content`。 */
  content: string;
  /** vault 相对路径；原生笔记传 null / 省略。 */
  relPath?: string | null;
}

export interface NoteSource {
  /** 可解析正文：偏移与行号都相对于它。 */
  body: string;
  kind: NoteBodyKind;
  /** `.txt` 为 false —— 纯文本没有链接语法（§3.3.1 末尾结论）。 */
  linksParsable: boolean;
  /**
   * 正文能给出的标题候选；`null` 表示正文里没有可用标题，调用方回退到文件名。
   * 语义与 v1 相同（v1 只有 H1 会产出候选）。
   */
  titleCandidate: string | null;
  /** 候选来自哪一级；`titleCandidate === null` 时恒为 `"filename"`。 */
  titleSource: TitleSource;
}

/**
 * 首个 H1、frontmatter 剥离、标题长度上限都由 `noteTitle` 拥有；这里再导出一次
 * 是为了不改变这个模块既有的 import 面（`stripFrontmatter` 早就是公开 API）。
 */
export { firstHeading, stripFrontmatter } from "@/utils/graph/noteTitle";

/** vault 文件的扩展名（小写、不含点）；原生笔记返回 ""。 */
export function noteSourceExtension(relPath: string | null | undefined): string {
  return relPath ? fileExtension(relPath) : "";
}

/** 把一次 `pickTitle` 的结果折进 `NoteSource` 的两个字段。 */
function withTitle(
  source: Omit<NoteSource, "titleCandidate" | "titleSource">,
  candidate: { title: string; source: Exclude<TitleSource, "filename"> } | null,
): NoteSource {
  return {
    ...source,
    titleCandidate: candidate?.title ?? null,
    titleSource: candidate?.source ?? "filename",
  };
}

/**
 * 判定正文形态并抽取可解析文本。
 *
 * `.txt` 优先判：一个 `.txt` 文件即使内容里带尖括号也只是文本，不能走 HTML
 * 分支 —— 那会把用户写的 `<p>` 示例当成标签吃掉。
 */
export function adaptNoteSource(input: NoteSourceInput): NoteSource {
  const content = input.content ?? "";
  const extension = noteSourceExtension(input.relPath);

  if (extension === "txt") {
    // `.txt` 没有 ATX 语义：`allowHeading1: false` 让 `# 一行字` 落到第 4 级
    // （首行会把井号去掉），而不是被当成 Markdown 的 H1。
    const meta = readFrontmatterMeta(content);
    const body = stripFrontmatter(content);
    return withTitle(
      { body, kind: "text", linksParsable: false },
      pickTitle(body, meta, { allowHeading1: false }),
    );
  }

  if (isStoredEditorHtml(content)) {
    // frontmatter 要在**转换后**的 Markdown 上读：HTML 时代存的笔记没有
    // frontmatter，而转换可能把开头的内容变成 `---` 分隔线。
    const markdown = storedContentToMarkdown(content);
    const meta = readFrontmatterMeta(markdown);
    const body = stripFrontmatter(markdown);
    return withTitle(
      { body, kind: "html", linksParsable: true },
      pickTitle(body, meta),
    );
  }

  const meta = readFrontmatterMeta(content);
  const body = stripFrontmatter(content);
  return withTitle(
    { body, kind: "markdown", linksParsable: true },
    pickTitle(body, meta),
  );
}
