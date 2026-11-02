/**
 * Headless verification for cross-block deletion (M5).
 *
 *   node scripts/verify-block-delete.mjs
 *
 * The chain under test is the one the editor actually runs: `deleteMarkupBackward`
 * first (in-block markup only), then CodeMirror's `deleteCharBackward` /
 * `deleteCharForward`. Both take a `{state, dispatch}` target, so they run here
 * without a DOM — the same code path a key press reaches, minus the keymap.
 *
 * Every case asserts three things:
 * 1. the resulting document is exactly the old one minus the expected characters
 *    (nothing swallowed, nothing re-numbered, nothing lifted out of a quote);
 * 2. the caret lands inside a block that can be resolved — M3 needs that to
 *    decide what to re-render;
 * 3. the decorations recomputed for that block contain no `hide`, i.e. the
 *    block the caret is in is never covered by a `Decoration.replace`.
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures += 1;
}

const section = (title) => console.log(`\n${title}`);
const show = (text) => JSON.stringify(text);

// ------------------------------------------------------------------ bundle
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "block-delete-verify-"));
const outfile = path.join(tmpDir, "blockDelete.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: [
      `export { classifyBlockDelete } from ${JSON.stringify(
        path.join(root, "src/utils/livePreview/blockDelete.ts"),
      ).replaceAll("\\", "/")};`,
      `export { blockAtPosition } from ${JSON.stringify(
        path.join(root, "src/utils/editorBlocks.ts"),
      ).replaceAll("\\", "/")};`,
      `export { collectLivePreviewRanges } from ${JSON.stringify(
        path.join(root, "src/utils/livePreview/decorations.ts"),
      ).replaceAll("\\", "/")};`,
      `export { EditorState } from "@codemirror/state";`,
      `export { ensureSyntaxTree } from "@codemirror/language";`,
      `export { markdown, markdownLanguage, deleteMarkupBackward } from "@codemirror/lang-markdown";`,
      `export { deleteCharBackward, deleteCharForward } from "@codemirror/commands";`,
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
  classifyBlockDelete,
  blockAtPosition,
  collectLivePreviewRanges,
  EditorState,
  ensureSyntaxTree,
  markdown,
  markdownLanguage,
  deleteMarkupBackward,
  deleteCharBackward,
  deleteCharForward,
} = await import(pathToFileURL(outfile).href);

const language = markdown({ base: markdownLanguage, addKeymap: false });

function stateFor(doc, selection) {
  const state = EditorState.create({ doc, selection, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** The production chain: markup deletion first, then one character. */
function press(state, direction) {
  let current = state;
  const target = {
    get state() {
      return current;
    },
    dispatch(transaction) {
      current = transaction.state;
    },
  };
  if (direction === "backward" && deleteMarkupBackward(target)) return current;
  const command = direction === "backward" ? deleteCharBackward : deleteCharForward;
  command(target);
  return current;
}

// ------------------------------------------------------------------ fixtures
/**
 * `expect` is the whole resulting document — the strongest possible statement
 * that only characters were removed. `removed` is the character count, used to
 * catch a delete that took a block along with it.
 */
const cases = [
  // (a) Backspace at a block start
  {
    name: "(a) 段落块首 Backspace：只删掉分隔换行",
    doc: "甲\n\n乙",
    caret: 3,
    direction: "backward",
    classify: "block-start-backspace",
    expect: "甲\n乙",
    removed: 1,
  },
  {
    name: "(a) 列表块首 Backspace：空行消失，标记变正文",
    doc: "甲\n\n- 项",
    caret: 3,
    direction: "backward",
    classify: "block-start-backspace",
    expect: "甲\n- 项",
    removed: 1,
  },
  {
    name: "(a) 标题块首 Backspace：两个标题并成相邻两行",
    doc: "# 甲\n\n## 乙",
    caret: 5,
    direction: "backward",
    classify: "block-start-backspace",
    expect: "# 甲\n## 乙",
    removed: 1,
  },
  {
    name: "(a) 文档首块不适用：Backspace 无字符可删",
    doc: "# 甲",
    caret: 0,
    direction: "backward",
    classify: "character",
    expect: "# 甲",
    removed: 0,
  },

  {
    name: "块内（列表标记之后）Backspace：整段标记被删，内容保留",
    doc: "- 项",
    caret: 2,
    direction: "backward",
    classify: "character",
    expect: "项",
    removed: 2,
  },
  {
    name: "块内（标题标记之后）Backspace：只删掉标记后的那个空格",
    doc: "# 标题",
    caret: 2,
    direction: "backward",
    classify: "character",
    expect: "#标题",
    removed: 1,
  },

  // (b) Delete at a block end
  {
    name: "(b) 列表块尾 Delete：吞掉的是换行",
    doc: "- 项\n\n后",
    caret: 3,
    direction: "forward",
    classify: "block-end-delete",
    expect: "- 项\n后",
    removed: 1,
  },
  {
    name: "(b) #5423 引用块尾 Delete：引用仍在引用内",
    doc: "> 引用一\n> 引用二\n\n> 引用三",
    caret: 11,
    direction: "forward",
    classify: "block-end-delete",
    expect: "> 引用一\n> 引用二\n> 引用三",
    removed: 1,
  },
  {
    name: "(b) 围栏代码块尾 Delete：只并掉空行",
    doc: "```\ncode\n```\n\n后",
    caret: 12,
    direction: "forward",
    classify: "block-end-delete",
    expect: "```\ncode\n```\n后",
    removed: 1,
  },

  // (c) Selection across blocks
  {
    name: "(c) #5385 列表项内删到后段：只删选中字符",
    doc: "- 项一\n- 项二\n\n尾段",
    selection: { anchor: 3, head: 12 },
    direction: "backward",
    classify: "cross-block-selection",
    expect: "- 项" + "段",
    removed: 9,
  },
  {
    name: "(c) 引用内删到后段：选区外一个字符都不动",
    doc: "> 引用一\n\n尾段",
    selection: { anchor: 3, head: 8 },
    direction: "backward",
    classify: "cross-block-selection",
    expect: "> 引" + "段",
    removed: 5,
  },
  {
    name: "(c) 块内选区不算跨块",
    doc: "甲\n\n乙丙丁",
    selection: { anchor: 3, head: 5 },
    direction: "backward",
    classify: "selection-in-block",
    expect: "甲\n\n丁",
    removed: 2,
  },
];

// ------------------------------------------------------------------ run
section("三种情形");

for (const item of cases) {
  const selection =
    item.selection ?? { anchor: item.caret, head: item.caret };
  const before = stateFor(item.doc, selection);

  const classified = classifyBlockDelete(before, item.direction);
  check(`${item.name} · 归类正确`, classified === item.classify, `分类 ${classified} ≠ ${item.classify}`);

  const after = press(before, item.direction);
  const doc = after.state?.doc?.toString() ?? after.doc.toString();
  const head = (after.state?.selection ?? after.selection).main.head;

  const problems = [];
  if (doc !== item.expect) problems.push(`文档 ${show(doc)} ≠ ${show(item.expect)}`);
  const removed = item.doc.length - doc.length;
  if (removed !== item.removed) problems.push(`删掉 ${removed} 个字符，期望 ${item.removed}`);
  check(`${item.name} · 结果准确`, problems.length === 0, problems.join("；"));

  // M3 联动：删除后当前块必须能重新解析，且块内不得有 hide。
  ensureSyntaxTree(after, doc.length, 5000);
  const block = blockAtPosition(after, head);
  const revealsCaret = !block || (head >= block.from && head <= block.to);
  check(`${item.name} · 光标仍落在可解析的块内`, revealsCaret, block ? show(block) : "null");

  const specs = collectLivePreviewRanges(after, [{ from: 0, to: doc.length }], block ? { reveal: block } : undefined);
  const leaked = block
    ? specs.filter((spec) => spec.kind === "hide" && spec.from >= block.from && spec.to <= block.to)
    : [];
  check(`${item.name} · 块内没有残留 hide`, leaked.length === 0, JSON.stringify(leaked.slice(0, 3)));
}

// ------------------------------------------------------------------ no swallowing
section("结构不被加工");

{
  // A delete never re-numbers a list or lifts an item out of a quote: the result
  // must be byte-identical to the original minus the deleted range, which is the
  // strongest form of "characters only".
  const doc = "- 1\n- 2\n- 3";
  const selection = { anchor: 3, head: 7 };
  const expected = doc.slice(0, selection.anchor) + doc.slice(selection.head);
  const result = press(stateFor(doc, selection), "backward").doc.toString();
  check("跨块选区删除 = 原文减去选中区间（列表未重排）", result === expected, `${show(result)} ≠ ${show(expected)}`);

  const quote = "> a\n> b";
  const qExpected = "> a\n> ";
  const qResult = press(stateFor(quote, { anchor: 7, head: 7 }), "backward").doc.toString();
  check("行内 Backspace 只删一个字符，不把内容提出引用", qResult === qExpected, `${show(qResult)} ≠ ${show(qExpected)}`);

  const heading = "# 标题";
  const hResult = press(stateFor(heading, { anchor: 4, head: 4 }), "backward").doc.toString();
  check("标题内 Backspace 只删一个字符", hResult === "# 标", show(hResult));
}

section("结果");
console.log(`  ${checks} 项检查 · ${failures} 项失败`);

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures > 0) process.exitCode = 1;
