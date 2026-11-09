# Codex 适配说明（qing-cx-*）

本套文件把 `qing-dev` 专家团的 8 份角色提示词转成 **OpenAI Codex CLI** 的自定义子智能体。
**这是独立适配，不是 WorkBuddy 专家包**：Codex 不认 `.codebuddy-plugin/plugin.json`、
YAML frontmatter、`marketplace.json` 注册、TeamCreate / SendMessage 编排。

本机已安装 `codex-cli 0.167.0`，项目级自定义 agent 目录为 `.codex/agents/`。

## 命名区分

| | WorkBuddy 适配 | Codex 适配 |
|---|---|---|
| 前缀 | `qing-dev-*` | `qing-cx-*` |
| 格式 | `.md` + YAML frontmatter | `.toml`（`name` / `description` / `developer_instructions`） |
| 真源目录 | `experts/workbuddy/my-experts/plugins/qing-dev/agents/` | `.codex/agents/`（由脚本生成） |
| 主理人 | `qing-dev-team-lead` | `qing-cx-lead` |

## 角色映射

| `docs/agents/*.md` | `.codex/agents/*.toml` | 编制 |
|---|---|---|
| `qing-dev-team-lead.md` | `qing-cx-lead.toml` | 常设（主线程编排者） |
| `qing-dev-frontend-engineer.md` | `qing-cx-frontend.toml` | 常设 |
| `qing-dev-rule-guardian.md` | `qing-cx-guardian.toml` | 常设（只读） |
| `qing-dev-quality-officer.md` | `qing-cx-quality.toml` | 常设 |
| `qing-dev-architect.md` | `qing-cx-architect.toml` | 按需 |
| `qing-dev-tauri-engineer.md` | `qing-cx-tauri.toml` | 按需 |
| `qing-dev-visual-designer.md` | `qing-cx-visual.toml` | 按需 |
| `qing-dev-release-steward.md` | `qing-cx-release.toml` | 按需 |

## 编排语义替换

见同目录 `DISPATCH.md`。要点：WorkBuddy 的「主理人建团 + 消息中转 + 共享任务列表」
在 Codex 里对应「主线程 `spawn_agent` 拉起子智能体、`wait_agent` 收集结论、
主线程自行维护任务清单」。每份 TOML 末尾都由构建脚本追加了一段适配注记，
说明原文中 `SendMessage` 等表述应如何理解，**不改写原文内容**。

## 32 KiB 陷阱

Codex 的 `AGENTS.md` 有约 32 KiB 上限，超出会静默截断；8 份角色正文合计约 36 KB，
**不能整包塞进根 `AGENTS.md`**。因此本适配把正文分散到各子智能体 TOML 的
`developer_instructions`，根 `AGENTS.md` 保持不动。

如需让 Codex 每次自动采用这套编排，可在根 `AGENTS.md` 追加一行（可选、非必需）：

```
需要多角色协作时，按 experts/codex/DISPATCH.md 调度 .codex/agents/qing-cx-*.toml。
```

## 重新生成

```bash
node scripts/build-codex-agents.mjs
python3 -c "import tomllib,glob; [tomllib.load(open(p,'rb')) for p in glob.glob('.codex/agents/*.toml')]"
```

脚本从 `docs/agents/*.md` 读取正文、去掉 frontmatter、追加 Codex 适配注记后写入 TOML 字面量多行字符串。
**不要手改 `.codex/agents/*.toml`**，改内容请改 `docs/agents/` 后重跑。

## 验证边界

已做：TOML 语法解析、文件数量与映射完整性、`qing-cx-*` 命名检查。
**未做**：Codex 运行时拉起子智能体的实测（需要 API 调用与真实会话），
以及 `spawn_agent` / `wait_agent` 在本机 config.toml 下的实际启用状态。
