/**
 * Headless verification for the sync pipeline's "do nothing twice" rules.
 *
 *   node scripts/verify-graph-sync.mjs
 *
 * Three claims, each one a link in the "graph never settles" chain that was
 * reproduced in the app:
 *
 * [1] A second `syncVault` over an unchanged vault must not push a snapshot.
 *     A pushed snapshot is a new `graphData` identity, and a new identity makes
 *     `force-graph` restart its cooldown (`force-graph.mjs:362-367`).
 * [2] `buildGraphData` must return the *same arrays* when the structure did not
 *     change, and new ones when a node is added or removed.
 * [3] `createPositionStore().write` must not touch the disk when the payload is
 *     byte-identical: `positions.ndjson` can live inside the watched vault, so
 *     a redundant write is a redundant watcher event.
 *
 * Everything that is not under test is either the real module (graphSync,
 * graphIndexStore, layoutEngine) or an explicit platform stub, so the bundle
 * runs under plain `node` with no GUI:
 *   - `@tauri-apps/plugin-fs`  -> `node:fs/promises` (absolute paths only),
 *                                 plus a per-path write counter
 *   - `@tauri-apps/api/core`   -> `invoke` dispatched to an in-memory vault
 *                                 backend that stands in for `vault.rs`
 *   - `@tauri-apps/api/event`  -> `listen` that never fires
 *   - `@/utils/storage`        -> `getDataDirectory()` returning the temp root
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

// ------------------------------------------------------------------- bundle
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-sync-verify-"));
const outfile = path.join(tmpDir, "sync.bundle.mjs");

/** `node:fs/promises` behind the plugin-fs surface, with a write counter. */
const tauriFsStub = {
  name: "stub-tauri-fs",
  setup(build) {
    build.onResolve({ filter: /^@tauri-apps\/plugin-fs$/ }, () => ({
      path: "tauri-fs-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `
import nodeFs from "node:fs/promises";
const writes = new Map();
globalThis.__GRAPH_FS_WRITES__ = writes;
export async function exists(target) {
  try { await nodeFs.access(target); return true; } catch { return false; }
}
export async function mkdir(target, opts) {
  await nodeFs.mkdir(target, { recursive: opts?.recursive ?? false });
}
export async function readDir(target) {
  const entries = await nodeFs.readdir(target, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
    isSymlink: entry.isSymbolicLink(),
  }));
}
export async function readTextFile(target) {
  return await nodeFs.readFile(target, "utf8");
}
export async function writeTextFile(target, data, opts) {
  writes.set(target, (writes.get(target) ?? 0) + 1);
  if (opts?.append) await nodeFs.appendFile(target, data, "utf8");
  else await nodeFs.writeFile(target, data, "utf8");
}
export async function remove(target, opts) {
  await nodeFs.rm(target, { recursive: opts?.recursive ?? false, force: true });
}
export async function rename(from, to) {
  await nodeFs.rename(from, to);
}
`,
      loader: "js",
    }));
  },
};

/** `invoke` / `listen` / `path` seams: the IPC edge of the renderer. */
const ipcStub = {
  name: "stub-tauri-ipc",
  setup(build) {
    build.onResolve({ filter: /^@tauri-apps\/api\/(core|event|path)$/ }, (args) => ({
      path: args.path,
      namespace: "ipc",
    }));
    build.onLoad({ filter: /.*/, namespace: "ipc" }, (args) => {
      if (args.path.endsWith("/core")) {
        return {
          contents: `
export async function invoke(command, payload) {
  const backend = globalThis.__GRAPH_VAULT_BACKEND__;
  if (!backend) throw new Error("no vault backend installed for command " + command);
  return await backend.invoke(command, payload);
}
export function isTauri() { return true; }
`,
          loader: "js",
        };
      }
      if (args.path.endsWith("/event")) {
        return {
          contents: `export async function listen() { return () => {}; }\n`,
          loader: "js",
        };
      }
      return {
        contents: `
export async function join(...parts) {
  return parts.filter((part) => part.length > 0).join("/");
}
export async function resourceDir() { return "/"; }
`,
        loader: "js",
      };
    });
  },
};

/**
 * `@/utils/storage` pulls the whole app storage layer (supabase, AI endpoints,
 * note migration). Only `getDataDirectory` is used by `graphSync`, so the seam
 * is replaced outright instead of stubbing five transitive dependencies.
 */
const storageStub = {
  name: "stub-storage",
  setup(build) {
    build.onResolve(
      { filter: /(^@\/utils\/storage$|utils[\\/]storage\.ts$)/ },
      () => ({ path: "storage", namespace: "storage-stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "storage-stub" }, () => ({
      contents: `export async function getDataDirectory() { return globalThis.__GRAPH_DATA_ROOT__; }\n`,
      loader: "js",
    }));
  },
};

await esbuild.build({
  stdin: {
    contents: [
      'export * as sync from "./src/utils/graph/graphSync.ts";',
      'export * as data from "./src/utils/graph/graphData.ts";',
      'export * as layout from "./src/utils/graph/layoutEngine.ts";',
      'export * as graphFs from "./src/utils/graph/graphFs.ts";',
      'export * as store from "./src/stores/graphStore.ts";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "graph-sync-verify-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent",
  alias: { "@": path.join(root, "src") },
  plugins: [tauriFsStub, ipcStub, storageStub],
  // `import.meta.env.DEV` is a Vite define. `false` keeps the DEV logs out of
  // the run and proves they are gated (nothing below depends on them).
  define: { "import.meta.env.DEV": "false" },
});
await esbuild.stop?.();

// Tauri v2 hangs `__TAURI_INTERNALS__` on every webview; `createGraphFs()`
// refuses to hand out the real implementation without it.
globalThis.window = { __TAURI_INTERNALS__: {} };
const dataRoot = path.join(tmpDir, "data");
fs.mkdirSync(dataRoot, { recursive: true });
globalThis.__GRAPH_DATA_ROOT__ = dataRoot;

const { sync: syncModule, data: dataModule, layout, graphFs, store: graphStoreModule } = await import(
  pathToFileURL(outfile).href
);

// ----------------------------------------------------------------- fixtures
const VAULT = "aabbccdd";
const VaultKey = VAULT;
/** relPath -> { mtimeMs, text } — the fake vault's content. */
const vaultFiles = new Map();
let vaultSkipped = [];

function installVaultBackend() {
  globalThis.__GRAPH_VAULT_BACKEND__ = {
    async invoke(command, payload) {
      if (command === "vault_list") {
        return [
          {
            key: VaultKey,
            root: path.join(tmpDir, "vault"),
            name: "vault",
            addedAt: "2024-01-01T00:00:00.000Z",
            lastScanAt: null,
            enabled: true,
            fileCount: vaultFiles.size,
          },
        ];
      }
      if (command === "vault_scan") {
        return {
          key: VaultKey,
          root: path.join(tmpDir, "vault"),
          files: [...vaultFiles.entries()]
            .map(([relPath, file]) => ({
              relPath,
              mtimeMs: file.mtimeMs,
              bytes: Buffer.byteLength(file.text, "utf8"),
            }))
            .sort((left, right) => left.relPath.localeCompare(right.relPath)),
          skipped: vaultSkipped,
          fileCount: vaultFiles.size,
          scannedAt: "2024-01-01T00:00:00.000Z",
        };
      }
      if (command === "vault_read_file") {
        const requested = Array.isArray(payload?.paths) ? payload.paths : [];
        return requested.map((relPath) => {
          const file = vaultFiles.get(relPath);
          if (!file) {
            return { relPath, text: null, bytes: 0, mtimeMs: 0, encoding: "none", skipped: "gone" };
          }
          return {
            relPath,
            text: file.text,
            bytes: Buffer.byteLength(file.text, "utf8"),
            mtimeMs: file.mtimeMs,
            encoding: "utf-8",
            skipped: null,
          };
        });
      }
      throw new Error(`unexpected vault command: ${command}`);
    },
  };
}

installVaultBackend();

/** Count `setSnapshot` pushes without changing what the store does. */
const graphStore = graphStoreModule.useGraphStore;
let snapshotPushes = 0;
const originalSetSnapshot = graphStore.getState().setSnapshot;
graphStore.setState({
  setSnapshot: (snapshot) => {
    snapshotPushes += 1;
    originalSetSnapshot(snapshot);
  },
});

// 和 `graphSync.resolveIndexRoot()` 拼出来的字符串逐字节一致：写入计数是按
// 路径字符串记账的，`path.join` 的 `\\` 与 `joinPath` 的 `/` 混用会对不上。
// 幂等写：`writeAtomic` 先写 `meta.json.tmp` 再 rename，所以计数要盯临时文件。
const metaPath = graphFs.joinPath(dataRoot, "graph", "index", "meta.json.tmp");
const writeCount = (target) => globalThis.__GRAPH_FS_WRITES__.get(target) ?? 0;

vaultFiles.set("a.md", { mtimeMs: 1000, text: "# A\n\n[[b]]\n" });
vaultFiles.set("b.md", { mtimeMs: 1000, text: "# B\n" });

// ================================================ [1] 零 diff 不推 snapshot
section("[1] 同一批文件连同步两次，第二次不推 snapshot");

const first = await syncModule.syncVault(VaultKey);
check("首次同步读入 2 个节点", first.added === 2, first);
check("首次同步推了一次 snapshot", snapshotPushes === 1, snapshotPushes);
const metaWritesAfterFirst = writeCount(metaPath);
check("首次同步写了 meta.json", metaWritesAfterFirst > 0, metaWritesAfterFirst);

const second = await syncModule.syncVault(VaultKey);
check("第二次同步没有新增", second.added === 0, second);
check("第二次同步没有改动", second.changed === 0, second);
check("第二次同步没有删除", second.removed === 0, second);
check("第二次同步没有重命名", second.renames === 0, second);
check("第二次同步没有推 snapshot", snapshotPushes === 1, snapshotPushes);
check("第二次同步没有重写 meta.json", writeCount(metaPath) === metaWritesAfterFirst, {
  before: metaWritesAfterFirst,
  after: writeCount(metaPath),
});
check("第二次同步仍报告扫描到的文件数", second.scanned === 2, second.scanned);
check("第二次同步复用已推送的 snapshot", graphStore.getState().snapshot?.nodes.length === 2);

const addedRun = await syncModule.syncVault(VaultKey);
check("无变化时第三次同步依然不推 snapshot", snapshotPushes === 1, {
  pushes: snapshotPushes,
  report: addedRun,
});

vaultFiles.set("c.md", { mtimeMs: 2000, text: "# C\n\n[[a]]\n" });
const third = await syncModule.syncVault(VaultKey);
check("新增文件后推了新 snapshot", snapshotPushes === 2, snapshotPushes);
check("新增文件被报告", third.added === 1, third);
check("新增后节点数是 3", graphStore.getState().snapshot?.nodes.length === 3);

vaultFiles.set("c.md", { mtimeMs: 3000, text: "# C\n\n[[a]] [[b]]\n" });
const fourth = await syncModule.syncVault(VaultKey);
check("mtime 变化被报告为 changed", fourth.changed === 1, fourth);
check("内容变化推了新 snapshot", snapshotPushes === 3, snapshotPushes);

vaultSkipped = [{ relPath: "huge.md", reason: "too large" }];
const fifth = await syncModule.syncVault(VaultKey);
check("只有 skipped 变化也要推一次", snapshotPushes === 4, { pushes: snapshotPushes, report: fifth });
const sixth = await syncModule.syncVault(VaultKey);
check("skipped 也是零 diff 时不推", snapshotPushes === 4, snapshotPushes);

// ============================================== [2] graphData 身份稳定
section("[2] 结构不变 -> graphData 引用相等；增删节点 -> 引用变化");

const makeNode = (id, overrides = {}) => ({
  id,
  kind: "vault",
  refId: id,
  vaultKey: VaultKey,
  title: id,
  path: id,
  dir: "",
  categoryId: null,
  tags: [],
  degree: 0,
  contentHash: null,
  bytes: 10,
  mtimeMs: 1000,
  parseError: null,
  ...overrides,
});

const makeEdge = (source, target) => ({ source, target, kind: "wiki", line: 1, raw: "" });

const nodesA = [makeNode("a.md"), makeNode("b.md")];
const edgesA = [makeEdge("a.md", "b.md")];
const nodesB = [makeNode("a.md"), makeNode("b.md")];
const edgesB = [makeEdge("a.md", "b.md")];
const seed = new Map([
  ["a.md", { x: 1, y: 2 }],
  ["b.md", { x: 3, y: 4 }],
]);

const signatureA = dataModule.graphSignature(nodesA, edgesA);
check("内容相同的两份快照签名相同", signatureA === dataModule.graphSignature(nodesB, edgesB), {
  signatureA,
  other: dataModule.graphSignature(nodesB, edgesB),
});
check(
  "边的方向进签名",
  dataModule.graphSignature(nodesA, [makeEdge("b.md", "a.md")]) !== signatureA,
);
check(
  "边的 kind 进签名",
  dataModule.graphSignature(nodesA, [{ ...makeEdge("a.md", "b.md"), kind: "markdown" }]) !==
    signatureA,
);
check("节点数量进签名", dataModule.graphSignature([...nodesA, makeNode("c.md")], edgesA) !== signatureA);

const built1 = dataModule.buildGraphData(null, nodesA, edgesA, seed);
check("首次构建不是复用", built1.reused === false);
check(
  "坐标从 positions 种进去",
  built1.cache.data.nodes[0].x === 1 && built1.cache.data.nodes[0].y === 2,
  built1.cache.data.nodes[0],
);
check(
  "边里的 source 是 id 字符串",
  built1.cache.data.links[0].source === "a.md",
  built1.cache.data.links[0],
);

const built2 = dataModule.buildGraphData(built1.cache, nodesB, edgesB, seed);
check("结构未变时复用缓存", built2.reused === true);
check("结构未变时 nodes 是同一个数组", built2.cache.data.nodes === built1.cache.data.nodes);
check("结构未变时 links 是同一个数组", built2.cache.data.links === built1.cache.data.links);
check(
  "结构未变时 data 对象本身也是同一个",
  built2.cache.data === built1.cache.data,
);

// 展示字段的变化必须落到缓存对象上，否则标题会一直停在旧值。
const renamed = [makeNode("a.md", { title: "新标题", degree: 1 }), makeNode("b.md", { degree: 1 })];
const built3 = dataModule.buildGraphData(built2.cache, renamed, edgesB, seed);
check("只改标题仍然复用（不重热布局）", built3.reused === true);
check(
  "标题被就地更新到缓存节点上",
  built3.cache.data.nodes[0].title === "新标题",
  built3.cache.data.nodes[0].title,
);
check("degree 也被就地更新", built3.cache.data.nodes[0].degree === 1, built3.cache.data.nodes[0].degree);

const built4 = dataModule.buildGraphData(
  built3.cache,
  [...nodesB, makeNode("c.md")],
  edgesB,
  seed,
);
check("加节点后重建", built4.reused === false);
check("加节点后 nodes 引用变化", built4.cache.data.nodes !== built3.cache.data.nodes);
check("加节点后新节点没有坐标", built4.cache.data.nodes[2].x === undefined);

const built5 = dataModule.buildGraphData(built4.cache, nodesB, edgesB, seed);
check("删节点后重建", built5.reused === false);
check("删节点后 nodes 引用变化", built5.cache.data.nodes !== built4.cache.data.nodes);
check("删节点后节点数回到 2", built5.cache.data.nodes.length === 2);

// ================================================= [3] 坐标写盘幂等
section("[3] 坐标内容相同则不写盘");

const layoutRoot = path.join(tmpDir, "layout");
const nodeGraphFs = graphFs.nodeGraphFs(tmpDir);
const layoutWrites = new Map();
const countingFs = {
  ...nodeGraphFs,
  writeTextFile: async (target, body, opts) => {
    layoutWrites.set(target, (layoutWrites.get(target) ?? 0) + 1);
    return await nodeGraphFs.writeTextFile(target, body, opts);
  },
};
const positionStore = layout.createPositionStore(countingFs, layoutRoot);
const positions = new Map([
  ["b.md", { x: 10.1234, y: 20.9876 }],
  ["a.md", { x: 1.5, y: 2.25 }],
]);
const temporaryPath = graphFs.joinPath(layoutRoot, "positions.ndjson.tmp");

await positionStore.write(positions);
const firstWrites = layoutWrites.get(temporaryPath) ?? 0;
check("第一次写坐标落盘一次", firstWrites === 1, firstWrites);

const body = await nodeGraphFs.readTextFile(graphFs.joinPath(layoutRoot, "positions.ndjson"));
check("坐标按 id 排序", body.startsWith('{"id":"a.md"'), body.split("\n")[0]);
check("坐标保留三位小数", body.includes('"x":10.123'), body);
check("正文以换行结尾", body.endsWith("\n"));

await positionStore.write(new Map(positions));
check("相同内容第二次不写盘", (layoutWrites.get(temporaryPath) ?? 0) === firstWrites, {
  before: firstWrites,
  after: layoutWrites.get(temporaryPath) ?? 0,
});

await positionStore.write(
  new Map([
    ["a.md", { x: 1.5, y: 2.25 }],
    ["b.md", { x: 99, y: 20.9876 }],
  ]),
);
check("内容变化后重新写盘", (layoutWrites.get(temporaryPath) ?? 0) === firstWrites + 1, {
  writes: layoutWrites.get(temporaryPath) ?? 0,
});

// 四舍五入到三位小数后相同的坐标，也不算变化。
await positionStore.write(
  new Map([
    ["a.md", { x: 1.5004, y: 2.2501 }],
    ["b.md", { x: 99.0004, y: 20.98761 }],
  ]),
);
check(
  "只在三位小数以内变化时不写盘",
  (layoutWrites.get(temporaryPath) ?? 0) === firstWrites + 1,
  { writes: layoutWrites.get(temporaryPath) ?? 0 },
);

// ------------------------------------------------------------------- result
console.log(`\nchecks: ${checks}   failures: ${failures}`);
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // 临时目录留给系统清理：一句清理失败不该盖住真正的测试结果。
}
if (failures > 0) process.exitCode = 1;
