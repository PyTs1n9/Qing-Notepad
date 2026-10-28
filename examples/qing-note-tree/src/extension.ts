/**
 * Note library → canvas structure tree.
 *
 * The plugin does three things and nothing else: read the folder/note tree,
 * compute positions, and hand the result to the host. It never touches a board
 * file, never learns a canvas item id, and never draws — the host owns all
 * three, which is what keeps this within `canvas:read` / `canvas:write` instead
 * of asking for the file system.
 *
 * Re-running `pull` is a sync, not a rebuild: the host keys nodes by reference
 * (`note:<id>`), so an existing node keeps the position the user dragged it to
 * and only its title, excerpt and summary are refreshed.
 */

import { buildTree, type TreeNode } from "./tree";
import { layoutTree, NODE_HEIGHT, NODE_WIDTH } from "./layout";
import {
  excerptOf,
  hashText,
  loadSummaryCache,
  saveSummaryCache,
  type SummaryEntry,
} from "./sync";

const PULL_COMMAND = "qing.note-tree.pull";
const SUMMARIZE_COMMAND = "qing.note-tree.summarize";
const CLEAN_COMMAND = "qing.note-tree.cleanMissing";

const ROOT_LABEL = "全部笔记";

/** Above this many nodes the tree stops being readable and starts being slow. */
const FULL_DETAIL_LIMIT = 150;
/** In degraded mode each folder keeps this many notes. */
const NOTES_PER_FOLDER_LIMIT = 12;
/** Reading a body is one host round-trip; stop paying for it past this many. */
const EXCERPT_LIMIT = 200;
/** One AI call per note, on the user's key: keep a single command cheap. */
const SUMMARY_BATCH = 8;
const SUMMARY_TEXT_LIMIT = 400;

function noteIdOf(node: TreeNode): string | null {
  return node.ref.kind === "note" ? node.ref.id : null;
}

function countNotes(node: TreeNode): number {
  const self = node.ref.kind === "note" ? 1 : 0;
  return node.children.reduce((sum, child) => sum + countNotes(child), self);
}

/**
 * Degrade a too-large library instead of refusing it.
 *
 * The alternative — drawing 400 nodes — produces a board that takes seconds to
 * open and a tree nobody can read. Dropping the tail of each folder keeps the
 * shape visible, which is the one thing a structure view is for.
 */
function degrade(root: TreeNode): { root: TreeNode; omitted: number } {
  if (countNotes(root) <= FULL_DETAIL_LIMIT) return { root, omitted: 0 };
  let omitted = 0;
  const trim = (node: TreeNode) => {
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

async function pull(options: { silent?: boolean } = {}): Promise<void> {
  const data = await qing.notes.tree();
  if (data.folders.length === 0 && data.notes.length === 0) {
    qing.ui.toast("还没有笔记可以画", "info");
    return;
  }

  const { root, omitted } = degrade(buildTree(data, ROOT_LABEL));
  const layout = layoutTree(root);
  const cache = await loadSummaryCache();

  const excerpts = new Map<string, string>();
  const noteNodes = layout.nodes.filter((placed) => placed.node.ref.kind === "note");
  for (const placed of noteNodes.slice(0, EXCERPT_LIMIT)) {
    const noteId = noteIdOf(placed.node);
    if (!noteId) continue;
    const note = await qing.notes.get(noteId);
    if (note) excerpts.set(placed.node.key, excerptOf(note.content));
  }

  const nodes = layout.nodes.map((placed) => {
    const noteId = noteIdOf(placed.node);
    const cached: SummaryEntry | undefined = noteId ? cache[noteId] : undefined;
    return {
      ref: placed.node.ref,
      title: placed.node.title.trim() || "未命名",
      excerpt: excerpts.get(placed.node.key),
      summary: cached?.text,
      summaryHash: cached?.hash,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
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
      style: "curve" as const,
      startAnchor: "right" as const,
      endAnchor: "left" as const,
    })),
  });

  if (options.silent) return;
  const parts = [`${nodes.length} 个节点`, `新增 ${written.created}`, `更新 ${written.updated}`];
  if (omitted > 0) parts.push(`省略 ${omitted} 篇（超出单夹上限）`);
  qing.ui.toast(parts.join(" · "), "success");
}

async function summarize(): Promise<void> {
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
        text: result.summary.slice(0, SUMMARY_TEXT_LIMIT),
      };
      done += 1;
    } catch {
      // One refused call (no endpoint, quota, timeout) must not abort the batch:
      // the rest are independent notes and the cache is written at the end.
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

async function cleanMissing(): Promise<void> {
  const data = await qing.notes.tree();
  const alive = new Set<string>(["root"]);
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
