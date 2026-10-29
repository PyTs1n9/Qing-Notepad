# 知识库两项改造 —— 交接快照（2026-10-29）

> 本文件用于「暂停后重新落地」。当前代码已完整收尾，仅 QA 最后一轮复跑因频率限制（429）未执行。
> 恢复时按文末《可再次落地的提示词》继续即可，无需重头摸代码。

## 一、本次交付的两项改造

| # | 任务 | 结论 | 状态 |
| --- | --- | --- | --- |
| 1 | 知识库导入条目名称显示为 UUID | 根因：Obsidian 文件以 UUID 命名且无 H1，标题回退到文件名。已实现六级标题候选链 + 索引自动重建 | ✅ 代码完成，验证全绿 |
| 2 | 知识库左侧面板可折叠 + UI 美化 | 面板 ⇄ 左上角胶囊按钮双态，状态持久化，窄屏详情变底部抽屉 | ✅ 代码完成，验证全绿 |

## 二、改动文件清单

### 任务 1（UUID 命名修复）
- `src/utils/graph/noteTitle.ts`（新增）—— 标题规则唯一实现：`pickTitle()` 六级候选链、`fileNameTitle()`、`looksLikeCodedName()`、`readFrontmatterMeta()`、`firstReadableLine()`（两趟：≤120 字整行 / >120 字截 40 字 + `…`）、`cleanMetaValue()`（frontmatter 值清洗）
- `src/utils/graph/noteSourceAdapter.ts` —— `adaptNoteSource()` 走 `pickTitle`；`.txt` 用 `allowHeading1:false`；新增 `titleSource` 字段；`firstHeading`/`stripFrontmatter` 仍再导出
- `src/utils/graph/graphIndexer.ts` —— `fallbackTitle()` 转发 `fileNameTitle()`
- `src/utils/graph/graphIndexStore.ts` —— `GRAPH_INDEX_SCHEMA_VERSION = 3`；`deriveSnapshot` 的 `schemaVersion` 改读常量；`readMeta()` 返回 `{meta, stale}`；`load()` 在 stale 且有分片时删 `vaults/<shardKey>/`（保留 `positions.ndjson`）
- `src/types/graph.ts` —— `GraphIndexMeta.schemaVersion` 字面量 1 → 3
- `scripts/verify-graph-title.mjs`（新增，60 断言）、`scripts/verify-graph-scan.mjs`、`scripts/verify-graph-index.mjs`、`package.json`（+`verify:graph-title`）
- `docs/decisions-knowledge-graph.md` —— 末尾新增「标题候选链（2026-10-29 修订）」六节，含 §4 版本升 3 的取舍与「版本号约定」

### 任务 2（面板折叠 + 美化）
- `src/components/Graph/GraphPage.tsx` —— `panelOpen` 状态 + localStorage 持久化（`qing.graph.panelOpen`）、`OverlaySection`（模块级）、焦点交接 effect、展开态 `section#graph-overlay-panel`、收起态 rail 按钮、右侧 aside 的 `max-md:` 底部抽屉
- `src/utils/i18n.ts` —— 新增 `graphPanelTitle/Collapse/Expand/ExpandCount` 中英三处
- `src/index.css` —— `.graph-panel-in` 动画 + `prefers-reduced-motion` 豁免

### 任务 3（协作规范文档，附加交付）
- `docs/team-collaboration-spec.md`（新增）—— 角色 RACI、工作流路由、交接物格式、DoR/DoD、本仓库专属检查清单
- `docs/INDEX.md` —— 第 25 行登记该文档

## 三、验证结果（本会话最后一次实跑，均为绿）

```
verify-graph-title   60/60  PASS
verify-graph-index   70/70  PASS
verify-graph-scan   112/112 PASS
verify-graph-sync    46/46  PASS（failures: 0）
tsc --noEmit         退出码 0
```

> 注意：本机 `npm.ps1` 包装脚本损坏，`tsc` / `build` 用 `node ./node_modules/typescript/bin/tsc --noEmit` 与 `node ./node_modules/vite/bin/vite.js build` 等价命令直跑。

## 四、已知限制（已记录进决策文档，非阻塞）

- **P2-4**：同目录两个 UUID 前 8 位相同 → 画布标签同名（id 仍唯一，概率极低）
- **P2-5**：meta.json 丢失但旧分片仍在 → 旧标题保留到手动「刷新索引」自愈
- **frontmatter 是 YAML 子集**：块标量/嵌套映射被忽略（拿不到而非拿错）；不支持的就降级到下一级候选
- 本机无 GUI：画布标签观感、折叠动画、窄屏抽屉、键盘焦点等需人工目视，未验证

## 五、尚未完成的事（恢复后要做）

1. **QA 最后一轮复跑**：QA 工程师已出首轮报告（1 个 P1 + 5 个 P2），工程师已全部修复（含 schemaVersion 升 3）。QA 需对修复后代码复跑一轮确认 P1-1/P2-1/P2-2/P2-3 已闭环、P2-4/P2-5 按已知限制接受。
2. **人工目视确认**：折叠/展开动画、窄屏抽屉、键盘焦点交接、画布标签观感。
3. **团队收尾**：TeamDelete 清理团队与任务目录（当前软件-工程师-2 与软件-QA 因 429 中断）。

---

## 六、可再次落地的提示词

> 以下提示词可直接粘贴到新会话的「软件公司」专家团（主理人 = 交付总监）里，恢复本任务。

### 提示词 A —— 恢复整个任务（推荐，自包含）

```
继续 Qing Notepad 知识库两项改造的收尾。工作目录 D:/Code/Qing-Notepad，Tauri v2 + React 19 + TS。

现状（已核实，不要再从头排查）：
1. UUID 命名修复已完成：src/utils/graph/noteTitle.ts 实现了六级标题候选链（frontmatter title/name/aliases[0] → H1 → H2–H6 → 正文首行，超长截 40 字+… → 文件名解码 → 父目录·前8位兜底）；graphIndexStore.ts 的 GRAPH_INDEX_SCHEMA_VERSION 已升到 3，load() 在版本不符时删 vaults/<shardKey>/ 保留 positions.ndjson 以触发全量重建。验证全绿：verify-graph-title 60/60、index 70/70、scan 112/112、sync 46/46、tsc 退出码 0。
2. 左侧面板折叠+美化已完成：GraphPage.tsx 面板⇄胶囊按钮双态、localStorage 持久化、焦点交接、窄屏详情变底部抽屉；i18n 四个键中英齐全；index.css 加 .graph-panel-in 动画。
3. 协作规范文档 docs/team-collaboration-spec.md 已落盘并登记进 docs/INDEX.md。

要你做的（按顺序，走软件公司 SOP）：
1. 派 QA 工程师严过关做最后一轮复跑：确认 P1-1（单段 >120 字标题回退 UUID）已闭环、P2-1（块标量 |/> 产出垃圾标题）、P2-2（嵌套映射 title 被提升）、P2-3（frontmatter 值未清洗）已修复；P2-4（同目录同前 8 位撞名）、P2-5（meta 丢失旧分片保留）按已知限制接受。跑 node scripts/verify-graph-title.mjs、verify-graph-index.mjs、verify-graph-scan.mjs、verify-graph-sync.mjs、node ./node_modules/typescript/bin/tsc --noEmit，全绿后出智能路由判定（Engineer/QA/NoOne）。注意本机 npm.ps1 损坏，tsc 用 node 直跑。
2. QA 若判 Engineer 且有问题，退回工程师修复（问题集中在 src/utils/graph/noteTitle.ts）。
3. 全绿后向我交付总结：TL;DR、交付概览、文件清单、需人工目视确认点、用户下一步建议。
4. 完成后 graceful 关闭团队成员并 TeamDelete。

关键边界：不要改 src/components/Graph/GraphPage.tsx、NodeListPanel.tsx、src/utils/i18n.ts、src/index.css（UI 已定稿）；不要 npm install；本机无 GUI，禁止声称目视验证过。硬规则见 .workbuddy/memory/MEMORY.md 与 docs/team-collaboration-spec.md。
```

### 提示词 B —— 仅复跑验证（若只想确认代码是绿的）

```
在 D:/Code/Qing-Notepad 复跑知识库改造的验证，不修改任何代码。依次执行并回报每条退出码与断言数：
node scripts/verify-graph-title.mjs
node scripts/verify-graph-index.mjs
node scripts/verify-graph-scan.mjs
node scripts/verify-graph-sync.mjs
node ./node_modules/typescript/bin/tsc --noEmit
（本机 npm.ps1 损坏，tsc/build 用 node 直跑等价命令）
```

### 提示词 C —— 人工目视清单（给用户在有 GUI 的机器上做）

```
在 Qing Notepad 桌面端确认以下点（打开知识库/图谱页）：
1. 导入一个「文件名是 UUID、正文无 H1」的 Obsidian 文件夹，画布节点标签应显示正文首句而非 UUID；单段超 120 字的笔记标题应截为前 40 字 + …。
2. 左侧面板：点击右上角收起按钮 → 面板消失、左上角出现胶囊按钮（带节点数）；再点展开恢复。刷新后状态保持；窄窗口（<768px）首次访问默认收起。
3. 键盘：Tab 到收起按钮 → 回车 → 焦点应落在胶囊按钮而非消失。
4. 窄屏：选中节点时右侧详情变底部抽屉，不与左上浮层重叠。
5. 四套主题（深/蓝/黄/绿）下无硬编码颜色、文字可读。
```
