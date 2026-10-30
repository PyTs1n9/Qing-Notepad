import assert from "node:assert/strict";
import test from "node:test";

import { deriveTitle, parseInline, parseMarkdown, sanitizeHref } from "./md.js";

test("headings carry their level", () => {
  const blocks = parseMarkdown("# 一\n## 二\n###### 六");
  assert.deepEqual(
    blocks.map((block) => [block.type, block.level, block.text]),
    [
      ["heading", 1, "一"],
      ["heading", 2, "二"],
      ["heading", 6, "六"],
    ],
  );
});

test("paragraphs stop at the next block", () => {
  const blocks = parseMarkdown("第一行\n第二行\n- 列表项");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[0].text, "第一行\n第二行");
  assert.equal(blocks[1].type, "list");
});

test("lists detect order, tasks and stop at a different list type", () => {
  const unordered = parseMarkdown("- 买牛奶\n- [x] 取快递\n- [ ] 写周报");
  assert.equal(unordered[0].ordered, false);
  assert.deepEqual(unordered[0].items.map((item) => item.checked), [null, true, false]);

  const ordered = parseMarkdown("1. 一\n2. 二\n\n- 打断");
  assert.equal(ordered[0].ordered, true);
  assert.equal(ordered[0].items.length, 2);
  assert.equal(ordered[1].type, "list");
  assert.equal(ordered[1].ordered, false);
});

test("fenced code keeps language and tolerates a missing closing fence", () => {
  const closed = parseMarkdown("```ts\nconst a = 1;\n```");
  assert.deepEqual(closed[0], { type: "code", lang: "ts", code: "const a = 1;" });

  const open = parseMarkdown("```\n没有结尾");
  assert.equal(open[0].type, "code");
  assert.equal(open[0].code, "没有结尾");
});

test("quotes and rules are separate blocks", () => {
  const blocks = parseMarkdown("> 引用一\n> 引用二\n\n---");
  assert.equal(blocks[0].type, "quote");
  assert.equal(blocks[0].text, "引用一\n引用二");
  assert.equal(blocks[1].type, "hr");
});

test("inline formatting splits into tokens", () => {
  const tokens = parseInline("这 **很重要**，用 `npm test`，看 [文档](https://example.com/a)。");
  assert.deepEqual(
    tokens.map((token) => token.type),
    ["text", "strong", "text", "code", "text", "link", "text"],
  );
  assert.equal(tokens[3].text, "npm test");
  assert.equal(tokens[5].href, "https://example.com/a");
});

test("dangerous links collapse to plain text", () => {
  const tokens = parseInline("[点我](javascript:alert(1))");
  assert.equal(tokens[0].type, "text");
  assert.equal(tokens[0].text, "点我");
  assert.equal(sanitizeHref("javascript:alert(1)"), "");
  assert.equal(sanitizeHref("https://a.b"), "https://a.b");
  assert.equal(sanitizeHref("./notes/1.md"), "./notes/1.md");
});

test("markdown-looking HTML stays text, it is never parsed as markup", () => {
  const blocks = parseMarkdown('<script>alert(1)</script> 和 <img src=x onerror=1>');
  assert.equal(blocks[0].type, "paragraph");
  assert.ok(blocks[0].text.includes("<script>"));
});

test("deriveTitle reads the first non-empty line without its marker", () => {
  assert.equal(deriveTitle("\n\n# 周会记录\n正文"), "周会记录");
  assert.equal(deriveTitle("- 一条待办"), "一条待办");
  assert.equal(deriveTitle("   "), "无标题笔记");
  assert.equal(deriveTitle("x".repeat(60)).length, 41);
});
