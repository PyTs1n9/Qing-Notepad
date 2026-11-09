# 决策：多智能体分派工作站（agent dispatch）

> **TL;DR**：可落地，且本工作区已跑过同一套机制。团队是**会话级运行时**，不存在常驻后台工作站；
> 能随仓库同步的只有 `AGENTS.md` 与 `docs/`（`.workbuddy/` 已被 git 忽略）。默认角色表定为
> **3 人基线 + 只读守门员 + 按需增补**，不删除任何现有角色。

## 1. 现状证据（2026-11-09 核实）

- `docs/team-collaboration-spec.md`（32.7 KB，已入库）：工作流判定表、五角色 RACI、
  `IS_PASS` / QA 路由门禁、DoR/DoD、并行边界 R1–R4 —— 规则层已完备。
- `~/.workbuddy/teams/` 下 7 个历史团队，其中 `software-changelog-refactor` 的 `cwd` 为
  `d:\Code\Qing-Notepad`，成员含 `team-lead` / `software-engineer` / `software-qa-engineer`，
  逐成员写有 `agentType`、`role`、`prompt`、`cwd`。运行层已验证可用。
- 历史用量：主理人 7/7、工程师 8 实例（最多 2 并行）、QA 4/7、架构师 3 实例 / 7 团、
  PM 2/7、UI 模板 2/7。
- `settings.json` 中未发现默认专家/角色/选中态配置项；团队 `config.json` 带 `leadSessionId`，
  绑定单次会话。**结论：没有任何角色在每轮对话中默认生效**，每轮生效的是 `AGENTS.md` 的规则。
- `.gitignore` 第 56 行排除 `.workbuddy/`，`git ls-files .workbuddy` 为空。

## 2. 三条不可逾越的边界

1. 团队实例是会话级运行时（`~/.workbuddy/teams/<name>/` 下 `config.json` / `runtime.json` /
   `inboxes/`），不能配置成跨会话常驻的后台进程；跨会话只保留 `docs/decisions-*` 的结论。
2. 子智能体角色靠「名称 + 提示词 + 权限约束」定义，只能复用系统已注册的类型，
   不能在工作区注册新类型；也不要手改 `~/.workbuddy/plugins/cache/experts/` 下的缓存包
   （更新会被覆盖，自定义专家包应走专家包管理流程）。
3. 项目级 skill 只在本机生效。要随 GitHub/Gitee 同步，规则必须写进已入库的 `AGENTS.md` 与 `docs/`。

## 3. 方案对比（architect 固定模板）

| 维度 | A 零配置直接用 | B 固化到工作区 | C 可视化看板 |
| --- | --- | --- | --- |
| 技术栈 | 现有会话编排 + 协作规范 | `AGENTS.md` + `docs/` + 本机项目级 skill | 本地 HTML 看板 / 资料库工作台 |
| 为什么适合 | 规则已齐备，起团队即可 | 规则随仓库走，双端同步 | 状态直观 |
| 开发难度 | 无 | 低（3 个文本文件） | 高，需桥接运行时 |
| 维护成本 | 每轮手写提示词，口径易漂 | 只维护一处规则 | 看板与团队状态双份对账 |
| 目标地区可用性 | 本机 | 本机 + GitHub/Gitee | 本机 |
| 你得自己管的东西 | 每轮判定与分派 | skill 与 `AGENTS.md` 一致性 | 状态同步与失效 |
| 主要风险 | 轮次多了返工 | `.workbuddy/` 不入库，换机需重建 | 只能看，不能下发子智能体 |

**推荐：方案 B**（用户 2026-11-09 选定）。决定性理由：本仓库已把协作规则定为文档真源
（`docs/INDEX.md` 真源排序），B 是唯一同时满足「可复用 + 随仓库同步 + 零新依赖」的路径；
C 无法真正下发任务，收益不抵维护成本。三方案均不引入新依赖、无定价与地区可用性问题。

## 4. 结论

- **D1｜分派入口分两层**：`AGENTS.md` 与 `docs/` 是随仓库走的规则真源；
  `.workbuddy/skills/qing-dispatch/SKILL.md` 是本机便利入口（git 忽略，换机重建）。
  理由：这是唯一能让规则双端同步、又不把本机路径写进仓库的划分。
- **D2｜主代理是唯一提交者与唯一构建验收者**。理由：本仓库每轮改动必须 commit，
  且进 `dist` 的改动要跑 build + WebView 验收；多成员同时构建会争用 exe 锁，
  多个提交者会让 `git status` 在途改动失控（规范 §3.4 R4）。
- **D3｜角色表 = 3 人基线 + 只读守门员 + 按需增补，不删除现有角色**。
  理由见 §5；规范 §1.2 已用工作流判定实现按需拉起，删角色只减少覆盖面。
- **D4｜跨成员信息必经主代理中转，共享面串行排他**。理由：规范铁律①与 R1/R3，
  两个成员同时写同一文件会静默覆盖（本仓库已发生过）。
- **D5｜多智能体不替代 `grill` / `architect`**。理由：这两步仍由主代理在起团队前完成，
  否则会出现「架构师子智能体」与 `architect` 产出两套方案。

## 5. 角色增减结论（2026-11-09）

| 角色 | 结论 | 理由 |
| --- | --- | --- |
| 主理人 / 工程师 / QA | 保留为默认 3 人基线 | 历史 7/7、8 实例、4/7；QA 强化为验收官，负责截图判读与未验证项标注 |
| 架构师 | 降为按需，与 `architect` 二选一 | 每轮已有 `architect` + 40 余篇 decisions 文档 |
| PM | 降为按需，默认不拉 | 单人维护，需求由用户 + `grill` 给出，历史仅 2/7 |
| `repo-guardian`（只读，新增） | **新增，交付前必跑** | 本项目大量「tsc/构建零信号」静默坑；只读核对硬规则、共享面冲突、在途改动、发版三处同步 |
| `tauri-engineer`（按需，新增） | **新增** | 硬触发项第一条是「触及 `src-tauri/` 必须升级」，软件团队模板无 Rust 专精 |
| UI 三人模板 | 保留为独立可选模板 | 视觉硬规则密集，但不并入默认团队 |
| 删除 | **不推荐删除任何角色** | 判定表已能裁剪人数 |

## 6. 落地清单

1. `.workbuddy/skills/qing-dispatch/SKILL.md`（本机，不入库）
2. `AGENTS.md` → `## Multi-Agent Dispatch (Required)`（入库）
3. `docs/decisions-agent-dispatch.md`（本文）+ `docs/INDEX.md` 导航一行（入库）
4. `git commit`，**不 push**；等用户确认本地构建验收通过后 `git pushall`

本次改动只涉及 `AGENTS.md` 与 `docs/` 的叙述性内容，不进 `dist`，
按 `AGENTS.md` 的触发条件**跳过** build + WebView 验收。

## 7. 开放问题

1. `docs/team-collaboration-spec.md` 的 §2.1 RACI 表是否同步更新为本文 §5 的角色表？
   本次**未改**该表，仅在分派入口与本文落地，避免单方面改动 32.7 KB 核心规范。
2. 默认团队规模是否固定 3 人基线（当前默认），还是按 §1.2 判定自动扩到 5 人？
3. 是否需要跨会话保留团队状态？原生不支持，当前口径是只保留 `docs/decisions-*` 结论。
