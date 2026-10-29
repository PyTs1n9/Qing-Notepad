/**
 * Headless verification for the graph index (T04).
 *
 * Bundles the real TypeScript with esbuild and runs it against a real temp
 * directory through `nodeGraphFs`, so the journal/compact/replay code is
 * exercised exactly as written — the only thing swapped out is the file API.
 *
 *   node scripts/verify-graph-index.mjs
 *
 * Sections map onto §8.2 (shards + journal + compact), §3.2.2 (aggregated edge
 * rows), §3.4.1 (derived incoming), §3.4.2 (delete → dangling) and §3.4.3
 * (rename repair).
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
  console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const section = (title) => console.log(`\n${title}`);

// ------------------------------------------------------------------ bundle
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-index-verify-"));
const outfile = path.join(tmpDir, "index.bundle.mjs");

/** `@tauri-apps/plugin-fs` 在 node 里没有运行时，脚本只用 nodeGraphFs，所以打桩。 */
const tauriFsStub = {
  name: "stub-tauri-fs",
  setup(build) {
    build.onResolve({ filter: /^@tauri-apps\/plugin-fs$/ }, () => ({
      path: "tauri-fs-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: [
        'const unavailable = () => { throw new Error("tauri fs is not available in scripts"); };',
        "export const exists = unavailable;",
        "export const mkdir = unavailable;",
        "export const readDir = unavailable;",
        "export const readTextFile = unavailable;",
        "export const remove = unavailable;",
        "export const rename = unavailable;",
        "export const writeTextFile = unavailable;",
      ].join("\n"),
      loader: "js",
    }));
  },
};

await esbuild.build({
  stdin: {
    contents: [
      'export * as store from "./src/utils/graph/graphIndexStore.ts";',
      'export * as indexer from "./src/utils/graph/graphIndexer.ts";',
      'export * as resolver from "./src/utils/graph/linkResolver.ts";',
      'export * as scanner from "./src/utils/graph/linkScanner.ts";',
      'export * as graphFs from "./src/utils/graph/graphFs.ts";',
      'export * as ids from "./src/utils/graph/ids.ts";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "graph-index-verify-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent",
  alias: { "@": path.join(root, "src") },
  plugins: [tauriFsStub],
});
await esbuild.stop?.();

const { store: storeModule, indexer: indexerModule, resolver, scanner, graphFs, ids } = await import(
  pathToFileURL(outfile).href
);

// ------------------------------------------------------------------ fixtures
const VAULT = "aabbccdd";
const indexRoot = graphFs.joinPath(tmpDir, "index");
const nodeFs = graphFs.nodeGraphFs(tmpDir);

function vaultNode(relPath, overrides = {}) {
  const fields = indexerModule.vaultNodeFields(relPath);
  return {
    id: ids.vaultNodeId(VAULT, relPath),
    kind: "vault",
    refId: relPath,
    vaultKey: VAULT,
    title: fields.title,
    path: relPath,
    dir: fields.dir,
    categoryId: null,
    tags: [],
    degree: 0,
    contentHash: null,
    bytes: 10,
    mtimeMs: 1000,
    parseError: null,
    ...overrides,
  };
}

function makeEdge(source, target, line = 1, kind = "wiki") {
  return { source, target, kind, line, raw: `[[${target}]]` };
}

function makeStamp(node, overrides = {}) {
  return {
    id: node.id,
    vaultKey: VAULT,
    relPath: node.path ?? node.refId,
    mtimeMs: node.mtimeMs,
    bytes: node.bytes,
    hash: `hash-of-${node.path ?? node.refId}`,
    edgeCount: 0,
    ...overrides,
  };
}

const freshStore = async (sub) => {
  const instance = storeModule.createGraphIndexStore({
    fs: nodeFs,
    root: graphFs.joinPath(tmpDir, sub),
  });
  await instance.load();
  return instance;
};

const snapshotSignature = (snapshot) =>
  JSON.stringify({
    nodes: snapshot.nodes
      .map((node) => ({ id: node.id, kind: node.kind, path: node.path, degree: node.degree }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: snapshot.edges
      .map((edge) => ({ s: edge.source, t: edge.target, k: edge.kind, line: edge.line }))
      .sort((left, right) => `${left.s}${left.t}${left.line}`.localeCompare(`${right.s}${right.t}${right.line}`)),
    dangling: snapshot.dangling
      .map((ref) => ({ id: ref.id, source: ref.source, cc: ref.candidateCount }))
      .sort((left, right) => `${left.id}${left.source}`.localeCompare(`${right.id}${right.source}`)),
    incoming: [...snapshot.incoming.entries()]
      .map(([target, sources]) => [target, [...sources].sort()])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  });

// ===================================================== [1] 写入 → 重放 → 快照
section("[1] 写入后重放：节点 / 边 / 入向（§8.2 定案 4、§3.4.1）");

const storeA = await freshStore("s1");
const indexerA = indexerModule.createGraphIndexer({ store: storeA });

const nodeA = vaultNode("a.md");
const nodeB = vaultNode("b.md");
const nodeC = vaultNode("c.md");
await indexerA.upsertNode(nodeA, [makeEdge(nodeA.id, nodeB.id), makeEdge(nodeA.id, nodeC.id)], makeStamp(nodeA));
await indexerA.upsertNode(nodeB, [makeEdge(nodeB.id, nodeC.id, 3)], makeStamp(nodeB));
await indexerA.upsertNode(nodeC, [], makeStamp(nodeC));

const liveSnapshot = storeA.snapshot("2024-01-01T00:00:00.000Z");
check("3 个节点", liveSnapshot.meta.nodeCount === 3, liveSnapshot.meta.nodeCount);
check("3 条边", liveSnapshot.meta.edgeCount === 3, liveSnapshot.meta.edgeCount);
check("没有悬空", liveSnapshot.meta.danglingCount === 0, liveSnapshot.meta.danglingCount);
check(
  "入向由出向派生：c 有 a、b 两个来源",
  JSON.stringify([...(liveSnapshot.incoming.get(nodeC.id) ?? [])].sort()) ===
    JSON.stringify([nodeA.id, nodeB.id].sort()),
  liveSnapshot.incoming.get(nodeC.id),
);
check("degree 是出度 + 入度", liveSnapshot.nodeById.get(nodeC.id).degree === 2, liveSnapshot.nodeById.get(nodeC.id).degree);
check("a 的 degree = 出 2", liveSnapshot.nodeById.get(nodeA.id).degree === 2, liveSnapshot.nodeById.get(nodeA.id).degree);

const replayedStore = storeModule.createGraphIndexStore({
  fs: nodeFs,
  root: graphFs.joinPath(tmpDir, "s1"),
});
await replayedStore.load();
const replayedSnapshot = replayedStore.snapshot("2024-01-01T00:00:00.000Z");
check(
  "新实例从 journal 重放出同样的图",
  snapshotSignature(replayedSnapshot) === snapshotSignature(liveSnapshot),
  snapshotSignature(replayedSnapshot),
);

// ===================================================== [2] 重放幂等
section("[2] 重放幂等（§8.2 定案 4）");

const firstReplay = snapshotSignature(replayedSnapshot);
await replayedStore.load();
const secondReplay = snapshotSignature(replayedStore.snapshot("2024-01-01T00:00:00.000Z"));
check("同一批 journal 连续重放两次结果逐字段相等", firstReplay === secondReplay);

// 手动重放同一批条目两次（不经 load），也必须幂等
const journalText = fs.readFileSync(path.join(tmpDir, "s1", "vaults", VAULT, "journal.ndjson"), "utf8");
const parsedOnce = storeModule.parseJournalText(journalText);
const parsedTwice = storeModule.parseJournalText(`${journalText}${journalText}`);
check("journal 里 3 条 upsert", parsedOnce.entries.length === 3, parsedOnce.entries.length);
check("重复追加同一批后条目翻倍（重放本身是覆盖语义）", parsedTwice.entries.length === 6, parsedTwice.entries.length);

// ===================================================== [3] remove 幂等
section("[3] remove 不存在的 id（§8.2 定案 4）");

const removedUnknown = await indexerA.removeNode("v-deadbeef-0000000000000000");
check("remove 未知 id 返回 false 且不抛错", removedUnknown === false, removedUnknown);
const afterUnknownRemove = storeA.snapshot("2024-01-01T00:00:00.000Z");
check("不会产生幽灵节点", afterUnknownRemove.meta.nodeCount === 3, afterUnknownRemove.meta.nodeCount);
check("边数不变", afterUnknownRemove.meta.edgeCount === 3, afterUnknownRemove.meta.edgeCount);

// ===================================================== [4] compact
section("[4] compact 触发（§8.2 定案 3）");

const compactStore = await freshStore("s4");
const compactIndexer = indexerModule.createGraphIndexer({ store: compactStore });
// 行数阈值要在字节阈值之前到，所以用"最小合法节点"（~300 B/行）：
// 真实笔记的 journal 行约 400+ B，5000 行会先撞 2 MB 的字节阈值，那就测不到
// 行数这条了。两个阈值各测一条，才说明两条都真的接上了。
const churnNode = {
  id: "v-tiny",
  kind: "vault",
  refId: "t.md",
  vaultKey: VAULT,
  title: "t",
  path: "t.md",
  dir: "",
  categoryId: null,
  tags: [],
  degree: 0,
  contentHash: null,
  bytes: 0,
  mtimeMs: 0,
  parseError: null,
};
const churnStamp = {
  id: "v-tiny",
  vaultKey: VAULT,
  relPath: "t.md",
  mtimeMs: 0,
  bytes: 0,
  hash: "",
  edgeCount: 0,
};
const churnBytesPerLine = JSON.stringify(churnNode).length + JSON.stringify(churnStamp).length + 64;
check(
  "选用的节点足够小，5000 行不会先撞 2 MB 字节阈值",
  churnBytesPerLine * storeModule.JOURNAL_MAX_LINES < storeModule.JOURNAL_MAX_BYTES,
  churnBytesPerLine * storeModule.JOURNAL_MAX_LINES,
);
for (let index = 0; index < storeModule.JOURNAL_MAX_LINES; index += 1) {
  await compactIndexer.upsertNode(churnNode, [], churnStamp);
}
const lineShardDir = path.join(tmpDir, "s4", "vaults", VAULT);
check(
  "行数阈值 5000 触发 compact",
  compactStore.journalStats(VAULT).lines === 0,
  compactStore.journalStats(VAULT),
);
check("nodes.ndjson 已写出", fs.existsSync(path.join(lineShardDir, "nodes.ndjson")));
check("edges.ndjson 已写出", fs.existsSync(path.join(lineShardDir, "edges.ndjson")));
check("stamps.ndjson 已写出", fs.existsSync(path.join(lineShardDir, "stamps.ndjson")));
check(
  "journal 被清空",
  fs.readFileSync(path.join(lineShardDir, "journal.ndjson"), "utf8") === "",
);
check(
  "compact 后节点仍在内存里",
  compactStore.node(churnNode.id) !== undefined,
);

// 字节阈值：行数远不到 5000，但体积超过 2 MB
const bytesStore = await freshStore("s4b");
const bytesIndexer = indexerModule.createGraphIndexer({ store: bytesStore });
const fatTitle = "x".repeat(6000);
const fatNode = vaultNode("fat.md", { title: fatTitle });
let byteLines = 0;
while (byteLines <= 400) {
  await bytesIndexer.upsertNode(fatNode, [], makeStamp(fatNode, { mtimeMs: byteLines }));
  byteLines += 1;
  // compact 发生后行数与字节数归零，循环即可结束。
  if (bytesStore.journalStats(VAULT).lines === 0) break;
}
check(
  "字节阈值 2 MB 在 5000 行之前触发（少行大体积）",
  byteLines < storeModule.JOURNAL_MAX_LINES,
  byteLines,
);
check("字节触发后 journal 行数为 0", bytesStore.journalStats(VAULT).lines === 0, bytesStore.journalStats(VAULT));

// ===================================================== [5] 半行截断
section("[5] 半行截断（§8.2 定案 4）");

const truncatedStore = await freshStore("s5");
const truncatedIndexer = indexerModule.createGraphIndexer({ store: truncatedStore });
await truncatedIndexer.upsertNode(nodeA, [], makeStamp(nodeA));
await truncatedIndexer.upsertNode(nodeB, [], makeStamp(nodeB));
const truncDir = path.join(tmpDir, "s5", "vaults", VAULT);
const truncJournal = path.join(truncDir, "journal.ndjson");
const goodJournal = fs.readFileSync(truncJournal, "utf8");
fs.writeFileSync(truncJournal, `${goodJournal}{"op":"upsert","ts":1,"node":{"id":"v-broken`);

const truncParsed = storeModule.parseJournalText(`${goodJournal}{"op":"upsert","ts":1,"node":{"id":"v-bro`);
check("半行被标记为 truncated", truncParsed.truncated === true, truncParsed.truncated);
check("半行之前的条目全部保留", truncParsed.entries.length === 2, truncParsed.entries.length);

const recoveredStore = storeModule.createGraphIndexStore({
  fs: nodeFs,
  root: graphFs.joinPath(tmpDir, "s5"),
});
await recoveredStore.load();
check("截断的 journal 仍能装载", recoveredStore.shardKeys().includes(VAULT), recoveredStore.shardKeys());
check("只丢了最后一条（2 个节点还在）", recoveredStore.snapshot().meta.nodeCount === 2, recoveredStore.snapshot().meta.nodeCount);

// ===================================================== [6] 删除 → 悬空
section("[6] 删除后指向它的边变悬空（§3.4.2）");

const deleteStore = await freshStore("s6");
const deleteIndexer = indexerModule.createGraphIndexer({ store: deleteStore });
await deleteIndexer.upsertNode(nodeA, [makeEdge(nodeA.id, nodeB.id)], makeStamp(nodeA));
await deleteIndexer.upsertNode(nodeB, [], makeStamp(nodeB));

check("删除前 b 是真实节点", deleteStore.snapshot().nodeById.get(nodeB.id)?.kind === "vault");
await deleteIndexer.removeNode(nodeB.id);
const afterDelete = deleteStore.snapshot("2024-01-01T00:00:00.000Z");
check("指向已删文件的边仍在", afterDelete.meta.edgeCount === 1, afterDelete.meta.edgeCount);
check("它变成悬空引用", afterDelete.meta.danglingCount === 1, afterDelete.meta.danglingCount);
check(
  "悬空节点按 dangling 呈现且 id 保持（文件回来即自愈）",
  afterDelete.nodeById.get(nodeB.id)?.kind === "dangling",
  afterDelete.nodeById.get(nodeB.id)?.kind,
);
check(
  "DanglingRef 指向原来源",
  afterDelete.dangling[0]?.source === nodeA.id,
  afterDelete.dangling[0],
);

await deleteIndexer.removeNode(nodeA.id);
const afterDeleteAll = deleteStore.snapshot("2024-01-01T00:00:00.000Z");
check("悬空节点无入边即被回收", afterDeleteAll.meta.danglingCount === 0, afterDeleteAll.meta.danglingCount);
check("图空", afterDeleteAll.meta.nodeCount === 0, afterDeleteAll.meta.nodeCount);

// ===================================================== [7] 重命名修补
section("[7] 重命名修补（§3.4.3）");

const stampOld = { id: "v-1", vaultKey: VAULT, relPath: "old.md", mtimeMs: 5, bytes: 10, hash: "h1", edgeCount: 0 };
const stampNew = { id: "v-2", vaultKey: VAULT, relPath: "new.md", mtimeMs: 5, bytes: 10, hash: "h2", edgeCount: 0 };
const byStat = indexerModule.repairRenames([stampOld], [stampNew]);
check("(bytes, mtimeMs) 命中 → 判定为重命名", byStat.renames.length === 1, byStat);
check("配对方向正确", byStat.renames[0]?.from.relPath === "old.md" && byStat.renames[0]?.to.relPath === "new.md");
check("没有残留的删除/新增", byStat.removed.length === 0 && byStat.added.length === 0, byStat);

const stampHashOld = { ...stampOld, relPath: "old2.md", mtimeMs: 1, bytes: 3, hash: "same" };
const stampHashNew = { ...stampNew, relPath: "new2.md", mtimeMs: 9, bytes: 4, hash: "same" };
const byHash = indexerModule.repairRenames([stampHashOld], [stampHashNew]);
check("(bytes, mtimeMs) 不同但 contentHash 相同 → 仍判定为重命名", byHash.renames.length === 1, byHash);

const ambiguousAdded = [
  { ...stampNew, id: "v-3", relPath: "copy1.md" },
  { ...stampNew, id: "v-4", relPath: "copy2.md" },
];
const oneToMany = indexerModule.repairRenames([stampOld], ambiguousAdded);
check("一对多不猜（两个新增都能配对 → 放弃）", oneToMany.renames.length === 0, oneToMany);
check("按删除 + 新增处理", oneToMany.removed.length === 1 && oneToMany.added.length === 2, oneToMany);

// 端到端：迁移后 id 与入边都不变
const renameStore = await freshStore("s7");
const renameIndexer = indexerModule.createGraphIndexer({ store: renameStore });
const target = vaultNode("旧名字.md");
const source = vaultNode("引用者.md");
await renameIndexer.upsertNode(target, [], makeStamp(target));
await renameIndexer.upsertNode(source, [makeEdge(source.id, target.id)], makeStamp(source));
const renamed = vaultNode("新名字.md");
await renameIndexer.migrateNode(target.id, renamed, [], makeStamp(renamed, { id: target.id }));
const afterRename = renameStore.snapshot("2024-01-01T00:00:00.000Z");
check("迁移后旧 id 仍然存在", afterRename.nodeById.has(target.id), [...afterRename.nodeById.keys()]);
check(
  "路径已更新为新路径",
  afterRename.nodeById.get(target.id)?.path === "新名字.md",
  afterRename.nodeById.get(target.id)?.path,
);
check("新路径派生的 id 没有留下孤儿节点", !afterRename.nodeById.has(renamed.id), [...afterRename.nodeById.keys()]);
check("入边没有变悬空", afterRename.meta.danglingCount === 0, afterRename.dangling);

// ===================================================== [8] 聚拢边行 + meta
section("[8] 边表聚拢成行 + meta（§3.2.2）");

const rowStore = await freshStore("s8");
const rowIndexer = indexerModule.createGraphIndexer({ store: rowStore });
await rowIndexer.upsertNode(nodeA, [makeEdge(nodeA.id, nodeB.id), makeEdge(nodeA.id, nodeC.id, 2)], makeStamp(nodeA));
await rowIndexer.upsertNode(nodeB, [makeEdge(nodeB.id, nodeC.id)], makeStamp(nodeB));
await rowIndexer.upsertNode(nodeC, [], makeStamp(nodeC));

// journal 行格式必须严格照 §8.2 第 2 条（compact 会清空 journal，所以先读）
const journalEntryLine = fs
  .readFileSync(path.join(tmpDir, "s8", "vaults", VAULT, "journal.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .pop();
const journalEntry = JSON.parse(journalEntryLine);
check(
  "journal 行含 op/ts/node/edges/stamp",
  ["op", "ts", "node", "edges", "stamp"].every((key) => key in journalEntry),
  Object.keys(journalEntry),
);
check("journal 的 op 是 upsert", journalEntry.op === "upsert", journalEntry.op);

await rowStore.compact(VAULT);
const rowEdgesText = fs.readFileSync(path.join(tmpDir, "s8", "vaults", VAULT, "edges.ndjson"), "utf8");
const rowLines = rowEdgesText.split("\n").filter((line) => line.trim());
check("edges.ndjson 行数 = 有出边的源节点数（2），不是边数（3）", rowLines.length === 2, rowLines.length);
const firstRow = JSON.parse(rowLines[0]);
check("行格式是 { s, e: [...] }", typeof firstRow.s === "string" && Array.isArray(firstRow.e), Object.keys(firstRow));
check("边项含 t/k/w/line/raw", ["t", "k", "w", "line", "raw"].every((key) => key in firstRow.e[0]), Object.keys(firstRow.e[0]));

const metaPath = path.join(tmpDir, "s8", "meta.json");
check("writeMeta 之前 meta 不存在", !fs.existsSync(metaPath));
await rowStore.writeMeta();
check("writeMeta 之后 meta.json 存在", fs.existsSync(metaPath));
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
check(
  "meta.schemaVersion 是当前版本常量",
  meta.schemaVersion === storeModule.GRAPH_INDEX_SCHEMA_VERSION,
  meta.schemaVersion,
);
check("meta 带 builtAt", typeof meta.builtAt === "string");
check("meta 聚合 counts", meta.nodeCount === 3 && meta.edgeCount === 3, meta);
check("meta 带分片清单", Array.isArray(meta.shards) && meta.shards[0]?.key === VAULT, meta.shards);

// journal 行格式在 compact 之前已经断言过（见上），这里只补 remove 行。
const removeJournal = (() => {
  const pathName = path.join(tmpDir, "s6", "vaults", VAULT, "journal.ndjson");
  const lines = fs.readFileSync(pathName, "utf8").split("\n").filter((line) => line.trim());
  return lines.map((line) => JSON.parse(line)).find((entry) => entry.op === "remove");
})();
check("remove 行含 op/ts/id", removeJournal !== undefined && "id" in removeJournal, removeJournal);

// ===================================================== [9] 原生分片 + 悬空记录
section("[9] 分片键 + 悬空目标的三元信息");

const mixedStore = await freshStore("s9");
const mixedIndexer = indexerModule.createGraphIndexer({ store: mixedStore });
const nativeNote = {
  id: ids.nativeNodeId("11111111-2222-3333-4444-555555555555"),
  kind: "native",
  refId: "11111111-2222-3333-4444-555555555555",
  vaultKey: null,
  title: "原生笔记",
  path: null,
  dir: null,
  categoryId: "cat-1",
  tags: [],
  degree: 0,
  contentHash: null,
  bytes: 0,
  mtimeMs: 0,
  parseError: null,
};
await mixedIndexer.upsertNode(
  nativeNote,
  [
    {
      source: nativeNote.id,
      target: ids.danglingNodeId("不存在"),
      kind: "wiki",
      line: 2,
      raw: "[[不存在]]",
      rawTarget: "不存在",
      normalized: "不存在",
      candidateCount: 1,
    },
  ],
  null,
);
check("原生笔记落到 native 分片", mixedStore.shardKeys().includes("native"), mixedStore.shardKeys());
const mixedSnapshot = mixedStore.snapshot("2024-01-01T00:00:00.000Z");
check("悬空目标没有节点记录但出现在快照里", mixedSnapshot.dangling.length === 1, mixedSnapshot.dangling);
check(
  "DanglingRef 保留了原文 / 归一化 / 候选数",
  mixedSnapshot.dangling[0].rawTarget === "不存在" &&
    mixedSnapshot.dangling[0].normalized === "不存在" &&
    mixedSnapshot.dangling[0].candidateCount === 1,
  mixedSnapshot.dangling[0],
);
check(
  "悬空 id 是 d-<hash>",
  /^d-[0-9a-f]{16}$/.test(mixedSnapshot.dangling[0].id),
  mixedSnapshot.dangling[0].id,
);

// ===================================================== [10] 正文 → 边
section("[10] 正文到边：解析 / 自环 / 悬空（§3.4.4 与 graphSync 的接线）");

const edgeNodes = [
  vaultNode("a.md"),
  vaultNode("b.md"),
  vaultNode("x/同名.md"),
  vaultNode("y/同名.md"),
];
const edgeTable = resolver.buildCandidateTable(edgeNodes);
const sourceNode = edgeNodes[0];
const scanned = scanner.scanLinks(
  ["[[b]]", "[[a]]", "[[不存在的笔记]]", "[[同名]]", "![[图.png]]"].join("\n"),
  { dir: "" },
);
const edgesFromText = indexerModule.toIndexEdges(sourceNode, scanned, edgeTable);

check("扫到 4 条链接，落成 3 条边（自环被丢、图片嵌入不进扫描）", scanned.length === 4 && edgesFromText.length === 3, [scanned.length, edgesFromText.length]);
check(
  "[[b]] 解析到真实节点",
  edgesFromText[0].target === edgeNodes[1].id && edgesFromText[0].kind === "wiki",
  edgesFromText[0],
);
check("自环 [[a]] 被丢掉（§3.4.4）", !edgesFromText.some((edge) => edge.target === sourceNode.id), edgesFromText.map((edge) => edge.target));
const missingEdge = edgesFromText.find((edge) => edge.normalized === "不存在的笔记");
check("missing → d-<hash> 悬空 id", /^d-[0-9a-f]{16}$/.test(missingEdge?.target ?? ""), missingEdge);
check("悬空边保留原文与归一化", missingEdge.rawTarget === "不存在的笔记" && missingEdge.candidateCount === 1, missingEdge);
const ambiguousEdge = edgesFromText.find((edge) => edge.normalized === "同名");
check("歧义边也建悬空节点并记候选数 2", ambiguousEdge?.candidateCount === 2, ambiguousEdge);
check(
  "两篇同名文件的边指向同一个悬空 id",
  ambiguousEdge.target === ids.danglingNodeId("同名"),
  ambiguousEdge.target,
);
check(
  "行号来自解析结果",
  edgesFromText.map((edge) => edge.line).join(",") === "1,3,4",
  edgesFromText.map((edge) => edge.line),
);

// ===================================================== [11] 重建
section("[11] deleteAll 后重建（§3.5.2 清理）");

const rebuildStore = await freshStore("s11");
const rebuildIndexer = indexerModule.createGraphIndexer({ store: rebuildStore });
await rebuildIndexer.upsertNode(nodeA, [], makeStamp(nodeA));
await rebuildStore.writeMeta();
await rebuildStore.deleteAll();
check("deleteAll 之后内存清空", rebuildStore.shardKeys().length === 0, rebuildStore.shardKeys());
await rebuildStore.load();
check("重建后是空图", rebuildStore.snapshot().meta.nodeCount === 0, rebuildStore.snapshot().meta.nodeCount);
check("重建后仍可用（分片目录已重建）", fs.existsSync(path.join(tmpDir, "s11", "vaults")));

// ------------------------------------------------------------------ summary
fs.rmSync(tmpDir, { recursive: true, force: true });

const summary = `${checks - failures}/${checks} checks passed`;
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILED"} — ${summary}`);
process.exit(failures === 0 ? 0 : 1);
