/**
 * Headless verification for the code-block interactions (L2).
 *
 *   node scripts/verify-code-block.mjs
 *
 * `codeBlock.ts` deliberately returns `TransactionSpec`s instead of writing to a
 * view, which is what makes the two behaviours checkable here: no editor, no key
 * event, no clipboard. Each spec is applied to a plain `EditorState` and the
 * resulting document is compared character by character — the bugs these tests
 * exist for (a fence welded onto the code line, two paragraphs eaten by one
 * paste) are all *document* changes, so they are invisible to a decoration test.
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

// ------------------------------------------------------------------ bundle
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-block-verify-"));
const outfile = path.join(tmpDir, "codeBlock.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: [
      `export { codeBlockAt, codeBlockSelectSpec, codeBlockPasteSpec, looksLikeCode } from ${JSON.stringify(
        path.join(root, "src/utils/livePreview/codeBlock.ts"),
      ).replaceAll("\\", "/")};`,
      `export { EditorState } from "@codemirror/state";`,
      `export { ensureSyntaxTree } from "@codemirror/language";`,
      `export { markdown, markdownLanguage } from "@codemirror/lang-markdown";`,
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

const { codeBlockAt, codeBlockSelectSpec, codeBlockPasteSpec, looksLikeCode, EditorState, ensureSyntaxTree, markdown, markdownLanguage } =
  await import(pathToFileURL(outfile).href);

/** Same language the editor mounts (`MarkdownSourceEditor` uses the GFM base). */
const language = markdown({ base: markdownLanguage });

function makeState(doc, anchor = 0, head = anchor) {
  const state = EditorState.create({ doc, extensions: [language], selection: { anchor, head } });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

const range = (spec) => (spec ? `${spec.selection.anchor}-${spec.selection.head}` : "null");

// ------------------------------------------------------------------ Ctrl+A
section("Ctrl+A：两段式（先选块内正文，再交回 selectAll）");

const selectCases = [
  {
    name: "围栏块：第一段只选代码正文，不含围栏",
    doc: "```js\nconst a = 1;\n```\n",
    caret: 8,
    first: "6-18",
    text: "const a = 1;",
    second: "null",
  },
  {
    name: "两行正文的围栏块",
    doc: "```\nline1\nline2\n```\n\nafter\n",
    caret: 8,
    first: "4-15",
    text: "line1\nline2",
    second: "null",
  },
  {
    name: "空正文围栏块：两段都是 null（没有东西可选，不能吞键）",
    doc: "```js\n```\n",
    caret: 0,
    first: "null",
    text: null,
    second: "null",
  },
  {
    // The regression A1 exists for: the parser gives this block a `CodeText` of
    // one bare newline. Selecting it let the next keystroke weld the closing
    // fence onto the code line and turn the rest of the note into code.
    name: "只有空行的围栏块：两段都是 null",
    doc: "```\n\n```\n",
    caret: 4,
    first: "null",
    text: null,
    second: "null",
  },
  {
    name: "普通段落：不拦截，交回默认行为",
    doc: "普通段落",
    caret: 2,
    first: "null",
    text: null,
    second: null,
  },
];

for (const item of selectCases) {
  const state = makeState(item.doc, item.caret);
  const spec = codeBlockSelectSpec(state);
  check(`${item.name} — 第一段`, range(spec) === item.first, `期望 ${item.first}，实际 ${range(spec)}`);

  if (!spec) continue;

  const next = state.update(spec).state;
  check(
    `${item.name} — 选中文本`,
    next.sliceDoc(next.selection.main.from, next.selection.main.to) === item.text,
    JSON.stringify(next.sliceDoc(next.selection.main.from, next.selection.main.to)),
  );
  check(`${item.name} — 只改选区，文档逐字不变`, next.doc.toString() === item.doc);

  const second = codeBlockSelectSpec(next);
  check(`${item.name} — 第二段`, range(second) === item.second, `期望 ${item.second}，实际 ${range(second)}`);
  if (second === null) {
    check(`${item.name} — 第二段不改文档`, next.doc.toString() === item.doc);
  }
}

// ------------------------------------------------------------------ codeBlockAt
section("codeBlockAt：正文口径（不含围栏 / 语言 / 缩进）");

{
  const cases = [
    { doc: "```js\nconst a = 1;\n```\n", pos: 8, expect: "0-22|6-18" },
    { doc: "```\ncode\n```\n", pos: 5, expect: "0-12|4-8" },
    // Empty body: no `CodeText` at all, so the gap is derived from the lines.
    { doc: "```js\n```\n", pos: 0, expect: "0-9|6-6" },
    // An unclosed fence's `CodeText` runs to the end of the document and keeps
    // the final newline; the content must not include it.
    { doc: "```\nunclosed\n", pos: 5, expect: "0-13|4-12" },
    // Two `CodeText` runs: content spans the first start to the last end.
    { doc: "    indented\n    code\n", pos: 6, expect: "4-21|4-21" },
  ];
  for (const item of cases) {
    const block = codeBlockAt(makeState(item.doc, item.pos), item.pos);
    const actual = block ? `${block.from}-${block.to}|${block.contentFrom}-${block.contentTo}` : "null";
    check(`codeBlockAt ${JSON.stringify(item.doc)}`, actual === item.expect, `期望 ${item.expect}，实际 ${actual}`);
  }
}

// ------------------------------------------------------------------ looksLikeCode
const codeTrue = [
  ["python（def / if / return）", "def greet(name):\n    if name:\n        return f\"hi {name}\"\n    return \"\""],
  ["js（function / 花括号）", "function add(a, b) {\n  return a + b;\n}"],
  ["shell（git 三行）", "git status\ngit add .\ngit commit -m \"init\""],
  ["json（含 {}）", '{\n  "name": "qing",\n  "version": "1.0.0"\n}'],
  // Keyword lines score 1 each (capped at 3), so a bare multi-line query clears
  // the threshold on its leading keywords alone — no punctuation needed.
  ["sql（裸三行 SELECT / FROM / WHERE，无分号）", "SELECT id, name\nFROM notes\nWHERE deleted = 0"],
  ["sql（带分号）", "SELECT id, name\nFROM notes\nWHERE deleted = 0;"],
  // Low-ambiguity keywords are unconditional: this run has no brackets, no
  // punctuation and no indent, and must still pass (the regression A would have
  // caused if every keyword needed a "code shape").
  ["python import 三行（无标点无缩进）", "import os\nimport sys\nprint(sys.argv)"],
  ["html（<div> 三行）", '<div class="card">\n  <span>hi</span>\n</div>'],
  ["四行带缩进 python", "for i in range(3):\n    print(i)\n    if i > 1:\n        break"],
];

const codeFalse = [
  ["三行中文散文", "今天天气很好。\n我们去公园散步。\n然后回家吃饭。"],
  ["三行英文散文", "The weather was good today.\nWe walked in the park.\nThen we went home."],
  // High-ambiguity keywords without a code shape: these two are the false
  // positives that per-line keyword scoring introduced, pinned so they cannot
  // come back.
  ["英文散文（行首 if/for/while）", "if you read the docs\nfor a moment it seemed fine\nwhile the tests ran"],
  ["英文散文（行首 type/new/class）", "type the name here\nnew file created already\nclass of 2024 starts soon"],
  ["Markdown 无序列表", "- 甲\n- 乙\n- 丙"],
  ["Markdown 表格", "| 名 | 值 |\n| --- | --- |\n| a | 1 |"],
  ["Markdown 标题块", "# 标题\n## 二级\n正文"],
  ["两行英文", "hello\nworld"],
  ["已经是围栏块的文本", "```js\nconst a = 1;\n```"],
  ["三行中文技术句", "这个函数接受一个参数。\n它返回计算结果。\n调用方需要处理异常。"],
];

section(`looksLikeCode：${codeTrue.length + codeFalse.length} 组判据（真 ${codeTrue.length} / 假 ${codeFalse.length}）`);

for (const [name, text] of codeTrue) {
  check(`true ← ${name}`, looksLikeCode(text) === true, JSON.stringify(text));
}
for (const [name, text] of codeFalse) {
  check(`false ← ${name}`, looksLikeCode(text) === false, JSON.stringify(text));
}

// ------------------------------------------------------------------ paste
section("粘贴：代码形状的文本转成一个围栏块");

const CODE = 'const cache = new Map();\nfunction get(key) {\n  return cache.get(key);\n}';
const CODE_LAST_LINE = "}";

/** Paste at a plain caret/selection and return the applied state plus the spec. */
function paste(doc, text, anchor, head = anchor) {
  const state = makeState(doc, anchor, head);
  const spec = codeBlockPasteSpec(state, text);
  return { state, spec, next: spec ? state.update(spec).state : null };
}

{
  // Caret at the end of an existing paragraph: the fence has to start on a line
  // of its own, so a blank line is opened first.
  const doc = "前言\n\n甲乙\n\n后续";
  const caret = doc.indexOf("甲乙") + 2;
  const { spec, next } = paste(doc, CODE, caret);
  check("段落末尾：产出围栏", spec !== null);
  if (spec && next) {
    const out = next.doc.toString();
    check("段落末尾：围栏前有空行", out.includes("甲乙\n\n```\n"), JSON.stringify(out));
    check("段落末尾：围栏后有空行", out.includes("```\n\n后续"), JSON.stringify(out));
    check("段落末尾：原段落未被吃掉", out.startsWith("前言\n\n甲乙") && out.endsWith("后续"), JSON.stringify(out));
    const at = spec.selection.anchor;
    check("段落末尾：光标在代码末行之后", next.doc.lineAt(at).to === at && next.doc.lineAt(at).text === CODE_LAST_LINE);
  }
}

{
  // Caret at the start of a paragraph: the fence goes above it, the paragraph is
  // pushed below the closing fence instead of being replaced.
  const doc = "甲乙\n\n后续";
  const { spec, next } = paste(doc, CODE, 0);
  check("段落行首：产出围栏", spec !== null);
  if (spec && next) {
    const out = next.doc.toString();
    check("段落行首：围栏在最前", out.startsWith("```\n"), JSON.stringify(out));
    check("段落行首：原段落被推到围栏之后", out.includes("```\n\n甲乙\n\n后续"), JSON.stringify(out));
    const at = spec.selection.anchor;
    check("段落行首：光标在代码末行之后", next.doc.lineAt(at).to === at && next.doc.lineAt(at).text === CODE_LAST_LINE);
  }
}

{
  const { spec, next } = paste("", CODE, 0);
  check("空文档：产出围栏", spec !== null);
  if (spec && next) {
    check(
      "空文档：不多插空行",
      next.doc.toString() === `\`\`\`\n${CODE}\n\`\`\``,
      JSON.stringify(next.doc.toString()),
    );
  }
}

{
  const refused = [
    ["列表项内", "- 甲\n", 3],
    ["引用内", "> 引用\n", 3],
    ["标题内", "# 标题\n", 3],
    ["表格内", "| a |\n| --- |\n| 1 |\n", 2],
    ["既有围栏内", "```\n甲\n```\n", 5],
  ];
  for (const [name, doc, caret] of refused) {
    const { spec } = paste(doc, CODE, caret);
    check(`${name}：拒绝（交回默认粘贴）`, spec === null, JSON.stringify(spec));
  }
}

{
  // A2: two paragraphs selected → the blank line between them and the second
  // paragraph would be swallowed by a single fence.
  const doc = "para one\n\npara two";
  const { spec } = paste(doc, CODE, 2, 12);
  check("跨块选区 2..12：拒绝", spec === null, JSON.stringify(spec));

  // The same paragraph, selected whole, is still allowed: the fence replaces
  // text the user actually selected.
  const same = paste("para one", CODE, 2, 6);
  check("同一段落内选区：仍然产出围栏", same.spec !== null, JSON.stringify(same.spec));
}

{
  const prose = "今天天气很好。\n我们去公园散步。\n然后回家吃饭。";
  const { spec } = paste("甲乙", prose, 2);
  check("散文粘贴：拒绝", spec === null, JSON.stringify(spec));
}

// ------------------------------------------------------------------ fence
section("围栏：比正文里最长的反引号串多一个");

{
  const withThree = 'const a = "```";\nfunction f() {\n  return a;\n}';
  const withFour = 'const b = "````";\nfunction g() {\n  return b;\n}';
  // Pasting into an empty document puts the opening fence on line 1.
  const openFenceOf = (text) => {
    const { next } = paste("", text, 0);
    return next ? next.doc.lineAt(0).text : "null";
  };
  check("正文含三连反引号 → 外层 4 个", openFenceOf(withThree) === "````", openFenceOf(withThree));
  check("正文含四连反引号 → 外层 5 个", openFenceOf(withFour) === "`````", openFenceOf(withFour));
  check("正文不含反引号 → 外层 3 个", openFenceOf(CODE) === "```", openFenceOf(CODE));
}

// ------------------------------------------------------------------ annotation
section("annotation 与纯函数");

{
  const { spec } = paste("甲乙", CODE, 2);
  check("spec 带 userEvent=input.paste", spec?.userEvent === "input.paste", JSON.stringify(spec?.userEvent));
}

{
  const state = makeState("```js\nconst a = 1;\n```\n", 8);
  const first = codeBlockAt(state, 8);
  const second = codeBlockAt(state, 8);
  check(
    "同一 state 连调两次 codeBlockAt 结果相同",
    JSON.stringify(first) === JSON.stringify(second),
    `${JSON.stringify(first)} vs ${JSON.stringify(second)}`,
  );
  check("codeBlockAt 只读文档", state.doc.toString() === "```js\nconst a = 1;\n```\n");
}

// ------------------------------------------------------------------ summary
section("结果");
console.log(`  ${checks} 项检查 · ${failures} 项失败`);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) process.exitCode = 1;
