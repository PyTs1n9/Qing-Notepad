# 决策记录 · 纯预览编辑模式（表格就地编辑）

日期：2026-11-09
状态：已实施；**WebView2 验收未闭环**（MSVC 工具链缺失 + 已安装实例占用单实例锁）。
代码级门禁与真实 Chromium 的 DOM 级验收已通过，逐条证据见 §6。

## 背景

需求原文：编辑器左下角新增按钮，开启/切换「纯预览编辑模式」。进入后内容始终保持渲染态，
不进行 md 降级、不跳回 md 源码态，也不把表格拆成普通文本；用户要能在表格视图里直接选取
单元格文本、并在表格视图内完成编辑，且表格结构保持不变。

改前事实（均已核对代码）：

- 表格由 `tableField.ts` 以 `Decoration.replace({ block: true })` 渲染成 widget；`TableWidget.ignoreEvent()`
  返回 `false`，鼠标事件交给 CodeMirror → 光标进入块 → `collectTableSpecs` 跳过该表 → **整块回退
  成 md 源码**（`decisions-typora-editor.md` 的 L3 规则）。选取文本与单击同路，所以「一选就降级」。
- 该文档把「可编辑表格 widget」列为独立立项，理由是 contenteditable 双向同步工程量大。本文件即
  该立项的最小闭环。
- lezer 的 GFM 表格里，`TableCell` 边界**不含**两侧空格与管道；**空单元格没有 `TableCell` 节点**，
  旧的 `readCells` 因此会漏列、让整行错位；`\|` 是 `Escape` 叶子，旧实现原样输出 `\|`（既有缺陷）。

## 追问结论

| 项 | 结论 | 理由 |
| --- | --- | --- |
| 追问强度 | 细问（3） | 需求已给出交互，缺的是模式边界与保真口径 |
| 降级范围 | **全文都不降级**（`revealActiveBlock: false`） | 模式名为「纯预览」，只让表格不回退会得到「表格编辑模式」；标记不可见也就不可直接编辑，是用户已接受的代价 |
| 单元格保真 | **纯文本编辑**：未改动的格保留行内格式；被改动的格按纯文本写回 | DOM→md 反向转换无法稳定保真；「只丢被改的那一格」是可控下限 |
| 按钮位置 | 编辑器底栏**左簇第三位**（大纲、源码之后） | 编辑器自己的左下角；不占右簇，六段信息顺序不变 |
| 表格手势 | **单击选取、双击编辑** | 选取是本次要解决的第一痛点，不能被单击编辑抢走；跨格拖选只在非编辑态成立 |
| 与源码档 | **源码档优先**：点「源码」自动关纯预览，回实时渲染不自动恢复 | 两个控件不能各说各话；源码档是逃生舱 |
| 状态记忆 | **会话级** | 与目录列同款；不加新的持久化项 |
| 窗口范围 | **仅主窗口** → 2026-11-09 晚改判为**两面都传**（见文末追加） | 独立笔记窗是同一文件的另一个编辑器，能力差异会带来同步歧义；按钮由 prop 决定存在性 |
| 单元格按键 | Tab/Shift+Tab 左右移格，Enter 下移同列，末格再按退出到表后块 | 与电子表格一致的移动模型 |
| Esc | **提交并退出** | 取消会丢掉刚敲的字；用户选的是「Esc 或点外部提交」 |
| 代码围栏 | 保持现状（围栏行可见） | 本轮只动表格与光标降级，避免顺手改第二套块级规则 |
| 列宽手柄 | 交互档**保留** `resizable`，双击距格右边界 ≤6px 不进入编辑 | `decisions-table-resize.md` 已冻结「双击列边界 = 重置列宽」，两条手势必须抢不同像素 |

## 实施

| 文件 | 改动 |
| --- | --- |
| `src/utils/livePreview/tableEditing.ts`（新） | 全部交互：双击进入、Tab/Enter/Esc、失焦提交、跨格点击、链接拦截、`flushTableEdit`、`attachTableInteraction` |
| `src/utils/livePreview/tableWidget.ts` | `TableCell{from,to,text,pieces,editable}`；按未转义 `\|` 切槽并与 `TableCell` 节点配对（补空槽与缺列幻影格）；`Escape` 解码；`encodeCellText`；`data-qing-table` / `data-cell` 契约；`interactive` 与 `ignoreEvent` |
| `src/utils/livePreview/tableField.ts` | `tablePreview({ interactive })`；`editable = revealActive \|\| interactive`（列宽注释在交互档仍可手改，见 §5） |
| `src/utils/livePreview/index.ts` | `LivePreviewConfig.interactive`；interactive 时强制 `revealActiveBlock: false` |
| `src/components/Editor/MarkdownSourceEditor.tsx` | 可选 `previewEditing`；`previewEditingExtension`；切出交互态前 `flushTableEdit` |
| `src/components/Editor/EditorStatusBar.tsx` | 左簇第三枚可选按钮（`PenLine`，24px，`aria-pressed`，源码档 disabled） |
| `src/components/Editor/NoteEditor.tsx` | `purePreview` 会话状态；`handleViewModeChange` 统一三处入口；保存前 flush；切笔记的归属守卫 |
| `src/utils/i18n.ts` | `purePreviewEdit` / `purePreviewEditHint`（zh/en） |
| `src/index.css` | 交互档可选取、`::selection`、编辑环、`cursor: text` |
| `scripts/verify-live-preview.mjs` | 改 1 条既有断言（形状适配，原意不变）+ 新增 18 条 |

## 四个非显然的实现决定

1. **位置不进数据模型**。`TableData.key` 只含内容（pieces / align / 列数 / 列宽），不含绝对偏移；
   每次提交用 `view.posAtDOM(wrap)` 现算表格起点，再 `readTable` 取单元格新区间。代价是
   `posAtDOM` 失败时本次交互 no-op（绝不写错位置）；收益是**在表格上方打字不会重建表格 DOM**，
   拖选中的原生 Selection 不被打断，也不产生每击键一次的表 DOM churn。
2. **widget 根保持 `contenteditable="false"`，交互档 `ignoreEvent()` 返回 true**。实测（headless Edge +
   CDP）：contenteditable=false 的子树叶文本仍可拖选、可跨格拖选、双击可选词；CodeMirror 的
   `eventBelongsToEditor` / `DOMObserver.onSelectionChange` 对 `ignoreEvent` 为 true 的 widget 直接放行，
   `readMutation` 也不读 widget 内变更。**不使用 `widget.editable`**——那会让 CM 驱动 contenteditable，
   而表格 DOM 的文本不等于 Markdown 源码，风险是把表格读成普通文本。
   只有被双击的那一格临时 `contenteditable="plaintext-only"`，所以「编辑态 = 单格孤岛」，
   跨格选择在编辑态不可用（与「双击进入」的手势一致）。
3. **一次一格一事务**。提交用 `isolateHistory.of("full")`，Ctrl+Z 一步撤回一格；提交后 DOM 会被重建，
   焦点在下一帧按 `data-cell` 坐标找回。离开表格的 `focusout` 用 `queueMicrotask` 提交，避免在
   CodeMirror 自己的 mousedown 处理栈内同步 dispatch；保存/切模式路径用同步 `flushTableEdit`。
4. **单元格文本读写必须成对**：读出时 `Escape` 解码（`\|`→`|`、`\\`→`\`），写入时 `encodeCellText`
   （换行→空格 → trim → `\`→`\\` → `|`→`\|`）。提交先比**可见文本**：`**粗体**` 的可见文本是 `粗体`，
   与源码比较永远不会相等，旧写法会让「双击看一眼再离开」也静默压平格式。
5. **切笔记的归属守卫**（`NoteEditor.handleMdChange`）：`flushTableEdit` 会在切笔记的取样里同步
   dispatch 一次 change，而 React 的 `activeNoteIdRef` 已经指向新笔记；不拦的话上一笔的正文会被写进
   新笔记的 store 条目并被标脏。守卫条件收窄为 `loaded !== null && loaded !== noteId`：
   `loaded` 是「当前缓冲区属于哪篇笔记」的已知事实，切笔记窗口内它仍是旧 id，正是要挡的竞态；
   `null`（尚未载入/载入失败）放行，因为此时缓冲区只可能是当前笔记刚敲的字，拦住反而会丢输入。
   代价：被拦住的那次 change 不会更新 store（磁盘由 `persistPrevious` 直接写，重开笔记会从磁盘刷新），
   且是早返回、无日志——这是有意的静默防御，改这段前先读本节。

## 已知取舍与边界

- **标记不可编辑**：全文不降级意味着看不见 `**`、`#`、`- `，也就不能直接删标记改格式；要改格式需切回实时渲染。
- **被编辑的单元格丢行内格式**：`**粗体**` 改成 `粗体一` 后写回纯文本；未编辑的格保留源码标记。
- **自动保存/切笔记会结束当前格的编辑**：`getCurrentEditorContent` 会先同步提交，内容已落盘；
  未提交的文本只在失焦、Esc、Tab/Enter、保存、切模式这些点落盘。
- **纯预览档唯一会现形的源码是表格宽度注释行**（`<!-- qing-table:w=… -->`）：列宽轮 A7 要求光标
  在该行时显形可改，`editable = revealActive || interactive` 保留了它；这是元数据不是正文，
  且只有选区触到该行时才出现。
- **编辑态的选区颜色走系统高亮**：CodeMirror 的 `hideNativeSelection` 用
  `.cm-content :focus::selection { background: Highlight !important }` 覆盖了本轮的 34% accent；
  非编辑态的跨格拖选仍是应用强调色。
- **独立笔记窗一开始没有该按钮**：`EditorStatusBar` 的按钮由 `onTogglePurePreview` 是否存在决定，
  首轮 `NoteWindowView` 不传。**2026-11-09 晚改判为两面都传**，见文末追加。
- **列宽与交互并存**：`interactive` 与 `resizable` 是两个独立开关，交互档两者都开；双击落在
  单元格右边界 6px 内归列宽手柄（重置列宽），否则进入编辑。

## 验证

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 error |
| `npm run verify:live-preview` | **78 项 · 0 失败**（含新增的空槽/转义/缺列/key 与位置无关等 18 条） |
| `npm run verify:ui-polish` | 15/15；对比度 152 组、150 ≥ 4.5:1、0 failures |
| `npm run verify:architecture` | PASS（235 文件；R1 无循环依赖） |
| `npm run build`（PowerShell） | 退出码 0（仅既有 chunk 体积告警） |
| Chromium DOM 探针（`test_temp/verify-table-edit-chromium.mjs`，真实鼠标事件 + 双截图） | **23/23**：常驻渲染、跨格拖选、双击编辑、Tab/Enter/Esc 提交、未编辑格保格式、空槽写回、普通模式不回归 |

**未完成（环境阻塞，不是代码缺陷）**：

- `npm run tauri -- build --no-bundle` 失败：`failed to find tool "cl.exe"`。本机 VS 2022 Build Tools 与
  Windows SDK 的 `Lib/`、`bin/` 已缺失，`rustc` 只有 msvc 一条链。与上一轮 `d5f17fa` 记录同一根因。
- `npm run verify:webview` 未开窗：已安装版 `qing-notepad.exe`（PID 1980，`E:\QingNotepad\`）占用单实例锁，
  runner 以 exit 2 拒绝启动；且 `src-tauri/target/release/qing-notepad.exe` 是 11-07 的旧构建，
  硬开窗等于验收旧前端，会给出假阳性。
- 因此 **P0-1（按钮运行时状态）、P0-6（源码档联动）、P0-7（独立窗开窗）只有静态核对**。
- 需人工目视：跨格拖选观感、双击选词视觉、6px 列宽热区手感、中文 IME 组字、失焦真实时序、
  编辑态选区颜色。

## 与既有文档的关系

- 本文件**局部推翻** `decisions-typora-editor.md` 的「表格首版只读、光标进入整块回退源码」：
  在纯预览编辑档下表格常驻渲染并可就地改单元格，但普通实时渲染档的行为不变。
- `decisions-table-resize.md` 的列宽手势仍是表格右边界 6px 的唯一主人；本文件只在双击判定上让位。
- `decisions-editor-statusbar.md` 的「六段固定顺序」指**信息段**；左簇开关注册表新增可选的第三枚，
  右簇（时间 / 保存 / 统计）顺序未动。该文件末尾已加一节说明。
- 两条并行的在途线（列宽拖拽、链接跳转）与本轮在 `tableWidget.ts` / `tableField.ts` /
  `MarkdownSourceEditor.tsx` / `index.css` 上物理交织，三条线只能整体提交；见 §7。

## 开放问题

1. **自动保存会不会打断编辑**：现在会（提交后重建、退出编辑态，内容已落盘）。若真机观感不可接受，
   逃生舱只有 `tableEditing.ts` 的 `flushTableEdit` 一处：提交后按原坐标重新进入该格并恢复光标。
2. **编辑态选区色**是否要与正文统一：需要给 `.cm-md-table-wrap [contenteditable]:focus::selection`
   加同权重 `!important` 才能压过 CM，静态无法判定注入顺序，需 dist + 真机截图。
3. **空单元格写回**已从 `|  填|` 改为 `| 填 |`；若列宽注释在场，插入点是否仍稳定需在下一轮复核。
4. **表头可否编辑**：当前可编辑（`data-cell="-1,c"`）。若产品认为表头应锁定，改 `TableWidget.toDOM` 一处。
- **多行单元格不支持**：Enter 语义是移格。要支持需引入 `<br>` 或 `\` 续行的编码约定。
- **非文本节点会被文本化**：单元格渲染器只生成 code / link / strong / em / strike 五种行内节点，
  不生成 `<img>`——图片在格内只显示 alt 文本，任务列表 `- [ ]` 也只显示字面文本。双击进入编辑后
  按纯文本写回，图片语法与复选框会退化为文字。这是纯文本编辑模型的边界，不是表格结构变化；
  未编辑的格受可见文本判等守卫保护，不受影响。

## 追加：独立笔记窗也启用（2026-11-09 晚，提交 `08891cc`）

「仅主窗口」这条结论被回退：`NoteWindowView` 现在也持有 `purePreview` state 并把它传给
`EditorStatusBar` 的第三枚开关，行为与主窗口同构（源码档优先、切档前 `flushTableEdit`、
会话级记忆不持久化）。

理由是可核对的实现事实而非偏好：两面跑的是同一个 `MarkdownSourceEditor`，因此也是同一层交互表格；
不给按钮只会让同一个文件在两扇窗里能力不一致。原先担心的「能力差异带来同步歧义」不成立——
纯预览只改 `livePreview` 的降级策略，不改文档内容，两个窗口仍以同一份 buffer 同步。

同一提交顺带修正了底栏三枚开关的按下与激活态（灰底选中态对底栏只有 1.4–1.6:1），
详见 `decisions-editor-statusbar.md` 的 2026-11-09 晚追加。
