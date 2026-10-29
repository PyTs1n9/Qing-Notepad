/**
 * Architecture invariant gate.
 *
 *   node scripts/verify-architecture.mjs              # 常规门禁，失败退出码 1
 *   node scripts/verify-architecture.mjs --self-test   # 额外证明"检测器能判负"
 *
 * 只用 node 内置模块，零依赖：扫 `src` 下全部 .ts/.tsx 的 import 语句，自己建图。
 * 不引入解析器是刻意的——门禁要在任何机器上零安装可跑，正则对"import 语句"这一
 * 种形态足够稳（注释会被先剥掉，见 stripComments）。
 *
 * 五条规则与基线：
 *   R1 无循环依赖          src/ 全量 import 图，非平凡强连通分量 = 0
 *   R2 状态层不直连宿主    src/stores/** 不出现 @tauri-apps/
 *   R3 utils→stores 白名单  出现白名单外的新依赖即失败（现有 11 个文件）
 *   R4 工具层不含 UI       src/utils/** 不 import @/components 或 @/plugin
 *   R5 桶文件登记          src/**\/index.ts 只允许 2 个
 *
 * `--self-test` 会往 `src/__arch_probe__/`（**唯一**的探针目录，已进 .gitignore）塞几个
 * 合成违规文件，断言每条规则都能报出它们，跑完在 `finally` 里删掉整个目录。没有这一步，
 * "门禁永远是 OK"和"门禁真的在检查"看起来一模一样。
 *
 * 探针不散落在 `src/utils/`、`src/stores/` 里：那些位置会被 `git add -A`、编辑器索引、
 * `tsc --watch` 看到，异常退出时还会留垃圾。集中到一个固定目录后，并发操作要么看不见
 * （gitignore），要么只看见一整个可一键删除的目录；启动时也会先清残留。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcDir = path.join(root, "src");

/**
 * 合成违规的唯一落脚点。目录内的 `utils/`、`stores/` 子目录是用来**冒充层**的：
 * 规则按层判定路径，`layerPath()` 会把这段前缀剥掉，于是
 * `src/__arch_probe__/utils/x.ts` 会被当成 `src/utils/x.ts` 参与 R3/R4 判定。
 */
const PROBE_ROOT = "src/__arch_probe__";

const toRel = (file) => path.relative(root, file).split(path.sep).join("/");

/** 判定用的"逻辑路径"：剥掉探针目录前缀，其余原样返回。 */
function layerPath(rel) {
  return rel.startsWith(`${PROBE_ROOT}/`) ? `src/${rel.slice(PROBE_ROOT.length + 1)}` : rel;
}

/**
 * 删掉整个探针目录。
 *
 * 刻意不用 `fs.rmSync(recursive)`：本机宿主把 `rmSync` 包进了"安全删除"层
 * （往回收站丢），递归删目录会以 `Some operations were aborted` 失败并留下垃圾。
 * 逐文件 `unlinkSync` + 自底向上 `rmdirSync` 是确定性的，也便于失败时报出具体路径。
 */
function removeProbeDir() {
  const probeDir = path.join(root, PROBE_ROOT);
  if (!fs.existsSync(probeDir)) return true;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        fs.rmdirSync(full);
      } else {
        fs.unlinkSync(full);
      }
    }
  };
  try {
    walk(probeDir);
    fs.rmdirSync(probeDir);
  } catch (error) {
    console.error(`无法清理 ${PROBE_ROOT}/：`, error instanceof Error ? error.message : error);
  }
  return !fs.existsSync(probeDir);
}

/** 启动时先清残留：上一次异常退出的探针不能污染本次扫描。 */
function cleanupProbeDir() {
  if (!fs.existsSync(path.join(root, PROBE_ROOT))) return false;
  removeProbeDir();
  console.log("[cleanup] removed leftover probes");
  return true;
}


// --------------------------------------------------------------- 扫描与解析
function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      listSourceFiles(full, out);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 先剥注释再找 import。`src/stores/dialogStore.ts:6` 在文档注释里提到了
 * `@tauri-apps/plugin-dialog`，不剥注释就会把它当成违规。
 */
function stripComments(code) {
  const withoutBlocks = code.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlocks
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
}

const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import x from "..." / export * from "..."
  /\bimport\s*["']([^"']+)["']/g, // import "..."
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("...")
];

function collectSpecifiers(code) {
  const source = stripComments(code);
  const specifiers = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return [...specifiers];
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** 把 `@/x` / `./x` 解析成 src 内的真实文件；外部包返回 null。 */
function resolveSpecifier(fromFile, specifier) {
  let base = null;
  if (specifier.startsWith("@/")) base = path.join(srcDir, specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  }
  if (base === null) return null;
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function scanSource() {
  const files = listSourceFiles(srcDir);
  const scanned = files.map((file) => ({
    file,
    rel: toRel(file),
    specifiers: collectSpecifiers(fs.readFileSync(file, "utf8")),
  }));
  const graph = new Map();
  for (const entry of scanned) {
    const edges = new Set();
    for (const specifier of entry.specifiers) {
      const resolved = resolveSpecifier(entry.file, specifier);
      if (resolved !== null) edges.add(resolved);
    }
    graph.set(entry.file, edges);
  }
  return { files, scanned, graph };
}

/** Tarjan：返回大小 > 1 的强连通分量，以及自引用环。 */
function findCycleComponents(graph) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];

  const strongConnect = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (!index.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }

    if (low.get(node) === index.get(node)) {
      const component = [];
      let popped = null;
      do {
        popped = stack.pop();
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      const selfLoop = component.length === 1 && (graph.get(node)?.has(node) ?? false);
      if (component.length > 1 || selfLoop) components.push(component);
    }
  };

  for (const node of graph.keys()) if (!index.has(node)) strongConnect(node);
  return components;
}

// ------------------------------------------------------------------- 白名单
/**
 * R3 白名单：`utils` 反向上依赖 `stores` 的既有文件。
 *
 * 这是**技术债清单，不是许可清单**——新增条目要走 review。其中 7 个是值导入
 * （真正形成倒置：canvasTile / announcements / noteDeletion / tile / storage /
 * graph/graphSync / ai/noteWrite），另 4 个只借类型（i18n / theme /
 * shortcutManager / ai/emptyState），类型导入在编译后被擦除，成本仅为方向噪声。
 */
const UTILS_TO_STORES_WHITELIST = new Map([
  ["src/utils/canvasTile.ts", "画布平铺几何要读 gridSize / 网格背景设置（值导入）"],
  ["src/utils/tile.ts", "同上，便签平铺的尺寸与配色来自设置（值导入）"],
  ["src/utils/announcements.ts", "通告栏文案与兜底内容按语言/主题出（值导入 + LangType）"],
  ["src/utils/noteDeletion.ts", "删除后需要同步 noteStore 内存列表（值导入，回收站入口）"],
  ["src/utils/storage.ts", "落盘层要读 trashRetentionDays 与 AI 端点设置（值导入）；已知倒置，见 docs/decisions-architecture-layering.md 契约 1"],
  ["src/utils/graph/graphSync.ts", "同步进度要写回 graphStore（值导入），图谱侧既有形态，见 decisions-knowledge-graph.md"],
  ["src/utils/ai/noteWrite.ts", "AI 改笔记要落到 noteStore（值导入），见 decisions-ai-note-write.md"],
  ["src/utils/i18n.ts", "仅 `import type { LangType }`，编译后擦除"],
  ["src/utils/theme.ts", "仅 `import type { ThemeType, CustomColors }`，编译后擦除"],
  ["src/utils/shortcutManager.ts", "仅 `import type { AppShortcuts }`，编译后擦除"],
  ["src/utils/ai/emptyState.ts", "仅 `import type { LangType }`，编译后擦除"],
]);

const ALLOWED_BARRELS = new Set(["src/types/index.ts", "src/utils/ai/chat/index.ts"]);

// ------------------------------------------------------------------- 规则集
const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);

function evaluate(scan) {
  const { files, scanned, graph } = scan;
  const results = [];

  // R1 无循环依赖
  const cycles = findCycleComponents(graph);
  results.push({
    id: "R1",
    title: "无循环依赖（非平凡强连通分量数）",
    measured: cycles.length,
    threshold: 0,
    ok: cycles.length === 0,
    details: cycles.map((component) => component.map(toRel).join(" → ")),
  });

  // R2 状态层不直连宿主
  const hostHits = [];
  for (const entry of scanned) {
    if (!under(layerPath(entry.rel), "src/stores")) continue;
    for (const specifier of entry.specifiers) {
      if (specifier.startsWith("@tauri-apps/")) hostHits.push(`${entry.rel} → ${specifier}`);
    }
  }
  results.push({
    id: "R2",
    title: "状态层不直连宿主（src/stores/** 中的 @tauri-apps/ import 数）",
    measured: hostHits.length,
    threshold: 0,
    ok: hostHits.length === 0,
    details: hostHits,
  });

  // R3 utils → stores 必须命中白名单
  const storeEdges = [];
  for (const entry of scanned) {
    const layer = layerPath(entry.rel);
    if (!under(layer, "src/utils")) continue;
    for (const specifier of entry.specifiers) {
      let hits = specifier.startsWith("@/stores/");
      if (!hits) {
        const resolved = resolveSpecifier(entry.file, specifier);
        hits = resolved !== null && under(toRel(resolved), "src/stores");
      }
      // 白名单按"逻辑路径"比对：探针冒充 utils 时不会被既有条目掩护。
      if (hits) storeEdges.push({ rel: entry.rel, layer });
    }
  }
  const uniqueStoreEdges = [...new Map(storeEdges.map((edge) => [edge.layer, edge])).values()].sort(
    (left, right) => left.layer.localeCompare(right.layer),
  );
  const unlisted = uniqueStoreEdges.filter((edge) => !UTILS_TO_STORES_WHITELIST.has(edge.layer));
  const stale = [...UTILS_TO_STORES_WHITELIST.keys()].filter(
    (rel) => !uniqueStoreEdges.some((edge) => edge.layer === rel),
  );
  results.push({
    id: "R3",
    title: "utils 反向上依赖 stores 必须命中白名单（白名单外文件数）",
    measured: unlisted.length,
    threshold: 0,
    ok: unlisted.length === 0,
    details: unlisted.map((edge) => `${edge.rel} 未登记，请在 UTILS_TO_STORES_WHITELIST 里补一行理由`),
    notes: [
      `实测依赖文件 ${uniqueStoreEdges.length} 个，白名单 ${UTILS_TO_STORES_WHITELIST.size} 条`,
      ...(stale.length === 0 ? [] : [`白名单已过期（可删）：${stale.join(", ")}`]),
    ],
  });

  // R4 工具层不含 UI
  const uiHits = [];
  for (const entry of scanned) {
    if (!under(layerPath(entry.rel), "src/utils")) continue;
    for (const specifier of entry.specifiers) {
      if (/^@\/(components|plugin)\//.test(specifier)) uiHits.push(`${entry.rel} → ${specifier}`);
      else {
        const resolved = resolveSpecifier(entry.file, specifier);
        if (resolved === null) continue;
        const rel = toRel(resolved);
        if (under(rel, "src/components") || under(rel, "src/plugin")) uiHits.push(`${entry.rel} → ${rel}`);
      }
    }
  }
  results.push({
    id: "R4",
    title: "工具层不含 UI（src/utils/** 对 components/plugin 的 import 数）",
    measured: uiHits.length,
    threshold: 0,
    ok: uiHits.length === 0,
    details: uiHits,
  });

  // R5 桶文件登记
  const barrels = files.map(toRel).filter((rel) => rel.endsWith("/index.ts") || rel === "src/index.ts");
  const unregistered = barrels.filter((rel) => !ALLOWED_BARRELS.has(rel));
  const missing = [...ALLOWED_BARRELS].filter((rel) => !barrels.includes(rel));
  results.push({
    id: "R5",
    title: "桶文件登记（未登记的 src/**/index.ts 数量）",
    measured: unregistered.length,
    threshold: 0,
    ok: unregistered.length === 0,
    details: unregistered.map((rel) => `${rel} 未登记；确实需要桶文件请在 ALLOWED_BARRELS 里登记`),
    notes: [
      `实测桶文件 ${barrels.length} 个：${barrels.join(", ")}`,
      ...(missing.length === 0 ? [] : [`已登记但已消失（可删）：${missing.join(", ")}`]),
    ],
  });

  return { results, barrels };
}

function report(scan) {
  const { results } = evaluate(scan);
  let failed = 0;
  for (const result of results) {
    console.log(`\n[${result.id}] ${result.title}`);
    console.log(`  实测 ${result.measured}　阈值 ${result.threshold}　${result.ok ? "PASS" : "FAIL"}`);
    for (const note of result.notes ?? []) console.log(`  · ${note}`);
    if (!result.ok) {
      failed += 1;
      for (const detail of result.details) console.log(`  ✗ ${detail}`);
    }
  }
  console.log(`\n扫描 ${scan.files.length} 个文件`);
  console.log(failed === 0 ? "PASS — 架构不变量全部成立" : `FAIL — ${failed} 条规则被打破`);
  return failed === 0;
}

// ------------------------------------------------------------------- 自检
/**
 * 每个探针只为一件事存在：让某条规则**必须**报错。
 *
 * 两个约束：
 * 1. 全部落在 `src/__arch_probe__/` 下（`utils/`、`stores/` 子目录用来冒充层）；
 * 2. 内容对 `tsc` 是干净的——探针存活的那一秒里若有人跑 `tsc --watch`，不应该因为
 *    我们自己的文件炸出一堆假错误。所以循环用 `import type`、组件用命名空间导入。
 */
const PROBES = [
  {
    file: `${PROBE_ROOT}/utils/__probe-ui.ts`,
    rule: "R4",
    contents:
      'import * as hostActivityBar from "@/components/Layout/ActivityBar";\nexport const probe = hostActivityBar;\n',
  },
  {
    file: `${PROBE_ROOT}/utils/__probe-store.ts`,
    rule: "R3",
    contents:
      'import { useSettingsStore } from "@/stores/settingsStore";\nexport const probe = useSettingsStore;\n',
  },
  {
    file: `${PROBE_ROOT}/stores/__probe-host.ts`,
    rule: "R2",
    contents: 'import { readDir } from "@tauri-apps/plugin-fs";\nexport const probe = readDir;\n',
  },
  {
    file: `${PROBE_ROOT}/utils/__probe-barrel/index.ts`,
    rule: "R5",
    contents: "export const probe = 1;\n",
  },
  {
    file: `${PROBE_ROOT}/utils/__probe-cycle-a.ts`,
    rule: "R1",
    contents:
      'import type { ProbeB } from "./__probe-cycle-b";\nexport type ProbeA = { next: ProbeB | null };\n',
  },
  {
    file: `${PROBE_ROOT}/utils/__probe-cycle-b.ts`,
    rule: "R1",
    contents:
      'import type { ProbeA } from "./__probe-cycle-a";\nexport type ProbeB = { prev: ProbeA | null };\n',
  },
];

function runSelfTest() {
  console.log("\n=== 自检：注入合成违规，确认检测器能判负 ===");
  console.log(`  探针目录：${PROBE_ROOT}/（已在 .gitignore 中，正常扫描前会被清空）`);
  const pristine = evaluate(scanSource());
  console.log(`  基线扫描：${pristine.results.map((r) => `${r.id}=${r.ok ? "PASS" : "FAIL"}`).join(" ")}`);

  let verdictOk = true;
  try {
    for (const probe of PROBES) {
      const target = path.join(root, probe.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, probe.contents, "utf8");
    }

    const { results } = evaluate(scanSource());
    const byId = new Map(results.map((result) => [result.id, result]));
    for (const probe of PROBES) {
      const result = byId.get(probe.rule);
      const details = (result?.details ?? []).join(" | ");
      const detected = result !== undefined && !result.ok && details.includes(path.basename(probe.file));
      if (!detected) verdictOk = false;
      console.log(
        `  ${detected ? "PASS" : "FAIL"}  ${probe.rule} 应报出 ${probe.file}` +
          (detected ? "" : `　实测 ${result?.ok ? "PASS（漏报）" : details}`),
      );
    }
  } finally {
    // 断言失败、异常抛出都会走到这里；整目录删除，不留任何单文件残渣。
    if (!removeProbeDir()) {
      verdictOk = false;
      console.log(`  FAIL  探针目录清理失败，请手工删除 ${PROBE_ROOT}/`);
    } else {
      console.log("  PASS  探针目录已整目录删除（工作区回到自检前状态）");
    }
  }

  console.log(verdictOk ? "SELF-TEST: PASS — 五条规则都可判负" : "SELF-TEST: FAIL — 有规则漏报");
  return verdictOk;
}

// ------------------------------------------------------------------- 入口
// 先清残留，再扫描：上一次自检异常退出留下的探针绝不能算进本次门禁。
cleanupProbeDir();

const scan = scanSource();
const gateOk = report(scan);

let selfTestOk = true;
if (process.argv.includes("--self-test")) selfTestOk = runSelfTest();

if (!gateOk || !selfTestOk) process.exitCode = 1;
