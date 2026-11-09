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
      `export { codeBlockAt, codeBlockSelectSpec, codeBlockPasteSpec, looksLikeCode, codeFenceInfoAt, codeBlockLanguageSpec } from ${JSON.stringify(
        path.join(root, "src/utils/livePreview/codeBlock.ts"),
      ).replaceAll("\\", "/")};`,
      `export { CODE_LANGUAGES } from ${JSON.stringify(
        path.join(root, "src/utils/highlight.ts"),
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

const { codeBlockAt, codeBlockSelectSpec, codeBlockPasteSpec, looksLikeCode, codeFenceInfoAt, codeBlockLanguageSpec, CODE_LANGUAGES, EditorState, ensureSyntaxTree, markdown, markdownLanguage } =
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

// -------------------------------------------------------------- codeFenceInfoAt
section("codeFenceInfoAt：语言词的三个区间");

{
  const info = (doc, pos) => {
    const value = codeFenceInfoAt(makeState(doc, pos), pos);
    if (!value) return null;
    const { from, to, infoFrom, infoTo, wordFrom, wordTo, closed } = value;
    return { from, to, infoFrom, infoTo, wordFrom, wordTo, closed, word: doc.slice(wordFrom, wordTo) };
  };

  // No info string at all: every range collapses onto the position right after
  // the opening fence, which is exactly where a language would be typed.
  check(
    "无 CodeInfo：info 与 word 都塌陷在反引号之后（3-3）",
    JSON.stringify(info("```\ncode\n```\n", 4)) ===
      JSON.stringify({ from: 0, to: 12, infoFrom: 3, infoTo: 3, wordFrom: 3, wordTo: 3, closed: true, word: "" }),
    JSON.stringify(info("```\ncode\n```\n", 4)),
  );

  // ```` ``` python ````: the parser trims, so `CodeInfo` starts after the space.
  // `infoFrom` stays at the fence end so clearing can take the space with it.
  const spaced = info("``` python\ncode\n```\n", 6);
  check(
    "` ``` python `：前导空格落在 infoFrom..wordFrom 之间",
    spaced !== null && spaced.infoFrom === 3 && spaced.wordFrom === 4 && spaced.word === "python",
    JSON.stringify(spaced),
  );

  const attrs = info('```js title="a b" hl_lines=1\ncode\n```\n', 6);
  check(
    "尾部参数：word 只覆盖 `js`，infoTo 覆盖整行 info",
    attrs !== null && attrs.word === "js" && attrs.wordFrom === 3 && attrs.wordTo === 5 && attrs.infoTo === 28,
    JSON.stringify(attrs),
  );
  check(
    "尾部参数：infoFrom..infoTo 逐字等于整段 info",
    attrs !== null && '```js title="a b" hl_lines=1\ncode\n```\n'.slice(attrs.infoFrom, attrs.infoTo) === 'js title="a b" hl_lines=1',
    JSON.stringify(attrs && '```js title="a b" hl_lines=1\ncode\n```\n'.slice(attrs.infoFrom, attrs.infoTo)),
  );

  check("闭围栏：closed === true", info("```js\n```\n", 0)?.closed === true);
  check("未闭合围栏：closed === false", info("```\nunclosed\n", 5)?.closed === false);
  check(
    "未闭合围栏：node.to 就是文档末尾（不凭空补围栏）",
    info("```\nunclosed\n", 5)?.to === "```\nunclosed\n".length,
    JSON.stringify(info("```\nunclosed\n", 5)),
  );
  check("缩进代码块：没有 fence info，返回 null", info("    indented\n    code\n", 6) === null);
  check("普通段落：返回 null", info("普通段落", 2) === null);
  check("四个反引号的围栏：word 仍只覆盖语言词", info("````js\nx\n````\n", 6)?.word === "js");
  check("波浪号围栏：别名按原样取出（py）", info("~~~py\nx\n~~~\n", 5)?.word === "py");
}

// ------------------------------------------------------------------ language
section("设语言：只换 fence info 的第一个词");

/** Apply `codeBlockLanguageSpec` and report everything the assertions need. */
function setLanguage(doc, pos, language) {
  const state = makeState(doc, pos);
  const before = codeBlockAt(state, pos);
  const spec = codeBlockLanguageSpec(state, pos, language);
  if (!spec) return { state, before, spec, tr: null, next: null, out: null, changes: [] };

  const tr = state.update(spec);
  const changes = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({ from: fromA, to: toA, removed: state.sliceDoc(fromA, toA), inserted: inserted.toString() });
  });
  const next = tr.state;
  return { state, before, spec, tr, next, out: next.doc.toString(), changes, after: codeBlockAt(next, pos) };
}

/** A change may not cross a line break: the fence line is the only line touched. */
function crossesLine(state, change) {
  return state.doc.lineAt(change.from).to < change.to;
}

const languageCases = [
  {
    name: "无 info：插入 python（贴着反引号，不加空格）",
    doc: "```\ncode\n```\n",
    pos: 4,
    lang: "python",
    out: "```python\ncode\n```\n",
  },
  {
    name: "`js` → typescript：整词替换，不是追加",
    doc: "```js\nconst a = 1;\n```\n",
    pos: 8,
    lang: "typescript",
    out: "```typescript\nconst a = 1;\n```\n",
  },
  {
    name: "`py` → 写 canonical `python`（别名不落到 fence 上）",
    doc: "```py\ncode\n```\n",
    pos: 5,
    lang: "python",
    out: "```python\ncode\n```\n",
  },
  {
    name: "null 清空：连同 word 前的分隔空格一起删",
    doc: "``` python\ncode\n```\n",
    pos: 6,
    lang: null,
    out: "```\ncode\n```\n",
  },
  {
    name: "null 清空：多个前导空格一并删净",
    doc: "```  py\ncode\n```\n",
    pos: 6,
    lang: null,
    out: "```\ncode\n```\n",
  },
  {
    name: "尾部参数：只换第一个词，`title` / `hl_lines` 原样",
    doc: '```js title="a b" hl_lines=1\ncode\n```\n',
    pos: 6,
    lang: "typescript",
    out: '```typescript title="a b" hl_lines=1\ncode\n```\n',
  },
  {
    name: "未闭合围栏：改名后仍不闭合，不新增行",
    doc: "```py\nunclosed\n",
    pos: 5,
    lang: "python",
    out: "```python\nunclosed\n",
  },
  {
    name: "波浪号围栏保留波浪号，只换词",
    doc: "~~~py\nx\n~~~\n",
    pos: 5,
    lang: "python",
    out: "~~~python\nx\n~~~\n",
  },
  {
    name: "四个反引号保留四个，只换词",
    doc: "````js\nx\n````\n",
    pos: 6,
    lang: "python",
    out: "````python\nx\n````\n",
  },
];

for (const item of languageCases) {
  const result = setLanguage(item.doc, item.pos, item.lang);

  check(`${item.name} — 产出 spec`, result.spec !== null);
  if (!result.spec) continue;

  check(
    `${item.name} — 文档逐字`,
    result.out === item.out,
    `期望 ${JSON.stringify(item.out)}\n        实际 ${JSON.stringify(result.out)}`,
  );
  check(
    `${item.name} — 正文内容逐字不变（只是整体位移）`,
    result.before !== null &&
      result.after !== null &&
      result.state.sliceDoc(result.before.contentFrom, result.before.contentTo) ===
        result.next.sliceDoc(result.after.contentFrom, result.after.contentTo),
    `${JSON.stringify(result.state.sliceDoc(result.before.contentFrom, result.before.contentTo))} → ${JSON.stringify(
      result.next.sliceDoc(result.after.contentFrom, result.after.contentTo),
    )}`,
  );
  const crosses = result.changes.filter((change) => crossesLine(result.state, change));
  check(
    `${item.name} — changes 不跨行（不越过行尾 / 换行）`,
    crosses.length === 0 && result.changes.every((c) => !c.inserted.includes("\n") && !c.removed.includes("\n")),
    JSON.stringify(result.changes),
  );
  check(
    `${item.name} — 正文长度只随插入词位移（fence 与正文未被吃掉）`,
    result.before !== null &&
      result.after !== null &&
      result.after.contentTo - result.after.contentFrom === result.before.contentTo - result.before.contentFrom,
    `${JSON.stringify(result.before)} → ${JSON.stringify(result.after)}`,
  );
  check(
    `${item.name} — 一次性单处改动`,
    result.changes.length === 1,
    JSON.stringify(result.changes),
  );
}

{
  // Idempotency: re-picking the language a fence already shows must not push an
  // undo step, or Ctrl+Z would appear dead once per click.
  const same = setLanguage("```python\ncode\n```\n", 6, "python");
  check("幂等：fence 已是 python，再选 python 返回 null", same.spec === null, JSON.stringify(same.spec));

  // Aliases are *upgraded* to the canonical spelling the menu shows — that is
  // the whole point of picking a row, and the `py` → `python` case above pins it.
  const alias = setLanguage("```js\nconst a = 1;\n```\n", 8, "javascript");
  check(
    "别名归一：fence 写 `js`，选 `javascript` 写成 canonical",
    alias.out === "```javascript\nconst a = 1;\n```\n",
    JSON.stringify(alias.out),
  );

  // Clearing an already-empty fence is a no-op, not an empty undo step.
  const emptyClear = setLanguage("```\ncode\n```\n", 4, null);
  check("幂等：无语言时清除返回 null", emptyClear.spec === null, JSON.stringify(emptyClear.spec));

  const alreadyEmpty = setLanguage("```js\n```\n", 4, null);
  check("清空空正文块同样只删语言词", alreadyEmpty.out === "```\n```\n", JSON.stringify(alreadyEmpty.out));
}

{
  // A language that is not registered must never reach the fence: the menu only
  // lists canonical names, but an unknown word would silently kill the
  // highlighting and read as "the app broke".
  const unknown = ["ruby", "brainfuck", "c#", "  "];
  for (const name of unknown) {
    const result = setLanguage("```python\ncode\n```\n", 6, name);
    check(`未注册语言 ${JSON.stringify(name)}：拒绝（返回 null）`, result.spec === null, JSON.stringify(result.spec));
  }

  // `c#` is *aliased* to `csharp`, which is not registered — having an alias
  // entry is not the same as the language being available.
  check("别名指向未注册语言同样拒绝（c# → csharp）", setLanguage("```python\ncode\n```\n", 6, "c#").spec === null);
}

{
  // Outside a fence there is nothing to rename, and the spec must decline rather
  // than write into a paragraph.
  const paragraph = setLanguage("普通段落\n", 1, "python");
  check("普通段落：返回 null 且文档不变", paragraph.spec === null && makeState("普通段落\n").doc.toString() === "普通段落\n");

  const indented = setLanguage("    indented\n    code\n", 6, "python");
  check("缩进代码块：返回 null（没有 info 可写）", indented.spec === null, JSON.stringify(indented.spec));
}

{
  // `userEvent` is what makes the change one user-intent undo group; no
  // `selection` and no `scrollIntoView`, so clicking a chip far off screen does
  // not move the caret or the viewport.
  const result = setLanguage("```js\nconst a = 1;\n```\n", 8, "python");
  check("spec 带 userEvent=input.setLanguage", result.spec?.userEvent === "input.setLanguage", JSON.stringify(result.spec?.userEvent));
  check("spec 不带 selection", result.spec?.selection === undefined, JSON.stringify(result.spec?.selection));
  check("spec 不带 scrollIntoView", result.spec?.scrollIntoView === undefined, JSON.stringify(result.spec?.scrollIntoView));
  check(
    "一次 transaction = 一步撤销",
    result.next !== null && makeState("```js\nconst a = 1;\n```\n", 8).update(result.spec).state.doc.toString() === "```python\nconst a = 1;\n```\n",
  );
}

{
  // The menu order is a contract the picker renders verbatim; deriving it from
  // the registration table is what keeps the two from drifting, so pin the order.
  const expected = [
    "bash",
    "c",
    "cpp",
    "css",
    "java",
    "javascript",
    "json",
    "markdown",
    "powershell",
    "python",
    "rust",
    "sql",
    "typescript",
    "xml",
  ];
  check(
    `CODE_LANGUAGES 顺序即菜单顺序（${expected.length} 项）`,
    JSON.stringify(CODE_LANGUAGES) === JSON.stringify(expected),
    JSON.stringify(CODE_LANGUAGES),
  );
  check(
    "CODE_LANGUAGES 与已注册语言一一对应（无漂移）",
    CODE_LANGUAGES.length === expected.length &&
      CODE_LANGUAGES.every((name) => codeBlockLanguageSpec(makeState("```\ncode\n```\n", 4), 4, name) !== null),
    JSON.stringify(CODE_LANGUAGES),
  );
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
