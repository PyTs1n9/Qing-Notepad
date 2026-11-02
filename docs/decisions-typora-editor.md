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
