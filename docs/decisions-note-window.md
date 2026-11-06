# 决策记录 · 独立笔记窗口

日期：2026-11-03
状态：已实施（构建 + 主窗口 WebView2 验收通过；独立窗口截图见 `local_img/note-window.png`）

## 背景

用户要求「在编辑器中新增一个独立的单页模块，用于将当前 Markdown 文档在单独窗口中打开」，并给出四条硬性构成：

1. 窗口只提供 note 功能（没有侧栏、标签栏、AI 面板、工作区壳层）；
2. 窗口头部带图标；
3. 顶部有「文件 / 编辑 / 段落 / 格式 / 视图」工具栏；
4. **完整**包含编辑器下方新增 bar 的全部内容，并在工具栏右侧多一个「返回主软件」按钮。

参考图：Typora 的 Windows 窗口——标题行（文档名 + 最小化/最大化/关闭）在上，菜单行紧贴其下，正文占满，
底部是状态条。本实现按这个形状落地，只把标题行左侧补上应用图标（需求 2），把菜单行右侧补上返回按钮（需求 4）。

## 追问结论

| 项 | 结论 | 理由 |
| --- | --- | --- |
| 追问强度 | 细问 | 需求已给出结构，缺的是窗口形态与双窗口语义 |
| 窗口形态 | **无边框自绘**：图标 + 文档标题 + 拖拽区 + 三个窗口按钮；下一行才是菜单栏 | 系统边框会在自绘头部上面再叠一条标题栏；Typora 参考图也是单条自绘头部 |
| 编辑与同步 | **可编辑 + 双向同步** | 只读窗口浪费了「完整编辑器」这个前提；同步交给事件总线 |
| 冲突策略 | **未动则刷新，已动则保留**（不弹窗） | 两个窗口都是真编辑器；弹窗打断写作，强制刷新会丢正在输入的文字 |
| 返回按钮 | **保存 → 聚焦主窗口 → 关闭本窗口** | 「返回」的语义就是回去；不先 flush 会丢最后 800ms 的输入 |
| 文件菜单 | 「关闭当前标签」改为「关闭独立窗口」；**保留导出** | 独立窗口没有标签条，照抄文案会指错对象；导出是文档级动作，不应因窗口不同而消失 |
| 入口范围 | **仅编辑器内**：菜单行右侧图标 + 「文件」菜单项 | 用户明确选择；右键菜单/标签右键留给后续需求 |
| AI 润色 | **显示但禁用**（`disabledNoAi`） | 菜单项静默消失比灰掉更难排查；独立窗口没有 AI 侧栏，不能假装能用 |

## 实施

| 文件 | 改动 |
| --- | --- |
| `src/components/NoteWindow/NoteWindowChrome.tsx`（新） | 无边框窗口头部（图标 + 标题 + 最小化/最大化/关闭）、28px 菜单行、右侧返回按钮；纯展示，不碰 Tauri |
| `src/components/NoteWindow/NoteWindowView.tsx`（新） | 数据与生命周期：读设置/笔记、CodeMirror、目录、底栏、自动保存、事件同步、导出、关窗前 flush |
| `src/utils/noteWindow.ts`（新） | `openNoteWindow`（每篇笔记单例 + 已有则聚焦）、`focusMainWindow`、三个事件常量、窗口标签前缀 |
| `src/hooks/useOutlineNavigation.ts`（新） | 从 `NoteEditor` 抽出的目录跳转 + 滚动高亮，两个窗口共用同一份坐标修正 |
| `src/utils/exportNote.ts`（新） | 从 `App.tsx` 抽出的整套导出（对话框 / md/txt/docx/pdf / 打印 sheet / 错误弹窗） |
| `src/utils/noteImages.ts`（新） | `imageExtensionOf` 与 `attachment://` 插入，编辑器与独立窗口共用 |
| `src/utils/markdownCommands.ts` | 新增 `insertTable` + `TABLE_MARKDOWN`（表格骨架原在 `NoteEditor` 内） |
| `src/components/Editor/EditorMenuBar.tsx` | `closeEntryLabel` / `onOpenInWindow` 两个可选 prop；`onAiPolish` 改为可选并在缺省时禁用 |
| `src/components/Editor/NoteEditor.tsx` | 菜单行新增「在独立窗口中打开」按钮与文件菜单项；保存时广播 `note-window:main-saved`；监听 `note-window:saved`（本窗口有未保存改动则忽略；否则刷新缓冲并用 `updateNote` 修回索引 `updatedAt`）；目录逻辑改用共享 hook |
| `src/App.tsx` | 导出实现搬到 `exportNote.ts`；外观变化时额外广播 `note-window:appearance`（含 `lang`） |
| `src/main.tsx` | `?noteWindow=<noteId>` 路由；在挂载前给 `<body>` 加 `note-window-body`，避免白底首帧 |
| `src-tauri/capabilities/default.json` | `windows` 增加 `note-window-*` |
| `src/index.css` | `body.note-window-body` 页面底色与禁止滚动；标题行图标不收缩 |
| `src/utils/i18n.ts` | 4 个新键（中英）：`openInNewWindow` / `closeNoteWindow` / `returnToMainApp` / `disabledNoAi` |
| `docs/user-manual.md` | 「记事」新增「独立窗口」一节（入口、窗口构成、同步规则、返回） |
| `scripts/verify-architecture.mjs` | 白名单补 `noteWindow.ts`（下发主题/语言）与 `exportNote.ts`（失败弹窗）；顺手登记 `livePreview/index.ts` 桶文件（该规则原本就在红） |

### 七个非显然的实现决定

1. **不复制编辑器，只复制「壳」**。菜单栏、底栏、CodeMirror、目录面板全部复用现有组件；独立窗口新增的只有窗口头部与返回按钮。
   复制一份 editor 会在下一次改底栏时立刻分叉——「完整包含下方 bar」这条需求本身就在要求同一份实现。
2. **目录坐标逻辑抽成 hook**。`docs/decisions-editor-statusbar.md` 记过两个只能靠肉眼发现的 16px / 8px 陷阱；
   第二个窗口各写一遍迟早会漂。`useOutlineNavigation` 同时服务两处，行为与既有验收一致。
3. **导出抽成 `exportNote.ts`**。独立窗口的「文件 → 导出」必须与主窗口同参数：扩展名兜底、
   HTML 旧笔记转 Markdown、Word 的图片丢弃提示、PDF 的离屏打印 sheet。两边各写一遍就是两套导出。
4. **同步靠两个方向相反的全局事件，不用 store**。子窗口是独立 JS 上下文，`noteStore` 不共享
   （`decisions-architecture-layering.md` 已规定子窗口不读 `settingsStore`）；因此独立窗口用
   `loadSettings()` / `loadNoteContent()` 自己装载，再用 `note-window:saved`（子 → 主）与
   `note-window:main-saved`（主 → 子）交换整篇正文。规则是「谁有未保存输入谁保留」：
   主窗口按 `tabStore.dirtyIds` 判断，独立窗口按 `dirtyRef` 判断。
5. **关闭只有一个 flush 入口**。标题栏 X、Alt+F4、任务栏关闭都走 `onCloseRequested`：
   `preventDefault()` → flush → `destroy()`；「返回主软件」则 flush → `focusMainWindow()` → `destroy()`。
   三条路径共用一次写盘，不会出现「关得快就丢字」。
6. **禁用 AI 润色而不是隐藏**。菜单结构是用户的心智地图；在独立窗口里删掉一项会让两份菜单看起来不是同一个编辑器。
7. **新窗口必须显式 `setFocus()` 才算置顶**（2026-11-06 修）。窗口以 `visible: false` 创建，而 tao 在不可见时
   根本不走激活路径——`Window::new` 里 `set_visible(false)` 直接跳过 `ShowWindow`，所以创建阶段拿不到前台。
   之后 `tauri://created` 里的 `show()` 只落到 `ShowWindow(SW_SHOW)`，前台锁（foreground lock）在别的顶层窗口
   挡在前面时会让它失败：窗口画出来了、任务栏图标闪一下、但仍停在后面。`set_focus` 是唯一会走到
   tao `force_window_active`（`SetForegroundWindow` + 合成 Alt 按键兜底）的入口，而它在窗口不可见时直接跳过，
   因此顺序必须是 `show` → `unminimize` → `setFocus`，三步收进 `activateWindow()`，新建窗口 / 已存在窗口 /
   `focusMainWindow()` 三处共用。**只写 `show()` 的窗口在「已有若干窗口 + 应用在后台」时必然不置顶。**
   证据（release exe，前台窗口轮询 50ms）：旧代码热启动开 md 后 5 秒内前台仍是 Chrome/VS Code，
   新代码在启动后约 250ms 拿到前台（`focus-e`，pid 为本进程），重复开同一文件则复用并前置已有窗口（`focus-b`）。
   冷启动带文件这一路径旧代码也能置顶——主窗口刚拿到前台，进程仍有前台权限——所以只测冷启动会漏掉这个 bug。

## 验证

- `npx tsc --noEmit`：0 error。
- `npm run build`：通过（仅既有的 chunk 体积告警）。
- `npm run tauri -- build --no-bundle`：通过。
- `npm run verify:webview`：主窗口 DOM 断言通过、零控制台错误、截图 `local_img/webview-main.png` 判读；
  编辑器菜单行新增的第 5 个图标与既有四个同高同色，未挤出工具栏。
- 独立窗口：由主窗口入口创建，`local_img/note-window.png` 判读标题行图标/标题/窗口按钮、
  28px 菜单行、右侧返回按钮、底栏六段是否完整；DOM 断言覆盖窗口存在、编辑器挂载、底栏段数。
  实测：`960×720`；头部 `36px`、菜单行 `28px`、底栏 `28px`（`y=692`，窗口高 720）；
  菜单 5 项 + 返回按钮；底栏 2 个按钮 + 更新时间 + 保存状态 + 四项统计；`overflowX = 0`；
  「返回主软件」关闭窗口后再次从主窗口打开成功（单例标签复用）。

### 双窗口同步的补充说明

子窗口直接写 `.md`，不经过 `noteStore`，所以 `index.json` 的 `updatedAt` 不会自己变。
主窗口收到 `note-window:saved` 后调用 `updateNote(noteId, { content }, { touchUpdatedAt: true })`：
一次调用同时修回侧栏/标签条/状态栏的时间戳与 AI 读取的正文副本。主窗口自身处于未保存状态时整条事件忽略
（包括元数据），因为它的下一次保存会覆盖这条时间线。

## 已知边界（未做 / 未验证）

1. **同一篇笔记两个窗口都在输入**：最后落盘者胜。放弃弹窗合并是本次的显式取舍，不是遗漏。
2. **应用整体退出**：主进程销毁所有窗口，独立窗口没有机会 flush；此时以主窗口最后的 800ms 自动保存为准。
3. **中文输入法组字期间**的外部刷新：组字事务在 CodeMirror 内部完成，未单独加 IME 闸门（主窗口既有逻辑同样未加）。
4. **笔记在独立窗口打开期间被删除**：窗口不做删除联动，继续保存会重建同名 `.md` 文件。当前由「删除前先关窗」的使用习惯兜底，未加拦截。
5. **窄宽 560px 以下**：窗口 `minWidth` 阻止到达；底栏的 620/520px 降级沿用编辑器容器查询，未在真机拖动验证。
