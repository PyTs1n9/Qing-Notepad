#!/usr/bin/env node
/**
 * Logic-level gate for the `qing.snippet` example plugin.
 *
 * The plugin cannot be exercised without the app (its Worker needs Tauri IPC),
 * but the part that can be *wrong* is the part that is pure logic: where
 * `${cursor}` lands after substitutions of different lengths, whether a wrapped
 * `${selection}` stays selected, whether a second import duplicates rows,
 * whether a delete can be undone. All of that is decided inside the bundle, so
 * this script loads `dist/extension.js` with a mock `qing` and drives its
 * commands directly.
 *
 * It is *not* a substitute for installing the .qnp in the app — permission
 * prompts, panel rendering and the worker lifecycle are host-side. See
 * `docs/plugin-guide.md` §6.1 for the three steps that need a human.
 *
 * Zero dependencies, so CI can run it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const bundle = readFileSync(join(root, "examples", "qing-snippet", "dist", "extension.js"), "utf8");
const manifest = JSON.parse(
  readFileSync(join(root, "examples", "qing-snippet", "package.json"), "utf8"),
);

/**
 * The permission gate.
 *
 * Without this the mock says yes to everything, and a manifest that is missing a
 * code still passes every assertion — which is exactly how 1.0.0 shipped without
 * `notify` while calling `ui.toast` on every command: the panel rendered fine,
 * and every command ended in `E_PERMISSION_DENIED` that the user saw as "nothing
 * happened". The table mirrors `src/plugin/bridge.ts::REQUIREMENTS`.
 */
const GRANTED = new Set(manifest.permissions);
const REQUIREMENTS = {
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.delete": "storage",
  "storage.keys": "storage",
  "ui.toast": "notify",
  "editor.getText": "editor:read",
  "editor.getSelection": "editor:read",
  "editor.replace": "editor:write",
  "editor.setSelection": "editor:selection",
  "views.refresh": "views",
};

let denied = [];

function need(method) {
  const permission = REQUIREMENTS[method];
  if (permission && !GRANTED.has(permission)) {
    denied.push(`${method} 需要 ${permission}，清单里没有`);
    throw Object.assign(new Error(`E_PERMISSION_DENIED: ${permission}`), {
      code: "E_PERMISSION_DENIED",
    });
  }
}

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(
    `  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`,
  );
}

function checkMatch(label, actual, pattern) {
  checks += 1;
  if (typeof actual === "string" && pattern.test(actual)) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}\n       pattern ${pattern}\n       actual  ${JSON.stringify(actual)}`);
}

/**
 * A host good enough for this plugin: a Map for `storage`, a real string for
 * the document, and records of every call that changes something.
 */
function createHost(initialDoc = "") {
  const storage = new Map();
  const commands = new Map();
  const host = {
    doc: initialDoc,
    selection: { from: 0, to: 0 },
    caret: null,
    refreshCount: 0,
    toasts: [],
    provider: null,
  };

  const qing = {
    apiVersion: 1,
    hostVersion: "0.7.3",
    plugin: { id: "qing.snippet", version: "1.0.0" },
    permissions: ["storage", "views", "editor:read", "editor:write", "editor:selection"],
    log() {},
    storage: {
      async get(key) {
        need("storage.get");
        return storage.get(key);
      },
      async set(key, value) {
        need("storage.set");
        storage.set(key, value);
      },
      async delete(key) {
        need("storage.delete");
        storage.delete(key);
      },
      async keys() {
        need("storage.keys");
        return [...storage.keys()];
      },
    },
    ui: {
      toast(message) {
        need("ui.toast");
        host.toasts.push(message);
      },
    },
    commands: {
      register(id, handler) {
        commands.set(id, handler);
      },
    },
    editor: {
      async getText(range) {
        need("editor.getText");
        if (!range) return host.doc;
        return host.doc.slice(range.from, range.to);
      },
      async getSelection() {
        need("editor.getSelection");
        const { from, to } = host.selection;
        return { from, to, anchor: from, head: to, text: host.doc.slice(from, to) };
      },
      async replace(range, text) {
        need("editor.replace");
        if (range.from < 0 || range.to > host.doc.length || range.from > range.to) {
          throw Object.assign(new Error("range out of bounds"), { code: "E_RANGE_INVALID" });
        }
        host.doc = host.doc.slice(0, range.from) + text + host.doc.slice(range.to);
      },
      async setSelection(spec) {
        need("editor.setSelection");
        const anchor = "from" in spec ? spec.from : spec.anchor;
        const head = "to" in spec ? spec.to : spec.head;
        host.selection = { from: Math.min(anchor, head), to: Math.max(anchor, head) };
        host.caret = { anchor, head };
      },
    },
    views: {
      registerTreeDataProvider(viewId, provider) {
        // Local registration: the host requires no permission for this.
        host.provider = provider;
        host.viewId = viewId;
      },
      async refresh() {
        need("views.refresh");
        host.refreshCount += 1;
      },
    },
  };

  host.qing = qing;
  host.commands = commands;
  host.start = () => {
    // The bundle is a script, not a module: the host wraps it in a function
    // whose only free variable is `qing`.
    new Function("qing", bundle)(qing);
  };
  return host;
}

/** Run one command the way the host does: with the row id, or without. */
async function run(host, id, itemId) {
  const handler = host.commands.get(id);
  if (!handler) throw new Error(`command ${id} was never registered`);
  try {
    await handler(itemId);
  } catch (error) {
    // A command that throws is a failure even when the assertions after it
    // happen to hold: the user-visible behaviour is "the button did nothing".
    checks += 1;
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL ${id} 抛异常：${message}`);
  }
}

function groupRowId(group) {
  return `g:${encodeURIComponent(group)}`;
}

/** Load snippets through the public path: export, then read the JSON back out. */
async function importPayload(host, entries) {
  const payload = JSON.stringify(entries);
  host.doc = payload;
  host.selection = { from: 0, to: payload.length };
  await run(host, "qing.snippet.import");
}

// ---------------------------------------------------------------------------

console.log("1. 首装播种与面板结构");
{
  const host = createHost();
  host.start();

  check("注册了 6 条命令", host.commands.size, 6);

  const roots = await host.provider.getChildren();
  check(
    "三个分组按内置顺序",
    roots.map((row) => row.label),
    ["写作", "会议", "待办"],
  );
  check("分组行带条数", roots[0].description, "1 条");
  check("分组行可展开", roots[0].collapsibleState, "expanded");
  check("分组行 id 用命名空间", roots[0].id, groupRowId("写作"));

  const meeting = await host.provider.getChildren(groupRowId("会议"));
  check("会议组有一条片段", meeting.map((row) => row.label), ["会议纪要"]);
  check("片段行 id 用命名空间", meeting[0].id.startsWith("s:"), true);
  check("片段行指向插入命令", meeting[0].command, "qing.snippet.insert");

  check("未知行没有子节点", await host.provider.getChildren("s:whatever"), []);
}

console.log("2. 种子片段的占位符全部展开");
{
  const host = createHost("正文");
  host.start();
  host.selection = { from: 2, to: 2 };

  const rows = await host.provider.getChildren(groupRowId("会议"));
  await run(host, "qing.snippet.insert", rows[0].id);

  checkMatch("日期已展开", host.doc, /### \d{4}-\d{2}-\d{2} \d{2}:\d{2} 会议/);
  check("光标落在插入内容末尾", host.caret, { anchor: host.doc.length, head: host.doc.length });
  check("提示已插入", host.toasts.at(-1), "已插入「会议纪要」");
}

console.log("3. ${cursor} 的偏移是替换后的位置，不是模板里的位置");
{
  const host = createHost("");
  host.start();
  await importPayload(host, [{ id: "mid", group: "写作", name: "中间光标", body: "A${date}-${cursor}-B" }]);

  host.doc = "";
  host.selection = { from: 0, to: 0 };
  await run(host, "qing.snippet.insert", "s:mid");

  checkMatch("日期先展开", host.doc, /^A\d{4}-\d{2}-\d{2}--B$/);
  // 若按模板偏移算，光标会落进日期串中间。
  check("光标在 -B 之前", host.caret?.anchor, host.doc.length - 2);
}

console.log("4. 新建片段：取名、分组、超长拒绝");
{
  const host = createHost("## 我的标题\n\n正文内容");
  host.start();
  host.selection = { from: 0, to: host.doc.length };
  await run(host, "qing.snippet.new", groupRowId("会议"));

  check("名字剥掉 # 并取首行", host.toasts.at(-1), "已存为片段「我的标题」");
  const meeting = await host.provider.getChildren(groupRowId("会议"));
  check("进了点中的分组", meeting.map((row) => row.label).includes("我的标题"), true);

  host.selection = { from: 0, to: 5 };
  await run(host, "qing.snippet.new", undefined);
  const ungrouped = await host.provider.getChildren(groupRowId("未分组"));
  check("从命令面板执行进未分组", ungrouped.length, 1);

  host.doc = "x".repeat(20001);
  host.selection = { from: 0, to: host.doc.length };
  await run(host, "qing.snippet.new", undefined);
  check("超长被拒绝", host.toasts.at(-1), "选中的内容有 20001 字符，超过 20000 上限");
}

console.log("5. ${selection} 有选区时换成原文，无选区时塌陷");
{
  const host = createHost("");
  host.start();
  await importPayload(host, [
    { id: "wrap", group: "写作", name: "包裹", body: "**${selection}**" },
    { id: "bare", group: "写作", name: "空包裹", body: "[${selection}]" },
  ]);
  check("导入两条", host.toasts.at(-1), "已导入 2 条片段");

  host.doc = "abcdef";
  host.selection = { from: 1, to: 4 }; // bcd
  await run(host, "qing.snippet.insert", "s:wrap");
  check("有选区时用原文替换", host.doc, "a**bcd**ef");
  check("光标停在插入内容末尾", host.caret, {
    anchor: host.doc.length - 2,
    head: host.doc.length - 2,
  });

  host.doc = "abc";
  host.selection = { from: 1, to: 1 };
  await run(host, "qing.snippet.insert", "s:bare");
  check("无选区时塌成空串", host.doc, "a[]bc");
  check("光标在插入内容末尾", host.caret?.anchor, host.doc.length - 2);
}

console.log("6. ${cursor} 与 ${selection} 同时出现时两者都准");
{
  const host = createHost("");
  host.start();
  await importPayload(host, [
    { id: "both", group: "写作", name: "两者都有", body: ">[${selection}](${date})<-${cursor}" },
  ]);

  host.doc = "ABCDE";
  host.selection = { from: 1, to: 4 }; // BCD
  await run(host, "qing.snippet.insert", "s:both");

  checkMatch("两个占位符都替换了", host.doc, /^A>\[BCD\]\(\d{4}-\d{2}-\d{2}\)<-E$/);
  check("光标在 <- 之后、E 之前", host.caret?.anchor, host.doc.length - 1);
}

console.log("7. 未识别的占位符原样保留");
{
  const host = createHost("");
  host.start();
  await importPayload(host, [{ id: "t", group: "写作", name: "带标题", body: "# ${title}" }]);

  host.doc = "";
  host.selection = { from: 0, to: 0 };
  await run(host, "qing.snippet.insert", "s:t");
  check("${title} 不被吃掉", host.doc, "# ${title}");
}

console.log("8. 删除可撤销一次");
{
  const host = createHost();
  host.start();
  const id = (await host.provider.getChildren(groupRowId("会议")))[0].id;

  await run(host, "qing.snippet.delete", id);
  check("删除后组内为空", await host.provider.getChildren(groupRowId("会议")), []);
  check(
    "提示可恢复",
    host.toasts.at(-1),
    "已删除「会议纪要」，可用「恢复上次删除的片段」找回",
  );

  await run(host, "qing.snippet.restore");
  check("恢复后组内回来", (await host.provider.getChildren(groupRowId("会议"))).length, 1);
  check("恢复的是整张表", host.toasts.at(-1), "已恢复 3 条片段");

  await run(host, "qing.snippet.restore");
  check("第二次恢复无内容", host.toasts.at(-1), "没有可恢复的片段");
}

console.log("9. 从命令面板直接执行时给出可操作提示");
{
  const host = createHost("abc");
  host.start();
  host.selection = { from: 0, to: 3 };

  await run(host, "qing.snippet.insert", undefined);
  check("插入要求先点行", host.toasts.at(-1), "请在「片段」面板里点一条片段");

  await run(host, "qing.snippet.delete", undefined);
  check("删除要求先点行", host.toasts.at(-1), "请在「片段」面板里点一条片段，再执行删除");

  host.selection = { from: 1, to: 1 };
  await run(host, "qing.snippet.new", undefined);
  check("空选区被拒绝", host.toasts.at(-1), "请先选中要存成片段的文字");
  check("文档没有被改动", host.doc, "abc");
}

console.log("10. 导出 → 导入往返，重复导入不产生重复行");
{
  const host = createHost("线上一段文字");
  host.start();
  host.selection = { from: 0, to: host.doc.length };
  await run(host, "qing.snippet.new", groupRowId("待办"));

  host.doc = "";
  host.selection = { from: 0, to: 0 };
  await run(host, "qing.snippet.export");
  checkMatch("导出的是围栏 JSON", host.doc, /^```json\n[\s\S]+\n```\n$/);

  const exported = host.doc;
  const parsed = JSON.parse(exported.replace(/^```json\n/, "").replace(/\n```\n$/, ""));
  check("导出内容能被解析成数组", Array.isArray(parsed), true);
  check("导出包含全部片段", parsed.length, 4);

  host.selection = { from: 0, to: exported.length };
  await run(host, "qing.snippet.import");
  check("重复导入全部跳过", host.toasts.at(-1), `没有新片段可导入（跳过 ${parsed.length} 条）`);
  check("组内条数没变", (await host.provider.getChildren(groupRowId("待办"))).length, 2);
}

console.log("11. 坏输入不会写坏数据");
{
  const host = createHost("这不是 JSON");
  host.start();
  host.selection = { from: 0, to: host.doc.length };
  await run(host, "qing.snippet.import");
  check("非 JSON 被拒绝", host.toasts.at(-1), "选中的内容不是片段 JSON");

  await importPayload(host, [{ id: "x", group: "写作", name: "", body: "" }, { nope: 1 }]);
  check("没有可用条目", host.toasts.at(-1), "没有新片段可导入（跳过 0 条）");
  check("原有片段没被清掉", (await host.provider.getChildren()).length, 3);
}

// ---------------------------------------------------------------------------

console.log("");
check("全程没有权限拒绝", denied, []);

if (failures > 0) {
  console.error(`${failures} / ${checks} checks failed`);
  process.exit(1);
}
console.log(`all ${checks} checks passed`);
