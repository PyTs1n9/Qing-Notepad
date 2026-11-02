# 实现计划：Typora 式实时渲染编辑（方案 A）

日期：2026-11-02
分支：`typora-sec`
上游决策：`docs/decisions-typora-editor.md`

## 一、目标与非目标

**目标**：把本地笔记编辑器从「源码编辑 + 分屏预览」改为「单栏实时渲染」，文件本体仍是纯 `.md`。

**明确不做**：

- 不改存储层。`data/notes/<uuid>.md` 仍是纯文本，禁止引入任何中间格式落盘。
- 不动 `CloudNoteEditor`、`collab-server`、Yjs 相关代码。
- 不动 `plugin/bridge.ts` 暴露给插件的契约（`qing.editor.setDecorations` 等）。
- 不动主窗口 CSP、`fs:scope`。
- 表格首版只读。
- 不引入新的编辑器内核依赖。

## 二、模块拆分

| 编号 | 模块 | 产出 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| M0 | 视图模型 | `MarkdownViewMode` 增加 `live`；`MarkdownViewSwitch` 支持按调用方配置档位；本地默认 `live` | 无 | 本地两档、云端仍三档且行为不变 |
| M1 | 块解析 | `blocks(doc)` 返回块区间与类型，供后续装饰使用 | M0 | 50 篇真实笔记块列表人工核对无误 |
| M2 | L1 装饰层 | 行内标记隐藏 + 块级视觉；仅处理视口范围 | M1 | 静态文档观感接近 Typora |
| M3 | L3 按块降级 | 光标所在块回退源码；IME 组字期间冻结重算 | M2 | 逐块点击验证；中文输入不跳位 |
| M4 | L2 输入规则 | 11 条规则，逐条独立 | M3 | 逐条手工用例通过 |
| M5 | 跨块删除语义 | Backspace 块首 / Delete 块尾 / 跨块选区删除 | M3 | Marktext #5423 #5400 #5389 #5385 四类场景不复现 |
| M6 | 只读实例 | 贴窗、卡片窗复用同一套 decoration，`editable: false` | M3 | 与主编辑器观感一致 |
| M7 | 删除分屏 | 移除 `split` 档及其代码路径 | M3–M5 | 全仓无残留引用，构建通过 |
| M8 | 遗留数据迁移 | HTML 期笔记一次性转 Markdown 写回 | 无（可并行） | 抽样核对；二次运行无变化（幂等） |

## 三、实现顺序

```
M8（独立，可先做）
M0 → M1 → M2 → M3 ─┬→ M4 ─┐
                    ├→ M5 ─┼→ M7
                    └→ M6 ─┘
```

硬性顺序理由：

- M1 必须先于 M2：装饰的位置依赖块边界，边界定义错了，M2 会整体重写。
- M3 必须先于 M4：输入规则会改变块结构，没有降级机制时用户无法编辑被装饰的行。
- M7 必须在 M3–M5 验收后：分屏是当前唯一可用的阅读路径，提前删会让应用在过渡期不可用。

## 四、块的定义（M1 的判定基准）

- 顶层节点为单位：段落、标题、围栏代码块、引用、表格、分隔线、HTML 块。
- **列表按 `ListItem` 逐项成块**，不按整个列表成块。理由：Typora 光标进入某一列表项时只降级该项。
- 引用块整体成块，内部段落不单独切分。
- 表格整体成块（首版只读，光标进入整表回退源码）。
- 块边界按语法树的 `from`/`to` 取值，禁止用「空行」启发式，避免嵌套列表与围栏代码块误判。

此定义若与预期手感不符，先改 M1 再继续，不要在 M2 之后调整。

---

## 五、阶段提示词

以下每段可独立复制为一个工作回合的指令。执行前确认当前分支为 `typora-sec`。

### M0 · 视图模型

```
在 Qing Notepad（Tauri v2 + React 19 + TS，分支 typora-sec）中改造 Markdown 视图档位。

现状：
- src/components/Editor/MarkdownViewSwitch.tsx 导出 MarkdownViewMode = "source" | "preview" | "split"，
  以及 MARKDOWN_VIEW_ORDER 三档常量，被本地编辑器与 src/components/Workspace/CloudNoteEditor.tsx 共用。
- 本地笔记编辑器是 src/components/Editor/NoteEditor.tsx + MarkdownSourceEditor.tsx（CodeMirror 6）。

要求：
1. MarkdownViewMode 增加 "live"（实时渲染）。
2. 组件改为接受档位集合参数，不再写死三档；滑动 pill 的宽度与位移按实际档位数计算，
   当前实现是写死 calc((100% - 4px) / 3) 与 translateX(activeIndex * 100%)，必须随之参数化。
3. 本地编辑器档位 = ["live", "source"]，默认 "live"；"live" 暂等同当前 "source" 的渲染
   （即尚未实现实时渲染，先打通档位与默认值）。
4. 云端编辑器保持 ["source", "preview", "split"] 三档不变，默认值不变。

约束：
- 不改 i18n 表以外的文案来源；新增档位需要中英文案。
- 不改任何存储逻辑。
- 不新增依赖。

验收：
- npx tsc --noEmit 通过。
- 本地编辑器出现两档且默认选中 live（本机无 GUI，无法截图确认，只报告改动点与未验证项）。
```

### M1 · 块解析

```
在分支 typora-sec 为实时渲染实现块解析。

目标：给定 CodeMirror 6 的 EditorState，返回当前文档的块列表，供装饰层使用。

要求：
1. 新建独立模块（建议 src/utils/editorBlocks.ts），导出 blocks(doc: Text): Block[]，
   Block = { from: number; to: number; kind: "paragraph" | "heading" | "code" | "quote" |
   "table" | "hr" | "html" | "listItem"; depth: number }。
2. 基于 @codemirror/lang-markdown 提供的语法树（syntaxTree）推导，不要自己写正则扫描。
3. 判定规则见 docs/typora-editor-impl-plan.md 第四节：列表按 ListItem 逐项成块；
   引用整体成块；表格整体成块；其余按顶层节点。
4. 纯函数，不读 EditorView，不持有状态；同一 doc 多次调用结果一致。
5. 提供单元级自测入口：仓库已有 scripts/verify-*.mjs 的验证脚本传统，
   新增一个可 node 直接运行的脚本，对 examples/ 下的 .md/.qnp 样例输出块列表，
   便于人工核对边界。

约束：
- 不修改文档内容，不产生 transaction。
- 不引入依赖。
- 不要用空行启发式切块。

验收：
- npx tsc --noEmit 通过。
- 脚本对至少 10 个样例文件跑通，输出块数与首尾位置合理。
```

### M2 · L1 装饰层

```
在分支 typora-sec 实现 CodeMirror 6 实时渲染的视觉层（L1）。

现状：src/components/Editor/MarkdownSourceEditor.tsx 以 basicSetup + markdown() 构建 EditorView，
另有 pluginDecorations 扩展挂在同一 view 上（来自 src/utils/editorHandle.ts）。

要求：
1. 新建装饰扩展模块（建议 src/utils/livePreview/），用 ViewPlugin 计算 DecorationSet，
   通过 syntaxTree 遍历视口内节点，view.visibleRanges 之外不计算。
2. 行内标记隐藏：**粗体**、*斜体*、~~删除线~~、`行内代码`、[文本](链接) 的标记字符隐藏，
   保留内容并施加对应样式。样式只允许用项目现有 token（见 src/index.css 的 --color-* 与
   工具类），不要写死十六进制颜色。
3. 块级视觉：标题按级别设字号与字重；引用加左侧竖线；围栏代码块加底纹并保留高亮；
   分隔线渲染；列表符号对齐。字号需遵循编辑器 zoom（useEditorZoom 已存在）。
4. 装饰不得改变文档内容，不得写入 doc。
5. 与 pluginDecorations 共存：两者叠加时不得抛错，顺序不敏感。

约束：
- 全部装饰用 Decoration.mark / Decoration.line / Decoration.replace，禁止改 state。
- 只处理视口内范围；不得对全文档一次性遍历（长文档会卡）。
- 不引入依赖。
- 动效只用 --ease-* / --dur-*（项目规范）。

验收：
- npx tsc --noEmit 通过。
- 用 scripts 里的构建脚本产出 dist 后，说明哪些观感项因本机无 GUI 无法验证，
  列出需要人工确认的清单（标题层级、引用线、代码块底纹、列表对齐）。
```

### M3 · L3 按块降级与 IME

```
在分支 typora-sec 为实时渲染实现按块降级（L3）与输入法兼容。

背景：CodeMirror 的 Decoration.replace 区域光标无法进入，因此光标所在块必须整体回退为源码，
离开后恢复渲染。这是 Typora 的核心交互，也是本方案成立的前提。

要求：
1. 由 selection 变化推导「当前块」（复用 M1 的 blocks()），当前块内的行内标记隐藏装饰全部撤销，
   块级视觉保留（标题仍是标题字号，但 # 号显示出来）。
2. 光标跨越块边界时平滑切换，不得闪烁；重算只针对受影响的块，不要全量重建 DecorationSet。
3. IME：compositionstart 期间冻结装饰重算，compositionend 后补一次；
   组字过程中不得 dispatch 装饰性 transaction，避免候选框跳位或首字丢失。
4. 装饰状态挂在 EditorView 生命周期内（ViewPlugin），不得存入 store 或 ref 供跨实例复用。
   理由：切换笔记会 re-key 编辑器并销毁实例（见 src/utils/editorHandle.ts 的说明），
   外部持有的装饰状态会残留。

约束：
- 不改文档内容。
- 不引入依赖。
- 中文输入是硬需求，不能留「后续优化」。

验收：
- npx tsc --noEmit 通过。
- 报告：装饰重算的范围控制方式、IME 冻结的实现位置、以及需要人工在真机上确认的三项
  （候选框是否跳位、首字是否丢失、快速输入是否掉字）。
```

### M4 · L2 输入规则

```
在分支 typora-sec 实现 11 条 Markdown 输入规则，逐条独立、可单独关闭。

清单：
1. 行首 "# " + 空格 → 标题（1-6 级按 # 数量）
2. "> " 续行自动补 "> "
3. 无序列表 Enter 自动续行；有序列表续行时数字递增
4. 空列表项 Enter 退出列表（删除该项标记并退出缩进层级）
5. Tab / Shift-Tab 调整列表层级（缩进单位遵循文档现有约定，不混用 tab 与空格）
6. 围栏代码块内 Enter 自动补闭合围栏
7. "$$" 后 Enter 自动补闭合 "$$"
8. "---" 后 Enter 转分隔线
9. Ctrl+B / Ctrl+I 包裹或取消包裹选中文本
10. 图片拖入/粘贴：落盘到笔记附件目录并插入 ![]() （沿用现有图片写入路径，不新造目录规则）
11. 任务列表复选框可点击切换 [ ] / [x]

要求：
- 每条规则一个独立函数，集中在 src/utils/livePreview/inputRules.ts，便于单条回退。
- 全部通过 transaction 实现，并用 annotation 标记来源，保证 Ctrl+Z 一次撤销一个完整转换
  （不能出现撤销半条规则的效果）。
- 规则的输入判定不用正则逐字符硬匹配，优先基于语法树与光标上下文。

约束：
- 不改变缩进风格既有约定。
- 不引入依赖。
- 第 10 条不得绕过现有附件路径规则，不得写入新目录。

验收：
- npx tsc --noEmit 通过。
- 每条规则列出触发条件、边界情况、以及需要人工确认的行为（本机无 GUI，无法实测按键）。
```

### M5 · 跨块删除语义

```
在分支 typora-sec 定义并实现跨块删除语义。

背景：这是在 Document 结构上最容易出隐蔽缺陷的地方。Marktext（块模型）有四个同源缺陷，
其中两个可直接转化为本项目的验收用例：#5423（行尾 Forward Delete 把后续引用块拉出引用）、
#5385（从列表/引用内部删到后方块后残留选中内容）。

要求：
1. 明确定义三种情形并落字到代码注释：
   a. Backspace 在块首（块内首字符位置、且该块非文档首块）
   b. Delete 在块尾
   c. 选区跨越两个及以上块
2. 行为须符合「纯文本编辑器」的直觉：删除的是字符，不是块。不允许出现整块被静默吞掉、
   或删除后残留装饰的情况。
3. 与 M3 的降级逻辑联动：删除导致块边界变化时，当前块的降级状态必须重算。
4. 全部通过 transaction 实现，可撤销。

约束：
- 不做「智能合并块」这类超出文本编辑语义的加工。
- 不引入依赖。

验收：
- npx tsc --noEmit 通过。
- 列出三种情形各自的预期结果与已识别的边界情况；说明哪些需人工在真机核对。
```

### M6 · 只读实例（贴窗 / 卡片窗）

```
在分支 typora-sec 让只读视图复用实时渲染装饰。

现状：src/components/Sticky/ 与 src/components/Tile/ 是独立窗口，只读展示笔记内容。

要求：
1. 这两个窗口的渲染复用同一套装饰扩展（M2/M3 的模块），以 editable: false 的 EditorView 呈现。
2. 只读实例不注册输入规则、不响应光标降级（没有可编辑光标），但需正确渲染。
3. 主题变量沿用现有机制，不得写死颜色。

约束：
- 不改窗口创建与管理逻辑。
- 不引入依赖。

验收：
- npx tsc --noEmit 通过。
- 说明只读实例与主编辑器的装饰差异点（列出），以及需人工确认的观感项。
```

### M7 · 删除分屏

```
在分支 typora-sec 移除分屏档。

前提：M3、M4、M5 已在真机确认可用（用户确认后才执行本阶段）。

要求：
1. 本地编辑器档位收敛为 ["live", "source"]，移除 "split" 相关分支与 UI。
2. 清理因此失效的代码路径（分屏布局、双栏滚动同步等），不留死代码。
3. CloudNoteEditor 的三档不受影响。

约束：
- 不顺手重构无关代码。
- 不删除仍被云端编辑器使用的能力。

验收：
- 全仓搜索 split 相关标识符，确认无残留引用（列出搜索结果）。
- npx tsc --noEmit 与 npm run build 通过。
```

### M8 · 遗留 HTML 笔记迁移

```
在分支 typora-sec 为 HTML 期笔记做一次性迁移。

背景：src/utils/htmlToMarkdown.ts 的 isStoredEditorHtml() 会识别出历史遗留的 HTML 内容，
这批数据与 Markdown 混存在 data/notes/*.md。实时渲染上线后它们会显示为标签原文。

要求：
1. 写一个一次性迁移脚本（放 scripts/，沿用现有 verify-* 脚本的风格），
   扫描 data/notes/*.md，命中 isStoredEditorHtml 的转为 Markdown 并写回。
2. 写回前先备份到 data/backup/ 或等价位置，命名带时间戳。
3. 幂等：对同一文件重复运行结果不变。
4. 输出统计：扫描数、命中数、转换数、跳过数、失败数。

约束：
- 必须复用 htmlToMarkdown.ts 现有转换规则，不得另写一套。
- 不得删除任何笔记文件。
- 失败的文件保持原样并计入失败数，不要部分写入。

验收：
- 在样例副本上运行，报告统计与抽样对比结果。
- 说明回滚方式。
```

---

## 六、执行约定

- 每阶段结束只做本地 `git commit`，不推送。版本号变更时才按项目规则双端推送。
- 本机无 GUI，任何涉及按键、拖拽、动画、观感、窗口行为的结论都不能声称已验证，
  必须列成「待真机确认」清单。
- 每阶段结束更新 `docs/decisions-typora-editor.md` 的待定问题列表。
