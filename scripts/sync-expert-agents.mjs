#!/usr/bin/env node
// 单向同步：docs/agents/*.md（仓库内唯一编辑真源）
//   → 项目内完整专家包 experts/workbuddy/my-experts/plugins/qing-dev/agents/
//   → WorkBuddy 运行时安装缓存 plugins/cache/my-experts/qing-dev/<version>/agents/
// C 盘的 marketplaces/my-experts 是指向项目内目录的 junction，无需单独同步。
// 并把项目内专家包的展示元数据镜像到各缓存版本目录。
// 用法：node scripts/sync-expert-agents.mjs
// 同步后仍需运行 expert-manager 的 validate_expert.py 与 register_expert.py。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'docs', 'agents');
const configDir = process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
const sourcePkg = join(repoRoot, 'experts', 'workbuddy', 'my-experts', 'plugins', 'qing-dev');
const cacheRoot = join(configDir, 'plugins', 'cache', 'my-experts', 'qing-dev');

const EXPECTED = 8;

if (!existsSync(srcDir)) {
  console.error(`源目录不存在：${srcDir}`);
  process.exit(1);
}
if (!existsSync(join(sourcePkg, 'agents'))) {
  console.error(`专家包未安装：${sourcePkg}`);
  console.error('请先用 expert-manager 初始化并注册 qing-dev 专家团。');
  process.exit(1);
}

// 缓存目录由 WorkBuddy 在首次启用专家时生成，可能有多个版本；缺失不算错误。
const cachePkgs = existsSync(cacheRoot)
  ? readdirSync(cacheRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(cacheRoot, d.name, 'agents')))
      .map((d) => join(cacheRoot, d.name))
  : [];

const files = readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();
if (files.length !== EXPECTED) {
  console.error(`源文件数量异常：期望 ${EXPECTED} 个，实际 ${files.length} 个。已中止，未写入任何文件。`);
  process.exit(1);
}

// 先全量校验再写入，避免同步到一半留下不一致状态。
const payloads = [];
for (const file of files) {
  const text = readFileSync(join(srcDir, file), 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    console.error(`缺少 frontmatter：${file}`);
    process.exit(1);
  }
  const nameLine = match[1].split(/\r?\n/).find((l) => /^name:\s*/.test(l));
  const declared = nameLine?.replace(/^name:\s*/, '').trim();
  const expectedName = file.replace(/\.md$/, '');
  if (declared !== expectedName) {
    console.error(`frontmatter name 与文件名不一致：${file} → ${declared ?? '(missing)'}`);
    process.exit(1);
  }
  if (/^tools:/m.test(match[1])) {
    console.error(`frontmatter 禁止声明 tools 字段：${file}`);
    process.exit(1);
  }
  payloads.push({ file, text });
}

// WorkBuddy 在首次启用专家时可能移除包根目录的 settings.json；按 plugin.json 自愈。
const settingsFrom = join(sourcePkg, 'settings.json');
if (!existsSync(settingsFrom)) {
  const pj = JSON.parse(readFileSync(join(sourcePkg, '.codebuddy-plugin', 'plugin.json'), 'utf8'));
  writeFileSync(settingsFrom, `${JSON.stringify({ agent: pj.agentName }, null, 2)}\n`, 'utf8');
  console.log(`  restored settings.json (agent=${pj.agentName})`);
}

for (const pkg of [sourcePkg, ...cachePkgs]) {
  const agentsDir = join(pkg, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const { file, text } of payloads) {
    writeFileSync(join(agentsDir, file), text, 'utf8');
  }
  console.log(`  prompts -> ${agentsDir}`);
}

// 展示字段（花名 / 标签 / 描述）只存在于源目录的这两个文件，需镜像到缓存。
for (const pkg of cachePkgs) {
  for (const rel of [join('.codebuddy-plugin', 'plugin.json'), 'README.md', 'settings.json']) {
    const from = join(sourcePkg, rel);
    if (!existsSync(from)) continue;
    const to = join(pkg, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`  meta    -> ${to}`);
  }
}

console.log(`\n已同步 ${payloads.length} 个角色提示词到 ${1 + cachePkgs.length} 个目录。`);
if (cachePkgs.length === 0) {
  console.log('提示：尚未发现安装缓存目录；首次在专家中心启用 qing-dev 后，请再跑一次本脚本。');
}
console.log('下一步：validate_expert.py → register_expert.py，然后 git commit（不 push）。');
