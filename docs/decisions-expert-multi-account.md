# 决策：让多个账号共用 qing-dev 专家团

> **TL;DR**：专家包的全局层本来就是共享的，唯一按账号隔离的是
> `~/.workbuddy/experts/custom/<uid>/experts.json`。采用**无新依赖的幂等脚本**
> 把 `qing-dev` 追加到本机每个已知账号的这份清单里；不引入常驻任务、不改运行时代码。
> 新账号首次登录后重跑脚本一次。

## 1. 背景与已核实事实（2026-11-09）

| 层 | 路径 | 是否按账号隔离 |
|---|---|---|
| 提示词真源 | `docs/agents/*.md` | 否，仓库内 |
| 项目内专家包 | `experts/workbuddy/my-experts/plugins/qing-dev/` | 否 |
| 目录联接 | `~/.workbuddy/plugins/marketplaces/my-experts` → 项目包 | 否，全局 |
| 市场清单 | `my-experts/.codebuddy-plugin/marketplace.json` | 否，全局 |
| 安装记录 | `installed_plugins.json`（`qing-dev@my-experts`）、`known_marketplaces.json` | 否，全局 |
| 运行时缓存 | `plugins/cache/my-experts/qing-dev/1.0.0/` | 否，全局 |
| **我的专家清单** | **`experts/custom/<uid>/experts.json`** | **是，per-uid** |

本机当时有 4 个账号 uid（`user-*-personal` 目录）：`06900c75`、`3d408293`、
`c1f72c8c`、`cab2c573`；而 `experts/custom/` 下只有 `3d408293` 一份 `["qing-dev"]`，
该 uid 正是 `settings.json` 里的 `legacyOwnerUid`。当前会话账号 `06900c75` 因此看不到专家团。

`expert-manager/scripts/register_expert.py` 的实际行为已读源码确认：它只更新
`marketplace.json`，并在带 `--session-id`/`CODEBUDDY_SESSION_ID` 时写
`.created-by-session`；**不写** `experts/custom/<uid>/experts.json`。脚本自身也警告
「no session id found; it may not appear in My Experts for the current user automatically」。
结论：重复跑注册脚本无法解决多账号问题，必须在 per-uid 层补齐。

## 2. 约束（本轮已确定）

- **使用地区 / 平台**：中国大陆，单机 Windows 桌面应用，无外部服务与网络依赖。
- **规模**：一台机器上少量账号切换使用，不要求多实例真并发。
- **数据**：纯本地 JSON 文件；无登录、无云同步、无多人协作。
- **用户可维护**：资深维护者，能运行 Node 脚本、理解 `%USERPROFILE%/.workbuddy` 结构。
- **预算 / 硬约束**：零持续成本；不新增依赖、不引入常驻进程；不得改动内置
  `software-company` 缓存包；每轮改动 commit、不 push。

## 3. 方案对比

### 方案 A：Node 原生 fs 幂等追加脚本（boring technology）

- **技术栈**：Node.js 内置 `fs` / `os` / `path`，一个 `.mjs` 脚本；仓库已有同类脚本
  （`ensure-expert-junction.mjs`、`sync-expert-agents.mjs`），风格与运行方式一致。
- **为什么适合**：改动面恰好等于断点（每个 uid 一个数组），无新依赖、无权限提升、
  无网络；脚本幂等、只追加不删除，可反复运行。
- **开发难度 / 维护成本**：约 100 行；维护成本仅为「新增账号后重跑一次」。
- **目标地区能否顺利使用**：能，纯本地文件操作，不受地区与网络影响。
- **你得自己管的东西**：新账号首次登录后手动跑一次；WorkBuddy 升级若改变
  `experts/custom` 结构，需要同步更新脚本。
- **主要风险**：`experts.json` 由运行时写入，静态检查无法确认切换账号或升级时是否覆写；
  需人工切账号实测。若与应用并发写同一文件，理论上存在极小竞态窗口。

### 方案 B：方案 A + 周期性自动同步

- **技术栈**：方案 A 加一个定时自动化任务，按固定间隔扫描并补齐。
- **为什么适合**：新账号无需人工干预。
- **开发难度 / 维护成本**：多一层调度状态；需要监控任务是否仍在运行。
- **目标地区能否顺利使用**：能，但自动化依赖应用自身的调度服务可用性。
- **你得自己管的东西**：任务生命周期、日志、与应用同时写 JSON 的冲突处理。
- **主要风险**：常驻任务与 WorkBuddy 并发写同一份 `experts.json`，可能互相覆盖；
  为一个低频动作引入常驻进程，收益不抵复杂度。用户已明确否决常驻任务。

### 方案 C：不改全局配置，每个账号在专家中心手工启用

- **技术栈**：无。
- **为什么适合**：零代码、零风险。
- **开发难度 / 维护成本**：每次切换账号都要人工操作；当前账号列表为空时可能连入口都没有。
- **目标地区能否顺利使用**：能。
- **你得自己管的东西**：记住每个账号都要点一次。
- **主要风险**：账号一多必然漏配；无法解释「为什么有的账号看得到、有的看不到」。

## 4. 推荐与理由

**推荐：方案 A。** 决定性理由：断点是唯一一个 per-uid 数组文件，用幂等只读-追加脚本
即可精确修复，且不触碰运行时、不引入新依赖或常驻进程；方案 B 为低频动作引入并发写风险，
方案 C 不可重复、不可解释。用户 2026-11-09 已按此确认（切换使用 + 手动重跑 + 允许写入）。

## 5. 落地内容

- `scripts/sync-expert-accounts.mjs`：扫描 `user-<uid>-personal` 与已有
  `experts/custom/<uid>` 目录，合并去重后逐账号补齐；支持 `--check` 与 `--uid`。
  已有条目一律保留，文件无法解析时跳过并报错退出。
- `experts/README.md`：把本脚本加入固定流程，并说明按账号清单这一层。
- 不修改 `~/.workbuddy/settings.json` 的 `enabledPlugins`：专家中心可见性由
  per-uid 清单决定，改全局启用开关缺乏证据且会波及所有插件。
- 不写 `.created-by-session`：它绑定单次会话 ID，易变且不适合入库；可见性由
  per-uid 清单保证。

## 6. 仍待验证 / 待定问题

1. **运行时是否会覆写 `experts.json`**：需要切换账号后实测。若被覆写，则需回到
   `register_expert.py --session-id` 路线重新评估，或把补齐动作挂到登录后时机。
2. **多实例真并发**：本轮明确不做。若后续需要，必须额外处理全局
   `marketplace.json` / 缓存的写竞态（运行时还存在删除 `settings.json` 的行为）。
3. 其余无。

## 7. 验证步骤（人工）

1. `node scripts/sync-expert-accounts.mjs --check` 应为零差异。
2. 退出当前账号，登录另一个 uid，打开左侧「专家」→ 我的专家，应能看到「青笺研发团」。
3. 逐个账号重复；若某个账号看不到，重跑脚本后重启该账号的 WorkBuddy 再确认。
