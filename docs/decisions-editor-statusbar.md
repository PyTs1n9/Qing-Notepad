# 决策记录 · 编辑器底部状态栏与目录列

日期：2026-11-03
状态：已实施（真机手感待验）

## 背景

用户要求在编辑器下方新增一条工具栏，并给出固定的六段顺序：

`显示/隐藏目录 → 切换源码 → 中间留白 → 更新时间 → 保存状态 → 字数统计`

改前的状态：

- 编辑器卡片内只有**一条** 36px 菜单行（`decisions-editor-menubar.md`），高度刻意锁死与上方
  `NoteTabBar` 对齐（2 + 32 + 2 = 36）。
- 「更新于 / 已保存 / N 字」是**右下角绝对定位的浮标**（`bg-bg-primary/85` + 阴影），压在正文之上。
- **目录功能完全不存在**：没有标题抽取、没有大纲面板、没有跳转。
- 字数只有一项「N 字」= 汉字数 + 英文单词数，且按**原始源码**统计（`#`、URL 都算进去）。

## 追问结论

| 项 | 结论 | 理由 |
| --- | --- | --- |
| 追问强度 | 细问（3） | 需求已给出布局，缺的是口径与形态 |
| 决策记录 | 本文件 | 字数口径与目录形态会被反复重议 |
| 统计口径 | **中西分离**：行数 / 字数=汉字 / 词数=西文单词+数字 / 字符数=全部可见字符（含空格） | 四项互不重复；中文写作时「字数」最直观，不会与「词数」同值 |
| 统计来源 | **按可见文本**，剔除 `#`、`**`、围栏行、链接语法与 URL，图片只算 alt | 与 Typora 一致；按源码统计会让长文档偏差到不可信 |
| 目录形态 | **左侧推挤**，正文变窄；固定 220px | 用户选择。展开/收起不影响左右侧栏宽度（目录在编辑卡内部） |
| 窄卡降级 | 卡片 ≤ 560px 时同一元素**转为浮层覆盖** | 220px 挤进 480px 卡只剩 260px 正文，不可读 |
| 目录内容 | 1–6 级标题 + 点击跳转 + **滚动高亮当前章节** | 长文档需要「我在哪」的锚点 |
| 更新时间 | **绝对时间，保存后刷新** | `noteStore` 的 `updatedAt` 每次击键都变，直接读会边打字边跳秒 |
| 旧浮标 | **删除** | 与新底栏三项信息完全重复，且压住最后一行正文 |
| 底栏高度 | **28px**，顶栏菜单行同步压到 28px | 用户选择；两条带共同框住正文，不再与 36px 标签条争高度 |
| 28px 范围 | **仅编辑器两条带**，`NoteTabBar` 与其它卡条带保持 36px | 避免推翻「顶栏统一 h-9」的壳层不变量，回归面最小 |
| 行内按钮 | **24px**，图标 15 → 14 | 28px 行上下各留 2px |
| 目录开关记忆 | **会话级**：切笔记保持，重启收起 | 不加新的持久化项，默认不打扰 |
| 窄档统计 | 四项全留，窄档**去单位标签**（数字间用竖线分隔，`title` 保留说明） | 数字是数据，单位是图例 |

## 实施

| 文件 | 改动 |
| --- | --- |
| `src/utils/markdownStats.ts`（新） | `classifyMarkdownLines`（围栏感知的行分类，统计与目录共用）、`stripInlineMarkdown`、`toVisibleText`、`computeMarkdownStats` |
| `src/utils/noteOutline.ts`（新） | `extractOutline`：ATX + Setext 标题，跳过代码围栏，返回 0 起原文行号 |
| `src/components/Editor/NoteOutlinePanel.tsx`（新） | 220px 目录列、层级缩进、当前章节高亮、点击跳转、空态、Esc 关闭 |
| `src/components/Editor/EditorStatusBar.tsx`（新） | 28px 底栏，六段固定顺序；`formatUpdatedAt` 按距离缩短时间 |
| `src/components/Editor/NoteEditor.tsx` | 两条带压到 28px、目录列与底栏接入、删除右下浮标、`savedAt` 快照、滚动高亮 |
| `src/components/Layout/DropdownMenu.tsx` | 文字触发器 `h-7` → `h-6`（文字触发器仅编辑器菜单行使用） |
| `src/index.css` | `.note-outline` 表面色；≤560px 转浮层；≤620px 去时间前缀；≤520px 去单位标签 |
| `src/utils/i18n.ts` | 13 个新文案键（中英各一套） |
| `scripts/verify-markdown-stats.mjs`（新） | 43 项统计与目录断言；`npm run verify:markdown-stats` |
| `preview-editor-statusbar.html` + `src/__preview-editor-statusbar.tsx`（新） | 渲染基准页：`?w=` `?theme=light` `?outline=0` `?source=1` `?clean=1` `?jump=n` |

### 四个非显然的实现决定

1. **统计与目录共用一份围栏扫描**。`classifyMarkdownLines` 把每行标成 `fence` / `code` / `markup`：
   围栏行是语法、围栏内是逐字可见的正文。两处各写一套，代码块里的 `# 注释` 迟早会进目录。
2. **Front matter 用等量换行替换，不是删除**。直接删会让后续行号整体前移，目录跳转全部错位
   （`classifyMarkdownLines` 的 `line` 是原文行号）。
3. **当前章节按坐标判定，不按 `scrollTop` 比较行块 top**。`.cm-content` 自带 `padding: 16px`，
   行块的文档坐标与 `scrollTop` 差这 16px，正好卡在视口顶端的标题永远匹配不上。改为
   `view.posAtCoords({ y: 视口顶 + 6 })` 再回查标题位置，折行（一"行"多个视觉行）也一并成立。
4. **`savedAt` 快照，不读 `activeNote.updatedAt`**。后者每次击键都被
   `updateNote` 重写；底栏要表达「文件上次落盘的时间」，只能在 `doSave` 成功与笔记载入时各取一次。

## 验证

- `npx tsc --noEmit`：0 error。
- `npm run build`：通过（仅既有的 chunk 体积告警）。
- `npm run verify:markdown-stats`：**43/43**（含「`###` 不算字符」「链接 URL 不计词」「表格分隔行不算」
  「围栏内的 `#` 不进目录」「Setext 标题」「front matter 不改变行号」）。
- 回归：`verify:markdown-commands` 43/43、`verify:input-rules` 53/53、`verify:live-preview` 42/42、
  `verify:ui-polish` 无失败。
- 视觉（headless Edge + CDP，`.workbuddy/preview/statusbar-*.png`）：
  - 实测 `menuH=28`、`barH=28`、`outlineW=220`；
  - 720px：目录推挤（`position: static`），底栏 `更新于 · ● 未保存 · 31 行 31 词 126 字 293 字符`；
  - 560px 及以下：目录 `position: absolute` 转浮层，正文宽度不减；
  - 380 / 460 / 560 / 640 四档 `scrollWidth - clientWidth = 0`，底栏从不溢出；
  - 浅蓝主题复核：底栏文字、分隔线、目录高亮均可读。

### 未验证（需真机）

1. 拖动侧栏 sash 时目录推挤/浮层的切换时机与 CodeMirror 重测是否有一帧抖动。
2. 中文输入法组字期间目录与统计的刷新节奏（每击键重算一次全量标题）。
3. 目录列在 4000 行以上长文里的滚动高亮流畅度（当前每次滚动 rAF 内线性扫标题）。
4. `Ctrl+/`、目录按钮、视图菜单三处切换源码模式的观感一致性。

## 追加：Typora 化大纲 + 平滑跳转（同日第二轮）

用户给出 Typora 大纲截图，要求「参考 typora」，且点击小章节要**滑动**过去而不是瞬移。

| 项 | 结论 | 理由 |
| --- | --- | --- |
| 面板还原度 | 完整对齐：标题行「大纲」+ 查找框 + 无图标 + 长标题换行 + 缩进表达层级 | 单行截断的 220px 列表读不出 `③ pd.concat([表1, 表2], ignore_index=True) — 多表按行拼` 这种标题 |
| 行高 | 由内容决定（12px/18px 行高，上下 3px） | 与 Typora 一致；层级只靠缩进（每级 10px）与字色，不再画 `#` 图标 |
| 查找框 | 过滤 + 命中高亮；无匹配显示空态；计数变 `2/7` | 只过滤不标命中，多字匹配时看不出为什么命中 |
| 跳转 | **rAF 自写动画**，时长 `clamp(180ms, 距离×0.45, 420ms)`，`easeOutCubic` | `scrollTo({behavior:"smooth"})` 的时长由浏览器定、无法中断、无法与目录高亮同步 |
| 可中断 | 滚轮 / 触摸 / 按下指针 / 任意按键（窗口捕获）→ 立即 cancel；再次点击、切笔记、关面板同样 cancel | 动画不能和用户抢滚动条 |
| 无障碍 | `prefers-reduced-motion: reduce` 时直接落位 | 与项目既有 reduced-motion 约定一致 |

### 两个坐标陷阱（都只能靠肉眼/探针发现）

1. **落点**：`view.lineBlockAt(pos).top` 是「从第一行算起」的文档坐标，`.cm-scroller` 的 `scrollTop` 是
   「从内容盒算起」，两者差 `.cm-content` 的 `padding-top`（16px）。直接用 `block.top` 当目标会整体偏高
   16px，且没有任何报错。实现里从 DOM 读 padding 而不是写死 16。
2. **高亮采样点**：跳转把标题停在视口顶下方 8px（`SCROLL_TOP_MARGIN`），若在 8px 处采样，读到的仍是
   **上一行的末尾**——结果是刚离开的章节被标成当前章节。采样点改为 `视口顶 + 8 + 6`。

### 验证

- 探针记录每次 `scroll` 的 `scrollTop`：一次 514px 跳转产生 **15 个不同中间值**（58 → 154 → 238 → … → 572），
  确认是动画而非瞬移；瞬移只会有一个值。
- 落点实测：标题行盒距视口顶 **8px**，与 `SCROLL_TOP_MARGIN` 一致。
- 查找输入「表」：7 行过滤到 2 行，命中处 4 个 `<mark>`；深/浅主题各截一张复核。
- 统计口径未受影响：`verify:markdown-stats` 仍 43/43，`npx tsc --noEmit` 0 error。

## 追加：左簇第三枚按钮（纯预览编辑，2026-11-09）

底栏原本的左簇是「大纲 / 源码」两枚开关。本轮在**左簇第三位**新增一枚可选的「纯预览编辑」开关：

- **位置**：大纲 → 源码 → 纯预览编辑 → `flex-1` → 时间 → 保存 → 统计。右簇一段未动。
- **存在性由 prop 决定**：`EditorStatusBar` 只在传入 `onTogglePurePreview` 时渲染该按钮。主窗口传，
  独立笔记窗不传 → 该面没有按钮，也不会进入交互档。
- **状态**：`aria-pressed={purePreview}`；源码档下 `disabled`（源码是逃生舱，两档互斥）。
- **「六段」的口径**：六段指**信息段**（目录 / 源码 / 留白 / 时间 / 保存 / 统计），左簇的开关数量
  可以扩展，右簇顺序不变。
- 规格不变：底栏 28px、按钮 `h-6 w-6`、图标 14、`rounded-md`。

模式语义、表格就地编辑与已知取舍见 `decisions-preview-edit.md`。

## 发版前必做

底栏取代了右下角浮标，发布说明需要一句迁移提示：

| 原位置 | 新位置 |
| --- | --- |
| 右下角浮标「更新于 / 已保存 / N 字」 | 编辑器底部状态栏（右下角） |
| 视图 → 实时渲染 / 源码 | 同菜单仍可用；底部状态栏第二个按钮与 `Ctrl+/` 等价 |
