/**
 * Headless verification for the graph scan layer (T02/T03).
 *
 * Bundles the real TypeScript modules with esbuild and drives them against
 * hand-written fixtures. No Tauri IPC, no filesystem, no GUI: `linkScanner`,
 * `linkResolver`, `noteSourceAdapter` and `ids` are all pure, so everything the
 * design document claims about them is checkable here.
 *
 *   node scripts/verify-graph-scan.mjs
 *
 * Sections map 1:1 onto the document: §3.3.1 (six syntaxes), §3.3.2 (seven
 * normalisation steps), §3.3.3 (four disambiguation levels), §3.3.4 (masking),
 * §3.2.1 (id shapes), §3.4.3 (contentHash).
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-verify-"));
const outfile = path.join(tmpDir, "graph.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: [
      'export * as scanner from "./src/utils/graph/linkScanner.ts";',
      'export * as resolver from "./src/utils/graph/linkResolver.ts";',
      'export * as adapter from "./src/utils/graph/noteSourceAdapter.ts";',
      'export * as ids from "./src/utils/graph/ids.ts";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "graph-verify-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent",
  alias: { "@": path.join(root, "src") },
});
await esbuild.stop?.();

const { scanner, resolver, adapter, ids } = await import(pathToFileURL(outfile).href);

const NOTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const VAULT_KEY = "aabbccdd";

// ------------------------------------------------------------------ fixtures
function vaultNode(relPath, overrides = {}) {
  const parts = relPath.split("/");
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  const filename = parts[parts.length - 1];
  const title = filename.replace(/\.(md|markdown|txt)$/i, "");
  return {
    id: ids.vaultNodeId(VAULT_KEY, relPath),
    kind: "vault",
    refId: relPath,
    vaultKey: VAULT_KEY,
    title,
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

function nativeNode(noteId, title, overrides = {}) {
  return {
    id: ids.nativeNodeId(noteId),
    kind: "native",
    refId: noteId,
    vaultKey: null,
    title,
    path: null,
    dir: null,
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

/** 造一条 ParsedLink：只给 resolver 用，行号列号无所谓。 */
function link(rawTarget, overrides = {}) {
  return {
    kind: "wiki",
    raw: `[[${rawTarget}]]`,
    rawTarget,
    alias: null,
    anchor: null,
    line: 1,
    column: 1,
    offset: 0,
    ...overrides,
  };
}

const scanOne = (text, options) => scanner.scanLinks(text, options);
const targetsOf = (links) => links.map((item) => item.rawTarget);

// ============================================================ [1] 三种正文形态
section("[1] 正文形态（§3.2.1 模块 4 / T03 验收）");

// v2 标题链让 frontmatter 的 `aliases` 优先于 H1，所以这个 fixture 把
// `[[不该成为边]]` 放到一个**与标题无关**的键（`related`）上：本节要证明的是
// "frontmatter 里的 `[[…]]` 不产生链接"，不该顺带改变标题来源。
// （`related` 与 `aliases` 同为 7 个字符，下面那条第 142 行的长度断言不受影响。）
const mdSource = adapter.adaptNoteSource({
  content: "---\ntags: [a]\nrelated: [[不该成为边]]\n---\n# 会议纪要\n正文 [[目标]]\n",
  relPath: "项目/会议纪要.md",
});
check("md 判定为 markdown", mdSource.kind === "markdown", mdSource.kind);
check("md 可解析链接", mdSource.linksParsable === true);
check("md 抽出首个 H1 作为标题候选（frontmatter 无标题键）", mdSource.titleCandidate === "会议纪要", mdSource.titleCandidate);
check("frontmatter 被清空但长度不变", mdSource.body.length === "---\ntags: [a]\nrelated: [[不该成为边]]\n---\n# 会议纪要\n正文 [[目标]]\n".length);
check(
  "frontmatter 里的 [[…]] 不产生链接",
  scanOne(mdSource.body, { dir: "项目" }).every((item) => item.rawTarget === "目标"),
  targetsOf(scanOne(mdSource.body)),
);
check("frontmatter 清空后行号不偏移（正文链接仍在第 6 行）", (() => {
  const links = scanOne(mdSource.body, { dir: "项目" });
  return links.length === 1 && links[0].line === 6;
})(), scanOne(mdSource.body, { dir: "项目" }).map((item) => item.line));

const htmlContent = "<p>导入的一行</p><p>[[目标]]</p><h1>旧版标题</h1>";
const htmlSource = adapter.adaptNoteSource({ content: htmlContent });
check("TipTap HTML 判定为 html", htmlSource.kind === "html", htmlSource.kind);
check("HTML 转成 Markdown 后仍能扫到 wiki 链接", scanOne(htmlSource.body).length === 1, targetsOf(scanOne(htmlSource.body)));
check("HTML 里的 <h1> 成为标题候选", htmlSource.titleCandidate === "旧版标题", htmlSource.titleCandidate);
check("HTML 每个 <p> 之间多一个空行（turndown 的段落间隔，行号按转换后正文计）", (() => {
  const links = scanOne(htmlSource.body);
  return links.length === 1 && links[0].line === 3;
})(), scanOne(htmlSource.body).map((item) => item.line));
check(
  "HTML 正文的行数与原文不同（已知限制：html 节点的行号只用于展示）",
  htmlSource.body.split("\n").length !== htmlContent.split("\n").length,
  [htmlSource.body.split("\n").length, htmlContent.split("\n").length],
);

const txtSource = adapter.adaptNoteSource({
  content: "随手记\n[[这不是链接]]\n[也不是](x.md)\n",
  relPath: "随手记.txt",
});
check("txt 判定为 text", txtSource.kind === "text", txtSource.kind);
check("txt 不解析链接", txtSource.linksParsable === false);
check("txt 正文扫描结果为空", scanOne(txtSource.body, { linksParsable: false }).length === 0);
// v2 标题链：`.txt` 也走 frontmatter → H2–H6 → 正文首行 → 文件名。
// 旧断言是"txt 恒不给候选（标题回退到文件名）"——那正是导入的纯文本笔记在画布上
// 显示文件名的原因，功能改版后必须跟着改，而不是为了过测试把候选链退回去。
check(
  "txt 用正文首行作为标题候选（v2 标题链，不再是恒 null）",
  txtSource.titleCandidate === "随手记",
  txtSource.titleCandidate,
);
check("txt 的候选来源标记为 text-line", txtSource.titleSource === "text-line", txtSource.titleSource);

const codeNote = adapter.adaptNoteSource({ content: "# 标题\n<h1>不该再抽一次</h1>\n[[x]]\n", relPath: "a.md" });
check("md 的标题只取 H1，不取正文里的 <h1>", codeNote.titleCandidate === "标题", codeNote.titleCandidate);

const fencedHeading = adapter.adaptNoteSource({
  content: "```\n# 代码里的井号\n```\n# 真标题\n",
  relPath: "b.md",
});
check("围栏代码块里的 # 不算标题", fencedHeading.titleCandidate === "真标题", fencedHeading.titleCandidate);

// ============================================================ [2] 等长屏蔽
section("[2] 屏蔽（§3.3.4）");

const fenceText = "前\n```\n[[代码里]]\n```\n[[真的]]\n";
const fenceLinks = scanOne(fenceText);
check("围栏代码块内不产生链接", fenceLinks.length === 1, targetsOf(fenceLinks));
check("围栏块之后的链接行号正确", fenceLinks[0]?.line === 5, fenceLinks[0]?.line);
check(
  "屏蔽不改长度（偏移可直接用）",
  scanner.maskVerbatim(fenceText).length === fenceText.length,
);
check(
  "屏蔽保留换行数量",
  (scanner.maskVerbatim(fenceText).match(/\n/g) ?? []).length === (fenceText.match(/\n/g) ?? []).length,
);
check("屏蔽位置在原文偏移上（偏移指向 [[真的]]）", fenceText.slice(fenceLinks[0].offset, fenceLinks[0].offset + 2) === "[[", fenceLinks[0].offset);

const unclosedFence = "```\n[[全被吃掉]]\n还是代码\n";
check("未闭合围栏屏蔽到文末", scanOne(unclosedFence).length === 0, targetsOf(scanOne(unclosedFence)));

const tildeFence = "~~~md\n[[也不该有]]\n~~~\n[[有]]\n";
check("~~~ 围栏同样屏蔽", targetsOf(scanOne(tildeFence)).join(",") === "有", targetsOf(scanOne(tildeFence)));

const inlineCode = "讲 `[[行内]]` 与 ``[[双反引号]]`` 以及 [[真]]\n";
check("行内代码屏蔽单反引号", targetsOf(scanOne(inlineCode)).includes("真"));
check("行内代码屏蔽双反引号", !targetsOf(scanOne(inlineCode)).includes("双反引号"), targetsOf(scanOne(inlineCode)));
check("行内代码之外仍然解析", scanOne(inlineCode).length === 1, targetsOf(scanOne(inlineCode)));

const htmlComment = "<!-- [[注释里]] -->\n[[外面]]\n";
check("HTML 注释屏蔽", targetsOf(scanOne(htmlComment)).join(",") === "外面", targetsOf(scanOne(htmlComment)));

const preBlock = "<pre>\n[[pre 里]]\n</pre>\n<code>[[code 里]]</code>\n[[外面]]\n";
check("<pre> 段屏蔽", !targetsOf(scanOne(preBlock)).includes("pre 里"), targetsOf(scanOne(preBlock)));
check("<code> 段屏蔽", !targetsOf(scanOne(preBlock)).includes("code 里"), targetsOf(scanOne(preBlock)));
check("<pre>/<code> 之外仍然解析", targetsOf(scanOne(preBlock)).join(",") === "外面", targetsOf(scanOne(preBlock)));

const unclosedComment = "<!-- [[永远]]\n[[也不该有]]\n";
check("未闭合 HTML 注释屏蔽到文末", scanOne(unclosedComment).length === 0, targetsOf(scanOne(unclosedComment)));

const unclosedBacktick = "先说 ` 然后 [[真]]\n";
check("未闭合反引号按普通文本处理，不影响后面的链接", targetsOf(scanOne(unclosedBacktick)).join(",") === "真", targetsOf(scanOne(unclosedBacktick)));

// ============================================================ [3] 六种语法
section("[3] 六种语法（§3.3.1）");

const plainWiki = scanOne("[[目标]]\n");
check("① [[目标]] → wiki 边", plainWiki.length === 1 && plainWiki[0].kind === "wiki", plainWiki[0]);

const aliasWiki = scanOne("[[目标|别名显示]]\n");
check("② 别名单独记录", aliasWiki[0]?.alias === "别名显示", aliasWiki[0]?.alias);
check("② 别名的存在不改变 rawTarget", aliasWiki[0]?.rawTarget === "目标", aliasWiki[0]?.rawTarget);
check("② raw 保留整段原文", aliasWiki[0]?.raw === "[[目标|别名显示]]", aliasWiki[0]?.raw);

const anchorWiki = scanOne("[[目标#某小节]]\n");
check("③ 锚点单独记录", anchorWiki[0]?.anchor === "某小节", anchorWiki[0]?.anchor);
check("③ 锚点不进入 rawTarget", anchorWiki[0]?.rawTarget === "目标", anchorWiki[0]?.rawTarget);

const selfRef = scanner.scanNoteLinks("[[#只有锚点]]\n[[目标]]\n");
check("③ [[#锚点]] 不建边", selfRef.links.length === 1, targetsOf(selfRef.links));
check("③ 自引用被计数", selfRef.stats.selfReferences === 1, selfRef.stats.selfReferences);

const embedImage = scanner.scanNoteLinks("![[图.png]]\n![[文档.pdf]]\n![[笔记]]\n");
check("④ 图片嵌入不建边", !targetsOf(embedImage.links).includes("图.png"), targetsOf(embedImage.links));
check("④ PDF 嵌入不建边", !targetsOf(embedImage.links).includes("文档.pdf"), targetsOf(embedImage.links));
check("④ 非笔记嵌入被计数", embedImage.stats.nonNoteEmbeds === 2, embedImage.stats.nonNoteEmbeds);
check("④ md 嵌入建立 embed 边", embedImage.links.length === 1 && embedImage.links[0].kind === "embed", embedImage.links[0]);

const mdLink = scanOne("[文字](项目/会议纪要.md)\n", { dir: "" });
check("⑤ [文字](相对路径.md) → markdown 边", mdLink.length === 1 && mdLink[0].kind === "markdown", mdLink[0]);
check("⑤ 目标去掉尖括号/标题后取得", scanOne('[x](a.md "标题")').length === 1, scanOne('[x](a.md "标题")'));
check("⑤ markdown 目标支持 txt", scanOne("[x](随手记.txt)").length === 1);
check("⑤ 非 md/txt 目标不建边", scanOne("[x](图.png)").length === 0);

const external = scanner.scanNoteLinks("[外链](https://example.com/a.md)\n[邮件](mailto:a@b.c)\n");
check("⑥ 外链不建边", external.links.length === 0, external.links);
check("⑥ 外链被计数", external.stats.externalLinks === 2, external.stats.externalLinks);

const escapeLink = scanOne("[越界](../../外面.md)", { dir: "项目" });
check("⑤ 解析后越出 vault 的相对路径不建边", escapeLink.length === 0, escapeLink);
const insideLink = scanOne("[上一级](../../笔记.md)", { dir: "a/b" });
check("⑤ 仍在 vault 内的 ../ 正常建边", insideLink.length === 1, insideLink);

const imageMd = scanner.scanNoteLinks("![](图.png)\n");
check("![](…) 图片嵌入不建边并计数", imageMd.links.length === 0 && imageMd.stats.nonNoteEmbeds === 1, imageMd.stats);

const inPageAnchor = scanOne("[跳转](#某节)\n");
check("同页 # 锚点不建边", inPageAnchor.length === 0, inPageAnchor);

const ordering = scanOne("[[一]]\n中间\n[[二]]\n");
check("结果按出现顺序（offset 升序）", ordering.map((item) => item.offset).every((value, index, all) => index === 0 || all[index - 1] < value));

// ============================================================ [4] 归一化七步
section("[4] 归一化（§3.3.2 七步）");

const n = resolver.normalizeTarget;
check("① NFKC：全角括号折叠", n("卡片（一）") === "卡片(一)", n("卡片（一）"));
check("① NFKC：全角字母折叠", n("ＲＥＡＤＭＥ") === "readme", n("ＲＥＡＤＭＥ"));
check("② 反斜杠统一为 /", n("项目\\会议") === "项目/会议", n("项目\\会议"));
check("③ URL 解码：%20 → 空格", n("a%20b") === "a b", n("a%20b"));
check("③ URL 解码：中文百分号编码", n("%E4%B8%AD%E6%96%87") === "中文", n("%E4%B8%AD%E6%96%87"));
check("③ 非法百分号编码保留原串（不抛错）", n("100%zz") === "100%zz", n("100%zz"));
check("④ 大小写折叠", n("ReadMe") === "readme", n("ReadMe"));
check("⑤ 全角空格当普通空格", n("笔记\u3000（一）") === "笔记 (一)", n("笔记\u3000（一）"));
check("⑤ 连续空白折叠 + 首尾 trim", n("  笔  记  ") === "笔 记", n("  笔 记  "));
check("⑥ 去扩展名 .md", n("笔记.md") === "笔记", n("笔记.md"));
check("⑥ 去扩展名 .markdown / .txt", n("a.markdown") === "a" && n("b.txt") === "b");
check("⑥ 非笔记扩展名不被去掉", n("图.png") === "图.png", n("图.png"));
check("⑦ 不做简繁转换（乾 ≠ 干）", n("干") !== n("乾"), [n("干"), n("乾")]);
check("⑦ 不做拼音近似（huiyi ≠ 会议）", n("huiyi") !== n("会议"));

// ============================================================ [5] 四级消歧
section("[5] 四级消歧（§3.3.3）");

const nodes = [
  vaultNode("项目/会议纪要.md", { title: "会议纪要" }),
  vaultNode("项目/来源.md"),
  vaultNode("读书/卡片（一）.md", { title: "卡片一" }),
  vaultNode("a/笔记.md"),
  vaultNode("b/笔记.md", { title: "B 的笔记" }),
  vaultNode("b/唯一.md"),
  vaultNode("项目/2024-01-05.md", { title: "周报标题" }),
  vaultNode("根目录笔记.md"),
  nativeNode("11111111-2222-3333-4444-555555555555", "原生笔记"),
];
const table = resolver.buildCandidateTable(nodes);
const byPath = (relPath) => nodes.find((node) => node.path === relPath);
const fromSource = byPath("项目/来源.md");

// 1a 根相对
const rootRelative = resolver.resolveLink({ link: link("/读书/卡片（一）"), from: fromSource, table });
check(
  "1a 根相对路径命中",
  rootRelative.status === "resolved" && rootRelative.nodeId === byPath("读书/卡片（一）.md").id,
  rootRelative,
);

// 1b 相对 from.dir
const relative = resolver.resolveLink({ link: link("会议纪要"), from: fromSource, table });
check(
  "2 同目录同名命中（不是全局同名）",
  relative.status === "resolved" && relative.nodeId === byPath("项目/会议纪要.md").id,
  relative,
);

const parentRelative = resolver.resolveLink({ link: link("../读书/卡片（一）"), from: fromSource, table });
check(
  "1b ../ 规范化后命中",
  parentRelative.status === "resolved" && parentRelative.nodeId === byPath("读书/卡片（一）.md").id,
  parentRelative,
);

// 1b 是"相对来源目录"，不是"相对 vault 根"：跨目录路径必须带前导 `/`（1a）
// 或写对 `../`。这条按 §3.3.3 原文实现，命中不了就是断链，不猜。
const crossDirWithoutSlash = resolver.resolveLink({
  link: link("读书/卡片（一）"),
  from: byPath("项目/来源.md"),
  table,
});
check(
  "1b 严格相对来源目录（不带前导 / 的跨目录路径不按根解析）",
  crossDirWithoutSlash.status === "missing",
  crossDirWithoutSlash,
);

const rootRelativeForm = resolver.resolveLink({
  link: link("/读书/卡片（一）"),
  from: byPath("项目/来源.md"),
  table,
});
check(
  "1a 前导 / 才是 vault 根相对",
  rootRelativeForm.status === "resolved" && rootRelativeForm.nodeId === byPath("读书/卡片（一）.md").id,
  rootRelativeForm,
);

// 来源在根目录时 1b 恰好等于根相对 —— 这也是 Obsidian 用户最常见的布局。
const fromRoot = resolver.resolveLink({
  link: link("读书/卡片（一）"),
  from: byPath("根目录笔记.md"),
  table,
});
check(
  "1b 来源在根目录时等同根相对路径",
  fromRoot.status === "resolved" && fromRoot.nodeId === byPath("读书/卡片（一）.md").id,
  fromRoot,
);

const escape = resolver.resolveLink({ link: link("../../外面"), from: byPath("项目/来源.md"), table });
check("1b 越界即失败（落到 missing）", escape.status === "missing", escape);

// 2 同目录同名：a/笔记.md 与 b/笔记.md 不互相打断
const sameDir = resolver.resolveLink({ link: link("笔记"), from: byPath("a/笔记.md"), table });
check(
  "2 同目录优先，避免同名互相打断",
  sameDir.status === "resolved" && sameDir.nodeId === byPath("a/笔记.md").id,
  sameDir,
);

// 3 全局唯一文件名（from 是原生笔记，没有 dir）
const globalUnique = resolver.resolveLink({
  link: link("唯一"),
  from: nativeNode("99999999-2222-3333-4444-555555555555", "另一个原生笔记"),
  table,
});
check(
  "3 全局唯一文件名命中",
  globalUnique.status === "resolved" && globalUnique.nodeId === byPath("b/唯一.md").id,
  globalUnique,
);

// 4 全局唯一标题
const titleHit = resolver.resolveLink({
  link: link("周报标题"),
  from: nativeNode("99999999-2222-3333-4444-555555555555", "另一个原生笔记"),
  table,
});
check(
  "4 全局唯一标题命中",
  titleHit.status === "resolved" && titleHit.nodeId === byPath("项目/2024-01-05.md").id,
  titleHit,
);

// 5 歧义
const ambiguous = resolver.resolveLink({
  link: link("笔记"),
  from: nativeNode("99999999-2222-3333-4444-555555555555", "另一个原生笔记"),
  table,
});
check("5 同名多篇 → ambiguous（不猜）", ambiguous.status === "ambiguous", ambiguous);
check("5 candidateCount 正确", ambiguous.candidateCount === 2, ambiguous.candidateCount);
check("5 候选 id 列表完整", Array.isArray(ambiguous.candidates) && ambiguous.candidates.length === 2, ambiguous.candidates);
check(
  "5 候选指向两个不同的 b/笔记.md 与 a/笔记.md",
  ambiguous.candidates.includes(byPath("a/笔记.md").id) && ambiguous.candidates.includes(byPath("b/笔记.md").id),
  ambiguous.candidates,
);

// 6 missing
const missing = resolver.resolveLink({ link: link("根本不存在的笔记"), from: fromSource, table });
check("6 全空 → missing", missing.status === "missing", missing);
check("6 missing 的 candidateCount 是 0", missing.candidateCount === 0);

// alias 不影响消歧
const aliasHit = resolver.resolveLink({ link: link("唯一", { alias: "随便写的别名" }), from: fromSource, table });
check(
  "别名不参与消歧",
  aliasHit.status === "resolved" && aliasHit.nodeId === byPath("b/唯一.md").id,
  aliasHit,
);

// 扩展名不影响消歧
const withExtension = resolver.resolveLink({ link: link("唯一.md"), from: fromSource, table });
check("[[唯一.md]] 与 [[唯一]] 等价", withExtension.status === "resolved", withExtension);

// 悬空节点 id
const danglingIdA = ids.danglingNodeId(n("不存在的笔记"));
const danglingIdB = ids.danglingNodeId(n("不存在的笔记.md"));
check("悬空 id 对归一化后的同一目标稳定", danglingIdA === danglingIdB, [danglingIdA, danglingIdB]);
check("不同目标得到不同悬空 id", danglingIdA !== ids.danglingNodeId(n("另一个")), danglingIdA);

// 大小写/全角在消歧里也生效
const caseTable = resolver.buildCandidateTable([vaultNode("项目/ReadMe.md")]);
const caseHit = resolver.resolveLink({ link: link("readme"), from: null, table: caseTable });
check("大小写不同的文件名能命中", caseHit.status === "resolved", caseHit);
const fullWidthHit = resolver.resolveLink({ link: link("ＲＥＡＤＭＥ"), from: null, table: caseTable });
check("全角字母也能命中", fullWidthHit.status === "resolved", fullWidthHit);

// ============================================================ [6] id 与 hash
section("[6] id 与 contentHash（§3.2.1 / §3.4.3）");

const vaultId = ids.vaultNodeId(VAULT_KEY, "项目/会议纪要.md");
check("vault id 形如 v-<8hex>-<16hex>", /^v-[0-9a-f]{8}-[0-9a-f]{16}$/.test(vaultId), vaultId);
check("vault id 长度 27", vaultId.length === 27, vaultId.length);
check("vault id 通过 NOTE_ID_PATTERN", NOTE_ID_PATTERN.test(vaultId), vaultId);
check("vault id 同步稳定", ids.vaultNodeId(VAULT_KEY, "项目/会议纪要.md") === vaultId);
check("不同路径不同 id", ids.vaultNodeId(VAULT_KEY, "a.md") !== ids.vaultNodeId(VAULT_KEY, "b.md"));
check("不同 vault 不同 id", ids.vaultNodeId("11112222", "a.md") !== ids.vaultNodeId("33334444", "a.md"));

const danglingId = ids.danglingNodeId("不存在");
check("dangling id 形如 d-<16hex>", /^d-[0-9a-f]{16}$/.test(danglingId), danglingId);
check("dangling id 通过 NOTE_ID_PATTERN", NOTE_ID_PATTERN.test(danglingId));

const nativeId = ids.nativeNodeId("11111111-2222-3333-4444-555555555555");
check("native id 形如 n-<uuid>", nativeId === "n-11111111-2222-3333-4444-555555555555", nativeId);

check("FNV-1a 已知向量（空串）", ids.fnv1a64Hex("") === "cbf29ce484222325", ids.fnv1a64Hex(""));
check("FNV-1a 已知向量（a）", ids.fnv1a64Hex("a") === "af63dc4c8601ec8c", ids.fnv1a64Hex("a"));

const hashA = ids.contentHashOf("内容相同");
check("contentHash 对同一内容稳定", hashA === ids.contentHashOf("内容相同"));
check("contentHash 对不同内容不同", hashA !== ids.contentHashOf("内容不同"));
const longBase = "A".repeat(600);
check(
  "contentHash 只看前 512 字节（同长度、尾部不同 → 同 hash）",
  ids.contentHashOf(`${longBase}X`) === ids.contentHashOf(`${longBase}Y`),
);
check(
  "contentHash 长度不同则不同",
  ids.contentHashOf(`${longBase}X`) !== ids.contentHashOf(`${longBase}XY`),
);

// ============================================================ [7] 行号列号
section("[7] 行号与列号");

const positioned = scanOne("第一行\n第二行 [[目标|别名]]\n");
check("行号 1-based", positioned[0]?.line === 2, positioned[0]?.line);
check("列号 1-based 且指向 [[", positioned[0]?.column === 5, positioned[0]?.column);
check(
  "偏移能切回原文",
  "第一行\n第二行 [[目标|别名]]\n".slice(positioned[0].offset, positioned[0].offset + 2) === "[[",
);
check("raw 保留原样", positioned[0]?.raw === "[[目标|别名]]", positioned[0]?.raw);

// ------------------------------------------------------------------ summary
fs.rmSync(tmpDir, { recursive: true, force: true });

const summary = `${checks - failures}/${checks} checks passed`;
console.log(`\n${failures === 0 ? "ALL PASS" : "FAILED"} — ${summary}`);
process.exit(failures === 0 ? 0 : 1);
