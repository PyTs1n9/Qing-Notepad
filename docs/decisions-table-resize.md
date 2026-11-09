# 决策记录 · Markdown 表格手动调整尺寸

日期：2026-11-09
状态：已实施（P3 完成，P4 守门通过，待 P5 构建/WebView 验收回填）

## 背景

需求：在现有表格功能上实现 Typora 式手动调整尺寸——拖列边界改列宽、拖表格边缘改整体宽度，
拖动时实时反馈，并保证保存 / 重新加载后一致，且不影响未调整的表格。

改前事实：

- 表格由 `src/utils/livePreview/tableField.ts` + `tableWidget.ts` 渲染为**只读块级 widget**
  （`Decoration.replace({ block: true })`），点单元格会把整块回退成 Markdown 源码（L3 规则，
  见 `decisions-typora-editor.md`「表格首版只读」）。
- `.cm-md-table { width: 100% }` + auto 布局；外层 `.cm-md-table-wrap` 已有 `overflow-x: auto`。
- GFM 源码里**列宽没有承载位**，所以「重载后一致」必然要求把宽度写进 `.md` 本身。

## 语法树探针结论（`test_temp/probe-table-comment*.mjs`，跑完即删）

| 探针 | 结果 |
| --- | --- |
| `<!-- … -->` + 空行 + 表格 | `CommentBlock` + 顶层 `Table`，正常 |
| `<!-- … -->` 紧贴表格（不空行） | `CommentBlock` + 顶层 `Table`，行边界完整，正常 |
| 段落 / 列表项下紧贴注释再接表格 | 仍是独立块 + 顶层 `Table`，正常 |
| `<colgroup><col style="width:180px"></colgroup>` + 表格 | 被解析成**单个 `HTMLBlock`，把表吞掉** |

→ Typora 的 `<colgroup>` 方案在本项目的 GFM 基线里**不可用**（会直接毁掉表格渲染），
HTML 注释是唯一可行的自包含载体。

## 追问结论

| 项 | 结论 | 理由 |
| --- | --- | --- |
| 持久化载体 | 表格**上一行**写 `<!-- qing-table:w=180,220,160 -->`（整数 px，列序即列序） | 自包含、随文件走、所有渲染器不可见；`colgroup` 已被探针否决 |
| 无注释的表 | 保持 `width:100%` + auto 布局，**逐像素等同现状** | 「不影响未调整表格」是硬要求 |
| 可拖拽态 | 只在渲染态；点单元格仍进源码态（**默认编辑档**；`interactive: true` 的纯预览编辑档由 `tableEditing.ts` 就地编辑，不进源码态） | 不触碰既有「块替换 + L3 回退」编辑模型；可编辑单元格是独立工作线 |
| 数据模型 | 只有 `cols[]`，表宽 = 各列之和 | 单一真源，避免「总宽 vs 列宽」双约束互相打架 |
| 内边界拖拽 | 相邻两列转移宽度，**总宽不变** | Typora 手感；不会牵动整表重排 |
| 最右边界拖拽 | 全表**等比缩放** | 用户选择；列宽比例是用户已经认可的观感 |
| 最小列宽 | **48px** | 约两个中文字 + 内边距；低于此值表头必然折行 |
| 整表上下限 | [列数×48, max(内容区宽度, 拖拽起始总宽)] | 上限防溢出；允许「起始已超宽」的表继续收缩而不被强制收窄 |
| 只读实例 | 贴窗 / 磁贴按注释宽度渲染，**无手柄** | 没有落盘目标；避免多写者 |
| `StickyNote` | 不启用拖拽 | 便签窗口同样会写 `.md`，与主编辑器争同一文件 |
| 列数不匹配 | 整表回退 auto，**注释保留不删** | 不丢数据；不做「半固定半自动」的怪表 |
| 重置入口 | **双击列边界** = 删除该表注释、恢复 auto | 不必手改源码；入口就在手指下 |
| 撤销粒度 | 拖拽中只改 DOM，**松手发一次事务** | Ctrl+Z 一步回退；不污染撤销栈 |
| 注释行呈现 | 渲染态**零高度隐藏**，光标进入该行显形 | 与其它块同一 L3 规则；源码态可读可改 |
| 宽度取整 | 整数 px | 注释短、diff 稳 |
| 手柄可见性 | **恒存在**（仅可编辑实例），默认零视觉，hover 才出 2px 线 | 「无注释的表无手柄」会让新表永远没有拖拽入口；静态呈现不变，只多一条 6px 透明热区 |
| 独立笔记窗口 | 保留手柄 | 它本来就是同一份文档的另一个编辑器，能力应与主窗口一致；同步冲突与打字同级，不单独收紧 |
| 首次拖右边界的方向 | 只能先变窄，变窄后可拉回内容区宽度 | 上限 = max(内容区宽, 起始总宽) 的直接后果；不放大上限，避免溢出 |

## 验收条件（冻结）

- **A1** 渲染态每列右边界有约 6px 热区，hover 出 2px 强调线，光标 `col-resize`。
- **A2** 内边界拖拽：相邻两列此消彼长、总宽不变、两列均 ≥ 48px。
- **A3** 最右边界拖拽：全表等比缩放，总宽落在 [列数×48, max(内容区宽, 起始总宽)]。
- **A4** 拖拽中实时更新并显示当前宽度（px 气泡）；松手后不跳变。
- **A5** 松手后文档出现/更新注释行；Ctrl+Z 一步撤销。
- **A6** 保存 → 重新加载后宽度一致。
- **A7** 注释行渲染态不可见，光标移入显形可编辑（零高度 + 指针穿透：鼠标点不进去，
  只能靠键盘上下键进入）。
- **A8** 无注释的表：`width:100%`、auto 布局，**静态呈现与改前逐像素一致**；DOM 只多出透明热区层
  （`pointer-events` 默认穿透，仅 6px 手柄条接收指针），不出现任何可见装饰。
  本条只描述**默认编辑档**；`interactive: true`（纯预览编辑档）下点单元格由 `tableEditing.ts`
  就地编辑，不进源码态。
- **A9** 列数不匹配回退 auto；双击手柄删除注释。
- **A10** 只读实例按宽度渲染且无手柄；`StickyNote` 无手柄。
- **A11** `npx tsc --noEmit`、`node scripts/verify-table-sizing.mjs`、构建与 WebView 验收通过。
- **A12** 不动导出管线（`utils/markdown.ts`）、i18n、`src-tauri/`、`storage.ts`；
  不新增依赖；不碰 `package.json` / capabilities / CSP。

## 实施

### 文件

| 文件 | 角色 |
| --- | --- |
| `src/utils/livePreview/tableSizing.ts`（新增） | 纯函数层：注释解析/序列化、夹取、等比缩放、内边界转移、定位上一行注释。零 DOM、零 `EditorView` |
| `src/utils/livePreview/tableResize.ts`（新增） | 手柄层：`<colgroup>` 宽度、6px 热区、拖拽快照/重算、px 气泡、唯一提交点、`destroy()` 幂等 |
| `src/utils/livePreview/tableWidget.ts` | `TableData.cols`（进 `key`）、`withCols`、`TableWidgetOptions`、`ignoreEvent` 只认手柄、`toDOM(view)` 建 colgroup/fixed、`RESIZERS` WeakMap + `destroy(dom)` 反查 |
| `src/utils/livePreview/tableField.ts` | `TableSpec.sizing`；`collectTableSpecs` 保持两参签名；`build()` 追加注释行的 `line` + `replace`，光标落入注释行时不产出 |
| `src/utils/livePreview/index.ts` | `LivePreviewConfig.resizable` 透传 |
| `src/components/Editor/MarkdownSourceEditor.tsx` | `livePreview({ resizable: true })` |
| `src/components/Editor/MarkdownReadonlyView.tsx` / `Sticky/StickyNote.tsx` | 显式 `resizable: false` |
| `src/index.css` | 冻结类名一段；既有 `.cm-md-table*` 一行未改 |
| `scripts/verify-table-sizing.mjs`（新增） | 53 条无头断言 |

### 三个实现层的关键点

1. **撤销粒度靠 `isolateHistory.of("full")`**，不是「一次事务」：CodeMirror 的 history 会把
   500ms 内的相邻改动并成一组，只发一次事务并不能保证 Ctrl+Z 一步回到拖拽前。
2. **松手提交前用 `view.posAtDOM(wrap)` 现算表格位置**，不缓存拖拽开始时的偏移：多窗口同步
   会在拖拽期间改文档，旧偏移会写到错误的行。
3. **注释行显形不能用 `blockAtPosition` 判定**：`CommentBlock` 内部 `blockFromChain` 会停在
   `Document` 上并返回 `null`，光标落在注释里永远判不成「活动块」。判据改为按**区间**比较选区。

### 退化路径（全部保留注释、不删数据）

| 情形 | 行为 |
| --- | --- |
| 非 `qing-table` 注释 | 完全不认领，不隐藏、不解析 |
| 前缀匹配但 payload 非法 | 该注释**不被认领**：不隐藏、不解析，宽度自然为 auto，注释保留（写坏的行应让人看得见） |
| 宽度个数 ≠ 列数 / 总和 < 列数×48 | 整表回退 auto，注释保留，双击手柄可删 |
| 注释与表格之间被插入空行 | 视为无注释，该注释变成孤儿并**恢复可见**（避免藏用户数据） |
| 表格在引用/列表内 | 不渲染，注释无表可认领，不隐藏 |

### 已知限制

- 表体行数多于表头列时，多出的单元格按 fixed 剩余空间分摊，不受手柄控制。
- `border-collapse` 的边框分摊在不同缩放下与列宽之和可能差 1–2px，首次切 fixed 的瞬间
  可能有一像素级跳动。
- 6px 手柄热区会让「点单元格进源码态」出现 6px 死区（A8 已接受）。
- px 气泡的纵向位置取 `pointerdown` 时的表格位置快照；拖拽期间若用滚轮/触控板滚动编辑器，
  气泡不会跟随纵向滚动（横向 `clientX` 始终跟随指针）。正常拖拽不滚动编辑器，属边角场景。

### 与并发工作线的关系

本轮实施期间，工作区另有一条独立工作线（`tableEditing.ts` 单元格就地编辑、`codeBlock.ts`、
`markdownLinks.ts`）。两条线在 `tableWidget.ts` / `tableField.ts` / `index.css` 上交织：
对方复用了本轮的 `TableData.cols` / `withCols` / `columnCount` 与 `ignoreEvent` 手柄契约，
并给 `tableWidget` 加了一个独立的 `interactive` 开关。**两套开关互不替代**：
`resizable` 管列宽手势，`interactive` 管单元格编辑。


## 开放问题

- 拖拽属于**无 GUI 无法验证**的类别：档位、手感、边缘吸附只能人工目视确认，
  QA 只能验「合成 PointerEvent 后文档被正确改写」与静态观感。不阻塞实施。
