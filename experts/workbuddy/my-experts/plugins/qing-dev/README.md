# 青笺研发团（qing-dev）

为 Qing Notepad（Tauri v2 + React 19 + TypeScript）桌面应用量身定制的多角色协作专家团。
角色划分、工作流阶段与系统提示词均由仓库所有者在 2026-11-09 逐岗位确认，不沿用内置 `software-company` 模板。

## 类型

Team 型（多角色协作团队），`categoryId = 02-Engineering`。

## 角色构成

| Agent ID | 花名 | 职业 | 编制 |
|---|---|---|---|
| `qing-dev-team-lead` | 柏青 | 交付调度总监 | 常设（主理人） |
| `qing-dev-frontend-engineer` | 前端大佬 | 前端工程师 | 常设 |
| `qing-dev-rule-guardian` | 仓管 | 仓库规则守门员（只读） | 常设 |
| `qing-dev-quality-officer` | Webview大佬 | 质量与验收官 | 常设 |
| `qing-dev-architect` | 架构大佬 | 架构与任务拆分师 | 按需 |
| `qing-dev-tauri-engineer` | Rust大佬 | Rust 外壳工程师 | 按需 |
| `qing-dev-visual-designer` | 视觉大佬 | 视觉系统设计师 | 按需 |
| `qing-dev-release-steward` | 发版大佬 | 发版专员 | 按需 |

需求澄清由用户 + 主理人承担，技术选型并入主理人，Git 纪律与文档记忆并入主理人，
插件权限与数据存储安全并入 Rust 岗，回归 QA 并入质量与验收官。

## 工作流

P0 准入判定 → P1 澄清与选型 → P2 任务切分与文件交集检查 → P3 并行实现 →
P4 只读守门 + `IS_PASS` 自审 → P5 质量验收 → P6 收口提交 / 可选发版。

## 提示词源文本

`docs/agents/`（仓库内，随 GitHub/Gitee 同步）是系统提示词的唯一编辑真源；
本包是 WorkBuddy 专家团的**项目内实体**；C 盘 `marketplaces/my-experts` 是指向本目录的
目录联接（由 `scripts/ensure-expert-junction.mjs` 检查与重建）。修改提示词请编辑 `docs/agents/*.md`，
然后在仓库根运行 `node scripts/sync-expert-agents.mjs`（会同时刷新本包与
`plugins/cache/my-experts/qing-dev/<version>/` 安装缓存），并重新运行校验与注册。
启用时 WorkBuddy 经联接读本包、并读取 C 盘安装缓存；`docs/agents/` 只是编辑真源，不参与运行时读取。

## 使用示例

- 按工作流判定本次改动该走哪条路径，并列出参与角色与可判定验收条件
- 改动能进 dist 时跑一遍完整构建与 WebView2 验收，并列出所有未验证项
- 按发版 Runbook 开始发行最新版 vX.Y.Z

## 头像

本轮按用户决定暂不生成。`avatars/.gitkeep` 保留，校验可通过。
如需补齐，按 `references/avatar-spec.md` 生成 `team.png` 与 8 张角色头像：
PNG/JPG、512×512、单张 ≤500KB、同团队画风一致（蓝紫色调，`02-Engineering`）。

## 安装与注册

```bash
python3 scripts/validate_expert.py <expert-dir>
python3 scripts/register_expert.py <expert-dir>
```

注册后在「专家中心 → 我的专家」中启用。内置 `software-company` 与
`ui-design-fullstack-team` 保留不动，可随时切回。

## 打包分享

```bash
python3 scripts/package_expert.py <expert-dir>
```
