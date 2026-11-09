#!/usr/bin/env node
/**
 * 把 qing-dev 追加到本机每个 WorkBuddy 账号的自定义专家清单。
 *
 * 背景：专家包的全局层（marketplace.json / installed_plugins.json /
 * known_marketplaces.json / cache）都位于 ~/.workbuddy/ 下，对所有账号共享；
 * 唯一按账号隔离的是：
 *   ~/.workbuddy/experts/custom/<uid>/experts.json
 * expert-manager 的 register_expert.py 只写 marketplace.json 与
 * .created-by-session，不写这个按账号的文件，所以重复注册无法让其他账号可见。
 *
 * 用法：
 *   node scripts/sync-expert-accounts.mjs             # 补齐所有已知账号
 *   node scripts/sync-expert-accounts.mjs --check    # 只报告差异，不写入
 *   node scripts/sync-expert-accounts.mjs --uid <uid> # 只处理指定账号
 *
 * 保证：只追加 qing-dev，绝不删除或覆盖任何已有条目；
 * 已有文件无法解析时跳过并报错退出，不猜测其内容。
 * 新账号首次登录、生成 user-<uid>-personal 目录后，重跑一次本脚本即可。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXPERT = 'qing-dev';
const configDir = process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
const customRoot = join(configDir, 'experts', 'custom');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const uidFlag = args.indexOf('--uid');
const onlyUid = uidFlag >= 0 ? args[uidFlag + 1] : null;

if (uidFlag >= 0 && !onlyUid) {
  console.error('--uid 需要一个账号 uid。');
  process.exit(1);
}

/** 已知账号 uid 的两个来源：账号级 personal 目录、运行时已建的 custom 目录。 */
function collectUids() {
  const found = new Set();
  if (onlyUid) return [onlyUid];

  if (existsSync(configDir)) {
    for (const entry of readdirSync(configDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^user-([0-9a-f-]{36})-personal$/i);
      if (match) found.add(match[1]);
    }
  }
  if (existsSync(customRoot)) {
    for (const entry of readdirSync(customRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) found.add(entry.name);
    }
  }
  return [...found].sort();
}

const uids = collectUids();
if (uids.length === 0) {
  console.error(`未发现任何账号 uid，请检查配置目录：${configDir}`);
  process.exit(1);
}

console.log(`配置目录：${configDir}`);
console.log(`发现 ${uids.length} 个账号 uid${checkOnly ? '（仅检查，不写入）' : ''}\n`);

let created = 0;
let appended = 0;
let unchanged = 0;
let skipped = 0;

for (const uid of uids) {
  const file = join(customRoot, uid, 'experts.json');
  const existed = existsSync(file);
  let list = [];

  if (existed) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('内容不是数组');
      list = parsed;
    } catch (err) {
      console.error(`  ! ${uid} 跳过：experts.json 无法解析（${err.message}），未改动。`);
      skipped += 1;
      continue;
    }
  }

  if (list.includes(EXPERT)) {
    console.log(`  = ${uid} 已包含 ${EXPERT}`);
    unchanged += 1;
    continue;
  }

  if (checkOnly) {
    console.log(`  + ${uid} 将${existed ? '追加' : '新建'} ${EXPERT}`);
    if (existed) appended += 1;
    else created += 1;
    continue;
  }

  mkdirSync(join(customRoot, uid), { recursive: true });
  writeFileSync(file, `${JSON.stringify([...list, EXPERT], null, 2)}\n`, 'utf8');
  console.log(`  + ${uid} ${existed ? '追加' : '新建'} ${EXPERT}`);
  if (existed) appended += 1;
  else created += 1;
}

console.log(
  `\n汇总：新建 ${created} · 追加 ${appended} · 已存在 ${unchanged} · 跳过 ${skipped}`,
);
if (!checkOnly) {
  console.log('切换账号后若专家中心仍看不到「青笺研发团」，重跑本脚本；新账号首次登录后也需重跑。');
}
if (skipped > 0) process.exit(1);
