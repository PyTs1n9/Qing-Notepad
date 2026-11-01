// 生成 updater 用的静态清单（`latest.json`）。
//
// 为什么是两份而不是一份：清单里的 `platforms.windows-x86_64.url` 只能写一个下载地址，
// 而 Gitee 与 GitHub 的发行版附件是两份独立的文件。于是同一份签名配两个宿主：
//   - `latest.json`       → 下载地址指向 GitHub（客户端用它做备源）
//   - `latest-gitee.json` → 下载地址指向 Gitee（主源，文件名不同是为了让人一眼看出指向哪里）
// 签名本身与宿主无关，`signature` 两份完全一样（它签的是安装包字节）。
//
// 用法（发布后由 CI 调用，也可本机手动跑）：
//   node scripts/updater-manifest.mjs --sig-dir src-tauri/target/release/bundle/nsis \
//     --tag v0.9.0 --out-dir .updater
//
// 参数：
//   --sig <path>        直接指定 .sig 文件（优先于 --sig-dir）
//   --sig-dir <dir>     在该目录里找 `*-setup.exe.sig`，多个时取最新修改的那个
//   --tag <tag>         发行版 tag，缺省 `v<version>`
//   --out-dir <dir>     输出目录，缺省 `.updater`
//   --notes-file <path> 发行说明文件（写入 `notes`）
//   --notes <text>      直接给一段发行说明

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const HOSTS = {
  github: "https://github.com/PyTs1n9/Qing-Notepad",
  gitee: "https://gitee.com/PyTs1N9/Qing-Notepad",
};

function fail(message) {
  console.error(`updater-manifest: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { outDir: ".updater" };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (!flag.startsWith("--")) fail(`无法识别的参数 ${flag}`);
    if (value === undefined || value.startsWith("--")) fail(`${flag} 需要一个值`);

    switch (flag) {
      case "--sig": options.sig = value; break;
      case "--sig-dir": options.sigDir = value; break;
      case "--tag": options.tag = value; break;
      case "--out-dir": options.outDir = value; break;
      case "--notes-file": options.notesFile = value; break;
      case "--notes": options.notes = value; break;
      default: fail(`未知参数 ${flag}`);
    }

    index += 1;
  }

  return options;
}

function pickSignature(options) {
  if (options.sig) {
    const path = resolve(repoRoot, options.sig);
    if (!existsSync(path)) fail(`找不到 .sig：${path}`);
    return path;
  }

  if (!options.sigDir) fail("需要 --sig 或 --sig-dir");

  const directory = resolve(repoRoot, options.sigDir);
  if (!existsSync(directory)) fail(`找不到目录：${directory}`);

  // 只认 NSIS 的安装包签名。目录里可能还留着历史版本的 .sig，
  // 取修改时间最新的那个，并把它打印出来 —— 选错版本是这个脚本最可能的失败方式。
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith("-setup.exe.sig"))
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  if (candidates.length === 0) fail(`${directory} 里没有 *-setup.exe.sig`);

  return candidates[0];
}

function readVersion() {
  const config = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  if (typeof config.version !== "string" || !config.version.trim()) {
    fail("src-tauri/tauri.conf.json 里没有 version");
  }
  return config.version.trim().replace(/^v/i, "");
}

const options = parseArgs(process.argv.slice(2));
const signaturePath = pickSignature(options);
const signature = readFileSync(signaturePath, "utf8").trim();

if (!signature) fail(`${signaturePath} 是空的`);

const artifact = basename(signaturePath).replace(/\.sig$/, "");
if (!artifact.endsWith(".exe")) fail(`签名对应的不是 .exe：${artifact}`);

const version = readVersion();
const tag = (options.tag ?? `v${version}`).trim();

if (tag.replace(/^v/i, "") !== version) {
  console.warn(`警告：tag ${tag} 与 tauri.conf.json 的 ${version} 不一致，客户端会按清单里的 version 判断。`);
}

const notes = options.notesFile
  ? readFileSync(resolve(repoRoot, options.notesFile), "utf8").trim()
  : (options.notes ?? "").trim();

const pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function manifest(url) {
  return `${JSON.stringify({
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": { signature, url },
    },
  }, null, 2)}\n`;
}

const outputDirectory = resolve(repoRoot, options.outDir);
mkdirSync(outputDirectory, { recursive: true });

const targets = [
  { file: "latest.json", host: "github" },
  { file: "latest-gitee.json", host: "gitee" },
];

for (const target of targets) {
  const url = `${HOSTS[target.host]}/releases/download/${tag}/${artifact}`;
  const path = join(outputDirectory, target.file);
  writeFileSync(path, manifest(url), "utf8");
  console.log(`${target.file} → v${version} (${target.host}) ${url}`);
}

console.log(`签名来源：${signaturePath}`);
