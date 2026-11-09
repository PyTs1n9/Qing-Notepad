/**
 * Headless verification for the live preview (L1) decoration specs.
 *
 *   node scripts/verify-live-preview.mjs
 *
 * The browser harness (`preview-live-preview.html`, screenshotted with headless
 * Edge) proves what the CSS paints. This script proves the parts a screenshot
 * cannot show: which offsets get decorated, that nothing outside the given
 * viewport ranges is touched, and that the document is never modified.
 *
 * Specs are compared as strings — `hide:0-2`, `mark:2-4:cm-md-strong`,
 * `line:0:cm-md-h1` — so a mismatch reads as positions, not as objects.
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-preview-verify-"));
const outfile = path.join(tmpDir, "livePreview.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: [
      `export { collectLivePreviewRanges, buildLivePreviewDecorations, toDecorationRanges } from ${JSON.stringify(
        path.join(root, "src/utils/livePreview/decorations.ts"),
      ).replaceAll("\\", "/")};`,
      `export { blocks, blockAt, blockAtPosition } from ${JSON.stringify(
        path.join(root, "src/utils/editorBlocks.ts"),
      ).replaceAll("\\", "/")};`,
      `export { collectTableSpecs } from ${JSON.stringify(
        path.join(root, "src/utils/livePreview/tableField.ts"),
      ).replaceAll("\\", "/")};`,
      `export { encodeCellText } from ${JSON.stringify(
        path.join(root, "src/utils/livePreview/tableWidget.ts"),
      ).replaceAll("\\", "/")};`,
      `export { EditorState, Text } from "@codemirror/state";`,
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

const {
  collectLivePreviewRanges,
  buildLivePreviewDecorations,
  toDecorationRanges,
  blocks,
  blockAt,
  blockAtPosition,
  collectTableSpecs,
  encodeCellText,
  EditorState,
  ensureSyntaxTree,
  markdown,
  markdownLanguage,
} = await import(pathToFileURL(outfile).href);

/** Same language the editor mounts (`MarkdownSourceEditor` uses the GFM base). */
const language = markdown({ base: markdownLanguage });

function specsFor(doc, ranges, options) {
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);
  const specs = collectLivePreviewRanges(state, ranges ?? [{ from: 0, to: doc.length }], options);
  return { state, specs };
}

const format = (spec) => {
  if (spec.kind === "line") return `line:${spec.from}:${spec.className}`;
  if (spec.kind === "widget") {
    const box = spec.className === "cm-md-task" ? (spec.checked ? ":x" : ":o") : "";
    return `widget:${spec.from}-${spec.to}:${spec.className}:${spec.text}${box}`;
  }
  return `${spec.kind}:${spec.from}-${spec.to}:${spec.className ?? ""}`;
};

const formatted = (doc, ranges) => specsFor(doc, ranges).specs.map(format);

// ------------------------------------------------------------------ fixtures
const fixtures = [
  {
    name: "粗体：两段 ** 隐藏，内容加粗",
    doc: "**粗体**\n",
    expect: ["hide:0-2:", "mark:2-4:cm-md-strong", "hide:4-6:"],
  },
  {
    name: "斜体：单 * 隐藏",
    doc: "*斜体*\n",
    expect: ["hide:0-1:", "mark:1-3:cm-md-em", "hide:3-4:"],
  },
  {
    name: "删除线：~~ 隐藏",
    doc: "~~删除~~\n",
    expect: ["hide:0-2:", "mark:2-4:cm-md-strike", "hide:4-6:"],
  },
  {
    name: "行内代码：反引号隐藏，内容成 chip",
    doc: "`code`\n",
    expect: ["hide:0-1:", "mark:1-5:cm-md-code", "hide:5-6:"],
  },
  {
    name: "链接：只保留 label，目的地址整段隐藏",
    doc: "[文本](https://a.b)\n",
    expect: [
      "hide:0-1:",
      "mark:1-3:cm-md-link",
      "hide:3-4:",
      "hide:4-5:",
      "hide:5-16:",
      "hide:16-17:",
    ],
  },
  {
    name: "嵌套：***粗斜*** 两层标记分别隐藏",
    doc: "***粗斜***\n",
    // Outer Emphasis hides the single `*` on each side, inner Strong hides `**`.
    expect: ["hide:0-1:", "hide:1-3:", "mark:1-7:cm-md-em", "mark:3-5:cm-md-strong", "hide:5-7:", "hide:7-8:"],
  },
  {
    name: "标题：按级别加行样式，`#` 与后随空格一并隐藏",
    doc: "# 一级\n\n## 二级\n\n###### 六级\n",
    expect: [
      "line:0:cm-md-h1",
      "hide:0-2:",
      "line:6:cm-md-h2",
      "hide:6-9:",
      "line:13:cm-md-h6",
      "hide:13-20:",
    ],
  },
  {
    // The `===` underline is a HeaderMark on the next line; hiding it would
    // leave an empty line where it used to be, so Setext keeps its underline.
    name: "Setext 标题：只加行样式，不隐藏下划线",
    doc: "标题\n===\n",
    expect: ["line:0:cm-md-h1"],
  },
  {
    name: "引用：左侧竖线加在每一行，`>` 与后随空格隐藏",
    doc: "> 引用一\n> 引用二\n",
    expect: ["line:0:cm-md-quote", "hide:0-2:", "line:6:cm-md-quote", "hide:6-8:"],
  },
  {
    // First/last lines carry their own class so CSS can round the card, and each
    // token becomes a mark whose class is the highlighter's own (`hljs-*`) — the
    // same palette the preview renderer emits. Nothing is hidden inside a fence.
    name: "围栏代码块：卡片首末行 + 语言标签 + 语法高亮",
    doc: "```js\nconst a = 1;\n\nconst b = 2;\n```\n",
    expect: [
      "line:0:cm-md-code-block cm-md-code-first",
      "mark:3-5:cm-md-code-info",
      "line:6:cm-md-code-block",
      "mark:6-11:hljs-keyword",
      "mark:16-17:hljs-number",
      "line:19:cm-md-code-block",
      "line:20:cm-md-code-block",
      "mark:20-25:hljs-keyword",
      "mark:30-31:hljs-number",
      "line:33:cm-md-code-block cm-md-code-last",
    ],
  },
  {
    name: "分隔线：隐藏 --- 并画线",
    doc: "---\n",
    expect: ["line:0:cm-md-hr", "hide:0-3:"],
  },
  {
    name: "无序列表：`-` 隐藏并渲染圆点，嵌套换字形",
    doc: "- 甲\n  - 乙\n",
    expect: ["widget:0-2:cm-md-bullet:•", "widget:6-8:cm-md-bullet:◦"],
  },
  {
    // The source says 1. three times; the reader must see 1. 2. 3.
    name: "有序列表：渲染递增序号，不是复现源数字",
    doc: "1. 甲\n1. 乙\n1. 丙\n",
    expect: [
      "widget:0-3:cm-md-ordered:1.",
      "widget:5-8:cm-md-ordered:2.",
      "widget:10-13:cm-md-ordered:3.",
    ],
  },
  {
    name: "有序列表：起始号 3 从 3 递增，`1)` 保留右括号",
    doc: "3) 甲\n9) 乙\n",
    expect: ["widget:0-3:cm-md-ordered:3)", "widget:5-8:cm-md-ordered:4)"],
  },
  {
    name: "任务列表：`- ` 隐藏，`[ ]`/`[x]` 渲染成复选框",
    doc: "- [ ] 甲\n- [x] 乙\n",
    expect: ["hide:0-2:", "widget:2-6:cm-md-task::o", "hide:8-10:", "widget:10-14:cm-md-task::x"],
  },
];

section("夹具：行内标记与块级行样式");

for (const fixture of fixtures) {
  const actual = formatted(fixture.doc);
  const detail =
    JSON.stringify(actual) === JSON.stringify(fixture.expect)
      ? undefined
      : [`期望 ${JSON.stringify(fixture.expect)}`, `实际 ${JSON.stringify(actual)}`].join("\n        ");
  check(fixture.name, detail === undefined, detail);
}

section("围栏代码块：语言标签（cm-md-code-info）");

{
  const labelled = "```js\nconst a = 1;\n```\n";
  const specs = formatted(labelled);
  check("含语言名：产出 info mark", specs.includes("mark:3-5:cm-md-code-info"), JSON.stringify(specs));

  const bare = formatted("```\ncode\n```\n");
  check(
    "无语言名：不产出 info mark",
    !bare.some((spec) => spec.endsWith(":cm-md-code-info")),
    JSON.stringify(bare),
  );

  // The label is emitted before the highlight pass on purpose: an empty body has
  // no `CodeText`, and `addCodeHighlight` returns on exactly that.
  const empty = formatted("```js\n```\n");
  check("空正文：info mark 仍在", empty.includes("mark:3-5:cm-md-code-info"), JSON.stringify(empty));
  check(
    "空正文：没有任何 hljs 高亮",
    !empty.some((spec) => spec.includes("hljs-")),
    JSON.stringify(empty),
  );

  // Revealing the block (caret inside) drops hides and widgets, never marks —
  // the label has to survive being edited, like the token colours do.
  const state = EditorState.create({ doc: labelled, extensions: [language] });
  ensureSyntaxTree(state, labelled.length, 5000);
  const caretBlock = blockAtPosition(state, 8);
  const revealed = specsFor(labelled, null, { reveal: caretBlock }).specs.map(format);
  check("光标在块内（reveal）时 info mark 仍在", revealed.includes("mark:3-5:cm-md-code-info"), JSON.stringify(revealed));
}

// ------------------------------------------------------------------ invariants
section("不变量");

{
  const doc = "# 标题\n\n正文 **粗** 与 `码`。\n\n> 引用\n\n- 甲\n- 乙\n\n```\ncode\n```\n\n---\n";
  const { state, specs } = specsFor(doc);

  const bad = specs.filter((spec) => {
    if (spec.from < 0 || spec.from > doc.length) return true;
    if (spec.kind === "line") return false;
    if (spec.to > doc.length || spec.to <= spec.from) return true;
    return spec.kind === "mark" && !spec.className;
  });
  check("区间合法（0 ≤ from < to ≤ 长度）", bad.length === 0, JSON.stringify(bad.slice(0, 3)));

  const lineStarts = new Set();
  let offset = 0;
  for (const line of doc.split("\n")) {
    lineStarts.add(offset);
    offset += line.length + 1;
  }
  const badLines = specs.filter((spec) => spec.kind === "line" && !lineStarts.has(spec.from));
  check("line 装饰一律落在行首", badLines.length === 0, JSON.stringify(badLines.slice(0, 3)));

  const sorted = specs.every((spec, index) => index === 0 || specs[index - 1].from <= spec.from);
  check("按 from 升序输出", sorted);

  const again = specsFor(doc).specs;
  check("同一文档两次调用结果一致", JSON.stringify(again) === JSON.stringify(specs));

  check("装饰不改文档内容", state.doc.toString() === doc);

  const built = buildLivePreviewDecorations(state, [{ from: 0, to: doc.length }]);
  check("DecorationSet 与 spec 数量一致", built.size === specs.length, `${built.size} vs ${specs.length}`);

  // Hides must never cover a mark: a marked range that also gets hidden would
  // remove the very text the mark exists for.
  const overlapping = specs.filter(
    (spec) =>
      spec.kind === "hide" &&
      specs.some((other) => other.kind === "mark" && spec.from < other.to && spec.to > other.from),
  );
  check("hide 与 mark 不重叠", overlapping.length === 0, JSON.stringify(overlapping.slice(0, 3)));
}

// ------------------------------------------------------------------ viewport
section("视口限制（view.visibleRanges 之外不计算）");

{
  const doc = "第一段 **甲**\n\n第二段 **乙**\n\n第三段 **丙**\n";
  const secondStart = doc.indexOf("第二段");
  const secondEnd = doc.indexOf("\n\n第三段");
  const viewport = { from: secondStart, to: secondEnd };

  const full = specsFor(doc).specs;
  const limited = specsFor(doc, [viewport]).specs;

  check(
    "只给了第二段的范围时，只有第二段被装饰",
    limited.length > 0 && limited.every((spec) => spec.from >= viewport.from && spec.to <= viewport.to),
    JSON.stringify(limited.map(format)),
  );
  check(
    "整篇范围得到的装饰更多",
    full.length > limited.length,
    `full=${full.length} limited=${limited.length}`,
  );
  check(
    "第一段与第三段的偏移完全未出现",
    limited.every((spec) => spec.from > secondStart - 1 || spec.from === secondStart) &&
      !limited.some((spec) => spec.from >= secondEnd),
  );

  // A partially visible inline node is skipped rather than half-hidden.
  const clipped = specsFor(doc, [{ from: secondStart, to: secondStart + "第二段 **".length }]).specs;
  check(
    "跨出视口的行内节点整段跳过（不做半隐藏）",
    clipped.every((spec) => spec.to <= secondStart + "第二段 **".length && spec.from >= secondStart),
    JSON.stringify(clipped.map(format)),
  );

  const builtLimited = buildLivePreviewDecorations(
    EditorState.create({ doc, extensions: [language] }),
    [viewport],
  );
  check("限定视口时 DecorationSet 与 spec 数量一致", builtLimited.size === limited.length);
}

// ------------------------------------------------------------------ block fallback
section("表格：StateField 规格（ViewPlugin 不能提供 block 装饰）");

{
  // A leading paragraph puts the caret outside the table at offset 0; without it
  // the document *starts* in the table and the whole case would be the
  // caret-inside branch.
  const doc = "前言\n\n| 名 | 值 |\n| :-- | --: |\n| a | **1** |\n";
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);

  const specs = collectTableSpecs(state, true);
  check("光标在外时产出 1 个表格 spec", specs.length === 1, String(specs.length));
  const spec = specs[0];
  check(
    "spec 覆盖整块（含表头与数据行）",
    Boolean(spec) && doc.slice(spec.from, spec.to) === "| 名 | 值 |\n| :-- | --: |\n| a | **1** |",
    `${spec?.from}-${spec?.to}`,
  );
  check("表头 2 列", spec?.data.header.length === 2, JSON.stringify(spec?.data.header));
  check("对齐取自分隔行", JSON.stringify(spec?.data.align) === '["left","right"]', JSON.stringify(spec?.data.align));
  {
    // Property order is irrelevant; what matters is that the `**` never becomes
    // text and the content keeps the strong flag. The cell is now a `TableCell`:
    // the pieces hang off `.pieces`, and `.text` is the decoded edit value.
    const cell = spec?.data.rows?.[0]?.[1] ?? null;
    check(
      "单元格行内粗体：源码标记不进入片段，内容带 strong",
      cell !== null &&
        cell.pieces.length === 1 &&
        cell.text === "1" &&
        cell.pieces[0].strong === true,
      JSON.stringify(cell),
    );
  }

  // The widget carries a serialised key so an unchanged table never rebuilds.
  check("同一表格两次读取的 key 相同", collectTableSpecs(state, true)[0]?.data.key === spec?.data.key);

  const inside = EditorState.create({
    doc,
    extensions: [language],
    selection: { anchor: doc.indexOf("a |") + 1 },
  });
  ensureSyntaxTree(inside, doc.length, 5000);
  check("光标在表格内时不渲染（回退源码可编辑）", collectTableSpecs(inside, true).length === 0);
  check("只读实例不降级，始终渲染", collectTableSpecs(inside, false).length === 1);
}

section("表格：单元格模型（源码区间 / 空槽 / 转义 / 幻影格）");

/** Table data for a whole document. `false` keeps the caret out of the decision. */
function tableDataFor(doc) {
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);
  return collectTableSpecs(state, false)[0]?.data ?? null;
}

/** The inverse of `encodeCellText` for the two characters it escapes. */
const decodeCellText = (text) => text.replace(/\\([\\|])/g, "$1");

{
  const doc = "| 名称 | 值 |\n| --- | --- |\n| a | b |\n";
  const data = tableDataFor(doc);
  const head = data?.header?.[0] ?? null;
  check(
    "表头单元格区间恰好覆盖内容（不含空格与管道）",
    head !== null && doc.slice(head.from, head.to) === "名称" && head.text === "名称",
    JSON.stringify(head),
  );
  check(
    "表头第二格区间同样只覆盖内容",
    data !== null && doc.slice(data.header[1].from, data.header[1].to) === "值",
    JSON.stringify(data?.header?.[1]),
  );
}

{
  // Three columns: an empty first cell (no `TableCell` node of its own), an
  // escaped pipe in the second, and a `\b` that is *not* an escape in the third.
  const doc = "| 名称 | 值 | 备注 |\n| --- | --- | --- |\n|  | x \\| y | a\\b |\n";
  const data = tableDataFor(doc);
  const row = data?.rows?.[0] ?? [];

  check("表头仍是 3 列", data?.header?.length === 3, String(data?.header?.length));
  check("空单元格没有放弃这一列（行仍是 3 格）", row.length === 3, JSON.stringify(row));
  check(
    "空单元格是零宽插入点：text 为空且 from === to",
    Boolean(row[0]) && row[0].text === "" && row[0].from === row[0].to,
    JSON.stringify(row[0]),
  );
  check(
    "空槽插入点落在首个空格之后（写回得到 `| 填 |`，不是 `|  填|`）",
    Boolean(row[0]) && doc.slice(row[0].from - 2, row[0].from) === "| ",
    JSON.stringify({ from: row[0]?.from, before: doc.slice(row[0]?.from - 3, row[0]?.from + 1) }),
  );
  const escaped = row[1]?.pieces?.map((piece) => piece.text).join("") ?? null;
  check("`\\|` 解码为 `|`，片段里没有反斜杠", escaped === "x | y", JSON.stringify(row[1]));
  check("解码后的文本就是编辑初值", row[1]?.text === "x | y", JSON.stringify(row[1]?.text));
  check(
    "`\\b` 不是合法转义：原样保留（与 CommonMark 一致）",
    row[2]?.text === "a\\b",
    JSON.stringify(row[2]?.text),
  );
}

{
  check("编码：`|` 变成 `\\|`", encodeCellText("a|b") === "a\\|b", encodeCellText("a|b"));
  check("编码：`\\` 变成 `\\\\`", encodeCellText("a\\b") === "a\\\\b", encodeCellText("a\\b"));
  check(
    "编码：换行变空格并 trim",
    encodeCellText("  上\n下  ") === "上 下",
    JSON.stringify(encodeCellText("  上\n下  ")),
  );
  const samples = ["普通文本", "a|b", "a\\b", "C:\\temp\\a|b", "x | y", "**不算粗体**"];
  check(
    "编码往返：decode(encode(x)) === x",
    samples.every((sample) => decodeCellText(encodeCellText(sample)) === sample),
    JSON.stringify(samples.map((sample) => decodeCellText(encodeCellText(sample)))),
  );
}

{
  const doc = "| 名称 | 值 | 备注 |\n| --- | --- | --- |\n| a |\n";
  const data = tableDataFor(doc);
  const row = data?.rows?.[0] ?? [];
  check("缺列的一行补齐到表头列数", row.length === 3, JSON.stringify(row));
  check("已有内容是正常格", row[0]?.text === "a" && row[0]?.editable === true, JSON.stringify(row[0]));
  check(
    "缺的列是幻影格：editable === false 且不可写回",
    row[2]?.editable === false && row[2].from === row[2].to,
    JSON.stringify(row.slice(1)),
  );
}

{
  const table = "| 名称 | 值 |\n| --- | --- |\n| a | b |\n";
  const top = tableDataFor(table);
  const pushed = tableDataFor(`前言一\n\n前言二\n\n前言三\n\n${table}`);
  check(
    "key 与绝对位置无关（同一表格下移三段仍是同一 identity）",
    Boolean(top && pushed) && top.key === pushed.key,
    `${top?.key?.slice(0, 60)} vs ${pushed?.key?.slice(0, 60)}`,
  );
}

{
  const doc = "| 名称 | 值 |\n| :-- | --: |\n| a | b |\n";
  const data = tableDataFor(doc);
  check("对齐行不被当成单元格", data?.header?.length === 2, JSON.stringify(data?.header?.length));
  check(
    "对齐仍取自分隔行",
    JSON.stringify(data?.align) === '["left","right"]',
    JSON.stringify(data?.align),
  );
}

section("L3 当前块回退（块内 hide 撤销，块级视觉保留）");

{
  const doc = "# 标题 **粗**\n\n正文 **甲**\n";
  const { state } = specsFor(doc);
  const heading = blockAtPosition(state, 2);
  const specs = collectLivePreviewRanges(state, [{ from: 0, to: doc.length }], { reveal: heading }).map(format);

  check("光标所在块被识别为标题块", heading !== null && heading.kind === "heading", JSON.stringify(heading));
  check(
    "块内不再有 hide（`**` 可被光标进入）",
    !specs.some((spec) => spec.startsWith("hide:") && Number(spec.split(":")[1].split("-")[0]) < heading.to),
    JSON.stringify(specs),
  );
  check("块内仍保留行内样式", specs.includes("mark:7-8:cm-md-strong"), JSON.stringify(specs));
  check("块级视觉保留（标题仍是标题）", specs.includes("line:0:cm-md-h1"), JSON.stringify(specs));
  check("块外仍是渲染态", specs.includes("hide:15-17:") && specs.includes("hide:18-20:"), JSON.stringify(specs));

  // A range selection spanning blocks reveals the whole span.
  const spanStart = blockAtPosition(state, 2);
  const spanEnd = blockAtPosition(state, doc.indexOf("正文") + 1);
  const span = { from: Math.min(spanStart.from, spanEnd.from), to: Math.max(spanStart.to, spanEnd.to) };
  const spanned = collectLivePreviewRanges(state, [{ from: 0, to: doc.length }], { reveal: span }).map(format);
  check("跨块选区把整段都回退为源码", !spanned.some((spec) => spec.startsWith("hide:")), JSON.stringify(spanned));
}

section("块级标记：光标进入块时回退源码");

{
  const doc = "# 标题\n\n> 引用 **乙**\n";
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);

  const heading = blockAtPosition(state, 2);
  const inHeading = collectLivePreviewRanges(state, [{ from: 0, to: doc.length }], { reveal: heading }).map(format);
  check("标题块回退：`#` 重新出现", !inHeading.includes("hide:0-2:"), JSON.stringify(inHeading));
  check("标题块外引用仍隐藏 `>`", inHeading.includes("hide:6-8:"), JSON.stringify(inHeading));

  const quote = blockAtPosition(state, doc.indexOf("引用") + 1);
  const inQuote = collectLivePreviewRanges(state, [{ from: 0, to: doc.length }], { reveal: quote }).map(format);
  check("引用块回退：`>` 重新出现", !inQuote.includes("hide:6-8:"), JSON.stringify(inQuote));
  check("引用块回退后左侧竖线仍在", inQuote.includes("line:6:cm-md-quote"), JSON.stringify(inQuote));
  check("引用块外标题仍隐藏 `#`", inQuote.includes("hide:0-2:"), JSON.stringify(inQuote));
}

section("列表符号：光标进入该项时回退源码");

{
  const doc = "- 甲\n- 乙\n";
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);
  const item = blockAtPosition(state, 1);
  const specs = collectLivePreviewRanges(state, [{ from: 0, to: doc.length }], { reveal: item }).map(format);

  // Only the revealed item loses its marker: the sibling below keeps its bullet,
  // so the assertion is scoped to `[item.from, item.to)` rather than "no widgets".
  const insideItem = specs.filter((spec) => {
    const start = Number(spec.split(":")[1].split("-")[0]);
    return start >= item.from && start < item.to;
  });
  check("当前列表项不再有 widget / hide（`-` 可被光标进入）", insideItem.length === 0, JSON.stringify(specs));
  check("另一项仍然显示圆点", specs.includes("widget:4-6:cm-md-bullet:•"), JSON.stringify(specs));

  const taskDoc = "- [ ] 甲\n";
  const taskState = EditorState.create({ doc: taskDoc, extensions: [language] });
  ensureSyntaxTree(taskState, taskDoc.length, 5000);
  const taskItem = blockAtPosition(taskState, 1);
  const taskSpecs = collectLivePreviewRanges(taskState, [{ from: 0, to: taskDoc.length }], { reveal: taskItem }).map(format);
  check("任务项回退后复选框消失、源码可见", taskSpecs.length === 0, JSON.stringify(taskSpecs));
}

section("blockAtPosition 与 blocks()+blockAt 结果一致");

{
  const doc = [
    "# 标题",
    "",
    "正文一 **粗**",
    "",
    "> 引用",
    "> - 项一",
    "> - 项二",
    "",
    "- 甲",
    "  - 甲一",
    "- 乙",
    "",
    "| a |",
    "| --- |",
    "| 1 |",
    "",
    "```",
    "code",
    "```",
    "",
    "---",
    "",
  ].join("\n");
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);
  const all = blocks(state.doc);

  const mismatches = [];
  for (let pos = 0; pos <= doc.length; pos += 1) {
    const fast = blockAtPosition(state, pos);
    const slow = blockAt(all, pos);
    const key = (block) => (block ? `${block.kind}:${block.from}-${block.to}` : "null");
    if (key(fast) !== key(slow)) mismatches.push(`${pos} ${key(fast)} vs ${key(slow)}`);
  }
  check(
    `每个偏移的当前块都与 blocks() 一致（${doc.length + 1} 个位置）`,
    mismatches.length === 0,
    mismatches.slice(0, 6).join("；"),
  );
}

section("增量更新与全量重建等价（只重算受影响的块）");

{
  const doc = "# 标题\n\n正文 **甲**\n\n- 项一\n- 项二\n\n> 引用 **乙**\n";
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);
  const viewport = [{ from: 0, to: doc.length }];
  const dump = (set) => {
    const out = [];
    set.between(0, doc.length, (from, to, value) => {
      out.push(`${from}-${to}:${value.spec?.class ?? "hide"}`);
    });
    return out;
  };

  const heading = blockAtPosition(state, 2);
  const item = blockAtPosition(state, doc.indexOf("项一") + 1);
  const quote = blockAtPosition(state, doc.indexOf("引用") + 1);
  check("三个块都被识别", Boolean(heading && item && quote));

  let set = buildLivePreviewDecorations(state, viewport, { reveal: heading });
  const patched = (from, to, toBlock) => {
    set = set.update({
      filterFrom: Math.min(from.from, to.from),
      filterTo: Math.max(from.to, to.to),
      filter: (f, t) => f < Math.min(from.from, to.from) || t > Math.max(from.to, to.to),
      add: toDecorationRanges(
        collectLivePreviewRanges(state, [{ from: Math.min(from.from, to.from), to: Math.max(from.to, to.to) }], {
          reveal: toBlock,
        }),
      ),
      sort: true,
    });
    return dump(set);
  };

  check(
    "标题 → 列表项：增量结果 == 全量重建",
    JSON.stringify(patched(heading, item, item)) ===
      JSON.stringify(dump(buildLivePreviewDecorations(state, viewport, { reveal: item }))),
  );
  check(
    "列表项 → 引用：增量结果 == 全量重建",
    JSON.stringify(patched(item, quote, quote)) ===
      JSON.stringify(dump(buildLivePreviewDecorations(state, viewport, { reveal: quote }))),
  );
  check(
    "引用 → 标题（回到起点）：增量结果 == 全量重建",
    JSON.stringify(patched(quote, heading, heading)) ===
      JSON.stringify(dump(buildLivePreviewDecorations(state, viewport, { reveal: heading }))),
  );
}

// ------------------------------------------------------------------ summary
section("结果");
console.log(`  ${checks} 项检查 · ${failures} 项失败`);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) process.exitCode = 1;
