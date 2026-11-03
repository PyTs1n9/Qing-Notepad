# 决策记录 · 笔记编辑器菜单栏（文件 / 编辑 / 段落 / 格式 / 视图）

日期：2026-11-03
状态：已实施（真机手感待验）

## 背景

用户要求把笔记编辑器顶部那一排图标工具栏改成 Typora 式的可展开菜单，并明确「参考、不要完全复刻」。
改动前的工具栏只有 9 个控件：实时渲染/源码切换、撤销、重做、插入表格、插入图片、AI 润色、保存、钉住、导出。

关键事实（改前核对，决定了工作量在哪）：

- 编辑器内核是 **CodeMirror 6 + basicSetup**，不是 TipTap；TipTap 只用于画布富文本卡片。
- 排版能力当时**只有输入规则**（`Ctrl+B` / `Ctrl+I`）与表格、图片插入；标题、列表、引用、代码块、
  链接、删除线、行内代码**没有任何命令层**。
- 全应用唯一下拉 `Layout/DropdownMenu.tsx` 支持图标触发器、键盘模型、flip 防溢出，但**无文字触发器、
  无滚动、无单选态**。
- `Ctrl+1`–`Ctrl+6` 全应用未被占用（只有 `Ctrl+W` 关标签、`Ctrl+S` 保存、`Ctrl+Alt+T` 插表格）。

## 追问结论

| 项 | 结论 | 理由 |
| --- | --- | --- |
| 真实痛点 | **容量 + 习惯**（两项同权） | 用户选择「想加排版功能但没地方」与「照 Typora 用」；因此真正的交付物是命令层，菜单只是容器 |
| 追问强度 | 拷打（5） | 需求以「参考截图」提出，不拆开无法界定范围 |
| 决策记录 | 本文件 | 菜单项取舍会被反复重议 |
| 菜单位置 | **编辑器卡片内独立菜单行**，替换原工具栏那一行 | 窗口顶栏 `h-9` 已承载标签页；且 D6/D9 已定「顶栏不承载随视图变形的入口」（传送门被删的原因） |
| 菜单结构 | 文件 / 编辑 / 段落 / 格式 / 视图，共 **37 项**（3 / 7 / 15 / 7 / 5） | 与 Typora 同名同序，便于肌肉记忆迁移 |
| 行尾保留 | 保存（脏时 accent）、钉住、导出 三个图标 | 菜单无法一眼表达「未保存」；这三个是离开编辑器的动作，需要可见状态 |
| 撤销 / 重做 | 进「编辑」菜单，行尾不保留 | `Ctrl+Z` 是系统级肌肉记忆，下沉成本低 |
| 视图切换 pill | **移除**，进「视图」菜单（带 ✓ 单选态） | 用户选择「菜单 + 保存/钉住/导出」；代价用 `Ctrl+/` 补偿 |
| 面板能力 | 分组 + `max-height: 500px` 滚动，**不加二级子菜单** | 我们的「表格」固定 3×3、「导出」已带格式选择，没有真正需要二维选择的项；二级菜单要重写键盘模型与翻转逻辑，收益不匹配 |
| 筛选口径 | ① Markdown 语法可直接表达 ② CM6 能一次事务写完并一次撤销 | 菜单里出现大量禁用项是缺陷（项目已定「禁用必带原因」） |
| 剪贴板三项 | **不做** | CM6 无剪贴板命令，只能走 `navigator.clipboard`；`Ctrl+C/V` 已是系统级肌肉记忆 |
| 快捷键 | 全套新增并显示 | 菜单不显示加速器就只是「把按钮藏起来」；显示即承诺，因此每条都必须真的注册 |

## 砍掉的项与理由

| 类别 | 项 | 理由 |
| --- | --- | --- |
| 文件 | 新建 / 打开 / 打开文件夹 / 快速打开 / 最近文件 / 选择编码 / 从磁盘重载 | 属侧栏职责；D3 已定「动作归位到所属视图」，菜单开第二入口就是重蹈传送门覆辙 |
| 文件 | 另存为 / 移动到 / 属性 / 打开文件位置 / 在侧栏中显示 / 删除 | 需要新增 Rust 命令或没有对应数据模型 |
| 编辑 | 剪切 / 复制 / 粘贴 / 复制为纯文本 / Markdown / HTML | 见上「剪贴板三项」 |
| 段落 | 数学工具 / 代码工具 / 警告框 / 脚注 / TOC / Front Matter | 无解析与渲染支持，加了就是空承诺 |
| 段落 | 提升 / 降低标题级别 | 与 `Ctrl+1..6` 功能重叠 |
| 段落 | 表格子菜单（增删行列、对齐） | 实时渲染下表格是只读 widget，子菜单会给出「可编辑」的假承诺 |
| 格式 | 链接操作 / 链接引用 / 清除样式 | 无引用式链接模型；清除样式边界多、收益低 |
| 视图 | 专注模式 / 打字机 / 全屏 / 置顶 / 字数窗口 / 开发者工具 | 不满足「一次 CM6 事务」口径；字数已有底部浮标 |
| 主题 | 整个「主题」菜单 | 已有一级设置面板，不复制第二入口（同 D6） |

## 实施

| 文件 | 改动 |
| --- | --- |
| `src/utils/markdownCommands.ts`（新） | 命令层：`setHeading` / `toggleQuote` / `toggleList` / `insertCodeBlock` / `insertHorizontalRule` / `insertLink` / `inlineWrap` / `insertParagraph` |
| `src/components/Editor/EditorMenuBar.tsx`（新） | 五个菜单的条目装配、行尾焦点归还、菜单栏左右方向键 |
| `src/components/Layout/DropdownMenu.tsx` | 文字触发器、`checked` 单选态、`maxHeight` 滚动、受控 `open`、相邻菜单 hover 切换、`onNavigate`；**面板改为 portal 到 `document.body`** |
| `src/components/Editor/NoteEditor.tsx` | 菜单行替换图标行，行尾留保存/钉住/导出；新增 `Ctrl+/` 与缩放的窗口级快捷键 |
| `src/components/Editor/MarkdownSourceEditor.tsx` | `Prec.high` 命令键盘表（标题、引用、列表、代码块、链接、行内标记、上下插段落） |
| `src/utils/editorZoom.ts` | 返回值由 `number` 改为 `{ fontSize, zoomIn, zoomOut, resetZoom }`（两个调用方同步） |
| `src/utils/livePreview/inputRules.ts` | `wrapRule` 改为调用 `markdownCommands.inlineWrap`，键盘与菜单共用一份实现 |
| `src/utils/i18n.ts` / `shortcutReference.ts` | 40 个新文案键；帮助中心快捷键页补 5 条 |
| `src/index.css` | 删除 `.note-export-label` 与其容器查询（导出改为纯图标） |
| `scripts/verify-markdown-commands.mjs`（新） | 命令层断言，`npm run verify:markdown-commands` |

### 三个非显然的实现决定

1. **面板必须 portal**。编辑器卡片带 `container-type: inline-size`，它隐含 `contain: layout`，会让该卡片
   成为 `position: fixed` 后代的包含块，再叠加卡片的 `overflow-hidden`，菜单会被定位到卡片内并裁掉。
   只改 `position` 不解决问题，必须渲染到 `document.body`。
2. **禁用态由 `hasEditor` 驱动，不由 `getView()` 推导**。CodeMirror 视图在 effect 里挂载，首帧
   `getView()` 是 `null`；用它算 `disabled` 会让所有文档动作先画成禁用，再等一次无关重渲染才恢复。
3. **焦点归还**。菜单项卸载后焦点掉到 `<body>`，下一次按键会失灵；所有条目统一在动作后
   `requestAnimationFrame(() => view.focus())`。

### 快捷键（显示即承诺，均已注册）

| 键 | 动作 | 位置 |
| --- | --- | --- |
| `Ctrl+0` / `Ctrl+1..6` | 正文 / 各级标题（同级别再按一次取消） | 编辑器 keymap |
| `Ctrl+Shift+Q` | 引用 | 编辑器 keymap |
| `Ctrl+Shift+[` / `]` / `X` | 无序 / 有序 / 任务列表 | 编辑器 keymap |
| `Ctrl+Shift+K` | 代码块 | 编辑器 keymap |
| `Ctrl+K` | 超链接 | 编辑器 keymap |
| `Ctrl+Shift+\`` | 行内代码 | 编辑器 keymap |
| `Alt+Shift+5` | 删除线 | 编辑器 keymap |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` | 下方 / 上方插入段落 | 编辑器 keymap |
| `Ctrl+/` | 实时渲染 ↔ 源码 | 窗口级（菜单获得焦点时也要能用） |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+Shift+0` | 放大 / 缩小 / 实际大小 | 窗口级 |
| `Alt+↑` / `Alt+↓` | 上移 / 下移该行 | CM 默认 keymap |
| `Ctrl+F` | 查找替换 | basicSetup 默认 |
| `Ctrl+S` / `Ctrl+W` / `Ctrl+Alt+T` | 保存 / 关标签 / 插表格 | 既有实现，未改 |

`Ctrl+/` 与缩放走窗口捕获阶段并带卡片范围判断，因此在 AI 面板里按这些键不会影响笔记。

## 验证

- `npx tsc --noEmit`：0 error（`noUnusedLocals` 打开）。
- `npm run build`：通过（仅既有的 chunk 体积告警）。
- `npm run verify:markdown-commands`：43 项全过（含「同级别按两次回正文」「改级别不动行内内容」
  「多行命令只产生一个事务」「行中插入围栏不吞掉后半行」）。
- 回归：`verify:input-rules` 53/53、`verify:live-preview` 42/42、`verify:ui-polish` 15/15、`verify-contrast` 无失败。
- 视觉：`preview-editor-menu.html` + CDP 截图（`.workbuddy/preview/f-*.png`），已确认
  640px / 400px 两档不换行、五个菜单全部展开内容完整、单选态 ✓、快捷键右对齐、焦点为背景高亮而非蓝框。

### 未验证（需真机）

1. `Alt+Shift+5` / `Ctrl+Shift+\`` 在真实键盘布局下的命中（CM 的 shifted-char 回退分支理论成立，未实按）。
2. 菜单 hover 切换与 `Escape` 还焦在真实鼠标/键盘下的手感。
3. portal 后的菜单在 Tauri 窗口内与 AI 侧栏、贴窗等浮层的层级关系（z-50 是否足够）。
4. 中文输入法组字期间点击菜单项的行为。
5. 段落菜单 500px 高在 1366×768 笔记本上的实际观感（会接近窗口高度）。

## 发版前必做

入口变更影响存量用户肌肉记忆（对应 `decisions-topbar-menus.md` D5），发布说明需附迁移对照：

| 原位置 | 新位置 |
| --- | --- |
| 工具栏「实时渲染 / 源码」pill | 视图 → 实时渲染 / 源码，或 `Ctrl+/` |
| 工具栏撤销 / 重做 | 编辑 → 撤销 / 重做，或 `Ctrl+Z` / `Ctrl+Y` |
| 工具栏插入表格 / 图片 | 段落 → 表格；格式 → 插入图片 |
| 工具栏 AI 润色（✨） | 格式 → AI 润色选中内容 |
| 工具栏保存 | 仍在行尾（未保存时高亮），或 文件 → 保存 |
| 工具栏钉住 / 导出 | 仍在行尾 |

## 缺陷修复（2026-11-03，上线后首轮反馈）

**症状**：点开任意笔记，窗口整片变黑。

**根因**：`NoteEditor` 里 `handleZoom` 这个 `useCallback` 写在 `if (!activeNote) return ...`
**之后**。首帧没有打开的笔记，只执行到早返回为止（hook 数 N）；点击笔记后第二次渲染多执行一个
hook，React 抛 `Rendered more hooks than during the previous render.`，无错误边界，整棵树被卸载，
窗口只剩 webview 底色。

**验证方式**：本地渲染台 `preview-note-editor.html` 改成「先空、800ms 后填入 activeNoteId」，
复现空态 → 有笔记的真实切换。把同样形态的 hook 注入早返回之后可稳定复现该报错且 `.cm-editor`
不存在；还原修复后 `cm: true`、无异常。

**修法**：`handleZoom` 移到早返回之前，与其余 hook 同处。文件内已无常量断言：早返回之后不再
出现任何 `useState/useRef/useEffect/useCallback/useMemo`。

**顺带补的两层兜底**（同类事故不再「黑屏无信息」）：

| 新增 | 作用 |
| --- | --- |
| `components/Layout/RootErrorBoundary.tsx` | 应用级错误边界：显示错误名/消息、可展开堆栈、重新加载、复制错误信息。此前只有卡片级 `PanelErrorBoundary`，渲染错误会卸载整棵树 |
| `main.tsx` 的 startup error overlay | 模块求值阶段（React 尚未挂载）抛错时把消息画到页面上；仅在 `#root` 为空时生效，挂载后的错误仍归边界与 console |

**教训**：`NoteEditor` 这类「空态早返回 + 有内容才渲染主体」的组件，任何新 hook 都必须加在早返回
之上；本地渲染台必须把「空 → 有内容」的切换也演一遍，只测有内容的一帧查不出这个问题。

## 待定

- [ ] 段落菜单 15 项是否偏长：若真机手感不佳，可把「在上方/下方插入段落」移入编辑菜单。
- [ ] 是否给可滚动面板加底部渐隐，替代「切半行」的截断感（当前依赖滚动条提示）。
- [ ] 云端编辑器（`CloudNoteEditor`）是否共用这套菜单；本轮只改本地笔记。
