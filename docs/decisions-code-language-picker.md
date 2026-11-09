# 代码块：右下角语言选择器与围栏隐藏

> 结论真源。口径：结论 + 理由 + 开放问题。
> 相关：`decisions-code-block.md`（卡片容器 / Ctrl+A / 粘贴成块）、
> `decisions-typora-editor.md`（L3 按块降级）、`decisions-preview-edit.md`（纯预览编辑档）。
>
> 与 `decisions-code-block.md` 分开成篇：那篇已收尾验收，本轮改动的是另一套块级规则，
> 追加进去会让「已验收」的结论串味。

## 需求（用户确认）

参考 Typora 的代码块语言选择交互：

1. 语言类型入口放在**代码块卡片右下角**，hover 才浮出；点击弹出固定语言表，选中即切换语言。
2. **隐藏 Markdown 的 ``` 围栏标记**，使其不在编辑或展示中出现。
3. 「默认状态下保持代码块降级功能正常启用」——经澄清指 **L3 按块降级**：光标进入代码块时
   整块回退源码、围栏回显，离开即隐藏。
4. 源码档保持原样（围栏可见、可手改围栏长度与 info string）。

grill 三轮拍板：降级＝光标回退源码；围栏在光标进块时**回显**；语言表＝**固定表**（14 种
已注册语言 + 纯文本/清除）；入口 **hover 才显示**；**除源码档外全部隐藏**（实时渲染档、
纯预览编辑档、贴图/卡片窗等只读面）；**接受行号跳号**。

## 结论

### D1 围栏隐藏走「零高度行」，不走 StateField block replace

`line` 装饰给围栏行挂 `cm-md-code-block cm-md-code-fence-hidden`（4 个 class，压得住既有
三 class 卡片规则），再加一条**不跨换行**的 `Decoration.replace({})` 把文字吃掉；CSS 把该行
压成 `height:0 / line-height:0 / font-size:0 / overflow:hidden`，并显式清零 `padding` 与
`border-width`（否则 0 高度行上残留 1px 竖痕）。引用内的围栏要第 5 个 class 才压得住
`.cm-md-quote.cm-md-code-block` 的 3px 竖线。

**不用 block replace 的四条理由**：① 它要求把整个 `[node.from, node.to)` 换成一个 widget 的
DOM，语法高亮、可编辑性、caret 回退、行号全部要在 widget 里重做；② widget 里的文字不是文档，
光标永远进不去，需求 3 的按块降级无从谈起；③ `tableField.ts` 的列宽注释已有同形先例
（`META_LINE` + `HIDE`）；④ 留在 ViewPlugin 里可白拿 `visibleRanges`、`push()` 的 reveal 过滤
和 `syncActive` 的增量补丁。表格必须走 StateField 是因为它本来就要「多行 → 一张真表」，我们
只是删掉两行，能力不匹配。

### D2 revealed 分支保持原逻辑，这就是「降级正常启用」

`revealed = reveal && node.from >= reveal.from && node.to <= reveal.to`。为真时完全走
`addCodeBlockLines` + `addCodeInfoMark`：卡帽仍在两条围栏行上、语言 info 仍是普通可编辑文本，
用户能直接手改语言与围栏长度。`collectLivePreviewRanges` 的 `push()` 对 reveal 区间内的
`hide`/`widget` 过滤是这套行为的既有实现，本轮没有放宽——**新加的 `codeLang`（chip）同样进了
这条过滤**，属于收紧而非放宽：光标在块内时 chip 一并收起，因为此时围栏已回显、可直接手改语言。

### D3 空块靠「最后一条围栏行保留行高」占位

`Decoration.replace({})` 只换文字，**不消除行高**（这正是表格列宽注释需要额外 `META_LINE`
的原因）。因此：

| 形态 | 处理 |
| --- | --- |
| 有正文 | 两条围栏行都塌陷，卡帽迁到正文首末行 |
| 空块 / 只有空行 | 塌陷开围栏行与空正文行；**闭围栏行不塌陷**，文字照样 replace，成为唯一可见行（`cm-md-code-single`），承载 chip 与可点区域 |
| 单行围栏（刚敲完 ```） | 什么都不隐藏——用户正在写它，且光标必然在块内 |

空块若两行全塌，整张卡片会从视图里消失，用户会以为块被删了。这是本轮最容易返工的一处，
由 `verify-live-preview.mjs` 的 4 个空块夹具钉住。

### D4 卡帽从围栏行迁到正文行；`cm-md-code-info` 在隐藏态抑制

隐藏态由 `addCardLines(state, visible, push, bodyFirst, bodyLast)` 重算 first/last。info mark
必须抑制：围栏行整行被 `replace` 后 mark 已无字可染，且会踩「hide 与 mark 不重叠」的既有
不变量。视觉标签由 chip 顶替，其文本读 fence info 的**第一个词**（原文，不做规范化）。

### D5 hover 只切换 class，绝不重建装饰

`LivePreviewView` 记 `hoveredBlock`，`contentDOM` 的 `mousemove` 经 rAF 节流 →
`posAtCoords` → `codeFenceInfoAt` → 只在**跨块边界**时 toggle 对应 chip 的 `.is-visible`；
`mouseleave` 清空；`composing` 期间直接 return。

重建装饰会替换 chip 的 DOM（`WidgetType.eq` 变了），指针下的元素消失即典型 hover 抖动。
另一个坑：`ViewPlugin.update` 在 `docView.update` **之前**执行，内联 `querySelector` 拿到的是
旧 chip，且此时 `view.posAtCoords` 会抛 `Reading the editor layout isn't allowed during an
update`——重贴 class 必须走 `view.requestMeasure({read, write})`（`scheduleHoverSync()`）。

CSS 另保留一条「chip 所在行 `:hover` 显示」兜底：chip 绝对定位在行盒之外，鼠标移向它时
`posAtCoords` 可能映射到相邻行甚至块外，纯 JS 的 `hoveredBlock` 会把类摘掉导致点不到；
CSS `:hover` 基于元素盒几何，正好补这段。

### D6 语言面板必须挂 `document.body`，不能用 React `DropdownMenu`

编辑器卡带 `container-type: inline-size`，`contain: layout` 会让它成为 `position: fixed`
后代的包含块，再叠 `overflow: hidden` 把浮层按卡片定位并裁掉（`DropdownMenu.tsx:84-88`
有同坑注释）。所以面板自绘 DOM（`div.cm-code-lang-menu`）、`fixed`、`z-index:60`
（顶栏菜单是 `z-50`，同为 body 级 portal），只由 TS 内联 `top/left/visibility`。

关闭四件套：Esc（捕获阶段）、点外部（捕获阶段）、`view.scrollDOM` 滚动 + `window` 的
`resize`/`blur`、view `destroy()`。面板在 body 上**只关不跟**。选中 → 先 close →
`view.dispatch(codeBlockLanguageSpec(...))`，不 `scrollIntoView`，一次 transaction 一步 undo。
第一版不实现 Tab 焦点环（不承诺完整 a11y），AT 用户走源码档改语言。

### D7 设语言是纯 `TransactionSpec`，与 Ctrl+A / 粘贴同族

```ts
codeFenceInfoAt(state, pos): CodeFenceInfo | null      // 缩进块返回 null
codeBlockLanguageSpec(state, pos, language: string | null): TransactionSpec | null
```

`language === null` 清除，`""`/未注册语言拒绝，目标词已是 canonical 时返回 `null`（幂等，
不产生空 undo 步）。只替换 info 的**第一个词**，保留 `title=...` 等尾部参数；`userEvent`
写 `input.setLanguage`。

**`infoFrom` 取开围栏 `CodeMark.to`，不是 `CodeInfo.from`**：lezer 的 `CodeInfo` 会 trim 前导
空格（``` ``` python ``` ``` 里空格不属于任何节点），只有从 `CodeMark.to` 起算才能既保留前导
空格、又在清除时连带删掉分隔空格，得到干净的 `` ``` ``。QA 按字面复核签名时不要误判为写错。

### D8 语言表单一真源

`highlight.ts` 的 14 次 `registerLanguage` 改为一张 `LANGUAGES: Record<string, LanguageFn>`
+ 循环注册，`CODE_LANGUAGES = Object.keys(LANGUAGES)` 导出给菜单。`resolveLanguage` 语义一字未改，
未注册语言仍返回 `""`（**不着色＝降级路径照常启用**）。`verify-code-block.mjs` pin 了「顺序逐项
相等」+「14 项都能被 spec 解析」两条断言，任何漂移都会红。

### D9 i18n 从组件层经 config 传入，不新增 `utils → stores` 边

只有「纯文本」和标签文本需要翻译；非空 info 显示原文，天然语言无关。
`MarkdownSourceEditor` 新增 `lang?: LangType`，`previewLayer(live, editing, lang)` 把
`plainText` 塞进 `codeLanguage`；**不能在组件里 `useSettingsStore`**——`NoteWindowView` 也挂载
它，而子窗口不读 settingsStore。`NoteEditor` 传 `lang` 一行。
`livePreview/*` 与 `highlight.ts` 均不 import store，`npm run verify:architecture` 的 15 条
白名单一个字未动。两个模块级 Extension 常量改成按 lang 记忆的 `Map`，避免每次渲染生成新的
ViewPlugin 类型导致 Compartment 反复重配。

### D10 只读面用 `static` 双保险

`MarkdownReadonlyView` 传 `codeLanguage: { mode: "static" }`：chip 常显、
`pointer-events:none`、**不挂任何 DOM 监听**。因为 `EditorState.readOnly` **不拦
`view.dispatch`**（只影响输入处理与 `aria-readonly`/`editable`），只靠 readOnly 挡不住写入。
`static` 且无语言的块**不发 chip**——否则只读窗/纯预览里每个裸示例都会永久挂一条「纯文本」尾巴。

### D11 不在本轮范围的四件事

- **`CloudNoteEditor` 不继承 livePreview 层**：它自己 `new EditorView`，扩展表只有
  `basicSetup / markdown() / themeAwareMarkdownHighlighting / yCollab / readOnly`，
  现状就是纯源码 + 协作光标，本轮零改动。
- **缩进代码块（`CodeBlock`）不给入口**：没有 fence 可藏、没有 info 可写；「转围栏」属新需求。
- **`previewEditing` 的光标进不可见围栏行**：`revealActiveBlock:false`，方向键可落到 0 高度
  围栏行并静默改掉 info/围栏长度。裁定第一版记为**已知限制**：`atomicRanges` 需新 StateField，
  且会引入「整条围栏被当原子单位删除」的新语义，收益小于风险，留作独立一轮。
- **`StickyNote` / 预览页**靠默认配置跟随（便签窗是可编辑的第二写者，保持 `menu` 模式）。

## 落地文件

| 路径 | 动作 |
| --- | --- |
| `src/utils/highlight.ts` | `LANGUAGES` 单一真源 + `CODE_LANGUAGES` |
| `src/utils/livePreview/codeBlock.ts` | `codeFenceInfoAt` / `codeBlockLanguageSpec` |
| `src/utils/livePreview/codeLanguageMenu.ts` | **新增**：自绘浮层、定位、四路关闭 |
| `src/utils/livePreview/codeLanguageWidget.ts` | **新增**：右下角 chip 的 DOM 与点击入口 |
| `src/utils/livePreview/decorations.ts` | `addFencedCode` / `collapseLine` / `addCardLines` / `addLanguageChip`；新 spec kind `codeLang` |
| `src/utils/livePreview/index.ts` | `codeLanguage` 配置透传 + hover 控制器 + 生命周期 |
| `src/components/Editor/MarkdownSourceEditor.tsx` | `lang` prop、`previewLayer` 记忆化 |
| `src/components/Editor/MarkdownReadonlyView.tsx` | `static` 档 |
| `src/components/Editor/NoteEditor.tsx` | 传 `lang` 一行 |
| `src/index.css` | 隐藏行、chip 定位上下文、chip、面板四段追加 + **一处既有规则收窄** |
| `scripts/verify-code-block.mjs` | 62 → 144 项（含设语言 11 条边界） |
| `scripts/verify-live-preview.mjs` | 78 → 100 项（隐藏态/revealed 双夹具、空块、不变量） |
| `docs/decisions-code-language-picker.md` | **新增**：本决策记录（主理人收口） |

`index.css` 的「收窄」指 `.cm-editor .cm-line.cm-activeLine` 加 `:not(.cm-md-code-block)`：
该规则带 `!important`，比三 class 卡片底色更强，点进代码块时会把卡片整行抹成透明、
露出编辑器面板。收窄后卡片自己管底色，卡片外的 active-line 条纹仍然被压死。既有代码块
三选择器、`.cm-md-code-info`、`hljs-*` 调色板零改动（P4 只读核对确认）。

本轮 capabilities / CSP / `release.yml` / `utils/markdown.ts` / 导出链路**零改动**。
`package.json` 本轮主张零改动，但**并行线**在 `:37` 加了
`"verify:sidebar-search": "node scripts/verify-sidebar-search.mjs"`（配套未跟踪脚本
`scripts/verify-sidebar-search.mjs`），这两条路径一并计入并行线白名单，**禁止回滚、不得卷入本轮提交**。

## 验证（P5 实测，2026-11-09）

**静态门禁**：10 个 verify 脚本全部 EXIT=0（`verify:code-block` 144 项 / `verify:live-preview`
100 项 / `verify:architecture` PASS 240 文件 / `editor-blocks` 20 / `input-rules` 53 /
`block-delete` 51 / `markdown-commands` 43 / `markdown-stats` 43 / `markdown-links` 51 /
`ui-polish` 15-15，另 `verify-contrast` 152 组合 0 失败）；`npx tsc --noEmit` 退出 0。

**构建**：`npm run build`（PowerShell）退出 0，3657 模块、CSS 164.44 kB；
`npm run tauri -- build --no-bundle` 退出 0，exe 45,420,032 B。本机实际
MSVC 14.36.32532 / SDK 10.0.22000.0（`AGENTS.md` 里写的 14.44.35207 / 10.0.26100.0 不存在，
`env.example.ps1` 的「取最新」回退生效）。`tauri build` 之后未跑 `cargo test`。

**主验收**：`npm run verify:webview` → `ok:true`、`failures:[]`、`consoleErrors:[]`、
`url http://tauri.localhost/`、`shellCards 3`、`editorCard 546×752`、`dragRegions 14`、
`railButtons 40`、`fontsStatus loaded`、`keptOpen true`、`buildMatch true`；
收尾复跑 `reused true`，同样全绿。

**功能探针**（`test_temp/code-lang-fixture.md` + `--target noteWindow= --no-assert --eval`）：

| 探针 | 实测 |
| --- | --- |
| 隐藏围栏 / 卡帽 | `hidden 12` 且 height 全 0；first/last 全落在正文行而非围栏行 |
| chip | 7 个，label = `python / 纯文本 / 纯文本 / js / foobarbaz / markdown / text`，全 `data-mode=menu` |
| 空块 | 恰好 1 条 `cm-md-code-single`，`h=24.36>0`，`hasChip=true` —— **机制性风险排除** |
| 行号 | 33 个数字按 top 排序后 `overlapsAfterTopSort=0`，1..32 首尾连续；10 个隐藏行对应 gutter `h=0`。一次宽松探针报 1 处相交，查明是 `n=""` 折叠 spacer 的 DOM 顺序假阳性 |
| 菜单 | `parentIsBody=true`、`fixed`、`zIndex 60`、`rect 709,273 224×288` 完整落在 960×720 视口内；15 项（14 语言 + 纯文本）、1 条分隔、当前项 `.is-active` |
| hover | `opacity 1` / `pointerEvents auto`；chip `41×17` 完整落在 host `890×24` 内，`overlappingTextRectCount=0` |
| 选语言 | `foobarbaz → python` 后 `changedLineCount=1`，`hidden 10→10`、`cards 25→25`、行数 `32→32`，菜单已关 |
| 按块降级 | 点块外：首块围栏由可见转隐藏、chip 出现在末行，同时无语言块 reveal 出 ```；点回正文：首块围栏回显、其余仍隐藏 |
| 残留围栏 | 10 个零高度行 `h=0/overflow hidden/fontSize 0`；唯一可见 ``` 是光标所在块**故意回显**的源码 |
| 只读 TileView | `chipCount 3 / staticCount 3 / menuCount 0`，labels `python/js/foobarbaz`；computed 全 `pointerEvents none`、`opacity 1`、`cursor default`；合成 mousedown 后 `menuOpenedByStaticClick=false`、文本不变；无语言块无 chip |

**截图**（均保留在 `local_img/`）：`webview-main.png`、`webview-codelang-probe1.png`、
`webview-codelang-chip.png`、`webview-codelang-menu.png` / `-settled.png`、
`webview-codelang-final.png` / `-reveal.png` / `-after-pick.png`、`webview-tile-static.png`。
判读：卡片圆角连续、无裸露围栏、空块保留完整空白行、chip 在右下角空白区未压代码、
面板不透明实底且完整在视口内、只读窗只有静态标签。 `-menu.png` 的半透明是入场动画未结束的
时序产物，`-settled.png` 才是稳定态。

**P4 只读守门**：7 项硬规则 7/7 PASS；`IS_PASS: NO` 来自 3 处「注释/文档与事实不符」，
均已整改并复核（`index.ts:335` 注释改为与 `?? "menu"` 实现一致；本文档「只追加」「package.json
零改动」两处订正）。架构白名单仍 15 条、禁改项 `diff=0`、`NoteEditor.tsx` 只 1 行。

**路由：NoOne**。两个疑似缺陷均证伪：gutter 相交是 spacer 假阳性；夹具磁盘出现
`return namepython` 是 **QA 自身探针 bug**（把注入的 chip 塞进 CodeMirror 管理的 `.cm-line`
触发 DOM 回读，把 `python` 当用户输入写进文档），夹具已还原、改走 body 注入；产品保存链
`NoteWindowView.saveNow()` 用 `contentRef.current`（源 `MarkdownSourceEditor.tsx:376`
`onChange(update.state.doc.toString())`），不含 widget，无源码改动。

### 本轮过程偏差（如实记录，不隐藏）

1. **外部安装版实例的处置**：首次 `verify:webview` 退出 2，挡路的是
   `E:\QingNotepad\qing-notepad.exe`（PID 38416，窗口「知识账本」，带另一个项目的 README.md）。
   QA 报告称在收到主理人「禁止强杀」指令**之前**已强制结束该外部实例，而用户后续选择的是
   「我从托盘退出」；无论是否真的执行，这都违反并行线在 `5941735` 写入 `AGENTS.md` 的规则
   「Do not kill the user's installed instance … Ask the human to quit it from the tray, or record
   it as an environment blocker」。**旁证**：并行会话当日日志记载该 PID **在 20:47 前已自行退出**，
   故这次动作很可能是对已消失进程空操作，数据丢失风险低；仍建议用户重开一次安装版确认笔记无损。
   本轮验收窗口未被 kill。
2. 为重新打开独立笔记窗，QA 用过 2 次 `verify:webview:close` + `--app-arg` 重启；每次最终都
   保持常驻，未用 `--close-after`。
3. **验收期间工作区被并行会话推进**：`0400a5c`（侧栏搜索）、`5941735`（AGENTS 规则）、
   `b3160f3`（代码块单击不透底 + 首行高光，也改了 `src/index.css` 代码块段）、`0a24d1a`（验收记录）。
   其中 `b3160f3` 把本轮 CSS 的前 ~50 行（卡片注释 + `.cm-activeLine:not(.cm-md-code-block)`
   收窄）提前带入 HEAD；本轮剩余 `+285/-0` 的四段样式仍在工作树、未提交。
   **已构建并验收的 dist/exe 是 20:42–20:43 的快照**，本轮语言选择器相关 TS 文件此后未变
   （仅 `index.ts` 一行注释，esbuild 会剥掉），不影响本轮功能结论；但与当前 HEAD 不完全一致。
4. 主理人复核时进程表里已**没有任何 `qing-notepad.exe`**（QA 报的常驻 pid 67256 不在），
   与「验收窗口常驻」的口径不符；按 `AGENTS.md`「关窗即代表旧构建作废」，下一会话若要接着验
   必须重走 build + tauri build + 重新开窗。
5. 平台 429：P4 守门与 P5 验收首岗同时撞配额失败，换轻量模型重派后两岗均完整交付，
   **没有启用「主理人代跑验收」的降级**。

## 需人工目视确认（本机无 GUI）

1. hover 浮出的真实鼠标时序/手感；面板入场动画观感（只截到稳定态）；
2. 滚动时 chip 锚定、面板关闭时机与重开定位；窄窗下菜单上下翻转；
3. 真实鼠标点击 chip 与菜单项（探针用的是合成 `dispatchEvent`）；
4. 菜单 15 项 `scrollHeight 407 > clientHeight 287`，`sql/typescript/xml/纯文本` 需内部滚动
   后才能点到，滚动后的可见性与点击手感；
5. chip 与选区色带的层级；光标离开块时两行塌陷的视觉跳动与滚动落点；
6. 引用/列表内围栏的高度塌陷是否压掉容器标记；四套主题 / 极暗壁纸下 chip 与面板的观感；
7. IME 组合输入（冻结与 settle）、拖拽、多窗口并发、托盘退出 / close-to-tray；
8. 与上一版截图逐像素对比（无存档）。

## 开放问题

1. **行号格 —— 已关闭**：严格探针 `overlapsAfterTopSort=0`，无需 `overflow:hidden` 兜底。
2. **`previewEditing` 光标进不可见围栏行**：是否单独一轮上 `atomicRanges`（见 D11）。
3. **`NoteWindowView` 的 `lang`**：本轮它在途未碰，独立笔记窗拿默认 `zh`，英文用户会看到
   「纯文本」。下轮补一行传 `lang`。
4. **`MarkdownReadonlyView` 的标签 i18n**：module 级常量目前也拿默认中文，同上。
5. **空块 chip —— 已关闭**：真机 `h=24.36>0 / hasChip=true`，零宽锚点与 `hide` 终点重合安全。
6. **429 降级 —— 已关闭**：换模型重派成功，两岗产出完整，主理人未代写任何成员产出。
7. **是否需要按当前 HEAD 重建**：验收 exe 是 20:42 快照，之后并行线提交了 4 次（含同一段
   `index.css`）；若要求「dist 与 HEAD 逐字节一致」，需在并行线稳定后另起一轮 build + WebView。
8. **AGENTS.md 构建环境版本号过期**：写死的 14.44.35207 / 10.0.26100.0 本机不存在，
   应改成「取最新」或标注回退口径。
