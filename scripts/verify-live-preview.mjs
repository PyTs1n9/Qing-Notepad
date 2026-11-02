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

const format = (spec) =>
  spec.kind === "line" ? `line:${spec.from}:${spec.className}` : `${spec.kind}:${spec.from}-${spec.to}:${spec.className ?? ""}`;

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
    name: "标题：按级别加行样式，不隐藏 #",
    doc: "# 一级\n\n## 二级\n\n###### 六级\n",
    expect: ["line:0:cm-md-h1", "line:6:cm-md-h2", "line:13:cm-md-h6"],
  },
  {
    name: "引用：左侧竖线加在每一行，> 保持可见",
    doc: "> 引用一\n> 引用二\n",
    expect: ["line:0:cm-md-quote", "line:6:cm-md-quote"],
  },
  {
    name: "围栏代码块：逐行底纹，内容不隐藏",
    doc: "```ts\nconst a = 1;\n\nconst b = 2;\n```\n",
    expect: [
      "line:0:cm-md-code-block",
      "line:6:cm-md-code-block",
      "line:19:cm-md-code-block",
      "line:20:cm-md-code-block",
      "line:33:cm-md-code-block",
    ],
  },
  {
    name: "分隔线：隐藏 --- 并画线",
    doc: "---\n",
    expect: ["line:0:cm-md-hr", "hide:0-3:"],
  },
  {
    name: "列表：符号列固定宽度",
    doc: "- 甲\n1. 乙\n",
    expect: ["mark:0-1:cm-md-list-mark", "mark:4-6:cm-md-list-mark"],
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
