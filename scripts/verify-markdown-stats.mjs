/**
 * Headless verification for the status bar's statistics and the outline.
 *
 *   node scripts/verify-markdown-stats.mjs
 *
 * Both are pure functions over the Markdown buffer, so every case is
 * "source in → numbers out". The four counters have to describe the *visible*
 * text: counting `###` or a link URL is the defect this suite exists to catch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let checks = 0;
let failures = 0;

function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
}

const section = (title) => console.log(`\n${title}`);
const show = (value) => JSON.stringify(value);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-stats-verify-"));
const outfile = path.join(tmpDir, "stats.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: `export { computeMarkdownStats, toVisibleText, stripInlineMarkdown } from "./src/utils/markdownStats.ts";
export { extractOutline } from "./src/utils/noteOutline.ts";`,
    resolveDir: root,
    loader: "ts",
    sourcefile: "stats-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
  // `@/` alias, mirroring tsconfig paths.
  alias: { "@": path.join(root, "src") },
});

const { computeMarkdownStats, toVisibleText, stripInlineMarkdown, extractOutline } = await import(
  pathToFileURL(outfile).href
);

const stats = (source) => computeMarkdownStats(source);

// ------------------------------------------------------------------- lines
section("行数");
check("空文档记 0 行", stats("").lines === 0, show(stats("")));
check("单行记 1 行", stats("# 标题").lines === 1);
check("三行记 3 行", stats("a\nb\nc").lines === 3);
check("结尾换行仍算一个空行", stats("a\n").lines === 2, show(stats("a\n")));
check("CRLF 折成一行", stats("a\r\nb").lines === 2);

// -------------------------------------------------------------------- 字数
section("字数（CJK 汉字）");
check("两个汉字", stats("# 标题").cjk === 2, show(stats("# 标题")));
check("英文不计入字数", stats("hello world").cjk === 0);
check("汉字与英文混排", stats("写 Hello 字").cjk === 2);
check("扩展 A 区汉字也计入", stats("\u3400\u3401").cjk === 2);

// -------------------------------------------------------------------- 词数
section("词数（西文单词与数字）");
check("两个单词", stats("hello world").words === 2, show(stats("hello world")));
check("汉字不重复计为词", stats("中文 word").words === 1);
check("数字串算一个词", stats("2026 年 11 月").words === 2);
check("带连字符的词算一个", stats("state-of-the-art").words === 1);

// ------------------------------------------------------------------ 字符数
section("字符数（可见字符，含空格不含换行）");
check("两个汉字两个字符", stats("标题").chars === 2);
check("空格计入", stats("a b").chars === 3, show(stats("a b")));
check("换行不计入", stats("a\nb").chars === 2);

// ------------------------------------------------------------- Markdown 标记
section("Markdown 标记不计入");
check(
  "标题的 # 不算字符",
  stats("### 标题").chars === 2,
  show(stats("### 标题")),
);
check(
  "粗体标记被剥掉",
  stats("**bold**").chars === 4 && stats("**bold**").words === 1,
  show(stats("**bold**")),
);
check(
  "链接只留文字，URL 不算",
  stats("[文档](https://example.com/a/b)").chars === 2 &&
    stats("[文档](https://example.com/a/b)").words === 0,
  show(stats("[文档](https://example.com/a/b)")),
);
check(
  "图片只留 alt",
  stats("![示意图](attachment://a.png)").cjk === 3,
  show(stats("![示意图](attachment://a.png)")),
);
check("分隔线不算字符", stats("---").chars === 0, show(stats("---")));
check(
  "表格分隔行不算，单元格文字照算",
  stats("| a | b |\n| --- | --- |\n| 1 | 2 |").words === 4,
  show(stats("| a | b |\n| --- | --- |\n| 1 | 2 |")),
);
check(
  "列表与任务框标记剥掉",
  stats("- [ ] 写周报").cjk === 3,
  show(stats("- [ ] 写周报")),
);
check(
  "引用标记剥掉",
  stats("> 引用一句").cjk === 4,
  show(stats("> 引用一句")),
);
check(
  "行内代码保留内容",
  stats("`const`").words === 1 && stats("`const`").chars === 5,
  show(stats("`const`")),
);

// ---------------------------------------------------------------- 代码围栏
section("代码围栏");
const fenced = "```\nconst a = 1;\n```";
check("围栏行本身不算字符", stats(fenced).chars === 12, show(stats(fenced)));
check("围栏内文字照算", stats(fenced).words === 3, show(stats(fenced)));
check(
  "围栏内的 # 不进目录",
  extractOutline("```\n# 不是标题\n```").length === 0,
);
check(
  "未闭合的围栏一直吃到文末",
  extractOutline("```\n# 也不是标题").length === 0,
);
check(
  "~~~ 与 ``` 各自成对",
  extractOutline("~~~\n# 不是\n~~~\n# 是\n").length === 1,
  show(extractOutline("~~~\n# 不是\n~~~\n# 是\n")),
);

// ---------------------------------------------------------------- front matter
section("Front matter");
const withFrontMatter = "---\ntitle: 测试\n---\n正文";
check("front matter 不计入字数", stats(withFrontMatter).cjk === 2, show(stats(withFrontMatter)));
check("front matter 不改变行号基数", stats(withFrontMatter).lines === 4, show(stats(withFrontMatter)));

// ------------------------------------------------------------------- 目录
section("目录抽取");
const outline = extractOutline(
  ["# 一", "", "正文", "", "## 二", "```", "# 代码里的", "```", "### 三", "#### 四"].join("\n"),
);
check("标题数量正确", outline.length === 4, show(outline));
check(
  "行号是 0 起的原文行号",
  outline.map((item) => item.line).join(",") === "0,4,8,9",
  show(outline.map((item) => item.line)),
);
check(
  "级别正确",
  outline.map((item) => item.level).join(",") === "1,2,3,4",
  show(outline.map((item) => item.level)),
);
check("标题文字去掉行内标记", extractOutline("## **重点** 章节")[0].text === "重点 章节");
check("结尾的 # 被去掉", extractOutline("## 标题 ##")[0].text === "标题");
check("空标题不列出", extractOutline("#").length === 0);
check("Setext 一级标题", extractOutline("标题\n===")[0].level === 1);
check("Setext 二级标题", extractOutline("标题\n---")[0].level === 2);
check("空行后的 --- 是分隔线不是标题", extractOutline("段落\n\n---").length === 0);

// ------------------------------------------------------------------ 可见文本
section("可见文本");
check("链接留下文字", toVisibleText("[文字](http://a.com)") === "文字", show(toVisibleText("[文字](http://a.com)")));
check("行内标记被剥掉", stripInlineMarkdown("~~删~~") === "删");

// ---------------------------------------------------------------------- 汇总
console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
