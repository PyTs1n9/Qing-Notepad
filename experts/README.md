# 专家团适配目录

Qing Notepad 定制 8 角色协作团队的**项目内唯一真源**，按目标 agent 分成两套独立适配。
两套内容同源、命名前缀严格区分，互不覆盖。

| 目录 | 目标运行时 | 命名前缀 | 运行时读取位置 |
|---|---|---|---|
| `experts/workbuddy/my-experts/` | WorkBuddy 专家中心 | `qing-dev-*` | C 盘 `marketplaces/my-experts` 目录联接 + `plugins/cache/.../1.0.0/` 安装缓存 |
| `experts/codex/` | OpenAI Codex CLI | `qing-cx-*` | 项目根 `.codex/agents/*.toml` |

角色提示词的**唯一编辑真源**仍是 `docs/agents/*.md`（8 份 Markdown）。改完按固定顺序跑：

```bash
node scripts/sync-expert-agents.mjs       # docs/agents -> 项目内 WorkBuddy 包 + C 盘缓存
node scripts/build-codex-agents.mjs       # docs/agents -> .codex/agents/qing-cx-*.toml
node scripts/ensure-expert-junction.mjs   # 确认 C 盘联接未被 WorkBuddy 重建
python3 <expert-manager>/validate_expert.py <项目内 qing-dev 路径>
python3 <expert-manager>/register_expert.py <项目内 qing-dev 路径>
git commit                                # 不 push，等用户确认本地验收
```

## 为什么 C 盘还有东西

`expert-manager` 的 `init_expert.py` 与 `validate_expert.py` 硬检查专家必须位于
`$WORKBUDDY_CONFIG_DIR/plugins/marketplaces/my-experts/plugins/`，直接放项目内会被判定
「无法被检测到」。因此采用：**整个 `my-experts` 市场目录实体迁入项目，C 盘同名路径改为目录联接**。
这样校验脚本两侧的基准路径都会解析到项目内，校验通过。

C 盘剩余两类东西，都不是实体源文件：

1. `plugins/marketplaces/my-experts` — 目录联接（junction），0 字节实体数据。
2. `plugins/cache/my-experts/qing-dev/<version>/` — WorkBuddy 启用时自动生成的安装缓存，
   由系统控制，无法取消；`sync-expert-agents.mjs` 会把它刷新成与项目内一致。

原 C 盘实体目录已保留为 `my-experts.pre-junction-20261109` 备份，可随时回滚。

## 命名区分约定

- WorkBuddy：Agent ID / MD 文件名一律 `qing-dev-<role>`，专家包名 `qing-dev`。
- Codex：TOML 文件名与 `name` 字段一律 `qing-cx-<role>`。
- 任何文件不得同时带两个前缀；生成脚本会强制校验源文件数量与映射完整性。
