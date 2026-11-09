/**
 * Headless verification for the sidebar's global search.
 *
 *   node scripts/verify-sidebar-search.mjs
 *
 * `src/utils/noteSearch.ts` is pure data-in/data-out, so every case here is
 * "text in → hits out". This suite exists for two invariants that fail
 * **silently** — a wrong result still renders, and no type check can see it:
 *
 * 1. **片段高亮的偏移必须与显示文本一致.** The snippet window is cleaned before
 *    display (`**x**` → `x`, `[t](url)` → `t`, tags dropped), so ranges computed
 *    on the raw markdown point at characters cleaning already deleted. They are
 *    re-scanned on the cleaned text; one off-by-N paints the wrong characters.
 * 2. **查询是字面匹配，不是正则.** A user typing `(*.` or `[` must degrade to "no
 *    matches", never to a thrown exception inside a render path — and a note
 *    containing `axxb` must not match the query `a.*b`.
 *
 * The remaining cases pin behaviour the panel depends on: ranking (title hit
 * first), the 10-hit cap with an honest `totalMatched`, the cold-start `bodies`
 * fallback (notes carry no body until opened), and the `İ`-style length drift
 * that makes lower-cased offsets useless and forces a positional scan.
 *
 * Exit code 1 on any failure, so it can be wired into a gate.
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
const show = (value) => JSON.stringify(value);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-search-verify-"));
const outfile = path.join(tmpDir, "noteSearch.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: `export {
  buildSearchIndex,
  cleanSnippetText,
  countOccurrences,
  searchIndex,
  searchNotes,
  MAX_BODY_CHARS,
  MAX_COUNT,
  SNIPPET_WINDOW,
  NOTE_SEARCH_LIMIT,
} from "./src/utils/noteSearch.ts";`,
    resolveDir: root,
    loader: "ts",
    sourcefile: "noteSearch-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
  // `@/` alias, mirroring tsconfig paths.
  alias: { "@": path.join(root, "src") },
});

const {
  buildSearchIndex,
  cleanSnippetText,
  countOccurrences,
  searchIndex,
  searchNotes,
  MAX_BODY_CHARS,
  MAX_COUNT,
  SNIPPET_WINDOW,
  NOTE_SEARCH_LIMIT,
} = await import(pathToFileURL(outfile).href);

// ---------------------------------------------------------------- fixtures
/** Minimal `Note`; only `id/title/content/updatedAt` matter to the search. */
const note = (id, title, content, updatedAt = "2026-01-01T00:00:00.000Z") => ({
  id,
  title,
  content,
  tags: [],
  categoryId: null,
  order: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

const ids = (result) => result.hits.map((hit) => hit.noteId);
const slices = (text, ranges) => ranges.map((range) => text.slice(range.start, range.end));

/** Any throw becomes data, so a rejected query fails its check instead of the run. */
const safeSearch = (notes, query) => {
  try {
    return searchNotes(notes, query);
  } catch (error) {
    return { thrown: String(error && error.message ? error.message : error) };
  }
};

// ------------------------------------------------------------------ 排序
section("排序：标题命中优先 → 命中数降序 → updatedAt 降序 → id 升序");
const ranked = [
  note("n1", "alpha one", "", "2026-01-05T00:00:00.000Z"),
  note("n2", "beta", "alpha alpha alpha", "2026-01-03T00:00:00.000Z"),
  note("n3", "alpha two", "alpha alpha", "2026-01-02T00:00:00.000Z"),
  note("n4", "alpha dup", "", "2026-01-09T00:00:00.000Z"),
  note("n5", "alpha dup", "", "2026-01-01T00:00:00.000Z"),
];
const rankedResult = searchNotes(ranked, "alpha");
check("5 篇全部计入 totalMatched", rankedResult.totalMatched === 5, show(rankedResult.totalMatched));
check(
  "完整顺序 n3(标题+2处) > n4(较新) > n1(较旧) > n5(最旧) > n2(仅正文3处)",
  ids(rankedResult).join(",") === "n3,n4,n1,n5,n2",
  show(ids(rankedResult)),
);
const sameStamp = [
  note("zz", "alpha", ""),
  note("aa", "alpha", ""),
];
check(
  "同分数同时间回退 id 升序",
  ids(searchNotes(sameStamp, "alpha")).join(",") === "aa,zz",
  show(ids(searchNotes(sameStamp, "alpha"))),
);

// -------------------------------------------------------------- 空查询
section("空 / 纯空白查询");
for (const query of ["", "   ", "\n\t ", "\u3000"]) {
  const label = query === "" ? "(空串)" : JSON.stringify(query);
  const result = safeSearch(ranked, query);
  check(
    `${label} → {hits:[],totalMatched:0}`,
    !result.thrown && result.hits.length === 0 && result.totalMatched === 0,
    show(result),
  );
}

// -------------------------------------------------- 正则元字符按字面处理
section("正则元字符：不抛错、不误命中");
const literalFixture = [note("r1", "axxb", "axxb ab"), note("r2", "alpha", "alpha")];
for (const query of ["(*.", "[", "\\", "(?", "a.*b"]) {
  const result = safeSearch(literalFixture, query);
  check(
    `"${query}" 不抛错且零命中`,
    !result.thrown && result.totalMatched === 0,
    show(result),
  );
}
check(
  '"axxb" 作为字面量命中（若被当正则，"a.*b" 就会误命中它）',
  searchNotes(literalFixture, "axxb").totalMatched === 1,
  show(searchNotes(literalFixture, "axxb")),
);

// -------------------------------------------------------------- 大小写
section("大小写不敏感");
const upper = searchNotes(ranked, "ALPHA");
const lower = searchNotes(ranked, "alpha");
const mixed = searchNotes(ranked, "AlPhA");
check("ALPHA ≡ alpha ≡ AlPhA 数量一致", upper.totalMatched === lower.totalMatched && mixed.totalMatched === lower.totalMatched, show([upper.totalMatched, lower.totalMatched, mixed.totalMatched]));
check("ALPHA ≡ alpha 结果集一致", ids(upper).join(",") === ids(lower).join(","), show([ids(upper), ids(lower)]));

// ---------------------------------------------------------------- limit
section("limit 与 totalMatched");
const limited = searchNotes(ranked, "alpha", 2);
check("limit=2 → hits.length===2", limited.hits.length === 2, show(limited.hits.length));
check("totalMatched 不受 limit 影响（===5）", limited.totalMatched === 5, show(limited.totalMatched));

// ------------------------------------------------------- 片段偏移自洽
section("片段：高亮偏移与显示文本一致");
const markdownBody = [
  "Intro paragraph.",
  "",
  "## Heading",
  "",
  "Some **Alpha** text and `alpha` in code.",
  "",
  "[alpha link](https://example.com/alpha) tail.",
].join("\n");
const mdHit = searchIndex(buildSearchIndex([note("m1", "x", markdownBody)]), "alpha").hits[0];
check("正文命中产生片段", Boolean(mdHit && mdHit.snippet), show(mdHit && mdHit.snippet));
check("片段至少有一个高亮区间", Boolean(mdHit && mdHit.snippet && mdHit.snippet.ranges.length > 0), show(mdHit && mdHit.snippet && mdHit.snippet.ranges));
check(
  "每个 range 切出的子串 toLowerCase()===needle",
  Boolean(mdHit && mdHit.snippet) &&
    mdHit.snippet.ranges.every((range) => mdHit.snippet.text.slice(range.start, range.end).toLowerCase() === "alpha"),
  show(mdHit && mdHit.snippet && slices(mdHit.snippet.text, mdHit.snippet.ranges)),
);
check(
  "粗体/行内代码标记不进片段",
  Boolean(mdHit && mdHit.snippet) && !mdHit.snippet.text.includes("**") && !mdHit.snippet.text.includes("`"),
  show(mdHit && mdHit.snippet && mdHit.snippet.text),
);
check(
  "链接 URL 不进片段",
  Boolean(mdHit && mdHit.snippet) && !mdHit.snippet.text.includes("https://"),
  show(mdHit && mdHit.snippet && mdHit.snippet.text),
);

// --------------------------------------------------- 标题命中但正文无命中
section("标题命中、正文无命中 → snippet === null");
const titleOnly = searchIndex(buildSearchIndex([note("s1", "only title alpha", "nothing here")]), "alpha").hits[0];
check("titleMatched 为 true", Boolean(titleOnly && titleOnly.titleMatched), show(titleOnly));
check("snippet === null（不留空行）", Boolean(titleOnly) && titleOnly.snippet === null, show(titleOnly && titleOnly.snippet));

// -------------------------------------------------------- bodies 补读
section("冷启动：bodies 未补读时只匹配标题");
const cold = [note("c1", "cold", "")];
check("content 为空且无 bodies → 零命中", searchNotes(cold, "needle").totalMatched === 0, show(searchNotes(cold, "needle").totalMatched));
const warm = searchIndex(buildSearchIndex(cold, new Map([["c1", "a needle in the body"]])), "needle");
check("补读后正文命中 1 篇", warm.totalMatched === 1, show(warm.totalMatched));
check("补读后片段存在", Boolean(warm.hits[0] && warm.hits[0].snippet), show(warm.hits[0] && warm.hits[0].snippet));

// ------------------------------------------------------ countOccurrences
section("countOccurrences：非重叠且封顶");
check('"aaaa" 中 "aa" 记 2 次（非重叠）', countOccurrences("aaaa", "aa") === 2, show(countOccurrences("aaaa", "aa")));
check("空 needle 记 0", countOccurrences("abc", "") === 0);
check("空 haystack 记 0", countOccurrences("", "abc") === 0);
check(`超长命中封顶 MAX_COUNT(${MAX_COUNT})`, countOccurrences("x".repeat(5000), "x") === MAX_COUNT, show(countOccurrences("x".repeat(5000), "x")));

// ------------------------------------------------------ cleanSnippetText
section("cleanSnippetText：清洗但不误伤");
check("2*3 保持原样（单星号不动）", cleanSnippetText("2*3") === "2*3", show(cleanSnippetText("2*3")));
check("snake_case 保持原样（单下划线不动）", cleanSnippetText("snake_case") === "snake_case", show(cleanSnippetText("snake_case")));
check("**bold** 与反引号去标记留文字", cleanSnippetText("**bold** and `code`") === "bold and code", show(cleanSnippetText("**bold** and `code`")));
check("实体解码", cleanSnippetText("&amp;&lt;&gt;&quot;&nbsp;ok") === '&<>" ok', show(cleanSnippetText("&amp;&lt;&gt;&quot;&nbsp;ok")));
check("行首标记与围栏整行去掉", cleanSnippetText("## 标题\n- 列表\n> 引用\n```js\ncode\n```\n正文") === "标题 列表 引用 code 正文", show(cleanSnippetText("## 标题\n- 列表\n> 引用\n```js\ncode\n```\n正文")));

// -------------------------------------------------- İ 长度漂移退化扫描
section("İ：小写化改变长度时退化为位置扫描");
const dotted = note("t1", "İstanbul", "body İstanbul text");
const dottedDoc = buildSearchIndex([dotted]);
check("bodyLower 置 null", dottedDoc[0].bodyLower === null, show(dottedDoc[0].bodyLower));
const dottedHit = searchIndex(dottedDoc, "stanbul").hits[0];
check("退化路径仍命中 ASCII 片段", Boolean(dottedHit), show(dottedHit && dottedHit.noteId));
check(
  "标题偏移切片正确",
  Boolean(dottedHit) && slices(dottedHit.title, dottedHit.titleRanges).every((part) => part.toLowerCase() === "stanbul"),
  show(dottedHit && slices(dottedHit.title, dottedHit.titleRanges)),
);
check(
  "片段偏移切片正确",
  Boolean(dottedHit && dottedHit.snippet) &&
    dottedHit.snippet.ranges.every((range) => dottedHit.snippet.text.slice(range.start, range.end).toLowerCase() === "stanbul"),
  show(dottedHit && dottedHit.snippet && slices(dottedHit.snippet.text, dottedHit.snippet.ranges)),
);
// 组合附加符号（"İ".toLowerCase() = "i" + U+0307）会让切片长度比 needle 多一位，
// 这类查询不保证命中——只保证不抛错、不越界。
const decomposed = safeSearch([dotted], "i\u0307stanbul");
check("组合附加符号查询不抛错", !decomposed.thrown, show(decomposed.thrown));
check(
  "退化路径的 range 不越界",
  !decomposed.thrown &&
    decomposed.hits.every((hit) =>
      hit.titleRanges.every((range) => range.start >= 0 && range.end <= hit.title.length),
    ),
  show(decomposed.thrown),
);

// ---------------------------------------------------------- 长正文裁剪
section("长正文：首尾裁剪标记与窗口长度");
const longBody = `${"prefix ".repeat(60)}target ${"suffix ".repeat(60)}`;
const longHit = searchIndex(buildSearchIndex([note("l1", "long", longBody)]), "target").hits[0];
check("clippedHead / clippedTail 均为 true", Boolean(longHit && longHit.snippet) && longHit.snippet.clippedHead === true && longHit.snippet.clippedTail === true, show(longHit && longHit.snippet && [longHit.snippet.clippedHead, longHit.snippet.clippedTail]));
check(
  `片段长度 ≤ SNIPPET_WINDOW+10 (${SNIPPET_WINDOW + 10})`,
  Boolean(longHit && longHit.snippet) && longHit.snippet.text.length <= SNIPPET_WINDOW + 10,
  show(longHit && longHit.snippet && longHit.snippet.text.length),
);
check("窗口内只有 1 个命中", Boolean(longHit && longHit.snippet) && longHit.snippet.ranges.length === 1, show(longHit && longHit.snippet && longHit.snippet.ranges.length));

// ------------------------------------------------- 超出 MAX_BODY_CHARS
section("正文超过 MAX_BODY_CHARS 后截断");
const hugeBody = `${"x".repeat(MAX_BODY_CHARS + 1)}needle`;
check(
  "截断点之后的命中不被索引",
  searchNotes([note("h1", "huge", hugeBody)], "needle").totalMatched === 0,
  show(searchNotes([note("h1", "huge", hugeBody)], "needle").totalMatched),
);

// ------------------------------------------------------------- 中文用例
section("中文：命中数与偏移");
const cjkBody = "第一段提到笔记。\n\n## 二级标题\n\n这里再说一次笔记，还有 [笔记链接](https://example.com/x) 结尾。";
const cjkHit = searchIndex(buildSearchIndex([note("cjk", "关于笔记", cjkBody)]), "笔记").hits[0];
check("标题命中", Boolean(cjkHit && cjkHit.titleMatched), show(cjkHit && cjkHit.titleMatched));
check(
  "标题偏移切片为「笔记」",
  Boolean(cjkHit) && slices(cjkHit.title, cjkHit.titleRanges).every((part) => part === "笔记"),
  show(cjkHit && slices(cjkHit.title, cjkHit.titleRanges)),
);
check("命中数 = 标题 1 + 正文 3", Boolean(cjkHit) && cjkHit.matchCount === 4, show(cjkHit && cjkHit.matchCount));
check(
  "片段偏移切片为「笔记」",
  Boolean(cjkHit && cjkHit.snippet) &&
    cjkHit.snippet.ranges.length > 0 &&
    cjkHit.snippet.ranges.every((range) => cjkHit.snippet.text.slice(range.start, range.end) === "笔记"),
  show(cjkHit && cjkHit.snippet && slices(cjkHit.snippet.text, cjkHit.snippet.ranges)),
);

section("中文：limit 与 totalMatched");
const manyCjk = Array.from({ length: 30 }, (_, index) => note(`m${index}`, `笔记 ${index}`, "正文"));
const manyDefault = searchNotes(manyCjk, "笔记");
check(`默认上限 NOTE_SEARCH_LIMIT(${NOTE_SEARCH_LIMIT})`, manyDefault.hits.length === NOTE_SEARCH_LIMIT, show(manyDefault.hits.length));
check("limit=5 → hits.length===5", searchNotes(manyCjk, "笔记", 5).hits.length === 5, show(searchNotes(manyCjk, "笔记", 5).hits.length));
check("totalMatched===30", manyDefault.totalMatched === 30, show(manyDefault.totalMatched));

// ---------------------------------------------------------------------- 汇总
console.log(`\n${checks} checks, ${failures} failures`);
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // Leaving one temp dir behind must never turn a green run red.
}
if (failures > 0) {
  process.exitCode = 1;
}
