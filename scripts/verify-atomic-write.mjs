/**
 * Headless verification for `src/utils/atomicWrite.ts`.
 *
 *   node scripts/verify-atomic-write.mjs
 *
 * The guarantee under test is "a save either fully lands or does not touch the
 * target", so the checks are written against the *observable call sequence*
 * rather than the file bytes alone:
 *
 *   [A] contents round-trip unchanged (Chinese text + newlines included)
 *   [B] the temp file is a sibling of the target and ends with `.tmp`
 *   [C] 100 concurrent writes to one target never share a temp path
 *   [D] a failing rename rejects *and* removes the temp file
 *   [E] a filesystem that refuses to replace takes the remove-then-rename path
 *
 * Only `@tauri-apps/plugin-fs` is stubbed — same approach as
 * `scripts/verify-graph-title.mjs:30-34`. The production module is bundled by
 * esbuild and imported as-is, so there is no test-only seam in shipped code.
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
  // `detail` is deliberately kept when it is `undefined`: for checks whose whole
  // point is "the target must still exist", `undefined` IS the evidence (the read
  // came back empty). Note that `JSON.stringify(undefined)` returns `undefined`
  // — not a string — so the fallback has to be written out explicitly.
  const evidence = detail === undefined ? " (undefined)" : JSON.stringify(detail);
  console.log(`  FAIL  ${name} — ${evidence}`);
}

const section = (title) => console.log(`\n${title}`);

/**
 * Runs `fn` and reports whether it rejected, without letting the rejection kill
 * the whole harness. A source regression must degrade into per-check FAILs, never
 * into "the script threw on line N and nothing else ran".
 */
async function expectReject(fn, label) {
  try {
    await fn();
    return { rejected: false, message: "" };
  } catch (error) {
    return { rejected: true, message: String(error?.message ?? error) };
  }
}

// ------------------------------------------------------------------ virtual fs
/**
 * In-memory stand-in for the Tauri fs API. Everything the module does is
 * recorded, and rename failures can be aimed at a *direction* — the
 * non-destructive fallback is only distinguishable from naive remove-then-rename
 * by making `temp→target` fail while `target→backup` still works.
 */
function createVirtualFs() {
  const files = new Map();
  const calls = { writeTextFile: [], writeFile: [], rename: [], remove: [], exists: [] };
  /** @type {{ matches: (from: string, to: string) => boolean, remaining: number }[]} */
  const renameRules = [];
  let renameFailureCount = 0;

  const fs = {
    files,
    calls,
    seed(filePath, contents) {
      files.set(filePath, contents);
    },
    /** 只让符合 `matches` 的 rename 失败，`times` 次。 */
    failRenameWhen(matches, times = Number.MAX_SAFE_INTEGER) {
      renameRules.push({ matches, remaining: times });
      return fs;
    },
    /** 让接下来的 `times` 次 rename（不分方向）全部失败。 */
    failNextRename(times = 1) {
      return fs.failRenameWhen(() => true, times);
    },
    /** 清掉所有注入的失败规则。 */
    failNothing() {
      renameRules.length = 0;
      return fs;
    },
    async writeTextFile(filePath, contents) {
      calls.writeTextFile.push(filePath);
      files.set(filePath, contents);
    },
    async writeFile(filePath, contents) {
      calls.writeFile.push(filePath);
      files.set(filePath, contents);
    },
    async rename(from, to) {
      // Every attempt is recorded, including the throwing one — the fallback in
      // `atomicWrite.ts` is only observable by counting attempts and directions.
      const rule = renameRules.find((entry) => entry.remaining > 0 && entry.matches(from, to));
      const willFail = rule !== undefined;
      const call = { from, to, failed: willFail, message: undefined };
      calls.rename.push(call);
      if (willFail) {
        rule.remaining -= 1;
        renameFailureCount += 1;
        // 每次失败的错误对象各不相同（带序号），这样"抛的是第一次还是第二次"可判。
        call.message = `EPERM: operation not permitted (rename failure #${renameFailureCount})`;
        throw new Error(call.message);
      }
      if (!files.has(from)) throw new Error(`ENOENT: no such file, rename '${from}'`);
      const value = files.get(from);
      files.set(to, value);
      files.delete(from);
    },
    async remove(filePath) {
      if (!files.has(filePath)) throw new Error(`ENOENT: no such file, remove '${filePath}'`);
      calls.remove.push(filePath);
      files.delete(filePath);
    },
    async exists(filePath) {
      calls.exists.push(filePath);
      return files.has(filePath);
    },
  };

  return fs;
}

const virtualFs = createVirtualFs();
globalThis.__ATOMIC_WRITE_FS__ = virtualFs;

// -------------------------------------------------------------------- bundle
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-verify-"));
const outfile = path.join(tmpDir, "atomicWrite.bundle.mjs");

/** Resolved lazily through `globalThis` so the fs can be inspected between checks. */
const tauriFsStub = {
  name: "stub-tauri-fs",
  setup(build) {
    build.onResolve({ filter: /^@tauri-apps\/plugin-fs$/ }, () => ({
      path: "tauri-fs-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: [
        "const store = () => {",
        "  const fs = globalThis.__ATOMIC_WRITE_FS__;",
        '  if (!fs) throw new Error("atomicWrite verify stub is not installed");',
        "  return fs;",
        "};",
        "export const writeTextFile = (p, c) => store().writeTextFile(p, c);",
        "export const writeFile = (p, c) => store().writeFile(p, c);",
        "export const rename = (a, b) => store().rename(a, b);",
        "export const remove = (p) => store().remove(p);",
        "export const exists = (p) => store().exists(p);",
      ].join("\n"),
      loader: "js",
    }));
  },
};

await esbuild.build({
  stdin: {
    contents: 'export * as atomic from "./src/utils/atomicWrite.ts";',
    resolveDir: root,
    sourcefile: "atomic-write-verify-entry.ts",
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

const { atomic } = await import(pathToFileURL(outfile).href);

const resetCalls = () => {
  for (const key of Object.keys(virtualFs.calls)) virtualFs.calls[key].length = 0;
};

// ================================================== [A] 内容原样落盘
section("[A] 内容正确：中文与换行一个字节不少");

const targetA = "/data/notes/a.md";
const bodyA = "第一行：中文\n第二行\t带制表符\n\n```\n代码块\n```\n";
const writeA = await expectReject(() => atomic.writeFileAtomic(targetA, bodyA));
check(
  "A1) 写入后读回与入参完全一致",
  !writeA.rejected && virtualFs.files.get(targetA) === bodyA,
  writeA.rejected ? writeA.message : virtualFs.files.get(targetA),
);
check("A2) 临时文件不残留（rename 已把它带走）", ![...virtualFs.files.keys()].some((p) => p.endsWith(".tmp")), [...virtualFs.files.keys()]);

const jsonTarget = "/data/config/settings.json";
const writeJson = await expectReject(() =>
  atomic.writeJsonAtomic(jsonTarget, { theme: "浅色", nested: { list: [1, 2] } }),
);
check(
  "A3) writeJsonAtomic 用 2 空格缩进，中文不转义",
  !writeJson.rejected &&
    virtualFs.files.get(jsonTarget) === JSON.stringify({ theme: "浅色", nested: { list: [1, 2] } }, null, 2),
  writeJson.rejected ? writeJson.message : virtualFs.files.get(jsonTarget),
);

let unserialisableRejected = false;
try {
  await atomic.writeJsonAtomic("/data/config/bad.json", undefined);
} catch {
  unserialisableRejected = true;
}
check("A4) 不可序列化的值直接抛错，不写半份文件", unserialisableRejected && !virtualFs.files.has("/data/config/bad.json"));

// ================================================ [B] 临时文件是同目录兄弟
section("[B] 临时文件与目标同目录、以 .tmp 结尾（跨盘 rename 会失败）");

resetCalls();
const targetB = "/data/notes/deep/nested/b.md";
const writeB = await expectReject(() => atomic.writeFileAtomic(targetB, "x"));
const tempB = virtualFs.calls.writeTextFile[0];
check(
  "B1) 写的是临时文件而不是目标本身",
  !writeB.rejected && tempB !== undefined && tempB !== targetB,
  writeB.rejected ? writeB.message : tempB,
);
check("B2) 临时文件 dirname 与目标 dirname 相同", path.posix.dirname(tempB ?? "") === path.posix.dirname(targetB), tempB);
check("B3) 临时文件以 .tmp 结尾", (tempB ?? "").endsWith(".tmp"), tempB);
check("B4) 临时文件名以目标文件名为前缀", path.posix.basename(tempB ?? "").startsWith("b.md."), tempB);
check("B5) 顺序是 write(temp) → rename(temp, target)", virtualFs.calls.rename.length === 1 && virtualFs.calls.rename[0].to === targetB, virtualFs.calls.rename);

// Windows 反斜杠路径同样必须落在同一目录（同目录判定不能靠硬编码 "/"）
resetCalls();
const targetBWin = "C:\\Users\\me\\AppData\\Roaming\\qing\\data\\notes\\c.md";
await atomic.writeFileAtomic(targetBWin, "y");
const tempBWin = virtualFs.calls.writeTextFile[0] ?? "";
check(
  "B6) 反斜杠路径的临时文件是同目录兄弟",
  tempBWin.startsWith("C:\\Users\\me\\AppData\\Roaming\\qing\\data\\notes\\") && tempBWin.endsWith(".tmp"),
  tempBWin,
);

// ================================================== [C] 并发不重名、不截断
section("[C] 同一目标并发 100 次：临时名不碰撞，最终内容是完整值");

resetCalls();
const targetC = "/data/notes/concurrent.md";
const values = Array.from({ length: 100 }, (_, i) => `并发写入第 ${i} 号\n`);
const writesC = await expectReject(() =>
  Promise.all(values.map((value) => atomic.writeFileAtomic(targetC, value))),
);

const tempsC = virtualFs.calls.writeTextFile.filter((p) => p !== targetC);
check(
  "C1) 100 次并发产生 100 个不同的临时路径",
  !writesC.rejected && new Set(tempsC).size === 100 && tempsC.length === 100,
  { rejected: writesC.rejected, message: writesC.message, unique: new Set(tempsC).size, total: tempsC.length },
);
check("C2) 最终内容是其中一个完整入参（无截断 / 无拼接）", values.includes(virtualFs.files.get(targetC)), virtualFs.files.get(targetC));
check("C3) 并发结束后没有临时文件残留", ![...virtualFs.files.keys()].some((p) => p.endsWith(".tmp")));

// ================================================== [D] 失败必须清理并抛出
section("[D] rename 失败：向调用方抛出，且临时文件被清掉");

resetCalls();
const targetD = "/data/notes/d.md"; // 故意不预置：本节只考察"永久失败 + 清理"
virtualFs.failNextRename(Number.MAX_SAFE_INTEGER);
let rejected = false;
let rejectionMessage = "";
try {
  await atomic.writeFileAtomic(targetD, "新内容");
} catch (error) {
  rejected = true;
  rejectionMessage = String(error?.message ?? error);
}
virtualFs.failNextRename(0);

check("D1) writeFileAtomic 以 reject 结束（不是静默吞掉）", rejected, rejectionMessage);
check("D2) 抛出的就是 rename 的原始错误，未被清理逻辑覆盖", rejectionMessage.includes("EPERM"), rejectionMessage);
check("D3) remove 被调用过（走了清理分支）", virtualFs.calls.remove.length >= 1, virtualFs.calls.remove);
check(
  "D4) 临时文件已从文件系统消失",
  ![...virtualFs.files.keys()].some((p) => p.endsWith(".tmp")),
  [...virtualFs.files.keys()],
);
check("D5) 目标没有被创建（不会留下半份文件）", !virtualFs.files.has(targetD), [...virtualFs.files.keys()]);

// 非破坏性的核心承诺：目标已存在时，**任何**失败路径都不许先删目标。
// 这一条曾经是"照抄 storage.ts:1012"的已知取舍（先 remove 再重试 → 失败即丢旧数据），
// 现在改成备份-重试-回滚，所以断言方向也反了过来：旧内容必须还在。
resetCalls();
const targetDKeep = "/data/notes/d-keep.md";
virtualFs.seed(targetDKeep, "旧内容");
virtualFs.failNextRename(Number.MAX_SAFE_INTEGER);
let keepRejected = false;
try {
  await atomic.writeFileAtomic(targetDKeep, "新内容");
} catch {
  keepRejected = true;
}
virtualFs.failNothing();
check(
  "D6) 目标已存在且所有 rename 都失败 → 旧内容原样保留（绝不先删目标）",
  keepRejected &&
    virtualFs.files.get(targetDKeep) === "旧内容" &&
    !virtualFs.calls.remove.includes(targetDKeep),
  { keepRejected, value: virtualFs.files.get(targetDKeep), removes: virtualFs.calls.remove },
);

// ================================= [E] 拒绝覆盖的文件系统：备份 → 替换 → 清备份
section("[E] 目标存在且首次 rename 失败 → 备份旧文件、重试、成功后清掉备份");

resetCalls();
const targetE = "/data/notes/e.md";
virtualFs.seed(targetE, "旧内容");
virtualFs.failNextRename(1); // 只失败一次：模拟"文件系统拒绝覆盖已存在目标"
// 这一行原本是裸 await：源码一旦回归成"目标存在时直接抛"，整个脚本会崩在这里，
// 后面 E7/E8/F/G 一条都不执行。用 expectReject 包住，回归只降级成 FAIL。
const writeE = await expectReject(() => atomic.writeFileAtomic(targetE, "新内容"));
virtualFs.failNothing();

const backupE = virtualFs.calls.rename.find((call) => call.to.endsWith(".bak"))?.to;
check(
  "E1) 首次 rename 失败后目标被改名成 .bak 备份（不是被删掉）",
  !writeE.rejected &&
    backupE !== undefined &&
    virtualFs.calls.rename.some((call) => call.from === targetE && call.to === backupE),
  writeE.rejected ? writeE.message : virtualFs.calls.rename,
);
check(
  "E2) 最终内容是新值",
  !writeE.rejected && virtualFs.files.get(targetE) === "新内容",
  writeE.rejected ? writeE.message : virtualFs.files.get(targetE),
);
check(
  "E3) rename 走了三步：temp→target 失败、target→bak、temp→target 成功",
  virtualFs.calls.rename.length === 3 &&
    virtualFs.calls.rename[0].failed === true &&
    virtualFs.calls.rename[1].from === targetE &&
    virtualFs.calls.rename[2].failed === false,
  virtualFs.calls.rename,
);
check("E4) 成功后备份被清掉（不留 .bak）", ![...virtualFs.files.keys()].some((p) => p.endsWith(".bak")), [...virtualFs.files.keys()]);
check("E5) 目标文件从未被 remove（非破坏性）", !virtualFs.calls.remove.includes(targetE), virtualFs.calls.remove);
check("E6) 没有临时文件残留", ![...virtualFs.files.keys()].some((p) => p.endsWith(".tmp")));

// 首建笔记的最高频路径：目标还不存在时，也必须重试一次（一次瞬时锁不该让新笔记存不下来）。
resetCalls();
const targetE7 = "/data/notes/fresh.md";
virtualFs.failNextRename(1); // 第一次失败，第二次正常
let freshRejected = false;
try {
  await atomic.writeFileAtomic(targetE7, "首次创建");
} catch {
  freshRejected = true;
}
virtualFs.failNothing();
check(
  "E7) 目标不存在 + 首次 rename 失败 → 重试一次即成功（新建笔记的首次保存）",
  !freshRejected && virtualFs.files.get(targetE7) === "首次创建" && virtualFs.calls.rename.length === 2,
  { freshRejected, renames: virtualFs.calls.rename, value: virtualFs.files.get(targetE7) },
);
check(
  "E7b) 这条路径不产生 .bak / .tmp 残留（无旧文件可备份）",
  ![...virtualFs.files.keys()].some((p) => /\.(tmp|bak)$/.test(p)),
  [...virtualFs.files.keys()],
);

// 两次都失败：仍报第一次的错误，别把原因换成第二次的重复信息。
resetCalls();
const targetE8 = "/data/notes/fresh-fail.md";
virtualFs.failNextRename(2); // 第一次与重试都失败
let e8Rejected = false;
let e8Message = "";
try {
  await atomic.writeFileAtomic(targetE8, "首次创建失败");
} catch (error) {
  e8Rejected = true;
  e8Message = String(error?.message ?? error);
}
virtualFs.failNothing();
const firstAttemptMessage = virtualFs.calls.rename[0]?.message;
const secondAttemptMessage = virtualFs.calls.rename[1]?.message;
check("E8) 两次都失败 → reject，且确实尝试了 2 次", e8Rejected && virtualFs.calls.rename.length === 2, virtualFs.calls.rename);
check(
  "E8b) 抛出的是第一次的错误（不是第二次的重复信息）",
  e8Message === firstAttemptMessage &&
    secondAttemptMessage !== undefined &&
    e8Message !== secondAttemptMessage,
  { e8Message, firstAttemptMessage, secondAttemptMessage },
);
check(
  "E8c) 目标未被创建、temp 已清理、没有任何 .bak",
  !virtualFs.files.has(targetE8) &&
    ![...virtualFs.files.keys()].some((p) => p.endsWith(".tmp")) &&
    ![...virtualFs.files.keys()].some((p) => p.endsWith(".bak")),
  [...virtualFs.files.keys()],
);

// ============================ [F] 永久失败不丢数据（备份回滚，核心断言）
section("[F] temp→target 永久失败：reject、旧内容仍在、.bak 已回滚清掉");

resetCalls();
const targetF = "/data/notes/f.md";
virtualFs.seed(targetF, "旧内容不能被吃掉\n第二行\n");
// 只有"临时文件换成目标"这个方向失败；备份与回滚方向正常。
virtualFs.failRenameWhen((from, to) => to === targetF && from.endsWith(".tmp"));
let fRejected = false;
let fMessage = "";
try {
  await atomic.writeFileAtomic(targetF, "新内容");
} catch (error) {
  fRejected = true;
  fMessage = String(error?.message ?? error);
}
virtualFs.failNothing();

const fTriedBackup = virtualFs.calls.rename.some((call) => call.to.endsWith(".bak") && !call.failed);
const fRolledBack = virtualFs.calls.rename.some((call) => call.from.endsWith(".bak") && call.to === targetF && !call.failed);
check("F1) 写失败以 reject 结束", fRejected, fMessage);
check("F2) 目标内容仍是旧值（一字不差）", virtualFs.files.get(targetF) === "旧内容不能被吃掉\n第二行\n", virtualFs.files.get(targetF));
check("F3) 走过「备份 + 回滚」两步（证明不是 remove-then-rename）", fTriedBackup && fRolledBack, virtualFs.calls.rename);
check("F4) 目标文件从未被 remove", !virtualFs.calls.remove.includes(targetF), virtualFs.calls.remove);
check("F5) 没有 .bak 残留", ![...virtualFs.files.keys()].some((p) => p.endsWith(".bak")), [...virtualFs.files.keys()]);
check("F6) 临时文件已清理", ![...virtualFs.files.keys()].some((p) => p.endsWith(".tmp")), [...virtualFs.files.keys()]);

// ============================== [G] 连备份都做不了：原错误上抛、目标不动
section("[G] target→backup 也失败：reject、目标内容不变、无 .bak / .tmp 残留");

resetCalls();
const targetG = "/data/notes/g.md";
virtualFs.seed(targetG, "旧内容");
virtualFs.failRenameWhen(
  (from, to) => (to === targetG && from.endsWith(".tmp")) || (from === targetG && to.endsWith(".bak")),
);
let gRejected = false;
let gMessage = "";
try {
  await atomic.writeFileAtomic(targetG, "新内容");
} catch (error) {
  gRejected = true;
  gMessage = String(error?.message ?? error);
}
virtualFs.failNothing();
check("G1) 以 reject 结束", gRejected, gMessage);
check("G2) 目标内容不变（旧值）", virtualFs.files.get(targetG) === "旧内容", virtualFs.files.get(targetG));
check("G3) 目标文件从未被 remove", !virtualFs.calls.remove.includes(targetG), virtualFs.calls.remove);
check("G4) 没有 .bak 残留", ![...virtualFs.files.keys()].some((p) => p.endsWith(".bak")), [...virtualFs.files.keys()]);
check("G5) 临时文件已清理", ![...virtualFs.files.keys()].some((p) => p.endsWith(".tmp")), [...virtualFs.files.keys()]);
check("G6) 抛的是原始 rename 错误（备份失败不掩盖它）", gMessage.includes("EPERM"), gMessage);

// ------------------------------------------------------------------ summary
fs.rmSync(tmpDir, { recursive: true, force: true });
delete globalThis.__ATOMIC_WRITE_FS__;

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(`${failures === 0 ? "PASS" : "FAIL"} — atomic write`);
if (failures !== 0) process.exitCode = 1;
