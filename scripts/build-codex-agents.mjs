#!/usr/bin/env node
// 从 docs/agents/*.md（WorkBuddy 角色提示词真源）生成 Codex 自定义子智能体。
// 输出：.codex/agents/qing-cx-*.toml
// 命名规则：WorkBuddy 版用 qing-dev-*，Codex 适配版一律用 qing-cx-*，避免混淆。
// 用法：node scripts/build-codex-agents.mjs

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'docs', 'agents');
const outDir = join(repoRoot, '.codex', 'agents');

const MAP = {
  'qing-dev-team-lead': 'lead',
  'qing-dev-frontend-engineer': 'frontend',
  'qing-dev-rule-guardian': 'guardian',
  'qing-dev-quality-officer': 'quality',
  'qing-dev-architect': 'architect',
  'qing-dev-tauri-engineer': 'tauri',
  'qing-dev-visual-designer': 'visual',
  'qing-dev-release-steward': 'release',
};

const CODEX_NOTE = `

## Codex 运行时适配注记（构建脚本追加，非 WorkBuddy 原文）

- 本定义是 Codex 自定义子智能体，由主线程通过 spawn_agent 拉起、wait_agent 收集结果。
  原文中的 SendMessage 一律理解为「把完整结论返回主线程」。
- 原文中的 TeamCreate、共享任务列表、主理人消息中转，改由 Codex 主线程编排与汇总。
- 原文中的「主理人」对应 qing-cx-lead；只读角色在调用时须显式要求不写文件。
- 沙箱与审批策略继承自父线程；角色 TOML 不声明 model，沿用项目 config.toml。
- 与 WorkBuddy 版 qing-dev-* 是两份独立适配，改内容请改 docs/agents/ 后重跑本脚本。
`;

if (!existsSync(srcDir)) {
  console.error(`源目录不存在：${srcDir}`);
  process.exit(1);
}

const files = readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();
if (files.length !== Object.keys(MAP).length) {
  console.error(`源文件数量异常：期望 ${Object.keys(MAP).length}，实际 ${files.length}。已中止。`);
  process.exit(1);
}

const outputs = [];
for (const file of files) {
  const id = file.replace(/\.md$/, '');
  const short = MAP[id];
  if (!short) {
    console.error(`未映射的角色：${file}`);
    process.exit(1);
  }
  const text = readFileSync(join(srcDir, file), 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fm) {
    console.error(`frontmatter 解析失败：${file}`);
    process.exit(1);
  }
  const descLine = fm[1].split(/\r?\n/).find((l) => /^description:\s*/.test(l));
  const description = (descLine?.replace(/^description:\s*/, '').trim() ?? '')
    .replace(/^["']|["']$/g, '') || `Qing Notepad ${short} role`;
  const body = fm[2].trimEnd() + CODEX_NOTE;
  if (body.includes("'''")) {
    console.error(`正文含 TOML 字面量字符串终止符，无法安全生成：${file}`);
    process.exit(1);
  }
  const toml = `# 由 scripts/build-codex-agents.mjs 生成，请勿手改；源：docs/agents/${file}\n`
    + `# 命名前缀 qing-cx-* = Codex 适配；qing-dev-* = WorkBuddy 专家团\n`
    + `name = "qing-cx-${short}"\n`
    + `description = ${JSON.stringify(description)}\n`
    + `developer_instructions = '''\n${body}\n'''\n`;
  outputs.push({ name: `qing-cx-${short}.toml`, toml });
}

mkdirSync(outDir, { recursive: true });
for (const { name, toml } of outputs) {
  writeFileSync(join(outDir, name), toml, 'utf8');
  console.log(`  generated  .codex/agents/${name}`);
}
console.log(`\n已生成 ${outputs.length} 个 Codex 子智能体定义。`);
console.log('提示：本机 Codex CLI 0.167.0；项目级 agent 目录为 .codex/agents/。');
