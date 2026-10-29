/**
 * The graph index's only write entry point.
 *
 * §3.2.4 boundary 1: every node / edge mutation goes through here, so the store
 * below never sees an ad-hoc write. That is what keeps the journal a faithful
 * log of what changed — one caller with a stray `nodes.set()` would desynchronise
 * the journal from the in-memory snapshot, and the next replay would silently
 * resurrect a deleted node.
 *
 * The write path deliberately does not touch edges when a node is removed: edges
 * keep pointing at the id the link resolved to, and `deriveSnapshot` renders a
 * target-without-node as dangling. Deleting a note is the cheapest possible
 * operation and, more importantly, restoring the file heals the graph with no
 * rewrite at all (§3.4.2 / §3.4.4 in one place).
 */
import type { FileStamp, GraphNode, ParsedLink } from "@/types/graph";
import { danglingNodeId } from "@/utils/graph/ids";
import { dirnameOf, normalizeTarget } from "@/utils/graph/linkResolver";
import type { CandidateTable } from "@/utils/graph/linkResolver";
import { resolveLink } from "@/utils/graph/linkResolver";
import { fileNameTitle } from "@/utils/graph/noteTitle";
import type { GraphIndexStore, IndexEdge } from "@/utils/graph/graphIndexStore";
import { NATIVE_SHARD_KEY } from "@/utils/graph/graphIndexStore";

/** 一次重命名修补的配对结果（纯匹配，不写盘）。 */
export interface RenamePair {
  from: FileStamp;
  to: FileStamp;
}

export interface RenamePlan {
  renames: RenamePair[];
  /** 没能配对的删除。 */
  removed: FileStamp[];
  /** 没能配对的新增。 */
  added: FileStamp[];
}

export interface GraphIndexer {
  upsertNode(node: GraphNode, edges: readonly IndexEdge[], stamp: FileStamp | null): Promise<void>;
  /** 删除节点并返回是否真的删掉了（未知 id 幂等返回 false）。 */
  removeNode(id: string): Promise<boolean>;
  /**
   * 重命名修补：把旧 id 迁移到新路径上。
   *
   * id 必须保持（§3.4.3 的全部意义就在此），所以这里用 `next` 的字段覆盖旧节点，
   * 但 id 仍用 `fromId`；`next` 自己是按新路径派生出来的 id，如果它在 store 里
   * 存在（上一次扫描留下的），要先删掉，否则会留下两个节点。
   */
  migrateNode(
    fromId: string,
    next: GraphNode,
    edges: readonly IndexEdge[],
    stamp: FileStamp,
  ): Promise<boolean>;
}

/** 分片键：原生笔记固定 `native`，其余用 vaultKey（§8.2 定案 1）。 */
export function shardKeyOf(node: Pick<GraphNode, "vaultKey">): string {
  return node.vaultKey ?? NATIVE_SHARD_KEY;
}

/**
 * 把一篇正文的链接落成边。
 *
 * 三件事只在这里发生，别处不要重复实现：
 * - 自环不建边（§3.4.4）。`[[#锚点]]` 在扫描阶段就被丢掉了，这里处理的是
 *   `[[本文标题]]` 这种解析到自己身上的写法。
 * - 没解析到的目标（missing / ambiguous）落成 `d-<hash(归一化目标)>` 的悬空 id，
 *   并把原文与候选数记在边上 —— 这是快照重建 `DanglingRef` 的唯一来源。
 * - 边去重不做：同一对 (source, target) 的多条边是不同行号的不同事实，反链面板
 *   要能列出"3 处引用"；视觉合并由渲染层负责（§3.4.4）。
 */
export function toIndexEdges(
  node: GraphNode,
  links: readonly ParsedLink[],
  table: CandidateTable,
): IndexEdge[] {
  const edges: IndexEdge[] = [];
  for (const link of links) {
    const resolution = resolveLink({ link, from: node, table });
    if (resolution.status === "resolved") {
      if (resolution.nodeId === node.id) continue;
      edges.push({
        source: node.id,
        target: resolution.nodeId,
        kind: link.kind,
        line: link.line,
        raw: link.raw,
      });
      continue;
    }
    const normalized = normalizeTarget(link.rawTarget);
    // `[[|别名]]` 这类没有目标的写法：不建边，也不造悬空节点。
    if (!normalized) continue;
    edges.push({
      source: node.id,
      target: danglingNodeId(normalized),
      kind: link.kind,
      line: link.line,
      raw: link.raw,
      rawTarget: link.rawTarget,
      normalized,
      candidateCount: resolution.status === "ambiguous" ? resolution.candidateCount : 1,
    });
  }
  return edges;
}

/**
 * §3.4.3 的三步配对，纯函数、不读文件。
 *
 * 第 1 步 `(bytes, mtimeMs)`：同一秒内内容长度也相同的两个*不同*文件几乎不可能
 * 出现，所以这一对命中就直接认定为重命名，连 hash 都不用看。
 * 第 2 步 `contentHash`（前 512 字节 + 长度）：处理"改名同时改了内容"的情况。
 * 第 3 步剩下的按"删除 + 新增"。**一对多不猜**：错配会把两篇不相关的笔记合并成
 * 一个节点，比坐标丢失严重得多。
 */
export function repairRenames(
  removed: readonly FileStamp[],
  added: readonly FileStamp[],
): RenamePlan {
  const remainingRemoved = [...removed];
  const remainingAdded = [...added];
  const renames: RenamePair[] = [];

  const pairByKey = (keyOf: (stamp: FileStamp) => string): void => {
    const groups = new Map<string, FileStamp[]>();
    for (const stamp of remainingRemoved) {
      const key = keyOf(stamp);
      if (!key) continue;
      const list = groups.get(key);
      if (list) list.push(stamp);
      else groups.set(key, [stamp]);
    }
    for (const stamp of [...remainingAdded]) {
      const key = keyOf(stamp);
      if (!key) continue;
      const candidates = groups.get(key);
      if (!candidates || candidates.length !== 1) continue;
      const from = candidates[0];
      // 同一个 key 在新增侧也只允许一个，否则"一对多"必须放弃猜测。
      const sameKeyAdded = remainingAdded.filter((item) => keyOf(item) === key);
      if (sameKeyAdded.length !== 1) continue;
      renames.push({ from, to: stamp });
      groups.delete(key);
      remainingRemoved.splice(remainingRemoved.indexOf(from), 1);
      remainingAdded.splice(remainingAdded.indexOf(stamp), 1);
    }
  };

  pairByKey((stamp) => `${stamp.bytes}:${stamp.mtimeMs}`);
  pairByKey((stamp) => stamp.hash);

  renames.sort((left, right) => left.from.relPath.localeCompare(right.from.relPath));
  return { renames, removed: remainingRemoved, added: remainingAdded };
}

/**
 * 文件名（percent-decode + 去扩展名，疑似编码名再加父目录）作为标题回退。
 *
 * 规则本体在 `noteTitle.fileNameTitle`，这里只转发：标题候选链的第 5/6 级与
 * 这里的回退必须是**同一个函数**，否则重命名修补（`migrateNode` 用新路径派生
 * 字段）会写出与首次解析不同的标题。v1 的 `stripNoteExtension(basenameOf(…))`
 * 已经并进那个函数。
 */
export function fallbackTitle(relPath: string): string {
  return fileNameTitle(relPath);
}

/** vault 节点 id 之外的公共字段，供 graphSync 与原生笔记接入共用。 */
export function vaultNodeFields(relPath: string): Pick<GraphNode, "refId" | "path" | "dir" | "title"> {
  return {
    refId: relPath,
    path: relPath,
    dir: dirnameOf(relPath),
    title: fallbackTitle(relPath),
  };
}

export interface GraphIndexerOptions {
  store: GraphIndexStore;
}

export function createGraphIndexer(options: GraphIndexerOptions): GraphIndexer {
  const { store } = options;

  const indexer: GraphIndexer = {
    async upsertNode(node, edges, stamp) {
      await store.upsert(shardKeyOf(node), node, edges, stamp);
    },

    async removeNode(id) {
      const existing = store.node(id);
      if (!existing) return false;
      await store.remove(shardKeyOf(existing), id);
      return true;
    },

    async migrateNode(fromId, next, edges, stamp) {
      const existing = store.node(fromId);
      if (!existing) return false;
      const shardKey = shardKeyOf(existing);
      if (next.id !== fromId) await store.remove(shardKeyOf(next), next.id);
      const merged: GraphNode = { ...next, id: fromId };
      await store.upsert(shardKey, merged, edges, { ...stamp, id: fromId });
      return true;
    },
  };

  return indexer;
}
