# Codex 版分派工作流（qing-cx-*）

> 这是 `qing-dev` 主理人 P0–P6 SOP 的 Codex 语义改写版。
> WorkBuddy 版见 `experts/workbuddy/my-experts/plugins/qing-dev/agents/qing-dev-team-lead.md`。

## 编排模型差异

| WorkBuddy 专家团 | Codex CLI |
|---|---|
| 主理人 `TeamCreate` 建团 | 主线程直接用 `spawn_agent` 拉起子智能体 |
| 成员经 `SendMessage` 回传主理人 | 主线程用 `wait_agent` 收集结论 |
| 共享任务列表 + owner 指派 | 主线程自行维护任务清单与文件交集 |
| 成员之间禁止直连 | 子智能体之间默认无通信，天然隔离 |
| 主理人是唯一提交者 | 主线程执行唯一一次 `git commit`（不 push） |

## P0–P6

**P0 准入**：读 `.workbuddy/memory/MEMORY.md`、`topics/`、`docs/INDEX.md` 与相关
`docs/decisions-*.md`；按 `docs/team-collaboration-spec.md` §1.2 判定 4 档工作流；
硬触发项（`src-tauri/`、`storage.ts`、持久化格式、新依赖、权限面、主题 token）命中即升级。

**P1 澄清与选型**：主线程把需求转成可判定验收条件与决策记录草案，不拉子智能体。
（Codex 侧无 `grill` / `architect` skill，这一步由用户与主线程直接完成。）

**P2 任务切分**：标准 SOP 或跨前端+Rust 时拉起 `qing-cx-architect`，产出文件级任务列表；
主线程做文件交集检查，`i18n.ts` / `App.tsx` / `index.css` / `types/` / `shellLayout.ts` 串行排他。

**P3 并行实现**：并行 `spawn_agent` 拉起 `qing-cx-frontend`，按需 `qing-cx-tauri`、
`qing-cx-visual`；每个任务提示词带硬规则摘要、目标路径、禁做清单、交接格式。

**P4 只读守门与自审**：拉起 `qing-cx-guardian`（只读），等 `IS_PASS` 与违规表都到齐。

**P5 质量验收**：拉起 `qing-cx-quality` 跑构建与 WebView2 验收链路、截图判读、
`Engineer/QA/NoOne` 路由；无 GUI 项写「需人工目视确认」。

**P6 收口**：`wait_agent` 收齐全部结论 → 决策文档 / INDEX / 日志 → 主线程唯一一次
`git commit`（`feat(scope): 中文摘要`，**不 push**）。用户下达发版指令时才拉 `qing-cx-release`。

## 铁律（Codex 版）

1. 主线程是唯一编排者、唯一提交者与唯一放行责任人，不代写任何子智能体的专业产出。
2. 所有跨角色信息经主线程汇总后再传给下一阶段；子智能体不互相直连。
3. 未完成前序阶段不得跳到后续阶段；门禁结论未到齐不得收口。
4. 共享面一次只交给一个子智能体，避免并行写覆盖。
5. 每阶段结束向用户简要通报；失败项与未验证项全部显式列出，不隐藏。
6. 只读角色（`qing-cx-guardian`、`qing-cx-visual`）调用时须显式要求不写文件。
7. 本机无 GUI：拖拽、流式、滚动时序、IME、托盘、多窗口一律「需人工目视确认」。

## 单角色直调

| 需求 | 直接拉起 |
|---|---|
| 只查硬规则违规 | `qing-cx-guardian` |
| 只跑构建与 WebView 验收 | `qing-cx-quality` |
| 只判视觉 token / 对比度 | `qing-cx-visual` |
| 只拆文件级任务 | `qing-cx-architect` |
| 综合性改动 | 走完整 P0–P6 |
