# docs 索引 —— 一页导航

> 字节数取自文件本身（KB ≈ 1024 B）。每篇只给 3 行以内摘要 + 何时读。

## 这套文档怎么用

1. **两类文档，别混着读**：`decisions-*` 是**结论真源**（改代码前必读）；`prompt-*` / `prompts-*` 是**一次性任务书**，
   写完就过期，只在要复盘"当初为什么这么写"时回看。
2. **现状真源排序**：`.workbuddy/memory/MEMORY.md`（硬规则）> `topics/`（机制细节）> `docs/decisions-*`（决策原文）> 日志（历史）。
   与代码不一致时**以代码为准**，并在决策文档里补一行偏差。
3. 大篇目顶部有 `> **TL;DR**`：先看它决定要不要往下读。
4. 分析类（`analysis-*`）只给判断和取舍，不含实现代码；数字分［官］/［研］/［估］三档，引用前看其口径表。
5. 专题按「新人上手 → 日常开发 → 专题/存档」排；下面最后那张表按"要改什么"直达。
6. 插件的完整方案文档（plan-plugin-system）已在实现时删除（git 状态 `D`，用户在途决定，**勿恢复、勿提交**）；
   其结论已并入 `decisions-plugin-system.md` 与 `verification-plugin-l1.md`，这两篇是插件的现行依据。

## 1. 新人上手

| 文档 | 摘要 | 什么时候读它 | 大小 |
| --- | --- | --- | --- |
| `user-manual.md` | 面向用户的功能手册：界面四区、笔记/待办/画布/便签、主题与 AI。也是 AI 检索语料之一 | 第一次接触产品，或改了用户可见功能要同步它 | 7.5 KB |
| `user-faq.md` | 「小青」问答语料，`## Qn｜question` 即分块边界 | 改 AI 检索语料、加用户问答 | 6.0 KB |
| `online-workspace.md` | Supabase 初始化步骤与工作台部署顺序 | 要摆在线工作台 / 跑 migration 时 | 3.3 KB |
| `release-notes-titlebar.md` | 顶栏改版的用户侧迁移对照表（旧入口 → 新入口） | 写发布说明、或被问"某个功能去哪了" | 3.6 KB |

## 2. 日常开发（决策记录 = 结论真源）

### 2.1 布局与视觉

| 文档 | 摘要 | 什么时候读它 | 大小 |
| --- | --- | --- | --- |
| `decisions-layout-unification.md` | 待办与云端工作台对齐笔记页的三卡外壳（todo 已落地，workspace 当时待做） | 动任一视图的外壳结构 | 12.1 KB |
| `decisions-note-tabs.md` | 笔记标签栏：多标签、拖拽实时换位（本地 `dragOrder`）、Ctrl+W 关闭 | 动标签栏 / 拖拽手感 | 15.1 KB |
| `decisions-topbar-menus.md` | 顶栏三菜单（工具/传送门/帮助）的上线级审计与收敛结论 | 动顶栏菜单、传送门入口 | 13.0 KB |
| `decisions-file-tree.md` | 侧栏改开发工具风格文件树 + 右键菜单承载重命名/置顶/删除 | 动侧栏树、右键菜单 | 8.9 KB |
| `decisions-sidebar-collapse.md` | 拖拽越过阈值即折叠侧栏（240/180 双档） | 动侧栏宽度 / 折叠行为 | 4.1 KB |
| `decisions-glass-layering.md` | 有壁纸时主卡更透、侧栏更深的分层规则 | 动磨砂 tint 分层 | 3.7 KB |
| `decisions-glass-blur.md` | 磨砂"滑块没反应"四轮排查的最终结论（含构建期前缀折叠） | 动 blur/saturate、或怀疑磨砂失效 | 4.2 KB |
| `decisions-ui-polish.md` | **0.6.2 结论唯一真源**：前景 token、动效三曲线、滚动条、字体闸门、sash 三版定稿 | 改主题色 / 动效 / 滚动条 / 空态 | 15.9 KB |
| `decisions-colour-contrast.md` | 拆 `--color-accent`（填充）与 `--color-accent-text`（文字），muted 重定、审计扩到五组口径 | 改任何颜色 token、扩审计 | 9.6 KB |
| `decisions-workspace-dashboard.md` | 工作台默认停概览、四块只读统计、子窗口统一 `ModalShell`、概览设计语言推广 | 动工作台 / 任何弹窗壳 | 19.7 KB |

### 2.2 功能模块

| 文档 | 摘要 | 什么时候读它 | 大小 |
| --- | --- | --- | --- |
| `decisions-ai-integration.md` | AI 双模型 + 本地 RAG（BM25+向量 RRF）+ 润色 + Key 走 DPAPI 的总决策 | 动 AI 检索、润色、模型选择 | 29.2 KB |
| `decisions-ai-api-settings.md` | API 接口改"用户自配 + 搜索模型 + 勾选启用"（BYOK） | 动端点配置 / `ai/endpoints.json` | 6.1 KB |
| `decisions-ai-channel-conversations.md` | 会话按接口（渠道）隔离：`endpointId` + `conversationScope.ts` 三条规则 | 动会话切换、换模型、删端点 | 4.1 KB |
| `decisions-ai-note-write.md` | AI 改笔记的两档权限（`noteWriteMode`）+ Tool Calling 边界 | 动 `noteWrite.ts` / 权限闸门 | 6.7 KB |
| `decisions-ai-conversations.md` | AI 侧栏多会话：新建/切换/历史 | 动会话列表 | 2.2 KB |
| `decisions-ai-autoscroll.md` | 流式滚动跟随失效的根因（160ms 防抖渲染晚于滚动） | 动消息滚动跟随 | 1.8 KB |
| `decisions-ai-sidebar-redesign.md` | AI 侧栏布局去"AI 化"、组件重排 | 动 AI 侧栏结构 | 2.6 KB |
| `decisions-ai-optimization.md` | AI 模块四方向审查结论（功能/性能/观感/可靠），先立基线再优化 | 大改 AI 模块前看基线数字 | 9.1 KB |
| `decisions-subtodo.md` | 待办子任务的数据结构与交互 | 动待办数据模型 | 5.3 KB |
| `decisions-recycle-bin.md` | 笔记回收站的删除/恢复语义 | 动删除逻辑 | 5.8 KB |
| `decisions-export-docx-pdf.md` | 导出 Word/PDF 的选型与前置结论 | 动导出格式 | 5.0 KB |
| `decisions-plugin-system.md` | 插件机制 D1–D7：双轨运行、A 档贡献点、中央索引、手动更新、`apiVersion` | 动插件机制的任何决策 | 6.2 KB |

## 3. 专题（分析与评审）

| 文档 | 摘要 | 什么时候读它 | 大小 |
| --- | --- | --- | --- |
| `plugin-guide.md` | **插件入门**：加了什么功能、怎么维护、怎么装插件、怎么开发插件（含 API 速查与最小示例） | 想写插件 / 想知道插件能干什么 | 8.5 KB |
| `verification-plugin-l1.md` | L1 插件**实测**做了什么：Worker 隔离、两阶段安装、权限闸门、CSP 只在 release 生效、14 项验收 | 动 `src/plugin/`、`src-tauri/plugin*.rs` | 13.9 KB |
| `analysis-extension-host.md` | 把 Worker 插件扩成 VS Code 式扩展宿主的取舍：不自带 Node、P0–P2 分期、CM6 七条硬约束 | 读插件 P1a 取舍（编辑器 API 已交付、独立宿主 P1b 未做） | 27.8 KB |
| `analysis-vscode-extension-ecosystem.md` | VS Code 扩展生态五维分析：规模、蠕虫事件、安装量陷阱、命名空间抢注 | 评审插件分发/更新策略时 | 21.2 KB |
| `review-performance-security.md` | 2026-10-24 性能与安全静态审查（P0/P1 分级清单） | 查安全边界、`fs:scope`、CSP 的来历 | 18.7 KB |
| `verify-batch3.md` | 批次 3 验证报告：CSP + capability 收紧的静态/构建期/探针结果 | 改 CSP 或 capability 时对照 | 11.4 KB |
| `verify-batch4.md` | 批次 4 验证报告：协作服务器限流与鉴权加固 | 动 `collab-server/` | 5.6 KB |
| `test-plan-ai-optimization.md` | AI 优化的验收清单（每项给"失败特征"） | 回归 AI 优化改动 | 4.8 KB |
| `plan-ai-capability-expansion.md` | AI 能力扩展路线图（第一波已定范围，未动代码） | 规划 AI 新能力时 | 12.2 KB |

## 4. 存档：不要当现状读

| 文档 | 摘要 | 什么时候读它 | 大小 |
| --- | --- | --- | --- |
| `prompt-workspace-shell-and-glass.md` | 工作区「三浮卡 + 毛玻璃」重构任务书（含 D10 冲突裁决顺序） | 只在复盘壳层来历 | 36.7 KB |
| `prompts-fix-performance-security.md` | 性能安全修复四批次投喂提示词（依赖顺序不可跳） | 只在复盘修复批次 | 26.0 KB |
| `prompt-ui-polish.md` | 0.6.2 美化执行提示词（派生自 `decisions-ui-polish.md`，冲突以决策为准） | 已执行完，存档 | 18.6 KB |
| `prompt-workspace-dashboard.md` | 工作台概览执行提示词（派生自 `decisions-workspace-dashboard.md`） | 已执行完，存档 | 22.5 KB |
| `prompt-workspace-layout-round1.md` | 第二阶段「工作台/画布对齐笔记页外壳」任务书 | 已执行完，存档 | 8.8 KB |
| `prompt-todo-sidebar-round4.md` | 待办左栏第 4 轮交互修复任务书（定稿，勿回改） | 只在复盘待办左栏 | 6.5 KB |
| `plan-topbar-menus.md` | 顶栏改造的可执行方案（配套 `decisions-topbar-menus.md`） | 已执行完，存档 | 11.9 KB |

> **注意**：`prompt-*` / `prompts-*` 里写的行号、文件名会漂移，`verification-plugin-l1.md` 明确记过
> "与提示词的偏离"——**以偏离记录为准**。

## 我想改 X → 先读哪篇

| 我想改 | 先读 | 再读 |
| --- | --- | --- |
| 主题色 / 配色 / 对比度 | `decisions-ui-polish.md`（D1/D11） | `decisions-colour-contrast.md` + `topics/tokens-colour.md` |
| 磨砂 / 玻璃 / 壁纸 | `decisions-glass-layering.md` | `decisions-glass-blur.md`（四轮排查结论） |
| 顶栏 / 菜单 / 传送门 | `decisions-topbar-menus.md` | `release-notes-titlebar.md`（用户口径） |
| 侧栏 / 文件树 / 右键 | `decisions-file-tree.md` | `decisions-sidebar-collapse.md` + `topics/layout.md` |
| 笔记标签栏 / 拖拽 | `decisions-note-tabs.md` | `topics/ui-rules.md` |
| 待办 / 子任务 / 描述 | `decisions-subtodo.md` | `topics/ui-rules.md`（横线本与行几何） |
| 动画 / 曲线 / 滚动条 | `decisions-ui-polish.md`（D5–D7/D10） | `topics/ui-rules.md` |
| AI 栏 / 模型选择 / 润色 | `decisions-ai-integration.md` | `topics/ai-module.md` |
| AI 端点 / API Key | `decisions-ai-api-settings.md` | `topics/ai-module.md` |
| AI 会话 / 切换模型 | `decisions-ai-channel-conversations.md` | `decisions-ai-conversations.md` |
| AI 写笔记 / 权限 | `decisions-ai-note-write.md` | `topics/ai-module.md` |
| 工作台 / 概览 / 弹窗 | `decisions-workspace-dashboard.md` | `decisions-layout-unification.md` |
| 想开发插件 / 装插件 | `plugin-guide.md` | `examples/*/src/qing.d.ts` |
| 插件机制 / 权限 / 安装 | `verification-plugin-l1.md` | `decisions-plugin-system.md` + `topics/plugin-system.md` |
| 插件 API / 编辑器 / CM6 | `analysis-extension-host.md`（P1a）——编辑器 API 是 **CodeMirror 6** 映射：`getText(range?)` / `getSelection()` / `replace()` / `setDecorations()`，权限 `editor:read\|write\|decorate`（`setSelection` 不在交付物，新码 `editor:selection` 排 P1a-2） | `analysis-vscode-extension-ecosystem.md` |
| 数据目录 / 迁移 / 图片 | `review-performance-security.md` | `topics/env.md` |
| CSP / capability / `fs:scope` | `verify-batch3.md` | `review-performance-security.md` |
| 导出 / PDF / Word | `decisions-export-docx-pdf.md` | `user-manual.md` |
| 发布 / tag / CI | （不在 docs）`topics/git-release.md` | `topics/verify-runbook.md`（产物与验收） |
