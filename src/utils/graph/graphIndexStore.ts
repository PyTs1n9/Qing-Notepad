/**
 * Graph index persistence: per-vault shards, an append-only journal, and
 * compaction (§8.2 verbatim).
 *
 * Why a journal at all: §3.5.2's original "rewrite the whole shard every 30 s"
 * was written before directory watching existed. With a watcher, one external
 * save is one write, and a 2 MB rewrite per save is ~1.2 GB/hour. Appending one
 * ~200 B line per save and compacting every 5000 lines brings that down by
 * three orders of magnitude (§8.2 point 5).
 *
 * Layout, under `<data>/graph/index/`:
 *
 * ```
 * meta.json                          aggregate counts + schemaVersion + skipped
 * positions.ndjson                   layout cache (layoutEngine owns it)
 * vaults/<shardKey>/
 *   nodes.ndjson                     one GraphNode per line
 *   edges.ndjson                     one row per *source* node (§3.2.2)
 *   stamps.ndjson                    one FileStamp per line
 *   journal.ndjson                   upsert / remove entries since last compact
 * ```
 *
 * Two decisions worth calling out because they are load-bearing:
 *
 * 1. **Dangling nodes are never stored.** §3.2.1 says a dangling node "不落盘为
 *    独立记录", and that is also the only way the graph self-heals: an edge keeps
 *     pointing at the id of the file it resolved to, so when that file comes back
 *    the node exists again and the edge is a real edge with no rewrite. The
 *    dangling set (and every `DanglingRef`) is therefore derived from edges whose
 *    target has no node record.
 *
 *    **Consequence the renderer depends on: a dangling node's id may start with
 *    `v-` (the file was deleted after parsing) or with `d-` (the target never
 *    resolved). Consumers must branch on `node.kind === "dangling"` and must
 *    never infer dangling-ness from the id prefix.** Two edges into one dead
 *    target also collapse into one virtual node, which is what makes the
 *    "被 N 篇引用" tooltip possible.
 * 2. **Incoming is never stored** (§3.4.1): it is rebuilt from out-edges in one
 *    pass, so "A links to B but B's backlinks miss A" cannot be persisted.
 */
import type {
  DanglingRef,
  FileStamp,
  GraphEdge,
  GraphEdgeKind,
  GraphIndexMeta,
  GraphNode,
  GraphSnapshot,
  IncomingIndex,
} from "@/types/graph";
import { joinPath, type GraphFs } from "@/utils/graph/graphFs";
import { utf8Bytes } from "@/utils/graph/ids";

/**
 * 索引 schema 版本。
 *
 * v1 → v2（标题候选链改版）：`GraphNode.title` 的算法变了（frontmatter →
 * H1 → H2–H6 → 正文首行 → 文件名），而标题不在 journal 的"变化"判据里 ——
 * `stamps.ndjson` 只记 mtime/bytes/hash，所以**只升版本号不清分片，图上就永远
 * 是旧标题**：文件没被改动，`syncVault` 连读都不会读它。
 *
 * v2 → v3（同一轮里的规则修正）：单段超长正文改为"前 40 字 + `…`"而不是回退
 * 文件名（P1），frontmatter 的块标量 / 嵌套映射不再产出候选，frontmatter 值要
 * 清洗。v2 从未发布，但本地 dev / QA 的 profile 可能已经写过 v2 的 meta.json，
 * 而复用版本号会让"升级首开即重算"的承诺恰好在这几台机器上不成立 —— 所以直接
 * 推进到 v3，代价只是一次全量重建（坐标保留）。
 *
 * 因此版本不符时 `load()` 会删掉 `vaults/<key>/` 下的分片（见那里的注释），
 * 让下一轮同步把每个文件都当成新增重读一次。这个版本号是"标题规则"的版本，
 * 不只是文件格式的版本：**规则再变就继续 +1，绝不复用旧号**。
 */
export const GRAPH_INDEX_SCHEMA_VERSION = 3;
/** 原生笔记固定分片键（§8.2 定案 1）。 */
export const NATIVE_SHARD_KEY = "native";
/** compact 阈值（§8.2 定案 3）。 */
export const JOURNAL_MAX_LINES = 5000;
export const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
/** §3.2.2 的边行里带 `w`（视觉权重）。v1 恒为 1，字段先占位，v2 的语义边要调权时
 *  不用改 schema。 */
export const DEFAULT_EDGE_WEIGHT = 1;

const NODES_FILE = "nodes.ndjson";
const EDGES_FILE = "edges.ndjson";
const STAMPS_FILE = "stamps.ndjson";
const JOURNAL_FILE = "journal.ndjson";
const META_FILE = "meta.json";

/**
 * An edge as it is stored.
 *
 * `GraphEdge` is the public shape; the three optional fields only exist on
 * edges whose target did not resolve, and they are what makes `DanglingRef`
 * reconstructable without a fifth file (see the module comment).
 */
export interface IndexEdge extends GraphEdge {
  /** 用户写的目标原文，仅在目标悬空时记录。 */
  rawTarget?: string;
  /** 归一化后的目标，仅在目标悬空时记录。 */
  normalized?: string;
  /** 1 = 真的不存在；>1 = 歧义。仅在目标悬空时记录。 */
  candidateCount?: number;
}

export interface SkippedFile {
  relPath: string;
  reason: string;
}

interface StoredEdgeWire {
  t: string;
  k: GraphEdgeKind;
  w: number;
  line: number;
  raw: string;
  rt?: string;
  n?: string;
  cc?: number;
}

interface UpsertEntry {
  op: "upsert";
  ts: number;
  node: GraphNode;
  edges: IndexEdge[];
  stamp: FileStamp | null;
}

interface RemoveEntry {
  op: "remove";
  ts: number;
  id: string;
}

export type JournalEntry = UpsertEntry | RemoveEntry;

export interface JournalStats {
  lines: number;
  bytes: number;
}

interface ShardState {
  key: string;
  nodes: Map<string, GraphNode>;
  edgesBySource: Map<string, IndexEdge[]>;
  stamps: Map<string, FileStamp>;
  journal: JournalStats;
}

export interface GraphIndexStoreOptions {
  fs: GraphFs;
  /** `<data>/graph/index`；由调用方解析（见 graphSync）。 */
  root: string;
}

export interface GraphIndexStore {
  readonly root: string;
  /** 读全部快照 + 重放全部 journal。启动时调一次。 */
  load(): Promise<void>;
  shardKeys(): string[];
  node(id: string): GraphNode | undefined;
  nodes(): GraphNode[];
  edges(): GraphEdge[];
  stamps(shardKey: string): FileStamp[];
  journalStats(shardKey: string): JournalStats;
  upsert(
    shardKey: string,
    node: GraphNode,
    edges: readonly IndexEdge[],
    stamp: FileStamp | null,
  ): Promise<void>;
  remove(shardKey: string, id: string): Promise<void>;
  setSkipped(shardKey: string, skipped: readonly SkippedFile[]): void;
  snapshot(builtAt?: string): GraphSnapshot;
  compact(shardKey: string): Promise<void>;
  /**
   * 注销一个 vault：删该分片的目录与内存。`vault_remove` 之后必须调它，否则
   * 白名单里已经没有这个 vault，图上却还留着它的节点（而且是永远扫不到的孤儿）。
   */
  dropShard(shardKey: string): Promise<void>;
  writeMeta(): Promise<void>;
  /** 删掉整个 `index/`（schemaVersion 不符或人工「重建」按钮）。 */
  deleteAll(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Wire format                                                                */
/* -------------------------------------------------------------------------- */

export function serializeEdge(edge: IndexEdge): StoredEdgeWire {
  const wire: StoredEdgeWire = {
    t: edge.target,
    k: edge.kind,
    w: DEFAULT_EDGE_WEIGHT,
    line: edge.line,
    raw: edge.raw,
  };
  if (edge.rawTarget !== undefined) wire.rt = edge.rawTarget;
  if (edge.normalized !== undefined) wire.n = edge.normalized;
  if (edge.candidateCount !== undefined) wire.cc = edge.candidateCount;
  return wire;
}

function isEdgeKind(value: unknown): value is GraphEdgeKind {
  return value === "wiki" || value === "embed" || value === "markdown";
}

export function deserializeEdge(source: string, wire: unknown): IndexEdge | null {
  if (typeof wire !== "object" || wire === null) return null;
  const record = wire as Partial<StoredEdgeWire>;
  if (typeof record.t !== "string" || !isEdgeKind(record.k)) return null;
  const edge: IndexEdge = {
    source,
    target: record.t,
    kind: record.k,
    line: typeof record.line === "number" ? record.line : 0,
    raw: typeof record.raw === "string" ? record.raw : "",
  };
  if (typeof record.rt === "string") edge.rawTarget = record.rt;
  if (typeof record.n === "string") edge.normalized = record.n;
  if (typeof record.cc === "number") edge.candidateCount = record.cc;
  return edge;
}

function isGraphNode(value: unknown): value is GraphNode {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<GraphNode>;
  return typeof record.id === "string" && typeof record.refId === "string";
}

function isFileStamp(value: unknown): value is FileStamp {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<FileStamp>;
  return typeof record.id === "string" && typeof record.relPath === "string";
}

function toJournalEntry(value: unknown): JournalEntry | null {
  if (typeof value !== "object" || value === null) return null;
  // `UpsertEntry & RemoveEntry` 会把 `op` 收窄成 never（两个字面量互斥），所以
  // 这里显式按字段收窄，而不是拿联合类型做 Partial。
  const record = value as {
    op?: unknown;
    ts?: unknown;
    id?: unknown;
    node?: unknown;
    edges?: unknown;
    stamp?: unknown;
  };
  const ts = typeof record.ts === "number" ? record.ts : 0;
  if (record.op === "remove" && typeof record.id === "string") {
    return { op: "remove", ts, id: record.id };
  }
  if (record.op === "upsert" && isGraphNode(record.node)) {
    const node = record.node;
    const edges = Array.isArray(record.edges)
      ? record.edges
          .map((wire) => deserializeEdge(node.id, wire))
          .filter((edge): edge is IndexEdge => edge !== null)
      : [];
    return {
      op: "upsert",
      ts,
      node,
      edges,
      stamp: isFileStamp(record.stamp) ? record.stamp : null,
    };
  }
  return null;
}

/**
 * Split a journal into entries.
 *
 * A crash can leave a half-written last line. It is dropped (`truncated: true`)
 * and everything before it is still replayed: the journal and the snapshot files
 * are both derived cache, so losing the last write only costs one re-scan.
 */
export function parseJournalText(text: string): { entries: JournalEntry[]; truncated: boolean } {
  const entries: JournalEntry[] = [];
  let truncated = false;
  const segments = text.split("\n");
  const lastIndex = segments.length - 1;
  for (let index = 0; index < segments.length; index += 1) {
    const raw = segments[index];
    if (!raw.trim()) continue;
    try {
      const entry = toJournalEntry(JSON.parse(raw) as unknown);
      if (entry) entries.push(entry);
    } catch {
      // 最后一段且没有换行结尾 = 半行，明确记为截断；中间坏行直接跳过。
      if (index === lastIndex) truncated = true;
    }
  }
  return { entries, truncated };
}

export function serializeJournalEntry(entry: JournalEntry): string {
  if (entry.op === "remove") {
    return JSON.stringify({ op: "remove", ts: entry.ts, id: entry.id });
  }
  return JSON.stringify({
    op: "upsert",
    ts: entry.ts,
    node: entry.node,
    edges: entry.edges.map(serializeEdge),
    stamp: entry.stamp,
  });
}

function parseNdjsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      // 派生缓存里的一行坏掉，跳过即可：下一次扫描会把它写回来。
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Snapshot derivation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One pass over the shards produces everything the renderer reads.
 *
 * Order: real nodes → edges (with degree counted) → dangling nodes/refs. The
 * dangling pass is what makes deletion cheap: removing a node does not touch a
 * single edge, the inbound edges simply stop resolving (§3.4.2), and come back
 * when the file does.
 */
export function deriveSnapshot(
  shards: readonly ShardState[],
  builtAt: string,
  skipped: readonly SkippedFile[],
): GraphSnapshot {
  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();
  const edges: IndexEdge[] = [];
  const outByNode = new Map<string, GraphEdge[]>();
  const incoming: IncomingIndex = new Map();

  for (const shard of shards) {
    for (const node of shard.nodes.values()) nodes.push({ ...node });
  }
  for (const node of nodes) nodeById.set(node.id, node);

  const degreeById = new Map<string, number>();
  const bump = (id: string, amount: number) => {
    degreeById.set(id, (degreeById.get(id) ?? 0) + amount);
  };

  for (const shard of shards) {
    for (const [source, list] of shard.edgesBySource) {
      if (list.length === 0) continue;
      outByNode.set(source, list);
      for (const edge of list) {
        edges.push(edge);
        bump(source, 1);
        bump(edge.target, 1);
        const sources = incoming.get(edge.target);
        // 同一来源对同一目标的多次引用只在反链列表里出现一次；"几处引用"由
        // outByNode 计数（§3.4.4）。
        if (!sources) incoming.set(edge.target, [source]);
        else if (!sources.includes(source)) sources.push(source);
      }
    }
  }

  for (const node of nodes) node.degree = degreeById.get(node.id) ?? 0;
  const realNodeCount = nodes.length;

  // 悬空节点由「边的目标没有节点记录」派生，并且只活在本快照里（§3.2.1）。
  // 一条指向已删文件的边仍然指向它当初解析到的 id，所以文件回来时这条边自动
  // 变回真边 —— 删除时一个字节都不用改写（§3.4.2）。
  const realIds = new Set(nodeById.keys());
  const synthesized = new Map<string, GraphNode>();
  const dangling: DanglingRef[] = [];
  for (const edge of edges) {
    if (realIds.has(edge.target)) continue;
    const normalized = edge.normalized ?? "";
    const rawTarget = edge.rawTarget ?? edge.raw;
    if (!synthesized.has(edge.target)) {
      synthesized.set(edge.target, {
        id: edge.target,
        kind: "dangling",
        refId: normalized,
        vaultKey: null,
        title: rawTarget,
        path: null,
        dir: null,
        categoryId: null,
        tags: [],
        degree: degreeById.get(edge.target) ?? 0,
        contentHash: null,
        bytes: 0,
        mtimeMs: 0,
        parseError: null,
      });
    }
    dangling.push({
      id: edge.target,
      source: edge.source,
      rawTarget,
      normalized,
      kind: edge.kind,
      line: edge.line,
      candidateCount: edge.candidateCount ?? 1,
    });
  }
  for (const virtual of synthesized.values()) {
    nodes.push(virtual);
    nodeById.set(virtual.id, virtual);
  }

  const meta: GraphIndexMeta = {
    schemaVersion: GRAPH_INDEX_SCHEMA_VERSION,
    builtAt,
    nodeCount: realNodeCount,
    edgeCount: edges.length,
    danglingCount: dangling.length,
    skipped: [...skipped],
  };

  return { nodes, nodeById, edges, outByNode, incoming, dangling, meta };
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

function emptyShard(key: string): ShardState {
  return {
    key,
    nodes: new Map(),
    edgesBySource: new Map(),
    stamps: new Map(),
    journal: { lines: 0, bytes: 0 },
  };
}

function applyUpsert(
  shard: ShardState,
  node: GraphNode,
  edges: readonly IndexEdge[],
  stamp: FileStamp | null,
): void {
  shard.nodes.set(node.id, node);
  if (edges.length > 0) shard.edgesBySource.set(node.id, [...edges]);
  // 出边全没了（例如正文里的链接被删）就必须清掉旧行，否则残留边会永远存在。
  else shard.edgesBySource.delete(node.id);
  if (stamp) shard.stamps.set(stamp.id, stamp);
}

function applyRemove(shard: ShardState, id: string): void {
  // 幂等：不存在的 id 直接忽略（重放可以安全重复，§8.2 定案 4）。
  shard.nodes.delete(id);
  shard.edgesBySource.delete(id);
  shard.stamps.delete(id);
}

interface MetaFile extends GraphIndexMeta {
  shards: { key: string; nodeCount: number; edgeCount: number }[];
}

/**
 * `meta.json` 的读取结果。
 *
 * `stale` 与"文件不存在"必须分开：分片是派生缓存，**版本不符**时整批作废是对的
 * （标题规则变了，旧标题无法就地修补）；但 meta 缺失不等于数据不可信 ——
 * 首次运行没有 meta，只写分片还没写 meta 的崩溃现场也没有 meta，这两种情况
 * 都要按原样装载分片，否则 journal 里还没 compact 的节点会被一起丢掉。
 */
interface MetaReadOutcome {
  meta: MetaFile | null;
  /** true = meta.json 存在但不可用（JSON 坏掉或 schemaVersion 不是当前版本）。 */
  stale: boolean;
}

function nowMs(): number {
  return Date.now();
}

export function createGraphIndexStore(options: GraphIndexStoreOptions): GraphIndexStore {
  const { fs, root } = options;
  const shards = new Map<string, ShardState>();
  const skippedByShard = new Map<string, SkippedFile[]>();

  const vaultsDir = () => joinPath(root, "vaults");
  const shardDir = (key: string) => joinPath(vaultsDir(), key);
  const shardFile = (key: string, file: string) => joinPath(shardDir(key), file);
  const metaFile = () => joinPath(root, META_FILE);

  const ensureShardState = (key: string): ShardState => {
    const existing = shards.get(key);
    if (existing) return existing;
    const created = emptyShard(key);
    shards.set(key, created);
    return created;
  };

  const readIfExists = async (path: string): Promise<string | null> => {
    if (!(await fs.exists(path))) return null;
    try {
      return await fs.readTextFile(path);
    } catch (error) {
      console.warn(`[graph-index] cannot read ${path}:`, error);
      return null;
    }
  };

  const writeAtomic = async (path: string, data: string): Promise<void> => {
    const temporary = `${path}.tmp`;
    await fs.writeTextFile(temporary, data);
    await fs.rename(temporary, path);
  };

  const appendJournal = async (shard: ShardState, entry: JournalEntry): Promise<void> => {
    const line = `${serializeJournalEntry(entry)}\n`;
    await fs.mkdir(shardDir(shard.key), { recursive: true });
    await fs.writeTextFile(shardFile(shard.key, JOURNAL_FILE), line, { append: true });
    shard.journal = {
      lines: shard.journal.lines + 1,
      bytes: shard.journal.bytes + utf8Bytes(line).length,
    };
  };

  const writeShardSnapshot = async (shard: ShardState): Promise<void> => {
    await fs.mkdir(shardDir(shard.key), { recursive: true });
    const nodesBody = [...shard.nodes.values()].map((node) => `${JSON.stringify(node)}\n`).join("");
    const edgesBody = [...shard.edgesBySource.entries()]
      .filter(([, list]) => list.length > 0)
      .map(([source, list]) => JSON.stringify({ s: source, e: list.map(serializeEdge) }))
      .join("\n");
    const stampsBody = [...shard.stamps.values()].map((stamp) => `${JSON.stringify(stamp)}\n`).join("");
    await writeAtomic(shardFile(shard.key, NODES_FILE), nodesBody);
    await writeAtomic(
      shardFile(shard.key, EDGES_FILE),
      edgesBody.length > 0 ? `${edgesBody}\n` : "",
    );
    await writeAtomic(shardFile(shard.key, STAMPS_FILE), stampsBody);
    // journal 清空最后做：中途崩溃只会导致重放一次已经写进快照的条目，而重放是
    // 幂等的（upsert 覆盖、remove 忽略）。
    await writeAtomic(shardFile(shard.key, JOURNAL_FILE), "");
    shard.journal = { lines: 0, bytes: 0 };
  };

  const loadShard = async (key: string): Promise<void> => {
    const shard = ensureShardState(key);
    shard.nodes.clear();
    shard.edgesBySource.clear();
    shard.stamps.clear();
    shard.journal = { lines: 0, bytes: 0 };

    const nodesText = await readIfExists(shardFile(key, NODES_FILE));
    if (nodesText) {
      for (const value of parseNdjsonLines(nodesText)) {
        if (isGraphNode(value)) shard.nodes.set(value.id, value);
      }
    }

    const edgesText = await readIfExists(shardFile(key, EDGES_FILE));
    if (edgesText) {
      for (const value of parseNdjsonLines(edgesText)) {
        if (typeof value !== "object" || value === null) continue;
        const row = value as { s?: unknown; e?: unknown };
        if (typeof row.s !== "string" || !Array.isArray(row.e)) continue;
        const list = row.e
          .map((wire) => deserializeEdge(row.s as string, wire))
          .filter((edge): edge is IndexEdge => edge !== null);
        if (list.length > 0) shard.edgesBySource.set(row.s, list);
      }
    }

    const stampsText = await readIfExists(shardFile(key, STAMPS_FILE));
    if (stampsText) {
      for (const value of parseNdjsonLines(stampsText)) {
        if (isFileStamp(value)) shard.stamps.set(value.id, value);
      }
    }

    const journalText = await readIfExists(shardFile(key, JOURNAL_FILE));
    if (journalText) {
      shard.journal = { lines: 0, bytes: utf8Bytes(journalText).length };
      const { entries } = parseJournalText(journalText);
      for (const entry of entries) {
        if (entry.op === "upsert") applyUpsert(shard, entry.node, entry.edges, entry.stamp);
        else applyRemove(shard, entry.id);
        shard.journal.lines += 1;
      }
    }
  };

  const readMeta = async (): Promise<MetaReadOutcome> => {
    const text = await readIfExists(metaFile());
    if (text === null) return { meta: null, stale: false };
    try {
      const parsed = JSON.parse(text) as MetaFile;
      if (parsed.schemaVersion !== GRAPH_INDEX_SCHEMA_VERSION) return { meta: null, stale: true };
      return { meta: parsed, stale: false };
    } catch {
      return { meta: null, stale: true };
    }
  };

  const store: GraphIndexStore = {
    root,

    async load() {
      shards.clear();
      skippedByShard.clear();
      await fs.mkdir(vaultsDir(), { recursive: true });

      const { meta, stale } = await readMeta();
      if (meta && meta.skipped && meta.skipped.length > 0) {
        // meta 里的 skipped 是上一次运行的扁平快照；本次扫描会用真实分片键覆盖
        // 同名条目，聚合时按 (relPath, reason) 去重。
        skippedByShard.set("*", [...meta.skipped]);
      }

      let entries: string[] = [];
      try {
        entries = await fs.readDir(vaultsDir());
      } catch {
        entries = [];
      }
      // 分片目录名是 shardKey（`native` / 8 位 hex），带 `.` 的是残留的临时文件。
      entries = entries.filter((key) => typeof key === "string" && key !== "" && !key.includes("."));

      /* -------------------------------------------------- schema 升级：整批作废 */
      // 版本不符（v1 → v2 的标题规则改版，或 meta.json 损坏）时，旧分片里的
      // `title` 是旧算法算出来的，而 `stamps.ndjson` 只记 mtime/bytes/hash：
      // 保留分片就等于"文件没改动 → 永远不重读 → 标题永远是旧值"，用户得去点
      // 「刷新索引」才能看到正确结果。所以这里直接删掉分片目录，让下一轮同步
      // 把每个文件都当成新增、全量重读一次（一次性的代价）。
      //
      // 两件事刻意不做：
      // 1. 不动 `index/positions.ndjson` —— 它在 index 根、不在 `vaults/` 下，
      //    所以布局坐标天然不受影响，重建后节点还在原来的位置。节点 id 来自
      //    relPath（`vaultNodeId`），与标题无关，坐标键也对得上。
      // 2. 不动 `meta.json` 本身：分片清空后内存是空图，下一次 `writeMeta()`
      //    会用新的 schemaVersion 覆盖它；此刻也不会有别的进程在写。
      //
      // `stale` 而不是"meta 缺失"才触发，是因为 meta 缺失还包含首次运行
      // （`vaults/` 本来就是空的，`entries.length === 0` 自然跳过）和
      // "写完分片、还没写 meta 就崩溃"两种正常情况。
      if (stale && entries.length > 0) {
        for (const key of entries) await fs.remove(shardDir(key), { recursive: true });
        entries = [];
        console.info(
          `[graph-index] schema ${GRAPH_INDEX_SCHEMA_VERSION}: dropped shards, next sync re-reads every file`,
        );
      }

      for (const key of entries) {
        await loadShard(key);
      }
      if (meta) {
        // meta 里登记过但目录没枚举到的分片（理论上不存在）按空分片补一条，
        // 免得调用方以为那个 vault 从未扫过。
        for (const shard of meta.shards ?? []) {
          if (!shards.has(shard.key)) ensureShardState(shard.key);
        }
      }
    },

    shardKeys() {
      return [...shards.keys()].sort();
    },

    node(id) {
      for (const shard of shards.values()) {
        const found = shard.nodes.get(id);
        if (found) return found;
      }
      return undefined;
    },

    nodes() {
      const out: GraphNode[] = [];
      for (const shard of shards.values()) out.push(...shard.nodes.values());
      return out;
    },

    edges() {
      const out: GraphEdge[] = [];
      for (const shard of shards.values()) {
        for (const list of shard.edgesBySource.values()) out.push(...list);
      }
      return out;
    },

    stamps(shardKey) {
      const shard = shards.get(shardKey);
      return shard ? [...shard.stamps.values()] : [];
    },

    journalStats(shardKey) {
      const shard = shards.get(shardKey);
      return shard ? { ...shard.journal } : { lines: 0, bytes: 0 };
    },

    async upsert(shardKey, node, edges, stamp) {
      const shard = ensureShardState(shardKey);
      const entry: UpsertEntry = {
        op: "upsert",
        ts: nowMs(),
        node,
        edges: [...edges],
        stamp,
      };
      applyUpsert(shard, node, edges, stamp);
      await appendJournal(shard, entry);
      if (
        shard.journal.lines >= JOURNAL_MAX_LINES ||
        shard.journal.bytes >= JOURNAL_MAX_BYTES
      ) {
        await store.compact(shardKey);
      }
    },

    async remove(shardKey, id) {
      const shard = ensureShardState(shardKey);
      applyRemove(shard, id);
      await appendJournal(shard, { op: "remove", ts: nowMs(), id });
      if (
        shard.journal.lines >= JOURNAL_MAX_LINES ||
        shard.journal.bytes >= JOURNAL_MAX_BYTES
      ) {
        await store.compact(shardKey);
      }
    },

    setSkipped(shardKey, skipped) {
      skippedByShard.set(shardKey, [...skipped]);
    },

    snapshot(builtAt = new Date().toISOString()) {
      const ordered = [...shards.values()].sort((left, right) => left.key.localeCompare(right.key));
      const unique = new Map<string, SkippedFile>();
      for (const list of skippedByShard.values()) {
        for (const item of list) unique.set(`${item.relPath}\u0000${item.reason}`, item);
      }
      const skipped = [...unique.values()].sort((left, right) =>
        left.relPath.localeCompare(right.relPath),
      );
      return deriveSnapshot(ordered, builtAt, skipped);
    },

    async compact(shardKey) {
      const shard = shards.get(shardKey);
      if (!shard) return;
      // 内存里已经是"快照 + 全量重放"的结果，所以 compact 只是把它落盘并清空
      // journal —— 不需要再读一遍 journal。
      await writeShardSnapshot(shard);
    },

    async dropShard(shardKey) {
      shards.delete(shardKey);
      skippedByShard.delete(shardKey);
      await fs.remove(shardDir(shardKey), { recursive: true });
    },

    async writeMeta() {
      const snapshot = store.snapshot();
      const meta: MetaFile = {
        ...snapshot.meta,
        shards: [...shards.values()]
          .sort((left, right) => left.key.localeCompare(right.key))
          .map((shard) => ({
            key: shard.key,
            nodeCount: shard.nodes.size,
            edgeCount: [...shard.edgesBySource.values()].reduce((sum, list) => sum + list.length, 0),
          })),
      };
      await fs.mkdir(root, { recursive: true });
      await writeAtomic(metaFile(), `${JSON.stringify(meta, null, 2)}\n`);
    },

    async deleteAll() {
      shards.clear();
      skippedByShard.clear();
      await fs.remove(root, { recursive: true });
      await fs.mkdir(vaultsDir(), { recursive: true });
    },
  };

  return store;
}
