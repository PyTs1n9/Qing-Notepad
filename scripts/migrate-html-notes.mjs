/**
 * One-off migration: stored editor HTML → Markdown (`data/notes/*.md`).
 *
 *   node scripts/migrate-html-notes.mjs --dry-run     # what would change
 *   node scripts/migrate-html-notes.mjs               # backup, then rewrite
 *   node scripts/migrate-html-notes.mjs --dir <notes> # a relocated data dir
 *
 * Before the Markdown rewrite, TipTap persisted rendered HTML into the same
 * `.md` files that now hold Markdown source. Live preview shows those notes as
 * raw tags, so each of them is converted once.
 *
 * The conversion is *the app's own*: `isStoredEditorHtml` decides what counts as
 * HTML-era content and `htmlToMarkdown` does the rewriting — the same two
 * functions `NoteEditor`, `App.tsx` and `plugin/bridge.ts` call. Nothing here
 * re-implements a rule, so a note migrates exactly as the app would read it.
 *
 * Safety rules:
 * - every file is copied to `<data>/backup/html-migration-<timestamp>/` before
 *   it is touched, so a wrong call is one `cp` away from undone;
 * - writes go through a temp file in the same directory and a rename, so a
 *   half-written note cannot happen;
 * - a file that fails (read, convert, write) is left exactly as it was;
 * - nothing is ever deleted.
 *
 * Re-running is safe: the output of the conversion no longer satisfies
 * `isStoredEditorHtml`, so a second run finds nothing to do. The one case that
 * cannot converge — a note whose *code fence* holds literal editor tags, so the
 * converted text still matches the recogniser — is **not written**. Writing it
 * would let the next run convert it again, and that second pass treats the fence
 * as markup and eats the tags inside it. Those files are reported as failures
 * and left untouched for a human to look at.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const verbose = argv.includes("--verbose") || argv.includes("-v");
const dirArgIndex = argv.indexOf("--dir");
const notesDir = path.resolve(root, dirArgIndex >= 0 ? argv[dirArgIndex + 1] ?? "" : "data/notes");

const section = (title) => console.log(`\n${title}`);
const show = (text) => JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}…` : text);

// ------------------------------------------------------------------ conversion
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "html-migration-"));
const bundlePath = path.join(tmpDir, "htmlToMarkdown.bundle.mjs");

await esbuild.build({
  stdin: {
    contents: `export { isStoredEditorHtml, htmlToMarkdown } from ${JSON.stringify(
      path.join(root, "src/utils/htmlToMarkdown.ts"),
    ).replaceAll("\\", "/")};`,
    resolveDir: root,
    loader: "ts",
    sourcefile: "migrate-entry.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  logLevel: "silent",
});

const { isStoredEditorHtml, htmlToMarkdown } = await import(pathToFileURL(bundlePath).href);

// ------------------------------------------------------------------ helpers
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Write through a temp file + rename so a crash cannot leave half a note. */
function writeAtomic(target, content) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.migrating`);
  try {
    fs.writeFileSync(temp, content, "utf8");
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // the temp file is best-effort cleanup; the original is untouched anyway
    }
    throw error;
  }
}

// ------------------------------------------------------------------ run
section("HTML 期笔记迁移");
console.log(`  目录 ${notesDir}`);
console.log(`  模式 ${dryRun ? "dry-run（只统计，不写盘）" : "写入（先备份）"}`);

if (!fs.existsSync(notesDir)) {
  console.log("  目录不存在，没有可迁移的笔记。");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}

const files = fs
  .readdirSync(notesDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
  .map((entry) => entry.name)
  .sort();

const backupDir = path.join(path.dirname(notesDir), "backup", `html-migration-${stamp()}`);
const stats = { scanned: 0, matched: 0, converted: 0, skipped: 0, failed: 0, warnings: 0 };
const failures = [];
const warnings = [];

for (const name of files) {
  const file = path.join(notesDir, name);
  stats.scanned += 1;

  let original;
  try {
    original = fs.readFileSync(file, "utf8");
  } catch (error) {
    stats.failed += 1;
    failures.push([name, `读取失败：${error.message}`]);
    continue;
  }

  // A BOM would ride into the converted text; it is also not part of the content.
  const content = original.replace(/^\uFEFF/, "");
  if (!isStoredEditorHtml(content)) {
    stats.skipped += 1;
    if (verbose) console.log(`  skip      ${name}`);
    continue;
  }
  stats.matched += 1;

  let converted;
  try {
    converted = htmlToMarkdown(content);
  } catch (error) {
    stats.failed += 1;
    failures.push([name, `转换失败：${error.message}`]);
    continue;
  }

  if (content.trim() !== "" && converted.trim() === "") {
    stats.failed += 1;
    failures.push([name, "转换结果为空，已保留原文"]);
    continue;
  }

  // Non-convergent: the converted text still contains an editor tag (a code
  // fence holding literal `<div>`). Writing it would make the next run convert
  // it again — and that pass parses the fence as markup and destroys it — so the
  // file is left alone and reported.
  if (isStoredEditorHtml(converted)) {
    stats.failed += 1;
    failures.push([name, "转换后仍被识别为 HTML（多半是代码块里有字面标签），未写盘"]);
    continue;
  }

  if (converted === original) {
    // Recognised as HTML but the converter made no change: rewriting would be a
    // no-op, and the file would keep matching forever. Leave it, report it.
    stats.skipped += 1;
    warnings.push([name, "转换前后完全一致，未写盘"]);
    continue;
  }

  if (!dryRun) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(file, path.join(backupDir, name));
      writeAtomic(file, converted);
    } catch (error) {
      stats.failed += 1;
      failures.push([name, `写盘失败：${error.message}`]);
      continue;
    }
  }

  stats.converted += 1;
  const delta = converted.length - original.length;
  console.log(
    `  ${dryRun ? "would fix" : "converted"} ${name}  ${original.length} → ${converted.length} 字符 (${delta >= 0 ? "+" : ""}${delta})`,
  );
  if (verbose) {
    console.log(`            before ${show(content)}`);
    console.log(`            after  ${show(converted)}`);
  }

}

// ------------------------------------------------------------------ summary
section("统计");
console.log(`  扫描 ${stats.scanned} · 命中 ${stats.matched} · 转换 ${stats.converted} · 跳过 ${stats.skipped} · 失败 ${stats.failed}`);
if (stats.warnings > 0) console.log(`  另有 ${stats.warnings} 个文件转换后仍被识别为 HTML（见上方 warning）`);

if (!dryRun && stats.converted > 0) {
  console.log(`  备份 ${backupDir}`);
  console.log(`  回滚：把备份目录里的文件复制回 ${notesDir}，覆盖同名文件即可。`);
}

if (failures.length > 0) {
  section("失败文件（原文未改动）");
  for (const [name, reason] of failures) console.log(`  ${name}：${reason}`);
}
if (warnings.length > 0) {
  section("提醒");
  for (const [name, reason] of warnings) console.log(`  ${name}：${reason}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
if (stats.failed > 0) process.exitCode = 1;
