/**
 * Headless verification for the layout layer (T05).
 *
 *   node scripts/verify-graph-layout.mjs
 *
 * Sections map onto §4.2.3 (coordinate cache), §4.2.4 (incremental placement,
 * "do not reshuffle the graph the user is looking at") and §4.2.5 (deterministic
 * clustered grid fallback).
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-layout-verify-"));
const outfile = path.join(tmpDir, "layout.bundle.mjs");

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
      'export * as layout from "./src/utils/graph/layoutEngine.ts";',
      'export * as graphFs from "./src/utils/graph/graphFs.ts";',
      'export * as ids from "./src/utils/graph/ids.ts";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "graph-layout-verify-entry.ts",
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

const { layout, graphFs, ids } = await import(pathToFileURL(outfile).href);

// ------------------------------------------------------------------ fixtures
const VAULT = "aabbccdd";

function vaultNode(relPath, overrides = {}) {
  const parts = relPath.split("/");
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return {
    id: ids.vaultNodeId(VAULT, relPath),
    kind: "vault",
    refId: relPath,
    vaultKey: VAULT,
    title: parts[parts.length - 1],
    path: relPath,
    dir,
    categoryId: null,
    tags: [],
    degree: 0,
    contentHash: null,
    bytes: 0,
    mtimeMs: 0,
    parseError: null,
    ...overrides,
  };
}

const makeEdge = (source, target, line = 1) => ({
  source,
  target,
  kind: "wiki",
  line,
  raw: `[[${target}]]`,
});

const indexRoot = graphFs.joinPath(tmpDir, "index");
const nodeFs = graphFs.nodeGraphFs(tmpDir);

// ===================================================== [1] 坐标缓存
section("[1] 坐标缓存读写（§4.2.3）");

const positionStore = layout.createPositionStore(nodeFs, indexRoot);
const emptyRead = await positionStore.read();
check("缓存不存在时读出空 Map", emptyRead instanceof Map && emptyRead.size === 0, emptyRead.size);

const original = new Map([
  ["v-aaaa-1", { x: 1.5, y: -2.25 }],
  ["v-aaaa-2", { x: 100, y: 200 }],
  ["d-bbbb", { x: 0, y: 0 }],
]);
await positionStore.write(original);
const roundtrip = await positionStore.read();
check("roundtrip 数量一致", roundtrip.size === 3, roundtrip.size);
check(
  "roundtrip 坐标逐点相等",
  [...original.entries()].every(([id, point]) => {
    const back = roundtrip.get(id);
    return back !== undefined && back.x === point.x && back.y === point.y;
  }),
  [...roundtrip.entries()],
);
check(
  "落盘格式是一行一个 { id, x, y }",
  fs
    .readFileSync(path.join(tmpDir, "index", "positions.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .every((line) => {
      const parsed = JSON.parse(line);
      return typeof parsed.id === "string" && typeof parsed.x === "number" && typeof parsed.y === "number";
    }),
);

// 坏行 / 半行必须被跳过，而不是让整个缓存失效
await nodeFs.writeTextFile(
  graphFs.joinPath(indexRoot, "positions.ndjson"),
  `${JSON.stringify({ id: "keep-1", x: 3, y: 4 })}\n{"id":"half","x":\n${JSON.stringify({ id: "keep-2", x: 5, y: 6 })}\n`,
);
const tolerant = await positionStore.read();
check("坏行被跳过，好行保留", tolerant.size === 2, [...tolerant.keys()]);
check("NaN 坐标不会被带进布局", [...tolerant.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));

// ===================================================== [2] 冷启动确定性
section("[2] 分簇网格冷启动（§4.2.5 确定性）");

const coldNodes = [
  vaultNode("项目/一.md"),
  vaultNode("项目/二.md"),
  vaultNode("项目/三.md"),
  vaultNode("读书/甲.md"),
  vaultNode("读书/乙.md"),
  vaultNode("根.md"),
  {
    id: ids.nativeNodeId("11111111-2222-3333-4444-555555555555"),
    kind: "native",
    refId: "11111111-2222-3333-4444-555555555555",
    vaultKey: null,
    title: "原生",
    path: null,
    dir: null,
    categoryId: "cat-a",
    tags: [],
    degree: 0,
    contentHash: null,
    bytes: 0,
    mtimeMs: 0,
    parseError: null,
  },
];

const coldFirst = layout.seedColdLayout(coldNodes);
const coldSecond = layout.seedColdLayout([...coldNodes].reverse());
check("所有节点都有坐标", coldFirst.size === coldNodes.length, coldFirst.size);
check(
  "两次调用（含输入顺序颠倒）逐字节相等",
  JSON.stringify([...coldFirst.entries()].sort()) === JSON.stringify([...coldSecond.entries()].sort()),
);
check("没有 NaN", [...coldFirst.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));

const projectIds = ["项目/一.md", "项目/二.md", "项目/三.md"].map((relPath) => ids.vaultNodeId(VAULT, relPath));
const readingIds = ["读书/甲.md", "读书/乙.md"].map((relPath) => ids.vaultNodeId(VAULT, relPath));
const distance = (leftId, rightId) => {
  const left = coldFirst.get(leftId);
  const right = coldFirst.get(rightId);
  return Math.hypot(left.x - right.x, left.y - right.y);
};
const withinProject = distance(projectIds[0], projectIds[1]);
const acrossClusters = distance(projectIds[0], readingIds[0]);
check("同簇节点彼此更近", withinProject < acrossClusters, [withinProject, acrossClusters]);

check("簇键按顶层目录切分", layout.clusterKeyOf(vaultNode("a/b/c.md")) === `vault:${VAULT}/a`, layout.clusterKeyOf(vaultNode("a/b/c.md")));
check("根目录文件单独成簇", layout.clusterKeyOf(vaultNode("x.md")) === `vault:${VAULT}/`, layout.clusterKeyOf(vaultNode("x.md")));
check(
  "原生笔记按 categoryId 分簇",
  layout.clusterKeyOf({ kind: "native", categoryId: "cat-a", vaultKey: null, dir: null }) === "native:cat-a",
);

// ===================================================== [3] 增量补位
section("[3] 增量：新节点落邻居质心（§4.2.4）");

const a = vaultNode("项目/a.md");
const b = vaultNode("项目/b.md");
const c = vaultNode("项目/c.md");
const isolated = vaultNode("别处/孤.md");
const positions = new Map([
  [a.id, { x: -100, y: 0 }],
  [b.id, { x: 100, y: 0 }],
  [isolated.id, { x: 900, y: 900 }],
]);
const incremental = layout.placeIncremental([a, b, c, isolated], positions, [
  makeEdge(a.id, c.id),
  makeEdge(b.id, c.id),
]);

const placed = incremental.positions.get(c.id);
check("新节点有坐标", placed !== undefined, placed);
check("落点在两个邻居之间（质心 + 抖动）", Math.abs(placed.x) < 10 && Math.abs(placed.y) < 10, placed);
check("已有节点坐标没被改动", positions.get(a.id).x === -100 && positions.get(b.id).x === 100);
check(
  "reheat 只含新节点与它的 1 跳邻居",
  JSON.stringify(incremental.reheatIds) === JSON.stringify([a.id, b.id, c.id].sort()),
  incremental.reheatIds,
);
check("不相干的已定位节点不进 reheat", !incremental.reheatIds.includes(isolated.id), incremental.reheatIds);

const noNeighbour = layout.placeIncremental([a, b, c, isolated], positions, []);
const clusterPlaced = noNeighbour.positions.get(c.id);
check(
  "没有邻居时落到同簇质心（簇内没有已定位节点 → 原点 + 抖动）",
  Math.abs(clusterPlaced.x) < 10 && Math.abs(clusterPlaced.y) < 10,
  clusterPlaced,
);
check(
  "无邻居时 reheat 只有自己",
  JSON.stringify(noNeighbour.reheatIds) === JSON.stringify([c.id]),
  noNeighbour.reheatIds,
);

// 无向邻接：边方向不影响"邻居"
const adjacency = layout.buildAdjacency([makeEdge(a.id, b.id)]);
check("邻接表是无向的", adjacency.get(a.id).includes(b.id) && adjacency.get(b.id).includes(a.id), [...adjacency.entries()]);

// ===================================================== [4] 补位与体积估算
section("[4] 缓存缺口与体积估算");

const missing = layout.missingPositionIds([a, b, c], new Map([[a.id, { x: 0, y: 0 }]]));
check("缺坐标的节点被列出", JSON.stringify(missing.sort()) === JSON.stringify([b.id, c.id].sort()), missing);
check("全部有坐标时为空", layout.missingPositionIds([a], new Map([[a.id, { x: 0, y: 0 }]])).length === 0);

const bytes = layout.estimatePositionBytes(new Map([[a.id, { x: 1, y: 2 }]]));
check("体积估算 > 0 且量级合理（< 200 B/节点）", bytes > 0 && bytes < 200, bytes);

check("PRNG 同种子同序列", (() => {
  const first = layout.mulberry32(42);
  const second = layout.mulberry32(42);
  return first() === second() && first() === second();
})());
check("PRNG 不同种子不同序列", layout.mulberry32(1)() !== layout.mulberry32(2)());

// ------------------------------------------------------------------ summary
fs.rmSync(tmpDir, { recursive: true, force: true });

const summary = `${checks - failures}/${checks} checks passed`;
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILED"} — ${summary}`);
process.exit(failures === 0 ? 0 : 1);
