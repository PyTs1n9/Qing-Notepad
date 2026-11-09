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
- `npm run tauri -- build --no-bundle`：**失败**，`linker link.exe not found`
- `npm run verify:webview`：**未运行**（没有新 exe）

### 验收状态：阻塞（2026-11-09）

`tauri build` 失败的原因不是配置，是本机工具链被卸载：`C:\Program Files (x86)\Microsoft Visual
Studio\2022` 与 `Windows Kits\10` 只剩空目录（mtime 均为 2026-11-08 15:12），`cl.exe`/`link.exe`/
`rc.exe` 全部不存在，`vswhere` 返回空，`KitsRoot10` 注册表值为空；`env.ps1` 指向的四个路径今天
全都不存在。`rustup` 只有 msvc target，没有 gnu 回退。

因此本轮**没有真实 WebView2 证据，判定「未验收」**。旧 exe（11-07 08:51）不能顶替：二进制内
`md-code-border` / `md-code-info` / `cm-md-code-first` 计数均为 0，dist 哈希已变而 exe 戳未变，
跑出来的截图是上一版 UI。工具链恢复后补跑：`npm run build` → `tauri build --no-bundle` →
`verify:webview`，并按 QA 清单量 `paddingLeft ≠ 6px`、边框对比度 ≥ 3、`--box-radius` = 10px、
引用内 `3px/4px/text-primary`、`.cm-md-code-info` 内层 inherit。

**需人工目视确认（本机无 GUI，一律未写「已验证」）**
1. Ctrl+A 两段式的真实按键手感与 IM E/剪贴板路径（本机只能合成事件）；
2. 粘贴后的光标落位与滚动时序；
3. 四套主题下 30/70 边框的实际观感，尤其暗色 3.27 是否显「通电」；
4. 引用内代码块：3px 竖线与 4px 左圆角的衔接、左重右轻是否可接受；
5. 空正文块只显示语言名的样子；
6. 150% 缩放下 1px 线是否发灰。

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
