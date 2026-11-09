# 侧栏折叠按钮合并 — 决策记录

日期：2026-11-09（分支 `md-plus`）
主题：资源管理器标题栏「全部展开」「全部折叠」两个按钮合并为单一动作式 toggle。
（本轮 `docs/INDEX.md` 因他人在途改动未同步导航，待合并时补一行。）

## 背景事实（已核实）

- 原两按钮在 `Sidebar.tsx` 标题行按钮组（共 6 键）：`ChevronsUpDown`（全部展开）/ `ChevronsDownUp`（全部折叠），均沿用 `headerActionButton`（`h-6 w-6`）。
- 状态单一来源 `settingsStore.expandedFolderIds`：`null` = 全展开（默认，持久化于 settings.json）；数组 = 已展开文件夹 id 集合。
- `NoteTree` 在搜索或标签筛选时强制展开命中路径，批量折叠必然 no-op —— 这就是旧「筛选态双禁用 + `bulkFoldDisabledByFilter`」的来历。
- 用户可只展开部分文件夹，存在**部分展开中间态**，是「两态 toggle」必须定归一规则的原因。
- `collectExplorerFolderIds` 恒含虚拟「未分类」桶，`explorerFolderIds.length === 0` 在当前数据模型下不可达。

## 结论

### 1. 合并为单一 toggle，采用「B 动作式」

- 结论：按钮图标 / `title` / `aria-label` 一律描述**下一次点击会做什么**，不描述当前状态。`nextFoldAction = everyFolderExpanded ? "collapse" : "expand"`：全展开（含 `null`）显示 `ChevronsDownUp` +「全部折叠」，点击 `setExpandedFolderIds([])`；其余显示 `ChevronsUpDown` +「全部展开」，点击 `setExpandedFolderIds(explorerFolderIds)`。
- 理由：所见即所得，不会把「显示当前状态」误读成「点了保持现状」；与搜索键的 toggle 写法同族。
- **去掉旧「终态禁用」**：旧版在全展开时禁用展开键、全折叠时禁用折叠键；动作式下按钮在终态仍有另一半动作可做，这是两按钮合并能成立的前提。

### 2. 部分展开中间态：一次归一到全展开（用户选「甲」）

- 结论：`partial` 态第一次点击先「全部展开」，第二次「全部折叠」，之后严格两态交替。不引入「记住上次批量动作」的额外 state。
- 理由：零新增状态、结果可预测；先把用户带到信息最全的确定态，符合「先看到全部再收起」。

### 3. 筛选态沿用「禁用 + 原因提示」

- 结论：`foldDisabled = treeFilterActive || explorerFolderIds.length === 0`；筛选态 `title = t(lang,"bulkFoldDisabledByFilter")`、不可点击、不改树状态、仍只渲染一个图标。
- 理由：筛选时批量折叠是 no-op，禁用最诚实；口径与 `NoteTree` 的 `forceExpand` 公式逐字一致。

### 4. 零文件夹：禁用 + 确定态双保险

- 结论：`explorerFolderIds.length === 0` 时按钮禁用；此时 `everyFolderExpanded` 恒真、`foldState` 恒 `expanded`，即使误触也不会「图标翻转但树不变」。
- 理由：无文件夹可折叠时任何点击都是不可见 no-op。该分支在当前数据模型下不可达（恒含未分类桶），属防御性守卫。

### 5. 断言钩子：三个 `data-*`，刻意不加 `aria-pressed`

- 结论：`data-fold-toggle`（唯一定位，对标 `data-search-toggle`）、`data-fold-state` = `expanded | collapsed | partial`（当前树状态）、`data-fold-action` = `expand | collapse`（下一次动作）。
- 理由：动作式按钮的 accessible name 随状态变化，而 ARIA 对 toggle button 的约定是 label 固定 + `aria-pressed` 表达状态；可变 label 配 `aria-pressed` 语义冲突，故用 `data-*` 让自动化无需解析翻译文案即可断言完整状态机。

### 6. i18n 零新增

- 结论：复用既有 `expandAllFolders` / `collapseAllFolders` / `bulkFoldDisabledByFilter` 三 key（zh/en 双表均在），`i18n.ts` 未改。
- 理由：文案语义完全复用，新增 key 反而要同步两表并审计。

## 实现位置

| 文件 | 改动 |
| --- | --- |
| `src/components/Layout/Sidebar.tsx` | 唯一源码改动（38 insertions / 19 deletions）：删两按钮与 `expandAllFolders` / `collapseAllFolders`，加 `nextFoldAction` / `foldState` / `foldLabel` / `foldDisabled` / `handleFoldToggle` 与三个 `data-*` 钩子；标题行按钮组 6 键 → **5 键**（搜索 index 0 / fold toggle / 新建笔记 / 新建分类 / 导入文件） |

## 验收（真实 WebView2，全部实测）

- `npx tsc --noEmit` 零诊断（strict + noUnusedLocals，同时证明无未用 import/变量）；`npm run build`（PowerShell）exit 0；`npm run tauri -- build --no-bundle`（内联 MSVC 14.36.32532 / SDK 10.0.22000.0）exit 0，新主 chunk `index-9Wj2Oesq.js` 内三个 `data-*` 各命中 1 处。
- `npm run verify:webview`：先 `verify:webview:close` 关旧窗口（pid 49720），`reused:false` 打开**新 exe 新窗口**（pid 70628），`ok:true` / `consoleErrors []` / `failures []` / `keptOpen:true`。
- 8 条专属断言全过：唯一 `[data-fold-toggle]`、5 键不换行行高 36px；`null` 态 → `expanded/collapse/全部折叠/lucide-chevrons-down-up`；点击翻转 `collapsed ↔ expanded`（树真实变化 folderRows 10↔19）；`partial` 一次归一到 expanded；筛选态 `disabled` + 原因提示且点击不改树；中英 `Collapse All` / `Expand All` 正确；240/180 两档（CSS 变量模拟）无换行无溢出。
- 用户设置字节级还原（settings.json 与开工备份 identical），store 复位为初始态；截图 `local_img/webview-main.png` 判读：搜索键后只剩一个双箭头图标，无裁切/重叠/空黑区。

## 已知边界（如实记录，均非本轮缺陷）

1. 零文件夹禁用态 `title` 仍是动作名、无禁用原因（该分支不可达，加 i18n key 属扩范围，未做）。
2. **内联搜索态（`searchActive`）时树被卸载、标题行 toggle 仍可点**，点击改 store 但无可见反馈 —— 旧两按钮同条件同行为，非本轮引入；`decisions-sidebar-search.md` 结论 2 明确「搜索」与「树过滤」是两件事。是否把内联搜索纳入禁用口径，列为开放问题。
3. `noteTreeModel.ts:141-142` 的 `note.content.toLowerCase()` 在 `searchQuery` 被强设且笔记 `content` 为 undefined 时抛 TypeError 触发 `RootErrorBoundary`；`searchQuery` 在产品中**无 UI 入口**，属 QA 探针构造的不可达既有缺陷，另案记录。
4. 应用内启动 effect 可能把 `null` 归一为 `[]`，真机首次 attach 时可能见到 `partial`；探针断言需用 store 精确设态。

## 开放问题

1. 内联搜索态是否纳入 `foldDisabled` 口径（见已知边界 2）。
2. 零文件夹禁用态是否补一条原因文案（需新增 i18n key，当前不可达故未做）。

## 需人工目视确认（本机无 GUI）

hover 高亮与按下反馈、真实点击手感、真实拖拽改侧栏宽度、折叠 rail 一键展开、IME、托盘/多窗口、设置面板切换亮暗主题 —— 以上均未验证，未验证项不得写成「已验证」。
