# 决策：重制工作角色与完整工作流（qing-dev 专家团）

> **TL;DR**：内置专家团是下载缓存，**不能原地重制**；改为在 `my-experts` 下新建 Team 型自定义专家团
> `qing-dev`。角色去留由用户逐岗 1 对 1 裁决（4 轮 16 问），最终 **4 常设 + 4 按需**，
> 花名亦由用户逐岗指定。系统提示词以 `docs/agents/` 为唯一编辑真源，单向同步到已注册的专家包。

## 1. 背景与边界（已核实）

- `software-company@experts` 位于 `~/.workbuddy/plugins/cache/experts/software-company/1.1.0/`，是下载缓存；
  直接改会在更新时被覆盖。专家包规范要求生成到 `my-experts/plugins/`，其他目录不会被检测到。
  本轮之前 `my-experts/plugins/` 为空，无同名冲突。
- 判定：`expertType = team`（多角色协作）、`categoryId = 02-Engineering`（主要输出物为代码 / 架构 /
  验收结论，服务开发者）。三方案选型（零配置 / 固化到工作区 / 可视化看板）沿用
  `docs/decisions-agent-dispatch.md` §3，本轮选的是「新建自定义专家团」，不引入新依赖。
- `validate_expert.py` 对头像只告警不阻断（`avatars/.gitkeep` 存在即可），用户决定暂不生成头像。
- 注册清单实际路径是 `my-experts/.codebuddy-plugin/marketplace.json`（不是市场根目录）。

## 2. 逐岗过问结论（4 轮 16 问，用户裁决）

| 轮次 | 岗位 | 结论 | 理由（用户取向 / 项目约束） |
|---|---|---|---|
| 1 | A1 主理人 | 设独立主理人 | 唯一提交者、唯一验收者、消息必经中转 |
| 1 | A2 需求澄清 | 由用户 + 主理人承担，不设岗 | 单人维护，需求由用户直接给出 |
| 1 | A3 技术选型 | 并入主理人 | `AGENTS.md` 已规定每轮 `architect` 由主代理跑 |
| 1 | A4 架构与任务拆分 | 按需独立 | 仅跨前端+Rust / 新依赖 / 改数据格式时拉起 |
| 2 | B1 前端工程师 | 独立常设 | `src/` 是改动量最大的实现面 |
| 2 | B2 Rust/Tauri | 按需独立 | 硬触发项第一条是「碰 Rust 必须升级」，但非每轮都碰 |
| 2 | B3 UI/视觉 | 按需独立 | 纯视觉改版时拉起 |
| 2 | B4 插件与权限 | 并入 Rust 岗 | 落点集中在能力配置与 Rust 侧 |
| 3 | C1 规则守门员 | 独立常设且只读 | 「tsc / 构建零信号」静默坑需要专门一道闸 |
| 3 | C2 构建验收官 | 独立常设 | 验收链路长且证据要求严格 |
| 3 | C3 回归 QA | 与验收官合并 | 减少编制 |
| 3 | C4 文档与记忆 | 并入主理人 | 收口时主理人掌握全部结论 |
| 4 | Q13 质量口径裁定 | **一个独立常设质量角色**（验收链路 + 回归路由） | 取 C2「独立常设」与 C3「合并」的交集，用户裁定 |
| 4 | B5 数据存储安全 | 并入 Rust 岗 | `storage.rs`、指针、原子写回都在 Rust 侧 |
| 4 | C5 发版专员 | 按需独立 | 仅在「开始发行最新版vX.Y.Z」时拉起 |
| 4 | C6 Git 仓库管理 | 并入主理人 | A1 已定其为唯一提交者 |

**展示与落地三项**：保留内置专家团（可随时切回）；系统提示词双份入库并附同步脚本；头像暂不生成。

## 3. 最终角色表与花名（用户逐岗指定）

| Agent ID | 花名（zh / en） | 职业 | 编制 |
|---|---|---|---|
| `qing-dev-team-lead` | 柏青 / PyTsING | 交付调度总监 | 常设（主理人） |
| `qing-dev-frontend-engineer` | 前端大佬 / Frontend Chief | 前端工程师 | 常设 |
| `qing-dev-rule-guardian` | 仓管 / Repo Keeper | 仓库规则守门员 | 常设（只读） |
| `qing-dev-quality-officer` | Webview大佬 / WebView Chief | 质量与验收官 | 常设 |
| `qing-dev-architect` | 架构大佬 / Architecture Chief | 架构与任务拆分师 | 按需 |
| `qing-dev-tauri-engineer` | Rust大佬 / Rust Chief | Rust 外壳工程师 | 按需 |
| `qing-dev-visual-designer` | 视觉大佬 / Visual Chief | 视觉系统设计师 | 按需 |
| `qing-dev-release-steward` | 发版大佬 / Release Chief | 发版专员 | 按需 |

> **规范偏离（已如实告知用户）**：除「柏青」外，花名多为职能称谓而非三字人名，
> 主理人英文名是账号 ID 而非拼音姓氏，与 `references/team-spec.md` 的花名规范不符。
> `validate_expert.py` 不校验此项，**不影响注册与使用**；影响专家中心卡片观感与未来上架审核。
> 用户明确要求按自己的命名写入，故原样落地。

## 4. 端到端工作流（写进主理人提示词）

P0 准入（读 MEMORY.md / topics / INDEX / decisions → `grill` → `architect` → 4 档工作流判定 → 硬触发项升级）
→ P1 澄清与选型（主理人亲自，不 spawn）
→ P2 任务切分与文件交集检查（按需架构师；共享面串行排他）
→ P3 并行实现（前端常设 + Rust/视觉按需；每个任务提示词带硬规则摘要、目标路径、禁做清单、交接格式）
→ P4 只读守门 + 工程师 `IS_PASS` 自审
→ P5 质量验收（构建链路 + 截图判读 + `Engineer/QA/NoOne` 路由）
→ P6 收口（解散团队 → 决策文档 / INDEX / 日志 → 唯一一次 commit 不 push → 可选发版专员）

主理人提示词另含协作四铁律、五条红线、成员能力清单、4 条预设 Workflow 与单 agent 直调路由表。

## 5. 系统提示词的定制要点

每个角色的正文都内嵌了本仓库「tsc / 构建零信号」的硬规则，而非通用软件工程套话：

- **前端**：28px 双带、`posAtCoords(视口顶+14)`、`text-accent-text`、`:root.theme-x`、
  选区 `z-index:1 + pointer-events:none`、flex 禁 `w-auto`、空态早返回 hook 位置、磨砂分层、i18n 双表。
- **Rust**：数据目录指针只由 `storage.rs` 读写、缺失抛 `DATA_DIRECTORY_UNAVAILABLE`、
  外部 md 哈希比对 + 原子写回 + 源文件权威、窗口几何只在 Rust 且压边容忍 ≥22 物理像素、
  `show → unminimize → setFocus`、灰度抗锯齿只追加不覆盖、NSIS `OpenWithProgids`、插件 blob Worker 边界。
- **守门员**：13 项只读核对表（含 `git status` 在途改动、发版三处同步）。
- **验收官**：`verify:webview:status` 三分支、PowerShell 构建、探针 `--no-assert`、
  常驻窗口不许 kill、无 GUI 项写「需人工目视确认」。
- **视觉**：模糊可见度 ≈ 1 − tint、禁抬 tint 换对比度、sash 禁 `filter: blur`、
  主题 token 覆盖顺序、CSS 压缩语义变化需用 `dist` 复测。
- **发版专员**：Runbook 8 步、三处文案同提交、`version:set` 改 5 文件、UTC `publishedAt`、
  tag 只推 GitHub 触发 CI、代理端口每次会话可能变化。

## 6. 落地清单

| 位置 | 内容 | 是否入库 |
|---|---|---|
| `my-experts/plugins/qing-dev/` | 运行副本：`plugin.json`、`agents/*.md` (8)、`settings.json`、`README.md`、`avatars/.gitkeep` | 否（用户目录） |
| `docs/agents/*.md` | **唯一编辑真源**，与上者同内容 | 是 |
| `scripts/sync-expert-agents.mjs` | 单向同步：校验 frontmatter name / 禁 `tools` / 数量 8 → 覆盖专家包 `agents/` | 是 |
| `docs/decisions-custom-expert-team.md` | 本文 | 是 |
| `docs/INDEX.md` | 导航两行 | 是 |
| `.workbuddy/skills/qing-dispatch/SKILL.md` | 改为薄适配层，指向新专家团，避免两套分派源冲突 | 否 |
| `~/.workbuddy/plugins/cache/my-experts/qing-dev/<version>/` | **启用时的安装副本**：`installed_plugins.json` 的 `installPath` 指向它，WorkBuddy 从这个已安装插件加载角色定义 | 否 |

> **启用时的读取路径（2026-11-09 核实）**：专家选择器的 `localPath` 指向注册源目录
> （`marketplaces/my-experts/plugins/qing-dev`），而已安装插件的 `installPath` 指向缓存目录
> （`plugins/cache/my-experts/qing-dev/1.0.0`）。两处都会被用到，且 `docs/agents/`（D 盘仓库）
> **不参与运行时读取**，它只是编辑真源。两处内容不一致会导致「改了提示词但启用时没变化」。

修改提示词的正确顺序：改 `docs/agents/*.md` → `node scripts/sync-expert-agents.mjs`
（同时刷新注册源目录与所有缓存版本目录，并镜像展示元数据）→
`validate_expert.py` → `register_expert.py` → `git commit`（不 push）。
若改的是展示字段（花名 / 标签 / 描述 / 推荐提示词），这些只存在于
`.codebuddy-plugin/plugin.json` 与 `README.md`，脚本会一并镜像到缓存目录。

## 7. 与既有文档的关系

- `docs/team-collaboration-spec.md` 仍是工作流判定与 RACI 的**规则真源**，本轮未改其 §2.1 表。
- `docs/decisions-agent-dispatch.md` 的**边界分析**（会话级团队、`.workbuddy/` 不入库、主代理唯一提交/验收）
  继续有效；其「3 人基线 + 按需」角色结论**已被本轮重制取代**。
- 内置 `software-company`、`ui-design-fullstack-team` 保留不动，未卸载。

## 8. 开放问题

1. 花名是否要改回符合 `team-spec.md` 的三字人名 + 拼音姓氏（当前按用户指定保留）。
2. 头像是否补齐（当前仅 `.gitkeep`）。
3. `docs/team-collaboration-spec.md` §2.1 RACI 表是否同步为本文 §3 的 8 岗口径。
4. 内置专家团是否需要卸载，还是长期保留为可回退选项。
5. 本次改动只涉及 `docs/` 与 `scripts/`，不进 `dist`，按 `AGENTS.md` 跳过 build + WebView 验收；
   若之后把提示词接进运行时，需重跑验收链路。
