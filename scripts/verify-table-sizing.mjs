/**
 * Headless verification for table sizing (`docs/decisions-table-resize.md`).
 *
 *   node scripts/verify-table-sizing.mjs
 *
 * The drag gesture itself needs a real WebView (pointer events, hit testing,
 * feel), but everything under it is a pure function and is asserted here: the
 * comment format, the arithmetic that turns a pointer delta into column widths,
 * and the spec the state field builds from a document.
 *
 * The intermediate bundle goes into the git-ignored `test_temp/` at the repo
 * root (project rule: probes never land in the OS temp folder) and is removed on
 * the way out.
 */
import fs from "node:fs";
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ bundle
const tempDir = path.join(root, "test_temp");
fs.mkdirSync(tempDir, { recursive: true });
const outfile = path.join(tempDir, "table-sizing-verify.bundle.mjs");

const entry = [
  `export {
    MIN_COL_WIDTH,
    SIZING_PREFIX,
    formatSizing,
    looksLikeSizing,
    parseSizingColumns,
    findSizingComment,
    columnCount,
    normalizeSizing,
    totalOf,
    minTotal,
    clampTotal,
    resizeInner,
    scaleTo,
    insertSizingChange,
    removeSizingChange,
  } from ${JSON.stringify(path.join(root, "src/utils/livePreview/tableSizing.ts")).replaceAll("\\", "/")};`,
  `export { collectTableSpecs, tablePreview } from ${JSON.stringify(
    path.join(root, "src/utils/livePreview/tableField.ts"),
  ).replaceAll("\\", "/")};`,
  `export { withCols } from ${JSON.stringify(
    path.join(root, "src/utils/livePreview/tableWidget.ts"),
  ).replaceAll("\\", "/")};`,
  `export { EditorState } from "@codemirror/state";`,
  `export { ensureSyntaxTree } from "@codemirror/language";`,
  `export { markdown, markdownLanguage } from "@codemirror/lang-markdown";`,
].join("\n");

try {
  await esbuild.build({
    stdin: {
      contents: entry,
      resolveDir: root,
      loader: "ts",
      sourcefile: "verify-table-sizing-entry.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}

const api = await import(pathToFileURL(outfile).href);
const {
  MIN_COL_WIDTH,
  SIZING_PREFIX,
  formatSizing,
  looksLikeSizing,
  parseSizingColumns,
  findSizingComment,
  columnCount,
  normalizeSizing,
  totalOf,
  minTotal,
  clampTotal,
  resizeInner,
  scaleTo,
  insertSizingChange,
  removeSizingChange,
  collectTableSpecs,
  tablePreview,
  withCols,
  EditorState,
  ensureSyntaxTree,
  markdown,
  markdownLanguage,
} = api;

/** Same language the editor mounts (GFM base, no keymap). */
const language = markdown({ base: markdownLanguage, addKeymap: false });

const docState = (doc) => EditorState.create({ doc });

const tableState = (doc) => {
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
};

// ------------------------------------------------------------------ format / parse
section("注释格式与解析");

check(
  "formatSizing 精确输出",
  formatSizing([180, 220, 160]) === "<!-- qing-table:w=180,220,160 -->",
  formatSizing([180, 220, 160]),
);

check("SIZING_PREFIX 是注释前缀", SIZING_PREFIX === "<!-- qing-table:");

{
  const roundTrips = [[180, 220, 160], [48], [48, 48, 48, 48, 48]];
  const bad = roundTrips.filter(
    (cols) => !eq(parseSizingColumns(formatSizing(cols)), cols),
  );
  check("往返 3 组（含单列）深等", bad.length === 0, JSON.stringify(bad));
}

check(
  "解析容忍 `=` 与逗号周围空白",
  eq(parseSizingColumns("<!-- qing-table: w = 180 , 220 -->"), [180, 220]),
  JSON.stringify(parseSizingColumns("<!-- qing-table: w = 180 , 220 -->")),
);

{
  const rejected = [
    ["普通注释", "<!-- note -->"],
    ["无 w=", "<!-- qing-table:180,220 -->"],
    ["空 payload", "<!-- qing-table:w= -->"],
    ["负数", "<!-- qing-table:w=-180,220 -->"],
    ["小数", "<!-- qing-table:w=180.5,220 -->"],
    ["混字母", "<!-- qing-table:w=180px,220 -->"],
    ["零宽列", "<!-- qing-table:w=0,220 -->"],
  ];
  const accepted = rejected.filter(([, text]) => parseSizingColumns(text) !== null);
  check(
    `解析拒绝 ${rejected.length} 种非宽度写法`,
    accepted.length === 0,
    JSON.stringify(accepted),
  );
}

check(
  "looksLikeSizing：普通注释为 false，宽度注释为 true",
  looksLikeSizing("<!-- note -->") === false &&
    looksLikeSizing("<!-- qing-table:w=180 -->") === true,
);

// ------------------------------------------------------------------ columns / normalize
section("列数与归一化");

check("columnCount：表头 2 + 某行 3 → 3", columnCount([[], []], [[[], [], []], [[], []]]) === 3);

check("columnCount：数据行更少时以表头为准", columnCount([[], [], []], [[], []]) === 3);

{
  const kept = normalizeSizing([180, 220], 2);
  check("normalizeSizing：列数相符原样返回", eq(kept, [180, 220]), JSON.stringify(kept));
}

check("normalizeSizing：列数不符 → null", normalizeSizing([180, 220], 3) === null);

check("normalizeSizing：低于 48 的列 → null", normalizeSizing([10, 10], 2) === null);

check("normalizeSizing：总和不足列数×48 → null", normalizeSizing([48, 48], 3) === null);

check("normalizeSizing：null 输入 → null", normalizeSizing(null, 2) === null);

// ------------------------------------------------------------------ resizeInner
section("内边界拖拽：相邻两列转移宽度");

{
  const cols = [180, 220, 160];
  const moved = resizeInner(cols, 0, 50);
  check("+50：左列变宽、右列变窄", eq(moved, [230, 170, 160]), JSON.stringify(moved));
  check("+50：总和逐字不变", totalOf(moved) === totalOf(cols), `${totalOf(moved)} vs ${totalOf(cols)}`);

  const floorLeft = resizeInner(cols, 0, -1000);
  check("左触底：被拖列停在下限", floorLeft[0] === MIN_COL_WIDTH, JSON.stringify(floorLeft));
  check(
    "左触底：总和不变且相邻列补足",
    totalOf(floorLeft) === totalOf(cols) && floorLeft[1] === 352,
    JSON.stringify(floorLeft),
  );

  const floorRight = resizeInner(cols, 0, 1000);
  check("右触底：相邻列停在下限", floorRight[1] === MIN_COL_WIDTH, JSON.stringify(floorRight));
  check(
    "右触底：总和不变且被拖列补足",
    totalOf(floorRight) === totalOf(cols) && floorRight[0] === 352,
    JSON.stringify(floorRight),
  );

  check("越界边界索引：原样返回（只取整）", eq(resizeInner(cols, 5, 40), cols));
}

// ------------------------------------------------------------------ scaleTo
section("整表缩放：等比且不破下限");

{
  const cols = [180, 220, 160];
  const targets = [560, 500, 480, 300, 144];
  const wrongSum = targets.filter((target) => totalOf(scaleTo(cols, target)) !== target);
  check(
    "每个目标总宽都精确命中（sum === target）",
    wrongSum.length === 0,
    wrongSum.map((target) => `${target} → ${totalOf(scaleTo(cols, target))}`).join("；"),
  );

  const belowFloor = targets.filter((target) => scaleTo(cols, target).some((width) => width < MIN_COL_WIDTH));
  check("每列始终 ≥ 48", belowFloor.length === 0, JSON.stringify(belowFloor));

  const scaled = scaleTo(cols, 500);
  const ideal = cols.map((width) => (width * 500) / totalOf(cols));
  const worst = Math.max(...scaled.map((width, index) => Math.abs(width - ideal[index])));
  check("比例误差 ≤ 1px", worst <= 1, `worst=${worst.toFixed(3)} ${JSON.stringify(scaled)}`);

  check("压到下限：[180,220,160] → 144 得 [48,48,48]", eq(scaleTo(cols, 144), [48, 48, 48]), JSON.stringify(scaleTo(cols, 144)));

  const once = scaleTo(cols, 500);
  check("幂等：再缩放同一目标不再变化", eq(scaleTo(once, 500), once), JSON.stringify(scaleTo(once, 500)));

  check("单列表：目标即该列宽度", eq(scaleTo([180], 300), [300]), JSON.stringify(scaleTo([180], 300)));
}

// ------------------------------------------------------------------ clampTotal
section("整表上下限");

{
  const cols = [180, 220, 160];
  check("不放大：总和已在上限内原样返回", eq(clampTotal(cols, 560), [180, 220, 160]));
  const pressed = clampTotal(cols, 300);
  check("压到上限：总宽等于上限且每列 ≥48", totalOf(pressed) === 300 && pressed.every((w) => w >= MIN_COL_WIDTH), JSON.stringify(pressed));
  check("minTotal 与列数一致", minTotal(3) === 144 && minTotal(0) === 0);
}

// ------------------------------------------------------------------ findSizingComment
section("注释归属：只看表格首行的上一行");

{
  const comment = "<!-- qing-table:w=180,220 -->";
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";

  const tight = docState(`${comment}\n${table}`);
  const found = findSizingComment(tight, comment.length + 1);
  check(
    "紧贴表格：命中且区间是注释行（不含换行）",
    Boolean(found) &&
      found.from === 0 &&
      found.to === comment.length &&
      tight.doc.sliceString(found.from, found.to) === comment,
    JSON.stringify(found),
  );
  check("紧贴表格：解出列宽", eq(found?.cols, [180, 220]), JSON.stringify(found?.cols));

  const blank = docState(`${comment}\n\n${table}`);
  check("隔空行：null", findSizingComment(blank, comment.length + 2) === null);

  const firstLine = docState(table);
  check("文档首行（无上一行）：null", findSizingComment(firstLine, 0) === null);

  const paragraph = docState(`${comment}\n\n正文\n\n${table}`);
  check("注释后跟段落：null", findSizingComment(paragraph, paragraph.doc.length - table.length) === null);
}

// ------------------------------------------------------------------ changes
section("写入与删除注释");

{
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const bare = docState(`前言\n\n${table}`);
  const from = bare.doc.toString().indexOf("| a");
  const insert = insertSizingChange(bare, from, [180, 220]);
  check(
    "无注释：插在表格首行行首",
    insert.from === from && insert.to === from,
    JSON.stringify(insert),
  );
  check("无注释：插入文本末尾带换行", insert.insert.endsWith("\n"), JSON.stringify(insert.insert));
  check(
    "无注释：插入后在表格正上方形成注释行",
    insert.insert.slice(0, -1) === "<!-- qing-table:w=180,220 -->",
    JSON.stringify(insert.insert),
  );

  const comment = "<!-- qing-table:w=100,100 -->";
  const pinned = docState(`前言\n\n${comment}\n${table}`);
  const pinnedDoc = pinned.doc.toString();
  const pinnedFrom = pinnedDoc.indexOf("| a");
  const commentFrom = pinnedDoc.indexOf(comment);
  const replace = insertSizingChange(pinned, pinnedFrom, [180, 220]);
  check(
    "有注释：只替换注释行区间",
    replace.from === commentFrom &&
      replace.to === commentFrom + comment.length &&
      replace.insert === "<!-- qing-table:w=180,220 -->",
    JSON.stringify(replace),
  );

  const remove = removeSizingChange(pinned, pinnedFrom);
  check(
    "删除：区间含行尾换行",
    Boolean(remove) &&
      remove.from === commentFrom &&
      remove.to === commentFrom + comment.length + 1 &&
      pinned.doc.sliceString(remove.from, remove.to) === `${comment}\n`,
    JSON.stringify(remove),
  );

  check("删除：无注释时 null", removeSizingChange(bare, from) === null);
}

// ------------------------------------------------------------------ spec
section("StateField 规格：注释 → 宽度 → widget");

{
  const pinnedDoc = "<!-- qing-table:w=180,220 -->\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const pinnedState = tableState(pinnedDoc);
  const pinned = collectTableSpecs(pinnedState, true);
  check("注释 + 表格：产出 1 个 spec", pinned.length === 1, String(pinned.length));
  check("spec.sizing.cols === [180,220]", eq(pinned[0]?.sizing?.cols, [180, 220]), JSON.stringify(pinned[0]?.sizing));
  check("spec.data.cols === [180,220]", eq(pinned[0]?.data?.cols, [180, 220]), JSON.stringify(pinned[0]?.data?.cols));

  // A leading paragraph keeps the caret outside the table (offset 0 would sit
  // in the table's own block and reveal it as source).
  const bareDoc = "前言\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const bareState = tableState(bareDoc);
  const bare = collectTableSpecs(bareState, true);
  check("无注释：sizing 与 data.cols 均为 null", bare.length === 1 && bare[0].sizing === null && bare[0].data.cols === null, JSON.stringify({ count: bare.length, sizing: bare[0]?.sizing, cols: bare[0]?.data?.cols }));

  const keyA = collectTableSpecs(pinnedState, true)[0]?.data?.key;
  const keyB = collectTableSpecs(pinnedState, true)[0]?.data?.key;
  check("同一文档两次读取 key 相同", keyA !== undefined && keyA === keyB);

  const data = collectTableSpecs(pinnedState, true)[0].data;
  const widened = withCols(data, [220, 180]);
  check("withCols 换宽度后 key 不同", widened.key !== data.key);
  check("withCols 保留同一份单元格引用", widened.header === data.header && widened.rows === data.rows);

  // A comment whose width count no longer matches the table: the table falls
  // back to auto layout, but the comment must still be reported (it has to be
  // hidden, and it is what a double-click deletes).
  const mismatchDoc = "<!-- qing-table:w=180,220 -->\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n";
  const mismatch = collectTableSpecs(tableState(mismatchDoc), true)[0];
  check(
    "列数不匹配：sizing 存在但 cols 为 null，data.cols 也为 null",
    Boolean(mismatch) && mismatch.sizing !== null && mismatch.sizing.cols === null && mismatch.data.cols === null,
    JSON.stringify({ sizing: mismatch?.sizing, cols: mismatch?.data?.cols }),
  );
  check(
    "列数不匹配：注释区间仍被报告（用于隐藏/删除）",
    mismatch?.sizing?.from === 0 && mismatch?.sizing?.to === "<!-- qing-table:w=180,220 -->".length,
    JSON.stringify(mismatch?.sizing),
  );
}

// ------------------------------------------------------------------ decoration set
section("DecorationSet：注释行零高度隐藏、光标进入即显形");

{
  // A leading paragraph keeps the caret out of both the comment and the table.
  const doc = "前言\n\n<!-- qing-table:w=180,220 -->\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const field = tablePreview({ revealActiveBlock: true, resizable: true });
  const state = EditorState.create({ doc, extensions: [language, field], selection: { anchor: 0 } });
  ensureSyntaxTree(state, doc.length, 5000);
  // The parse is lazy: the field's `create` ran before the tree existed, so one
  // selection transaction forces the rebuild the editor would get anyway.
  const built = state.update({ selection: { anchor: 1 } }).state.field(field);
  check("注释 + 表格：3 组装饰（行样式 + 隐藏注释 + 表格替换）", built.size === 3, String(built.size));

  const inComment = state
    .update({ selection: { anchor: doc.indexOf("<!--") + 2 } })
    .state.field(field);
  check(
    "光标在注释行：隐藏装饰消失（注释显形可编辑），表格仍渲染",
    inComment.size === 1,
    String(inComment.size),
  );

  // The interactive surface (cell editing) turns the caret fallback off, so the
  // comment has to stay reachable through its own test.
  const interactiveField = tablePreview({ revealActiveBlock: false, resizable: true, interactive: true });
  const interactiveState = EditorState.create({
    doc,
    extensions: [language, interactiveField],
    selection: { anchor: doc.indexOf("<!--") + 2 },
  });
  ensureSyntaxTree(interactiveState, doc.length, 5000);
  const interactiveBuilt = interactiveState
    .update({ selection: { anchor: doc.indexOf("<!--") + 3 } })
    .state.field(interactiveField);
  check(
    "交互态（无 L3 回退）：光标在注释行仍显形",
    interactiveBuilt.size === 1,
    String(interactiveBuilt.size),
  );

  // Read-only surfaces must keep the comment invisible even with a selection on
  // it: a collapsed selection at offset 0 would otherwise expose the first one.
  const readonlyField = tablePreview({ revealActiveBlock: false, resizable: false });
  const readonlyState = EditorState.create({
    doc,
    extensions: [language, readonlyField],
    selection: { anchor: doc.indexOf("<!--") + 2 },
  });
  ensureSyntaxTree(readonlyState, doc.length, 5000);
  const readonlyBuilt = readonlyState
    .update({ selection: { anchor: doc.indexOf("<!--") + 3 } })
    .state.field(readonlyField);
  check(
    "只读实例：注释恒定隐藏（不因选区显形）",
    readonlyBuilt.size === 3,
    String(readonlyBuilt.size),
  );
}

// ------------------------------------------------------------------ summary
section("结果");
console.log(`  ${checks} 项检查 · ${failures} 项失败`);

fs.rmSync(outfile, { force: true });

if (failures > 0) process.exitCode = 1;
