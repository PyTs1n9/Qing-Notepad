# Markdown 链接跳转

状态：已实施（`md-plus` 分支）
相关代码：`src/utils/linkScheme.ts`、`src/utils/markdownLinks.ts`、
`src/utils/markdownLinkActions.ts`、`src/utils/editorScrollJump.ts`、
`src/hooks/useOutlineNavigation.ts`、`src/components/Editor/MarkdownSourceEditor.tsx`、
`src/components/Editor/MarkdownReadonlyView.tsx`、`src/components/Sticky/StickyNote.tsx`、
`src/components/Workspace/CloudNoteEditor.tsx`、`src/components/Graph/GraphPage.tsx`
门禁：`node scripts/verify-architecture.mjs`、`npm run verify:markdown-links`

## TL;DR

渲染态里的 Markdown 链接可以点了：`http/https/mailto/tel` 交系统打开，`#小节` 跳到本文
同名标题，`other.md` 跳到本地笔记库里**标题**匹配（唯一）的那一篇。可编辑面用
`Ctrl/Cmd+单击`，只读面单击即跳。其余一律静默不跳——不 toast、不文案。
跨笔记锚点（`other.md#小节`）本轮**不支持**，行为上只切笔记。

## 结论

### 1. 只有四类目标，其余静默不跳

结论：`http|https|mailto|tel` → 外部；`#小节` → 文内锚点；标题能唯一匹配的 `other.md` →
笔记跳转；其他（空串、`#`、`javascript:`、`data:`、`file:`、`C:\x\y.md`、
`www.example.com`、`report.pdf`、同名两篇）→ `none`，执行层返回 false。

理由：链接是**信任边界**——笔记正文和 AI 回答都会走到渲染器，`marked` 把目的地址原样写进
`href`。给「无法跳转」配 toast 只会让人以为坏了；写坏的链接在源码里一眼能看见。而静默的
前提是「点击仍被吞掉」，否则 webview 会自己导航出一个白屏壳。

### 2. 修饰键按面分开，且按平台分开

结论：可编辑面 `Ctrl/Cmd+单击`，只读面单击。mac 只认 `metaKey`，其他平台只认 `ctrlKey`。

理由：可编辑面里链接文本被装饰层从 `[label](url)` 藏成 label，普通单击是**编辑 label 的唯一
入口**，不能被跳转占用；只读面没有 caret 可放，再加修饰键只是让人多点一次。平台分开是因为
mac 上 Ctrl+单击是次要键点击（右键菜单），`ctrlKey || metaKey` 会把右键菜单变成跳转。

### 3. 事件时机按面选：可编辑主编辑器用 `mousedown`，只读面与贴图窗用 `click`

结论：`MarkdownSourceEditor` 在 `mousedown` 里判定并消费；`MarkdownReadonlyView` 与
`StickyNote` 用 `click`。三处都遵守同一条：「`openMarkdownLink` 返回 false 就不消费这次
点击」（编辑器的 `mousedown` 让 CodeMirror 走默认放光标，只读面的 `click` 不
`preventDefault`）。

理由：`mousedown` 发生在光标移动之前，拒绝这次点击就已经是「默认行为」，不需要事后把光标
搬回来——这是主编辑器「普通单击必须落在点击处」的需要。只读面与贴图窗没有「保住光标」的
诉求，用 `click` 即可，**不为形式统一去改代码**。返回值语义统一为「是否真的执行了动作」
——`note` 分支在 noteId 已不在 store 里时是 false，锚点找不到标题也是 false。这样
「Ctrl+单击一个死锚点」的结果和普通单击完全一样，而不是什么都没发生。

### 4. scheme 白名单只有一个真源

结论：`src/utils/linkScheme.ts` 持有 `LINK_SCHEMES` / `schemeOf` / `isExternalScheme` /
`isSafeLinkHref`；`markdown.ts` 与 `markdownLinks.ts` 都从这里取，`markdown.ts` 保留
`isSafeLinkHref` 的再导出以免外部 import 断。

理由：两条判定曾经各自维护——渲染器决定「要不要输出 `<a href>`」，点击解析决定「要不要交给
OS」。一个放行 `tel:` 另一个拒绝就是死链；反方向（解析层信任渲染层拒绝过的东西）就是
`javascript:` 进 webview。图片另有一套 `IMAGE_SCHEME_ALLOWLIST`（`data:`/`blob:`/
`attachment:`/`asset:`），**故意不合并**：这些 scheme 作为 `<img src>` 是惰性的，作为链接
目的地绝不该可点。

### 5. 笔记链接按标题匹配，不按文件名

结论：路径段只用来提示作者指的是哪一篇，判定是「标题经 `looseLinkKey` 归一化后唯一相等」。

理由：笔记的标识是标题，文件名的 slug 会随标题变化，而用户改标题时不会去改所有链接。
归一化（NFKC + 小写 + 丢空白/连字符/标点）让 `#Hello-World`、`#hello world`、
`#Ｈｅｌｌｏ　Ｗｏｒｌｄ`、`#快速开始：准备` / `#快速开始准备` 都落到同一处。同名两篇不猜：
跳错笔记比不跳更难发现。所以 `other.md` **不会**命中标题为 `Other Note` 的笔记
（`other` ≠ `othernote`），而 `notes/other-note.markdown` 会命中。

### 6. 跨笔记锚点：解析出来，但不承诺

结论：`resolveMarkdownLink` 仍把 `#小节` 从路径里拆掉（否则标题匹配会因为尾巴而失败），
但 `MarkdownLinkTarget` 的 `note` 分支**没有 `anchor` 字段**，行为上只切笔记。

理由：目标笔记的 `EditorView` 是在切标签之后才重建的，跳转坐标在解析时根本不存在。让类型
带上 `anchor` 就等于承诺一个没人能兑现的滚动，调用方迟早会照着写。需求方已确认本轮不做。

### 7. 滚动原语共享，只读窗上溯祖先

结论：新增 `scrollEditorToPosition(view, position)`，与 `useOutlineNavigation` 的跳转公式
完全一致（补回 `.cm-content` 的 `padding-top`、8px 落点边距）；自身不可滚时才上溯最近的
`overflow-y: auto|scroll` 祖先，把目标换算到它的坐标系；找不到祖先就什么都不做。

理由：只读预览是 auto height + `.cm-scroller { overflow: visible }`，**它的 scroller 没有
自己的滚动范围，往里写 `scrollTop` 是空操作**——卡片窗里的锚点跳转原本是死的。同一份公式
抄两遍会在任何一边调参时立刻漂移（大纲高亮那边还有一条 `posAtCoords` 的采样约定）。

取消动画：`wheel` / `touchstart` 每个容器只挂一次持久监听（`WeakSet` 去重），回调里取消
当前动画。初稿每次跳转 `addEventListener(..., { once: true })` 且结束时无 cleanup，
一次成功跳转就留下两个永不触发的监听器。

### 8. 不 `stopPropagation`

结论：点击处理只 `preventDefault()`。

理由：`preventDefault` 才是阻止 webview 导航的那一步，跟冒泡无关；顺手 `stopPropagation`
只会让上层容器收不到点击（选区内同步、关浮层、自己的 click-away 逻辑），而且这种破坏是
静默的。只读预览里另加一条：有非折叠选区时直接返回 false——双击选词的第一下不该把页面
滚走。

### 9. 分层：`utils` 读 `stores`，登记进白名单

结论：`src/utils/markdownLinkActions.ts` 值导入 `noteStore` / `tabStore`，在
`scripts/verify-architecture.mjs` 的 `UTILS_TO_STORES_WHITELIST` 与
`docs/decisions-architecture-layering.md` 契约表各登记一行。

理由：与 `externalNotes.ts` 同形态——「按标题找笔记再切标签」必须读内存里的笔记列表，
而笔记列表的所有权在 store。**解析层保持无 store**（`markdownLinks.ts` 只接受
`LinkNote[]` 参数），所以 `verify:markdown-links` 能在纯 node 里跑。

### 10. 覆盖范围

| 面 | 组件 | 交互 |
| --- | --- | --- |
| 实时渲染编辑器 | `MarkdownSourceEditor` | Ctrl/Cmd+单击 |
| HTML 预览（云文档、图谱节点） | `CloudNoteEditor`、`GraphPage` | 单击（`allowNoteLinks: false`） |
| 只读窗（卡片） | `MarkdownReadonlyView` | 单击 |
| 贴图窗 | `StickyNote` | Ctrl/Cmd+单击（可编辑面） |

不含：AI 侧栏、帮助中心、公告栏。后两者是应用自身文案，链接只该开浏览器（仍走
`src/utils/externalLinks.ts`）。

## 与既有决策的关系

- **`docs/decisions-typora-editor.md` M6 / M11**：M6 的表把编辑器里的链接写成「文本，
  不可点（靠预览面板）」，本轮改为「Ctrl/Cmd+单击可点」；M6 里「只 `openInDefaultBrowser`、
  只放行 http(s)」的实施记录也已被 M11 推翻（那样会静默丢掉锚点与笔记链接）。M11 只记渲染
  侧的交互与滚动修复，完整理由在本文。
- **`docs/decisions-architecture-layering.md` 契约 1（门禁 R3）**：新增第 15 条白名单
  （`markdownLinkActions.ts`，值导入）。契约本身不变：`utils → stores` 仍需逐条登记理由，
  解析层（`markdownLinks.ts` / `linkScheme.ts`）保持零 store 依赖，这样它才能在 node 里被
  断言。

## 验证

- `npm run verify:markdown-links`（新）——51 项：外部/不可跳转/锚点/笔记/比较键/标题定位/
  scheme 真源。覆盖了 `javascript:`、`data:`、`file:`、`C:\x\y.md`、坏转义 `a%zzb.md`
  不抛错、同名两篇不跳、`other.md` 不等于 `Other Note`、围栏代码块与 front matter 里的 `#`
  不是标题。
- `node scripts/verify-architecture.mjs`——R1–R5 全 PASS（R3 实测 15 文件 / 白名单 15 条）。
- `npx tsc --noEmit`、`npm run verify:live-preview` 无回归。
- **未覆盖（需人工目视）**：点击/修饰键的真实分发、只读窗的上溯滚动是否落在标题上、
  跨笔记跳转后标签栏与大纲是否同步、`prefers-reduced-motion` 下的瞬时落点。

## 开放问题

1. **跨笔记锚点**（`other.md#小节`）。要做得先「切标签 → 等新 `EditorView` 挂载 → 再滚」，
   等于给链接跳转加一个跨组件的收尾动作。本轮类型上已明确不承诺。
2. **split 模式左右不对齐**。云文档 split 的滚动同步是**按比例**映射
   （`scrollTop / (scrollHeight - clientHeight)`），而锚点跳转是精确到标题行；跳一次之后
   源面板停在标题上、预览面板停在同一比例的位置，两者内容不同。要一致就得让同步改成
   「按块对齐」或让锚点跳转在 split 下改走预览容器的 `scrollToAnchorInElement`。
3. **`.cm-md-link` 没有可点线索**。样式本轮未改，编辑器里链接文本和普通文字只差一个色号，
   看不出「Ctrl+单击可跳」。候选：hover 时加下划线、或按住修饰键时整篇链接一起高亮
   （后者需要一条只在修饰键按下时生效的装饰，代价是每次 keydown 都重配扩展）。
4. **辅助窗口里的跨笔记链接是空操作**。贴图窗、磁贴窗都是独立 webview，只从磁盘读
   `index.json` 与笔记内容，**没有 hydrate `noteStore`**（`main.tsx` 里只有 `App` 走
   完整引导）。所以那里的 `other.md` 解析成 `none`：不会跳到错误的笔记，但也不会跳。
   要支持要么在辅助窗口 hydrate 笔记列表（多一次 IO），要么加一条 `open-note` 事件让主窗口
   切标签。
5. **自引用 `[x](本篇标题.md)` 等价于激活当前标签**，不做特殊处理。解析层不知道点它的是
   哪一篇（`markdownLinks.ts` 无状态、不依赖 store），所以 `note` 分支一律
   `openTab(noteId)`；noteId 就是当前激活项时，`openTab` 只会重新激活同一标签，视觉上无变化。
   若要「自引用 = 跳到本文同名小节」，得给上下文加回「当前笔记 id」并重新引入跨笔记锚点的
   那套问题（见第 1 条），本轮不做。
