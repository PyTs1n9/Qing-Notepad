/**
 * Headless verification for the live-preview block parser (`editorBlocks.ts`, M1).
 *
 *   node scripts/verify-editor-blocks.mjs            # fixtures + examples + docs
 *   node scripts/verify-editor-blocks.mjs -v         # also print every block
 *   node scripts/verify-editor-blocks.mjs a.md b.md  # explicit files/directories
 *
 * Two halves:
 * - fixtures with hand-written expectations, one per rule in
 *   `docs/typora-editor-impl-plan.md` §4 plus the edges that decide a block
 *   boundary (nested lists, quotes as atoms, fenced code holding blank lines);
 * - real Markdown from this repository, printed as block count plus first and
 *   last block so a human can eyeball the boundaries.
 *
 * Invariants (valid offsets, ordering, determinism, `blocksFromState` parity,
 * `blockAt` innermost-wins) are checked on every document, fixtures included.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose") || argv.includes("-v");
const explicitPaths = argv.filter((arg) => !arg.startsWith("-"));

let checks = 0;
let failures = 0;

function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
}

const section = (title) => console.log(`\n${title}`);
const displayPath = (absolute) => path.relative(root, absolute).split(path.sep).join("/");

// ------------------------------------------------------------------ bundle
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-blocks-verify-"));
const outfile = path.join(tmpDir, "editorBlocks.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: [
      `export { blocks, blocksFromState, blockAt } from ${JSON.stringify(
        path.join(root, "src/utils/editorBlocks.ts"),
      ).replaceAll("\\", "/")};`,
      `export { Text, EditorState } from "@codemirror/state";`,
      `export { markdown, markdownLanguage } from "@codemirror/lang-markdown";`,
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
    sourcefile: "verify-entry.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent",
});

const { blocks, blocksFromState, blockAt, Text, EditorState, markdown, markdownLanguage } = await import(
  pathToFileURL(outfile).href
);

const KINDS = new Set(["paragraph", "heading", "code", "quote", "table", "hr", "html", "listItem"]);

/** Same language configuration the module uses, rebuilt here to test parity. */
const gfmLanguage = markdown({ base: markdownLanguage, addKeymap: false });

const toText = (source) => Text.of(source.split("\n"));
const sliceOf = (source, block) => source.slice(block.from, block.to);
const lineAt = (source, pos) => source.slice(0, pos).split("\n").length;
const describeBlock = (source, block) =>
  `${block.kind}/${block.depth} [${block.from},${block.to}) L${lineAt(source, block.from)}` +
  ` ${JSON.stringify(sliceOf(source, block).slice(0, 48))}`;

// ------------------------------------------------------------------ fixtures
/**
 * `expect` entries are `[kind, depth, exact source text]`. Text is compared
 * verbatim rather than by offsets so a wrong boundary shows up as readable
 * output instead of two bare numbers.
 */
const fixtures = [
  {
    name: "段落：空行分隔的两段",
    source: "第一段。\n\n第二段。\n",
    expect: [
      ["paragraph", 0, "第一段。"],
      ["paragraph", 0, "第二段。"],
    ],
  },
  {
    name: "标题：ATX 与 Setext，depth 为级别",
    source: "# 一级\n\n### 三级\n\n二级\n---\n",
    expect: [
      ["heading", 1, "# 一级"],
      ["heading", 3, "### 三级"],
      ["heading", 2, "二级\n---"],
    ],
  },
  {
    name: "围栏代码块：内部空行不切块",
    source: "```ts\nconst a = 1;\n\nconst b = 2;\n```\n",
    expect: [["code", 0, "```ts\nconst a = 1;\n\nconst b = 2;\n```"]],
  },
  {
    name: "缩进代码块与分隔线（CodeBlock 边界起于缩进之后）",
    source: "    indented\n\n***\n",
    expect: [
      ["code", 0, "indented"],
      ["hr", 0, "***"],
    ],
  },
  {
    name: "引用整体成块：内部列表不拆项",
    source: "> 第一段\n>\n> - 项一\n> - 项二\n",
    expect: [["quote", 1, "> 第一段\n>\n> - 项一\n> - 项二"]],
  },
  {
    name: "GFM 表格整体成块",
    source: "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    expect: [["table", 0, "| a | b |\n| --- | --- |\n| 1 | 2 |"]],
  },
  {
    name: "HTML 块整体成块",
    source: "<div>\n  <span>x</span>\n</div>\n",
    expect: [["html", 0, "<div>\n  <span>x</span>\n</div>"]],
  },
  {
    name: "列表逐项成块，嵌套项 depth+1",
    source: "- 一\n- 二\n  - 二之一\n  - 二之二\n- 三\n",
    expect: [
      ["listItem", 1, "- 一"],
      ["listItem", 1, "- 二\n  - 二之一\n  - 二之二"],
      ["listItem", 2, "- 二之一"],
      ["listItem", 2, "- 二之二"],
      ["listItem", 1, "- 三"],
    ],
  },
  {
    name: "列表项内含围栏代码块：项为原子块",
    source: "- 项\n\n  ```js\n  const x = 1;\n  ```\n",
    expect: [["listItem", 1, "- 项\n\n  ```js\n  const x = 1;\n  ```"]],
  },
  {
    name: "任务列表按项成块",
    source: "- [ ] 待办\n- [x] 已办\n",
    expect: [
      ["listItem", 1, "- [ ] 待办"],
      ["listItem", 1, "- [x] 已办"],
    ],
  },
  {
    name: "引用内含代码块与表格：仍为一个引用块",
    source: "> ```js\n> const y = 2;\n> ```\n>\n> | a |\n> | --- |\n> | 1 |\n",
    expect: [["quote", 1, "> ```js\n> const y = 2;\n> ```\n>\n> | a |\n> | --- |\n> | 1 |"]],
  },
  {
    name: "列表项内含引用：项为原子块",
    source: "- 项\n\n  > 引用\n",
    expect: [["listItem", 1, "- 项\n\n  > 引用"]],
  },
  {
    name: "顶层 HTML 注释块归入 html",
    source: "<!-- 注释\n跨行 -->\n\n正文\n",
    expect: [
      ["html", 0, "<!-- 注释\n跨行 -->"],
      ["paragraph", 0, "正文"],
    ],
  },
  {
    name: "链接引用定义：占用自己的块",
    source: "[ref]: https://example.com\n\n正文\n",
    expect: [
      ["paragraph", 0, "[ref]: https://example.com"],
      ["paragraph", 0, "正文"],
    ],
  },
  {
    name: "混合片段：标题 + 段落 + 列表 + 表格",
    source: "## 小节\n\n正文一行。\n\n- 甲\n- 乙\n\n| h |\n| --- |\n| v |\n",
    expect: [
      ["heading", 2, "## 小节"],
      ["paragraph", 0, "正文一行。"],
      ["listItem", 1, "- 甲"],
      ["listItem", 1, "- 乙"],
      ["table", 0, "| h |\n| --- |\n| v |"],
    ],
  },
  { name: "空文档：无块", source: "", expect: [] },
  { name: "仅空白行：无块", source: "\n\n  \n", expect: [] },
];

// ------------------------------------------------------------------ invariants
/**
 * Every property that must hold for any document. Returns human-readable
 * problems instead of asserting, so fixtures and real files can fold them into
 * one line each.
 */
function invariantProblems(source, list) {
  const problems = [];

  for (const block of list) {
    if (!KINDS.has(block.kind)) problems.push(`未知 kind ${block.kind}`);
    if (!Number.isInteger(block.from) || !Number.isInteger(block.to)) problems.push(`非整数边界 ${block.from}/${block.to}`);
    if (block.from < 0 || block.to > source.length) problems.push(`越界 ${block.from}..${block.to} / ${source.length}`);
    if (block.from > block.to) problems.push(`反向区间 ${block.from}>${block.to}`);
    if (block.kind === "heading" && !(block.depth >= 1 && block.depth <= 6)) problems.push(`标题级别越界 ${block.depth}`);
    if (block.kind === "listItem" && block.depth < 1) problems.push(`列表项 depth<1 ${block.depth}`);
    if (block.kind === "quote" && block.depth !== 1) problems.push(`引用 depth≠1 ${block.depth}`);
    if (!["heading", "listItem", "quote"].includes(block.kind) && block.depth !== 0) {
      problems.push(`${block.kind} depth 应为 0，实际 ${block.depth}`);
    }
    if (block.to > block.from && /^\s*$/.test(source.slice(block.from, block.to))) {
      problems.push(`空白块 ${block.kind}[${block.from},${block.to})`);
    }
  }

  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1];
    const current = list[i];
    const ordered = prev.from < current.from || (prev.from === current.from && prev.to >= current.to);
    if (!ordered) problems.push(`顺序错乱 ${describeBlock(source, prev)} → ${describeBlock(source, current)}`);
  }

  const again = blocks(toText(source));
  if (JSON.stringify(again) !== JSON.stringify(list)) problems.push("两次调用结果不一致");

  const state = EditorState.create({ doc: source, extensions: gfmLanguage });
  const fromState = blocksFromState(state);
  if (JSON.stringify(fromState) !== JSON.stringify(list)) problems.push("blocksFromState 与 blocks 结果不同");

  for (const block of list) {
    const hit = blockAt(list, block.from);
    if (!hit) problems.push(`blockAt(${block.from}) 查不到块`);
    else if (hit.to - hit.from > block.to - block.from) problems.push(`blockAt(${block.from}) 命中了更外层的块`);
  }

  // Nesting is only ever "item contains its nested items". Any other overlap is
  // a boundary bug the decoration layer would inherit as a broken range set.
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[j].from >= list[i].to) break;
      if (list[j].to <= list[i].to) {
        if (list[i].kind !== "listItem") {
          problems.push(`非列表块包含其它块 ${describeBlock(source, list[i])} ⊃ ${describeBlock(source, list[j])}`);
        }
      } else if (list[j].to > list[i].to) {
        problems.push(`部分重叠 ${describeBlock(source, list[i])} ∩ ${describeBlock(source, list[j])}`);
      }
    }
  }

  // Every non-blank line must be owned by a block, otherwise live preview has
  // caret positions it cannot degrade. Blank lines legitimately own nothing.
  const unowned = [];
  let lineStart = 0;
  for (const line of source.split("\n")) {
    const content = line.trimStart();
    if (content.length > 0) {
      const pos = lineStart + (line.length - content.length);
      if (!blockAt(list, pos)) unowned.push(lineAt(source, pos));
    }
    lineStart += line.length + 1;
  }
  if (unowned.length > 0) problems.push(`有块外内容：L${unowned.slice(0, 5).join(", ")}`);

  return problems;
}

// ------------------------------------------------------------------ fixtures run
section("夹具：块类型与边界（docs/typora-editor-impl-plan.md §4）");

const seenKinds = new Set();

for (const fixture of fixtures) {
  const source = fixture.source;
  const actual = blocks(toText(source));
  const actualTriples = actual.map((block) => [block.kind, block.depth, sliceOf(source, block)]);
  const expectedTriples = fixture.expect;

  const problems = [];
  if (JSON.stringify(actualTriples) !== JSON.stringify(expectedTriples)) {
    problems.push(`结构  期望 ${fixture.expect.length} 块：${JSON.stringify(expectedTriples)}`);
    problems.push(`结构  实际 ${actualTriples.length} 块：${JSON.stringify(actualTriples)}`);
  }
  for (const problem of invariantProblems(source, actual)) problems.push(`不变量  ${problem}`);

  check(fixture.name, problems.length === 0, problems.join("\n        "));

  for (const block of actual) seenKinds.add(block.kind);
  if (verbose) {
    for (const block of actual) console.log(`        · ${describeBlock(source, block)}`);
  }
}

section("夹具：块类型覆盖");

const missingKinds = [...KINDS].filter((kind) => !seenKinds.has(kind));
check(
  `八种块类型均出现在夹具中（已见 ${seenKinds.size}/8）`,
  missingKinds.length === 0,
  `缺 ${missingKinds.join("、")}`,
);

// ------------------------------------------------------------------ real files
function collectMarkdown(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(absolute, found);
    else if (entry.name.toLowerCase().endsWith(".md")) found.push(absolute);
  }
  return found;
}

const defaultSources = [];
for (const dirName of ["examples", "docs"]) {
  const dir = path.join(root, dirName);
  if (fs.existsSync(dir)) defaultSources.push(...collectMarkdown(dir));
}

const qnpFiles = fs
  .readdirSync(path.join(root, "examples"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".qnp"))
  .map((entry) => path.join(root, "examples", entry.name));

const sources = explicitPaths.length > 0
  ? explicitPaths.flatMap((value) => {
      const absolute = path.resolve(root, value);
      if (!fs.existsSync(absolute)) {
        console.log(`  SKIP  ${value}（不存在）`);
        return [];
      }
      return fs.statSync(absolute).isDirectory() ? collectMarkdown(absolute) : [absolute];
    })
  : defaultSources;

section(`真实文档：${sources.length} 个 .md`);

let totalBlocks = 0;
const histogram = new Map();
const fileFailures = [];

for (const absolute of sources) {
  const source = fs.readFileSync(absolute, "utf8");
  // BOM and CRLF must not shift the offsets we print.
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const list = blocks(toText(normalized));
  totalBlocks += list.length;
  for (const block of list) histogram.set(block.kind, (histogram.get(block.kind) ?? 0) + 1);

  const label = displayPath(absolute);
  const problems = invariantProblems(normalized, list);
  if (problems.length > 0) fileFailures.push({ label, problems });

  const first = list[0];
  const last = list[list.length - 1];
  const summary =
    `  ${label.padEnd(44)} ${String(list.length).padStart(3)} 块` +
    (first ? `  首 ${describeBlock(normalized, first)}` : "  （无块）") +
    (last && last !== first ? `  末 ${describeBlock(normalized, last)}` : "");
  console.log(problems.length === 0 ? summary : `  FAIL ${summary.trimStart()}`);

  if (verbose) {
    for (const block of list) console.log(`      ${describeBlock(normalized, block)}`);
  }
}

for (const { label, problems } of fileFailures) {
  check(`${label}：不变量`, false, problems.slice(0, 4).join("\n        "));
}

section("真实文档：汇总");

console.log(
  `  文件 ${sources.length} 个 · 块 ${totalBlocks} 个 · 平均 ${(totalBlocks / Math.max(sources.length, 1)).toFixed(1)} 块/文件`,
);
console.log(
  `  类型分布 ${[...histogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`)
    .join(" · ")}`,
);
check(`样例文件数 ≥ 10`, sources.length >= 10, `实际 ${sources.length}`);
check(
  `${sources.length} 个真实文档的边界 / 顺序 / 确定性 / blockAt 不变量`,
  fileFailures.length === 0,
  `${fileFailures.length} 个文件有问题`,
);

section("examples/*.qnp：非 Markdown 容器");
console.log(
  `  ${qnpFiles.length} 个 .qnp（插件包，内含 dist/extension.js + package.json），无 Markdown 内容，已跳过：` +
    qnpFiles.map((file) => path.basename(file)).join("、"),
);

// ------------------------------------------------------------------ summary
section("结果");
console.log(`  ${checks} 项检查 · ${failures} 项失败 · ${sources.length + fixtures.length} 个文档`);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) process.exitCode = 1;
