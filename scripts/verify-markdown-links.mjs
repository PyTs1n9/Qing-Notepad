/**
 * Headless verification for Markdown link classification.
 *
 *   node scripts/verify-markdown-links.mjs
 *
 * What a click does cannot be checked here (it needs a webview: caret vs.
 * navigation, focus, scroll). What *can* be checked is the decision in front of
 * it: given a destination and a note list, which of the four kinds comes out, and
 * where an in-note anchor points. That decision is what the security posture
 * rests on — a `javascript:` destination that resolves to `external` would reach
 * `openUrl`.
 *
 * The sources are bundled with esbuild rather than imported directly because the
 * app uses `@/` path aliases and `.ts` extensions; the bundle is the same shape
 * `verify:live-preview` uses. Nothing here may touch Tauri: `markdownLinks.ts`
 * depends only on `noteOutline` → `markdownStats` and `smoothScroll`.
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
  console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
}

const section = (title) => console.log(`\n${title}`);

// ------------------------------------------------------------------ bundle
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-links-verify-"));
const outfile = path.join(tmpDir, "markdownLinks.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: [
      `export { resolveMarkdownLink, findHeadingPosition, looseLinkKey } from ${JSON.stringify(
        path.join(root, "src/utils/markdownLinks.ts"),
      ).replaceAll("\\", "/")};`,
      `export { LINK_SCHEMES, isExternalScheme, isSafeLinkHref, schemeOf } from ${JSON.stringify(
        path.join(root, "src/utils/linkScheme.ts"),
      ).replaceAll("\\", "/")};`,
      `export { EditorState } from "@codemirror/state";`,
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

const {
  resolveMarkdownLink,
  findHeadingPosition,
  looseLinkKey,
  LINK_SCHEMES,
  isExternalScheme,
  isSafeLinkHref,
  schemeOf,
  EditorState,
} = await import(pathToFileURL(outfile).href);

/** Compact, stable rendering of a target for failure messages. */
const show = (target) => JSON.stringify(target);

/** The notebook the resolver matches titles against. */
const notes = [
  { id: "n-other", title: "Other Note" },
  { id: "n-dup-1", title: "重复" },
  { id: "n-dup-2", title: "重复" },
  { id: "n-plan", title: "v1.2 计划" },
];

const classify = (href) => resolveMarkdownLink(href, notes);

function expectTarget(name, href, expected) {
  let actual;
  try {
    actual = classify(href);
  } catch (error) {
    check(name, false, `解析抛错 ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const detail =
    show(actual) === show(expected) ? undefined : [`期望 ${show(expected)}`, `实际 ${show(actual)}`].join("\n        ");
  check(`${name}  →  ${show(expected)}`, detail === undefined, detail);
}

// ------------------------------------------------------------------ external
section("外部链接：只放行 http / https / mailto / tel");

expectTarget("http(s) 带锚点整段保留", "https://a.com/x#frag", { kind: "external", url: "https://a.com/x#frag" });
expectTarget("http 无路径", "http://x", { kind: "external", url: "http://x" });
expectTarget("mailto", "mailto:a@b.c", { kind: "external", url: "mailto:a@b.c" });
expectTarget("tel", "tel:+86100", { kind: "external", url: "tel:+86100" });
expectTarget("协议相对地址补成 https", "//host/x", { kind: "external", url: "https://host/x" });
// CommonMark allows `[x](<a b.md>)`; the angle brackets are markup, not the URL.
expectTarget("尖括号包裹的目的地址去掉括号", "<other note.md>", { kind: "note", noteId: "n-other" });

// ------------------------------------------------------------------ none
section("不可跳转：空、危险 scheme、本地文件、文件名");

for (const href of [
  "",
  "   ",
  "#",
  "javascript:alert(1)",
  "data:text/html,x",
  "file:///C:/x.md",
  "C:/x/y.md",
  "C:\\x\\y.md",
  "www.example.com",
  "report.pdf",
]) {
  expectTarget(`不跳 ${JSON.stringify(href)}`, href, { kind: "none" });
}

// A malformed percent escape must degrade to "no match", not throw.
{
  let threw = null;
  let actual = null;
  try {
    actual = classify("a%zzb.md");
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check(
    "坏转义 a%zzb.md 不抛错且不跳",
    threw === null && show(actual) === show({ kind: "none" }),
    threw === null ? `实际 ${show(actual)}` : `抛错 ${threw}`,
  );
}

// ------------------------------------------------------------------ anchor
section("文内锚点");

expectTarget("#快速开始", "#快速开始", { kind: "anchor", anchor: "快速开始" });
expectTarget(
  "百分号编码的锚点解码后匹配",
  "#%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B",
  { kind: "anchor", anchor: "快速开始" },
);

// ------------------------------------------------------------------ note
section("笔记链接：按标题匹配，不是文件名");

expectTarget("other note.md → Other Note", "other note.md", { kind: "note", noteId: "n-other" });
expectTarget("Other%20Note.md → Other Note", "Other%20Note.md", { kind: "note", noteId: "n-other" });
expectTarget(
  "子目录 + .markdown 扩展名仍按标题命中",
  "notes/other-note.markdown",
  { kind: "note", noteId: "n-other" },
);
expectTarget("标题带点号 v1.2 计划 能命中", "v1.2 计划.md", { kind: "note", noteId: "n-plan" });
expectTarget("同名两篇 → 不猜，不跳", "重复.md", { kind: "none" });
expectTarget("other.md 不等于标题 Other Note", "other.md", { kind: "none" });

// `other.md#小节` splits the hash off and switches notes; the hash is not part
// of the target type, so the type cannot promise a scroll the app will not do.
{
  const target = classify("other note.md#小节");
  check(
    "跨笔记锚点：仍切笔记，且类型上不带 anchor 字段",
    target.kind === "note" && target.noteId === "n-other" && !("anchor" in target),
    show(target),
  );
}

// ------------------------------------------------------------------ loose key
section("比较键：大小写 / 全半角 / 空格 / 连字符 / 标点");

{
  const keys = ["Hello-World", "hello world", "Ｈｅｌｌｏ　Ｗｏｒｌｄ", "HELLO_WORLD"].map(looseLinkKey);
  check(
    "Hello-World / hello world / 全角空格 同键",
    new Set(keys).size === 1 && keys[0] === "helloworld",
    JSON.stringify(keys),
  );
  const punctuated = [looseLinkKey("快速开始：准备"), looseLinkKey("快速开始准备")];
  check("中文冒号不影响匹配", new Set(punctuated).size === 1 && punctuated[0] === "快速开始准备", JSON.stringify(punctuated));
  check("空锚点得到空键", looseLinkKey("   ") === "", JSON.stringify(looseLinkKey("   ")));
}

// ------------------------------------------------------------------ headings
section("标题定位（findHeadingPosition）");

function headingPosition(doc, anchor) {
  return findHeadingPosition(EditorState.create({ doc }), anchor);
}

{
  const atx = "# 快速开始\n\n正文\n";
  check("ATX 标题命中首行", headingPosition(atx, "快速开始") === 0, String(headingPosition(atx, "快速开始")));

  const level2 = "前言\n\n## 二级 小节\n\n正文\n";
  const expected = level2.indexOf("## 二级 小节");
  check(
    "`#二级-小节` 命中「## 二级 小节」",
    headingPosition(level2, "二级-小节") === expected,
    `${headingPosition(level2, "二级-小节")} vs ${expected}`,
  );

  const fenced = "```\n# 代码里的井号\n```\n\n# 真的标题\n";
  check("围栏代码块内的井号不是标题", headingPosition(fenced, "代码里的井号") === null);
  check(
    "围栏代码块之后的标题仍命中",
    headingPosition(fenced, "真的标题") === fenced.indexOf("# 真的标题"),
    String(headingPosition(fenced, "真的标题")),
  );

  const setext = "标题甲\n===\n\n正文\n";
  check("Setext 标题命中标题文字所在行", headingPosition(setext, "标题甲") === 0, String(headingPosition(setext, "标题甲")));

  const frontMatter = "---\ntitle: x\n# 假标题\n---\n\n# 真标题\n";
  check("front matter 里的井号不是标题", headingPosition(frontMatter, "假标题") === null);
  check(
    "front matter 之后的标题仍命中",
    headingPosition(frontMatter, "真标题") === frontMatter.indexOf("# 真标题"),
    String(headingPosition(frontMatter, "真标题")),
  );

  check("文档里没有的锚点返回 null", headingPosition(atx, "不存在的小节") === null);
  check("空锚点返回 null", headingPosition(atx, "  ") === null);
}

// ------------------------------------------------------------------ schemes
section("scheme 单一真源（渲染器与点击解析共用）");

{
  const expectedSchemes = JSON.stringify([...LINK_SCHEMES].sort());
  check(
    "白名单就是 http/https/mailto/tel",
    expectedSchemes === JSON.stringify(["http", "https", "mailto", "tel"]),
    expectedSchemes,
  );
  check("schemeOf 小写化", schemeOf("HTTPS://A") === "https", schemeOf("HTTPS://A"));
  check("schemeOf 对相对地址返回空", schemeOf("other.md") === "" && schemeOf("#a") === "");
  check("isExternalScheme 认 tel", isExternalScheme("tel:+86100") === true);
  check("isExternalScheme 拒绝 javascript", isExternalScheme("javascript:alert(1)") === false);

  check("isSafeLinkHref 放行 https", isSafeLinkHref("https://a.com/x") === true);
  check("isSafeLinkHref 放行相对地址（交给点击解析）", isSafeLinkHref("other.md") === true);
  check("isSafeLinkHref 放行锚点", isSafeLinkHref("#小节") === true);
  check("isSafeLinkHref 放行协议相对地址", isSafeLinkHref("//host/x") === true);
  check("isSafeLinkHref 拒绝 javascript:", isSafeLinkHref("javascript:alert(1)") === false);
  check("isSafeLinkHref 拒绝 data:", isSafeLinkHref("data:text/html,x") === false);
  check("isSafeLinkHref 拒绝 file:", isSafeLinkHref("file:///C:/x.md") === false);
  check("isSafeLinkHref 拒绝空串", isSafeLinkHref("   ") === false);
}

// ------------------------------------------------------------------ summary
section("结果");
console.log(`  ${checks} 项检查 · ${failures} 项失败`);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) process.exitCode = 1;
