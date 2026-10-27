# UI 美化（0.6.2 开发分支）决策记录

> **TL;DR**（0.6.2，P0/P1/P2 已执行；本轮结论的唯一真源）
> - D1 前景色 token 化：`--color-on-accent/success/danger` 替掉约 40 处 `text-white`，不写死白字。
> - D5/D6/D7 动效：ActivityBar `layoutId` 滑动胶囊、标题逐字母错峰、曲线收敛为 `--ease-*` / `--dur-*`。
> - D3 启动底色由 Rust 回读上次写入值；D4 纸纹只在纯色背景下启用；D10 滚动条重写但留系统兜底。
> - D14 侧栏拖动条改过三版，定稿「hover 才出现的渐变线」——别再兜回无痕或常显。
> - 验收判据见第 4 节，执行记录与 D11/D12/D13 补漏见第 5 节。

> 本轮所有结论的唯一真源。提示词文档 `docs/prompt-ui-polish.md` 由本文派生；
> 若两者冲突，以本文为准，并同步修正提示词。
>
> 记录日期：2026-10-24 · 状态：已执行（P0/P1/P2 三批落地，验收见第 5 节）

## 0. 背景

0.6.1 已对外分发。视觉体系（三浮卡 + 磨砂 + 6px 节奏 + 容器查询 + 主题变量）
已经成型，本轮不是"重做界面"，而是补齐三类缺口：**可读性缺陷、纵深不足、缺少记忆点**。
用户追加要求把字体、ActivityBar 滑动胶囊、滚动条重写一并纳入（原建议中排除，现收回）。

开发在分支上进行，**由用户在开发结束后统一打 0.6.2 节点**，本轮不涉及发版动作。

## 1. 已定结论

### D1｜accent/success/danger 上的前景色改为 token，不再写死 `text-white`

**结论**：在 `@theme` 中新增 `--color-on-accent` / `--color-on-success` / `--color-on-danger`，
各 `.theme-*` 覆盖取值；约 40 处 `text-white` 按"底色类型"逐个替换为对应 `text-on-*`。

**理由**：
- 实测（WCAG 相对亮度公式）现有组合大面积不达标（小字需 4.5:1）：

  | 主题 | 底色 | 用途 | 白字对比 | 判定 |
  |---|---|---|---|---|
  | blue | `#2563eb` accent | 主按钮/选中 | 5.17 | 通过 |
  | blue | `#1d4ed8` accent-hover | 悬停 | 6.69 | 通过 |
  | blue | `#22c55e` success | 完成态 | **2.28** | 不通过 |
  | blue | `#ef4444` danger | 删除/退出 | **3.76** | 不通过 |
  | dark | `#5c7cfa` accent | 主按钮/选中 | **3.68** | 不通过 |
  | dark | `#4c6ef5` accent-hover | 悬停 | **4.32** | 边缘不通过 |
  | dark | `#51cf66` success | 完成态 | **2.00** | 不通过 |
  | dark | `#ff6b6b` danger | 删除/退出 | **2.78** | 不通过 |
  | yellow | `#c4a24a` accent | 主按钮/选中 | **2.44** | 不通过 |
  | yellow | `#b08e38` accent-hover | 悬停 | **3.10** | 不通过 |
  | yellow | `#8ab88a` success | 完成态 | **2.28** | 不通过 |
  | yellow | `#d98a7a` danger | 删除/退出 | **2.66** | 不通过 |
  | green | `#4aaa6a` accent | 主按钮/选中 | **2.87** | 不通过 |
  | green | `#3a9a5a` accent-hover | 悬停 | **3.51** | 不通过 |
  | green | `#6aba6a` success | 完成态 | **2.40** | 不通过 |
  | green | `#d88a8a` danger | 删除/退出 | **2.65** | 不通过 |

- 只有 blue 的 accent 家族本来达标，**其余 12 组全部不达标**，其中 danger 承载
  破坏性操作（删除笔记、退出应用），属可用性缺陷而非观感问题。
- 不能靠"把 accent 压深保白字"统一解决：dark 的 `#5c7cfa` 压到能配白字的
  `#3b5bdb` 后，`text-accent`（暗底上的强调文字）对比会从 4.67 掉到 **3.06**，
  等于拆东墙补西墙。**该路径作废**（这是对早期建议的自我修正）。

**取值策略**：低饱和主题（yellow/green）配深色前景，与莫兰迪色系协调；
blue 保持白字不动；dark 的 accent 用极深前景压亮蓝。最终每个组合必须由脚本实测
≥ 4.5 才通过，不足时**优先微调该主题的底色**（不是前景色）。

### D2｜全局补 `:focus-visible`，滚动容器用负 offset

**结论**：在 `@layer base` 增加全局焦点环，`[role="treeitem"]` 与 `.note-tab-strip button`
使用 `outline-offset: -2px`。

**理由**：`index.css` 现仅有 `.sticky-content:focus` 与 `.canvas-switcher-create:focus-within`
两处局部规则；`NoteTree` 实现了 roving tabindex（`NoteTree.tsx:109`）却无可见焦点，
键盘用户无法定位。滚动容器内正向 offset 会被裁掉，必须负向内嵌。

### D3｜启动背景色由 Rust 读取"上次写入的底色"，不复制色表

**结论**：新增一个前端命令把当前 `--color-bg-primary` 解析后的 hex 写入
`%APPDATA%/com.qing-notepad.app/window-bg.json`；`lib.rs` 的 `setup` 读取该文件并
`set_background_color`。

**理由**：
- `tauri.conf.json` 的窗口配置无 `backgroundColor` 且 `decorations: false`，Tauri 默认画白，
  深色主题启动必闪白。
- 静态写一个值无效：默认主题是 **blue**（`settingsStore.ts:220`），写深色会让浅色用户黑闪；
  写 `#f0f4f8` 对 dark 用户几乎等于没改。
- 不在 Rust 侧复制主题色表：用户支持自定义调色板（`theme: "custom"`），Rust 无法复刻派生色，
  且会违反单一真源。让前端写入结果值，Rust 只读一个 hex。

**风险**：`Window::set_background_color` 的 API 可用性需先核实（见待定 Q1），
不可用时降级为静态 conf 值并记录。

### D4｜纸纹只在纯色背景下启用，有壁纸时关闭

**结论**：噪点纹理叠加在 `.surface-glass::before` 的 `background-image`；
`hasBackground` 为真时禁用。

**理由**：
- `.surface-glass::before` 用的是 `background-color` + `backdrop-filter`（`index.css:224-234`），
  不是 `background` 简写，所以 `background-image` 可以共存，不会覆盖 tint。
- **绝不能放卡片本身**：带 `filter`/`backdrop-filter` 的祖先会成为 `position: fixed` 的
  包含块，而本应用把右键菜单、弹窗都渲染在卡片内部（`index.css:200-212` 已有此注释）。
- 有壁纸时用户挑的图自带纹理，再叠噪点会让画面显脏，故直接关闭。

### D5｜ActivityBar 用 motion 的 `layoutId` 做滑动胶囊，并统一按钮高度

**结论**：选中指示器改为单个 `motion.span layoutId="activity-indicator"`；
顶部四个按钮 `h-11` 与底部四个 `h-10` 统一为 `h-10`。

**理由**：
- `motion`（^14.5.0）已在 `AiSidebar` / `ModelPicker` / `NoteTabBar` / `AiPolishPanel` 使用，
  且 `useReducedMotion` 已有先例，**零新增依赖**，不违反轻量取向。
- 当前顶部 `h-11`（`ActivityBar.tsx:56`）与底部 `h-10`（`:74/86/95/105`）不一致，
  两段按钮的图标基线与左边距差 1px，是可见的不齐。
- 保留 `bg-bg-active` 色块 + 左侧 2px 条属于双重编码，胶囊方案取其一带发光即可。

### D6｜标题栏逐字母动画加错峰、降幅度

**结论**：`scale-125` → `scale-110`、`-translate-y-0.5` → `-translate-y-px`，
并加 `transitionDelay: index * 12ms`；`prefers-reduced-motion` 下取消位移与缩放。

**理由**：`TitleBar.tsx:143` 现在是十一个字母同幅同步跳动，鼠标扫过时视觉噪音大且无节奏。
错峰后变成一次波浪，是我们想要的"记忆点"而不是干扰。

### D7｜动效曲线收敛为三个 token

**结论**：定义 `--ease-out: cubic-bezier(.22,1,.36,1)`、`--ease-spring: cubic-bezier(.2,1.35,.38,1)`、
`--ease-in-out: cubic-bezier(.4,0,.2,1)` 与 `--dur-fast/base/slow`，替换现存 6 种手写曲线。

**理由**：现有 `(0.2,0.9,0.25,1.18)`、`(0.33,1,0.68,1)`、`(0.2,1.35,0.38,1)`、`(0.2,0.8,0.25,1)`
等散落各处，手感不统一。收敛是"界面像一个东西"的最省力手段，且纯 CSS 变量，零风险。

### D8｜空态抽公共组件，只做文字 + 图标

**结论**：新增 `src/components/Layout/EmptyState.tsx`，供笔记树、Todo、搜索无结果、回收站复用。
**不做插画/手绘图形**（用户明确排除）。

**理由**：`NoteTree.tsx:902` 的空态只有一行 `<p>noNotes</p>`，是全应用最可能承载品牌感的
位置，却在四个视图里各写一遍。抽成组件与项目"不重复推导"的取向一致。

### D9｜字体方案进本轮范围，但设体积闸门

**结论**：为品牌字（标题栏 "Qing Notepad"）与空态大标题引入**一个 Latin 展示字体**
（自托管、子集化）；中文正文字体**不动**。

**理由与限制**：
- 项目硬规则：开发侧成本 = 安装包体积（API 是 BYOK，不计费）。当前 NSIS 包 25.64 MiB。
- 中文字体单 weight 子集后仍可达数 MB，且需引入构建步骤，风险与收益不成比例，故不引入。
- Latin 子集（仅品牌字所需字符）可控制在 40 KiB 内，闸门：**新增字体文件合计 ≤ 60 KiB**，
  超出即回退为纯系统字体方案并记录。字体文件必须随仓库自托管，不得 CDN 外链
  （离线可用 + CSP）。

### D10｜滚动条重写，但保留系统细滚动条作为兜底

**结论**：用 `::-webkit-scrollbar` 系列重写为 6px、默认 thumb 45% 透明、容器 hover 时 78%。

**理由**：现用 `scrollbar-color` + `scrollbar-width: thin`（`index.css:476-477`），
thumb 默认 78% mix 偏重，破坏浮卡的干净感。

**坑**：Chromium 中 `scrollbar-width` 与 `::-webkit-scrollbar` 同时存在时，
**前者优先**，只写后者不生效。必须先移除 `scrollbar-width`/`scrollbar-color`
（或改为只在 `@supports not selector(::-webkit-scrollbar)` 内声明），再写伪元素，
并逐容器验证（树、编辑器、AI 侧栏、设置面板、画布各有自己的滚动容器）。

## 2. 已排除项

| 项 | 理由 |
|---|---|
| 空态插画 / 手绘图形 | 用户明确排除；与"纯 CSS、零资源"取向冲突 |
| 中文正文字体替换 | 体积（数 MB）+ 构建步骤，收益不成比例 |
| 启动画面（Splash） | 超出本轮范围，D3 已解决首帧观感 |
| 布局几何调整（pad/gutter/top-gap/圆角） | 用户在上一轮已定 6px 节奏，属**不变量**，本轮不得动 |
| 顶栏菜单结构 | 上一轮已收敛为"仅帮助菜单"，不得回退或新增 |

## 3. 待定问题（已全部关闭，结论见第 5 节）

- **Q1**（已关闭）：`tauri::Window::set_background_color` 在 Tauri 2.12 可用，签名
  `set_background_color(Option<Color>)`，`Color(r, g, b, a)`。因为走的是自己的
  `invoke` 命令而不是 JS 侧 window API，**不需要** `core:window:allow-set-background-color`。
- **Q2**（已关闭）：最终 hex 见 D11，由 `scripts/verify-contrast.mjs` 实测确定。
- **Q3**（已关闭）：Fraunces 600，Latin 子集 woff2，17.7 KiB。
- **Q4**（已关闭）：`.sticky-content` 是原生 `contentEditable` div（不是 ProseMirror），
  空笔记时确实命中 `:empty`，属活代码，已改为 `content: attr(data-placeholder)` +
  `t(lang, "stickyEmptyHint")`。

### D14｜侧栏拖动条：悬停才出现的渐变分隔线（改过三版，别再兜圈）

**结论**：`.seam-line` 单元素承担全部三态——默认 `opacity: 0`（完全不可见）；hover 淡入为
2px 主题色分隔线（两端 22% 处淡出，无光晕、不加宽）；拖动再 `scaleX(1.5)` 到 3px + 16px 光晕。
指针热区 `::after` 从 6px 撑到 14px。

**演进过程（三版，全部记录，避免下次再走一遍）**：
1. **原始规则**："sash 完全无痕，只有拖动时的模糊光晕"。问题是三态只回答了一个问题，hover 态
   实际上不存在——6px 太窄，指针极难命中。
2. **第一版修正**：默认 muted 握把 + hover 换 accent + 拖动才出全高缝线。默认态仍在"说话"，
   但用户要的是更明显的主题色反馈。
3. **第二版**：常显 2px 渐变线（模仿参考截图）。安静度不够——两条常驻竖线成了装饰。
4. **定稿（当前）**：保留截图的**形状**（2px、主题色、两端淡出），但把**出现时机**改成 hover。
   即"要的是那个样式，不是那个常显状态"。

**为什么两端淡出**：实心全高竖线会把窗口切成两半，与"三张浮卡漂在 gutter 上"直接冲突；淡出后
读作"缝里的一道折痕"，所以在 hover 时它能整条出现而不显得生硬。

**状态分级靠什么**：hover = 全强度 2px（这就是"高光"，不再叠光晕，避免变成发光物体）；
拖动 = 加宽 50% + 16px 光晕，因为 `.sidebar-resizing` 已经把卡片阴影抽掉，缝上这点光是唯一
剩余的层次线索。

**代价与边界**：
- 14px 热区每侧压进相邻卡片 1px，命中优先级靠 `.seam { z-index: 1 }`；卡片内边距 ≥ 6px，
  不会盖到控件。
- 光晕用 `box-shadow`，**不用 `filter: blur()`**：后者会让整条全高元素在拖动时每帧重绘。

**未做（明确排除）**：拖动时的宽度数值气泡、`role="separator"` 的键盘可调（缺 `tabIndex` +
方向键 + `aria-valuenow`）。后者是既存无障碍缺口，与本次视觉改动无关，留作独立事项。

## 4. 验收判据

1. `npx tsc --noEmit` 0 error；`npm run build` 通过（PowerShell）。
2. 对比度脚本对**每个主题 × 每个 `bg-*`/`text-on-*` 组合**输出实测值，全部 ≥ 4.5 才通过。
3. 静态观感用 build 产物 CSS + headless Chrome 截图 + 同坐标取样（沿用
   `.workbuddy/preview/glass-compare.html` 的做法）。
4. **本机无 GUI，不得声称做过视觉验证**；hover 波浪、胶囊滑动、拖拽手感必须列入
   "待人工确认"清单交给用户。

## 5. 执行记录（2026-10-24）

两条脚本把上面能静态判定的部分固化了，避免"改一遍就退化"：

- `npm run verify:ui-polish` → `scripts/verify-ui-polish.mjs`（14 条，对应 P0-1…P2-3）
  + `scripts/verify-contrast.mjs`（对比度实测，48 组）

### D11｜`--color-on-*` 最终取值（实测确定）

| 主题 | on-accent | on-success | on-danger | 备注 |
|---|---|---|---|---|
| blue | `#ffffff` | `#052e16` | `#ffffff` | danger 底色压深为 **`#d42424`** |
| dark | `#08090f` | `#052e16` | `#2a0a0a` | |
| yellow | `#2a2214` | `#16240f` | `#2e1512` | |
| green | `#0d2416` | `#06240f` | `#2b1212` | |

**danger 底色偏离提示词初值**：提示词写 `#dc2626`（白字 4.84），实测改为 `#d42424`
（白字 5.15）。原因是提示词漏算了 `hover:bg-danger/90` 这一档——90% 的红色压在浅色底上
会**变浅**，`#dc2626` 的 /90 合成值只有 4.51，落在阈值边缘；`#d42424` 的 /90 为 4.63，
留出余量。这符合 D1「不足时优先微调该主题的底色」的约定。

实测（压在 `--color-bg-primary` 上，`bg-secondary` 差异 < 0.1）：

| 主题 | accent | accent-hover | success | danger | danger/90 |
|---|---|---|---|---|---|
| blue | 5.17 | 6.70 | 6.54 | 5.15 | 4.63 |
| dark | 5.41 | 4.60 | 7.43 | 6.60 | 5.58 |
| yellow | 6.44 | 5.06 | 7.19 | 6.38 | 7.05 |
| green | 5.66 | 4.64 | 6.98 | 6.61 | 7.30 |

### D12｜`disabled:bg-danger/80` 归为豁免项，不参与门禁

blue 主题下 `disabled:bg-danger/80` 的白字实测 **4.05**（`CloudNoteEditor.tsx:1605`）。
WCAG 1.4.3 明确豁免非活动控件，且该态的唯一用途是"删不了"的视觉提示，因此
**保留现状、脚本单独标注 `exempt` 而非 `FAIL`**，不为此改动 danger 底色（继续压深会
连带影响所有激活态按钮的观感）。这是本轮唯一的未达 4.5 的组合，登记在此备查。

### D13｜空态与状态色补漏（清单外但同属 D1/D8 的缺陷类）

- `EmptyState` 接入 **笔记树（无笔记 / 搜索无结果）、Todo 列表、回收站** 三处；
  接入时发现上一轮改了 JSX 却没补 `searchNoResults` / `searchNoResultsHint` 两个
  i18n key，也没 `import EmptyState`，两处都会断 `tsc`，本轮一并修好。
- `AiSettingsPanel.tsx:386` 的 `bg-danger/90` + `text-bg-primary` 改为 `text-on-danger`
  （blue 下前者 4.46，边缘不达标），属 D1 同一缺陷类，提示词的行号清单未覆盖。
- `.canvas-switcher-row--active .canvas-switcher-index` 的 `color: white` 改为
  `var(--color-on-accent)`（dark 主题 accent 上白字 3.68）。CSS 内同类的硬编码前景，
  提示词只列了 `.tsx`，同属漏项。
