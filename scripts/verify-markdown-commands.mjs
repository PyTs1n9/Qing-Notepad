/**
 * Headless verification for the Markdown command layer.
 *
 *   node scripts/verify-markdown-commands.mjs
 *
 * Every command is a pure function from an editor state to a `TransactionSpec`,
 * so each case here is "document + selection in → document + caret out". The
 * menu and the keymap both call these functions, so a green run means both
 * paths produce the same edit — no DOM, no view, no key events involved.
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
const show = (text) => JSON.stringify(text);

// ------------------------------------------------------------------ bundle
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-commands-verify-"));
const outfile = path.join(tmpDir, "markdownCommands.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: [
      `export {
        setHeading,
        toggleQuote,
        toggleList,
        insertCodeBlock,
        insertHorizontalRule,
        insertLink,
        inlineWrap,
        insertParagraph,
        markdownCommandSource,
      } from ${JSON.stringify(path.join(root, "src/utils/markdownCommands.ts")).replaceAll("\\", "/")};`,
      `export { EditorState } from "@codemirror/state";`,
      `export { isolateHistory } from "@codemirror/commands";`,
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
    sourcefile: "verify-entry.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent",
});

const {
  setHeading,
  toggleQuote,
  toggleList,
  insertCodeBlock,
  insertHorizontalRule,
  insertLink,
  inlineWrap,
  insertParagraph,
  markdownCommandSource,
  EditorState,
  isolateHistory,
} = await import(pathToFileURL(outfile).href);

function stateFor(doc, caret) {
  return EditorState.create({
    doc,
    selection: typeof caret === "number" ? { anchor: caret } : caret,
  });
}

/**
 * `caret` is a number (collapsed) or `{ anchor, head }`. `expect.head` is
 * optional: multi-line commands leave the selection to CodeMirror's mapping, and
 * asserting an arbitrary mapped offset would test the mapping, not the command.
 */
const cases = [
  // ---------------------------------------------------------------- headings
  { name: "正文 → 一级标题", run: (s) => setHeading(s, 1), doc: "你好", caret: 2, expect: { doc: "# 你好", head: 4 } },
  { name: "二级标题 → 一级标题", run: (s) => setHeading(s, 1), doc: "## 标题", caret: 5, expect: { doc: "# 标题", head: 4 } },
  { name: "一级标题再按一次 → 正文", run: (s) => setHeading(s, 1), doc: "# 标题", caret: 4, expect: { doc: "标题", head: 2 } },
  { name: "二级标题再按一次 → 正文", run: (s) => setHeading(s, 2), doc: "## 标题", caret: 5, expect: { doc: "标题", head: 2 } },
  { name: "二级 → 三级", run: (s) => setHeading(s, 3), doc: "## 标题", caret: 5, expect: { doc: "### 标题", head: 6 } },
  { name: "无空格的 #标题 当正文前缀", run: (s) => setHeading(s, 1), doc: "#标题", caret: 3, expect: { doc: "# #标题", head: 5 } },
  { name: "行首缩进被抹平", run: (s) => setHeading(s, 2), doc: "  正文", caret: 4, expect: { doc: "## 正文", head: 5 } },
  { name: "正文按 Ctrl+0 不动", run: (s) => setHeading(s, 0), doc: "正文", caret: 1, expect: null },
  { name: "标题按 Ctrl+0 变正文", run: (s) => setHeading(s, 0), doc: "# 标题", caret: 0, expect: { doc: "标题", head: 0 } },
  {
    name: "多行选区逐行加标题",
    run: (s) => setHeading(s, 2),
    doc: "甲\n乙",
    caret: { anchor: 0, head: 3 },
    expect: { doc: "## 甲\n## 乙" },
  },
  {
    name: "多行选区跳过空行",
    run: (s) => setHeading(s, 1),
    doc: "甲\n\n乙",
    caret: { anchor: 0, head: 4 },
    expect: { doc: "# 甲\n\n# 乙" },
  },

  // --------------------------------------------------------------- blockquote
  { name: "正文 → 引用", run: toggleQuote, doc: "文字", caret: 0, expect: { doc: "> 文字", head: 2 } },
  { name: "引用 → 正文", run: toggleQuote, doc: "> 文字", caret: 4, expect: { doc: "文字", head: 2 } },
  { name: "嵌套引用退一级", run: toggleQuote, doc: "> > 文字", caret: 6, expect: { doc: "> 文字", head: 4 } },
  {
    name: "多行选区整体加引用",
    run: toggleQuote,
    doc: "第一行\n第二行",
    caret: { anchor: 0, head: 7 },
    expect: { doc: "> 第一行\n> 第二行" },
  },
  {
    name: "多行选区整体去引用",
    run: toggleQuote,
    doc: "> 第一行\n> 第二行",
    caret: { anchor: 0, head: 11 },
    expect: { doc: "第一行\n第二行" },
  },

  // -------------------------------------------------------------------- lists
  { name: "正文 → 无序列表", run: (s) => toggleList(s, "bullet"), doc: "文字", caret: 0, expect: { doc: "- 文字", head: 2 } },
  { name: "无序列表 → 正文", run: (s) => toggleList(s, "bullet"), doc: "- 文字", caret: 4, expect: { doc: "文字", head: 2 } },
  {
    name: "多行选区编有序号",
    run: (s) => toggleList(s, "ordered"),
    doc: "甲\n乙",
    caret: { anchor: 0, head: 3 },
    expect: { doc: "1. 甲\n2. 乙" },
  },
  {
    name: "无序 → 有序保留缩进",
    run: (s) => toggleList(s, "ordered"),
    doc: "  - 甲",
    caret: 5,
    expect: { doc: "  1. 甲" },
  },
  { name: "任务项转普通列表", run: (s) => toggleList(s, "bullet"), doc: "- [ ] 待办", caret: 8, expect: { doc: "- 待办", head: 4 } },
  { name: "正文 → 任务列表", run: (s) => toggleList(s, "task"), doc: "待办", caret: 2, expect: { doc: "- [ ] 待办", head: 8 } },
  { name: "任务列表再按一次 → 正文", run: (s) => toggleList(s, "task"), doc: "- [ ] 待办", caret: 8, expect: { doc: "待办", head: 2 } },

  // --------------------------------------------------------------- code block
  {
    name: "空文档插入围栏，光标落在正文行",
    run: insertCodeBlock,
    doc: "",
    caret: 0,
    expect: { doc: "```\n\n```", head: 4 },
  },
  {
    name: "行中插入先把围栏断到新行",
    run: insertCodeBlock,
    doc: "正文",
    caret: 2,
    expect: { doc: "正文\n```\n\n```", head: 7 },
  },
  {
    name: "选中文字包进围栏",
    run: insertCodeBlock,
    doc: "文字",
    caret: { anchor: 0, head: 2 },
    expect: { doc: "```\n文字\n```", head: 10 },
  },
  {
    name: "行中插入围栏不吞掉后半行",
    run: insertCodeBlock,
    doc: "abcdef",
    caret: 3,
    expect: { doc: "abcdef\n```\n\n```", head: 11 },
  },
  {
    name: "行中选区围栏两侧都断开",
    run: insertCodeBlock,
    doc: "abcdef",
    caret: { anchor: 3, head: 5 },
    expect: { doc: "abc\n```\nde\n```\nf", head: 15 },
  },

  // ----------------------------------------------------------- horizontal rule
  {
    name: "段落下方插分割线先留空行",
    run: insertHorizontalRule,
    doc: "正文",
    caret: 2,
    expect: { doc: "正文\n\n---\n", head: 8 },
  },
  { name: "空行插分割线", run: insertHorizontalRule, doc: "", caret: 0, expect: { doc: "---\n", head: 4 } },

  // --------------------------------------------------------------------- link
  { name: "空选区插链接", run: insertLink, doc: "", caret: 0, expect: { doc: "[]()", head: 1 } },
  {
    name: "选区变链接并选中占位 url",
    run: insertLink,
    doc: "文字",
    caret: { anchor: 0, head: 2 },
    expect: { doc: "[文字](url)", head: 8 },
  },

  // -------------------------------------------------------------- inline wrap
  {
    name: "选中文字加粗",
    run: (s) => inlineWrap(s, "**"),
    doc: "文字",
    caret: { anchor: 0, head: 2 },
    expect: { doc: "**文字**", head: 4 },
  },
  {
    name: "已加粗则取消",
    run: (s) => inlineWrap(s, "**"),
    doc: "**粗体**",
    caret: { anchor: 2, head: 4 },
    expect: { doc: "粗体", head: 2 },
  },
  {
    name: "连标记一起选中也能取消",
    run: (s) => inlineWrap(s, "**"),
    doc: "**粗**",
    caret: { anchor: 0, head: 5 },
    expect: { doc: "粗", head: 1 },
  },
  { name: "空光标插成对标记", run: (s) => inlineWrap(s, "*"), doc: "", caret: 0, expect: { doc: "**", head: 1 } },
  {
    name: "删除线包裹",
    run: (s) => inlineWrap(s, "~~"),
    doc: "文字",
    caret: { anchor: 0, head: 2 },
    expect: { doc: "~~文字~~", head: 4 },
  },
  {
    name: "行内代码包裹",
    run: (s) => inlineWrap(s, "`"),
    doc: "code",
    caret: { anchor: 0, head: 4 },
    expect: { doc: "`code`", head: 5 },
  },

  // -------------------------------------------------------- insert paragraph
  { name: "在上方插入空行", run: (s) => insertParagraph(s, "above"), doc: "文字", caret: 1, expect: { doc: "\n文字", head: 0 } },
  { name: "在下方插入空行", run: (s) => insertParagraph(s, "below"), doc: "文字", caret: 1, expect: { doc: "文字\n", head: 3 } },
];

section("markdownCommands");
for (const item of cases) {
  let state;
  try {
    state = stateFor(item.doc, item.caret);
  } catch (error) {
    check(item.name, false, `构造 state 失败：${error.message}`);
    continue;
  }

  const spec = item.run(state);
  if (item.expect === null) {
    check(item.name, spec === null, spec === null ? undefined : `期望不改动，实际 ${show(spec.changes)}`);
    continue;
  }
  if (!spec) {
    check(item.name, false, "期望产生事务，实际返回 null");
    continue;
  }

  const transaction = state.update(spec);
  const doc = transaction.state.doc.toString();
  const head = transaction.state.selection.main.head;
  const problems = [];
  if (doc !== item.expect.doc) problems.push(`文档 ${show(doc)} ≠ ${show(item.expect.doc)}`);
  if (item.expect.head !== undefined && head !== item.expect.head) {
    problems.push(`光标 ${head} ≠ ${item.expect.head}`);
  }
  if (!transaction.docChanged) problems.push("事务没有改动文档");
  if (!transaction.annotation(markdownCommandSource)) problems.push("缺少 markdownCommandSource");
  if (transaction.annotation(isolateHistory) !== "full") problems.push("缺少 isolateHistory");
  check(item.name, problems.length === 0, problems.join("；"));
}

// --------------------------------------------------------------- idempotence
section("不变量");

{
  // Applying the same heading twice must return to the paragraph, so the command
  // is reversible by keyboard rather than only by undo.
  const state = stateFor("正文", 2);
  const once = state.update(setHeading(state, 3)).state;
  const twice = once.update(setHeading(once, 3)).state;
  check(
    "同一级别按两次回到正文",
    twice.doc.toString() === "正文",
    `实际 ${show(twice.doc.toString())}`,
  );
}

{
  // Prefix commands must never touch line content, only the marker in front.
  const doc = "## 带 **粗体** 的标题";
  const state = stateFor(doc, 0);
  const next = state.update(setHeading(state, 6)).state.doc.toString();
  check(
    "改级别不动行内内容",
    next === "###### 带 **粗体** 的标题",
    `实际 ${show(next)}`,
  );
}

{
  // One command = one undo step.
  const state = stateFor("甲\n乙\n丙", { anchor: 0, head: 5 });
  const transaction = state.update(setHeading(state, 1));
  check(
    "多行命令只产生一个事务",
    transaction.state.doc.toString() === "# 甲\n# 乙\n# 丙",
    `实际 ${show(transaction.state.doc.toString())}`,
  );
}

section("结果");
console.log(`  ${checks} 项检查 · ${failures} 项失败`);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) process.exitCode = 1;
