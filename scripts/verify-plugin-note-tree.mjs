#!/usr/bin/env node
/**
 * Logic-level gate for the `qing.note-tree` example plugin.
 *
 * The plugin cannot run without the app (its worker needs Tauri IPC), but the
 * parts that can be *wrong* are pure logic: does an empty library still produce
 * a root, does an uncategorised note land under the root, does a second run
 * keep the positions the user dragged, does a 200-note library degrade instead
 * of drawing 200 cards, does `cleanMissing` name exactly the dead notes.
 *
 * This loads `dist/extension.js` with a mock `qing` whose canvas behaves like
 * the host's: upsert by reference key, existing node keeps its geometry, edges
 * deduplicated, removing a node removes the edges bound to it.
 *
 * It is *not* a substitute for installing the .qnp: permission prompts, the
 * worker lifecycle and the actual rendering are host-side.
 *
 * Zero dependencies, so CI can run it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const bundle = readFileSync(join(root, "examples", "qing-note-tree", "dist", "extension.js"), "utf8");

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

function checkTrue(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

function refKeyOf(ref) {
  return ref.kind === "root" ? "root" : `${ref.kind}:${ref.id}`;
}

/**
 * A host good enough for this plugin. The canvas mock is deliberately strict
 * about the one rule that matters: an existing reference node keeps its x/y.
 */
function createHost(library) {
  const storage = new Map();
  const commands = new Map();
  const canvas = { items: [], seq: 0, hiddenCalls: [], removed: [] };
  const state = {
    library,
    toasts: [],
    summaryCalls: [],
    canvas,
  };

  const idFor = (ref) => `item-${(canvas.seq += 1)}`;

  const qing = {
    apiVersion: 1,
    hostVersion: "0.7.3",
    plugin: { id: "qing.note-tree", version: "1.0.0" },
    permissions: ["notes:read", "canvas:read", "canvas:write", "ai:summarize", "storage", "notify"],
    log() {},
    storage: {
      async get(key) {
        return storage.get(key);
      },
      async set(key, value) {
        storage.set(key, value);
      },
    },
    ui: {
      toast(message, tone) {
        state.toasts.push({ message, tone });
      },
    },
    commands: {
      register(id, handler) {
        commands.set(id, handler);
      },
    },
    notes: {
      async tree() {
        return {
          folders: state.library.folders.map((folder) => ({ ...folder })),
          notes: state.library.notes.map((note) => ({ ...note })),
        };
      },
      async get(id) {
        const note = state.library.notes.find((item) => item.id === id);
        if (!note) return null;
        return { id: note.id, title: note.title, tags: [], content: note.content ?? `# ${note.title}` };
      },
    },
    canvas: {
      async listRefKeys() {
        return {
          boardId: "board-1",
          refKeys: canvas.items.filter((item) => item.type === "ref").map((item) => refKeyOf(item.ref)),
        };
      },
      async upsertRefNodes({ nodes }) {
        let created = 0;
        let updated = 0;
        const idByRefKey = {};
        for (const input of nodes) {
          const key = refKeyOf(input.ref);
          const existing = canvas.items.find((item) => item.type === "ref" && refKeyOf(item.ref) === key);
          if (existing) {
            existing.title = input.title;
            existing.excerpt = input.excerpt;
            existing.summary = input.summary;
            existing.summaryHash = input.summaryHash;
            updated += 1;
            idByRefKey[key] = existing.id;
            continue;
          }
          const item = { id: idFor(input.ref), type: "ref", ...input };
          canvas.items.push(item);
          created += 1;
          idByRefKey[key] = item.id;
        }
        state.lastUpsert = { created, updated };
        return { idByRefKey, created, updated };
      },
      async upsertRefConnectors({ edges }) {
        const seen = new Set();
        for (const item of canvas.items) {
          if (item.type !== "connector") continue;
          seen.add(`${item.start}->${item.end}`);
        }
        let created = 0;
        for (const edge of edges) {
          const key = `${edge.from}->${edge.to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          canvas.items.push({ id: `edge-${(canvas.seq += 1)}`, type: "connector", start: edge.from, end: edge.to, style: edge.style });
          created += 1;
        }
        state.lastEdges = created;
        return { created };
      },
      async setNodesHidden({ refKeys, hidden }) {
        canvas.hiddenCalls.push({ refKeys, hidden });
        let changed = 0;
        for (const item of canvas.items) {
          if (item.type !== "ref") continue;
          if (!refKeys.includes(refKeyOf(item.ref))) continue;
          if ((item.hidden ?? false) === hidden) continue;
          item.hidden = hidden;
          changed += 1;
        }
        return { changed };
      },
      async removeRefNodes({ refKeys }) {
        const doomed = new Set();
        for (const item of canvas.items) {
          if (item.type === "ref" && refKeys.includes(refKeyOf(item.ref))) doomed.add(item.id);
        }
        const countRefs = () => canvas.items.filter((item) => item.type === "ref").length;
        const before = countRefs();
        canvas.items = canvas.items.filter((item) => {
          if (item.type === "ref") return !doomed.has(item.id);
          if (item.type === "connector") {
            return !refKeys.includes(item.start) && !refKeys.includes(item.end);
          }
          return true;
        });
        canvas.removed.push(...refKeys);
        return { removed: before - countRefs() };
      },
    },
    ai: {
      async summarize(noteId) {
        state.summaryCalls.push(noteId);
        if (noteId === "boom") throw Object.assign(new Error("no endpoint"), { code: "E_NO_PROVIDER" });
        return { summary: `摘要 ${noteId}`, title: "t" };
      },
    },
  };

  state.qing = qing;
  state.commands = commands;
  state.start = () => {
    // The bundle is a script, not a module: the host wraps it in a function
    // whose only free variable is `qing`.
    new Function("qing", bundle)(qing);
  };
  return state;
}

async function run(host, id) {
  const handler = host.commands.get(id);
  if (!handler) throw new Error(`command ${id} was never registered`);
  await handler();
}

function refNodes(host) {
  return host.canvas.items.filter((item) => item.type === "ref");
}

function nodeByKey(host, key) {
  return refNodes(host).find((item) => refKeyOf(item.ref) === key);
}

const sampleLibrary = () => ({
  folders: [
    { id: "f1", name: "技术", parentId: null, order: 0 },
    { id: "f2", name: "前端", parentId: "f1", order: 0 },
    { id: "f3", name: "后端", parentId: "f1", order: 1 },
  ],
  notes: [
    { id: "n1", title: "React 19", categoryId: "f2", order: 0 },
    { id: "n2", title: "Tauri", categoryId: "f3", order: 0 },
    { id: "n3", title: "随手记", categoryId: null, order: 0 },
  ],
});

// ---------------------------------------------------------------------------

console.log("1. 空库");
{
  const host = createHost({ folders: [], notes: [] });
  host.start();
  check("注册了 3 条命令", host.commands.size, 3);
  await run(host, "qing.note-tree.pull");
  check("没有创建任何节点", refNodes(host).length, 0);
  checkTrue("提示没有笔记", host.toasts.some((toast) => toast.message.includes("还没有笔记")));
}

console.log("2. 三层文件夹 + 未分类笔记");
{
  const host = createHost(sampleLibrary());
  host.start();
  await run(host, "qing.note-tree.pull");

  check("节点数 = 文件夹 3 + 笔记 3 + 根 1", refNodes(host).length, 7);
  check("连线数 = 节点数 - 1", host.canvas.items.filter((i) => i.type === "connector").length, 6);
  check("根节点唯一", refNodes(host).filter((item) => item.ref.kind === "root").length, 1);

  const edges = host.canvas.items.filter((i) => i.type === "connector").map((i) => `${i.start}->${i.end}`);
  checkTrue("未分类笔记挂在根下", edges.includes("root->note:n3"), edges.join(", "));
  checkTrue("子文件夹挂在父文件夹下", edges.includes("folder:f1->folder:f2"), edges.join(", "));
  checkTrue("笔记挂在自己的文件夹下", edges.includes("folder:f2->note:n1"), edges.join(", "));
  checkTrue("连线用曲线", host.canvas.items.filter((i) => i.type === "connector").every((i) => i.style === "curve"));

  const f1 = nodeByKey(host, "folder:f1");
  const f2 = nodeByKey(host, "folder:f2");
  const n1 = nodeByKey(host, "note:n1");
  checkTrue("层级越深 x 越大", f1.x < f2.x && f2.x < n1.x, `${f1.x} / ${f2.x} / ${n1.x}`);
  checkTrue("同一父下的兄弟不重叠", nodeByKey(host, "folder:f2").y + 92 <= nodeByKey(host, "folder:f3").y);

  check("笔记节点带上了摘要片段", typeof nodeByKey(host, "note:n1").excerpt, "string");
}

console.log("3. 二次拉取是同步而不是重建");
{
  const host = createHost(sampleLibrary());
  host.start();
  await run(host, "qing.note-tree.pull");
  const before = nodeByKey(host, "note:n1");
  const dragged = { x: 999, y: 777 };
  before.x = dragged.x;
  before.y = dragged.y;

  host.library.notes.find((note) => note.id === "n1").title = "React 19 改";
  await run(host, "qing.note-tree.pull");

  check("没有新建节点", host.lastUpsert.created, 0);
  check("节点总数不变", refNodes(host).length, 7);
  check("位置保留在用户拖动处", { x: nodeByKey(host, "note:n1").x, y: nodeByKey(host, "note:n1").y }, dragged);
  check("标题跟随源笔记", nodeByKey(host, "note:n1").title, "React 19 改");
  check("连线不重复创建", host.lastEdges, 0);
}

console.log("4. 清理失效节点");
{
  const host = createHost(sampleLibrary());
  host.start();
  await run(host, "qing.note-tree.pull");

  host.library.notes = host.library.notes.filter((note) => note.id !== "n3");
  host.library.folders = host.library.folders.filter((folder) => folder.id !== "f3");

  await run(host, "qing.note-tree.cleanMissing");
  check("只点名源里已不存在的引用", host.canvas.removed, ["folder:f3", "note:n3"]);
  check("失效节点连同连线一起消失", host.canvas.items.filter((i) => i.type === "connector").length, 3);
  checkTrue("报告了清理数量", host.toasts.some((toast) => toast.message.includes("已清理")));
}

console.log("5. 规模降级");
{
  const folders = [{ id: "big", name: "大文件夹", parentId: null, order: 0 }];
  const notes = Array.from({ length: 200 }, (_, index) => ({
    id: `bulk-${index}`,
    title: `笔记 ${index}`,
    categoryId: "big",
    order: index,
  }));
  const host = createHost({ folders, notes });
  host.start();
  await run(host, "qing.note-tree.pull");

  check("每夹只保留 12 篇 + 文件夹 + 根", refNodes(host).length, 14);
  checkTrue("提示了省略数量", host.toasts.some((toast) => toast.message.includes("省略 188 篇")));
}

console.log("6. AI 概括按需且缓存");
{
  const host = createHost(sampleLibrary());
  host.start();
  await run(host, "qing.note-tree.summarize");
  check("一次最多处理 8 篇（本次 3 篇）", host.summaryCalls.length, 3);
  check("摘要写进了节点", nodeByKey(host, "note:n1").summary, "摘要 n1");

  await run(host, "qing.note-tree.summarize");
  check("第二次不再调用 AI", host.summaryCalls.length, 3);
  checkTrue("提示都已有摘要", host.toasts.some((toast) => toast.message.includes("都已有摘要")));
}

console.log("7. 一次失败不中断整批");
{
  const library = sampleLibrary();
  library.notes = [
    { id: "boom", title: "会失败的", categoryId: null, order: 0 },
    { id: "n1", title: "正常", categoryId: null, order: 1 },
  ];
  const host = createHost(library);
  host.start();
  await run(host, "qing.note-tree.summarize");
  check("两篇都尝试过", host.summaryCalls, ["boom", "n1"]);
  check("成功的那篇有摘要", nodeByKey(host, "note:n1").summary, "摘要 n1");
  checkTrue("报告了失败数", host.toasts.some((toast) => toast.message.includes("1 篇失败")));
}

// ---------------------------------------------------------------------------

console.log(`\n${checks} 项断言，${failures} 项失败`);
if (failures > 0) process.exit(1);
