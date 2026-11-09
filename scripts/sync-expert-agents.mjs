#!/usr/bin/env node
// 单向同步：docs/agents/*.md（仓库内唯一编辑真源）→ 已注册的 qing-dev 专家包 agents/。
// 用法：node scripts/sync-expert-agents.mjs
// 同步后仍需重新运行 expert-manager 的 validate_expert.py 与 register_expert.py。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'docs', 'agents');
const configDir = process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
const dstDir = join(
  configDir,
  'plugins', 'marketplaces', 'my-experts', 'plugins', 'qing-dev', 'agents',
);

const EXPECTED = 8;

if (!existsSync(srcDir)) {
  console.error(`源目录不存在：${srcDir}`);
  process.exit(1);
}
if (!existsSync(dstDir)) {
  console.error(`专家包未安装：${dstDir}`);
  console.error('请先在 WorkBuddy 中安装 qing-dev 专家团，或用 expert-manager 初始化并注册。');
  process.exit(1);
}

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

mkdirSync(dstDir, { recursive: true });
for (const { file, text } of payloads) {
  writeFileSync(join(dstDir, file), text, 'utf8');
  console.log(`  synced  ${file}`);
}

console.log(`\n已同步 ${payloads.length} 个角色提示词 → ${dstDir}`);
console.log('下一步：validate_expert.py → register_expert.py，然后 git commit（不 push）。');
