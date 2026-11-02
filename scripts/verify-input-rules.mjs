/**
 * Headless verification for the eleven Markdown input rules.
 *
 *   node scripts/verify-input-rules.mjs
 *
 * Each rule is a pure function from a caret position to a `TransactionSpec`, so
 * every case here is "state + caret in → document + caret out". That is exactly
 * what a key press would produce, minus the key: the keymap only adds the two
 * annotations, which are asserted separately.
 *
 * The browser cannot be used for this: headless Chrome cannot synthesise an IME
 * commit, and key events would exercise CodeMirror's key handling rather than the
 * rule logic.
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "input-rules-verify-"));
const outfile = path.join(tmpDir, "inputRules.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: [
      `export { INPUT_RULES, INPUT_RULE_IDS, ruleContext, withRuleAnnotations, inputRuleSource, taskToggleAt } from ${JSON.stringify(
        path.join(root, "src/utils/livePreview/inputRules.ts"),
      ).replaceAll("\\", "/")};`,
      `export { EditorState } from "@codemirror/state";`,
      `export { isolateHistory } from "@codemirror/commands";`,
      `export { markdown, markdownLanguage } from "@codemirror/lang-markdown";`,
      `export { ensureSyntaxTree } from "@codemirror/language";`,
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

const { INPUT_RULES, INPUT_RULE_IDS, ruleContext, withRuleAnnotations, inputRuleSource, taskToggleAt, EditorState, isolateHistory, markdown, markdownLanguage, ensureSyntaxTree } =
  await import(pathToFileURL(outfile).href);

const language = markdown({ base: markdownLanguage });

function stateFor(doc, caret) {
  const state = EditorState.create({
    doc,
    selection: typeof caret === "number" ? { anchor: caret } : caret,
    extensions: [language],
  });
  // The rules read the syntax tree; parse the whole fixture up front.
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/**
 * `variant` picks one function out of the id's list (Mod-b vs Mod-i).
 * `expect: null` means "the rule must decline", which is how a rule stays out of
 * the way for the default CodeMirror behaviour.
 */
const cases = [
  // 1 · 行首 # + 空格
  { rule: "headingShortcut", variant: 0, name: "# + Space → H1", doc: "#", caret: 1, expect: { doc: "# ", head: 2 } },
  { rule: "headingShortcut", variant: 0, name: "#### + Space → H4", doc: "####", caret: 4, expect: { doc: "#### ", head: 5 } },
  { rule: "headingShortcut", variant: 0, name: "缩进 2 空格被抹平", doc: "  ##", caret: 4, expect: { doc: "## ", head: 3 } },
  { rule: "headingShortcut", variant: 0, name: "7 个 # 不触发", doc: "#######", caret: 7, expect: null },
  { rule: "headingShortcut", variant: 0, name: "光标不在行尾不触发", doc: "#", caret: 0, expect: null },
  { rule: "headingShortcut", variant: 0, name: "正文中间不触发", doc: "abc#", caret: 4, expect: null },

  // 2 · 引用续行
  { rule: "quoteContinue", variant: 0, name: "> 行末 Enter 续行", doc: "> 引用", caret: 4, expect: { doc: "> 引用\n> ", head: 7 } },
  { rule: "quoteContinue", variant: 0, name: "空 > 退出引用", doc: "> ", caret: 2, expect: { doc: "", head: 0 } },
  { rule: "quoteContinue", variant: 0, name: "嵌套 > > 退一级", doc: "> > ", caret: 4, expect: { doc: "> ", head: 2 } },
  { rule: "quoteContinue", variant: 0, name: "普通行不触发", doc: "正文", caret: 2, expect: null },

  // 3 · 列表续行
  { rule: "listContinue", variant: 0, name: "- 项 Enter 续项", doc: "- 项", caret: 3, expect: { doc: "- 项\n- ", head: 6 } },
  { rule: "listContinue", variant: 0, name: "有序递增 1. → 2.", doc: "1. 项", caret: 4, expect: { doc: "1. 项\n2. ", head: 8 } },
  { rule: "listContinue", variant: 0, name: "有序保留 ) 分隔符", doc: "3) 项", caret: 4, expect: { doc: "3) 项\n4) ", head: 8 } },
  { rule: "listContinue", variant: 0, name: "嵌套项沿用缩进", doc: "- 父\n  - 子", caret: 9, expect: { doc: "- 父\n  - 子\n  - ", head: 14 } },
  { rule: "listContinue", variant: 0, name: "任务项续出新的空任务", doc: "- [ ] 待办", caret: 8, expect: { doc: "- [ ] 待办\n- [ ] ", head: 15 } },
  { rule: "listContinue", variant: 0, name: "引用内列表保留 > 前缀", doc: "> - 项", caret: 5, expect: { doc: "> - 项\n> - ", head: 10 } },
  { rule: "listContinue", variant: 0, name: "行中拆分也带标记", doc: "- 甲乙", caret: 3, expect: { doc: "- 甲\n- 乙", head: 6 } },
  { rule: "listContinue", variant: 0, name: "空项交给规则 4", doc: "- ", caret: 2, expect: null },

  // 4 · 空项退出
  { rule: "listExit", variant: 0, name: "空项 Enter 删标记", doc: "- ", caret: 2, expect: { doc: "", head: 0 } },
  { rule: "listExit", variant: 0, name: "缩进空项一并去掉缩进", doc: "  - ", caret: 4, expect: { doc: "", head: 0 } },
  { rule: "listExit", variant: 0, name: "任务空项去掉 [ ]", doc: "- [ ] ", caret: 6, expect: { doc: "", head: 0 } },
  { rule: "listExit", variant: 0, name: "引用内空项保留 >", doc: "> - ", caret: 4, expect: { doc: "> ", head: 2 } },
  { rule: "listExit", variant: 0, name: "有内容的项不触发", doc: "- 项", caret: 3, expect: null },

  // 5 · Tab / Shift-Tab
  { rule: "listIndent", variant: 0, name: "Tab 默认两空格", doc: "- 项", caret: 2, expect: { doc: "  - 项", head: 4 } },
  { rule: "listIndent", variant: 0, name: "跟随文档的空格单位（4）", doc: "- 甲\n    - 乙\n- 项", caret: 13, expect: { doc: "- 甲\n    - 乙\n    - 项", head: 17 } },
  { rule: "listIndent", variant: 0, name: "跟随文档的 tab 单位", doc: "- 甲\n\t- 乙\n- 项", caret: 9, expect: { doc: "- 甲\n\t- 乙\n\t- 项", head: 10 } },
  { rule: "listIndent", variant: 0, name: "多行项整块缩进", doc: "- 项\n  续行", caret: 2, expect: { doc: "  - 项\n    续行", head: 4 } },
  { rule: "listIndent", variant: 1, name: "Shift-Tab 回退一级", doc: "  - 项", caret: 4, expect: { doc: "- 项", head: 2 } },
  { rule: "listIndent", variant: 1, name: "顶层项 Shift-Tab 不动", doc: "- 项", caret: 2, expect: null },
  { rule: "listIndent", variant: 0, name: "非列表行不触发", doc: "正文", caret: 1, expect: null },

  // 6 · 围栏补全
  { rule: "fenceClose", variant: 0, name: "``` 回车补闭合", doc: "```", caret: 3, expect: { doc: "```\n\n```", head: 4 } },
  { rule: "fenceClose", variant: 0, name: "带 info 的围栏补同款", doc: "```ts", caret: 5, expect: { doc: "```ts\n\n```", head: 6 } },
  { rule: "fenceClose", variant: 0, name: "已闭合不再补", doc: "```\ncode\n```", caret: 3, expect: null },
  { rule: "fenceClose", variant: 0, name: "围栏行中间不触发", doc: "```ts", caret: 3, expect: null },

  // 7 · $$
  { rule: "mathClose", variant: 0, name: "$$ 回车补闭合", doc: "$$", caret: 2, expect: { doc: "$$\n\n$$", head: 3 } },
  { rule: "mathClose", variant: 0, name: "已在数学块内不补", doc: "$$\na\n$$", caret: 7, expect: null },
  { rule: "mathClose", variant: 0, name: "行内 $$ 不触发", doc: "x $$", caret: 4, expect: null },

  // 8 · ---
  { rule: "hrBreak", variant: 0, name: "独立 --- 回车换行", doc: "---", caret: 3, expect: { doc: "---\n", head: 4 } },
  {
    rule: "hrBreak",
    variant: 0,
    name: "被并成 Setext 下划线时先断开",
    doc: "标题\n---",
    caret: 6,
    expect: { doc: "标题\n\n---\n", head: 8 },
  },
  { rule: "hrBreak", variant: 0, name: "非分隔线行不触发", doc: "---a", caret: 4, expect: null },

  // 9 · Ctrl+B / Ctrl+I
  { rule: "inlineWrap", variant: 0, name: "选中文字加粗", doc: "文字", caret: { anchor: 0, head: 2 }, expect: { doc: "**文字**", head: 4 } },
  { rule: "inlineWrap", variant: 0, name: "已加粗则取消", doc: "**粗体**", caret: { anchor: 2, head: 4 }, expect: { doc: "粗体", head: 2 } },
  { rule: "inlineWrap", variant: 0, name: "连标记一起选中也能取消", doc: "**粗**", caret: { anchor: 0, head: 5 }, expect: { doc: "粗", head: 1 } },
  { rule: "inlineWrap", variant: 0, name: "空光标插入成对标记", doc: "", caret: 0, expect: { doc: "****", head: 2 } },
  { rule: "inlineWrap", variant: 1, name: "Ctrl+I 斜体", doc: "文字", caret: { anchor: 0, head: 2 }, expect: { doc: "*文字*", head: 3 } },
  { rule: "inlineWrap", variant: 1, name: "斜体取消", doc: "*文字*", caret: { anchor: 0, head: 4 }, expect: { doc: "文字", head: 2 } },

  // 11 · 任务复选框
  { rule: "taskToggle", variant: 0, name: "点击 [ ] 变 [x]", doc: "- [ ] 待办", caret: 3, expect: { doc: "- [x] 待办", head: 3 } },
  { rule: "taskToggle", variant: 0, name: "点击 [x] 变 [ ]", doc: "- [x] 待办", caret: 3, expect: { doc: "- [ ] 待办", head: 3 } },
  { rule: "taskToggle", variant: 0, name: "引用里的任务也能切", doc: "> - [ ] 项", caret: 5, expect: { doc: "> - [x] 项", head: 5 } },
  { rule: "taskToggle", variant: 0, name: "正文位置不触发", doc: "- [ ] 待办", caret: 7, expect: null },
];

// ------------------------------------------------------------------ per rule
const byRule = new Map();
for (const item of cases) {
  if (!byRule.has(item.rule)) byRule.set(item.rule, []);
  byRule.get(item.rule).push(item);
}

for (const [ruleId, items] of byRule) {
  section(`${ruleId} · ${INPUT_RULES[ruleId][0].trigger}`);
  for (const item of items) {
    const rule = INPUT_RULES[ruleId][item.variant];
    let state;
    try {
      state = stateFor(item.doc, item.caret);
    } catch (error) {
      check(item.name, false, `构造 state 失败：${error.message}；doc=${show(item.doc)} caret=${JSON.stringify(item.caret)}`);
      continue;
    }
    const spec = rule.run(ruleContext(state));

    if (item.expect === null) {
      check(item.name, spec === null, spec === null ? undefined : `期望不触发，实际 ${show(spec.changes)}`);
      continue;
    }
    if (!spec) {
      check(item.name, false, "期望产生事务，实际返回 null");
      continue;
    }

    const transaction = state.update(withRuleAnnotations(ruleId, spec));
    const doc = transaction.state.doc.toString();
    const head = transaction.state.selection.main.head;
    const problems = [];
    if (doc !== item.expect.doc) problems.push(`文档 ${show(doc)} ≠ ${show(item.expect.doc)}`);
    if (head !== item.expect.head) problems.push(`光标 ${head} ≠ ${item.expect.head}`);
    if (!transaction.docChanged) problems.push("事务没有改动文档");
    if (transaction.annotation(inputRuleSource) !== ruleId) problems.push("缺少来源 annotation");
    if (transaction.annotation(isolateHistory) !== "full") problems.push("缺少 isolateHistory");
    check(item.name, problems.length === 0, problems.join("；"));
  }
}

// ------------------------------------------------------------------ coverage
section("覆盖");

const missing = Object.keys(INPUT_RULES).filter((id) => !byRule.has(id));
check("十条文本规则都有用例（第 10 条是 DOM 事件，不在此列）", missing.length === 0, `缺 ${missing.join("、")}`);
check("十一条规则 id 齐全（10 条文本规则 + imageDrop）", INPUT_RULE_IDS.length === 11 && Object.keys(INPUT_RULES).length === 10, `${INPUT_RULE_IDS.length} / ${Object.keys(INPUT_RULES).length}`);

// 任务点击的纯函数入口与规则一致
{
  const state = stateFor("- [ ] 项", 3);
  check("taskToggleAt 与规则结果一致", JSON.stringify(taskToggleAt(state, 3)?.changes) === JSON.stringify({ from: 3, to: 4, insert: "x" }));
}

section("结果");
console.log(`  ${checks} 项检查 · ${failures} 项失败`);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) process.exitCode = 1;
