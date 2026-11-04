# 任务书：编辑器排版对齐 Typora（清晰度 + 布局 + 列表符号）

> 本文是可独立交给一个 agent / 会话执行的任务书。所有结论与约束均已核实过仓库现状。
> 目标产品：Qing Notepad（Tauri v2 + React 19 + TS + CodeMirror 6）。

---

## 一、背景与目标

用户横向对比 Typora（左）与 Qing Notepad（右）后提出三点不满：

1. **字体更糊**：中文正文 16px 下明显发虚、不如 Typora 锐利。
2. **布局乱、不整洁**：段落节奏反了（段间比标题间还大）、首行留白不足、无正文最大宽度、有多余的折叠箭头/行号。
3. **列表符号未隐藏**：非源码模式下 `-`/`*` 仍是字符，未渲染成圆点；有序列表是淡色原始数字，不是干净序号。

本任务只做「排版对齐」这一件事，不引入新依赖，不重做编辑器架构。

---

## 二、需求（已与用户逐条确认，勿再改方向）

### 清晰度（D1）

- D1-1 修正中文正文字体栈：现栈 `"Segoe UI", "PingFang SC", "Microsoft YaHei"` 中 `PingFang SC` 在 Windows 不存在，中文实际落到微软雅黑 400，这是「糊」的第一嫌疑。
- D1-2 探索编辑区背景透明/磨砂对 LCD 次像素抗锯齿的影响。Chromium 只在背景不透明时启用 ClearType；文字压在 tint < 100% 的磨砂层上会退化为灰度抗锯齿，16px 中文会明显发糊。**这条必须用发版构建 + WebView2 截图验证，不能凭推理定论。**
- D1-3 检查并考虑显式声明 `-webkit-font-smoothing`（注意：Windows 上 `antialiased` 反而更糊，`subpixel-antialiased` 才是 ClearType 路径，需在真实 WebView2 里对比截图决定是否加、加哪个值，而不是盲加）。

### 布局（D2）

- D2-1 首行留白：`.cm-content` 现为 `padding: 16px 20px`，Typora 首行留白约 40px。调大顶部 padding（建议 40px 左右，具体值看截图）。
- D2-2 标题上下间距：`.cm-md-h1~h6` 现只有字号/字重/行高，**无任何 margin/padding**。需为每个标题等级补上前置间距（h1 最多、h6 最少，逐级递减）。**必须用 `padding`，禁用 `margin`**：CodeMirror 6 测量行高时不含 margin，用 margin 会让滚动位置漂移。
- D2-3 段落间距：源码空行现按整行高度（`line-height: 1.7` → 16px 下约 27px）渲染，过大。压缩源码态空行的视觉高度，使段间距 < 标题前间距，恢复正确的阅读节奏。
- D2-4 正文最大宽度 + 居中：正文无 max-width，宽窗口下一行可跑上百字。加最大宽度（建议 40–46em，约 640–736px @16px）并水平居中。
- D2-5 移除/收拢折叠箭头与行号：`basicSetup` 默认带 `lineNumbers` 与 `foldGutter`，截图里的零散 `v` 即折叠箭头。默认关闭，必要时放进设置项（不要直接删功能代码，只改默认开关）。

### 列表符号（D3）

- D3-1 无序列表 `-` / `*` / `+`：非源码模式下隐藏源符号，渲染为一个圆点（bullet）。
- D3-2 有序列表 `1.` / `1)`：隐藏源数字，渲染**递增后的真实序号**（1. 2. 3.…），保持 Typora 语义。
- D3-3 隐藏后的可编辑性约束：`Decoration.replace` 会让被替换区间光标不可达。列表符号隐藏后，用户无法把光标停在符号上删改它。需与 `revealActiveBlock` 语义协调——光标进入该列表项时是否回退显示源码符号，按现有「标题 # 维持现状回退」的同一套逻辑处理，保持体验一致。
- D3-4 嵌套列表、任务列表 `- [ ]` 的处理需一并覆盖，不能只做顶层一级。

### 明确不做（N1）

- N1-1 标题 `#` 的隐藏行为**维持现状**：光标进入标题块回退显示源码，光标离开则隐藏 `#`。只调字号/间距，不改其显示/隐藏逻辑。
- N1-2 不引入新的第三方 Markdown 渲染库；沿用现有 live preview（L1 装饰层）架构。
- N1-3 不改数据层、不改导出/预览一致性假设（D2 只动编辑器表面排版，不动 `docs/user-manual.md` 等被 `?raw` 引入的内容，除非排版改动确实需要）。

---

## 三、已核实的代码事实（供实现直接引用）

### 关键文件与行号

| 文件 | 作用 | 关键位置 |
| --- | --- | --- |
| `src/utils/codeMirror.ts` | 字体栈、字号/字族 Compartment | `DEFAULT_BODY_FONT`（:64）、`codeMirrorTypographyTheme`（:85） |
| `src/components/Editor/MarkdownSourceEditor.tsx` | 编辑器实例、基础主题 | `.cm-content` padding（:139-142）、`lineHeight: 1.7`（:136） |
| `src/components/Editor/NoteEditor.tsx` | 编辑器宿主、缩放 | `useEditorZoom` initialSize 16（:118）、`editorFontSize` 传入（:767） |
| `src/index.css` | 全部 `.cm-md-*` 与 live preview 样式 | 标题 `.cm-md-h1~h6`（:3438-3470）、列表 `.cm-md-list-mark`（:3650） |
| `src/utils/livePreview/decorations.ts` | 装饰层（隐藏符号、块级样式） | `visitNode`（:173）、标题分支（:179-189）、`ListMark` 分支（:214-218） |
| `src/utils/livePreview/index.ts` | live preview 插件（revealActiveBlock 回退） | `activeRange`（:186）、`revealFor`（:195） |
| `src/utils/editorBlocks.ts` | 块结构、光标所在块判定 | `blockAtPosition`（:143）、`ListItem` 深度（:190） |

### 现有隐藏机制（复用，勿重造）

1. **符号隐藏**：`decorations.ts` 用 `Decoration.replace({})`（`HIDE` 常量，:145）隐藏标记符。标题的 `HeaderMark`、行内强调的 `EmphasisMark`/`CodeMark` 等已走此通道。
2. **光标块回退**：`livePreview/index.ts` 的 `LivePreviewView.computeActive` 用 `blockAtPosition` 找光标所在块，`reveal` 时 `collectLivePreviewRanges` 会丢弃该块内的 `hide` 装饰（`decorations.ts:78`），使光标块显示源码。
3. **列表标记当前处理**：`ListMark` 节点被 `Decoration.mark`（非 replace）涂成 `cm-md-list-mark`（`decorations.ts:214-218`），CSS 里是 `display:inline-block; min-width:2ch; text-align:right` 的淡色窄列（`index.css:3650`）。**这就是「没隐藏、只淡色」的现状，D3 要改造它。**

### 技术约束（务必遵守）

- **C1**：标题间距用 `padding`，不用 `margin`（CodeMirror 6 行测量不含 margin，margin 会导致滚动漂移）。
- **C2**：`Decoration.replace` 隐藏的区间光标不可达，需与 `revealActiveBlock` 协调，保持「光标进入该块回退源码」的一致体验（与标题 `#` 现状对齐）。
- **C3**：列表符号若改成「隐藏 + 渲染圆点/序号」，圆点/序号需用 `Decoration.widget` 或 `Decoration.replace` + widget 实现（`tableField.ts` 已有 `Decoration.replace` + widget 的表格先例，可参考）。
- **C4**：有序列表序号是**渲染态**的递增序号，不是源文本数字的简单复现；源文本可能 `1. 1. 1.`，渲染态必须 `1. 2. 3.`。
- **C5**：`.cm-md-*` 样式一律 `em`，不能写 `px`（编辑器根携带缩放字号，标题要随 ⌘+/- 缩放）。
- **C6**：改动能进 dist/exe 就必须「先构建、再 WebView2 验收」（见 `AGENTS.md` §Build And WebView Acceptance），截图是唯一排版验收证据。`npm run build` 用 PowerShell。

---

## 四、执行步骤

1. 读 `AGENTS.md`（尤其 §Build And WebView Acceptance 与 §Session resume）。
2. 读上文第三节列出的全部文件，确认行号与现状一致。
3. 按 D1 → D2 → D3 顺序实现，每个字母组完成后本地构建并截图自检一次，避免一次堆太多改动难以定位回归。
4. 每条改动遵循「改什么 + 为什么」写进提交信息（`feat(editor): 中文摘要`）。
5. 全部完成后：`npm run build`（PowerShell）→ `npm run tauri -- build --no-bundle` → `npm run verify:webview` → 读 `local_img/webview-main.png` 验收。
6. 每轮改动结束 commit（不 push）。

## 五、验收标准

- [ ] 中文正文在真实 WebView2 截图中比改动前锐利（或至少不更糊），并已确认编辑区背景透明度对 ClearType 的实际影响。
- [ ] 首行留白约 40px，标题上方有明显且逐级递减的间距，段间距明显小于标题前间距，阅读节奏正确。
- [ ] 正文有最大宽度（40–46em）且居中，宽窗口下一行不超过约 60–80 字。
- [ ] 折叠箭头默认不再出现（或已收进设置）。
- [ ] 非源码模式下，无序列表 `-`/`*`/`+` 显示为圆点；有序列表显示递增序号 1. 2. 3.，即使源文本是 `1. 1. 1.`。
- [ ] 光标进入列表项时，符号按「回退源码」规则显示（与标题 `#` 一致）；离开后恢复圆点/序号。
- [ ] 嵌套列表、任务列表 `- [ ]` 行为正确。
- [ ] `npx tsc --noEmit` 通过（若被 PowerShell 执行策略拦截，见 `AGENTS.md` 的说明，可跳过并说明）。
- [ ] 无零控制台错误（`verify:webview` 自带断言）。

## 六、遗留开放问题（实现中需自行验证，勿假设）

- 编辑区磨砂透明度对 ClearType 的具体影响，需截图 A/B 对比后决定「是否垫不透明纸层」。
- `-webkit-font-smoothing` 在 Windows 真实 WebView2 下该不该加、加哪个值，需截图对比，不可盲加。
- 正文最大宽度与居中的具体数值（em）以截图观感为准，40–46em 是起点不是定值。
