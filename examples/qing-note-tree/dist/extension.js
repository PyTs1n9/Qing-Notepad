// src/tree.ts
function folderKey(id) {
  return `folder:${id}`;
}
function noteKey(id) {
  return `note:${id}`;
}
function reachesTop(id, byId) {
  let cursor = byId.get(id)?.parentId ?? null;
  let guard = 0;
  while (cursor) {
    if (guard > byId.size) return false;
    const parent = byId.get(cursor);
    if (!parent) return true;
    cursor = parent.parentId ?? null;
    guard += 1;
  }
  return true;
}
function sortTree(node) {
  node.children.sort((a, b) => {
    const rankA = a.ref.kind === "note" ? 1 : 0;
    const rankB = b.ref.kind === "note" ? 1 : 0;
    if (rankA !== rankB) return rankA - rankB;
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title);
  });
  for (const child of node.children) sortTree(child);
}
function buildTree(data, rootLabel) {
  const root = {
    key: "root",
    ref: { kind: "root", label: rootLabel },
    title: rootLabel,
    order: 0,
    children: []
  };
  const byId = new Map(data.folders.map((folder) => [folder.id, folder]));
  const folderNodes = /* @__PURE__ */ new Map();
  for (const folder of data.folders) {
    folderNodes.set(folder.id, {
      key: folderKey(folder.id),
      ref: { kind: "folder", id: folder.id },
      title: folder.name,
      order: folder.order,
      children: []
    });
  }
  for (const folder of data.folders) {
    const node = folderNodes.get(folder.id);
    if (!node) continue;
    const parent = folder.parentId ? folderNodes.get(folder.parentId) : void 0;
    if (parent && reachesTop(folder.id, byId)) parent.children.push(node);
    else root.children.push(node);
  }
  for (const note of data.notes) {
    const node = {
      key: noteKey(note.id),
      ref: { kind: "note", id: note.id },
      title: note.title,
      order: note.order,
      children: []
    };
    const parent = note.categoryId ? folderNodes.get(note.categoryId) : void 0;
    (parent ?? root).children.push(node);
  }
  sortTree(root);
  return root;
}

// src/layout.ts
var NODE_WIDTH = 240;
var NODE_HEIGHT = 92;
var LAYER_GAP = 320;
var SIBLING_GAP = 24;
function measure(node, memo) {
  const cached = memo.get(node.key);
  if (cached !== void 0) return cached;
  const height = node.children.length === 0 ? NODE_HEIGHT : node.children.reduce((sum, child) => sum + measure(child, memo), 0) + SIBLING_GAP * (node.children.length - 1);
  memo.set(node.key, height);
  return height;
}
function layoutTree(root) {
  const memo = /* @__PURE__ */ new Map();
  const nodes = [];
  const edges = [];
  const place = (node, depth, top) => {
    const span = measure(node, memo);
    nodes.push({
      node,
      x: depth * LAYER_GAP,
      y: top + span / 2 - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT
    });
    let cursor = top;
    for (const child of node.children) {
      const childSpan = measure(child, memo);
      edges.push([node.key, child.key]);
      place(child, depth + 1, cursor);
      cursor += childSpan + SIBLING_GAP;
    }
  };
  place(root, 0, 0);
  const width = nodes.reduce((max, node) => Math.max(max, node.x + node.width), NODE_WIDTH);
  const height = nodes.reduce((max, node) => Math.max(max, node.y + node.height), NODE_HEIGHT);
  return { nodes, edges, width, height };
}

// src/sync.ts
var CACHE_KEY = "note-tree.summaries";
var CACHE_LIMIT = 500;
var EXCERPT_LIMIT = 160;
function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
function stripMarkdown(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/^#{1,6}\s+/gm, "").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>~]/g, "").replace(/^\s*[-+]\s+/gm, "").replace(/\s+/g, " ").trim();
}
function excerptOf(markdown) {
  const plain = stripMarkdown(markdown);
  return plain.length > EXCERPT_LIMIT ? `${plain.slice(0, EXCERPT_LIMIT)}…` : plain;
}
async function loadSummaryCache() {
  try {
    const raw = await qing.storage.get(CACHE_KEY);
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [noteId, value] of Object.entries(raw)) {
      const entry = value;
      if (!entry || typeof entry.hash !== "string" || typeof entry.text !== "string") continue;
      out[noteId] = { hash: entry.hash, text: entry.text };
    }
    return out;
  } catch {
    return {};
  }
}
async function saveSummaryCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length > CACHE_LIMIT) {
    const trimmed = entries.slice(entries.length - CACHE_LIMIT);
    cache = Object.fromEntries(trimmed);
  }
  await qing.storage.set(CACHE_KEY, cache);
}

// src/extension.ts
var PULL_COMMAND = "qing.note-tree.pull";
var SUMMARIZE_COMMAND = "qing.note-tree.summarize";
var CLEAN_COMMAND = "qing.note-tree.cleanMissing";
var ROOT_LABEL = "全部笔记";
var FULL_DETAIL_LIMIT = 150;
var NOTES_PER_FOLDER_LIMIT = 12;
var EXCERPT_LIMIT2 = 200;
var SUMMARY_BATCH = 8;
var SUMMARY_TEXT_LIMIT = 400;
function noteIdOf(node) {
  return node.ref.kind === "note" ? node.ref.id : null;
}
function countNotes(node) {
  const self = node.ref.kind === "note" ? 1 : 0;
  return node.children.reduce((sum, child) => sum + countNotes(child), self);
}
function degrade(root) {
  if (countNotes(root) <= FULL_DETAIL_LIMIT) return { root, omitted: 0 };
  let omitted = 0;
  const trim = (node) => {
    let kept = 0;
    node.children = node.children.filter((child) => {
      if (child.ref.kind !== "note") return true;
      kept += 1;
      if (kept <= NOTES_PER_FOLDER_LIMIT) return true;
      omitted += 1;
      return false;
    });
    for (const child of node.children) trim(child);
  };
  trim(root);
  return { root, omitted };
}
async function pull(options = {}) {
  const data = await qing.notes.tree();
  if (data.folders.length === 0 && data.notes.length === 0) {
    qing.ui.toast("还没有笔记可以画", "info");
    return;
  }
  const { root, omitted } = degrade(buildTree(data, ROOT_LABEL));
  const layout = layoutTree(root);
  const cache = await loadSummaryCache();
  const excerpts = /* @__PURE__ */ new Map();
  const noteNodes = layout.nodes.filter((placed) => placed.node.ref.kind === "note");
  for (const placed of noteNodes.slice(0, EXCERPT_LIMIT2)) {
    const noteId = noteIdOf(placed.node);
    if (!noteId) continue;
    const note = await qing.notes.get(noteId);
    if (note) excerpts.set(placed.node.key, excerptOf(note.content));
  }
  const nodes = layout.nodes.map((placed) => {
    const noteId = noteIdOf(placed.node);
    const cached = noteId ? cache[noteId] : void 0;
    return {
      ref: placed.node.ref,
      title: placed.node.title.trim() || "未命名",
      excerpt: excerpts.get(placed.node.key),
      summary: cached?.text,
      summaryHash: cached?.hash,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height
    };
  });
  const written = await qing.canvas.upsertRefNodes({ nodes });
  await qing.canvas.upsertRefConnectors({
    // Curve + right-to-left anchors is what makes this read as a tree rather
    // than a graph: every edge leaves a parent's right edge and enters a
    // child's left edge, so the whole thing flows one way.
    edges: layout.edges.map(([from, to]) => ({
      from,
      to,
      style: "curve",
      startAnchor: "right",
      endAnchor: "left"
    }))
  });
  if (options.silent) return;
  const parts = [`${nodes.length} 个节点`, `新增 ${written.created}`, `更新 ${written.updated}`];
  if (omitted > 0) parts.push(`省略 ${omitted} 篇（超出单夹上限）`);
  qing.ui.toast(parts.join(" · "), "success");
}
async function summarize() {
  const data = await qing.notes.tree();
  const cache = await loadSummaryCache();
  const pending = data.notes.filter((note) => !cache[note.id]).slice(0, SUMMARY_BATCH);
  if (pending.length === 0) {
    qing.ui.toast("所有笔记都已有摘要", "info");
    return;
  }
  let done = 0;
  let failed = 0;
  for (const note of pending) {
    try {
      const result = await qing.ai.summarize(note.id);
      if (!result) continue;
      const body = await qing.notes.get(note.id);
      cache[note.id] = {
        hash: hashText(body?.content ?? ""),
        text: result.summary.slice(0, SUMMARY_TEXT_LIMIT)
      };
      done += 1;
    } catch {
      failed += 1;
    }
  }
  await saveSummaryCache(cache);
  if (done === 0) {
    qing.ui.toast(failed > 0 ? "摘要生成失败，检查 AI 接口设置" : "没有可用的摘要", "danger");
    return;
  }
  await pull({ silent: true });
  const suffix = failed > 0 ? `，${failed} 篇失败` : "";
  qing.ui.toast(`已为 ${done} 篇生成摘要${suffix}`, "success");
}
async function cleanMissing() {
  const data = await qing.notes.tree();
  const alive = /* @__PURE__ */ new Set(["root"]);
  for (const folder of data.folders) alive.add(`folder:${folder.id}`);
  for (const note of data.notes) alive.add(`note:${note.id}`);
  const { refKeys } = await qing.canvas.listRefKeys();
  const missing = refKeys.filter((key) => !alive.has(key));
  if (missing.length === 0) {
    qing.ui.toast("没有失效节点", "info");
    return;
  }
  const { removed } = await qing.canvas.removeRefNodes({ refKeys: missing });
  qing.ui.toast(`已清理 ${removed} 个失效节点`, "success");
}
qing.commands.register(PULL_COMMAND, () => pull());
qing.commands.register(SUMMARIZE_COMMAND, () => summarize());
qing.commands.register(CLEAN_COMMAND, () => cleanMissing());
qing.log(`${qing.plugin.id}@${qing.plugin.version} ready; node ${NODE_WIDTH}×${NODE_HEIGHT}`);
