/**
 * Read-side orchestration: scan, diff, read, parse, resolve, write, publish.
 *
 * §3.2.4 makes `GraphIndexer` the only *write* entry point; this module is the
 * only *reader* of the vault. Keeping them apart is what makes the two testable
 * separately: the indexer can be driven from a journal fixture, and this module
 * can be reasoned about as "given a scan result, what does it ask the indexer to
 * write".
 *
 * The four steps that are easy to get wrong, and how they are handled here:
 *
 * 1. **The candidate table must contain the nodes being created right now.**
 *    On a first scan every node is new; resolving against only the *stored*
 *    nodes would turn every link into a dangling node.
 * 2. **Renames are detected before new nodes are created**, because keeping the
 *    old node id is the entire point of §3.4.3 (inbound edges, cached
 *    coordinates and selection state all key off the id).
 * 3. **Parsing yields between batches** (§3.5.3): a 20 MB parse in one go is a
 *    multi-hundred-millisecond main-thread task, and the window is frozen for
 *    all of it.
 * 4. **`full` re-reads everything.** The watcher's 60 s fallback only proves
 *    that the entry count changed; after a silent watcher death a file can be
 *    edited with an unchanged mtime, so a `full` sync must not trust `stat`.
 */
import type { FileStamp, GraphNode, ParsedLink, VaultFileContent, VaultSkipped } from "@/types/graph";
import { useGraphStore } from "@/stores/graphStore";
import { getDataDirectory } from "@/utils/storage";
import { createGraphFs, joinPath } from "@/utils/graph/graphFs";
import { createGraphIndexStore, type GraphIndexStore, type IndexEdge } from "@/utils/graph/graphIndexStore";
import {
  createGraphIndexer,
  repairRenames,
  toIndexEdges,
  vaultNodeFields,
  type GraphIndexer,
} from "@/utils/graph/graphIndexer";
import { contentHashOf, vaultNodeId } from "@/utils/graph/ids";
import { buildCandidateTable } from "@/utils/graph/linkResolver";
import { adaptNoteSource } from "@/utils/graph/noteSourceAdapter";
import { scanNoteLinks } from "@/utils/graph/linkScanner";
import {
  listVaults,
  readVaultFiles,
  scanVault,
  subscribeVaultChanges,
} from "@/utils/graph/vaultService";

/** 每批解析多少个文件后让出主线程（§3.5.3 的 50 ms 预算）。 */
const PARSE_BATCH = 50;
/** §3.5.2 触发①：启动后延迟 3 s 再后台扫描，先让首帧出来。 */
export const STARTUP_SCAN_DELAY_MS = 3000;

export interface SyncOptions {
  /** true = 重读该 vault 的全部文件，不信任 mtime（watcher 兜底事件会带它）。 */
  full?: boolean;
}

export interface SyncReport {
  vaultKey: string;
  scanned: number;
  added: number;
  changed: number;
  removed: number;
  renames: number;
  dangling: number;
  skipped: number;
  durationMs: number;
}

interface ParsedNote {
  relPath: string;
  mtimeMs: number;
  bytes: number;
  node: GraphNode;
  links: ParsedLink[];
}

let graphFs: ReturnType<typeof createGraphFs> | null = null;
let indexStore: GraphIndexStore | null = null;
let indexer: GraphIndexer | null = null;
let loadPromise: Promise<void> | null = null;

/** 同步序号，只用于 DEV 日志（"第几次同步"比"多少毫秒"更容易对上事件）。 */
let syncSeq = 0;
/** 上一轮每个 vault 的 skipped 摘要：内容一致就不必再写 meta。 */
const lastSkippedSignature = new Map<string, string>();

/**
 * `skipped` 列表的稳定摘要。顺序由 Rust 保证（按 relPath 排序），但仍然显式
 * 拼成字符串比较，免得依赖"调用方已排序"这个隐含约定。
 */
function skippedSignature(skipped: readonly VaultSkipped[]): string {
  return skipped
    .map((item) => `${item.relPath}\u0000${item.reason}`)
    .sort()
    .join("\u0001");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** `<data>/graph/index`（§8.2）。显式解析一次，别让每个模块自己拼。 */
export async function resolveIndexRoot(): Promise<string> {
  return joinPath(await getDataDirectory(), "graph", "index");
}

/**
 * 打开（并首次装载）索引。装载失败会把 promise 清掉，下一次调用可以重试 ——
 * 数据目录在 U 盘上被拔掉再插回来是真实会发生的。
 */
export async function ensureIndex(): Promise<{ store: GraphIndexStore; indexer: GraphIndexer }> {
  if (!indexStore) {
    graphFs = createGraphFs();
    const root = await resolveIndexRoot();
    indexStore = createGraphIndexStore({ fs: graphFs, root });
    indexer = createGraphIndexer({ store: indexStore });
  }
  if (!loadPromise) {
    loadPromise = indexStore.load().catch((error: unknown) => {
      loadPromise = null;
      throw error;
    });
  }
  await loadPromise;
  return { store: indexStore, indexer: indexer as GraphIndexer };
}

/** 装载索引并把快照推给 store（T06 打开图谱页时先调它，首屏就有内容）。 */
export async function loadGraphIndex(): Promise<void> {
  const { store } = await ensureIndex();
  useGraphStore.getState().setSnapshot(store.snapshot());
}

function parseVaultFile(vaultKey: string, content: VaultFileContent): ParsedNote {
  const relPath = content.relPath;
  const source = adaptNoteSource({ content: content.text ?? "", relPath });
  const fields = vaultNodeFields(relPath);
  const parsed = scanNoteLinks(source.body, {
    dir: fields.dir,
    linksParsable: source.linksParsable,
  });
  const node: GraphNode = {
    id: vaultNodeId(vaultKey, relPath),
    kind: "vault",
    refId: relPath,
    vaultKey,
    title: source.titleCandidate ?? fields.title,
    path: relPath,
    dir: fields.dir,
    categoryId: null,
    tags: [],
    degree: 0,
    contentHash: contentHashOf(source.body),
    bytes: content.bytes,
    mtimeMs: content.mtimeMs,
    // 解析失败仍然是节点（灰点），只是没有链接可算（§3.2.1）。
    parseError: content.text === null ? (content.skipped ?? "unreadable") : null,
  };
  return { relPath, mtimeMs: content.mtimeMs, bytes: content.bytes, node, links: parsed.links };
}

function stampOf(vaultKey: string, item: ParsedNote, edgeCount: number, id = item.node.id): FileStamp {
  return {
    id,
    vaultKey,
    relPath: item.relPath,
    mtimeMs: item.mtimeMs,
    bytes: item.bytes,
    hash: item.node.contentHash ?? "",
    edgeCount,
  };
}

/**
 * 同步一个 vault。
 *
 * 调用时序（谁在什么时候调）：
 * - `startVaultSync()` 在启动 3 s 后对每个启用的 vault 调一次 `full: false`；
 * - 每次 `vault://changed` 事件（Rust 已做 300 ms 去抖）按 vault 串行入队调一次，
 *   `full` 直接透传事件里的值；
 * - 用户点「刷新索引」时调一次 `full: true`。
 */
export async function syncVault(vaultKey: string, options: SyncOptions = {}): Promise<SyncReport> {
  const startedAt = Date.now();
  const graph = useGraphStore.getState();
  graph.setStatus("scanning", vaultKey);

  try {
    const { store, indexer } = await ensureIndex();
    const scan = await scanVault(vaultKey);

    const known = new Map<string, FileStamp>();
    for (const stamp of store.stamps(vaultKey)) known.set(stamp.relPath, stamp);

    const pending = new Map<string, ParsedNote>();
    const added: string[] = [];
    const changed: string[] = [];
    const seen = new Set<string>();
    for (const file of scan.files) {
      seen.add(file.relPath);
      const previous = known.get(file.relPath);
      if (!previous) {
        added.push(file.relPath);
      } else if (options.full || previous.mtimeMs !== file.mtimeMs || previous.bytes !== file.bytes) {
        // full：即使 mtime/bytes 没变也重读（watcher 静默死亡后内容可能已变）。
        changed.push(file.relPath);
      }
    }
    const removedStamps: FileStamp[] = [];
    for (const [relPath, stamp] of known) {
      if (!seen.has(relPath)) removedStamps.push(stamp);
    }

    const toRead = [...added, ...changed];
    for (let index = 0; index < toRead.length; index += PARSE_BATCH) {
      const batch = toRead.slice(index, index + PARSE_BATCH);
      const contents = await readVaultFiles(vaultKey, batch);
      for (const content of contents) {
        pending.set(content.relPath, parseVaultFile(vaultKey, content));
      }
      // 每批之间让出主线程：5000 篇一次性解析会冻住窗口几百毫秒。
      await yieldToEventLoop();
    }

    // 候选表必须包含"这一轮才出现的节点"，否则首扫全是 dangling。
    const tableNodes = new Map<string, GraphNode>();
    for (const node of store.nodes()) tableNodes.set(node.id, node);
    for (const item of pending.values()) tableNodes.set(item.node.id, item.node);
    const table = buildCandidateTable([...tableNodes.values()]);

    const edgesByRelPath = new Map<string, IndexEdge[]>();
    for (const item of pending.values()) {
      edgesByRelPath.set(item.relPath, toIndexEdges(item.node, item.links, table));
    }
    const stampFor = (item: ParsedNote, id?: string): FileStamp =>
      stampOf(vaultKey, item, edgesByRelPath.get(item.relPath)?.length ?? 0, id);

    // 1) 重命名修补先算：命中就迁移旧 id，别先建新节点再删旧的（那会让入边全部
    //    变悬空，坐标也丢了 —— §3.4.3 要避免的正是这个）。
    const addedStamps: FileStamp[] = [];
    for (const relPath of added) {
      const item = pending.get(relPath);
      if (item) addedStamps.push(stampFor(item));
    }
    const plan = repairRenames(removedStamps, addedStamps);

    /* -------------------------------------------------- 零 diff：什么都不推 */
    // 图收敛 → 写 positions.ndjson → watcher 报告 → 再同步一轮，是这条链路
    // 的常态。只要这一轮没有增删改，就不要推新 snapshot：`setSnapshot` 换掉
    // 引用，`GraphRenderer` 的 graphData memo 就会重建数组，force-graph 的
    // `resetCountdown()` 把 15 s 冷却重新计时 —— 图就永远抖着不收敛。
    //
    // `plan.renames` 也算"有变化"：命中重命名的节点已经 migrate 过，它们的
    // relPath 变了，快照必须推。
    const skipped = scan.skipped;
    const nextSkippedSignature = skippedSignature(skipped);
    const structureChanged =
      plan.added.length + plan.removed.length + plan.renames.length + changed.length > 0;
    const skippedChanged = lastSkippedSignature.get(vaultKey) !== nextSkippedSignature;
    syncSeq += 1;
    if (!structureChanged && !skippedChanged) {
      const current = useGraphStore.getState();
      current.setStatus("idle", null);
      // 报告里的 dangling 直接读已推送的快照：`store.snapshot()` 是 O(n) 派生，
      // 而这条路径就是"高频、什么都不做"的那条。
      const dangling = current.snapshot?.meta.danglingCount ?? 0;
      if (import.meta.env.DEV) {
        console.info(`[graph] sync #${syncSeq} no-op`, {
          vaultKey,
          scanned: scan.files.length,
          nodes: current.snapshot?.nodes.length ?? 0,
          full: options.full === true,
          durationMs: Date.now() - startedAt,
        });
      }
      return {
        vaultKey,
        scanned: scan.files.length,
        added: 0,
        changed: 0,
        removed: 0,
        renames: 0,
        dangling,
        skipped: skipped.length,
        durationMs: Date.now() - startedAt,
      };
    }

    for (const pair of plan.renames) {
      const item = pending.get(pair.to.relPath);
      if (!item) continue;
      await indexer.migrateNode(
        pair.from.id,
        item.node,
        edgesByRelPath.get(item.relPath) ?? [],
        stampFor(item, pair.from.id),
      );
    }

    // 2) 真正的新增（repairRenames 已把配对成功的从 added 里摘走）。
    for (const stamp of plan.added) {
      const item = pending.get(stamp.relPath);
      if (!item) continue;
      await indexer.upsertNode(item.node, edgesByRelPath.get(item.relPath) ?? [], stamp);
    }

    // 3) 内容变化（id 不变，直接覆盖）。
    for (const relPath of changed) {
      const item = pending.get(relPath);
      if (!item) continue;
      await indexer.upsertNode(item.node, edgesByRelPath.get(item.relPath) ?? [], stampFor(item));
    }

    // 4) 真正消失的。指向它的边不改写：快照会把它们画成悬空，文件回来即自愈。
    for (const stamp of plan.removed) {
      await indexer.removeNode(stamp.id);
    }

    store.setSkipped(vaultKey, skipped);
    lastSkippedSignature.set(vaultKey, nextSkippedSignature);
    await store.writeMeta();

    const snapshot = store.snapshot();
    useGraphStore.getState().setSnapshot(snapshot);
    useGraphStore.getState().setStatus("idle", null);

    if (import.meta.env.DEV) {
      console.info(`[graph] sync #${syncSeq}`, {
        vaultKey,
        scanned: scan.files.length,
        added: plan.added.length + plan.renames.length,
        changed: changed.length,
        removed: plan.removed.length,
        renames: plan.renames.length,
        nodes: snapshot.nodes.length,
        edges: snapshot.edges.length,
        dangling: snapshot.meta.danglingCount,
        skipped: skipped.length,
        full: options.full === true,
        durationMs: Date.now() - startedAt,
      });
    }

    return {
      vaultKey,
      scanned: scan.files.length,
      added: plan.added.length + plan.renames.length,
      changed: changed.length,
      removed: plan.removed.length,
      renames: plan.renames.length,
      dangling: snapshot.meta.danglingCount,
      skipped: scan.skipped.length,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    useGraphStore.getState().setStatus("error", detail);
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Subscription + serialisation (T08 renderer side)                           */
/* -------------------------------------------------------------------------- */

const chains = new Map<string, Promise<void>>();

/**
 * 同一 vault 的同步串行化。
 *
 * Rust 已经把 300 ms 内的同类事件合并了，但一次保存仍可能落成两个事件（rename
 * 的 from/to、跨目录移动）。两次扫描并发跑会交错写 journal 并互相覆盖内存快照，
 * 所以按 vault 排队；不同 vault 之间仍然并行（它们写的是不同分片）。
 */
function enqueue(vaultKey: string, task: () => Promise<void>): Promise<void> {
  const previous = chains.get(vaultKey) ?? Promise.resolve();
  // 上一次失败也要接着跑：一条坏事件不能让整个订阅死掉。
  const next = previous.then(task, task).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    useGraphStore.getState().setStatus("error", detail);
  });
  chains.set(vaultKey, next);
  void next.finally(() => {
    if (chains.get(vaultKey) === next) chains.delete(vaultKey);
  });
  return next;
}

/** 按 vault 排队的同步入口，事件与手动刷新都走它。 */
export function requestVaultSync(vaultKey: string, options: SyncOptions = {}): Promise<void> {
  return enqueue(vaultKey, async () => {
    await syncVault(vaultKey, options);
  });
}

/** 逐个同步所有启用的 vault（启动首扫与「刷新索引」）。 */
export async function refreshAllVaults(options: SyncOptions = {}): Promise<void> {
  const records = await listVaults();
  const enabled = records.filter((record) => record.enabled);
  for (const record of enabled) {
    await requestVaultSync(record.key, options);
  }
}

/**
 * 注销一个 vault 后的收尾：删分片 + 刷新快照。
 *
 * 没有这一步，`vault_remove` 只从白名单里删掉 key，分片目录和内存里的节点都还在
 * —— 那些节点再也不会被扫到（`vault_scan` 会报 unknown vault），于是成为永远
 * 清除不掉的孤儿，图上还照常显示。
 */
export async function forgetVault(vaultKey: string): Promise<void> {
  const { store } = await ensureIndex();
  await store.dropShard(vaultKey);
  // 注销之后这个 vault 不会再同步，摘要留着只会占内存。
  lastSkippedSignature.delete(vaultKey);
  await store.writeMeta();
  useGraphStore.getState().setSnapshot(store.snapshot());
}

let stopSyncing: (() => void) | null = null;

/**
 * 订阅 `vault://changed` 并启动首扫。
 *
 * 返回停止函数；重复调用返回同一个停止函数（React 严格模式会 mount 两次，
 * 第二次订阅会变成两个监听器、两份扫描）。
 */
export function startVaultSync(): () => void {
  if (stopSyncing) return stopSyncing;
  const unsubscribe = subscribeVaultChanges((payload) => {
    void requestVaultSync(payload.vaultKey, { full: payload.full });
  });
  const timer = setTimeout(() => {
    void refreshAllVaults({ full: false }).catch((error: unknown) => {
      console.error("[graph] startup scan failed:", error);
    });
  }, STARTUP_SCAN_DELAY_MS);
  const stop = () => {
    clearTimeout(timer);
    unsubscribe();
    stopSyncing = null;
  };
  stopSyncing = stop;
  return stop;
}
