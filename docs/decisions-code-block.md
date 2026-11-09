# 代码块交互：卡片容器 / Ctrl+A 块内选区 / 粘贴成块

> 结论真源。口径：结论 + 理由 + 开放问题。  
> 相关：`decisions-typora-editor.md`（M9 代码块观感、M10 排版与三处踩坑）、
> `decisions-colour-contrast.md`（对比度口径）、`decisions-editor-menubar.md`（插入代码块命令）。
>
> 说明：本轮原本计划作为 `decisions-typora-editor.md` 的 M11 追加，但该编号已被并行的
> 「链接跳转」一轮占用，故独立成篇，避免两条在飞改动争同一段文档。

## 需求（用户确认）

1. 每个围栏代码块以**独立、清晰可见的边框容器**呈现，风格参考 Typora；
2. 光标在代码块内按 Ctrl+A，**第一段只选中当前代码块的代码正文**，不选中文档其他内容；
3. 粘贴大段代码时**自动作为独立围栏块插入**，不再退化成普通段落；
4. **不自动识别语言**：创建后由用户手动输入代码类型；
5. 普通文本、既有代码块内容、块外 Ctrl+A 与常规粘贴行为不受影响。

grill 阶段用户拍板的三项：Ctrl+A 走**两段式**；粘贴判定为**多行 + 代码特征**；外观为
**围栏行留在框内、语言直接手输**（不做失焦隐藏围栏 + 右上角语言标签的 block widget 方案）。

## 结论

### D1 卡片观感的真正缺陷是「padding 是死代码」，不是缺边框

代码块一直是逐行 `Decoration.line` 拼出来的（`Decoration.line` 无法包 range），四边由
`cm-md-code-first/last/single` 补。旧规则写成 `.cm-line.cm-md-code-block`（两个 class）：
CodeMirror 基础主题 `.ͼ1 .cm-line { padding: … }` 运行时注入且排在本文件之后，同权重取胜，
**`padding-left/right: 1em` 从未生效**，代码文字距边框只有 6px，卡片读起来是一条染色带。

修法：选择器提到 `.cm-content .cm-line.cm-md-code-block`（三个 class）。这是 M10 坑 2 的
第三个实例（前两例是标题间距与引用竖线），**「`.cm-line` 上的 padding 必须三个 class」由此
升级为硬规则**。

### D2 边框色不能是「边框 token 的 80% 透明混合」

旧值 `color-mix(in srgb, var(--color-border) 80%, transparent)` 在暗色主题下与卡片底色差
不到 2%，等于不存在。而卡片底色 `--color-bg-secondary` 与页面底色 `--color-bg-primary`
只差 1.09–1.11，**整张卡的「卡片感」100% 由这条 1px 线承担**。

定值：`--md-code-border: color-mix(in srgb, var(--color-border) 30%, var(--color-text-muted) 70%)`。
实测对 `--color-bg-secondary`：暗 3.27 / blue 3.04–3.11 / yellow 3.10 / green 3.05，
四套主题全部越过 WCAG 1.4.11 的非文字 3:1。备选 35/65 在亮色三套只有 2.82–2.90，不取；
45/55 只有 2.42–2.71，不取。

不新增主题级 token：该值是**派生**（`color-mix` 引用既有 token），随 `:root.theme-*` 自动跟随，
不必写进每个主题块，也不受「`:root` 块在 `.theme-*` 之后同权重被反杀」那条陷阱影响。

### D3 垂直方向零 padding，圆角走 `--box-radius`

M10 坑 3：`.cm-line` 的 `padding-top` 会把文字压下去，而行号/折叠箭头钉在行顶，表现为
「行号上浮、高度错乱」。所以卡片上下不给 padding —— 首行字面距上边框约 6.5px（半行距 +
上伸部），与 Typora 的 0.45–0.5em 等价，够了。旧的 `0.45em` 上下 padding 一并删除：
它此前是死代码，一旦随三 class 选择器生效就会引入行号错位。

圆角统一 `var(--box-radius)`（`:root` 定义 10px），不写死 `10px`：与 `.markdown-code-block`
的 `0.65rem` 是同一档，写死两个数字迟早漂移。

### D4 引用内的代码块要四 class，且左侧圆角单独降到 4px

`.cm-content .cm-line.cm-md-quote`（三 class）写在代码块规则之前，同权重反杀 →
引用里的围栏块丢掉 3px 引用竖线。补 `.cm-content .cm-line.cm-md-quote.cm-md-code-block`：
保留 `border-left: 3px` 竖线与 `padding-left: 0.9em`，左侧圆角降到 4px（3px 竖线穿过 10px
圆角会在弧线接缝处留缺口），并补 `color: var(--color-text-primary)` —— 卡片是独立表面，
不继承引用的 `--color-text-secondary`，否则未被高亮器命中的普通代码字符是次级灰。

左 3px 重线 / 右 1px 发丝线是**语义不对称**（竖线表示「引用」，发丝线表示「卡片」），
Typora 同为左重右轻，接受。

### D5 语言标签只上色，不隐藏

`.cm-md-code-info`（``` 行上的 info string）由 `decorations.ts` 的 `addCodeInfoMark` 产出
`mark`，CSS 给 `--color-accent-text`（实测 4.96–5.12，过 4.5）。**必须是 mark 不是 hide**：
不自动识别语言 ⇒ 这一行是唯一能输入语言的位置，隐藏即等于剥夺需求 4。

两个坑：① 必须在 `addCodeHighlight` **之前**产出 —— 后者首句 `if (!text) return;`，空正文块
（`` ```js\n```\n ``，解析树没有 `CodeText`）会把语言标签一起吞掉；② 内层 span 抢色，
需 `.cm-line.cm-md-code-block .cm-md-code-info span { color: inherit !important }`（M9 同款）。

### D6 Ctrl+A 是两段式，第二段必须交回 `selectAll`

第一段：选区完全落在块内时，选中 `contentFrom..contentTo`（围栏行与语言行不算正文）。
第二段：选区已经**等于**正文 ⇒ 返回 `null`，让 `basicSetup` 的 `selectAll` 接管选全文。
理由：不放手的话代码块内永远选不到全文，是陷阱不是特性。

`Prec.highest` 的原因：`basicSetup` 已绑 `Mod-a`。**返回 `false` 是机制的一部分**（放行下一
个绑定），不能被「优化」成无条件 `true`。

### D7 空白正文一律不接管 Ctrl+A（数据级）

实测 `` ```\n\n```\n ``：解析树给出 `CodeText` 覆盖那个裸换行，第一段选中它之后用户打字，
闭合围栏被焊到代码行上 → `"```\nX```\n"`，围栏不再闭合，**后续全文变代码**。这是块破坏，
不是观感问题。故 `sliceDoc(contentFrom, contentTo).trim() === ""` 时直接返回 `null`。

### D8 粘贴成块：`looksLikeCode` 打分 + 只接顶层段落

判定：`≥3 行且 ≥2 行有内容`，再加分/减分，阈值 3。加分项：缩进、行尾标点、括号对、
注释符、**行首关键字（三档，见下）**、运算符、HTML 标签、JSON 外形、shell 命令、CLI 开关。
减分项：Markdown 块标记（标题/列表/引用/表格行）−3、中文句读密度 > 40% −2。

关键字为什么分三档（实测逼出来的两轮修正）：

| 档 | 词表 | 条件 |
| --- | --- | --- |
| 大写 SQL | `SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/FROM/WHERE/JOIN/GROUP/ORDER` | 行首即 +1，无条件 |
| 低歧义代码 | `import/def/function/func/const/let/var/export/interface/enum/struct/namespace/package/using/elif/throw` + `public/private/protected/static/final` 前缀 | 行首即 +1，无条件 |
| 高歧义英文 | `if/else/for/while/switch/case/try/catch/finally/return/new/type/class/from` | 该行**同时**含 `[={}\[\]();]` 或行首有缩进才 +1 |

合计 `Math.min(count, 3)`，阈值仍是 3。两次实测修正的由来：
1. 平摊 `+2` 时三行裸 SQL（无标点）正好 2 分 → 漏判；改「按行 +1」后 3 行关键字 = 3 分过线。
2. 「按行 +1」又放出散文误判 —— `if you read the docs / for a moment it seemed fine /
   while the tests ran` 三行各以英文虚词开头即 3 分；`type the name here / new file created
   already / class of 2024 starts soon` 同理。故把高歧义词的判据从「关键字」改成
   「关键字 + 这一行有没有代码形状」，低歧义词保持无条件（否则三行 `import os` 会被误杀），
   大写 SQL 单独豁免（散文不会写 `FROM notes`）。

承接条件：只在**顶层 paragraph**（或块间空行，`blockAtPosition` 返回 `null`）里接管。
列表项/引用/表格/标题内一律拒绝 —— 围栏在那里要么破坏容器，要么变成容器的字面文本。
**非空选区还必须两端同属一个 paragraph**：否则一次粘贴会吃掉用户没选中的结构（实测选
`2..12` 横跨两段）。

插入形态：`\n\n` + 围栏 + `\n` + 代码 + `\n` + 围栏 + `\n\n`（按行上下文裁剪），光标落在
代码末行之后；`userEvent: "input.paste"`；围栏长度取「内容里最长反引号连续段 + 1」，
下限 3，所以粘贴内容自带 ``` 也能正确闭合。**不写 info string** —— 不猜语言（需求 4）。

### D9 交互层不挂在 `livePreview` compartment 里

`codeBlockInteractions()` 直接进 `MarkdownSourceEditor` 的扩展表，源码档同样生效：
Ctrl+A 与粘贴是**文档语义**，不是视图装饰。挂进 compartment 会让「源码档粘贴成块、实时档
原样粘贴」变成两套行为，用户无法预测。

### D10 选区色带按内容列裁剪，卡片几何一个像素不动

**现象**：代码块内整段选中时，蓝色色带比卡片每侧宽约 20px，压在行号槽与滚动条上，并把 10px
圆角填成直角。

**根因**：`drawSelection` 的 `rectanglesForRange()` 用 `.cm-content` 的 **border box**
`contentRect` 加上**首个 `.cm-line`** 的 padding 来算整行色带边界；
而代码块卡片是 `.cm-line` 本身、没有 margin，它的 border box 恰好等于 `.cm-content` 的
**padding box**。两者相差正好是 `.cm-content` 的 20px 横向 padding（右边界再差 2px：
基础主题给 `.cm-line` 的 `padding-right`）。色带又被抬到 `z-index: 1`（见
`topics/ui-rules.md` §选区与不透明表面），于是外溢可见。

**结论**：给 `.cm-selectionLayer` 加 `clip-path`，左右边界取「内容列」（`.cm-content` 的
padding box）。裁切边与卡片 border box 重合，卡片自身宽度/边框/圆角/padding 全部不动。

**理由**（为什么不是另外两条更省事的路）：

1. **不改卡片几何**：把卡片改成贴满内容列（`padding` 转 `margin`、负 margin 外扩等）虽然
   也能让色带落进卡片，但会改变卡片观感，且依赖「首个 `.cm-line` 的 padding」——文档首行
   是代码块或引用时该值不是 20px，色带会再次错位。裁剪不依赖首行。
2. **不做 CSS-only 的 20px 常量**：图层原点在 `.cm-scroller` 而不是 `.cm-content`，中间
   还有 gutter；gutter 宽度随行号位数变化（9→10→100），写死 20px 会在三位数行号时再次外溢。
   因此两个 inset 由 `utils/selectionClip.ts` 实测写入 CSS 变量。
3. **用布局量而不是视口量**：图层钉在 scroller 的 padding edge，内容在它内部横向滚动，
   `getBoundingClientRect()` 的差值会随横向滚动漂移；`offsetLeft` / `offsetWidth` 同时天然
   就是 `clip-path` 需要的 CSS px，浏览器缩放不需要 `view.scaleX` 换算。
4. **图层是 0×0 盒**（基础主题 `.cm-layer` 带 `contain: size`）：`clip-path` 的参考盒为空，
   百分比宽度不会给它面积，所以宽度必须由扩展写成像素；纵向 inset 取负值让裁切区在滚动时
   始终覆盖视口。

**代价（已知且接受）**：普通段落的整行色带也一起收到内容列内（左少 14px、右少 18px），
看起来更贴近文字列；卡片首/末行被整段选中时，色带是矩形，10px 圆角区域会被填满（选中态
看起来是直角，取消选中恢复圆角）。要连圆角一起裁，只能按行后处理每个色带 rect，代价与
收益不成比例。

**归属**：`selectionBandClip()` 只挂 `MarkdownSourceEditor`；只读视图与便签的
`.cm-content` padding 为 0，实测 inset 为 0，裁剪是空操作。

## 落地文件

| 路径 | 改动 |
| --- | --- |
| `src/utils/livePreview/codeBlock.ts` | 新增：`codeBlockAt` / `codeBlockSelectSpec` / `codeBlockPasteSpec` / `looksLikeCode` / `codeBlockInteractions()` |
| `src/utils/livePreview/decorations.ts` | 新增 `addCodeInfoMark`，调用点排在 `addCodeHighlight` 之前 |
| `src/components/Editor/MarkdownSourceEditor.tsx` | 仅 1 处 import + 1 处挂载（注释 2 行 + 调用 1 行，共 4 行） |
| `src/index.css` | 代码块段改三 class、`--md-code-border`、`var(--box-radius)`、四 class 引用规则、`.cm-md-code-info` 与内层 inherit |
| `scripts/verify-code-block.mjs` | 新增：62 项无头断言（选区两段、19 组判定真假、守卫、转义、annotation、纯函数） |
| `scripts/verify-live-preview.mjs` | 围栏夹具补 info mark 期望 + 新增语言标签小节 |
| `package.json` | 仅 1 行：`verify:code-block` script |
| `docs/INDEX.md` | 导航表补 `decisions-code-block.md` 一行 |
| `src/utils/selectionClip.ts` | 新增（D10）：`selectionBandClip()` —— 实测内容列 inset 写入 `.cm-selectionLayer` 的 CSS 变量与像素宽度 |
| `src/components/Editor/MarkdownSourceEditor.tsx` | D10：`basicSetup` 后挂 `selectionBandClip()`，1 处 import + 1 处调用 |

## 验证

- `npx tsc --noEmit`：通过（他人 `table*.ts` 在飞期间的报错不计入本轮，最终复跑见下）
- `node scripts/verify-code-block.mjs`：62 项 · 0 失败（判定 19 组：真 9 / 假 10）
- `npm run verify:live-preview`：77 项 · 0 失败（含 `cm-md-code-info` 5 条）
- `npm run verify:editor-blocks`：20 项 · 0 失败（101 个真实文档 / 5935 块）
- `npm run verify:input-rules`：53 项 · 0 失败
- `npm run verify:block-delete`：51 项 · 0 失败
- `npm run verify:ui-polish`：152 组合 · 150 达 4.5:1 · 无失败
- `npm run build`：通过（3652 modules，dist 里 `md-code-border` / `md-code-info` /
  `cm-md-code-first` 三个新标记各 1 处）
- `npm run tauri -- build --no-bundle`：通过（MSVC 14.36.32532 + SDK 10.0.22000.0，
  `Finished release profile in 1m 26s`，exe 45,415,936 B）
- `npm run verify:webview`：**通过**，`failures: []` / `consoleErrors: []` / `consoleWarnings: []` /
  `networkNoise: []`，退出码 0，`ok: true`；报告值 editorCard 1053×971、shellCards 3、
  dragRegions 14、railButtons 40、themeClass `theme-dark`、`repeated-open` 无

### 验收状态：已验收（2026-11-09，合并树构建）

先记一次环境事故：`tauri build` 首次失败于 `linker link.exe not found` —— 本机 MSVC Build Tools
与 Windows SDK 在 2026-11-08 15:12 被卸载（`VS\2022` 与 `Windows Kits\10` 只剩空目录，
`vswhere` 返回空，`KitsRoot10` 注册表值为空）。重装 VS 2022 Build Tools（VCTools 工作负载 +
`--includeRecommended`）后恢复为 MSVC 14.36.32532 / SDK 10.0.22000.0；`env.ps1` 里写死的
14.44.35207 / 10.0.26100.0 不存在，脚本的「取最新」回退生效，四个路径全部落地真实目录。

**旧 exe 不能顶替新构建**，但判据不是 `grep -a` 查 CSS 文本：Tauri 对嵌入资源做 brotli 压缩，
新旧 exe 里 CSS 文本都是 0 命中。正确判据是**资源文件名**——新 exe 内 `index-DJn13j_l.js`
与 `index-DIPjQh7q.css` 各命中 1 次，旧构建的 `index-2Xq-JrNd.js` 为 0。

六组 `--eval --no-assert` 实测（暗色主题，1707×1019 视口）：

| 探针 | 实测 |
| --- | --- |
| 卡片内距 | `paddingLeft = 14.4px`，同行 `font-size = 14.4px`（即 1em 真正生效；旧规则是 6px） |
| 边框可见度 | 边框 `rgb(138,144,152)` / 底色 `rgb(37,38,43)`，WCAG 对比度 **4.69:1**（≥3） |
| 圆角 | 实块 `borderTopLeftRadius = 10px`，`--box-radius` 解析同为 `10px` |
| 引用内代码块 | `borderLeftWidth` 计算值 2.667px（3px 在 dpr 1.5 下取整为 4 物理像素）、左圆角 `4px`、`color = rgb(233,236,239)` = `--color-text-primary` |
| 语言标签 | 外层与内层 span 的 `color` 完全相同（`color(srgb 0.775 0.816 0.948)`）→ `inherit` 规则确实压住了 |
| 行号对位 | 首行/末行 `lineH` 与 `gutterElement` 高度、`top` 差值均为 **0px**（行 41 块；该次测量在 546px 窄编辑器下） |

**未验证（需人工目视）**：宽视口下的行号对位（只在 546px 编辑器宽度下量过）；代码块卡片的
实际观感（最终截图视口内没有代码块，19:29 那张有代码块但整段被选区色带覆盖）；四主题下 30/70
边框的观感；引用内代码块 3px 竖线与 4px 左圆角的接缝；150% 缩放下 1px 线是否发灰；Ctrl+A
两段式与真实剪贴板粘贴的手感（headless 只覆盖 spec 层与合成事件）。


**需人工目视确认（本机无 GUI，一律未写「已验证」）**
1. Ctrl+A 两段式的真实按键手感与 IM E/剪贴板路径（本机只能合成事件）；
2. 粘贴后的光标落位与滚动时序；
3. 四套主题下 30/70 边框的实际观感，尤其暗色 3.27 是否显「通电」；
4. 引用内代码块：3px 竖线与 4px 左圆角的衔接、左重右轻是否可接受；
5. 空正文块只显示语言名的样子；
6. 150% 缩放下 1px 线是否发灰。

### D10 的验收（2026-11-09，release exe + 真实 WebView2）

几何与像素两路都取了证据（`--eval --no-assert` 直连 CDP，视口 1200×800，dpr 1.5，暗色主题）。
`--no-assert` 不能省：窄窗下编辑器会塌陷成 `editorCard w:1`，带断言的探针会直接 exit 1，
量不到几何；探针只负责读数，断言留给 `verify:webview` 那一次正式验收：

| 探针 | 实测 |
| --- | --- |
| 图层宽度 | `.cm-selectionLayer` 由扩展写成 `1046px`（= `.cm-scroller` 的 `clientWidth`），不再 0×0 |
| 左右 inset | `--cm-sel-clip-left: 58px`（gutter 38 + content padding 20）、`--cm-sel-clip-right: 20px` |
| 左边界像素 | CSS x=359 仍是面板底色（36,37,39），x=361 起出现色带（44,51,74）→ 色带止于 content padding box（360.53） |
| 右边界像素 | x=1327 仍有色带，x=1332 起回到底色（58,59,65）→ 止于 content padding box 右沿（1328.67） |
| 卡片对齐 | 代码块行 border box 左沿 `360.53` = 裁切边 `361`（1px 边框跨在 padding box 上，向内 0.47px），即色带落在卡片内侧、边框仍可见 |
| 无副作用 | `scrollWidth = clientWidth = 1046`，加宽图层没有引入横向滚动；光标层与协作光标是另外的元素，不受裁剪影响 |

**需人工目视确认**：选中整块时首/末行的 10px 圆角会被矩形色带填成直角（D10 已列为已知代价）。

### D10 的研发团复核（2026-11-09，P4 只读守门 + P5 QA）

**结论**：代码层证据已闭环，`353ee18` 无缺陷、无硬规则违反；**release 验收闭环仍未闭环**。
两者不能混写。复核时 HEAD 已由并行会话推进到 `0a24d1a`（`353ee18` 为 HEAD~4），
工作区仍有 16 个在途文件，因此本轮全程只读、不构建、不启动/关闭验收窗口。

新增证据（均来自真实 WebView2 只读 CDP 探针，非合成卡片）：

| 项目 | 实测 |
| --- | --- |
| 运行时指纹 | 三个不同时刻窗口均命中 `selectionBandClip()`：`538px / 50 / 20`、`1046px / 58 / 19`、`538px / 50 / 20`，与 `left = content.offsetLeft + padLeft`、`right = clientWidth - (offsetLeft + offsetWidth - padRight)` 逐字吻合；独立笔记窗口亦生效（`960 / 50 / 20`） |
| 压缩产物层叠（守门员 U7） | theme 注入的 `clip-path` 位于内联 `<STYLE>` 的 rule 153/154/155，LINK 的压缩 CSS 只有 `z-index:1` 与 `pointer-events:none`、无任何 `clip-path` 覆盖 → computed 值确为 `inset(-100000px 20px -100000px 50px)`，层叠未被在途 CSS 反杀 |
| **卡片级像素证据** | 19 个真实 `.cm-md-code-block` 卡片 + 合成 Ctrl+A + PIL 逐像素扫描：色带左沿 `360.67` / 右沿 `1329.33`，卡片 border box `360.53` / `1329.20` → 外溢 **+0.14px / +0.13px**（≤1px 通过）；行号槽与右侧滚动条区均为面板底色、无色带像素。截图 `local_img/qa-r2-selection-band.png` |
| 几何与副作用 | 裁切边 `353.00 / 821.00` vs 内容列 padding box `353.22 / 821.33`（-0.22 / -0.33px）；`scrollWidth == clientWidth == 538`、`bodyOverflowX = 0` |
| 静态门禁 | `npx tsc --noEmit` 退出 0 / 0 行；`verify:code-block.mjs` 144 项 0 失败、`verify:live-preview` 100 项 0 失败 —— 但两脚本已被并行会话改写（+286 / +296），**结果不作 D10 纯证据** |

**为什么仍不能判「已验收」**：本轮 dist 是含在途 CSS（围栏 `height:0`、语言 chip、
`.cm-activeLine:not(.cm-md-code-block)`）的合并树构建；验收期间窗口/session 被并行会话重启
≥3 次（pid 36192→67256）；没有 test→build→verify 顺序日志，也没有官方 `ok:true` 与
`consoleErrors: []`。守门员因此判 `IS_PASS: NO`（针对交付判定，非代码正确性），QA 路由
`NoOne`（不退回工程师、不退回脚本）。

**解除条件**：并行会话收敛、在途文件冻结 → 主理人按 `AGENTS.md §Session resume` 用「仅目标提交」
的干净树重跑唯一一次 `verify:webview:status`（→ 必要时 `:close`）→ `npm run build`（PowerShell）
→ 加载 MSVC 环境 → `npm run tauri -- build --no-bundle` → `npm run verify:webview`，留存
`ok:true` / `consoleErrors: []` / `buildMatch:true` 的 JSON 报告；顺序固定 test→build→verify，
`tauri build` 之后不再跑 `cargo test --release`（会让指纹 stale）；探针一律 `--eval --no-assert`。
完成后方可把「交付完成」改为 YES。

**回归面未验证项**（本机无 GUI，禁止写成「已验证」）：垂直/水平滚动时序、软换行、超长行、
行号三档位切换（仅观测到 30.22→50 / 37.53→58 两档，证明 inset 随 gutter 动态测量）、
`editorZoom`、四套主题、只读视图/便签/协作编辑器的运行时、拖拽/流式/IME/托盘/多窗口激活，
以及选中整块时首末行圆角被填平的观感。

## 开放问题

1. **边框对比度没有脚本兜底**：`scripts/verify-contrast.mjs` 只校验文字组合。30/70 是手算
   token 得出的，建议后续给 contrast 脚本补一条「非文字 3:1」规则（本轮不做，属该脚本扩面）。
2. **`CloudNoteEditor` 被动继承**：协作编辑器复用 `MarkdownSourceEditor`，因此也会有
   Ctrl+A 分段与粘贴成块。本轮判定「不为其加开关」（需求未提，加开关立刻产生行为分叉）；
   本机无 collab server，**未验证**。
3. **源码档是否该一视同仁**：当前两档行为一致。若用户要求源码档保持「纯粘贴」，需要
   `codeBlockInteractions({ paste: false })` 这类开关，但会引入行为分叉，需用户拍板。
4. **缩进代码块（`CodeBlock`）的正文口径**：取「首个 `CodeText.from` … 末个 `CodeText.to`」，
   不含行首缩进。是否该连缩进一起选，未与用户确认。
5. **粘贴判定的已知假阴性**：diff/patch、CSV、小写 SQL、以及三行 `await fetch(url)`
   （无花括号/缩进/分号）判 false。`await/async` 目前只作 `public/static` 一类的前缀组，
   「修饰词 + 非关键字调用」的行不计分。收法很小（把 `await|async` 移回核心候选），但它要求
   重走一次完整 test → build → verify，本轮判定不划算，留作独立一轮。

---

## 追加（2026-11-09）：单击代码块透出背景 / 毛玻璃方案实测撤回

> 用户报障：单击围栏代码块，光标所在那一行整行透明、透出壁纸。要求「点击只显示光标、不改背景」，
> 并把代码块的透明改法换成毛玻璃。grill 拍板：两处表面同步、保守 84%、保留行号槽高亮；
> 两份独立只读判定给出实测数字后，用户改拍「回到不透明 + 顶高光」。

### 结论 1｜根因是 `!important` 的活动行透明规则，不是卡片样式

卡片底色是 `.cm-content .cm-line.cm-md-code-block` 的 `background-color: var(--color-bg-secondary)`
（三 class、不透明）。而 `index.css` 另有一条
`.cm-editor .cm-line.cm-activeLine { background-color: transparent !important; }`，
本意是去掉 CodeMirror 基础主题的整行染色条（`&light .cm-activeLine` 是两 class，单靠
`noteEditorTheme` 的 `transparent` 压不住）。**两者落在同一个 `.cm-line` 元素上**，
`!important` 无条件取胜 → `highlightActiveLine` 只在编辑器获得焦点时给光标行加类，
表现正好是「点哪行、哪行透出背景」。

修法：给透明规则加 `:not(.cm-md-code-block)`，`!important` 保留。
- 卡片内不会把 base theme 的染色条找回来：那条是两 class 且无 `!important`，
  在任何源码顺序下都输给三 class 的卡片填充。
- 卡片外的活动行仍然透明，原规则的正当目的没有丢。
- 行号槽 `.cm-activeLineGutter` 的 12% 品牌色保留：它是光标定位反馈，不是代码块背景。

CSS 优先级问题没有第二种解法：把卡片填充也写成 `!important` 会让它反过来压掉其他卡片的
活动行语义，且新增一条永久性的 `!important` 军备竞赛。

### 结论 2｜毛玻璃（84% 填充 + 8px blur）实测后撤回

先按用户初始选择实现过一版：编辑器逐行与预览卡都用
`color-mix(in srgb, var(--color-bg-secondary) 84%, transparent)` + 固定 `backdrop-filter: blur(8px)`，
另配 `prefers-reduced-transparency` 降级与打印关闭。两份独立只读判定（硬规则守门、视觉设计）
**算出同一组数，结论都是撤回**：

| 项 | 实测 |
|---|---|
| 壁纸真实透出率 | tint 40/60/63/76 → **9.6% / 6.4% / 5.9% / 3.8%** |
| 项目自测的「blur 不可辨」阈值 | 透出 20% 时三档 blur 几乎不可辨 → 6% 低了约 3 倍 |
| 默认壁纸档（tint 63）文字 4.5:1 | blue **4.41** / dark **4.22** / yellow **4.34** / green 4.45 |
| tint 拉到 40 | blue 4.04 / dark 3.73 / yellow 3.98 / green 4.07 |
| 卡片描边 1.4.11 3:1 | 3.05–3.26 → 壁纸最差 **2.44–2.53** |
| 守住 4.5 所需不透明度 | tint 40 极端壁纸要 92–95%，此时透出只剩约 3%，比 84% 更不像玻璃 |

两点决定性理由：
1. **两个目标没有交集**：要读成玻璃需透出 ≥20%（填充 ≤50%），要守住 4.5 需填充 ≥92–95%。
   这正是 `topics/tokens-colour.md` §三已写明的「半透明卡片 + 正文 4.5:1 在任意壁纸下不可同时成立」。
2. **参考系就在同一像素旁边**：`.cm-gutters` 是不透明 `--color-bg-secondary`，与卡片只隔 1px
   发丝线。有壁纸时读到的不是「玻璃」，而是「代码卡和行号栏不是一个颜色」。

额外代价：卡片是 `Decoration.line` 逐行拼的，逐行 `backdrop-filter` = 视口内每行一个合成层
（滚动重采样、字形退回灰度 AA、首末行圆角泄漏未知）；`backdrop-filter` 还会让该行成为
`position:fixed` 的包含块，正好会坑到并行那条「代码块语言选择菜单」（锚点在 `.cm-md-code-info`）。

**结论：卡片回到不透明 `var(--color-bg-secondary)`，预览卡回到 90/10 原值，代码卡段落
零 `backdrop-filter`**。撤回后前述对比度风险、合成层、字形、fixed 包含块四类风险同时消失。

### 结论 3｜材质感改由首行顶高光承担

真正让人读出「一张抬起的表面」的线索是顶边 1px 镜面高光，而不是不可见的 6% 透明。
`.markdown-code-block` 本来就有 `box-shadow: inset 0 1px white 16%`，编辑器卡没有 —— 两处
自称「同一材质」，线索却是零。补：

```css
.cm-content .cm-line.cm-md-code-block.cm-md-code-first,
.cm-content .cm-line.cm-md-code-block.cm-md-code-single { box-shadow: inset 0 1px color-mix(in srgb, white 16%, transparent); }
```

**只命中两个 cap，绝不写在基类上**：逐行 `Decoration.line` 会给每一行都画一道 1px 亮线，
卡片会变成横纹。折叠围栏那条线会把 `-first` / `-last` 搬到可见行，故再补一条同源镜像
（`-first.cm-md-code-fence-hidden + .cm-line.cm-md-code-block` 只搬 `box-shadow`，
`border-top` / 圆角由对方那条规则负责）；实测装饰把 `-first` 放在可见行，镜像当前是 no-op，
纯属保险。

预览卡的语言条 `color-mix(bg-active 36%, bg-secondary)` **保持实底**：它只有 0.75em/700 的
11–12px 字，透化后在 tint 40 + 亮壁纸下会跌到约 4.05，且暗色主题下卡片可能反过来比语言条亮，
层级从「凸起」翻成「下凹」。

### 验证（2026-11-09，区分「实测」与「未验」）

- `npm run build`（PowerShell）：**通过**，`tsc` 零错误，3657 modules，`dist/assets/index-Chuh_I9j.css`。
- `npm run tauri -- build --no-bundle`（MSVC 14.36.32532 / SDK 10.0.22000.0）：**通过**，
  1m30s，exe 45,420,032 B。
- `npm run verify:ui-polish`：15/15 静态审计 PASS、对比度 152 组 `no failures`；
  `verify:live-preview` 100/0；`verify:code-block` 144/0（后两项的项数由并行线扩充）。
- **生产 CSS 计算样式实测**（无头 Edge 加载 `dist/assets/index-Chuh_I9j.css`，dark + blue 两套）：
  代码块活动行 `rgb(37,38,43)` / `rgb(226,232,240)`，与同块非活动行**完全相同**且不等于
  `rgba(0,0,0,0)`；块外活动行仍是 `rgba(0,0,0,0)`；所有代码行 `backdropFilter: none`；
  首行/单行/折叠镜像行 `boxShadow` 含 `inset`，中间行 `none`；
  `.cm-selectionLayer` = `z-index:1` / `pointer-events:none`；
  描边 1px 且颜色仍为 30/70 派生值。夹具截图（临时、已删）确认卡片整块不透明、无横纹、无接缝。
- **`verify:webview`（真实 WebView2，release exe）通过**：复用已开窗口
  （pid 36192 / CDP 9333，`reused: true`，buildId 指纹与 `dist/` + exe 一致），
  `ok: true`、`failures: []`、`consoleErrors: []`、`consoleWarnings: []`、
  `networkNoise: []`、`url: http://tauri.localhost/`、`keptOpen: true`、
  `themeClass: theme-dark`、`editorCard 546×752`、`shellCards 3`、`fontsStatus: loaded`。
  首次尝试曾被已安装实例 `E:\QingNotepad\qing-notepad.exe`（pid 38416，带 `README.md`
  启动）占单实例锁挡住，**未 kill 任何用户进程**；该实例随后退出，并行线用同一份
  release exe 开了窗口，故直接复用。窗口按规则保持常驻，收尾未关。
- **真实 WebView2 计算样式探针**（`--eval --no-assert`，页面内临时构造同类
  `.cm-editor` / `.cm-line` DOM、读完即移除，**不改任何笔记数据**）：dark / blue 两套下
  代码块活动行 `rgb(37,38,43)` / `rgb(226,232,240)` 与同块非活动行**完全相同**，
  块外活动行仍是 `rgba(0,0,0,0)`；所有代码行 `backdropFilter: none`；
  首行 `inset` 高光、中间行 `none`；选区层 `z-index:1 / pointer-events:none`；
  预览卡为 90/10 合成色且无 blur；描边 1px 仍是 30/70 派生值。
  真实编辑器里 `.cm-line.cm-activeLine` 数量 = 1，证明 CodeMirror 确在聚焦时加类。

**需人工目视（本机无 GUI，一律未验证）**：验收时打开的笔记里没有围栏代码块，所以
「真实点进代码块 → 光标落位 / 编辑输入 / IME / 选区拖拽」这条交互路径**没有被端到端覆盖**
（计算样式探针用的是临时 DOM，不是真笔记）；四套主题与真实壁纸下的边框观感、
HiDPI 下顶高光与圆角贴合、折叠围栏时的接缝、长代码块滚动帧率、
语言条实底与卡片材质的层级、系统「减少透明效果」开关。

### 本轮新增的开放问题

1. **`verify-contrast.mjs` 不含代码 token 组**：全文无 `--color-code-*` / `hljs` 断言，
   `composited` 只从 `:root` 读 tint 合成面板，不看代码卡；`--md-code-border` 的 1.4.11 3:1
   也从未进脚本（原开放问题 1 已自陈）。本轮靠两份人工复算把关，门禁本身仍绿得没有依据。
   建议独立一轮补「代码卡合成面 + 非文字 3:1」两组。
2. **`--color-code-*` 在 `:root` 声明处替换**：`data-contrast="boost"` 提升不到代码 token
   （`--color-accent-text` 却会跟着 boost 走），卡内层级在 boost 时被打乱。计算对比度口径时
   不能用 boost 值兜底。
3. **并行线的过时注释**：折叠围栏 / 语言角标那段 CSS 仍写着「frosted card」「measured on the
   84% card」，前提已被本轮撤回。数值只增不减（不透明卡上对比度更高），结论仍成立，
   但措辞需由那条线的负责人清理。
4. **磨砂例外清单**：`topics/ui-rules.md`「磨砂只在 `.surface-glass::before`」事实上已有多处
   既有例外（modal backdrop、sticky container 等），建议补一张判定条件清单，避免每轮重新争论。
