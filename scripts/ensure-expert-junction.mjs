#!/usr/bin/env node
// 检查并重建 WorkBuddy 自定义专家市场的目录联接（junction）。
// C 盘路径必须存在且指向项目内的 experts/workbuddy/my-experts，否则专家中心检测不到。
// 用法：node scripts/ensure-expert-junction.mjs
// 本脚本绝不删除任何目录：遇到真实目录或指向错误的联接时只报警并给出手动步骤。

import { existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'experts', 'workbuddy', 'my-experts');
const configDir = process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
const link = join(configDir, 'plugins', 'marketplaces', 'my-experts');

const norm = (p) => p
  .replace(/^\\\\\?\\/, '')
  .replace(/[\\/]+/g, '\\')
  .replace(/\\$/, '')
  .toLowerCase();

if (!existsSync(target)) {
  console.error(`项目内专家市场不存在：${target}`);
  console.error('请先从仓库检出 experts/workbuddy/my-experts/。');
  process.exit(1);
}

let stat = null;
try {
  stat = lstatSync(link);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  symlinkSync(target, link, 'junction');
  console.log(`已创建目录联接：\n  ${link}\n  -> ${target}`);
  console.log('下一步：node scripts/sync-expert-agents.mjs，然后重新校验并注册。');
  process.exit(0);
}

let current = null;
try {
  current = readlinkSync(link);
} catch {
  current = null;
}

if (current !== null && norm(current) === norm(target)) {
  console.log('联接正常，无需改动：');
  console.log(`  ${link} -> ${current}`);
  process.exit(0);
}

if (current !== null) {
  console.error('联接存在但指向了别的位置，未自动修改：');
  console.error(`  当前 -> ${current}`);
  console.error(`  期望 -> ${target}`);
  console.error('请人工确认后删除该联接（只删联接，不删目标），再重跑本脚本。');
  process.exit(1);
}

console.error('C 盘路径已变成真实目录（可能被 WorkBuddy 重建），其中可能有新数据：');
console.error(`  ${link}`);
console.error('为防数据丢失，本脚本不会自动删除。手动步骤：');
console.error('  1) 把该目录改名备份（例如 my-experts.rebuilt-YYYYMMDD）');
console.error('  2) 重跑 node scripts/ensure-expert-junction.mjs 重建联接');
console.error('  3) 运行 node scripts/sync-expert-agents.mjs 恢复两处一致');
process.exit(2);
