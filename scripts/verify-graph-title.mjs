/**
 * Headless verification for the note title chain (v2) + index schema upgrade.
 *
 *   node scripts/verify-graph-title.mjs
 *
 * The bug this pins down: an imported Obsidian vault whose file names are UUIDs
 * (`25f9f43b-1078-484f-8a6d-18b951f4f106.md`) and whose bodies start with prose
 * used to be labelled with that UUID on the canvas, because a node's title was
 * "first H1, else the file name" and such a note has no H1.
 *
 * Section [1] is the nine required cases of the new chain, driven through the
 * **real** `adaptNoteSource` and the **real** `fallbackTitle` — the same two
 * calls `graphSync.parseVaultFile` makes, so a change that breaks the wiring
 * (not just the parser) fails here.
 *
 * Section [2] covers the boundaries of the same chain (fences, tables, images,
 * inline markup, the coded-name patterns).
 *
 * Section [3] is the index side: bumping `GRAPH_INDEX_SCHEMA_VERSION` has to
 * *actually drop* the stale shards on load (both a v1 index and a v2 one —
 * v2 was never released but a dev/QA profile may already have written it),
 * otherwise `stamps.ndjson` keeps every unchanged file out of the re-read and
 * the old UUID titles survive the upgrade forever. `positions.ndjson` must
 * survive it — the layout cache lives at the index root, not under `vaults/`,
 * and node ids are derived from relPath so the coordinates still apply.
 *
 * Only the Tauri fs/IPC seams are stubbed (same approach as
 * `scripts/verify-graph-index.mjs`); everything else is the production module.
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-title-verify-"));
const outfile = path.join(tmpDir, "title.bundle.mjs");

/** `@tauri-apps/plugin-fs` 在 node 里没有运行时；本节只用 `nodeGraphFs`，所以打桩。 */
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
      'export * as title from "./src/utils/graph/noteTitle.ts";',
      'export * as adapter from "./src/utils/graph/noteSourceAdapter.ts";',
      'export * as indexer from "./src/utils/graph/graphIndexer.ts";',
      'export * as store from "./src/utils/graph/graphIndexStore.ts";',
      'export * as graphFs from "./src/utils/graph/graphFs.ts";',
      'export * as ids from "./src/utils/graph/ids.ts";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "graph-title-verify-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent",
  alias: { "@": path.join(root, "src") },
  plugins: [tauriFsStub],
  define: { "import.meta.env.DEV": "false" },
});
await esbuild.stop?.();

const { title, adapter, indexer, store: storeModule, graphFs, ids } = await import(
  pathToFileURL(outfile).href
);

// ----------------------------------------------------------------- fixtures
const UUID = "25f9f43b-1078-484f-8a6d-18b951f4f106";

/**
 * 复刻 `graphSync.parseVaultFile` 的两步：正文给候选，给了就用；没给就回退到
 * `vaultNodeFields().title`（内部是 `fallbackTitle`）。测试必须走这两步，
 * 否则"解析器改了但接线没改"这种回归测不出来。
 */
function resolveNote(content, relPath) {
  const source = adapter.adaptNoteSource({ content, relPath });
  const fallback = indexer.vaultNodeFields(relPath).title;
  const usedFallback = source.titleCandidate === null;
  return {
    title: usedFallback ? fallback : source.titleCandidate,
    source: usedFallback ? "filename" : source.titleSource,
    kind: source.kind,
    linksParsable: source.linksParsable,
    body: source.body,
  };
}

// ============================================== [1] 标题候选链的九个必测用例
section("[1] 标题候选链（frontmatter → H1 → H2–H6 → 正文首行 → 文件名）");

const case1 = resolveNote('---\ntitle: "中文标题"\n---\n# 一级标题\n正文\n', "a.md");
check(
  "1) frontmatter title 优先于 H1，且去掉引号",
  case1.title === "中文标题" && case1.source === "frontmatter",
  case1,
);

const case2 = resolveNote("---\naliases: [别名一, 别名二]\n---\n# 一级标题\n", "a.md");
check(
  "2) 无 title 时 aliases 的第一项生效（内联数组）",
  case2.title === "别名一" && case2.source === "frontmatter",
  case2,
);

const case3 = resolveNote("# 只有一级标题\n正文\n", "a.md");
check(
  "3) 有 H1 → 用 H1",
  case3.title === "只有一级标题" && case3.source === "heading",
  case3,
);

const case4 = resolveNote("## 只有二级标题\n正文\n", "a.md");
check(
  "4) 无 H1 有 H2 → 用 H2",
  case4.title === "只有二级标题" && case4.source === "heading",
  case4,
);

const case5 = resolveNote("这是第一句普通的话，没有井号。\n第二行。\n", "a.md");
check(
  "5) 无任何标题 → 用正文首行",
  case5.title === "这是第一句普通的话，没有井号。" && case5.source === "text-line",
  case5,
);

const case6 = resolveNote("tags: [a, b]\n真正想显示的那一行\n", "a.md");
check(
  "6) 首行是裸元数据 → 跳过，取下一行",
  case6.title === "真正想显示的那一行" && case6.source === "text-line",
  case6,
);

const case7 = resolveNote("随手记第一行\n第二行\n", "随手记.txt");
check(
  "7) .txt 首行作为标题（且仍不解析链接）",
  case7.title === "随手记第一行" &&
    case7.source === "text-line" &&
    case7.kind === "text" &&
    case7.linksParsable === false,
  case7,
);

const case8 = resolveNote("", "%E4%B8%AD%E6%96%87.md");
check(
  "8) 文件名 %E4%B8%AD%E6%96%87.md → 中文",
  case8.title === "中文" && case8.source === "filename",
  case8,
);

const case9 = resolveNote("", `我的笔记/${UUID}.md`);
check(
  "9) UUID 文件名 + 空正文 → 父目录 · 前 8 位（不是整串 UUID）",
  case9.title === "我的笔记 · 25f9f43b" && case9.source === "filename",
  case9,
);
check(
  "9b) 回退链与 fallbackTitle 是同一实现（重命名修补不会给出不同标题）",
  indexer.fallbackTitle(`我的笔记/${UUID}.md`) === case9.title,
  indexer.fallbackTitle(`我的笔记/${UUID}.md`),
);

// ==================================================== [2] 同一链的边界情况
section("[2] 边界：frontmatter 变体、代码围栏、表格、行内修饰、编码名");

const blockAliases = resolveNote("---\naliases:\n  - 别名甲\n  - 别名乙\n---\n# 标题\n", "a.md");
check("块状数组 aliases 同样生效", blockAliases.title === "别名甲", blockAliases);

const nameKey = resolveNote("---\nname: '单引号名字'\n---\n# 标题\n", "a.md");
check("frontmatter name 作为次选", nameKey.title === "单引号名字", nameKey);

const tagOnly = resolveNote('---\ntags: [x]\n---\n', "a.md");
check("frontmatter 无标题键 → 不产出候选", tagOnly.title === "a", tagOnly);

const fenced = resolveNote("```\n# 代码里的井号\n```\n真正的首句\n", "a.md");
check("围栏代码块里的 # 与代码行都不算标题", fenced.title === "真正的首句", fenced);

const table = resolveNote("|---|---|\n| a | b |\n真正的一行\n", "a.md");
check("表格分隔线与表格行被跳过", table.title === "真正的一行", table);

const rule = resolveNote("---\n\n***\n真正的首句\n", "a.md");
check("水平分割线被跳过", rule.title === "真正的首句", rule);

const imageOnly = resolveNote("![](图.png)\n[链接](a.md)\n真正的首句\n", "a.md");
check("图片 / 链接独占行被跳过", imageOnly.title === "真正的首句", imageOnly);

const inline = resolveNote("**重点** 与 `代码` 和 ~~删除~~ 都在\n", "a.md");
check("行内 markdown 修饰被去掉", inline.title === "重点 与 代码 和 删除 都在", inline);

const htmlOnly = resolveNote("<!-- 注释 -->\n<div></div>\n真正的首句\n", "a.md");
check("HTML 注释 / 标签独占行被跳过", htmlOnly.title === "真正的首句", htmlOnly);

const longLine = resolveNote(`${"很长的一段话".repeat(30)}\n短标题\n`, "a.md");
check("超过 120 字的段落不当标题，继续往下找", longLine.title === "短标题", longLine);

const txtFrontmatter = resolveNote("---\ntitle: 纯文本标题\n---\n首行\n", "a.txt");
check(".txt 也读 frontmatter", txtFrontmatter.title === "纯文本标题", txtFrontmatter);

const txtHash = resolveNote("# 井号开头的一行\n第二行\n", "a.txt");
check(".txt 的 # 不当作 H1，但首行的井号会被去掉", txtHash.title === "井号开头的一行", txtHash);

const digitsName = resolveNote("", "20241029.md");
check("8 位纯数字文件名：根目录下保留原名（无父目录可用）", digitsName.title === "20241029", digitsName);

const hexName = resolveNote("", "导出/d41d8cd98f00b204e9800998ecf8427e.md");
check("32 位 hex 文件名 → 父目录 · 前 8 位", hexName.title === "导出 · d41d8cd9", hexName);

const normalName = resolveNote("", "会议纪要 2024.md");
check("普通中文文件名原样使用", normalName.title === "会议纪要 2024", normalName);

const nestedName = resolveNote("", "项目/子目录/笔记.md");
check("父目录名取最近的一级", nestedName.title === "笔记", nestedName);

/* ------------- 回归：单段超长正文不能回退到 UUID 文件名（QA 报的 P1） -------- */
// 中文 Markdown 极少硬换行，"整篇就一段"的导入稿很常见。若首行 >120 字就整行跳过，
// 这类笔记没有任何候选可用 → 回退文件名 → UUID 文件名的笔记重新显示成 UUID，
// 正是本次要修的 bug。所以第 4 级分两趟：先找 ≤120 字的行，一行都没有时把首段
// 截到 40 字并追加 `…`（让用户看出这是节选，而不是笔记第一句就到此为止）。
for (const length of [121, 150, 300]) {
  const single = resolveNote("这".repeat(length), `收件箱/${UUID}.md`);
  check(
    `单段 ${length} 字（无第二行）→ 前 40 字 + …，不回退 UUID`,
    single.source === "text-line" &&
      single.title === `${"这".repeat(40)}…` &&
      single.title.startsWith("这".repeat(40)) &&
      single.title.endsWith("…") &&
      single.title !== UUID,
    single,
  );
}

const at119 = resolveNote("这".repeat(119), `收件箱/${UUID}.md`);
const at120 = resolveNote("这".repeat(120), `收件箱/${UUID}.md`);
check(
  "119 / 120 字仍在原窗口内，整行使用不截断、不加省略号",
  at119.title.length === 119 &&
    at120.title.length === 120 &&
    !at119.title.endsWith("…") &&
    !at120.title.endsWith("…"),
  [at119.title.length, at120.title.length],
);

const longThenShort = resolveNote(`${"长".repeat(300)}\n短的第二行\n`, `收件箱/${UUID}.md`);
check(
  "超长首行 + 后面有短行 → 优先用短行，不截断",
  longThenShort.title === "短的第二行",
  longThenShort,
);

const englishLong = resolveNote(
  // 180 字 > 120，才会走到"截断首段"那条路径（短英文按整行用，不需要截断）。
  "The quick brown fox jumps over the lazy dog. ".repeat(4),
  `收件箱/${UUID}.md`,
);
check(
  "超长英文按词边界截断（不留半截单词）+ 省略号",
  englishLong.source === "text-line" &&
    englishLong.title.length <= 41 &&
    englishLong.title.startsWith("The quick brown") &&
    englishLong.title.endsWith("…") &&
    !englishLong.title.includes(" …"),
  englishLong,
);

/* ------------- 回归：frontmatter 的三种"忽略而不是猜"（QA 报的两个 P2） ------ */
const blockScalarPipe = resolveNote("---\ntitle: |\n  多行标题\n---\n正文。\n", "a.md");
check("块标量 title: | 被忽略（不能把竖线当标题）", blockScalarPipe.title === "正文。", blockScalarPipe);

const blockScalarFold = resolveNote("---\ntitle: >-\n  折叠标题\n---\n正文。\n", "a.md");
check("块标量 title: >- 被忽略", blockScalarFold.title === "正文。", blockScalarFold);

const blockScalarFoldPlain = resolveNote("---\ntitle: >\n  折叠标题\n---\n正文。\n", "a.md");
check("块标量 title: > 被忽略", blockScalarFoldPlain.title === "正文。", blockScalarFoldPlain);

const nestedMapping = resolveNote("---\nmeta:\n  title: 嵌进去的\n---\n正文。\n", "a.md");
check("嵌套映射里的 title 不提升为顶层键", nestedMapping.title === "正文。", nestedMapping);

const flowItem = resolveNote("---\naliases:\n  - {a: 1}\n  - 真正的别名\n---\n正文。\n", "a.md");
check("列表项是流式集合时丢弃，取下一个标量别名", flowItem.title === "真正的别名", flowItem);

const blockThenKey = resolveNote(
  "---\ntitle: |\n  块内容\n  title: 不是键\nname: 真名字\n---\n正文。\n",
  "a.md",
);
check("块标量结束后仍能读到后面的顶层键", blockThenKey.title === "真名字", blockThenKey);
check(
  "块标量里的内容行不会被当成键",
  blockThenKey.title !== "不是键" && blockThenKey.title !== "块内容",
  blockThenKey.title,
);

/* ------------- 回归：frontmatter 值里的行内修饰被去掉（QA 备查项，顺手修） --- */
const boldTitle = resolveNote("---\ntitle: '**加粗周报**'\n---\n正文。\n", "a.md");
check("frontmatter 值里的 ** 被去掉", boldTitle.title === "加粗周报", boldTitle);

const wikiAlias = resolveNote("---\naliases:\n  - '[[维基]]'\n---\n正文。\n", "a.md");
check("别名里的 wiki 语法被去掉（不留方括号）", wikiAlias.title === "维基", wikiAlias);

const mdLinkTitle = resolveNote("---\ntitle: '[链接](x.md)'\n---\n正文。\n", "a.md");
check("frontmatter 值里的 markdown 链接保留可见文字", mdLinkTitle.title === "链接", mdLinkTitle);

const nestedArrayAlias = resolveNote("---\naliases: [[会议]]\n---\n正文。\n", "a.md");
check(
  "aliases: [[会议]] 只留别名本身（不留残缺方括号）",
  nestedArrayAlias.title === "会议",
  nestedArrayAlias,
);

const onlyMarkupTitle = resolveNote("---\ntitle: '**'\n---\n# 正文标题\n", "a.md");
check(
  "frontmatter 值清洗后为空 → 继续走下一级候选（返回空标题不算完）",
  onlyMarkupTitle.title === "正文标题" && onlyMarkupTitle.source === "heading",
  onlyMarkupTitle,
);

const numberedTitle = resolveNote("---\ntitle: 3. 版本说明\n---\n正文。\n", "a.md");
check(
  "frontmatter 值不剥行首编号（`3. ` 是标题的一部分）",
  numberedTitle.title === "3. 版本说明",
  numberedTitle,
);

const underscoreAlias = resolveNote("---\naliases: [my_note]\n---\n正文。\n", "a.md");
check("下划线不当修饰符（别名里的 _ 是内容）", underscoreAlias.title === "my_note", underscoreAlias);

check(
  "looksLikeCodedName 只认 UUID / 长 hex / 长数字",
  title.looksLikeCodedName(UUID) &&
    title.looksLikeCodedName("d41d8cd98f00b204e9800998ecf8427e") &&
    title.looksLikeCodedName("20241029") &&
    !title.looksLikeCodedName("K3n8Qz") &&
    !title.looksLikeCodedName("会议纪要") &&
    !title.looksLikeCodedName("1234"),
  [
    title.looksLikeCodedName(UUID),
    title.looksLikeCodedName("K3n8Qz"),
  ],
);

// ================================= [3] schemaVersion 升级会真的作废旧分片
section("[3] 索引版本升到 3：旧分片作废、坐标保留（升级后无需手动「刷新索引」）");

const VAULT = "aabbccdd";
const staleRelPath = `我的笔记/${UUID}.md`;
const staleNode = {
  id: ids.vaultNodeId(VAULT, staleRelPath),
  kind: "vault",
  refId: staleRelPath,
  vaultKey: VAULT,
  // 按旧规则写下的标题就是这串 UUID —— 正是要修掉的现象。
  title: UUID,
  path: staleRelPath,
  dir: "我的笔记",
  categoryId: null,
  tags: [],
  degree: 0,
  contentHash: null,
  bytes: 12,
  mtimeMs: 1000,
  parseError: null,
};
const staleStamp = {
  id: staleNode.id,
  vaultKey: VAULT,
  relPath: staleRelPath,
  mtimeMs: 1000,
  bytes: 12,
  hash: "hash-of-stale",
  edgeCount: 0,
};

/**
 * 造一份"旧版本写出来的索引"：meta.json（指定版本）+ 一个分片 + 根上的
 * positions.ndjson。版本号由调用方给，所以同一套 fixture 能测 1 → 3 与 2 → 3。
 */
function seedStaleIndex(sub, version) {
  const root = path.join(tmpDir, sub);
  const shard = path.join(root, "vaults", VAULT);
  const positions = path.join(root, "positions.ndjson");
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(
    path.join(root, "meta.json"),
    `${JSON.stringify(
      {
        schemaVersion: version,
        builtAt: "2024-01-01T00:00:00.000Z",
        nodeCount: 1,
        edgeCount: 0,
        danglingCount: 0,
        skipped: [],
        shards: [{ key: VAULT, nodeCount: 1, edgeCount: 0 }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(shard, "nodes.ndjson"), `${JSON.stringify(staleNode)}\n`, "utf8");
  fs.writeFileSync(path.join(shard, "stamps.ndjson"), `${JSON.stringify(staleStamp)}\n`, "utf8");
  fs.writeFileSync(path.join(shard, "journal.ndjson"), "", "utf8");
  // 坐标缓存在 index 根，不在 vaults/ 下 —— 升级必须保住它。
  fs.writeFileSync(positions, `{"id":"${staleNode.id}","x":1.5,"y":2.5}\n`, "utf8");
  return { root, shard, positions };
}

const nodeFs = graphFs.nodeGraphFs(tmpDir);

/* ------------------------------------------------ v1 → 当前版本（首次升级） */
const v1 = seedStaleIndex("index-v1", 1);
const upgraded = storeModule.createGraphIndexStore({ fs: nodeFs, root: v1.root });
await upgraded.load();
check("v1 分片被整批作废（内存里 0 个节点）", upgraded.snapshot().meta.nodeCount === 0, upgraded.snapshot().meta);
check("v1 分片目录已被删除（下一轮同步会全量重读）", !fs.existsSync(v1.shard));
check("v1 stamps 一起作废（否则 mtime 未变的文件永远不重读）", upgraded.stamps(VAULT).length === 0);
check("positions.ndjson 原样保留", fs.existsSync(v1.positions) && fs.readFileSync(v1.positions, "utf8").includes('"x":1.5'));

await upgraded.writeMeta();
const rewrittenMeta = JSON.parse(fs.readFileSync(path.join(v1.root, "meta.json"), "utf8"));
check(
  "writeMeta 之后 meta.schemaVersion 是当前版本（第二次启动不再重建）",
  rewrittenMeta.schemaVersion === storeModule.GRAPH_INDEX_SCHEMA_VERSION,
  rewrittenMeta.schemaVersion,
);
check(
  "常量是 3（标题规则版本：规则再变继续 +1，不复用旧号）",
  storeModule.GRAPH_INDEX_SCHEMA_VERSION === 3,
  storeModule.GRAPH_INDEX_SCHEMA_VERSION,
);

const reloaded = storeModule.createGraphIndexStore({ fs: nodeFs, root: v1.root });
await reloaded.load();
check("版本已对齐后再 load 不会重复清空（幂等）", reloaded.snapshot().meta.nodeCount === 0);

/* ------------------------ v2 → 当前版本（v2 从未发布，但本地 profile 可能有） */
// 这条正是把版本从 2 推到 3 的原因：复用 2 的话，已经写过 v2 的 dev / QA profile
// 既不清分片也不重读，"升级首开即重算"在最需要验证的机器上恰好不成立。
const v2 = seedStaleIndex("index-v2", 2);
const fromV2 = storeModule.createGraphIndexStore({ fs: nodeFs, root: v2.root });
await fromV2.load();
check("v2 分片同样被作废（不能只认 v1）", fromV2.snapshot().meta.nodeCount === 0, fromV2.snapshot().meta);
check("v2 分片目录已被删除", !fs.existsSync(v2.shard));
check("v2 的 positions.ndjson 也保留", fs.existsSync(v2.positions));

/* ---------------------------------------- 反例：meta 缺失不能误清分片 */
// "写完分片还没写 meta 就崩溃" 的现场：分片可信，必须照常装载。
const noMetaRoot = path.join(tmpDir, "index-no-meta");
const noMetaVault = path.join(noMetaRoot, "vaults", VAULT);
fs.mkdirSync(noMetaVault, { recursive: true });
fs.writeFileSync(path.join(noMetaVault, "journal.ndjson"), `${JSON.stringify({ op: "upsert", ts: 1, node: staleNode, edges: [], stamp: staleStamp })}\n`, "utf8");

const noMetaStore = storeModule.createGraphIndexStore({ fs: nodeFs, root: noMetaRoot });
await noMetaStore.load();
check("meta.json 缺失（崩溃现场）时按原样装载 journal", noMetaStore.snapshot().meta.nodeCount === 1, noMetaStore.snapshot().meta);

/* ------------------------------------- 反例：%E5%88%9D%E6%AC%A1 vaults 为空 */
const emptyRoot = path.join(tmpDir, "index-empty");
const emptyStore = storeModule.createGraphIndexStore({ fs: nodeFs, root: emptyRoot });
await emptyStore.load();
check("首次运行 vaults/ 为空 → 正常空图，不报错", emptyStore.snapshot().meta.nodeCount === 0);
check("首次运行不会删掉 index 根（positions 目录仍在）", fs.existsSync(emptyRoot));

// ------------------------------------------------------------------ summary
fs.rmSync(tmpDir, { recursive: true, force: true });

const summary = `${checks - failures}/${checks} checks passed`;
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILED"} — ${summary}`);
process.exit(failures === 0 ? 0 : 1);
