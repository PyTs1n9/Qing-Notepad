import assert from "node:assert/strict";
import test from "node:test";

import { classify, extractTags, groupItems, normalize, splitSentences, tidy } from "./tidy.js";

const NOW = new Date("2026-10-30T15:40:00+08:00");

test("splitSentences breaks on hard punctuation and splits long soft ones", () => {
  assert.deepEqual(splitSentences("买牛奶。顺便取快递"), ["买牛奶", "顺便取快递"]);
  assert.deepEqual(splitSentences("短句，保持原样"), ["短句，保持原样"]);
  const long = "把首页的活动文案改一版，明天上午交给运营确认，顺便问一下预算";
  assert.ok(splitSentences(long).length > 1, "a long comma sentence should break apart");
});

test("cleanSentence strips list markers and numbering", () => {
  assert.equal(tidy([{ text: "- 买牛奶" }]).items[0].text, "买牛奶");
  assert.equal(tidy([{ text: "1. 改文案" }]).items[0].text, "改文案");
  assert.deepEqual(extractTags("# 工作 改文案").tags, [], "a space after # is not a tag");
});

test("extractTags pulls tags out of the body, including trailing ones", () => {
  assert.deepEqual(extractTags("改完首页文案 #工作"), { text: "改完首页文案", tags: ["工作"] });
  assert.deepEqual(extractTags("#想法 要不要做置顶小窗").tags, ["想法"]);
});

test("classify separates questions, actions and plain notes", () => {
  assert.equal(classify("要不要换成 IndexedDB？").kind, "question");
  assert.equal(classify("为什么拖拽会卡").kind, "question");
  assert.equal(classify("改完首页文案").kind, "action");
  assert.equal(classify("明天上午给运营看").kind, "action");
  assert.equal(classify("用户说慢一点更好").kind, "note");
  assert.equal(classify("明天上午给运营看").due, "明天");
});

test("normalize ignores punctuation, spaces and case", () => {
  assert.equal(normalize("Buy Milk!"), normalize("buy  milk"));
  assert.equal(normalize("买 牛奶。"), normalize("买牛奶"));
});

test("tidy dedupes, tags and orders fragments", () => {
  const result = tidy(
    [
      { text: "改完首页文案 #工作", createdAt: 2 },
      { text: "改完首页文案。#工作", createdAt: 3 },
      { text: "要不要做置顶小窗？#想法", createdAt: 1 },
      { text: "已经做完的事", done: true, createdAt: 0 },
      { text: "   ", createdAt: 4 },
    ],
    NOW,
  );

  assert.equal(result.stats.fragments, 3, "done and blank fragments are skipped");
  assert.equal(result.stats.dropped, 1, "the duplicate collapses");
  assert.equal(result.stats.items, 2);
  const action = result.items.find((item) => item.kind === "action");
  const question = result.items.find((item) => item.kind === "question");
  assert.equal(action.text, "改完首页文案");
  assert.deepEqual(action.tags, ["工作"]);
  assert.equal(question.text, "要不要做置顶小窗？");
});

test("tidy renders a checklist grouped by tag", () => {
  const { markdown } = tidy(
    [
      { text: "改完首页文案 #工作", createdAt: 1 },
      { text: "买牛奶 #生活", createdAt: 2 },
      { text: "要不要做置顶小窗？", createdAt: 3 },
      { text: "用户说慢一点更好", createdAt: 4 },
    ],
    NOW,
  );

  assert.match(markdown, /^# 碎片整理 · 10 月 30 日 15:40/);
  assert.match(markdown, /## 待办清单/);
  assert.match(markdown, /### 生活/);
  assert.match(markdown, /### 工作/);
  assert.match(markdown, /- \[ \] 改完首页文案/);
  assert.match(markdown, /## 待确认/);
  assert.match(markdown, /- \[ \] 要不要做置顶小窗？/);
  assert.match(markdown, /## 原样保留/);
  assert.ok(
    markdown.indexOf("### 工作") < markdown.indexOf("### 生活"),
    "tag groups sort by locale order",
  );
  assert.ok(markdown.indexOf("## 待办清单") < markdown.indexOf("## 待确认"));
});

test("tidy marks due hints without removing the text", () => {
  const { markdown } = tidy([{ text: "明天上午给运营看", createdAt: 1 }], NOW);
  assert.match(markdown, /- \[ \] 明天上午给运营看 · ⏰ 明天/);
});

test("tidy survives empty and malformed input", () => {
  assert.equal(tidy([]).stats.items, 0);
  assert.equal(tidy(undefined).stats.items, 0);
  assert.equal(tidy([{ text: "" }, null]).stats.items, 0);
  assert.match(tidy([]).markdown, /^# 碎片整理/);
});

test("groupItems puts untagged items last", () => {
  const groups = groupItems([
    { text: "b", kind: "action", tags: ["工作"] },
    { text: "a", kind: "action", tags: [] },
  ]);
  assert.equal(groups[groups.length - 1].label, "");
});
