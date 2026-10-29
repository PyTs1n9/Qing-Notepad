#!/usr/bin/env node
/**
 * End-to-end plugin pipeline, exercised without a GUI.
 *
 * The chain this script walks is the one a user walks:
 *
 *   1. 搜索   索引从三个源里取到（与 Rust 侧 `INDEX_URLS` 同序）
 *   2. 选择   挑一个 GitHub 托管的条目，逐条校验它敢不敢被安装
 *   3. 安装   下载（cdn → fastly → gcore 回退）→ sha256 → 解包防线 → 清单 → 落盘
 *   4. 加载   worker 前奏 + 插件产物，真跑 `worker-boot.js`
 *   5. 功能   向插件下命令，断言它对外产生的可观测结果
 *
 * What is real and what is simulated, stated up front because the difference
 * matters:
 *
 * - **Real**: the index bytes, the package bytes, sha256, the manifest, the
 *   plugin bundle, `src/plugin/worker-boot.js`, the message protocol
 *   (`init` / `ready` / `call` / `rpc` / `res` / `log`), and the plugin's own
 *   code paths.
 * - **Simulated**: the host side of `bridge.ts`. It imports Tauri IPC and the
 *   Zustand stores, so it cannot run under Node; `HOST_CALLS` below mirrors its
 *   permission table and its replies exactly. A host-side regression would not
 *   be caught here — `npm run verify:plugin-runtime` is the gate for that.
 * - **Not covered**: the Rust install command's own filesystem writes, the
 *   permission dialog, and the command palette. Those need the app window; §6 of
 *   `docs/plugin-guide.md` gives the manual steps and their pass criteria.
 *
 * Usage: npm run verify:plugin-e2e [-- --plugin <id>]
 * Exit code 0 only when every stage passes. Network is required; a blocked
 * network is reported as a named stage failure, never as a silent skip.
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const root = fileURLToPath(new URL("../..", import.meta.url));
const HOST_VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

/** Mirrors `plugin.rs::INDEX_URLS` — same sources, same order, same reason. */
const INDEX_URLS = [
  ["github", "https://raw.githubusercontent.com/PyTs1n9/Qing-Notepad-Plugins/main/index.json"],
  ["gitee", "https://gitee.com/PyTs1N9/Qing-Notepad-Plugins/raw/main/index.json"],
  ["jsdelivr", "https://cdn.jsdelivr.net/gh/PyTs1n9/Qing-Notepad-Plugins@main/index.json"],
];

/** Mirrors `plugin.rs::JSDELIVR_MIRRORS` and the order it tries them in. */
const JSDELIVR_MIRRORS = ["fastly.jsdelivr.net", "gcore.jsdelivr.net"];

/** Mirrors `plugin_manifest.rs::KNOWN_PERMISSIONS`. */
const KNOWN_PERMISSIONS = new Set([
  "storage",
  "notes:read",
  "notes:write",
  "todo:read",
  "todo:write",
  "clipboard:read",
  "clipboard:write",
  "notify",
  "editor:read",
  "editor:write",
  "editor:decorate",
  "views",
  "editor:selection",
]);

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_SINGLE_FILE = 5 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const SUPPORTED_API_VERSION = 1;
const FETCH_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const COMMAND_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const stages = [];
let failureCount = 0;

function stage(index, label) {
  return {
    pass(detail) {
      stages.push({ index, label, ok: true, detail });
      console.log(`[${index}/5] ${label}  PASS  ${detail}`);
    },
    fail(detail) {
      stages.push({ index, label, ok: false, detail });
      failureCount += 1;
      console.log(`[${index}/5] ${label}  FAIL  ${detail}`);
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Stage 1 — search: the index, from whichever source answers first
// ---------------------------------------------------------------------------

async function fetchIndex() {
  const errors = [];
  for (const [source, url] of INDEX_URLS) {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "QingNotepad-PluginManager/1" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const document = JSON.parse(text);
      assert(document.schema === 1, `schema ${document.schema} is not supported`);
      assert(Array.isArray(document.plugins), "plugins is not an array");
      return { source, document, ms: Date.now() - started, skipped: errors };
    } catch (error) {
      errors.push(`${source}: ${error.message}`);
    }
  }
  throw new Error(`all index sources failed → ${errors.join("; ")}`);
}

// ---------------------------------------------------------------------------
// Stage 2 — selection: is this entry allowed to be installed at all
// ---------------------------------------------------------------------------

/** `>=0.7.3 <1.0.0` and friends: the conjunctive subset the market actually uses. */
function satisfies(version, range) {
  const parse = (value) => value.split(".").map((part) => Number.parseInt(part, 10));
  const [major, minor, patch] = parse(version);
  const compare = (other) => {
    const [oMajor, oMinor, oPatch] = parse(other);
    if (major !== oMajor) return major - oMajor;
    if (minor !== oMinor) return minor - oMinor;
    return patch - oPatch;
  };
  return range
    .trim()
    .split(/\s+/)
    .every((term) => {
      const match = term.match(/^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)$/);
      assert(match, `unsupported range term \`${term}\``);
      const [, operator = "=", target] = match;
      const delta = compare(target);
      switch (operator) {
        case ">=":
          return delta >= 0;
        case ">":
          return delta > 0;
        case "<=":
          return delta <= 0;
        case "<":
          return delta < 0;
        default:
          return delta === 0;
      }
    });
}

function validateEntry(entry) {
  assert(typeof entry.id === "string" && entry.id, "entry.id");
  assert(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(entry.id), `entry.id \`${entry.id}\` 不符合点分小写规则`);
  assert(entry.id.length <= 64, "entry.id 超过 64 字符");
  assert(/^\d+\.\d+\.\d+$/.test(entry.version), `entry.version \`${entry.version}\` 不是严格 semver`);
  assert(typeof entry.download === "string" && entry.download.startsWith("https://"), "entry.download 必须是 https");
  assert(/@[0-9a-f]{40}\//.test(entry.download), `entry.download \`${entry.download}\` 没有钉住 40 位 commit SHA`);
  assert(/^[0-9a-f]{64}$/.test(entry.sha256 ?? ""), "entry.sha256 必须是 64 位小写十六进制");
  assert(Array.isArray(entry.permissions), "entry.permissions 必须是数组");
  for (const permission of entry.permissions) {
    assert(KNOWN_PERMISSIONS.has(permission), `未知权限 \`${permission}\`（E_PERMISSION_UNKNOWN）`);
  }
  const range = entry.engines?.host;
  assert(typeof range === "string" && range.trim(), "entry.engines.host 缺失");
  assert(satisfies(HOST_VERSION, range), `宿主 ${HOST_VERSION} 不满足 \`${range}\`（E_HOST_VERSION）`);
  if (entry.apiVersion != null) {
    assert(entry.apiVersion === SUPPORTED_API_VERSION, `apiVersion ${entry.apiVersion}（E_API_VERSION）`);
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — install: download, verify, unpack, validate, place on disk
// ---------------------------------------------------------------------------

/** Same rewrite as `plugin.rs::download_candidates`: only the pinned CDN host. */
function downloadCandidates(url) {
  const candidates = [url];
  const prefix = "https://cdn.jsdelivr.net/";
  if (url.startsWith(prefix)) {
    for (const host of JSDELIVR_MIRRORS) candidates.push(`https://${host}/${url.slice(prefix.length)}`);
  }
  return candidates;
}

async function downloadWithMirrors(url) {
  const errors = [];
  const tried = [];
  for (const candidate of downloadCandidates(url)) {
    const host = new URL(candidate).host;
    const started = Date.now();
    try {
      const response = await fetch(candidate, {
        headers: { "User-Agent": "QingNotepad-PluginManager/1" },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("E_TOO_LARGE");
      tried.push(`${host} ${Date.now() - started}ms`);
      return { bytes, host, tried };
    } catch (error) {
      tried.push(`${host} FAIL(${error.message})`);
      errors.push(`${host}: ${error.message}`);
    }
  }
  throw new Error(`E_NETWORK 全部镜像失败 → ${errors.join("; ")}`);
}

/**
 * Minimal zip reader: central directory → local headers → inflateRaw.
 *
 * Written out rather than shelling to `unzip` because the point of this script
 * is to run anywhere `npm run` runs, and because the entry names are what the
 * zip-slip / ADS checks below have to inspect *before* anything touches disk.
 */
function readZip(buffer) {
  const eocd = (() => {
    const min = Math.max(0, buffer.length - 0xffff - 22);
    for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
      if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    throw new Error("不是 zip：找不到中央目录结尾");
  })();

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < count; index += 1) {
    assert(buffer.readUInt32LE(cursor) === 0x02014b50, "中央目录条目签名不对");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);

    entries.push({ name, data, declaredSize: uncompressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * The unpack defences, mirrored from `plugin.rs::extract_archive`.
 *
 * Names are checked *before* extraction, not sanitised into something that
 * happens to work: a package that asks for `../x.js` is refused, because the
 * name is the only place that intent is visible.
 */
function assertSafeEntries(entries) {
  assert(entries.length <= MAX_ENTRIES, `E_TOO_MANY_FILES：${entries.length} 个条目`);
  let total = 0;
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, "/");
    assert(!name.includes(":"), `E_ZIP_SLIP：条目名含冒号（NTFS 数据流）\`${entry.name}\``);
    assert(!name.startsWith("/"), `E_ZIP_SLIP：绝对路径 \`${entry.name}\``);
    assert(!name.split("/").includes(".."), `E_ZIP_SLIP：路径穿越 \`${entry.name}\``);
    assert(!/\.(node|wasm)$/i.test(name), `E_NATIVE_MODULE：\`${entry.name}\``);
    assert(entry.data.length <= MAX_SINGLE_FILE, `E_TOO_LARGE：\`${entry.name}\` 超过 5 MB`);
    total += entry.data.length;
    assert(total <= MAX_ARCHIVE_BYTES, "E_TOO_LARGE：解包后超过 20 MB");
  }
}

function readManifest(entries) {
  const files = new Map(entries.map((entry) => [entry.name.replace(/\\/g, "/"), entry.data]));
  // `plugin.rs::declared_format`: a `package.json` is authoritative only when it
  // declares a non-empty `main`. A build-only package.json (scripts, devDeps,
  // `"private": true`) must not shadow the plugin.json sitting next to it.
  const packageBytes = files.get("package.json");
  const packageMain = packageBytes
    ? (() => {
        try {
          return JSON.parse(packageBytes.toString("utf8")).main;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const usePackageJson = typeof packageMain === "string" && packageMain.trim().length > 0;
  const manifestBytes = usePackageJson ? packageBytes : files.get("plugin.json");
  assert(manifestBytes, "E_MANIFEST_MISSING：包内没有可用的 package.json 或 plugin.json");
  const raw = JSON.parse(manifestBytes.toString("utf8"));

  // `from_package_json` in plugin_manifest.rs: publisher+name, engines.qing, main.
  const id = usePackageJson
    ? raw.publisher
      ? `${raw.publisher}.${raw.name}`
      : raw.name
    : raw.id;
  const main = raw.main;
  assert(typeof id === "string" && id, "E_MANIFEST_INVALID：无法确定插件 id");
  assert(typeof main === "string" && main.trim(), "E_MANIFEST_INVALID：缺少 main");
  const manifest = {
    id,
    version: raw.version,
    apiVersion: raw.apiVersion ?? 1,
    engines: { host: raw.engines?.qing ?? raw.engines?.host },
    main: main.replace(/^\.\//, ""),
    permissions: raw.permissions ?? [],
    commands: (raw.contributes?.commands ?? []).map((command) => command.command ?? command.id),
  };
  assert(files.has(manifest.main), `E_MISSING_MAIN：包里没有 \`${manifest.main}\``);
  return manifest;
}

function validateManifest(manifest, entry) {
  assert(manifest.apiVersion === SUPPORTED_API_VERSION, `E_API_VERSION：${manifest.apiVersion}`);
  for (const permission of manifest.permissions) {
    assert(KNOWN_PERMISSIONS.has(permission), `E_PERMISSION_UNKNOWN：\`${permission}\``);
  }
  const range = manifest.engines.host;
  assert(typeof range === "string" && range.trim(), "E_MANIFEST_INVALID：engines 缺失");
  assert(satisfies(HOST_VERSION, range), `E_HOST_VERSION：需要 \`${range}\`，本机 ${HOST_VERSION}`);
  assert(manifest.id === entry.id, `包内 id \`${manifest.id}\` 与索引 \`${entry.id}\` 不一致`);

  // The index advertises the grant the user sees while browsing; the package
  // declares the one the prompt shows. Disagreement is refused before install.
  const expand = (list) => {
    const out = new Set(list);
    if (out.has("notes:write")) out.add("notes:read");
    if (out.has("todo:write")) out.add("todo:read");
    return out;
  };
  const declared = expand(manifest.permissions);
  const advertised = expand(entry.permissions);
  const mismatch =
    [...declared].filter((item) => !advertised.has(item)).length +
    [...advertised].filter((item) => !declared.has(item)).length;
  assert(mismatch === 0, "E_INDEX_PERMISSION_MISMATCH：索引与包内权限不一致");
}

// ---------------------------------------------------------------------------
// Stage 4/5 — load and run: the real worker prelude, a simulated host
// ---------------------------------------------------------------------------

/** Mirrors `bridge.ts::REQUIREMENTS` — which permission each host method needs. */
const REQUIREMENTS = {
  storage: { get: "storage", set: "storage", delete: "storage", keys: "storage" },
  notes: { list: "notes:read", get: "notes:read", create: "notes:write", update: "notes:write" },
  todo: { list: "todo:read", create: "todo:write", update: "todo:write" },
  clipboard: { read: "clipboard:read", write: "clipboard:write" },
  ui: { toast: "notify" },
  editor: { getText: "editor:read", getSelection: "editor:read", replace: "editor:write" },
  views: { refresh: "views" },
};

const NOTES_FIXTURE = [
  { id: "n1", title: "周会记录", tags: [], content: "# 周会\n- 上线插件市场\n- 修 DNS" },
  { id: "n2", title: "读书笔记", tags: [], content: "熵增是默认状态，秩序需要能量。" },
];

function runPlugin({ manifest, mainSource, permissions, commandId }) {
  const boot = readFileSync(join(root, "src", "plugin", "worker-boot.js"), "utf8");
  const script = `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = globalThis;
    globalThis.postMessage = (message) => parentPort.postMessage(message);
    globalThis.addEventListener = (type, handler) => {
      if (type === "message") parentPort.on("message", (data) => handler({ data }));
    };
${boot}
    globalThis.__qing_main = async function () {
${mainSource}
    };
  `;

  const worker = new Worker(script, { eval: true });
  const observed = { toasts: [], clipboard: [], logs: [], calls: [] };
  const storage = new Map();
  const grant = new Set(permissions);

  const hostCall = (namespace, method, args) => {
    const required = REQUIREMENTS[namespace]?.[method];
    if (!required) return { error: "E_INTERNAL" };
    if (!grant.has(required)) return { error: "E_PERMISSION_DENIED" };
    observed.calls.push(`${namespace}.${method}`);
    switch (`${namespace}.${method}`) {
      case "ui.toast":
        observed.toasts.push({ message: args[0], tone: args[1] });
        return { value: null };
      case "clipboard.write":
        observed.clipboard.push(args[0]);
        return { value: null };
      case "notes.list":
        return { value: NOTES_FIXTURE.map(({ id, title, tags }) => ({ id, title, tags })) };
      case "notes.get":
        return { value: NOTES_FIXTURE.find((note) => note.id === args[0]) ?? null };
      case "storage.set":
        storage.set(args[0], args[1]);
        return { value: null };
      case "storage.get":
        return { value: storage.get(args[0]) };
      default:
        return { value: null };
    }
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`E_TIMEOUT：${COMMAND_TIMEOUT_MS}ms 内没有应答`));
    }, COMMAND_TIMEOUT_MS);

    let callRid = null;
    worker.on("message", (message) => {
      switch (message.t) {
        case "log":
          observed.logs.push(message.args?.join(" ") ?? "");
          return;
        case "ready":
          callRid = 1;
          worker.postMessage({
            t: "call",
            rid: callRid,
            ns: "commands",
            method: "execute",
            args: [commandId],
          });
          return;
        case "rpc": {
          const result = hostCall(message.ns, message.method, message.args ?? []);
          worker.postMessage(
            result.error
              ? { t: "res", rid: message.rid, ok: false, code: result.error }
              : { t: "res", rid: message.rid, ok: true, value: result.value },
          );
          return;
        }
        case "res":
          if (message.rid !== callRid) return;
          clearTimeout(timer);
          worker.terminate();
          if (!message.ok) {
            reject(new Error(`${message.code}：命令执行失败`));
            return;
          }
          resolve(observed);
          return;
        default:
          return;
      }
    });
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.postMessage({
      t: "init",
      id: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      hostVersion: HOST_VERSION,
      permissions,
    });
  });
}

/** Independent count, so the assertion is not the plugin grading itself. */
function countCharacters(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
  return cjk + words;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const wantedId = (() => {
  const flag = process.argv.indexOf("--plugin");
  return flag >= 0 ? process.argv[flag + 1] : "qing.note-wordcount";
})();

/**
 * `--tamper` flips one byte after the download, before hashing.
 *
 * The failure paths of this chain have no UI to observe them in, so the script
 * has to be able to demonstrate that the gate actually fires — a verifier that
 * can only pass proves nothing about the one branch a user is most likely to
 * hit (a CDN serving a stale or truncated package).
 */
const tamper = process.argv.includes("--tamper");

const workDir = mkdtempSync(join(tmpdir(), "qing-plugin-e2e-"));

try {
  // 1 — search
  const searchStage = stage(1, "搜索");
  let index;
  try {
    index = await fetchIndex();
    searchStage.pass(
      `source=${index.source} ${index.document.plugins.length} 条 ${index.ms}ms` +
        (index.skipped.length ? `（前序源失败：${index.skipped.join("; ")}）` : ""),
    );
  } catch (error) {
    searchStage.fail(`${error.message} → 界面应显示「索引不可用」而不是空列表`);
    throw error;
  }

  // 2 — selection
  const selectStage = stage(2, "选择");
  const entry = index.document.plugins.find((item) => item.id === wantedId);
  try {
    assert(entry, `索引里没有 \`${wantedId}\``);
    validateEntry(entry);
    selectStage.pass(
      `${entry.id}@${entry.version} engines=${entry.engines.host} ` +
        `pinned@${entry.download.match(/@([0-9a-f]{40})\//)[1].slice(0, 7)}`,
    );
  } catch (error) {
    selectStage.fail(`${error.message} → 该条目应被拒绝安装`);
    throw error;
  }

  // 3 — install
  const installStage = stage(3, "安装");
  let manifest;
  let installDir;
  try {
    const download = await downloadWithMirrors(entry.download);
    if (tamper) {
      // Same length, same host, one byte different: exactly what a stale CDN
      // edge or a truncated transfer looks like from here.
      download.bytes[download.bytes.length - 1] ^= 0xff;
    }
    const actual = createHash("sha256").update(download.bytes).digest("hex");
    assert(
      actual === entry.sha256,
      `E_SHA256_MISMATCH：索引登记 ${entry.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
    );
    const entries = readZip(download.bytes);
    assertSafeEntries(entries);
    manifest = readManifest(entries);
    validateManifest(manifest, entry);

    installDir = join(workDir, "plugins", manifest.id, manifest.version);
    for (const file of entries) {
      const target = join(installDir, file.name.replace(/\\/g, "/"));
      assert(
        target.startsWith(installDir),
        `E_ZIP_SLIP：\`${file.name}\` 会落到插件目录之外`,
      );
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, file.data);
    }
    installStage.pass(
      `${download.bytes.length}B via ${download.host} sha256✓ ${entries.length} 文件 → ` +
        `plugins/${manifest.id}/${manifest.version}/（${download.tried.join(" → ")}）`,
    );
  } catch (error) {
    installStage.fail(`${error.message}`);
    throw error;
  }

  // 4 — load
  const loadStage = stage(4, "加载");
  const mainSource = readFileSync(join(installDir, manifest.main), "utf8");
  try {
    assert(!/^\s*(import|export)\s/m.test(mainSource), "产物含顶层 import/export（宿主会把正文包进函数）");
    assert(manifest.commands.length > 0, "清单没有 contributes.commands，命令面板里无入口");
    loadStage.pass(
      `${manifest.main} ${mainSource.length}B 无顶层 import/export，命令 ${manifest.commands.join(",")}`,
    );
  } catch (error) {
    loadStage.fail(`${error.message} → 插件应显示为「加载失败」并留下错误日志`);
    throw error;
  }

  // 5 — function
  const runStage = stage(5, "功能");
  try {
    const observed = await runPlugin({
      manifest,
      mainSource,
      permissions: manifest.permissions,
      commandId: manifest.commands[0],
    });
    assert(observed.toasts.length > 0, "命令跑完了但没有任何 toast，用户看不到结果");

    if (manifest.id === "qing.note-wordcount" || manifest.id === "qing.wordcount-ts") {
      const expected = NOTES_FIXTURE.reduce((sum, note) => sum + countCharacters(note.content), 0);
      const toast = observed.toasts.at(-1);
      assert(/success/.test(toast.tone ?? ""), `toast tone 是 \`${toast.tone}\`，预期 success`);
      assert(
        toast.message.includes(`${NOTES_FIXTURE.length} 篇笔记`),
        `toast 文案 \`${toast.message}\` 没有报告笔记篇数`,
      );
      assert(
        toast.message.includes(`${expected} 字`),
        `toast 报告的字数与独立计算不一致：期望 ${expected}，实际「${toast.message}」`,
      );
      runStage.pass(`toast「${toast.message}」与独立统计 ${expected} 字一致（宿主调用：${observed.calls.join(",")}）`);
    } else {
      const toast = observed.toasts.at(-1);
      assert(observed.clipboard.length > 0, "插件没有写剪贴板");
      assert(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(observed.clipboard[0]),
        `剪贴板内容 \`${observed.clipboard[0]}\` 不是 ISO 时间戳`,
      );
      runStage.pass(`剪贴板←「${observed.clipboard[0]}」 toast「${toast.message}」`);
    }
  } catch (error) {
    runStage.fail(`${error.message} → 用户看到的是命令失败提示 + 错误日志，不是静默无反应`);
    throw error;
  }

  console.log(`\n端到端链路通过：搜索 → 选择 → 安装 → 加载 → 功能（宿主 ${HOST_VERSION}）`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  console.log(`\n链路中断：\n  ${error.message}`);
  console.log(`  现场保留在 ${workDir}`);
  process.exit(1);
}
