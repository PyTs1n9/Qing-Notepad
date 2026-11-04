# 决策记录：Typora 式 Markdown 编辑器

日期：2026-11-02
状态：追问中（Q1–Q4 已定，Q5–Q8 待确认）

## 背景

目标是把笔记编辑器做成 Typora 那种「单栏、实时渲染、文件本身仍是纯 `.md`」的编辑体验，而不是
现有的「源码 / 预览 / 分屏」三档并列。

## 改动前的事实基础（已核对代码）

- `src/components/Editor/NoteEditor.tsx` 编辑的对象是 `mdContent` 字符串，底层渲染器是
  `MarkdownSourceEditor.tsx` —— **CodeMirror 6 + `@codemirror/lang-markdown`**，不是 TipTap。
- 笔记落盘在 `data/notes/<uuid>.md`，内容即纯 Markdown 文本（`utils/storage.ts`）。
- `MarkdownViewSwitch.tsx` 已有三档视图：`source | preview | split`。
- TipTap 只用于 Canvas 富文本卡片（`components/Canvas/CanvasRichTextEditor.tsx`），与笔记编辑器无关。
- `utils/htmlToMarkdown.ts` 只服务历史遗留的 HTML 期数据，`isStoredEditorHtml()` 负责识别；
  新写入的笔记不经过这层转换。

**由此修正一个前期误判**：笔记并非「富文本存储 + 有损互转」，而是「纯文本存储 + 源码编辑」。
复刻 Typora 不需要更换存储层，也不需要引入第二个编辑器内核。

## 已确认的前提

| 项 | 结论 | 理由 |
| --- | --- | --- |
| 追问强度 | 拷打（5） | 需求以「复刻 Typora」这种整包说法提出，不拆开无法定路线 |
| 决策记录 | 保留本文件，逐条追加 | 技术分歧跨度长，不落文档会反复重议同一件事 |
| 复刻目标层 | 混合渲染编辑体验（单栏、光标处出源码、文件为纯 `.md`） | 这是唯一无法事后补上的东西；主题、公式、导出都可增量叠加 |
| 与现有编辑器关系 | 并存 | 不对现有三档做破坏性替换，先验证再收敛 |
| 验收标准 | 用起来像，不是看起来像 | 只做视觉层会得到一个"能看不能编"的假编辑器 |
| 首版层级 | L1 视觉 + L2 结构 + L3 按块降级，三者同批 | L3 是 L1 成立的前提（`Decoration.replace` 区域光标不可入），拆开做等于返工 |
| `preview` 档 | 升级为实时渲染，取代原只读预览 | 消除 marked 与 lezer-markdown 双解析器导致的同文异貌 |
| 表格 | 首版只读，光标进入整块回退源码 | 可编辑 widget 需 contenteditable 与文档双向同步，且与 L3 降级规则冲突，工程量独立立项 |
| Marktext 参考资料 | 只读行为与 issue，不读实现 | 其架构为 contenteditable，与本项目 CM6 装饰路线不同，照搬实现会引入错误抽象 |
| L2 输入规则 | 全部实现，三条高风险项（空列表项退出 / Tab 层级 / 跨块删除）单独定义语义 | 三者共用同一套按键判定，边界最多，缺语义定义会导致「多按一次吃掉上一段」 |
| 分屏档 | 删除。若后续需要只读呈现（贴窗 / 卡片窗），复用同一套 decoration 的只读实例 | 实时渲染达标后分屏失去意义；decor 只读实例比另建 marked 管线更省，且视觉不会分叉 |
| 遗留 HTML 期笔记 | 上线前一次性迁移为 Markdown 并写回 | 否则这批笔记在实时渲染下显示为标签原文，比现状更差 |
| 开发分支 | `typora-sec`，已创建 | 与 `main` 隔离，避免编辑器内核级改动影响主线发版 |
| 协作版范围 | 不覆盖。`CloudNoteEditor` 维持源码/预览现状 | Q11 选择 A；接入 Yjs 的装饰层成本另议，本轮不做 |
| 技术路线 | 方案 A：CM6 decoration 自建 | 唯一保持「文档即真相、零序列化」的路线（详见下节） |

## 视图模型的修正（2026-11-02）

用户指出 Typora 自身也有「实时渲染 ↔ 源代码模式」的切换，据此确认：

- Typora 的两种模式共用**同一个纯文本 buffer**，切换只是关闭/开启渲染层，无损、可保留光标。
- 本项目的 `source / preview / split` 与它粒度不同：`preview` 是 marked 的只读渲染，不是同一
  buffer 的另一种视图。
- 因此落点不是「新增第四种模式」，而是把 `preview` 档升级为实时渲染，最终形态为
  `实时渲染（默认）/ 源码 / 分屏`。

待确认：`preview` 档是替换还是保留为第三档（见 Q7）。

## 外部参考调研：Marktext（2026-11-02）

采集方式：GitHub API 取 `marktext/marktext` 最近 600 条 issue，滤掉 PR 后 256 条。
`git clone` 在本机因 schannel TLS 中断不可用，改用 API + codeload 分发绕过，不影响结论。

### 发现

1. **Marktext 0.20+ 已换内核为 Muya（块模型）**。26 条 `area/muya` 标签，报错栈里是
   `block2.children[0]`、`cursorOutMostBlock` 一类块结构。它不再是 Typora 那种「纯文本 + 渲染层」，
   而是「块模型 + 序列化回 Markdown」。**参照 Typora 时不应以 Marktext 的实现为蓝本。**
2. **块模型的缺陷集中在序列化往返**。典型：#5861「紧凑列表内含代码块，保存后重开变松散列表」。
   这是「块 → 文本 → 块」丢信息。CM6 直接编辑文本，不存在这一失败模式。
3. **第二集中的缺陷是跨块删除**。#5423（行尾 Forward Delete 把后续引用块拉出引用）、#5400（选区终点在表格
   内时连带删除其后所有块）、#5389（三击选行覆盖下一块）、#5385（从列表/引用内部删到后方块残留选区）。
   四条同源：块边界与选区的交互语义未定义完整。**这条路线上同样会出现**，因为 L3 按块降级必须先定义块边界。
4. **表格类问题最多（19 条）**，且 #5829 记录 0.20+ 大表格切标签页卡顿数秒。佐证 Q6「表格首版只读」。
5. 内联层规范偏差集中在 CommonMark 边角：内联代码的连续反引号、转义 ASCII 标点、嵌套图片 alt、原始
   HTML 标签属性（`markdown/spec` 标签 7 条）。这些是渲染器必须逐条对齐的用例，不能靠直觉实现。

### 用法

第 3、5 条直接转为验收用例；第 2 条作为 CM6 路线相对块模型的正面依据；第 1 条用于纠正「复刻 Marktext
即复刻 Typora」的路径依赖。

## 技术路线对比与结论（2026-11-02）

候选库数据取自 GitHub API 当日查询，非记忆值：

| 候选 | 许可证 | Stars | 最后推送 | 未关 issue | 结论 |
| --- | --- | --- | --- | --- | --- |
| Vditor | MIT | 11,421 | 2026-10-18 | 98 | 备选，未采用 |
| Milkdown | MIT | 12,037 | 2026-11-02 | 47 | 备选，未采用 |
| tui.editor | MIT | 17,988 | 2024-08-01 | 643（已归档） | 排除 |

| 方案 | 内核 | 开发难度 | 维护成本 | 致命问题 |
| --- | --- | --- | --- | --- |
| A CM6 decoration 自建 | 现有 CodeMirror 6 | 高 | 低 | 无结构性缺陷，难在调试 |
| B Vditor IR 替换 | 第三方引擎 | 低 | 中高 | 破坏 `qing.editor.setDecorations` 契约 |
| C Milkdown 块模型 | ProseMirror | 中 | 中 | 块模型必须往返序列化，与 Marktext #5861 同源缺陷 |

**结论：采用方案 A。**

决定性理由：A 是唯一不需要「文档 → 编辑器模型 → 文档」往返的方案，存储即真相，渲染只是视图。
B 与 C 都会在往返中静默丢失列表紧凑度、缩进、围栏代码块等结构信息，且这类缺陷难以穷尽修复。

次要理由：B 会破坏插件 decoration 契约，C 需迁移 CM6 侧全部既有资产（`editorHandle`、
`pluginDecorations`、贴窗、卡片窗），隐性成本高于 A 的显性自研成本。

代价：A 的开发难度三者最高，L3 按块降级与跨块删除无现成实现可参照，工作量主体在调试而非编码。

## 待定问题

- ~~L3「块」的边界定义：按空行分段、按 AST 顶层节点，还是按视觉行组。~~ 块边界已按 AST
  节点区间落定（见 M1）。仍待定的是**降级粒度**：引用与表格整体降级是否可接受（表格首版只读，
  引用内含列表时整块降级），待 M3 实测手感。
- ~~`MarkdownViewSwitch` 是本地与云编辑器共用组件。本地删 `split` 后，需支持档位集合按调用方配置，
  避免云端三档被一起改掉。~~ 已解决，见下节 M0。
- 中文 IME 组字期间 decoration 冻结策略（实现约束，非选项）。

## M0 实施记录（2026-11-02）

改动四个文件，`npx tsc --noEmit` 与 `npm run build` 均通过：

| 文件 | 改动 |
| --- | --- |
| `MarkdownViewSwitch.tsx` | `MarkdownViewMode` 增加 `live`；新增必填 `modes` 参数；轨道列数与 pill 宽度/位移按 `modes.length` 派生 |
| `NoteEditor.tsx` | 档位集合 `["live","source"]`，默认 `live`；`showMarkdownSource` 纳入 `live` |
| `CloudNoteEditor.tsx` | 显式传 `MARKDOWN_VIEW_ORDER`（`source/preview/split`），默认值不变 |
| `i18n.ts` | 新增 `mdViewLive`：中文「实时渲染」、英文「Live rendering」 |

### 几何参数化方式

- 轨道：`grid` + 内联 `gridTemplateColumns: repeat(N, minmax(0, 1fr))`，与 Tailwind v4 的
  `grid-cols-3` 展开值逐字一致（已从 `dist` 产物核对 `repeat(3,minmax(0,1fr))`），
  因此三档外观与改动前完全相同。
- pill：`width: calc((100% - 4px) / N)`，`translateX(activeIndex * 100%)` 保持不变 ——
  百分比相对 pill 自身宽度解析，而 pill 宽度恒等于一格，故任意档位数下一步都是一格。
- `4px` 来自 `p-0.5` 的左右内边界（0.125rem × 2，默认 16px 根字号），提为 `TRACK_INSET_PX` 常量。

### 类型约束方式

`labels` 由 `Record<MarkdownViewMode, string>` 收紧为 `Record<Mode, string>`（`Mode` 由 `modes`
推导），两侧文案表分别被约束为 2 项 / 3 项：新增档位若漏配文案即编译失败，
调用方也不会被迫携带自己渲染不到的档位文案。

### 未验证项（本机无 GUI）

- 两档开关的实际宽度与 pill 滑动行程、`live` 图标（`PenLine`）在 15px 下的辨识度。
- 切档时的 jelly 动画在两档下的观感（`markdown-view-pill-fill` 的 key 仍随 value 变化）。
- 默认落在 `live` 时首帧是否有可见的 pill 位移动画。

## M1 实施记录（2026-11-02）

新增 `src/utils/editorBlocks.ts` 与 `scripts/verify-editor-blocks.mjs`（`npm run verify:editor-blocks`）。
`npx tsc --noEmit` 通过；验证脚本 18 项检查全过，覆盖 79 个文档、4882 个块。

### API

| 导出 | 签名 | 用途 |
| --- | --- | --- |
| `blocks` | `(doc: Text, options?) => Block[]` | 需求指定的入口，自己建 state 解析 |
| `blocksFromState` | `(state: EditorState, options?) => Block[]` | 装饰层复用编辑器已有语法树，避免每次更新再解析一遍 |
| `blockAt` | `(blocks, pos) => Block \| null` | 取**最内层**块，把嵌套语义固化成可执行的函数 |

`Block` 与 `BlockKind` 按需求定义；`depth` 分档解释：标题=级别，列表项=1 起的嵌套层数，
引用恒为 1（引用是原子块），其余为 0。

### 落定规则

- 递归只发生在 `Document` → `BulletList`/`OrderedList` → `ListItem`（再找其中的嵌套列表）。
- `Paragraph` / `LinkReference` / `Blockquote` / `Table` / `HorizontalRule` / `FencedCode` /
  `CodeBlock` / `HTMLBlock` / `CommentBlock` / `ProcessingInstructionBlock` 是**原子块**，不再下钻。
  引用内的列表因此整块降级，与计划 §4「引用整体成块」一致。
- `LinkReference`（链接定义）按 `paragraph` 归类而非跳过：光标能进入该行，无主会让 L3 无块可降级。
- 块之间**允许嵌套**，且实测只有「列表项包含其嵌套列表项」一种形态。取光标所在块用 `blockAt`，
  不要假设块集合是扁平且互斥的。

### 两个必须知道的解析事实

1. **`markdown()` 默认是 CommonMark，没有 `Table` 节点**，GFM 表格会被解析成 `Paragraph`。
   模块因此用 `markdown({ base: markdownLanguage })` 取 GFM 基线。
   **`MarkdownSourceEditor.tsx` 目前仍是裸 `markdown()`** —— 编辑器自己的语法树里没有表格，
   M2 要么统一走 `blocks(doc)`，要么把编辑器基线换成 GFM，两者不能混用（否则同一文档两套块边界）。
2. **缩进代码块（`CodeBlock`）的 `from` 起于缩进之后**，块区间不含行首缩进。围栏代码、
   段落、标题的边界都含各自的行首缩进/标记，只有它是特例。

### 不变量（脚本每次运行都验）

- 边界合法（`0 ≤ from ≤ to ≤ 长度`）、非空行内容都有块覆盖、块按文档顺序排列。
- 重叠只允许「`listItem` 包含 `listItem`」，出现其它包含或部分重叠即失败。
- 同一文档两次调用结果一致；`blocksFromState` 与 `blocks` 结果一致。

### 未验证项

- 计划里 M1 的验收写的是「50 篇真实笔记人工核对」，但本机 `data/notes/` 为空，
  实际样本是仓库内 64 个 `.md`（`examples/**` 5 个 + `docs/**` 59 个）。真实笔记手感仍需真机补测。
- `examples/*.qnp` 是插件包（内含 `dist/extension.js` + `package.json`），不含 Markdown，
  脚本只报告并跳过，没有解包。
- 块边界的观感（块间距、光标进出块时的降级跳变）无法在本机确认。

## M2 实施记录（2026-11-02）

新增 `src/utils/livePreview/`（`index.ts` 插件 + `decorations.ts` 纯规格层）、
`preview-live-preview.html` + `src/__preview-live-preview.tsx`（渲染验证台，与既有的
`preview-*.html` 一样被 `.gitignore` 排除，只留本机）、
`scripts/verify-live-preview.mjs`（`npm run verify:live-preview`，已入库）。
`npx tsc --noEmit` 与 `npm run build` 通过；规格脚本 23 项检查全过。

### 结构

- `decorations.ts` 只产出**纯数据** `LivePreviewRange[]`（`hide` / `mark` / `line`），
  `buildLivePreviewDecorations(state, ranges)` 再转成 `DecorationSet`。
  分成两层是为了能在没有 DOM 的环境里断言「装饰了哪些偏移」——GUI 缺失时这是唯一可自动化的部分。
- `index.ts` 是 `ViewPlugin`，只喂 `view.visibleRanges`；`update` 里除 `docChanged` /
  `viewportChanged` 外还比较 `syntaxTree(startState) !== syntaxTree(state)`，
  否则解析器异步补完的那一帧不会重绘。
- 挂载点：`MarkdownSourceEditor` 的 `livePreview` prop，经 `Compartment` 重配。
  切档是 reconfigure 不是 remount，撤销历史与滚动位置都保留；**源码档不挂载**，保持原始 Markdown。

### 顺带解决 M1 遗留的解析基线问题

`MarkdownSourceEditor` 的 `markdown()` 改为 `markdown({ base: markdownLanguage })`（GFM）。
理由：`~~删除~~` 在 CommonMark 基线下根本不是 `Strikethrough` 节点，无法隐藏标记；
表格同理。改后编辑器与 `blocks()` 用同一套树，不存在「同一文档两套块边界」。

### 隐藏与样式清单

| 源 | 隐藏 | 样式类 |
| --- | --- | --- |
| `**粗**` | 两段 `EmphasisMark` | `cm-md-strong`（700） |
| `*斜*` | 两段 `EmphasisMark` | `cm-md-em`（italic） |
| `~~删~~` | 两段 `StrikethroughMark` | `cm-md-strike`（line-through） |
| `` `码` `` | 两段 `CodeMark` | `cm-md-code`（底纹 + 圆角 chip） |
| `[文本](url)` | `[`、`](`、URL、`)` | `cm-md-link`（accent + 下划线） |
| `# 标题` | 不隐藏 `#` | `cm-md-h1..h6`（字号 1.85/1.55/1.32/1.16/1.06/1em + 字重） |
| `> 引用` | 不隐藏 `>` | `cm-md-quote`（3px 左侧竖线 + 缩进） |
| ```` ``` ```` | 不隐藏围栏 | `cm-md-code-block`（逐行底纹） |
| `---` | 整段隐藏 | `cm-md-hr`（border-top 画线） |
| `- `/`1. ` | 不隐藏 | `cm-md-list-mark`（2ch 定宽右对齐，符号列对齐） |

`#` 与 `>` 保留可见是**有意为之**：需求只列了五种行内标记要隐藏，块级标记按「加视觉」处理。
若后续要 Typora 那样连块级标记一起隐藏，改 `visitNode` 两处即可。

字号一律用 `em`，因为编辑器根节点的 px 字号由 `codeMirrorFontSizeTheme` 注入，
em 会跟着 zoom 走；这一点已在 16px / 24px 两档截图里确认。

### 验证方式（本机无 GUI，改用无头浏览器实测）

用 `npm run dev` + headless Edge（`--headless=new --screenshot`）真实渲染
`preview-live-preview.html`，截图存 `.workbuddy/preview/`：

| 截图 | 结论 |
| --- | --- |
| `live-16.png` / `live-final.png` | 五种行内标记全部隐藏且样式生效；H1>H2>H3 字号递减；引用竖线存在；0 未捕获错误 |
| `live-tail.png` | 代码块底纹覆盖围栏与空行、止于闭合围栏；`---` 画成细线且原文隐藏；`-` 与 `1.` 右对齐到同一列、后续文字同列 |
| `live-zoom24.png` | 24px 下标题与正文同比放大，竖线随之变高，无裁切 |
| `source-16.png` | 源码档完全不受影响：`**`、反引号、`[](  )`、`#` 全部原样可见，标题不变字号 |
| `plugin-order.png` | 与 `pluginDecorations` 叠加（含「插件 mark 起始落在隐藏标记内部」的最坏情形），两种注册顺序的渲染一致，未捕获错误 0 |

### 未验证项

- 真实窗口内的滚动/光标：首屏外的行由 `viewportChanged` 重建，逻辑上成立，但只做了静态截图，
  滚动过程中的闪烁与「新进入视口的那一帧是否已装饰」没法在截图里证明。
- 光标进入被隐藏标记内部的落点、选区跨隐藏区、中文 IME 组字，均需真机确认。
- `.cm-md-list-mark` 用了 `display:inline-block`，可能影响光标在符号前后的落点精度。
- `.cm-md-hr` 的空行高度（画线上下各留一行）是否符合预期，需要在真实窗口里看。

## M3 实施记录（2026-11-02）

`npx tsc --noEmit` 与 `npm run build` 通过；规格脚本 34 项检查全过（含逐偏移一致性与增量等价）。

### 当前块的取法

`editorBlocks.ts` 新增 `blockAtPosition(state, pos)`，与 `blocks()` **同源不同路**：

- 光标位置是「字符之间」，所以先按 `resolveInner(pos, +1)` 找从该位置开始的块，
  找不到再按 `-1` 回退——块的 `to` 边上必须算作本块，否则在段尾打字会把整段重新渲染。
- 分类规则逐字复用 `describeAtomic` 与容器优先级（ListItem 内层优先，Blockquote / Table 外层优先），
  所以 `blockAtPosition` 与 `blockAt(blocks(state.doc), pos)` 结果一致；脚本对夹具的
  **每一个偏移（93 个位置）逐个比对**，不一致就失败。
- 为什么不在编辑器里直接调 `blocks()`：那是全文档遍历 + 强制解析，光标每动一次都跑一遍不成立。
  `blocks()` 仍然是对外契约与测试基准。

选区非空时取「首尾两个块的外接区间」，让整段选区都回退——否则用户可能按删除键删掉看不见的标记。

### 重算范围控制

| 触发 | 处理 |
| --- | --- |
| 光标在同一块内移动 | 直接 return，零计算 |
| 光标跨块 | `RangeSet.update({ filterFrom/filterTo, filter, add, sort })`：只丢弃并重算「旧块 ∪ 新块」这一段，其余装饰原样保留 |
| 文档改变 / 视口改变 / 语法树补完 | 按视口重建（M2 路径） |

跨块切换是一次同步的 `RangeSet.update`，只产生一次重绘，所以不存在「全渲染 → 回退」的中间帧。
脚本用三跳（标题 → 列表项 → 引用 → 回到标题）比对「增量更新」与「全量重建」的 DecorationSet 序列，
三者逐项相等，证明局部更新没有残留。

### IME 冻结

- 监听挂在 `view.contentDOM` 的 `compositionstart` / `compositionend`（`destroy()` 里摘掉，
  换笔记销毁实例时不留下任何监听）。
- 组字期间 `update()` **只做 `decorations.map(changes)`**：位置跟着走，装饰不重算、不 dispatch、
  不触发重新测量，候选框与已上屏的首字都不会被动到。
- `compositionend` 只置 `settlePending`：随后到达的提交 transaction 会走一次正常重建；
  若组字没有产生变更（取消/Esc），没有任何 transaction 会来，此时用一帧后的**一次空 dispatch**
  （无 effect、无文档变更）补算，之后正常更新会清掉该标记。实例销毁后该回调直接返回。

### 实测证据（无头 Edge，`.workbuddy/preview/`）

| 截图 | 结论 |
| --- | --- |
| `l3-cursor.png` | 光标在第 5 行段落：该行的 `**`、`*`、`~~`、反引号、`[ ]( )` 全部显示，且样式仍在（粗/斜/删除线/代码 chip/链接）；其余块仍为渲染态；标题仍是标题字号 |
| `ime-freeze.png` | 组字中向另一块插入 `**新加粗**`：标记原样可见，说明期间没有重算 |
| `ime-flush.png` / `ime-flush-zoom.png` | 组字结束后同一条插入：标记被隐藏、`新加粗` 加粗、句号保留，说明补算恰好一次 |

### 需要真机确认的三项

1. **候选框是否跳位**：本机只能合成事件序列，真实 IME 的候选窗锚点无法在无头浏览器里复现。
2. **首字是否丢失**：合成事件不走真实的 `beforeinput`/`compositionupdate` 链路，首字合并行为测不到。
3. **快速输入是否掉字**：连续快速的拼音输入 + 我们的 `RangeSet.update` 是否会在某些帧里与
   输入法竞争，只能在真机上压测。

另外两项也需要真机看：滚动时组字（冻结期间新进入视口的行不装饰，属于预期，但观感要确认）、
跨块大范围选区的回退观感。

## M4 实施记录（2026-11-02）

新增 `src/utils/livePreview/inputRules.ts`（11 条规则 + 注册表 + 绑定）与
`scripts/verify-input-rules.mjs`（`npm run verify:input-rules`，53 项）。
`npx tsc --noEmit`、`npm run build` 通过；无头浏览器合成按键 9/9 通过。

### 结构

- 每条规则是 `run(context) → TransactionSpec | null` 的纯函数，注册在 `INPUT_RULES[id]`；
  一个 id 可挂多个函数（`listIndent` = Tab + Shift-Tab，`inlineWrap` = Mod-b + Mod-i），
  关闭一个 id 就整组停用。`markdownInputRules({ disabled })` 是唯一开关入口。
- 所有事务带两个 annotation：`inputRuleSource`（来源）与 `isolateHistory.of("full")`
  （独立 undo 组）。一条规则只发一次事务，所以 Ctrl+Z 必然整条回退，不会只退一半。
- `MarkdownSourceEditor` 的 `markdown()` 改为 `addKeymap: false`：语言包自带的 Enter
  续行会与本模块重复，且会让「单条关闭」失效。Backspace 的标记删除显式补回
  （`deleteMarkupBackward`），跨块删除留给 M5。

### 每条规则的触发条件 / 边界

| # | 规则 | 触发 | 边界（已验证） |
| --- | --- | --- | --- |
| 1 | `headingShortcut` | 行尾输入空格，前面恰好是 0–3 空格 + 1–6 个 `#` | 7 个 `#` 不触发（保持段落）；行首缩进被抹平；光标不在行尾不触发 |
| 2 | `quoteContinue` | 引用行 Enter | 只有 `>` 的行退出一级（`> > ` → `> `，`> ` → 空行）；懒续行（无 `>`）交回默认 |
| 3 | `listContinue` | 列表项行 Enter | 有序按 `n+1` 且保留 `.`/`)`；任务项续出新的 `- [ ] `；引用内保留 `> `；行中拆分也带标记；空项让给规则 4 |
| 4 | `listExit` | 只有标记的空项 Enter | 连缩进一起删；任务空项连 `[ ] ` 一起删；引用内保留 `>`；有内容不触发 |
| 5 | `listIndent` | 列表项内 Tab / Shift-Tab | 单位取「本项缩进 → 文档首个缩进列表行 → 两空格」，tab 文档插 tab；多行项整块缩进；顶层 Shift-Tab 不动；非列表交给默认 Tab |
| 6 | `fenceClose` | 未闭合围栏的起始行 Enter | 按起始围栏的字符与长度补闭合；已闭合/围栏行中间不触发 |
| 7 | `mathClose` | 整行恰为 `$$` 时 Enter | 上方奇数个 `$$` 视为已在块内，不补；行内 `$$` 不触发 |
| 8 | `hrBreak` | `---`/`***`/`___` 行 Enter | 正常情况补换行；被解析成 Setext 下划线时先插空行断开（一次事务两处改动，仍是一次撤销） |
| 9 | `inlineWrap` | Mod-b / Mod-i | 已加粗则取消；连标记一起选中也能取消；空光标插入成对标记 |
| 10 | `imageDrop` | 编辑器上粘贴/拖入图片文件 | 只判定「是图片」并 `preventDefault`，落盘仍走 `NoteEditor.insertImageBytes`（`attachment://` 路径未变） |
| 11 | `taskToggle` | 点击 `[ ]` / `[x]` | 用 `TaskMarker` 节点定位，改 `[` 与 `]` 之间的一个字符；正文位置不触发；点击不移动光标 |

### 验证方式

- `verify-input-rules.mjs`：每个用例「文档 + 光标 → 期望文档 + 光标」，并断言事务里两个
  annotation 都在、文档确实改变。
- 无头浏览器 `?mode=rules`：合成 `KeyboardEvent` 交给 CodeMirror 自己的 keymap，
  9 条按键规则全部 PASS —— 这同时证明 `Prec.highest` 压过了 `basicSetup` 的默认 Enter/Tab。
- 未做（也无法做）：真实键盘/输入法的字符插入路径，所以「按下去到底会不会触发」仍需真机。

### 需要人工确认

1. 规则 1：真实输入法下「先打#再打空格」是否会先插入字符再触发规则（我们拦的是 keydown，
   字符由浏览器插入，顺序与合成事件不同）。
2. 规则 3/4：连续按 Enter 穿过「列表 → 空项 → 退出 → 引用退出」四级时的节奏是否顺。
3. 规则 5：Tab 在缩进列表里的层级变化是否符合直觉，尤其混合 `-` 与 `1.` 的列表。
4. 规则 10：真实拖拽（资源管理器拖文件）与截图粘贴是否都能落到 `data/img` 且 `attachment://` 可显示。
5. 规则 11：点击复选框时不应抢走选区；鼠标按下与拖动选择的区分。

## M5 实施记录（2026-11-02）

新增 `src/utils/livePreview/blockDelete.ts`（语义定义 + 可执行分类）与
`scripts/verify-block-delete.mjs`（`npm run verify:block-delete`，51 项）。
`npx tsc --noEmit`、`npm run build` 通过。

**这一阶段没有新增按键绑定。** 删除行为由 CodeMirror 的字符命令提供，本模块做的是：
把三种情形写进代码注释、把「这次删除属于哪种情形」变成可断言函数、并用真实命令链
（`deleteMarkupBackward` → `deleteCharBackward`/`deleteCharForward`）逐条验证结果。

### 三种情形与预期

| 情形 | 定义 | 预期结果 | 已验证 |
| --- | --- | --- | --- |
| (a) 块首 Backspace | 光标在该块第一个字符上，且该块不是文档首块 | 删掉的是**上一块与本块之间的换行**，两块并成一个；本块标记（`-`、`#`）作为普通字符留在文本里 | 段落/列表/标题三种块首各一条用例 |
| (b) 块尾 Delete | 光标在块最后一个字符之后，且该块不是末块 | 删掉的是**本块与下一块之间的换行**，下一块首行接到本行；`>` `-` `#` 作为字符保留 | 列表、引用（#5423）、围栏代码块各一条 |
| (c) 跨块选区 | 选区两端落在不同块 | 只删 `from..to` 之间的字符，一个不多一个不少 | #5385 场景 + 引用场景 + 块内选区反例 |
| 块内删除 | 其余情况 | 删除光标前/后的字符 | 列表标记后、标题标记后各一条 |

### Marktext 四个缺陷为什么不可能复现

四个缺陷同源：块模型拥有文档，删除在块树上计算，于是树能移动用户没选中的文字。
本项目文档即文本、块是只读派生，删除只会产生字符区间。用例把这一点写成最强形式：
**结果文档必须逐字等于「原文档减去被删区间」**，任何整块吞掉、列表重编号、
把内容提出引用都会立刻失败。脚本里对 #5423、#5385 两条有专门用例。

### 唯一保留的结构性动作（有意为之）

`deleteMarkupBackward` 仍在 Backspace 链的最前面，用于「光标紧跟在标记之后」时删标记：

- `- 项` 光标在 `-` 与 `项` 之间 → 整段 `- ` 被删，剩 `项`（**实测**，非推测）；
- `# 标题` 同位置 → 只删标记后那个空格，变 `#标题`（实测）。

两者都不跨块、不动内容、一次撤销。若判定这仍属"智能加工"，把 `inputRules.ts` 里
`keymap.of([{ key: "Backspace", run: deleteMarkupBackward }])` 去掉即可，其余用例不受影响。
这一条列为需人工确认的体验问题。

### 与 M3 降级的联动

删除一定伴随 `docChanged`，ViewPlugin 的 `update()` 走 `rebuild()` 分支，
`activeRange(state)` 在新文档上重算——所以「并块后光标所在块」会重新判定并要求回退为源码。
用例断言了两件事：删除后 `blockAtPosition(newState, head)` 仍落在块内；
用该块做 `reveal` 得到的装饰里，块范围内没有 `hide`。

无头浏览器补充了一张图 `delete-merge.png`：两段并成一段后，`**加粗**` 的星号可见——
说明合并后的块被判为当前块并已回退；若降级状态没重算，星号会继续被隐藏。

### 需要人工确认

1. 连续 Backspace 穿过多块时的节奏（本机只能逐次模拟，长按连发未测）。
2. 上面那条「标记后 Backspace」的体验取舍：删整段标记 vs 只删一个字符。
3. 跨块大选区删除时，M3 的整段回退是否会让用户"看到"即将被删的标记（观感）。
4. 中文输入法组字中点 Backspace（与 M3 的冻结叠加）。

## M6 实施记录（2026-11-02）

`npx tsc --noEmit`、`npm run build` 通过；只读实例已在无头浏览器渲染核对（`readonly-tile.png`）。

### 做了什么

- `livePreview(config)` 改成工厂，新增 `revealActiveBlock`（默认 true）。只读实例传 false：
  没有可编辑光标，若不关，offset 0 处的 selection 会让**首块永远停在源码态**。
- 新增 `src/components/Editor/MarkdownReadonlyView.tsx`：`editable: false` + `readOnly: true`
  的 CM 视图，挂同一套装饰，不注册输入规则，自管主题（透明底、无 gutter、auto height）。
- `TileView` 从「`renderStoredNoteContent` → innerHTML」改为该组件，`dangerouslySetInnerHTML`
  与 `renderMarkdown` 管线在卡片窗上彻底退出。
- 链接点击：装饰层把 `[label](url)` 藏成纯文本，DOM 里已没有 `<a>`，所以改为
  `view.posAtCoords` → `linkUrlAt(state,pos)` → `openInDefaultBrowser`（仍只放行 http(s)）。
  `linkUrlAt` 抽到 `src/utils/markdownLinks.ts`，贴窗与卡片窗共用。

### 贴窗的事实纠正（与原需求前提不同）

原需求把贴窗也当只读。实际 `StickyNote` 是 **contentEditable 可编辑**窗口：防抖保存，并且把
**渲染后的 HTML** 写回 `.md` 文件——这正是 M8 要迁移的「HTML 期数据」的来源。
按你的选择，贴窗改成**可编辑的 CM 实例**（不是只读）：

- 装饰、输入规则、主题、字号缩放全部复用；`markdownInputRules()` 不传 `insertImage`（贴窗没有附件路径）；
- 保存改写 `view.state.doc.toString()`，即**直接写 Markdown**，HTML 往返与其"多一个空行"的旧注释一并消失；
- `sticky:note-updated` 用带 annotation 的全量替换灌入，不置脏标记，避免回写风暴；
- 组合输入：监听 `contentDOM` 的 compositionstart/end，组字期间不冲刷防抖保存。

### 只读实例与主编辑器的装饰差异（全部为有意）

| 项 | 主编辑器 | 只读实例 |
| --- | --- | --- |
| 光标降级 | `revealActiveBlock: true`，当前块回退源码 | `false`，全部保持渲染 |
| 输入规则 | 11 条全注册 | 不注册（无 keymap、无 paste/drop、无复选框点击） |
| 历史/撤销 | `basicSetup` 提供 | 无（不挂 history，不可编辑） |
| 行号 / 活动行 / 搜索面板 | 有 | 无（不挂 basicSetup） |
| 主题 | 编辑器主题 + 20px content padding | 透明底、无 padding、auto height 由窗口滚动 |
| 字号 | `codeMirrorFontSizeTheme` | 同一个，标题仍是 `em` 跟随 |
| 字体 | Consolas 栈 | 同一个栈（原卡片窗是正文无衬线，**观感变化**） |
| 链接 | 文本，不可点（编辑器里靠预览面板） | 文本，可点（`posAtCoords` + 语法树） |

### 需要人工确认

1. 卡片窗（Tile）的观感：等宽字体替代了原来的无衬线，标题层级、代码块底纹、分隔线在窄窗里是否可接受。
2. 贴窗（Sticky）整体：本机无法创建 Tauri 窗口，**只做了编译与静态审查**，编辑、防抖保存、
   `sticky:note-saved` 回传主窗口、Ctrl+滚轮缩放、空笔记占位符都要真机过一遍。
3. 贴窗焦点样式：原 `.sticky-content:focus` 的内阴影现在不会触发（焦点在 CM 内部），是否需要补一条
   `.sticky-content:focus-within`。
4. 旧笔记里已经存成 HTML 的内容，在卡片窗/贴窗里会显示为原始 HTML 文本（与主编辑器一致），
   须由 M8 一次性迁移。

## M7 实施记录（2026-11-02）

`npx tsc --noEmit`、`npm run build` 通过；四个验证脚本（158 项）无回归。

### 本地编辑器

- 档位仍是 `["live", "source"]`，但 state 类型从 `MarkdownViewMode`（四值）收紧为
  `LocalMarkdownView`（两值）——`split` / `preview` 在这个编辑器里**类型上不可能出现**，
  不需要运行期判断。
- 删掉的路径：
  - 预览面板（`dangerouslySetInnerHTML` + 那串 `prose` 工具类）与它的 `previewHtml` 状态；
  - `renderMarkdown(mdContent)` 那个副作用——它本来只喂预览面板；
  - 双栏布局、`w-1/2` / `border-r`、两个面板小标题（`markdownViewMode === "split"` 分支）；
  - 双向滚动同步（`handleCodeMirrorScroll` / `handlePreviewScroll` / `isScrollingRef` /
    `scrollSyncEnabled*` / `toggleScrollSync`）与工具栏上的同步开关按钮；
  - `MarkdownSourceEditor` 的 `onScroll` prop 及其 DOM 监听（唯一调用方就是上面那个同步）。
- i18n：`sourceEditor`、`preview` 两个键因此失效，已从类型表与 zh/en 表各删一条。
  `mdViewSplit` / `mdViewPreview` / `synchronizedScroll` / `independentScroll` **保留**——云端编辑器仍在用。
- 两处注释原本描述"预览/分屏只是 CSS 隐藏"，与现状不符，改为描述"两种模式共用一个 view"。

### 云端

`CloudNoteEditor` 一行未动：`splitRatio` / `resizingSplit` / 双栏滚动同步 / `mdViewSplit` 全部保留。

### 全仓 split 搜索（排除 `.split(` 与无关英文）

| 位置 | 结论 |
| --- | --- |
| `MarkdownViewSwitch.tsx` 的 union / `MARKDOWN_VIEW_ORDER` / 图标表 | 保留：云端三档共用 |
| `CloudNoteEditor.tsx` 的 `split*` 与 `resizingSplit` | 保留：云端分屏 |
| `i18n.ts` 的 `mdViewSplit` | 保留：云端在用 |
| `NoteEditor.tsx` | 只剩 `imageExtensionOf` 里的 `.split()` 与一段讲 padding 的英文注释 |
| `plugin/bridge.ts`、`utils/editorHandle.ts` | 原注释描述的分屏行为已不存在，改写 |
| `App.tsx` / `NoteTabBar` / `GraphPage` / `plugin/*` / `settingsStore` 等 | 与编辑器档位无关的英文 `split`，不动 |

### 未验证

本地编辑器整体依赖 Tauri（dialog/fs），无法在浏览器里整块挂载，因此**工具栏去掉同步按钮后的
间距与换行**只做了静态判断，需真机看一眼。

## M8 实施记录（2026-11-02）

新增 `scripts/migrate-html-notes.mjs`（`npm run migrate:html-notes`）。`npx tsc --noEmit` 通过。

### 用法

```
node scripts/migrate-html-notes.mjs --dry-run   # 只统计
node scripts/migrate-html-notes.mjs             # 备份后写入
node scripts/migrate-html-notes.mjs --dir <data/notes>
```

转换**完全复用** `htmlToMarkdown.ts`：`isStoredEditorHtml` 判定命中，`htmlToMarkdown` 负责改写，
与 `NoteEditor` / `App.tsx` / `plugin/bridge.ts` 调用的是同一份规则，没有第二套实现。

### 安全边界

- 写盘前把原文件按字节复制到 `<data>/backup/html-migration-<YYYYMMDD-HHMMSS>/`；
- 写入走「同目录临时文件 + rename」，不会出现半截文件；
- 读取/转换/写入任一失败，原文件保持不动并计入失败；
- 不删除任何文件。

**回滚**：把备份目录里的同名文件复制回 `data/notes/` 覆盖即可（脚本运行结束会打印这两个路径）。

### 幂等

转换产物不再满足 `isStoredEditorHtml`，所以第二次运行命中 0、转换 0。

唯一不收敛的情形是「代码块里存了字面 `<div>` 等标签」：转换结果仍会被识别为 HTML。
这类文件**不写盘**、计入失败并列出原因——因为写下去之后，下一次运行会把围栏当标签解析并吃掉
里面的标签（实测 26 → 15 字符，内容被破坏）。样例里 `warn-fence.md` 就是这一条。

### 顺带修掉的一个阻塞

`htmlToMarkdown.ts` 的 `img` 规则读 `el.dataset.attachmentSrc`。脚本在 Node 侧 DOM 下运行，
那里没有 `dataset` 实现，**任何带图片的笔记都会转换失败**（实测 `Cannot read properties of
undefined (reading 'attachmentSrc')`）。改为 `getAttribute("data-attachment-src")`，
第二顺位仍是 `el.src`，浏览器的相对 URL 解析行为不变。

### 样例副本运行结果（`%TEMP%/qnp-migration-samples/data/notes`，8 个文件）

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| `html-basic.md` | h1 / p / strong / em / code / ul / blockquote | 转换 164 → 69 字符 |
| `html-code-image.md` | h2 / pre code / img / hr | 转换 118 → 62 字符 |
| `html-div-lines.md` | contentEditable 的 div 行（含空行） | 转换 57 → 12 字符 |
| `already-markdown.md` / `plain-text.md` / `empty.md` | 已是 Markdown / 纯文本 / 空 | 跳过 |
| `blank-html.md` | `<p></p>` | 失败：转换结果为空，保留原文 |
| `warn-fence.md` | 代码块里存了 `<div>` | 失败：不收敛，未写盘 |

统计：**扫描 8 · 命中 5 · 转换 3 · 跳过 3 · 失败 2**；第二次运行 **转换 0**，失败集合与文件字节均不变。

抽样对比（`html-basic.md`）：

```
前 <h1>项目计划</h1><p>第一段<strong>加粗</strong>…<ul><li><p>甲</p></li>…
后 # 项目计划\n\n第一段**加粗**与*斜体*，还有`行内码`。\n\n## 清单\n\n-   甲\n\n-   乙\n\n> 引用一句
```

### 保真度观察（未改，属于既有规则）

`<li><p>甲</p></li>` 这种 TipTap 结构会被 turndown 转成「松列表」：`-   甲` 后面跟一个空行。
实时渲染里表现为列表项之间多一行空白。这来自既有转换规则，按要求没有另写一套去"优化"它。

### 未验证

- 本机 `data/notes` 不存在（仓库里没有真实笔记），真实用户数据上的分布未知；
- 数据目录若不可写（只读盘/权限），备份会失败，脚本按设计整文件跳过并计入失败——未在真机上验证。

## M9 实施记录（2026-11-02，真机反馈后的观感修复）

`npx tsc --noEmit`、`npm run build` 通过；四个规格脚本 166 项全过。
无头浏览器实测截图：`final-look.png`（整页）、`crop-zoom3.png`（代码块 3× 放大）。

### 1. 表格渲染（原先完全没有）

`Table` 节点在装饰层里**没有分支**，所以只有行内标记被处理，表格结构没人管——这正是
「表格没渲染、表格内格式却正常」的原因。

新增 `src/utils/livePreview/tableField.ts` + `tableWidget.ts`：

- widget 由**单元格行内片段**构建（`readTable` 遍历 `TableCell` 的 `StrongEmphasis` /
  `InlineCode` / `Link`），逐片 `createElement` + `textContent`，**不拼 HTML 字符串**，
  因此不存在注入面；链接走与 `markdown.ts` 相同的 scheme 白名单。
- 对齐取自分隔行（`TableDelimiter` 的 `:`）。
- 光标在表格内时整块回退源码（`collectTableSpecs` 跳过），与 M3 的块降级一致。

**踩坑（决定架构的一条）**：widget 起初放在 ViewPlugin 里，编辑器直接抛
`RangeError: Block decorations may not be specified via plugins`，整个页面白屏（无错误边界）。
CM 只允许 **StateField** 提供 block 装饰，因为块替换会改变文档高度。
所以装饰层现在分成两半：行内/逐行留在 ViewPlugin，表格单独一个 StateField。
**这条不是风格选择，是硬约束**，后续任何 block 级视觉（图片、数学块）都得走 StateField。

表格只处理**顶层** `Table`：引用/列表里的表格保留源码形态，否则外层块的降级会失效。

### 2. 代码块观感

三处独立缺陷，各自修复：

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 没有语法颜色 | 编辑器只接了 `markdown()`，围栏内容没有 token；项目真实的 19 个 python / 3 个 powershell 代码块用 CM 语言包也覆盖不到 | 复用已有的 `highlight.js`（14 门语言），把它的 HTML 输出还原成偏移，产出 `hljs-*` mark |
| 只是一个矩形 | `.cm-md-code-block` 只有一句 `background-color` | 首/末行加 `cm-md-code-first/last/single`，圆角 + 四边发丝线 + 内边距 |
| 光标落位透明一整行 | `highlightActiveLine` 的 baseTheme 是 `&light .cm-activeLine`（两类），压过主题里的单类 `transparent` | `.cm-editor .cm-line.cm-activeLine { background: transparent !important }` |

高亮实现放在 `src/utils/highlight.ts`：语言注册从 `markdown.ts` 抽出来共用（原来预览与编辑器
会各注册一遍，且在编辑器侧压根没注册）。`highlightRanges` 把 hljs 的 HTML 走一遍栈，
转成 `{from,to,className}`；**结束时校验「可见文本长度 == 源码长度」**，不等就返回空——
宁可不染色，也不能错位（实体 `&amp;` 是 5 个字符 1 个宽）。

**踩坑**：`.hljs-keyword { color }` 一直不生效，但 `background: red !important` 能生效。
原因是 CodeMirror 把每段 token 文字又包了一层自己的 `<span>`，颜色声明在**内层**；
高亮器的 class 在**外层**，`color` 只是被继承，继承永远输给内层的直接声明。
修法是让内层 `color: inherit !important`。这条同样适用于任何「在编辑器里给文字上色」的场景。

代码块内保留围栏行（``` 与语言名），与 `#`、`>` 的处理一致：只加视觉，不藏块级标记。

### 3. 正文字体接口

原先三处编辑器实例都硬编码 `Consolas`。**中文没有等宽字体**，于是逐字回退到系统衬线，
小字号下就是用户说的「像素化」。所以这不是"换个好看的字体"，是"用错了字体类别"。

- `settingsStore.editorFontFamily: string`（`""` = 系统无衬线栈），随其余设置持久化。
- 设置 → 基础 → **编辑器字体**：下拉取 `useFontStore` 的字体表（系统自带四款 + 用户上传的
  `@font-face`），另有「自定义…」可填任意 family 名。
- `codeMirrorTypographyTheme(fontSize, fontFamily)` 同时管字号与字体，仍走同一个 `Compartment`，
  切换字体不重建视图。
- **代码不受影响**：`--editor-font-mono` 只作用于 `.cm-md-code-block` 与 `.cm-md-code`。
  该变量原本叫 `--font-mono`，与 Tailwind v4 `@theme` 里的同名 token 撞车，已改名。
- `fontFamily === undefined` 表示"只改字号、别动字体"：云端编辑器共用这个 helper，
  不能被顺带套上正文字体栈。

### 未验证（需真机）

1. 点击表格：应从 widget 跳回源码态并落光标。落点可能先到块首，再点一次才精确。
2. 表格 widget 与滚动：`estimatedHeight` 是估算（34 + 行数×34），长表格首次进入视口可能有一次高度跳动。
3. 字体下拉里用户上传的字体是否即时可选（`@font-face` 在主窗口注入，贴窗是独立 webview）。
4. 切换字体后行高/光标位置是否立即正确（`Compartment` 重配应触发 remeasure）。

## M10 实施记录（2026-11-04，排版对齐 Typora）

任务书：`docs/typora-typography-task.md`。这轮只碰编辑器表面（字体、间距、列表符号），
不动数据层与导出链路。

### 最终落地的三件事

1. **字体栈终于生效（D1-1）**。根因不是雅黑本身，而是 `CodeMirror` 基础主题在
   `.cm-scroller` 上直接声明 `font-family: monospace`，压过从 `.cm-editor` 继承的栈：
   实测 `.cm-content` 的计算字体是 `monospace`，中文落到系统等宽回退字体（Windows 上是
   宋体/SimSun，字宽 112px @16px 与 `monospace` 完全相同）。修法是让
   `codeMirrorTypographyTheme` 把字体族同时写到 `.cm-scroller`；字体栈按「Windows 实际
   有什么」重排（system-ui → Segoe UI Variable Text → Segoe UI → Microsoft YaHei UI →
   Microsoft YaHei → PingFang SC）。改后同串字宽 117.49px（= 雅黑），截图内无衬线、
   笔画均匀。**这一条是「正文发虚」的唯一实质修复。**
2. **列表符号渲染（D3）**。`ListMark` 从「淡色原字符」改为 `Decoration.replace` +
   widget：无序渲染 `•`/`◦`/`▪`（按嵌套层级），有序渲染**递增序号**（列表起始号 +
   项序号，`1. 1. 1.` 显示 1. 2. 3.），`1)` 保留右括号；任务列表隐藏 `- ` 并把
   `[ ]`/`[x]` 换成可点击复选框（复用 `taskToggleAt`，点击不移动光标）。widget 落在
   `push` 的 reveal 规则里，光标进入该项时自动回退源码，与标题 `#` 的降级同一套机制。
3. **标题间距（仅 `padding-bottom`）**。上间距在回滚后不再实现（见下）。

### 用户当面否决的三项（任务书里写的，但作废）

| 任务书 | 用户决定 | 结果 |
| --- | --- | --- |
| D2-5 默认关闭行号与折叠槽 | **需要**行号与折叠槽 | `basicSetup` 原样，`editorSetup` 已删 |
| D1-2 垫不透明纸层换 ClearType | **要透明**，磨砂必须透 | `.cm-editor` 背景 `transparent`，`--editor-paper` 已删 |
| D2-4 正文最大宽度 + 居中 | **不限宽、不居中**，到边换行 | `.cm-content` 无 `max-width`，`padding: 16px 20px` |

D2 的间距/宽度整组已回滚（提交 `4283453`），只保留字体修复与 D3。

### 踩到的三个坑（都会静默失败）

1. **`.cm-scroller` 上的 `monospace`**：见上。改 `.cm-editor` 的字体无效，必须改
   scroller；同理任何「继承了却看不到效果」的字体问题先查这一层。
2. **`.ͼ1 .cm-line { padding: 0 2px 0 6px }` 是两个类**：基础主题的样式表在运行时注入、
   排在本文件之后，所以单类的 `.cm-md-h1`（甚至 `.cm-line.cm-md-code-block`）设的 padding
   会被静默清零，标题一度完全没有间距。行级 padding 一律用
   `.cm-content .cm-line.X`（三个类）才压得住。
3. **`padding-top` 与行号互斥**：CodeMirror 把行号和折叠箭头钉在**行顶**，`.cm-line`
   的 `padding-top` 会把文字压下去而标记留在原处——表现为「行号堆在标题上方、高度错乱」
   （用户当场报的问题）。要加标题上间距只能挂在**前一行**的 `padding-bottom` 上
   （`.cm-line:has(+ .cm-md-hN)`），或者干脆不加；不要回到 `padding-top`。

### 验证

- `npm run verify:live-preview`：48 项全过（含递增序号、嵌套字形、任务复选框、
  reveal 回退）。
- release exe + WebView2：`.cm-content` 无 `max-width`（998/1053px 铺满）、`.cm-editor`
  透明、行号与 `.cm-line` 的 top/height 逐项相等、列表渲染 10 个 `•` 与 `1.`/`2.`
  序号、点击列表项后该行回到 `- **…**` 源码态且无 widget。
- **未验证**：任务复选框的实际外观（当前笔记无任务列表）与点击切换（会改用户笔记，
  没有点）、嵌套列表在真机上的观感、贴窗/卡片窗内的新标记样式。

### 块级标记隐藏（2026-11-04 追加）

用户要求把 `#` 与 `>` 也按「光标进块才显示源码」处理，推翻 M9 里「块级标记只加视觉、
不隐藏」的旧结论：

- `HeaderMark`：ATX 标题的 `#` 与闭合 `###` 连同后随空格一起隐藏；**Setext 的下划线
  不隐藏**——它是下一行的 `HeaderMark`，藏掉会留下一个空行，所以按「与标题首行同一行」
  判断。
- `QuoteMark`：每行的 `>` 与后随空格隐藏，视觉上只剩 `.cm-md-quote` 的左侧竖线与缩进。
  多行引用的每个 `>` 都要藏，否则会读成一叠 `>`；懒续行的 `QuoteMark` 在 `Paragraph`
  内部，遍历同样会碰到。
- 两者都走 `push()` 的 reveal 规则：`blockAtPosition` 对标题返回标题块、对引用返回整个
  `Blockquote`，光标进块即丢弃块内 hide，`#` / `>` 原样出现。
- 顺带修好 `.cm-md-quote` 的 `padding-left`：单类选择器一直被基础主题的
  `.ͼ1 .cm-line{padding:...}` 压着（见上文坑 2），`>` 藏掉后文字会贴住竖线，故选器
  升到 `.cm-content .cm-line.cm-md-quote` 并把缩进提到 0.9em。
- 验证：`verify:live-preview` 54 项全过（新增 Setext 不隐藏、标题/引用回退、引用竖线
  仍在）；WebView2 实测标题不显示 `#`、引用只剩竖线、光标所在行回到 `- **…**` 源码态。
