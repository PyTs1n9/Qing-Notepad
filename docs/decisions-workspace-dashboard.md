# 工作台（Dashboard）风格统一与美化 · 决策记录

> **TL;DR**（2026-10-24，五轮均已落代码，执行结果见文末）
> - D1 进工作台默认停在「概览」，不再自动打开第一篇文档（代价：改了旧肌肉记忆，回退路径要显式）。
> - D2 概览面板四块内容全部只读、零新增请求。
> - D3/D4 正文与左栏只调视觉密度与对齐，不动排版、`max-w-[820px]`、CodeMirror 配置。
> - 第三~五轮把概览提取的设计语言推广到全站，子窗口统一走 `Layout/ModalShell.tsx`。
> - 真机视觉未验收（本机无 GUI），清单在「仍未验证」一节。

状态：grill 定案，**已落代码（2026-10-24，见文末「实施结果」）**。记录于 2026-10-24。

## 范围

| 包含 | 不包含 |
| --- | --- |
| `Workspace/WorkspaceSidebar.tsx`（左栏 explorer） | 右侧 AI 侧栏 |
| `Workspace/WorkspaceStrip.tsx`（36px 条带） | 数据结构、Supabase 表、网络逻辑 |
| `Workspace/WorkspaceView.tsx`（主卡全部状态 + 新建/管理/删除/转让四个弹窗） | 顶栏、ActivityBar、Sash 几何、玻璃分层 |
| `Workspace/CloudNoteEditor.tsx`（视觉与密度，不改正文排版） | 本机无 GUI，不做真机视觉验收 |

参照基线：note 与 todo 两个视图已完成的风格（36px 条带 + 浮卡 + `text-on-*` 前景 token +
`EmptyState` 单例 + 容器查询 + 12/13px 正文）。

## D1 进入工作台默认停留「概览」

- **结论**：`loadDocuments` 不再自动把 `documents[0]` 设为 `activeDocumentId`；切换工作台后主卡
  显示概览面板，用户点文档才进编辑器。36px 条带左侧的工作台名可点回概览。
- **理由**：现状下只要工作台里有文档，进工作台就直接进编辑器，概览页永远看不到 —— 不做这一步，
  下面 D2 的内容等于零可见性。
- **代价**：改变了「点工作台 = 看第一篇」的既有肌肉记忆。回退路径必须显式（条带工作台名 + 由概览
  进入的文档被删除后落回概览）。

## D2 概览面板四块内容（全部只读，零新增请求）

1. **文档与发布状态统计**：文档总数 + 草稿 / 定时 / 已发布三段分布。
2. **成员与我的身份**：成员数 + 头像堆叠 + 当前角色徽标。
3. **最近编辑列表**：按 `WorkspaceDocument.updatedAt` 倒序前 5 篇，点击进编辑器。
4. **owner 专属操作区**：邀请码 + 复制 + 分享入口 + 待发布/定时文档提醒（非 owner 不渲染该块）。

- **理由**：`workspaceStore.loadWorkspaces` / `selectWorkspace` 已经同时拉 `documents` 与 `members`
  （`workspaceStore.ts:136-139`、`157-160`），四块数据全部在内存里，不需要任何新请求。
- **约束**：概览不引入任何写操作；所有动作复用现有 store action 与 `workspaceUi` 的 dialog。

## D3 正文编辑器只统一视觉与密度，不动排版

- 工具栏高度对齐 note 编辑器的 36px；控件圆角/间距/悬停态统一。
- 右侧状态区（权限 dropdown / 发布按钮 / 网络浮层 / 保存态 / 在线头像）收纳成两组，去掉
  `·` 手工分隔符；窄卡下不靠 `flex-wrap` 硬折行。
- 发布弹窗、只读提示卡对齐 `app-modal-panel` 与 `EmptyState`。
- **不动**：`max-w-[820px]` 正文宽度、行高、标题层级、CodeMirror 与预览的双栏比例。

## D4 左栏只调视觉密度，不重排

所有控件与入口保持原位。只做：间距节奏、层级（工作台切换器 / 文档列表 / 筛选之间的分组）、
空态换 `EmptyState`、hover 与选中态统一。

## D5 与 note / todo 对齐的具体硬规则

| 项 | 现状 | 目标 |
| --- | --- | --- |
| 黄底文字 | 4 处 `bg-warning + text-white`（`WorkspaceSidebar:370,507`、`WorkspaceView:1006`、`CloudNoteEditor:1454,1480` 同族） | `text-on-warning`（新增 token）或改 `text-bg-primary`；必须过 `verify:ui-polish` 对比度 |
| 弹窗圆角 | 管理弹窗 `rounded-[22px]`，其余 `rounded-xl` | 全部 `rounded-xl` |
| 空态 | 图标 + 一行 14px 文字，四种写法 | 统一 `Layout/EmptyState`（含 `brand-face` 标题） |
| 小字号 | 大量 `text-[10px]` / `text-[11px]` | 正文类上提到 12px；只有纯标注（徽标、键名）可留 11px |
| 条带 | 已是 `ShellStrip`，合规 | 保持 `h-9`，不新增第二条 hairline |
| 前景色 | — | 一律 `text-on-accent/success/danger/warning`，禁止 `text-white` |

## D6 验证方式

本机无 GUI：

1. `npx tsc --noEmit` + `npm run verify:ui-polish`（静态审计 + 对比度实测）。
2. 用脚本生成 `.workbuddy/preview/workspace-*.html`（构建产物 CSS + 真实 token），headless Chrome
   截图核对浅/深两主题，作为视觉自查证据。
3. 真机验收（加载态、悬停浮层、拖拽、协作连接、150% 缩放）由用户完成，代码交付时如实标注未验项。

## 第二轮确认（2026-10-24）

- **D7 空工作台态走概览内单独一套**：已登录但没有任何工作台时，仍然渲染概览框架（标题 + 说明），
  内容区放创建/加入引导卡；不再回到旧的居中裸空态（`WorkspaceView.tsx:513-546` 整段废弃）。
  理由：概览是工作台的常驻首页，四种状态应当同一套骨架，否则用户会看到界面「跳形态」。
- **D8 配色同步**：新增 `--color-on-warning`，`@theme` + 四套主题各覆盖一次；
  `verify-contrast.mjs` 的扫描列表加 `warning`，`verify-ui-polish.mjs` 的 P0-1a/1b 同步扩到 warning，
  P0-1c 的 `text-white` 登记清单删掉 `WorkspaceSidebar`(2) 与 `WorkspaceView`(1) 两条。
  理由：不做 token 就只能继续用白字，而黄底白字对比度 3.1:1 左右，不达标。
- **D9 最近编辑为空的降级**：不是补一句文案，而是整块换成 `EmptyState`，`canEdit` 时带「新建云文档」
  action，viewer 不带 action；同时「待发布」统计卡在计数 > 0 时加 warning 圆点，让「有草稿没发布」
  在概览上形成完整叙事。理由：空白列表读起来像加载失败，而给 viewer 一个点不动的按钮是假入口。

实施提示词已落 `docs/prompt-workspace-dashboard.md`（B0–B6 六批，含验收命令与不可验证项清单）。

## 实施结果（2026-10-24）

B0–B6 全部落地，`node node_modules/typescript/bin/tsc --noEmit` 与
`npm run verify:ui-polish`（15 条静态审计 + 56 组对比度实测）全绿。

改动清单：

| 文件 | 改动 |
| --- | --- |
| `src/index.css` | 新增 `--color-on-warning`（@theme + 四主题）；新增 `.workspace-editor-toolbar` / `.workspace-overview` 两个容器与 `.workspace-status-text` / `.workspace-avatars` / `.workspace-overview-stats` / `-body` / `-pair` / `-actions` 六个辅助 class |
| `src/stores/workspaceStore.ts` | `loadDocuments` 不再自动选中首篇；`deleteDocument` 删当前文档后回概览 |
| `src/components/Workspace/WorkspaceOverview.tsx` | 新文件，四态共用一套骨架 |
| `src/components/Workspace/WorkspaceView.tsx` | 两段旧空态换成概览；四弹窗头/圆角/按钮尺寸/前景色统一 |
| `src/components/Workspace/WorkspaceSidebar.tsx` | `text-on-warning`、空态换 `EmptyState`、字号与分组间距 |
| `src/components/Workspace/WorkspaceStrip.tsx` | 无选中文档时工作台名是「回概览」按钮 |
| `src/components/Workspace/CloudNoteEditor.tsx` | 工具栏 36px 对齐、状态区两组收纳、未配置提示换 `EmptyState` |
| `src/utils/i18n.ts` | 新增 16 个 key（中英同步） |
| `scripts/verify-ui-polish.mjs` / `verify-contrast.mjs` | warning 纳入审计，`text-white` 登记表删掉两条 |
| `scripts/gen-workspace-preview.mjs` | 新增，生成四份快照（`.workbuddy/preview/workspace-*.html|.png`） |

### 第二轮（同日）：三处偏离回正 + 左栏重做 + 子窗口

第一轮交付时记录的「三处偏差」已全部按提示词回正，做法不是照抄字面而让功能坏掉：

1. **栅格**回到提示词的 `sm:grid-cols-2 lg:grid-cols-4`（body 用 `lg:grid-cols-[1.5fr_1fr]`），
   另外在 `@container workspace-overview (max-width: 479px)` 上加一条护栏，保证「480px 以下单列」。
   护栏是 unlayered 规则，直接压过工具类，不需要 `!important`。
2. **状态区真的加了 `overflow-hidden`**。为了不让它把浮层吃掉，网络历史与在线成员改成 portal 到 body 的
   悬停浮层（新组件 `Workspace/HoverPopover.tsx`）：hover / focus 打开、140ms 延迟关闭（够指针跨过 6px
   间隙）、Escape 关闭、滚动与缩放时重新定位、下方不够空间时向上翻。
3. **保存态**改回「紧随其后 + 按状态上色」的文字（`text-success / text-warning / text-text-muted`），
   面板里也有一份；圆点只在浮层内部当装饰。

同日追加的三处：

- **左栏重做**：结构与 note 树 / todo 列表面板一致 —— `h-9` 标题栏（11px 大写标题 + 计数 + 两个 28px 图标按钮）、
  32px 扁平工作台切换行（`WorkspaceDropdown` 新增 `tone="plain"`）、chips 筛选（选中态与 note 的标签 chip 同款
  `bg-accent text-on-accent`）、32px 文档行（13px 标题 + 状态色图标 + 省略年份的日期）、`border-t` 双列页脚。
  原来的渐变 hero、内嵌圆角切换卡、48px 新建卡、四段式分段控件、行内徽标全部删除；访问级别、定时时间等
  细节移到「文档详情」浮层。行内 `...` 按钮删除。
- **行菜单改为右键**：`onContextMenu` 在行上打开（`role="menu"` 浮层按指针坐标定位并用 `clampFloatingMenu`
  夹在视口内），外加 `ContextMenu` / `Shift+F10` 键盘等价路径；关闭条件为「点外部 / Escape / 窗口缩放 /
  列表滚动（滚动菜单自身不触发）」。条目内容与原来一致：重命名 / 定时发布 / 文档详情 / 删除。
- **管理工作台弹窗**：双 tab 保留，内部重做 —— 设置页整页可滚动（原来 `overflow-hidden`，窗口矮时下半截
  无法到达）、非 owner 不再看到空白页（改 `EmptyState`）、分享区拆成「邀请码 + 复制 + 重新生成」与
  「新成员权限」两块（原来代码与角色控件挤在同一个横排，邀请码还渲染了两份）、成员清单限高 200px 自滚
  （原来无限增长会把文档权限表挤没）、文档权限行改用 `h-7` 控件与 11px 说明、空文档走 `EmptyState`。
- **概览入口补齐**（第二轮反馈）：进编辑器后 `WorkspaceStrip` 只剩文档名，左栏也没有回概览的入口，
  于是 D1 的「条带工作台名可点」只在**没有**打开文档时生效，等于没有回路。现在两处都有：条带 leading 加了
  返回箭头（`ChevronLeft`，左栏折叠时仍可用），左栏列表顶部加了常驻的「概览」行（`LayoutDashboard`，
  无选中文档时是 `flat-active-row` 选中态）。两处都走 `selectDocument(null)`。
- **网络浮层**：口径统一（曲线、阈值虚线、图例、工具栏数字全部走 `displayLatency` 的四分之一「体感」
  口径，此前图例写 150/400ms 而曲线画的是 ÷4 值，永远贴着顶边）；数字从 6 格减到 3 格（当前 / 平均 /
  最慢），P95 与最小在 30 个采样点下没有统计意义；「同步积压」改成仅在 > 0 时出现的 warning 行（原来
  「0 ms」会被读成延迟）；失败采样从顶部（被画成最快的点）改为底部红色短竖线；最新采样点单独放大。

### 仍未验证（本机无 GUI，须真机确认）

- 悬停浮层的定位、翻转与遮挡（已改为 portal，行为与旧 CSS 版本不同）
- 右键菜单在列表滚动 / 窗口缩放时的关闭时机
- 拖拽重排文档
- Yjs 协作连接、断线重连、`CloudNoteEditor` 卸载后连接释放
- 150% 显示缩放下的实际读数
- 拖动侧栏时概览的容器查询是否实时跟随

## 第三轮（同日）：子窗口统一 —— `Layout/ModalShell.tsx`

前面的工作把工作台本身对齐了 note / todo，但它打开的**子窗口**仍是手搓的：同一个「确认删除」在
note 侧栏、todo 侧栏、todo 主卡、工作台里各写了一份，头部有三种内边距、三种遮罩、两种阴影、
两种关闭方式。这轮把弹窗收进一个壳。

### 方案

新组件 `src/components/Layout/ModalShell.tsx` 是唯一的弹窗外壳：

| 部位 | 规格 |
| --- | --- |
| 遮罩 | `.app-modal-backdrop`：`color-mix(bg-primary 12%, rgb(0 0 0 / 46%))` + 2px 模糊；`prefers-reduced-transparency` 下关闭模糊 |
| 面板 | `rounded-xl`（12px）+ `border-border` + `bg-bg-primary` + 双层阴影（近影 1px 2px + 远影 20px 48px）；暗色主题额外加 `inset 0 1px 0` 高光 |
| 头部 | `h-8` 图标块（accent / warning / danger / success 四种语气）+ `text-sm font-semibold` 标题 + 可选 `text-[11px]` 说明 + `h-8 w-8` 关闭键；`border-b` + `bg-bg-sidebar/45` |
| 正文 | 唯一的滚动容器（`px-4 py-4`，`overscroll-contain`，`scrollbar-gutter: stable`）；需要自管滚动时传 `scrollBody={false}` |
| 页脚 | `border-t` + `px-4 py-3`；左槽放危险动作（退出/删除工作台），右槽放主次按钮；窄窗口自动改成竖排 |
| 尺寸 | `sm 400` / `md 460` / `lg 560` / `xl 680` |
| 行为 | 打开时把焦点移进面板、关闭时归还；Esc 关闭（请求进行中可锁）；点遮罩关闭（从输入框里拖选不会误关）；统一 portal 到 body |

### 已迁移的子窗口（10 处）

工作台：新建/加入/新建文档/重命名、管理工作台（双 tab）、删除确认、转让创建者、移除成员、
发布状态弹窗；全局：应用级确认与进度（`AppDialog`）、回收站、移到文件夹、笔记删除确认、
待办列表删除确认、待办删除确认。

### 顺带修掉的实际问题

- 管理工作台设置页原来 `overflow-hidden`，窗口矮时下半截无法到达 → 改为整页可滚动。
- 分享区原来把邀请码渲染两份、并把「新成员权限」挤进同一个横排 → 拆成两块。
- 成员清单原来无限增长，会把文档权限表挤没 → 限高 200px 自滚。
- 回收站的二次确认原来占一条页脚 → 改成正文顶部的 danger 提示条 + 页脚按钮。
- 移到文件夹原来没有关闭键 → 有了统一的 X，并给当前项加对勾。

### 快照

`.workbuddy/preview/workspace-dialogs.html` 现在展示**弹窗族**（删除 / 转让 / 新建 / 回收站 /
管理工作台两个 tab / 发布弹窗），浅深两套主题并排。

## 第四轮（同日）：以概览为基准的设计语言提取与推广

用户给出真机截图，要求「以概览为统一基准，把同一套语言应用到其余页面」。
截图里暴露了一个快照里看不出来的问题：统计区在宽卡下塌成 2×2、每卡大片留白。

### 概览提取出的基准（其它页面照此对齐）

- **配色**：卡片 `border-border` + `bg-bg-secondary/40`（不投影、不渐变）；
  页面底 `bg-bg-primary`；主文字 `text-text-primary` / 次 `text-text-secondary` / 说明 `text-text-muted`；
  强调 `accent` / `accent-light` / `text-on-accent`；状态 `success` / `warning` / `danger` 一律配 `text-on-*`。
- **间距**：4 / 6 / 8 / 12 / 16 / 24 六级；卡内 `px-3.5 py-3`；区块间距 `gap-3`（12px）；页边距 `px-5/7 py-5/6`。
- **圆角**：区块与卡片 `rounded-xl`（12px），控件 `rounded-lg`（8px），徽标 `rounded-full`。
- **层级**：页标题 19px（brand-face）→ 统计数字 24px（tabular-nums）→ 区块标题 12px 大写追踪
  → 行标题 13px → 说明 11–12px。
- **分组**：统计 → 最近编辑 + 成员（1.5fr : 1fr）→ owner 区，全部用同一类卡，不再叠第二层卡片。
- **栅格**：**卡宽驱动** —— <480 单列、≥640 四列统计、≥720 最近编辑/成员双栏。

### 各页面改动

| 页面 | 具体改动 |
| --- | --- |
| 概览（基准） | 栅格从纯视口断点改成「视口 `sm/lg` 打底 + 容器查询升级」：`@container (max-width:479px)` 强制单列；新增 `@container (min-width:640px)` 统计四列、`(min-width:720px)` 主体双栏。宽卡不再塌成 2×2、也不再有半空的卡 |
| 编辑器主卡 | 36px 条带 + 36px 工具栏（与概览条带同高）、状态区「文档态｜协作态」两组、按钮统一 32px，去掉手打 `·` 分隔 |
| 文档详情浮层 | 头部与 `ModalShell` 完全同构（图标块 + 14px 标题 + 11px 说明 + 32×32 关闭键）；字段卡改为概览同款 `border-border + bg-bg-secondary/40`、间距 `gap-2`、标签 11px、值 13px |
| 右键菜单 | 条目内容不变；浮层 `rounded-xl + border-border + shadow-xl`，与下拉面板的圆角、内边距一致 |
| 管理工作台弹窗 | 三格角色计数卡沿用概览统计卡语言（`bg-secondary/40`、数字 tabular-nums），成员/文档清单共用同一行高与 11px 说明 |
| 网络浮层 | 图例与曲线统一到同一延迟口径；三格数字卡与统计卡同构；保存态为正文色而非新色板 |
| 空态 / 只读态 | 一律走 `Layout/EmptyState`（图标 + brand-face 标题 + 说明 + 可选主按钮），viewer 不给假入口 |

### 说明

`sm:grid-cols-2 lg:grid-cols-4` 与容器升级**并存**，不是二选一：视口断点决定窗口级的粗排，
容器查询决定这张卡自己够不够宽。两者都写在 `index.css` 的 `.workspace-overview` 区块里。

## 第五轮（同日）：把同一套语言铺到全站子窗口

第四轮只统一了工作台自己的子窗口；这轮把剩下的手搓弹窗全部收口，**全站再无第二种弹窗写法**。

### 迁移到 `ModalShell`（4 处）

- `Settings/UpdateModal.tsx`：发现新版本（原为 40px 图标块 + 16px 标题 + 三层按钮），改为主页脚三按钮（不再提醒 / 稍后 / 立即更新）。
- `Help/UpdateCheckModal.tsx`：检查更新（原为绝对定位的 X + 卡片），四种状态不变，头部与卡片壳统一。
- `Help/HelpCenterModal.tsx`：帮助中心（手册 / FAQ / 快捷键 / 画布），tab 条从「头部内自定义」改用 `ModalShell` 的 `tabs` 插槽。
- `Workspace/WorkspaceRemovalNotifier.tsx`：被移出工作台的通知（danger 语气 + 单按钮页脚）。

### 只做对齐、不换壳（3 处，保留各自的复合布局）

- `Settings/SettingsModal.tsx`（设置）：头部换成 32px 图标块 + 14px 标题 + 32px 关闭键；左侧导航从「带内边距的 14px 按钮」改成 **32px 行**（`flat-active-row` + 2px 强调条），与左栏的「概览」行同一语言；分区标题 18px → 15px；下拉触发器与选项统一 32px / 13px；面板卡片 `/35` → `/40`。
- `Auth/AuthModal.tsx`（登录/账号）：遮罩换成统一遮罩、面板挂上 `app-modal-panel` 阴影、头部与关闭键同规格。
- `Auth/PasswordRecoveryModal.tsx`（找回密码）、`Settings/AvatarCropper.tsx`（头像裁剪）：头部、关闭键、圆角、阴影同规格；头像裁剪那个 `rounded-2xl` 是全站最后一个 2xl 圆角，已归位到 12px。

### 现在的全站规则

| 项 | 规则 |
| --- | --- |
| 弹窗 | 一律 `ModalShell`（`size` 取 sm/md/lg/xl）；复合布局的弹窗也必须用它的头部与页脚 |
| 头部 | 32px 语气图标块 + `text-sm font-semibold` 标题 + `text-[11px]` 说明 + 32×32 关闭键 |
| 页脚 | `border-t` + `px-4 py-3`；右对齐主次按钮，危险动作放左槽；窄屏竖排 |
| 控件 | 下拉/输入/按钮统一 32px 高、13px 字；列表行 32px |
| 卡片 | `rounded-xl` + `border-border` + `bg-bg-secondary/40`，不投影；只有浮在内容上的层才带阴影 |
| 圆角 | 12px（面板/卡片）、8px（控件）、full（徽标）——不再有 2xl |
| 阴影 | 只有 `app-modal-panel` / `app-popover` 两级：面板双层阴影，浮层单层 `shadow-xl` |
