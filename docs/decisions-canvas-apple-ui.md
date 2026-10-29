# 画布工具栏与画布侧栏 · macOS 视觉规范

状态：规范定稿（Phase 1，仅文档，不含代码改动）
范围：`CanvasView` 顶部工具栏（改为居中悬浮胶囊）+ 右侧 `canvas-switcher`（视觉重制）
参考系：macOS 桌面（Freeform / Keynote），不是 iOS
关联：`docs/decisions-glass-blur.md`、`docs/decisions-glass-layering.md`、`docs/decisions-colour-contrast.md`、`docs/decisions-ui-polish.md`（D1/D5/D6/D7）、`docs/decisions-topbar-menus.md`

已锁定的用户决策（不再讨论）：① 参考系 = macOS 桌面；② 工具栏 = 居中悬浮胶囊、脱边、磨砂感、分段分组；③ 侧栏保留右侧垂直居中悬浮条 44px → 248px，只换皮不换位；④ 文字标签宽屏保留、窄窗渐隐。

**修订追溯（Phase 2 合并状态）**：§7 体验审查（位于文末附录之后）的 R1–R11 **已全部并入第 1–6 章正文**，现在 1–6 章是落地唯一真源，§7 保留为取证与推理过程。合并时有两处与 §7 结论不同，已在正文标注并说明依据：

| 差异 | §7 原结论 | 本文定稿 | 依据 |
|---|---|---|---|
| ⑤⑥⑦ 阈值 | 350 / 310 / 285 | **426 / 396 / 362**（团队终值；④ 470） | §7 与 §1–§6 都曾把"折叠后的内容宽"当触发阈值；最终值 = 触发时内容宽 + 6–12px slack，**档间间隔 30 / 34 = 折叠减少量**，与字体无关、可直接定死。逐项算式见 §8.5 |
| 保存指示颜色 | `Check` 用 `text-success` | **`text-text-muted`** | `text-success` 对胶囊底实测 blue 1.86 / yellow 1.92 / green 2.08，低于非文字 3:1；见 §3.3 |

---

## 0. 设计原则

**P1｜浮起靠阴影，边界靠发丝线，两者都不靠提高 tint。**
胶囊底与画布底在五套主题里的明度差只有 1.08–1.13（实测见 §3.4），单靠填充看不见。识别责任分配给投影（浮起）与 1px 发丝线（定边），tint 只负责"透多少"。**禁止**为了在小画布上"更实"而调高 tint——那会让壁纸模式下胶囊变成一块没有质感的白板。

**P2｜一个选中态，全胶囊只有一种表达。**
工具选中（选择/平移）、菜单 active（样式▾）、菜单项 active 一律 `bg-accent + text-on-accent`。不做"分段控件底 + 图标换色 + 左侧竖条"三套并行语言。仓里已有的 `canvas-switcher-row--active::before` 发光竖条按本条删除。

**P3｜结构靠节拍，不靠分隔线堆叠。**
40px 高的胶囊里每段都画线会退化成表格。默认用间距分组（组内 2px / 段间 8px），只在语义真正断裂的两处保留 1px×16px 竖发丝线——因为窄窗文字全部消失后，间距会退化成均匀的图标栅格，那时只有这两条线还能把"名字 / 工具 / 动作"三段读出来。

**P4｜层级只由 text-primary / secondary / muted 表达。**
胶囊内 13 个控件不允许用字号阶梯制造三层以上的视觉重量（12px 是主体，13px 只给画布名，10px 只给侧栏分组小标题）。禁用 `text-white`、禁用 `text-accent`（一律 `text-accent-text`）、色块上一律 `text-on-*`。

**P5｜浮动层不叠 backdrop-filter。**
胶囊与侧栏都在 `surface-glass--editor` 卡片内部。嵌套的 `backdrop-filter` 采样不到壁纸（`src/index.css:613` 的 `.note-tab-bar` 注释已写明这一点），却要为一个 40×1000 的条带花掉一整块合成缓冲。磨砂的"可见度 ≈ 1 − tint"用 tint 表达：胶囊 95%，侧栏 96%，不再加 blur。**本轮必须删掉 `.canvas-switcher-panel` 现存的 `backdrop-filter: blur(16px) saturate(1.12)`**（它是硬规则里唯一被违反处，见附录 C）。

### 反模式清单（写了就返工）

| 反模式 | 原因 |
|---|---|
| 给 `.canvas-pill` / `.canvas-switcher-panel` 加 `backdrop-filter` 或 `surface-glass` 类 | 嵌套滤镜采样不到壁纸；且会把 fixed 子元素变成 containing block |
| 用 `translateX(-50%)` 做胶囊水平居中 | 半像素位移让 12px 中文发虚；用 flex 居中或 `margin-inline: auto` |
| flex 居中的 layer 忘写 `align-items: flex-start` | 层是 `height: 0`，默认 `stretch` 会把胶囊压成 0 高 |
| 把胶囊当 `@container` 本身 | 见 §4.3 的"容器查询塌陷"，这是本轮最容易翻车的点 |
| 给 `.canvas-pill-layer` 写 `width: fit-content` | 容器宽度会等于胶囊宽度，断点立刻失去意义 |
| 删掉 `h-11` 工具栏后把 `section` 改成 `relative` / 加 `justify-*` | 舞台的 `overflow: hidden` 是画布不溢出的唯一保障；`flex-1` 已经铺满，见 §1.2 的"高度账" |
| 文本编辑时让胶囊下移让位 | 会 12→68px 跳一次，且两条工具条视觉重量打架；正确做法是胶囊淡出，见 §1.6 |
| 断点用 `display: none` 藏标签 | 不可过渡，窗口拖动时文字瞬间消失；必须 `max-width + opacity` |
| 给胶囊加通栏 `border-b` | 破坏"顶栏 h-9 + 单一 border-b"的壳层规则 |
| 选中行用 `bg-accent/15 + text-accent-text` | 实测 4.12（blue）/ 4.16（dark），低于 4.5，见 §3.5 |
| 侧栏 hover 态用 `text-danger` 上红字 | yellow 2.26 / green 2.32，图标对比不足 3:1 |
| 新增 `isolation: isolate` | `.app-root` 持唯一 stacking context |
| 写裸 `duration-200` / `duration-300` / `cubic-bezier(...)` | 一律 `--dur-*` / `--ease-*` |

---

## 1. 布局规格

### 1.1 参照系

画布视图挂在 `main.shell-box.surface-glass.surface-glass--editor`（圆角 `--box-radius: 10px`，`overflow: hidden`）里。结构：

```
section.canvas-surface  (flex-col, bg-bg-primary)
├─ 旧 .canvas-toolbar   ← 删除，不再占布局高度
└─ div.app-work-area-overlay (relative, flex-1, overflow-hidden)  ← 画布舞台
   ├─ [新] div.canvas-pill-layer  (absolute, top:12, inset-inline:12, h:0)
   │    └─ div.canvas-pill
   ├─ svg 画布
   ├─ 文本编辑条 (absolute top-0 z-50)
   ├─ 小地图 (absolute bottom-4 right-4 z-20)
   └─ div.canvas-rail-layer (absolute, 右侧, z-30)
        └─ div.canvas-switcher-panel
```

**画布舞台在 `canvas-surface` 里仍然是 `flex-1`，但胶囊不再占一行高度**——画布内容从卡片顶端开始。这是"脱离顶边、浮在画布上方"的物理含义：省下的 44px 归画布（原来 `h-11` + `border-b`）。

### 1.2 胶囊

| 项 | 值 | 说明 |
|---|---|---|
| 高度 | `40px`（`--canvas-pill-h: 2.5rem`） | = 6px 上下内边距 + 28px 控件；比壳层顶栏 36px 高一档，读作"浮在内容的层"，但不能到 44px（会压过壳层顶栏） |
| 距画布顶边 | `12px`（`--canvas-pill-inset: 0.75rem`） | 2×6px，落在既有 6px 节奏上 |
| 左右留边 | `12px` | 即 `inset-inline: 12px`，宽窗口下也保持不变 |
| 宽度 | `width: max-content; max-width: 100%` | 内容自适应。**不给固定宽度、不给 flex-1**：13 个控件在五套 locale 下宽度不同，胶囊必须自己收缩到内容 |
| 水平居中 | 层 `display: flex; justify-content: center; align-items: flex-start`（或等价地给胶囊 `margin-inline: auto`） | **禁止** `left:50% + translateX(-50%)`（半像素位移让 12px 中文发虚）。**用 flex 居中时 `align-items: flex-start` 是必须的**：层的 `height: 0`（见 §4.3），默认 `align-items: stretch` 会把胶囊压成 0 高 |
| 圆角 | `10px`（`--canvas-pill-radius: 0.625rem`） | 与卡片 `--box-radius: 10px` 同值，浮层与承载它的卡片说同一种圆角语言 |
| 层级 | `z-index: 40` | 见 §1.3 的层序表 |
| 是否避让侧栏 | **水平不避让，垂直避让** | 胶囊在顶部居中、侧栏在右缘垂直居中，几何上不会撞（见 1.5）。侧栏改为在"胶囊以下"的带内居中，因此不需要给胶囊留右内边距 |
| 点击穿透 | layer `pointer-events: none`，胶囊 `pointer-events: auto` | 胶囊两侧的 12px 留边必须让画布能接笔，否则用户在小画布上画不到最上沿 60px |

胶囊内部三段：

```
[ A 身份 ] 8px ‖ 1px×16 发丝线 ‖ 8px  [ B 工具 ] 8px ‖ 1px×16 发丝线 ‖ 8px  [ C 动作 ]
```

- **A（左）**：`ImagePlus 16px (text-accent-text)` + 6px + 画布名 + 6px + **保存状态**（常态 12px `Check`，无文字，见 §2.1 / §7.7）。名字上限沿用 `15rem`（`--canvas-toolbar-title-label` 现有值，**不要改**：五个容器查询阈值是在满长标题下实测的，动它会让整条阶梯同时失效）。`truncate`。A 段内部一律用 6px（簇间距），**不用** 8px 段间距。
- **B（中）**：选择/平移（2px 间距的一组）+ 6px + 插入▾ 绘制▾ 排列▾ 样式▾。
- **C（右）**：撤销/重做 + 6px + 视图▾/缩放读数 + 6px + 开小窗 + 导出（保存状态已移出 C 段，见 §7.7）。
- **spacer 处理：删除 `flex-1`。** 胶囊宽度 = 内容宽度，spacer 的"把右侧推走"职责由"三段 + 8px 段间距"承担。留一个空的 `flex-1` 会让 `max-content` 计算依赖父宽，胶囊在窄窗下退化成 `100%`（失去胶囊形态）。

**脱离文档流后的高度账（不要留空白带）**

`section.canvas-surface` 保持 `flex flex-col`，但**不再有工具栏这个 flex 子项**：

```
section.canvas-surface (flex flex-col)          ← 不加 relative、不加 justify-*
└─ div.app-work-area-overlay (flex-1 min-h-0 relative overflow-hidden)
   └─ svg (h-full w-full)                       ← 高度 = 卡片高度，不再被 h-11 顶掉 44px
```

- 唯一子项 `.app-work-area-overlay` 仍是 `flex-1 min-h-0`，因此 SVG 铺满整个 section 高度；**删掉 `h-11` 那一行后不会出现空白带**，也不需要把 section 改成 `relative`。
- 胶囊的绝对定位上下文放在 `.app-work-area-overlay`（`relative` 已有），**不要**上移到 section：舞台的 `overflow: hidden` 是画布内容不溢出卡片的唯一保障。
- 回归判据：把窗口拖到 480×400，画布空白处（无内容）的像素颜色从卡片顶端第一行起就是 `--color-bg-primary`，中间不存在一条 44px 的 `bg-bg-secondary` 带。

### 1.3 层序

| z | 元素 | 备注 |
|---|---|---|
| 20 | 小地图（`bottom-4 right-4`，220px 宽） | 只读面，最低 |
| 30 | `.canvas-rail-layer`（侧栏，右缘带内居中） | 操作面，压住小地图是预期的 |
| 40 | `.canvas-pill-layer`（胶囊） | 常驻工具 |
| 40 → **45** | `CanvasRichTextEditor`（`CanvasView.tsx:2125`，现在 `z-40`） | 改成 **`z-[45]`**（Tailwind 没有 `z-45` 这个档）：与胶囊同级时靠 DOM 顺序决定胜负，太脆；编辑中的文本框必须无条件压住胶囊 |
| 50 | `CanvasTextToolbar`（文本格式条，`absolute inset-x-0 top-0`） | 高于一切舞台浮层 |

同一 z-index 下不允许再靠 DOM 顺序分胜负——本轮把编辑器提到 45 就是为了消掉这个隐式依赖。


### 1.4 侧栏（`canvas-switcher`）

外框不再是 `absolute right-0 top-1/2 -mt-[30px] -translate-y-1/2`，改为纵向带内居中：

```css
.canvas-rail-layer {
  position: absolute;
  z-index: 30;
  inset-inline-end: 0;
  top: calc(var(--canvas-pill-inset) + var(--canvas-pill-h) + 0.5rem); /* 60px */
  bottom: var(--canvas-pill-inset);                                     /* 12px */
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  pointer-events: none;
}
```

| 项 | 常驻态 | 展开态 |
|---|---|---|
| 宽度 | `44px`（`2.75rem`，现 `--canvas-rail-w`） | `248px`（`15.5rem`） |
| 高度 | 内容高 = 6 + 32(新建) + 0(小标题) + n×32 + (n−1)×2 + 28(footer) + 6；3 个画布 = **172px** | 同上 + 20(小标题) = **192px** |
| 最大高度 | `min(70vh, 480px, 100%)`，超出列表滚动 | 同 |
| 圆角 | `10px 0 0 10px` | 同 |
| 边框 | `1px`，仅左/上/下（`border-right: 0`），贴着卡片右缘 | 同 |
| 距画布右缘 | `0`（保持现状，不内缩） | 同 |
| 距胶囊下沿 | `8px`（由 `top: 60px` 保证） | 同 |
| 距舞台下沿 | `12px` | 同 |
| 层级 | `z-index: 30` | 同 |

**行节拍两态一致（32px），宽度过渡只改宽度。** 常驻/展开高度只差"分组小标题"的 20px，这一项用 `max-height: 0 → 1.25rem` 一起过渡，因此展开时不会出现纵向跳变。

> 行高从 28px 定为 **32px**（`--canvas-rail-row-h: 2rem`），与胶囊按钮的 `--canvas-ctl-h: 1.75rem` **解耦**——两者不是同一个概念（列表行 vs 工具按钮）。理由是误击代价不对称：切换画布会触发 `switchCanvas` 全量重载（`CanvasView.tsx:642-665`，落盘 + loadCanvasBoard + loadBoard，全程把每行 disabled），而点错工具只是换了个工具。28px 行 + 2px gap 只有 30px 垂直周期，触控板上容易选到邻行。详见 §7.9.4。

展开态内部纵向结构：

```
6px padding
  新建行        32px   h-8，底部 1px 发丝线
  分组小标题    20px   10px/600/uppercase，仅展开态
  列表行 × n    32px   gap 2px，mx-6px
  footer       28px   h-7，顶部 1px 发丝线
6px padding
```

列表区另需两条（§7.8）：`padding-inline-end: 2px` + **底部叠加渐变层** `.canvas-rail-fade`（高 24px、`pointer-events:none`、`linear-gradient(to top, bg-secondary 96% → transparent)`，仅 `canvases.length > 5` 时挂），因为 `border-right: 0` + `overflow: hidden` 会让滚动条贴在卡片右缘、且 overlay 滚动条不动时不可见，"还有更多"没有提示。**不要用 `mask-image`**：它会把正在滚出视口的那一行（含选中行 accent 底）一起淡掉，而提示恰恰在滚动时最需要。

> **叠加层的三个定位/条件细节（比"挂不挂"更容易错）**：
> 1. `bottom: 1.75rem`（= footer 高 28px），不是 `bottom: 0`——否则它会把 footer 的顶部发丝线和 footer 一起压灰。
> 2. 叠在列表容器上、`z-index` 高于行（行没有 z-index，所以 `position: absolute` 即可），`pointer-events: none` 保证滚轮与点击穿透。
> 3. `canvases.length > 5` 只是廉价的预判；**真正的条件是"列表下方确实还有内容"**（`scrollTop < scrollHeight − clientHeight − 1`）。滚到底时要把叠加层淡出（`opacity: 0`），否则最后一行会静止在渐变带里被洗白——这正是 `mask-image` 方案无解的那个问题，叠加层用一条"滚到底就淡出"的 `onScroll` 就能绕开。

### 1.5 胶囊 / 侧栏 / 小地图的碰撞

- **水平会重叠，垂直不会**：舞台 ≤ ~1100px 时胶囊几乎吃满（`max-width: 100%`）并盖到侧栏 44px 所在的列；但侧栏纵向带从 `top: 60px` 起（胶囊下沿 52px + 8px），二者永远不在同一水平带内，所以**不设水平避让、也不给胶囊留右内边距**。实现时不要把"水平相隔"当成前提去加 `padding-inline-end`，那会让胶囊在中等宽度下无端偏左。
- 展开的 248px 侧栏会盖住右下角 220px 小地图（`z-20`）。侧栏 `z-30` 压住小地图是正确的（侧栏是操作面，小地图是只读面），**不要**给小地图提层级。
- 舞台高 < 300px 时侧栏（内容上限 480px）靠 `max-height: 100%` 在带内收缩并在内部滚动；它始终从 `top: 60px` 起，**不会盖住胶囊**，不需要额外层级让步。

### 1.6 与文本编辑工具栏的互斥（顶部只有一个工具栏）

画布顶部的实际占用者有两个：胶囊（`top: 12px`，40px 高，居中）与 `CanvasTextToolbar`（`CanvasView.tsx:2009-2013`，`absolute inset-x-0 top-0 z-50 shadow-md`，`h-10` = 40px，通栏）。**结论：编辑文字时胶囊整体淡出，文本格式条独占顶部。**

```
canvasTextEditor != null →
  <div className="canvas-pill" inert>          ← React 19 布尔属性；用 undefined 而不是 false
  .canvas-pill--hidden { opacity: 0 }          ← 不再写 pointer-events: none（inert 已覆盖）
  transition: opacity var(--dur-fast) var(--ease-out)
```

**必须是 `inert`，不能只是 `opacity:0 + pointer-events:none`**（这一条按 §7.6 修订）：后者只做视觉透明 + 不接指针，**Tab 仍会停在 13 个看不见的按钮上**，屏幕阅读器仍会朗读全部 13 个控件，焦点环画在透明元素上等于焦点彻底消失（WCAG 2.4.7 + 2.4.3 双双失分）。`inert` 一次解决三件事：移出 Tab 序列、移出 a11y 树、屏蔽程序化 `focus()`。`inert` 立即生效、`opacity` 在 120ms 内淡出，两者不冲突——淡出期间按钮可见但不可点，正是想要的。进入编辑态时若焦点在胶囊内，先 `blur()` 再设 `inert`（`inert` 元素内部持焦点时各引擎行为不一致）；退出编辑态**不抢回焦点**（焦点应回到文本编辑器）。

为什么选"胶囊让位"而不是另外两条路：

| 方案 | 判断 |
|---|---|
| **胶囊淡出 + 文本条独占顶部**（采用） | 40px 对 40px，同一块高度只换内容，用户不会觉得顶部"长出一条新的东西"；文字编辑是局部模式，此时不需要选题/插入/导出 |
| 文本条改用胶囊形、与胶囊并排 | ✗ 文本条有字号/加粗/颜色/对齐/完成 7–9 个控件，塞进居中胶囊后宽度超过画布中线两侧的可用空间，窄窗必然溢出；而且两个同形态的胶囊并排会让人分不清哪个是"当前模式" |
| 文本条改为就近浮在文本框下方 | ✗ 文本框可以贴在画布任意位置：放在视口底部时"下方"没有空间，只能翻到上方，翻转规则又要处理旋转文本；且 ProseMirror 的选区每次变化都要重算浮层坐标，等于给一个已经有性能注释的组件再加一条每帧 reflow 的路径 |
| 胶囊下移到文本条之下 | ✗ 12→68px 会跳一次；两条工具条纵向叠放时视觉重量打架，画布可用高度又被吃掉 40px |

配套细节：

1. **文本条保持通栏**（`inset-x-0`，`border-b`）不改形态——它是临时格式条，通栏是对的；此时胶囊没有 `border-b`，所以顶部仍然只有一条通栏线，不违反"单一 border-b"的壳层规则。
2. 隐藏用 `opacity` 而不是 `display: none`：胶囊有 transition，且 `display` 切换会让 `canvas-pill-layer` 的容器查询被迫重算一次布局。
3. 编辑器块（`CanvasRichTextEditor`）本轮从 `z-40` 提到 `z-45`（见 §1.3），保证编辑中的文本框无条件压住胶囊；文本条继续 `z-50`。
4. 退出编辑（`finishEditingText`）→ 去掉 `.canvas-pill--hidden`，胶囊在同一帧内淡入 `--dur-fast`，**不做位移动画**（它不是"回来"，它一直在那儿）。

---

## 2. 分组与控件规格

### 2.1 控件表

图标 15px，`strokeWidth` 保持 lucide 默认（2）；命中区 = 视觉尺寸（不做负边距扩张，28px 已满足桌面指针）。"窄窗隐藏"指按 §4 的阶梯逐级降级。

| # | 控件 | 视觉分组 | 图标 | 命中区 | 宽屏有文字 | 窄窗降级顺序 | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | 画布名（+ImagePlus） | A 身份 | 16px | 非交互 | 是（≤15rem 截断） | 第 4 位隐藏标签，图标保留 | 低 |
| 2 | 选择 | B1 指针 | 15px | 28×28 | 否 | 不隐藏 | 高 |
| 3 | 平移 | B1 指针 | 15px | 28×28 | 否 | 不隐藏 | 高 |
| 4 | 插入▾ | B2 内容 | 15px | 28×(自适应) | 是 | 第 2 位隐藏文字 | 高 |
| 5 | 绘制▾ | B2 内容 | 15px | 同上 | 是 | 第 2 位 | 高 |
| 6 | 排列▾ | B2 内容 | 15px | 同上 | 是 | 第 2 位 | 中 |
| 7 | 样式▾（条件渲染） | B2 内容 | 15px | 同上 | 是 | 第 2 位 | 中 |
| 8 | 撤销 | C1 历史 | 15px | 28×28 | 否 | 不隐藏 | 高 |
| 9 | 重做 | C1 历史 | 15px | 28×28 | 否 | 不隐藏 | 高 |
| 10 | 视图▾ | C2 视口 | 15px | 28×自适应 | 是 | 第 2 位 | 中 |
| 11 | 缩放读数 | C2 视口 | 无 | 40×28（`min-w-10`） | 是（数字） | 第 5 位隐藏 | 低 |
| 12 | 保存状态 | **A 身份**（名字右侧，6px） | `Check` 12px / `Loader2` 12px | 非交互 | **否**（常态只有图标，文字进 `title` + `sr-only`） | 永不隐藏 | 低 |
| 13 | 开小窗 | C3 出口 | 15px | 28×自适应 | 是 | 第 5 位：整簇折叠进 `⋯` | 低 |
| 14 | 导出 | C3 出口 | 15px | 28×自适应 | 是 | 第 5 位：整簇折叠进 `⋯` | 中 |

> 表内 13 项 = #2–#14。#12 保存状态是**非交互的状态指示**，重制后随 A 段走、不占 C 段宽度；#13/#14 是真正的动作。DOM 顺序按本表重排：`视图▾` 从"样式之后"移到 `撤销/重做` 之后，与缩放读数相邻（它们是同一个概念：怎么看这块画布）；保存状态从 C3 移到 A 段名字之后（§7.7）。
>
> **#13 / #14 在窄窗不再"整簇退出"**：全仓核实它们各自只有一个入口（`CanvasView.tsx:1999-2002` / `2003-2006`，`shortcutReference.ts:22-42` 的画布分组只有 Ctrl+Z/Y，`src-tauri` 无 canvas 菜单项，`App.tsx:1030` 的 `handleExportNote` 是笔记导出）。**≤426px** 时折进 `⋯` 溢出菜单，**功能一个都不能丢**（§4.2 / §8.5）。

> 表内 13 项 = #2–#14（#1 是身份区，不是控件）。

### 2.2 组间分隔：**间距为主 + 两处结构发丝线**

三选一的答案是"间距"，但只对组内与子簇成立：

| 层级 | 间距 | 实现 |
|---|---|---|
| 组内同簇控件 | `2px` | `gap-0.5` |
| 簇间（B1↔B2、C1↔C2↔C3） | `6px` | 子簇之间 `gap-1.5` |
| 段间（A↔B、B↔C） | `8px + 1px + 8px` | 段容器之间 `gap-2`，中间放 `.canvas-seg-rule` |
| 胶囊内边距 | `6px` | `px-1.5`，`padding-block` 由 `h-10` 与子项 28px 撑出 |

理由（写进注释里的一句话）：*宽屏有文字时 8px 间距足够分组；文字消失后间距退化成均匀的图标栅格，三段结构只剩两条 1px×16px 竖线可读——所以线不是装饰，是窄窗下唯一的结构标记。* 这也是"只保留两条而不是五条"的原因：五条会变成表格。

### 2.3 互斥工具（选择/平移）的选中形态：**单按钮填充**

选中项 = `bg-accent text-on-accent`，未选中 = 透明 + `text-text-secondary`。**不做外层 track 的分段控件底**：

1. 胶囊内高 28px，塞一层 track 再塞一层 24px 按钮，命中区掉到 24px，且两层圆角（7px 内 4px）在 40px 高的胶囊里显得局促；
2. 全仓已经有一致的选中语言（菜单 active、工具栏 active 都是 accent 填充），再引入 track 会出现"胶囊里套胶囊"的第三套形态；
3. 两枚图标按钮紧邻（gap 2px）本身已经读作一组，不需要 track 声明分组。

### 2.4 控件视觉规范

所有控件共用基类（替换现有 `CanvasView.tsx:336` 的 `toolbarButton`）：

```
h-7 min-w-7 shrink-0 inline-flex items-center justify-center gap-1
rounded-[7px] px-1.5 text-xs whitespace-nowrap
transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]
```

| 状态 | 类 | 备注 |
|---|---|---|
| 默认 | `text-text-secondary` | 12px / 500 |
| hover | `hover:bg-bg-hover hover:text-text-primary` | 底色是 `--color-bg-hover` |
| 菜单展开 | `bg-bg-hover text-text-primary` | 与 hover 同色，靠 `aria-expanded` 区分语义 |
| 工具选中 / 菜单 active | `bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent` | 全局唯一选中语言 |
| disabled | `disabled:opacity-40 disabled:cursor-not-allowed` | 不加额外灰阶，避免与 muted 打架 |
| focus-visible | 见 §3.6 | 用 `text` 不是 `accent` 做环色 |

菜单触发器（`CanvasToolbarMenu`）额外结构：`icon(15) + gap-1 + label(12px) + gap-0.5 + ChevronDown(12)`；窄窗时 label 与 chevron 一起折叠（两个字形挤在 28px 里会读成两个按钮）。

侧栏行规格：

| 元素 | 值 |
|---|---|
| 行高 | **`32px`**（`--canvas-rail-row-h: 2rem`，与胶囊按钮 28px 解耦，理由见 §1.4），`gap 2px`，`mx-1.5`（6px），`rounded-md`（6px） |
| 行首槽位 | **monogram 文字槽**：固定 `2rem`（32px）宽、`shrink-0`、`text-center`，内容 = 画布名缩写（CJK 取 1 字符 / 非 CJK 取 2 字符），12px / 600，**不加任何底色方块**；未选中 `text-text-secondary`，选中 `text-on-accent` |
| 行名 | 12px / 500，`truncate`；折叠时 `max-width: 0 + opacity: 0` **收内层 span，不收按钮本身**（§7.3） |
| 行 hover | `bg-bg-hover text-text-primary`；**不做 `translateX(-2px)`**（现 `index.css:1250`，苹果列表不位移） |
| 行选中 | **整行 `bg-accent` + `text-on-accent`**，monogram 同时 `text-on-accent`；另补 `aria-current="true"`——"当前画布"不能只靠底色（色弱 / 高对比模式下会丢） |
| 行内操作 | 重命名 14px / 删除 14px，`opacity-0 → 100`（`hover` 或 `focus-within`），`28×28` 命中区；**`tabIndex={-1}`**，键盘路径走 `F2` / `Delete`（否则 20 个画布 = 61 个 Tab 停留点） |
| 新建行 | `h-8`（32px），`Plus 15px text-accent-text` + 12px/500 标签，底部 1px 发丝线；0 个画布时标签换成"新建第一个画布" |
| 分组小标题 | `h-5`（20px），10px/600/uppercase/`tracking-[0.08em]`/`text-text-muted`，`px-2` |
| footer | `h-7`（28px），`PanelRight 14px`，展开时 `rotate-180`；补 `aria-controls`（它是 disclosure 按钮，不加 `aria-haspopup`） |

> **为什么是 monogram 而不是 6px 圆点**（按 §7.1 修订，我原稿写的是圆点）：一列等距 6px 圆点在 mac 语汇里读作 page control / 状态灯，不读作"可展开的条目"；而现有 `1 2 3` 序号方块（`CanvasView.tsx:2332`）至少还回答了"这里有 n 个有序的东西"，换成圆点是可发现性**净下降**。monogram 还顺手补了我原稿没解决的一个洞：≤545px 时胶囊把画布名收起（§4.2 ③），此刻全应用**没有任何地方显示当前画布名**，monogram + 整行 accent 一并回答"我在哪个画布"。零宽度成本（44 − 12 = 32px 行宽，12px 字号下 CJK 单字 12px、Latin 2 字符约 13px）。**不做缩略色块**：`CanvasDocument` 只有 `id / name / createdAt / updatedAt`（`types/canvas.ts:134-139`），要出图得对每个画布 `loadCanvasBoard`，20 个画布 = 20 次 IO。
>
> **已知取舍**：两个字同首字的画布（"项目 A"/"项目 B" → 都是"项"）在常驻态无法区分，靠 `title` + 展开态的文字承担。不要为此把缩写扩到 2 个 CJK 字符——32px 槽位会挤到边界。

**行为连带改动（必须一起做，否则删掉序号方块后"切换画布"就没有触发器了）：**

| 交互 | 旧 | 新 |
|---|---|---|
| 点击行（**常驻态**） | 点序号方块 = 切换 | **点击 = 展开列表**（不移出 44px 就能看到名字，且展开可逆） |
| 点击行（**展开态**） | 点序号方块 = 切换 | **整行点击 = 切换画布** |
| 重命名 | 点行名文字 | 行内 hover 出现的 `Pencil` 按钮（键盘：行聚焦后 `F2`） |
| 删除 | 行内出现的 Trash | 行内 hover 出现的 `Trash2` → **行内二次点击**：两个操作钮就地换成 `✓ / ✕`，**不渲染确认句**（`✓` 用 `bg-danger text-on-danger`，`✕` 中性）；完整问句只进 `✓` 的 `aria-label` |

> 常驻态"点击 = 展开"是按 §7.2 修订的：折叠态行内只有一个没有标签的标记，让这样的目标执行**不可逆**的跳转是防错失分；而"展开"本来就需要一个比 footer 更近的入口。为让模式差异对辅助技术可见，`aria-label` 随状态切换（折叠态 `"展开画布列表（当前：{name}）"`、展开态 `"切换到 {name}"`），`title` 同步。
>
> 删除的确认形态也改了（§7.4）：248px 面板的行内宽只有 235px，现有确认行给名字留下的空间约 130px，中文问句 `确定删除"{name}"吗？` 光模板就 88px，**名字只剩 42px ≈ 3.8 个中文字**——用户看到的是 `确定删除"设计…"吗？`，一个连宾语都说不清的确认。去掉句子、保留名字，可见名字反而涨到 141px ≈ 11.7 个中文字。**不用弹层确认**（列表内的破坏性操作，macOS 用行内确认或 Cmd+Delete，不用 sheet）。

---

## 3. 颜色与材质

### 3.1 新增变量（写入 `:root`，与 `--shell-pad` 同段）

```css
:root {
  /* 画布浮层几何：全部走 6px 节奏 */
  --canvas-pill-h: 2.5rem;         /* 40px */
  --canvas-pill-inset: 0.75rem;    /* 12px */
  --canvas-pill-radius: 0.625rem;  /* 10px = --box-radius */
  --canvas-ctl-h: 1.75rem;         /* 28px */
  --canvas-ctl-radius: 0.4375rem;  /* 7px */
  --canvas-gap-in: 0.125rem;       /* 2px  组内 */
  --canvas-gap-cluster: 0.375rem;  /* 6px  簇间 */
  --canvas-gap-seg: 0.5rem;        /* 8px  段间 */
  --canvas-rail-w: 2.75rem;        /* 44px */
  --canvas-rail-w-open: 15.5rem;   /* 248px */
  --canvas-rail-row-h: 2rem;       /* 32px：列表行，与 --canvas-ctl-h 解耦 */
  --canvas-rail-mark-w: 2rem;      /* 32px：monogram 槽位 */
}
```

### 3.2 胶囊（`.canvas-pill`）

```css
.canvas-pill {
  --pill-fill: color-mix(in srgb, var(--color-bg-secondary) 95%, transparent);
  --pill-divider: color-mix(in srgb, var(--color-border) 62%, var(--color-text-muted) 38%);
  position: relative;
  display: flex;
  align-items: center;
  width: max-content;
  max-width: 100%;
  height: var(--canvas-pill-h);
  margin-inline: auto;
  gap: var(--canvas-gap-seg);
  padding-inline: 0.375rem;
  border-radius: var(--canvas-pill-radius);
  border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent);
  background-color: var(--pill-fill);
  box-shadow:
    0 1px 1px color-mix(in srgb, #000 10%, transparent),
    0 6px 18px -12px color-mix(in srgb, #000 55%, transparent);
  pointer-events: auto;
}
```

### 3.3 逐态 token 表

| 态 | 属性 = 取值 |
|---|---|
| 胶囊底 | `background-color: color-mix(in srgb, var(--color-bg-secondary) 95%, transparent)` |
| 胶囊边框 | `border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent)` |
| 投影（浅色主题） | `0 1px 1px color-mix(in srgb,#000 10%,transparent), 0 6px 18px -12px color-mix(in srgb,#000 55%,transparent)` |
| 投影（`.theme-dark` 覆盖） | `inset 0 1px 0 color-mix(in srgb,#fff 5%,transparent), 0 8px 20px -14px #000` |
| 竖发丝线 | `background-color: var(--pill-divider)`，`1×16px` |
| 控件默认 | `color: var(--color-text-secondary)` |
| 控件 hover | `background-color: var(--color-bg-hover); color: var(--color-text-primary)` |
| 控件 选中/active | `background-color: var(--color-accent); color: var(--color-on-accent)`；hover 时 `var(--color-accent-hover)` |
| 控件 菜单展开 | `background-color: var(--color-bg-hover); color: var(--color-text-primary)` |
| 控件 disabled | `opacity: .4`（不动色值） |
| 保存状态（A 段，图标） | 常态 `Check` 12px `color: var(--color-text-muted)`；saving 时 `Loader2` 12px `animate-spin` **`color: var(--color-text-secondary)`**、等宽替换（0 布局位移）。两态**必须不同色**——同色会让"正在保存"与"已保存"在视觉上无法区分，而这 12px 图标的全部价值就是状态变化（secondary 实测 6.20–7.37）。必须带 `role="status" aria-live="polite" aria-atomic="true"`，文字只进 `sr-only` |
| 缩放读数 | `color: var(--color-text-secondary)`，12px `tabular-nums` |
| 画布名 | `color: var(--color-text-primary)`，13px/600；左侧 `ImagePlus` 用 `var(--color-accent-text)` |
| 胶囊隐藏（文字编辑中） | `opacity: 0`（+ `inert`，见 §1.6） |

> **保存指示为什么不用 `text-success`**（这是我对 §7.7 唯一的一处修订）：`Check` 落在胶囊底上，`--color-success` 的实测对比是 blue **1.86** / yellow **1.92** / green **2.08**，只有 dark 达标（7.62）——低于 WCAG 1.4.11 非文字 3:1，浅色主题下这个勾几乎是看不见的（它是"保存好了"的唯一视觉证据，不能靠对比度赌）。改用 `text-text-muted`：5.04 / 4.66 / 5.09 / 5.11，四套主题全过。附带好处是它不再读作"任务完成"的绿色对勾，而是中性的状态字形——这正好呼应 §7.7 想避免的误读。
>
> `aria-live` **只播报 saving**（常态不渲染文字 → 不会在每次自动保存后播报"已保存"），否则自动保存每 650ms 一次会变成播报风暴。

### 3.4 在五套主题下的实际观感风险（实测数据）

胶囊底 = `bg-secondary` 95% 叠在 `bg-primary` 上，实测合成值（四套主题；`@theme` 默认值即 light，与 `.theme-blue` 同值，仓里没有独立的 `.theme-light`，所以"浅色"一栏就是 blue）：

| 主题 | 合成底 | 底 vs 画布 | 边框 vs 底 | 竖线 vs 底 | text-secondary | text-muted | accent-text |
|---|---|---|---|---|---|---|---|
| blue（默认 light） | `#e3e9f0` | **1.11** | 1.21 | 2.72 | 6.20 | 5.04 | 5.00 |
| dark | `#24252a` | **1.13** | 1.34 | 2.99 | 7.37 | **4.66** | 5.03 |
| yellow | `#f2ecdd` | **1.09** | 1.24 | 2.76 | 6.04 | 5.09 | 5.09 |
| green | `#e9f2ec` | **1.08** | 1.19 | 2.71 | 6.16 | 5.11 | 5.13 |

结论与风险：

- **底与画布的对比只有 1.08–1.13，等于不可见。** 胶囊的"存在"100% 由投影 + 边框承担（P1）。任何一个主题下如果投影被 `shadow-none` 掉、或被父级 `overflow: hidden` 裁掉，胶囊就消失了——这是验收时要单独看的一条。
- **yellow / green 下方向反了**：`bg-secondary` 比画布**深** 1.09，胶囊读作"贴进去的浅色板"。这在苹果的浅色界面里是对的（Freeform 的浮条就是比纸面灰一档），但必须靠投影把它抬起来，否则像画布上的一块补丁。**不允许**的解法：把 `--pill-fill` 换成 `bg-primary`（与画布同色 → 彻底消失）或调高到不透明 + 加深（会变成"实心工具条"，丢掉浮层语义）。
- **dark 下 `text-muted` 只有 4.66**（勉强过 AA 4.5）。它是保存指示图标的颜色（§3.3 修订后不用 `text-success`），12px 图形按 3:1 判定仍有余量，**但不要再用 muted 承载 12px 文字**——真要加回文字就换 `text-secondary`（7.37）。
- **dark 的投影必须换配方**：黑色阴影在 `#1a1b1e` 上看不见（`.shell-box` 的注释已写明同一结论），改用 `inset 0 1px 0 #fff/5%` 的顶缘 + `#000` 深影，让"上亮下暗"读出厚度。
- **accent 当填充时全部合格**（`on-accent` vs `accent`：blue 5.17 / dark 5.41 / yellow 6.44 / green 5.66），但 **accent 当线条/文字时在 yellow 只有 2.07、green 2.54**。所以：焦点环不能用 `--color-accent`（见 §3.6），侧栏不能用 accent 画边或发光。

### 3.5 侧栏（`.canvas-switcher-panel`）· 磨砂定案

现状 `.canvas-switcher-panel`（`index.css:1130-1135`）直接写了 `backdrop-filter: blur(16px) saturate(1.12)`，绕开 `.surface-glass::before` 这唯一磨砂层。**定案：收敛——删掉这处滤镜，改由 tint 表达"透多少"，且不给面板套 `.surface-glass`。** 不做二选一之外的第三条"豁免"。

**先算清一件事：把它搬进 `.surface-glass` 技术上可行，但代价很具体。**

`.surface-glass::before` 用 `z-index: -1`，要让它画在面板内容之下、面板背景之上，面板必须处在一个 stacking context 里。`.canvas-switcher` 现在恰好有 `isolation: isolate`（`index.css:1119`），所以直接加 `surface-glass` 类**是能出效果的**：`::before` 会落在 `.canvas-switcher` 这个隔离上下文里，压住卡片自己的玻璃层、被面板内容压住。也就是说这不是"做不到"，而是"要不要付这个价"：

| 代价 | 说明 |
|---|---|
| 保留第二个 `isolation: isolate` | 直接违反"`.app-root` 持唯一 stacking context"；这条规则的存在理由是固定定位的浮层要靠它锚到视口，一旦多一个隔离上下文，面板内任何 `position: fixed` 的将来实现都会静默失效 |
| 一套面板级 tint 变量 | `--glass-panel` / `--glass-tint-here` 是为 88/92/60 这种大面板标定的；给 44px 宽的浮条再开一套（92? 84?）等于承认"tint 阶梯要重排"，而这个决定不属于画布视图 |
| 一笔纯成本的合成缓冲 | 只有 44×172 到 248×480 的面积，却要在每次展开/收起的 width 动画期间逐帧重建 |

**决定性的量化理由：在这个尺寸上，模糊本来就看不见。** 按仓里自己的判据「模糊可见度 ≈ 1 − tint」，tint 96% 时可见度是 4%——`blur(16px)` 对 4% 的透出来说等于零，却要花掉上面三项代价。这正是 `.note-tab-bar`（`index.css:613`）注释里已经写过的结论："嵌套的 backdrop-filter 采样不到壁纸，只会烧掉一整块合成缓冲"。**画布浮层与 tab 条处于同一个处境**（都在 `surface-glass--editor` 卡片内部）。

所以：

1. 面板只留 `background-color: color-mix(in srgb, var(--color-bg-secondary) 96%, transparent)`；不加 `surface-glass` 类、不加 `::before` 磨砂层、不加 `isolation`。
2. `.canvas-switcher` 现有的 `isolation: isolate` **删掉**（删掉滤镜后它不再有用例）。
3. 若将来设计要让侧栏真的"透"（tint ≤ 85），正确的动作是**先**把这条浮条提升为 `.surface-glass` 成员、并把 `isolation` 的唯一性规则重新裁决一次（写进 `decisions-glass-layering.md`），而不是在这里就地加回去。当前版本不做。

```css
.canvas-switcher-panel {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  width: var(--canvas-rail-w);
  max-height: 100%;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-border) 82%, transparent);
  border-right: 0;
  border-radius: var(--canvas-pill-radius) 0 0 var(--canvas-pill-radius);
  background-color: color-mix(in srgb, var(--color-bg-secondary) 96%, transparent);
  box-shadow:
    0 1px 1px color-mix(in srgb, #000 9%, transparent),
    -10px 0 24px -16px color-mix(in srgb, #000 50%, transparent);
  transition: width var(--dur-slow) var(--ease-out);
}
.canvas-switcher-panel--open { width: var(--canvas-rail-w-open); }
.theme-dark .canvas-switcher-panel {
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent),
    -12px 0 26px -18px #000;
}
```

**必须删除的三处**（全部在 `src/index.css:1117-1298`）：

| 删除项 | 位置 | 理由 |
|---|---|---|
| `backdrop-filter: blur(16px) saturate(1.12)` | `.canvas-switcher-panel`（1135） | 见本节定案；它是"磨砂只落在 `.surface-glass::before`"的唯一现存违反 |
| `isolation: isolate` | `.canvas-switcher`（1119） | 滤镜删掉后无用例；`.app-root` 持唯一 |
| `::before` 的 accent 光斑（80×80 blur 22px） | `.canvas-switcher-panel::before`（1142-1155） | 一个 44px 宽的浮条上挂光斑，是"发光边条"的同族装饰；macOS 侧栏无此语汇 |
| `::after` 的 105° accent 渐变扫光 | `.canvas-switcher-new::after`（1175-1189） | 同上；且渐变在五主题下色相偏移不可控 |

**逐态 token：**

| 态 | 取值 |
|---|---|
| 面板底 | `bg-secondary 96%` |
| 面板边框 | `border 82%`，仅左/上/下 |
| 分割线（新建行下、footer 上） | `1px var(--pill-divider)` |
| 行 hover | `background-color: var(--color-bg-hover); color: var(--color-text-primary)` |
| 行选中 | `background-color: var(--color-accent); color: var(--color-on-accent)` |
| 未选中行文字 | `var(--color-text-secondary)` |
| 行首槽位 | monogram 文字槽 `2rem`：未选中 `var(--color-text-secondary)`，选中 `var(--color-on-accent)` |
| 行内操作默认 | `color: var(--color-text-muted)`，`opacity: 0` |
| 行内操作 hover | 底色 `color-mix(in srgb, var(--color-danger) 12%, transparent)`，图标 `color: var(--color-text-primary)` |
| 新建行标签 | `var(--color-text-secondary)`；`Plus` 图标 `var(--color-accent-text)` |
| 输入框 | 边框 `color-mix(in srgb, var(--color-accent) 55%, var(--color-border))`，底 `color-mix(in srgb, var(--color-bg-primary) 78%, transparent)`（现有值保留） |

**为什么选中行必须整行 `bg-accent`（实测依据）**：现有实现 `bg-accent/15 + text-accent-text` 的对比度是 **4.12（blue）/ 4.16（dark）**，低于小字 4.5；整行 accent 填充 + `on-accent` 是 **5.17–6.44**，全部达标。这不是审美偏好，是现方案不达标的修复。

**为什么行的 hover 操作不用 `text-danger`**：`--color-danger` 在 yellow 是 `#d98a7a`（对胶囊底 2.26）、green 是 `#d88a8a`（2.32），作为 14px 图标不足 3:1。危险色在这里只当**底色**（`danger/12`）用，图标前景回到 `text-text-primary`。

### 3.6 焦点环

全局规则是 `outline: 2px solid var(--color-accent); offset: 2px`（`index.css:1015`），canvas 内改成 `offset: -2px`。胶囊里要再改一次颜色：

```css
.canvas-pill :where(button, [role="menuitem"]):focus-visible,
.canvas-switcher-panel :where(button, input):focus-visible {
  outline: 2px solid var(--color-accent-text);
  outline-offset: -2px;
}
.canvas-pill button[aria-pressed="true"]:focus-visible {
  outline-color: var(--color-on-accent);
}
```

理由：`accent` 作为环色对胶囊底的对比只有 blue 4.23 / dark 4.16 / **yellow 2.07 / green 2.54**，低于非文字 3:1；`accent-text` 是 5.00–5.13，五套主题全过。选中的实心按钮上换 `on-accent`（5.17–6.44），因为环落在 accent 底上。

**前置条件（否则上面第二条规则是死代码）**：选择/平移两枚按钮（`CanvasView.tsx:1825 / 1828`）现在**没有 `aria-pressed`**，`[aria-pressed="true"]` 永远匹配不到。必须补 `aria-pressed={tool === "select"}` / `{tool === "pan"}`（`CanvasTextToolbar.tsx:39`、`CanvasTileView.tsx:173` 已有先例）。同批补齐：撤销/重做补显式 `aria-label`（现在只有 `title`，而 `title` 同时是 tooltip，改文案容易只改一处）；侧栏面板的 `role="region"` 上那个 `aria-expanded` 是非法用法（`CanvasView.tsx:2245-2247`），要删——`aria-expanded` 属于 footer 那个 disclosure 按钮。

---

## 4. 文字与断点

### 4.1 字号阶梯（胶囊 + 侧栏）

| 层 | 字号/行高 | 字重 | 用在哪 | 颜色 |
|---|---|---|---|---|
| T1 | 13px / 18px | 600 | 胶囊里的画布名 | `text-primary` |
| T2 | 12px / 16px | 500 | 控件标签、菜单项、侧栏行名、新建行 | `text-secondary` |
| T3 | 12px / 16px | 400 `tabular-nums` | 缩放读数、保存状态 | `text-secondary` / `text-muted` |
| T4 | 10px / 16px | 600 uppercase `tracking-[0.08em]` | 侧栏分组小标题 | `text-muted` |

层级差异靠 **字重 + 色阶**，不靠字号堆砌：T1 与 T2 只差 1px，真正的层级差来自 600/500 与 primary/secondary。禁止出现 11px、`text-[9px]` 之类的中间档（现 `text-[10px]` 的序号方块随方块一起删掉）。

### 4.2 断点阈值：重算（不能沿用）

现有五档（1050 / 920 / 855 / 620 / 500 / 426）是在**旧几何**下实测的：控件 32px、`gap-1`(4px)、`px-3`(24px)、无段间距。新几何改变了每一项：

| 项 | 旧 | 新 | 每个控件的收益 |
|---|---|---|---|
| 控件高/宽 | 32px | 28px | −4 × 13 = **−52px** |
| 控件间距 | 4px | 2px | −2 × ~14 = **−28px** |
| 行内边距 | 24px（`px-3`×2） | 12px（`px-1.5`×2） | **−12px** |
| 段间距 | 0 | 8×2 + 2×1px 竖线 | **+18px** |
| 合计 | | | **≈ −74px** |

同时"可用宽度"的定义是对齐的：旧容器是 `.canvas-toolbar` 的 **content box**（= 卡片宽 − 24），新容器 `.canvas-pill-layer` 是 `inset-inline: 12px`（= 舞台宽 − 24 = 卡片宽 − 24，因为胶囊不再占一行、舞台与卡片同宽）。所以新旧阈值可直接相减。

**①–③ 沿用「旧值 − 几何收益」；④–⑦ 由「触发时的内容宽」反推（见下）。七档（数值以 §8.5 为最终依据）：**

| 档 | 阈值（`.canvas-pill-layer` 的 inline-size） | 该档动作 | 依据 |
|---|---|---|---|
| ① | **≤ 950px** | `开小窗` / `导出` 的文字（保图标） | 1050 − 75 − 24 ≈ 950 |
| ② | **≤ 820px**（`en` 及无 `data-lang`）/ **≤ 755px**（`zh`） | 菜单标签 + chevron 隐藏；触发器收成 28px 方钮。**保存状态不再在此隐藏**（它已无文字） | 920 / 855 同减 |
| ③ | **≤ 545px** | 画布名文字（保 `ImagePlus` 图标）；身份交给侧栏 monogram（§2.4） | 620 − 75 |
| ④ | **≤ 470px** | 缩放读数 | 触发时内容 466（420 + 缩放读数 40 + 簇间 6）→ 仅 4px slack，**唯一必须实测的绝对值** |
| ⑤ | **≤ 426px** | C3（开小窗 + 导出）折进一个 `⋯` 溢出菜单；**C1 撤销/重做保留** | 触发时内容 420（390 + C3 58 − ⋯ 28） |
| ⑥ | **≤ 396px** | `视图▾` 并入同一个 `⋯` 菜单，C2 整段退出 | 触发时内容 390（356 + 视图 28 + 簇间 6） |
| ⑦ | **≤ 362px** | 兜底：胶囊 `overflow-x: auto; scrollbar-width: none`——不裁切、不丢控件 | 触发时内容 356（§8.5.2 逐项算式） |

**⑤⑥⑦ 的数值推导（对 §7.5 的订正，务必按这个来）**

§7.5 给的 350 / 310 / 285 是把「**折叠之后**的内容宽」当成了「**触发**阈值」，差了一档：

- 全标签收起、`⋯` 已就位后（A + B1 + B2 + C1 + `⋯` + padding + border）≈ **356px**；
- 但 ⑤ 触发时 C3 **还在**：内容 = 356 + 6（簇间）+ 58（两枚 28px）− 28（`⋯` 尚未出现）= **420px**；
- 若把 ⑤ 定在 350，则 **350–420px 是一段死区**：胶囊撞 `max-width: 100%`，尾部被 `overflow: hidden` 切掉半颗按钮——正是我们要消灭的画面；
- 所以触发阈值 = **该档触发时的内容宽 + 少量 slack**：⑤ **426**（内容 420）→ ⑥ **396**（内容 390）→ ⑦ **362**（内容 356）。
- **间隔 30 / 34 恰好等于 ⑤ / ⑥ 的折叠减少量（C3 58→28 省 30；视图 28+簇间 6 省 34），这是结构性的，与字体渲染无关，可以直接定死**；绝对值只依赖 28px 方格与 12px 状态图标，误差 ≤8px。④ 只能靠实测（见 §8.8）。

**A 段在 ③ 之后必须收敛到 34px**（`16 图标 + 6 + 12 状态`）：名字用 `display:none` 让两个 6px 间隙合成一个。**若沿用 `max-width:0`（保留两个间隙 = 40px），⑤⑥⑦ 的 slack 会从 6–8px 掉到 0–2px**——这是 §8.3 那条坑在阈值侧的同一处表现。团队口径按 A=28 算得 456 / 414 / 384 / 350（slack 12px）；钉死 A=34 后是 462 / 420 / 390 / 356（slack 6–8px）。**两种口径都不产生死区、都不裁切**，差额全部来自 A 段的折叠方式。

原则写死：**每一档的阈值 = 它触发时的内容宽（含 6–12px slack）；不许拿"折叠后的宽度"当阈值；档间间隔 = 该档的折叠减少量，与字体无关。**

- 语言分档保留，理由见现有注释（中文标签宽度约为英文的 2/3，用一套英文阈值会让中文界面早 65px 掉字）。实现方式不变：`:not([data-lang="zh"])` 走保守值，`[data-lang="zh"]` 走窄值。
- 这些数是**首版锚点，必须实测重校**：方法沿用现有注释里那套——把胶囊的 `scrollWidth` 与容器宽度逐个 10px 对照，找到实际碰撞点，再回退 **6–12px slack**。别用"把每项宽度加起来"的方式验算（旧注释已经否掉过这条路）。
- **⑤⑥ 绝不裁切也绝不丢功能**：`椭圆胶囊被切掉半个按钮` 会露出直角缺口，比少一段难看；而"整段退出"在本轮被否掉——开小窗与导出全仓各只有**一个**入口（§2.1 的取证），退掉等于在窄窗静默删功能。折叠用一个 `MoreHorizontal` 28px 触发器 + 复用 `CanvasToolbarMenu`（`aria-haspopup` / `aria-expanded` / `aria-controls` 已齐全，`align="end"`），菜单内容 = 视图 4 项 + 发丝线 + 开小窗 + 导出（保存状态不进菜单，它在 A 段）。
- **⑦ 的滚动有一个必踩的坑**：layer 是 `justify-content: center`，容器一旦可滚动，溢出部分**两侧都不可达**（居中内容在滚动容器里左边是负向溢出，滚不到）。该档必须把 layer 改成 `justify-content: flex-start`（或给胶囊 `margin-inline: 0`），并接受"尾部要滚"。
- `⋯` 换按钮这件事 CSS 做不到（要换 DOM），这一档必须在 TSX 里做：C3 渲染成 `.canvas-seg--output`（两项）+ `.canvas-seg--more`（一个 ⋯），用容器查询翻 `display`。**段级切换允许 `display: none`**——§4.4 禁它是为了文字渐隐的连续性，段级替换本来就是离散事件。

### 4.3 容器查询挂在**层**上，不挂在胶囊上

这是本轮最关键的实现约束：`.canvas-pill` 是 `width: max-content`，**如果它自己 `container-type: inline-size`，inline-size 包含会让它的宽度不再由内容决定（塌成 0 / 由外部指定）**——查询永远不触发，或者胶囊直接消失。所以容器搬到外层 wrapper，胶囊在里面当普通 block 按内容撑开：

```css
.canvas-pill-layer {
  position: absolute;
  z-index: 40;
  inset-inline: var(--canvas-pill-inset);   /* 宽 = 舞台宽 − 24px，与旧 content box 口径对齐 */
  top: var(--canvas-pill-inset);
  height: 0;                                 /* 不参与舞台高度；无 paint containment，胶囊照常溢出 */
  display: flex;
  justify-content: center;
  align-items: flex-start;                   /* 必须：height:0 + 默认 stretch 会把胶囊压成 0 高 */
  pointer-events: none;                      /* 两侧 12px 留边要能让画布接笔 */
  container-type: inline-size;
  container-name: canvas-pill;
}

.canvas-pill {
  width: max-content;
  max-width: 100%;
  height: var(--canvas-pill-h);
  pointer-events: auto;
  /* 材质与几何见 §3.2 */
}

@container canvas-pill (max-width: 950px) { .canvas-toolbar-action-label { … } }
```

**断点语义随之改变，这段要写进注释里：** 旧阈值的含义是"工具栏自己多宽"，新阈值的含义是"画布多宽"。两者数值口径一致（`inset-inline: 12px` 后的宽度 = 卡片宽 − 24px = 旧 `.canvas-toolbar` 的 content box），所以 §4.2 可以用"旧实测值 − 几何收益"直接换算；但**不能照抄 1050/920/855/620/500/426**，也不要在新容器上继续用 `.canvas-toolbar` 这个名字（`index.css:649` 的 `container-type` 必须从 `.canvas-toolbar` 上删掉，否则胶囊一旦被别处复用就会二次塌陷）。

`container-type: inline-size` 会带来 `contain: layout`（因此该层会成为自己的 stacking context 与 abs-pos 的 containing block）。它是一个空壳，不裁切内容；`z-index: 40` 写在这一层上，而不是胶囊上。

两条一起记住的实现约束：

- 这一层是 `display: flex` 的**行容器**，按仓里硬规则**不许写 `w-auto`**（会让子项的 `w-full` 静默退回 `max-content`）。宽度只由 `inset-inline` 决定。
- 居中不要用 `left:50% + translateX(-50%)`；也**不要**给这一层加 `width: fit-content`（那会把容器宽度等于胶囊宽度，查询立刻失去意义）。

### 4.4 渐隐的实现：`max-width + opacity`，不用 `display`

| 做法 | 判断 |
|---|---|
| `max-width: 0 → 100%` + `opacity: 0 → 1` + `overflow: hidden` + `white-space: nowrap` | ✅ **采用** |
| `display: none`（现状） | ❌ 不可过渡；拖动窗口时文字"啪"地消失，正是苹果界面里最不该出现的那一下 |
| 单纯的容器查询改 `display` | ❌ 同上，容器查询的切换是离散的 |
| `visibility` / `clip-path` | ❌ 前者不可平滑插值，后者需要改布局 |

实现要点：

1. 容器查询只负责**翻状态**（把 `max-width` 从 `100%` 改成 `0`、`opacity` 从 `1` 改成 `0`），过渡仍由 `transition` 完成，所以窗口拖动时会看到 12px 文字平滑收回，而不是闪断。
2. 触发器的 `padding-inline` 与 `gap` 必须一起过渡到 0，否则标签收完了按钮还留着 12px 的内边距（旧注释里"所有触发器收成同一个 32px 方钮"的意图保留，只是从 `display:none` 换成可过渡的写法）。
3. 过渡用 `transition: max-width var(--dur-base) var(--ease-out), opacity var(--dur-base) var(--ease-out), padding var(--dur-base) var(--ease-out)`。**不用 `--dur-slow`**：尺寸收缩超过 280ms 会跟不上窗口拖动的节奏。
4. chevron 与标签同组显隐（现规则已如此），不要单独留下 chevron 在 28px 方钮里。

---

## 5. 动效

只允许 `--dur-fast / --dur-base / --dur-slow` 与 `--ease-out / --ease-spring / --ease-in-out`。

| 动作 | 时长 | 曲线 | 属性 | 说明 |
|---|---|---|---|---|
| 控件 hover（底色/文字色） | `--dur-fast` | `--ease-out` | `background-color, color` | 回答一次指针，必须最快 |
| 工具选中切换 | `--dur-fast` | `--ease-out` | `background-color, color` | 不做滑动指示块（见 §2.3） |
| 菜单弹出 | `--dur-fast` | `--ease-spring` | `opacity, transform`（`scale(.98) translateY(-2px)` → `1`） | 弹入属于 entry/pop，spring 的过冲是既有注释指定的用途；`transform-origin` 按 `align` 设左上/右上 |
| 菜单收回 | `--dur-fast` | `--ease-out` | 同上 | 退场不用 spring（回弹会显得拖沓） |
| 标签渐隐/展开（断点切换） | `--dur-base` | `--ease-out` | `max-width, opacity, padding, gap` | 见 §4.4 第 3 条 |
| 侧栏展开/收起 | `--dur-slow` | `--ease-out` | `width` | **从 `--ease-spring` 改为 `--ease-out`**：248px 宽度的 5% 过冲 = 12px，而面板贴着卡片右缘 `overflow: hidden`，过冲会被裁掉一截再弹回，看起来像抖动。布局尺寸的移动不用会过冲的曲线（既有注释也是这么分工的） |
| 侧栏分组小标题显隐 | `--dur-slow` | `--ease-out` | `max-height, opacity` | 与宽度同曲线，避免两种节奏 |
| 侧栏行 hover | `--dur-fast` | `--ease-out` | `background-color, color` | |
| 行内操作浮现 | `--dur-fast` | `--ease-out` | `opacity` | 同时 `transform: scale(.86) → 1` 改用 `--dur-base` + `--ease-spring`（保留现有手感） |
| footer 箭头翻转 | `--dur-base` | `--ease-out` | `transform` | 现在是裸 `duration-300`，换变量 |
| 胶囊隐藏（进入文字编辑） | `--dur-fast` | `--ease-out` | `opacity` | |
| 胶囊入场 | **无** | — | — | 视图切换已有自己的过渡，不叠第二层动效 |
| 行入场错峰 | **删除** | — | — | 现 `animationDelay: index*35ms` + `canvas-switcher-row-in` 是"重制感"来源，苹果列表打开时不逐行飞入 |

`prefers-reduced-motion` 分支保留并扩到新类（`.canvas-pill`、`.canvas-rail-layer`、行内操作）：把所有 `transition-duration` 压到 1ms、`animation: none`。

---

## 6. 五主题自检清单

每条都能在浏览器里直接验证（DevTools 里切 `.theme-*` 类 + 目视/取色）。**五项全绿才算完成**；任一项红就回到对应小节。

### 6.1 结构（与主题无关，先过）

- [ ] 画布顶部**没有**第二条通栏水平分割线；画布内容从卡片顶端开始，原先 `h-11` 的那一行高度归还给画布。
- [ ] **没有残留空白带**：480×400 窗口下，画布空白区从卡片顶端第一行像素就是 `--color-bg-primary`，中间不存在一条 44px 的 `bg-bg-secondary` 带（`section` 仍是 `flex flex-col`，舞台 `flex-1` 铺满）。
- [ ] 胶囊高度 = 40px（DevTools 量 `.canvas-pill` 的 `height`，**不是 0**）：确认 layer 写了 `align-items: flex-start`，没有被 `stretch` 压扁。
- [ ] 胶囊水平居中偏差 ≤ 1px（放大到 400% 截图对齐卡片中线）；文字不发虚、无半像素模糊。
- [ ] 胶囊左右各 12px 的留边是**点击穿透**的：在画布最上沿拖拽能画出笔迹，不会被空壳挡住。
- [ ] 窗口从 1400px 拖到 420px：标签逐级平滑收起，无闪断、无跳位。
- [ ] **470 / 426 / 396 / 362 四档各验一次**（窗口拖到对应宽度后量 `.canvas-pill-layer` 的 `clientWidth`）：缩放读数消失、C3 变 `⋯`、`视图▾` 进 `⋯`、胶囊横向滚动——**任何一档都不出现被切掉半颗按钮**；`⋯` 菜单里能点到开小窗/导出（功能不丢）。
- [ ] ⑦ 档实测：`⋯` 在最左端可见（`justify-content: flex-start` 已生效），能向右滚到导出；居中遗留的写法会让左侧内容滚不到。
- [ ] 侧栏常驻 44px / 展开 248px；行高 32px；展开过程中**高度不跳变**（只有小标题那 20px 在动）。
- [ ] 侧栏纵向中心落在"胶囊下沿 → 舞台下沿"这一带的中心，不与胶囊重叠。
- [ ] **常驻态能看出是"哪个画布"**：44px 条里当前项整行 accent + monogram 反白；折叠态点行**展开**（不切换），展开态点行**切换**。
- [ ] 删除二次确认：两个操作钮就地换成 `✓/✕`，**行内没有确认句**，名字完整可见（约 11 个中文字）；`✓` 的 `aria-label` 是完整问句。
- [ ] 进入文字编辑：胶囊 `opacity: 0` **且 Tab 走不到里面任何按钮**（`inert` 生效）**且不与文本格式条叠在一起**；拖一个文本框到画布最顶部再双击编辑，复看一次（编辑块 `z-[45]` 要压住胶囊）；退出后胶囊复现且无位移。

### 6.2 逐主题（light/blue · dark · yellow · green + 自定义配色）

- [ ] **胶囊可见**：把 `box-shadow` 临时改成 `none`，胶囊几乎消失——说明浮起由投影承担；恢复后边界清楚。（`底 vs 画布` 只有 1.08–1.13，这是预期行为）
- [ ] 边框在四套主题下都看得见 1px 灰线（预期对比 1.19–1.34：它是"定边"不是"分界"）。
- [ ] 竖发丝线（2 条）在四套主题下能读出三段结构（预期 2.71–2.99）。
- [ ] `text-secondary` 文字对比 ≥ 4.5（实测 6.04–7.37）。
- [ ] 保存指示 `Check` 用 `text-text-muted`（5.04 / 4.66 / 5.09 / 5.11 全过 3:1）；**不是 `text-success`**（blue 1.86 / yellow 1.92 / green 2.08，浅色主题下几乎看不见）；saving 时换 spinner 且**换 `text-text-secondary`**（与常态可区分），宽度不变（无布局位移）。
- [ ] 选中/active 的 `bg-accent` 块上，文字与图标用 `text-on-accent`：四主题 5.17 / 5.41 / 6.44 / 5.66，全部 ≥ 4.5；**页面里搜不到 `text-white`**。
- [ ] yellow 与 green 下胶囊底板比画布**深**一档（1.09 / 1.08），读作"浮起的浅灰板"而不是"纸上的补丁"。
- [ ] dark 下胶囊靠 `inset 0 1px 0 #fff/5%` 的顶缘读出厚度，黑色投影未完全消失。
- [ ] 侧栏选中行整行 accent 填充、文字 `on-accent`、monogram `on-accent`；**没有**左侧发光竖条、没有 accent 光斑、没有扫光渐变、没有序号方块。
- [ ] 侧栏行 hover 只有底色变化，**没有** `translateX` 位移、**没有** monogram 缩放。
- [ ] 删除按钮 hover：底色 `danger/12` + 图标 `text-primary`；**不出现** yellow/green 下的浅红字（那只有 2.26）。
- [ ] 键盘 Tab 走查：焦点环在胶囊底上可见（`accent-text` 环，5.00–5.13），选中按钮上换 `on-accent`；环不被胶囊圆角裁掉（`offset: -2px`）。**选择/平移确实带 `aria-pressed`**（否则那条覆盖规则是死代码）。
- [ ] DevTools 里搜 `backdrop-filter`：`.canvas-pill` 与 `.canvas-switcher-panel` 都命中 0 处；只有 `.surface-glass::before` 一处。
- [ ] `isolation: isolate` 在全仓仍只有 `.app-root`（`.canvas-switcher` 现存那一处随重制一起删）。
- [ ] 自定义配色（用户自选 accent）：所有选中块仍用 `bg-accent + text-on-*`，不得因为 accent 变化而出现写死的白字或写死的边框色。
- [ ] 壁纸模式下（`app-has-custom-background`）：胶囊与侧栏仍是不透明 95%/96% 的实底，**不出现**半透到能看清壁纸纹理的情况。

### 6.3 硬规则回归

- [ ] 全仓 `grep -n "duration-\([0-9]\)" src/components/Canvas`：0 处（现有 `duration-200` ×2、`duration-300` ×1 必须清掉）。
- [ ] 全仓 `grep -n "cubic-bezier" src/index.css`：只在 `:root` 的三个 `--ease-*` 定义里。
- [ ] 新增的 flex 行容器没有 `w-auto`。
- [ ] 没有新增 `backdrop-filter` / `filter` / 写死毫秒 / 写死十六进制色值。

---

## 附录 A｜新增/改动的 CSS 块骨架

```css
/* ---------- 胶囊层（容器查询的宿主） ---------- */
.canvas-pill-layer {
  position: absolute;
  z-index: 40;
  inset-inline: var(--canvas-pill-inset);
  top: var(--canvas-pill-inset);
  height: 0;
  display: flex;                 /* 行容器：禁写 w-auto */
  justify-content: center;
  align-items: flex-start;       /* 必须；否则 height:0 会把胶囊 stretch 成 0 高 */
  pointer-events: none;
  container-type: inline-size;
  container-name: canvas-pill;
}

/* ---------- 胶囊 ---------- */
.canvas-pill {
  width: max-content;
  max-width: 100%;
  height: var(--canvas-pill-h);
  pointer-events: auto;
  /* 材质与几何见 §3.2 */
}
.canvas-pill--hidden { opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
/* 可访问性由 JSX 的 inert 负责（§1.6）：不要再写 pointer-events: none，它挡不住 Tab 与 SR */

.canvas-seg { display: flex; align-items: center; gap: var(--canvas-gap-in); flex-shrink: 0; }
.canvas-seg--cluster { gap: var(--canvas-gap-cluster); }
.canvas-seg-rule {
  flex-shrink: 0;
  width: 1px;
  height: 1rem;
  background-color: var(--pill-divider);
}
.canvas-seg--more { display: none; }   /* ⑤ 以下由容器查询翻成 flex */

/* ---------- 侧栏层 ---------- */
.canvas-rail-layer { /* 见 §1.4 */ }

/* ---------- 断点（容器是 .canvas-pill-layer） ---------- */
@container canvas-pill (max-width: 950px) { .canvas-toolbar-action-label { /* max-width:0; opacity:0; padding-inline:0 */ } }
@container canvas-pill (max-width: 820px) { .canvas-pill:not([data-lang="zh"]) :is(.canvas-toolbar-menu-label, .canvas-toolbar-menu-chevron) { /* 同上 */ } }
@container canvas-pill (max-width: 755px) { .canvas-pill[data-lang="zh"] :is(.canvas-toolbar-menu-label, .canvas-toolbar-menu-chevron) { /* 同上 */ } }
@container canvas-pill (max-width: 545px) { .canvas-toolbar-title-label { /* 同上 */ } }
@container canvas-pill (max-width: 470px) { .canvas-toolbar-zoom { /* 同上 */ } }
/* ⑤⑥ 是段级替换，不是文字渐隐：允许 display 硬切（见 §4.2 末条） */
@container canvas-pill (max-width: 426px) { .canvas-seg--output { display: none; } .canvas-seg--more { display: flex; } }
@container canvas-pill (max-width: 396px) { .canvas-seg--viewport { display: none; } }
/* ⑦ 兜底：居中容器一旦可滚动，溢出部分两侧都不可达 —— 必须改 flex-start */
@container canvas-pill (max-width: 362px) {
  .canvas-pill-layer { justify-content: flex-start; }
  .canvas-pill { max-width: none; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
}
```

（文字类收起项的 `max-width` 目标值按被收元素的现宽度写死，例如标签给 `12rem`：`max-width` 从 `0` 过渡到 `12rem` 时多出来的部分不可见，所以不必精确，但**不能用 `max-content`**——`max-content` 不可插值。）

`data-lang` 属性保留在 `.canvas-pill` 上（现挂在 `.canvas-toolbar` 上）。

## 附录 B｜落地顺序建议

1. 加 `--canvas-*` 变量 + `.canvas-pill-layer` / `.canvas-pill` / `.canvas-seg*` / `.canvas-rail-layer` 的 CSS 骨架；**从 `.canvas-toolbar`（`index.css:649`）上删掉 `container-type` / `container-name`**，容器搬到 layer。
2. 拆 `CanvasView.tsx:1819-2007` 为三段（A/B/C）：删外层 `div.canvas-toolbar` 的 `h-11 / border-b / bg-bg-secondary / px-3`、删 `flex-1` spacer、重排 DOM（`视图▾` 移到 `重做` 之后），把 `data-lang` 挂到 `.canvas-pill` 上。`section.canvas-surface` 的 `flex flex-col` **保持不变**，不要加 `relative` 或 `justify-*`。
3. 换 `toolbarButton` 基类（`h-8`→`h-7`、`rounded-md`→`rounded-[7px]`、`px-2`→`px-1.5`），触发器同步。
4. 改七档阈值（**950 / 820·755 / 545 / 470 / 426 / 396 / 362**，以 §8.5 为最终依据），把文字类收起从 `display:none` 换成 `max-width+opacity`；段级替换（⑤⑥⑦）用 `display` 硬切 + `⋯` 溢出菜单；容器换成 `canvas-pill`。
5. 侧栏：删 `backdrop-filter` / `isolation` / `::before` 光斑 / `::after` 扫光 / `row--active::before` 竖条 / `index` 方块；行高 32px；行首改 monogram 槽位；改行为（折叠=展开、展开=切换、行内二次点击删除、`F2`/`Delete` 键盘路径）；补 `aria-current`；`max-height: min(70vh,480px,100%)` + `padding-inline-end: 2px` + 底部叠加渐变层 `.canvas-rail-fade`（`canvases.length > 5` 时挂）+ 打开时 `scrollIntoView`。
6. 文本编辑互斥：`canvasTextEditor` 存在时胶囊加 `inert` + `.canvas-pill--hidden`；`CanvasRichTextEditor` 的 `z-40` 改 `z-[45]`；进态前先 `blur()`。
7. 焦点环覆盖规则 + `aria-pressed`（选择/平移）+ 撤销/重做 `aria-label` + 保存状态 `role="status"` + 侧栏面板删掉非法的 `aria-expanded`；`prefers-reduced-motion` 扩展。
8. 0 / 1 / 20+ 画布三态（空态一行 + 新建标签改写 + 当前行滚进视野）+ 焦点归还（收起 → footer；删除 → 下一行主按钮）。
9. 跑 §6 清单。

## 附录 C｜本轮顺带要清的既有违规

| 位置 | 现状 | 处理 |
|---|---|---|
| `index.css:1135` `.canvas-switcher-panel` | `backdrop-filter: blur(16px) saturate(1.12)` | 删（P5） |
| `index.css:1119` `.canvas-switcher` | `isolation: isolate` | 删（`.app-root` 持唯一） |
| `index.css:1250` `.canvas-switcher-row:hover` | `translateX(-2px)` | 删 |
| `index.css:1238` `.canvas-switcher-row--active::before` | accent 发光竖条 | 删（P2） |
| `index.css:1127-1134` | 面板 `border` + 三层 `box-shadow`（用 `--color-text-primary` 当阴影色，dark 下会变成"亮阴影"） | 换成 `#000` 基座 + `.theme-dark` 覆盖 |
| `CanvasView.tsx:2312 / 2404` | `duration-200`（裸毫秒） | 换 `--dur-base` |
| `CanvasView.tsx:2434` | `duration-300` | 换 `--dur-base` |
| `CanvasView.tsx:2150` 小地图 | `backdrop-blur-sm` | 本轮不动（不在范围内），但记一条：它是同一族违规的最后一处，下次一并清 |
| `index.css:1016` 焦点环 | `outline-color: var(--color-accent)` 在 yellow/green 只有 2.07/2.54 | 只在画布浮层内覆盖成 `accent-text`；全局改动另开一轮 |

---

## 7. 体验审查（Phase 2）

> **数值已过期提示**：本章保留审查当时的取证与推理，其中的阈值（350/310/285、415/380/345 等）与 "fade mask" 表述均已被 §8 覆盖。**实现只看 §8.5.2 与 §4.2**；本章的价值在"为什么"，不在"是多少"。

状态：审查完成（仅文档，未改动 `src/`）。审查对象 = §1–§6 定稿规范；方法 = 逐条代码取证（`CanvasView.tsx`、`CanvasToolbarMenu.tsx`、`CanvasTextToolbar.tsx`、`index.css`、`tauri.conf.json`、`sidebarLayout.ts`、`shortcutReference.ts`、`types/canvas.ts`）+ Nielsen 十项启发式 + WCAG 2.2 AA。
审查前提：§0 的四项用户已锁定方向（macOS 桌面语汇 / 顶部居中悬浮胶囊 / 右侧 44→248px 悬浮条 / 文字标签宽屏保留窄窗渐隐）不在讨论范围；以下质疑的都是**具体做法**。

**结论分布：采纳 1 条（Q3）／有条件采纳 3 条（Q1、Q7、Q8）／否决 4 条（Q2、Q4、Q5、Q6）。**
每条格式 = 结论 → 理由 → 实现指向（`文件:行号`）。与 1–6 章的冲突只在 §7.10 的修订清单里提，**正文未改动**。

---

### 7.1 Q1｜44px 常驻态的信息量

**结论：有条件采纳。** 否决「6px 圆点」作为常驻态的唯一信息载体（问题不是"信息量不够"，是**信息类型错了**）；采纳"常驻态行内展示画布名首字"——用**单字姓名缩写（monogram）替换圆点，两态共用同一个槽位**。否决「hover 自动展开」与「缩略色块」。

**理由：**

1. **点阵的语义是"状态指示器"，不是"列表项"。** 一列等距 6px 圆点在 mac 语汇里读作分页点（page control）或状态灯，不读作"可展开的条目"。现有实现用的是 `1 2 3` 序号方块（`CanvasView.tsx:2332`），虽然 `text-[10px]` 违反 §4.1，但它至少回答了"这里有 n 个东西、且是有序的"——换成圆点是**可发现性净下降**，而且是在一个已经很难被发现的控件上。
2. **常驻态还欠第二个答案：我在哪个画布。** ≤545px 时胶囊把画布名收起（§4.2 ③），此刻全应用没有任何地方显示当前画布名（`1822` 的名字在 A 段，已随 ③ 隐藏）。monogram 用同一像素成本把这个信息补回来：当前行整行 `bg-accent` + 首字 `text-on-accent`。
3. **否决「缩略色块」有代码依据**：`CanvasDocument` 只有 `id / name / createdAt / updatedAt`（`src/types/canvas.ts:134-139`），既没有颜色字段也没有缩略图；要出缩略图必须对每个画布 `loadCanvasBoard`（`CanvasView.tsx:650`）再渲染，20 个画布 = 20 次 IO + 20 次 SVG 渲染，只为一个 44px 宽的条。
4. **否决「hover 自动展开」**：侧栏贴画布右缘、展开后 248px 覆盖画布。用户在最右侧作画时指针必然扫过这条 44px 带 → 面板反复弹开/收回，且一开就把 248×480 的画布区域变成不可绘制区（面板 `pointer-events: auto`，§3.5）。它还会和点击展开产生两个真相源：hover 已经展开后点击 footer 会立刻收起（`toggleCanvasMenu`，`CanvasView.tsx:759`），是典型的"两次输入互相打架"。
5. **在不加宽、不加交互的前提下，monogram 是唯一零成本方案**：44px − `mx-1.5`×2(12px) = **32px 行宽**；12px 字号下 CJK 单字 12px、Latin 2 字符约 13px，都在 32px 内。

**实现指向：** 行首槽位固定 `width: 2rem`（32px）`flex-shrink: 0` `text-center`，内容 = 首字（CJK 取 1 字符、非 CJK 取 2 字符），字号走 §4.1 的 T2（12px/500→600），**不加任何底色方块**（否则与行选中态的 `bg-accent` 打架）。删除 `canvas-switcher-index` 方块（`2332`）与 `index.css:1254-1271` 的全部相关规则（含 `:hover .canvas-switcher-index { scale(1.08) }`）。两态共用该槽位 = 展开/收起时**不发生"圆点↔文字"的交叉淡出**，一次结构改动替代两套状态。

---

### 7.2 Q2｜常驻态点击语义冲突

**结论：否决「整行点击 = 切换画布」作为常驻态语义。** 常驻态行点击 = **展开列表**；展开态行点击 = 切换画布。

**理由：**

1. **32px 行里用户无法预知后果。** 常驻态名字被 `max-width:0` 收起（现 `CanvasView.tsx:2404`），行内只剩一个标记——一个没有标签的目标执行"跳转"是 Nielsen #5（防错）最典型的失分点。**展开是可逆的，切换不是。**
2. **切换的代价被低估。** `switchCanvas`（`642-665`）会先落盘当前 board（`648`）、再 `loadCanvasBoard`（`650`）、再 `loadBoard`（`660`），全程 `switchingCanvas=true` 把每一行的按钮 `disabled`（`2328 / 2341 / 2406 / 2415`），结束后还 `setCanvasMenuOpen(false)`（`661`）——面板自己收起。误触一次 = 一次全量重载 + 面板消失 + 焦点丢失。
3. **"展开"本来就需要一个比 footer 更近的入口。** 现在唯一的展开触发器是面板最下方的 `PanelRight`（`2426-2435`）。让"点行 = 展开"顺手把它解决掉；footer 保留为冗余入口（它必须是 `aria-expanded` 的宿主，见 §7.9.3）。
4. **规格内部其实是自洽的**：`beginRenameCanvas`（`712`）与 `requestDeleteCanvas`（`747`）都强制 `setCanvasMenuOpen(true)`，说明"操作前先展开"在代码里已经是既有约定。

**实现指向：** 处置逻辑挂在行容器上，但只在折叠态生效：`onClick={() => (canvasMenuOpen ? void switchCanvas(c.id) : setCanvasMenuOpen(true))}`。为了让"模式差异"对辅助技术可见，行的可访问名随状态切换：折叠态 `aria-label="展开画布列表（当前：{name}）"`、展开态 `aria-label="切换到 {name}"`（`title` 同步）。**不要**给行容器加 `role="button"`（见 §7.3）。

---

### 7.3 Q3｜行内操作与整行点击的冒泡冲突

**结论：采纳（规格此处留白，本节给结构结论）。** 用「**拉伸主按钮 + 并列操作按钮**」，行容器**不持有任何点击处理**，因此**不需要 `stopPropagation`**。

**理由：** 唯一同时满足 ①HTML 不允许嵌套 button ②键盘可聚焦 ③"整行看起来可点" 的结构，是让主按钮横向拉伸、吃掉除操作区以外的全部宽度。"结构上不需要 stopPropagation"比"记得写 stopPropagation"可靠一个数量级——后者漏一处就是"点删除顺带切了画布"。

**DOM 结构（可直接实现）：**

```
div.canvas-row                          ← 仅布局：无 onClick、无 role、无 tabIndex
├─ button.canvas-row__main              ← flex-1 min-w-0 h-full gap-1.5 rounded-md text-left
│    ├─ span.canvas-row__mark           32px 固定：monogram（§7.1）
│    └─ span.canvas-row__name           truncate；折叠时 max-w-0 + opacity-0（**收内层 span，不收按钮**）
├─ button.canvas-row__action            h-full w-7，tabIndex={-1}，aria-label="重命名 {name}"
└─ button.canvas-row__action            h-full w-7，tabIndex={-1}，aria-label="删除 {name}"
```

- **禁止** `div[role="button"] + onClick` 包裹两个 button：嵌套交互内容在 a11y 树里非法，且 `role="button"` 不会自动获得 `Space`/`Enter`，必须自己补 `onKeyDown`——漏补一处就是键盘不可用。
- 主按钮必须 `h-full flex-1`，**宽度收缩只能发生在内部的 name span 上**。现有代码把 `max-w-0 opacity-0 pointer-events-none` 打在 name 按钮**本身**（`2404`），折叠态下按钮宽度归零。沿用这个写法会让"整行点击"的可点区域只剩 32px 的标记槽——详见 §7.12（本轮最容易抄错的一处）。
- 行内操作的浮现条件必须是 `hover` **或** `focus-within`（§2.4 已规定），保证鼠标路径与键盘路径看到同一套控件。
- **Tab 顺序**：DOM 顺序即 Tab 顺序 = 新建 → 行1[主, ✎, 🗑] → 行2[主, ✎, 🗑] → footer。20 个画布 = **61 个停留点**才能到 footer，不可接受。因此**行内操作 `tabIndex={-1}`**，键盘路径改为（与 §2.4 的重命名规定合并成一套）：
  - 主按钮聚焦后 `F2` = 重命名、`Delete` = 删除（走二次点击）、`Enter`/`Space` = 展开 / 切换。
  - WCAG 2.1.1 仍满足（功能键盘可达），2.4.3（焦点顺序）反而更短。macOS（Finder）也是这个模型：行内操作不是 Tab 站，而是行选中后的快捷键。

---

### 7.4 Q4｜删除二次确认的形态

**结论：否决「行内替换」。采纳「行内二次点击」——但不写确认句。** 结构 = 整行内容不变（monogram + 画布名照常显示），只把行尾两个 hover 操作钮**就地替换**成 `✓ / ✕`。否决「弹确认层」。

**理由（248px 下的实际文字预算）：**

- 面板内宽 = 248 − 1（左边框） = 247；行盒减去 `mx-1.5`×2（12px） = **235px**。
- 现有确认行的分配（`CanvasView.tsx:2334-2356`）：`235 − 32(序号钮) − 28(✓) − 28(✕) − 6(gap×2) − 7(确认块 padding-left) − 4(pr-1) ≈ 130px` 给问句。
- 中文问句 `确定删除“{name}”吗？`（`i18n.ts:1056`）**光模板就 8 个字 ≈ 88px**（11px 字号），名字只剩 **42px ≈ 3.8 个中文字符**。也就是说现有实现的二次确认里，**最关键的宾语被截掉了**——用户看到的是 `确定删除“设计…”吗？`，这是在问一个它自己也没说清的对象。
- 28px 行高本身够用（11px/16px 行高 + 两枚钮刚好撑满）。**真正放不下的是文字预算，不是高度**——所以"压缩字句"不是解法，**去掉句子**才是。
- 本方案的预算：名字保留 `235 − 32 − 28 − 28 − 6 = 141px` ≈ **11.7 个中文字符**，一个典型画布名（4–8 字）完整可见。"删的是哪个"由名字本身承担，不必在句子里重复。
- **否决弹确认层**：为删除一个画布开居中 modal，需要 focus trap + 遮罩 + 关闭后归还焦点，成本远高于动作本身；且这是"列表内的破坏性操作"，macOS 在这里用行内确认或快捷键（Cmd+Delete），不用 sheet。
- 配色：`✓` 用 `bg-danger text-on-danger`（`2339` 已是），`✕` 保持中性——**不要**用绿色 ✓，删除不是"确认成功"。

**实现指向：** `deletingCanvasId === canvas.id` 时 `canvas-row__main` 原样保留，只把两个 `.canvas-row__action` 换成 `✓ / ✕`；`✓` 的 `aria-label` 用现成的 `tWithParams(lang, "canvasDeleteQuestion", { name })`（**完整问句只进可访问名，不进视觉**），`✕` 用 `t(lang,"confirmNo")`。删除问句 `span`（`2336`）与 `index.css:1224-1228` 的整块 danger 底色（`.canvas-switcher-confirm` 的 `background: danger/8`）——行内确认不再需要一整块红底，红只出现在 `✓` 与 hover 上。

---

### 7.5 Q5｜窄窗兜底缺口

> **落地时以 §8.5.2 为准**：本节的**结构结论**（⑤ 折 `⋯`、⑥ 视图▾ 并入、⑦ 横向滚动）全部采纳；但 350 / 310 / 285 三个阈值是把"折叠后的内容宽"当成了"触发阈值"，差了一档，最终值见 §8.5.2 的 **470 / 426 / 396 / 362**（slack 4–6px，间隔 = 折叠减少量 46/30/34）。另：保存状态按 §7.7 移入 A 段后，`⋯` 菜单里不再需要"已保存"那一行只读项。

**结论：否决「C3 整体退出」，改为「C3 折叠为单个 ⋯ 溢出菜单」。** 并指出 ⑤ 的 350px 恰好是胶囊的物理下限，本身不构成余量。

**理由（已核实：这两个动作真的没有第二个入口）：**

| 取证 | 结果 |
|---|---|
| `canvasOpenTile` 全仓命中 | 只有 `CanvasView.tsx:1999-2002`（按钮 + label）；其余是 `i18n.ts:1093` 的文案定义 |
| `canvasExport` 全仓命中 | 只有 `CanvasView.tsx:2003-2006`（按钮 + label）；其余是 `i18n.ts` 与 `canvasExport.ts` 实现 |
| `shortcutReference.ts:22-42` | 画布分组只有 `Ctrl+Z / Ctrl+Y`，无导出/小窗快捷键（该文件注释明写"只登记真的被代码处理的快捷键"） |
| `src-tauri` 菜单 | 无任何 canvas 菜单项 |
| App 级导出 | `handleExportNote`（`App.tsx:1030`）是**笔记**导出，与画布无关 |

→ ≤350px 时"整段退出" = **静默删掉两个功能**。这不是降级，是缺陷。

**算术（为什么 ⑤ 不是余量而是地板）：**
全标签收起后 A(28) + 段线(8+1+8) + B1(28+2+28) + 簇间(6) + B2(4×28+3×2) + 段线(17) + C1(28+2+28) + 簇间(6) + C2(视图 28，缩放已在 ④ 收起) + `padding-inline:12` + `border:2` = **350px**。一点余量都没有。
而舞台可以窄于 350px：`tauri.conf.json:18-19` 最小窗口 480×400，但左右侧栏最小宽分别是 `SIDEBAR_MIN_WIDTH = 240`（`sidebarLayout.ts:5`）与 `AI_SIDEBAR_MIN_WIDTH = 280`（`:22`），窗口 resize 不做自动收起（`App.tsx:786-788` 只校正下限），`480 − 240 − 280 − 活动栏 < 0` 完全可达。**⑤ 之后必须还有一档。**

**替代做法（三级）：**

| 档 | 内容宽（**不是阈值**） | 动作 |
|---|---|---|
| ⑤ | 414（C3 尚在）→ 折叠后 **384** | C3 三项**收进一个 `MoreHorizontal` 28px 按钮**，点击弹出菜单：开小窗 + 导出（保存状态已按 §7.7 移入 A 段，不进菜单） |
| ⑥ | 384 → 折叠后 **350** | `视图▾` 并入同一个 ⋯ 菜单（视图 4 项本就低频），C2 整段退出 |
| ⑦ | 350（地板） | 兜底：胶囊 `overflow-x: auto; scrollbar-width: none`——**不裁切、不丢控件**，代价是尾部要滚动 |

> **本节的两处算术订正（已由 §4.2 吸收，此处保留记录以免再犯）**
> ① 上表原写「阈值 = 350 / 310 / 285」「350 → 320」，两处都错：**350 是折叠后的内容宽，不能当触发阈值**。⑤ 触发那一刻 C3 还在，内容 = 350 + 6 + 58 = **414**；若把阈值定在 350，350–414px 是一段死区，胶囊撞 `max-width:100%` 后被 `overflow: hidden` 切掉半颗按钮。
> ② 「350 → 320」也算了：省下的 30px（−58 +28）应当从**折叠前**的 414 减，得 **384**，不是从折叠后的 350 再减 30。
> ③ 由此得到的不变量：**阈值ₙ = 内容宽ₙ + slack**（只加不减）。原 310 / 285 相对 384 / 350 分别低了 74 / 65px，属同一类错的第二级放大。落地数值以 §4.2 为准。

- ⋯ 菜单直接复用 `CanvasToolbarMenu`（`aria-haspopup="menu"` + `aria-expanded` + `aria-controls` 已齐全，`CanvasToolbarMenu.tsx:124-126`），`align="end"`，不新增组件。
- 收益：⑤ 用 28px 换回 58px（省 30px）且**零功能损失**；⑥ 再省 34px。
- **不要**把 C1（撤销/重做）并进 ⋯：高频 + 肌肉记忆，§4.2 ⑤ 保留 C1 的判断是对的。

**实现指向：** "把三个按钮换成一个按钮"用 CSS 做不到（要换 DOM），所以**这一档必须在 TSX 里做**：`CanvasView.tsx:1998-2006` 的 C3 渲染成 `.canvas-seg--output`（三项）+ `.canvas-seg--more`（一个 ⋯ 触发器），用容器查询翻 `display`。**此处允许 `display:none`**：§4.4 禁 `display:none` 是为了文字渐隐的连续性，而段级切换本来就是离散事件，不需要过渡（附录 A 现有的 `.canvas-seg--output { display: none }` 保持即可，只是目标从"整段消失"改成"整段被 ⋯ 替代"）。

---

### 7.6 Q6｜编辑态隐藏胶囊的可访问性

**结论：否决 `opacity:0 + pointer-events:none`，改用 `inert`。** `visibility` 延迟过渡作为零 JS 备选；**否决条件卸载**。

**理由：**

1. 现规则（§1.5、`附录A:660`）只做了两件事：视觉透明 + 不接指针。**Tab 仍会停在 13 个看不见的按钮上，屏幕阅读器仍会读出全部 13 个控件**，且焦点环画在 `opacity:0` 的元素上 = 用户彻底失去焦点位置。WCAG 2.4.7（焦点可见）+ 2.4.3（焦点顺序）双双失分。
2. **这不是"编辑态才有"的边缘问题**：同一个 bug 已经在侧栏里存在——`2404` 与 `2413` 的 `pointer-events-none opacity-0 max-w-0` 让折叠态每个画布多出 **2 个不可见 Tab 停留点**，20 个画布 = **40 个幽灵焦点**。两处应一起修（见 §7.9.3）。
3. **为什么选 `inert` 而不是 `visibility`**：`inert` 一次解决三件事（移出 Tab 序列、移出 a11y 树、屏蔽程序化 `focus()`）；`visibility:hidden` 只管前两件。React 19.1（`package.json:62`）原生支持 `inert` 布尔属性，成本是一个 prop。
4. **为什么否决条件卸载**：①丢失 `--dur-fast` 的淡出（编辑态进出是高频动作，闪断明显）；②卸载会重建 C 段三个按钮的 DOM，`CanvasToolbarMenu` 的 `panelRef` 测量（`CanvasToolbarMenu.tsx:56-74`）会在下次打开时重跑 `useLayoutEffect`，产生一帧定位跳动；③卸载与 `openToolbarMenu` 状态不同步，退出编辑后菜单可能"自己开着"。
5. `inert` 立即生效、`opacity` 在 120ms 内淡出，两者不冲突：**淡出期间按钮可见但不可点，这正是想要的**——用户刚点进文字编辑，不应误触正在消失的工具栏。

**实现指向：** 胶囊容器加 `inert={canvasTextEditor != null ? true : undefined}`（React 19 写法；用 `undefined` 而不是 `false`，避免渲染出 `inert="false"` —— 该属性按存在与否判定）。CSS 侧保留 `.canvas-pill--hidden { opacity: 0; }`，**删掉其中的 `pointer-events: none`**（`inert` 已覆盖）。
若需零 JS 兼容老 WebKitGTK，改用非对称过渡：

```css
/* 隐藏：先淡出，淡出结束后才真正隐藏（visibility 是离散属性，可用 delay 控制切换时刻） */
.canvas-pill--hidden {
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--dur-fast) var(--ease-out),
    visibility 0s linear var(--dur-fast);
}
/* 恢复：立即可见，再淡入 */
.canvas-pill {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    visibility 0s linear 0s;
}
```

**另需补焦点管理**：进入编辑态时若焦点在胶囊内，先 `document.activeElement.blur()` 再设 `inert`（`inert` 元素内部持焦点时各引擎行为不一致）；退出编辑态不抢回焦点（焦点应回到文本编辑器）。

---

### 7.7 Q7｜保存状态的位置

**结论：有条件采纳。** 位置采纳"移到 A 段画布名右侧"（macOS 惯例正确）；**但把常态文字去掉**，只留 12px `Check` 图标。

**理由：**

1. **状态必须挨着它描述的对象。** 它描述的是"这块画布"，把它放进 C3 出口簇、与"导出"相邻，语义上等于把它当成了一个**动作**——它不是动作，它是状态可见性（Nielsen #1）。macOS 把文档状态放在标题栏（靠近文档身份）。
2. **但「已保存」不该常驻占位。** 中文 3 字 = **36px**（12px 字号），它在 99% 的时间里显示同一个值，是胶囊里性价比最低的 36px。改为：常态 = `Check` 12px（**`text-text-muted`**，占 12px）；`saving` = 换成 12px 环形 spinner（**等宽替换，不产生布局位移**）。

> **落地口径（team lead 裁决）**：本条下面的代码示例里写的是 `text-success`，那是审查当时的初稿。**以 §3.3 的修订为准，用 `text-text-muted`** —— `--color-success` 对胶囊底只有 blue 1.86 / yellow 1.92 / green 2.08，浅色主题下这个勾几乎不可见。
3. **8px 段间距的冲突解法：A 段内部用 6px，不用 8px。** §1.4 的 `8px` 是**段间**节拍（A↔B、B↔C）；"图标–名字–状态"是 A 段内部的子元素，走 §2.2 的"簇间 6px"（`--canvas-gap-cluster`）。这样 8px 段间距不动，节拍阶梯仍是 **2 / 6 / 8 三级**，不新增第四级。
4. **顺带解决三个既有隐患**：①§3.4 里 dark 主题 `text-muted` 只有 4.66、且"保存状态是唯一用 muted 的元素"——不再有 12px muted 文字，这条风险消失；②§4.2 的 ② 档里"保存状态"作为隐藏项可删（图标永不隐藏），⑤ 档也不用再保护它，两条断点规则各少一个选择器；③`i18n.ts:1040-1041` 的「已保存 / 保存中…」不再需要视觉呈现，只留在 `title` 与 `sr-only` 里。
5. **宽度账**：C3 少 `36+6=42px`、A 段多 `12+6=18px`，**胶囊最大内容宽度净减 24px**，对 §4.2 是净收益。

**实现指向：** `CanvasView.tsx:1998` 的 `<span className="canvas-toolbar-status">` 从 C3 移到 `1820-1823` 的 A 段 `div` 内、名字之后，间距 `gap-1.5`（6px）：

```tsx
<span className="canvas-toolbar-status" role="status" aria-live="polite" aria-atomic="true">
  {saveState === "saving"
    ? <><Loader2 size={12} className="animate-spin" aria-hidden /><span className="sr-only">{t(lang, "canvasSaving")}</span></>
    : <Check size={12} className="text-text-muted" aria-hidden />}
</span>
```

`role="status"` 是**新增的必需项**：现在（`1998`）状态变化对屏幕阅读器完全静默。**`aria-live` 只播报 `saving`**（常态不渲染文字 → 不会在每次编辑后播报"已保存"），否则自动保存每 650ms 一次（`536-539`）会变成播报风暴。

---

### 7.8 Q8｜画布数量边界

**结论：有条件采纳。** `max-height: min(70vh, 480px)` 采纳（现有 `max-h-[116px]` 在 `2317`，36px 行高下只显示 3 行）；但需补 0 / 1 / 20+ 三态，且行高建议从 28 提到 32（见 §7.9.4）。

**理由：**

1. **0 个画布**：删光最后一个后 `activeCanvasId = null`（`796`）、`canvases = []`、面板自动收起（`800`）。此时常驻态只剩 `+` 和 footer，展开态是"一条空列表 + 一个新建行"。
   - **不能收起侧栏**：`+` 是全应用唯一的新建入口。
   - 列表区补一行 28px 空态文案（12px `text-muted`，"还没有画布"），并把新建行标签在 0 个时换成"新建第一个画布"——用一句话把"下一步做什么"说清（Nielsen #10）。
2. **1 个画布**：**不收起**。收起会同时藏掉"新建 / 重命名 / 删除"三个入口，且侧栏显隐本身是布局跳变（Nielsen #4 一致性 > 省 44px）。
3. **20+ 个画布**：`min(70vh, 480px)` 的可见行数 = `(480 − 32新建 − 20小标题 − 28footer − 12padding) / 30 ≈ 12` 行，20 个画布 2 屏；400px 高的窗口下 `max-height:100%` 会先压到带高，约 6 行。可接受。**但缺两件事**：
   - **打开时必须把当前画布滚进视野**：active 在第 15 项时，展开面板停在第 1 项，用户看不到"我在哪"。
   - **滚动条贴着卡片右缘**：面板 `border-right: 0` 且 `overflow: hidden`，列表的 `overflow-y: auto` 会让滚动条贴在屏幕/卡片边；且 overlay 滚动条在不动的时候不可见，"还有更多"没有提示。
4. **另计一条**：面板现在**只能靠 footer 收起**。`toggleCanvasMenu`（`759`）之外没有任何 outside-click 或 Esc 关闭（`2242-2437` 内没有 pointerdown / keydown 处理）。展开的 248×480 是画布上的不可绘制区，必须能一键退出（见 §7.9.2 与 §7.11）。

**实现指向：**
- `2317` 的 `max-h-[116px]` → `max-height: min(70vh, 480px, 100%)`（把 §3.5 已有的 `max-height: 100%` 合并进同一个 `min()`，避免两处 `max-height` 打架）。
- 空态行插在 `2318` 的 `canvases.map` 之前：`canvases.length === 0 && <div className="h-7 …">`。
- 用 `useLayoutEffect` + `rowRefs[activeCanvasId]?.scrollIntoView({ block: "nearest" })` 在 `canvasMenuOpen` 变 true 时把当前行滚进视野（`prefers-reduced-motion` 下 `behavior: "auto"`）。
- 列表加 `padding-inline-end: 2px`，并加**底部叠加渐变层** `.canvas-rail-fade`（高 24px、`pointer-events:none`、`bg-secondary 96% → transparent`，仅 `canvases.length > 5` 时挂）。这既是 macOS 的溢出提示，也在滚动条自动隐藏时回答了"还有更多"。**不要用 `mask-image`**——它会把正在滚出视口的那一行（含选中行 accent 底）一起淡掉，而滚动时恰恰最需要那个提示。

---

### 7.9 附加检查

#### 7.9.1 焦点顺序

- **DOM 顺序天然正确**：胶囊层（`2008` 之后）→ svg（`2014`）→ 小地图 → 侧栏（`2242`）。Tab 走 `胶囊 13 项 → 侧栏`，方向与视觉一致（上 → 右），**不需要 `tabindex` 干预**。
- **三个必须修的顺序缺陷**（都属于"焦点落到不可见元素"）：
  1. **折叠态侧栏每行 2 个幽灵停留点**：`2404`、`2413` 的 `pointer-events-none opacity-0 max-w-0` 不移出 Tab 序列。修法同 §7.6——折叠时给这两个按钮 `tabIndex={-1}` 或条件渲染。
  2. **侧栏收起时焦点丢失**：`switchCanvas`（`661`）与 `removeCanvas`（`800`）里的 `setCanvasMenuOpen(false)` 会收掉正持有焦点的按钮，焦点掉到 `body`。修法：收起前把焦点交给 footer 触发器（它有 `aria-expanded`，语义正确）。
  3. **删除后焦点丢失**：`removeCanvas`（`767-804`）不处理焦点，键盘用户要重新从文档头 Tab 一遍。修法：删除完成后把焦点交给同位置的下一行主按钮（无下一行则交给新建按钮）。
- **反例**：不要在行容器上加 `tabIndex={0}` 来"让整行可聚焦"——会和主按钮重复入栈。

#### 7.9.2 Escape 的行为与统一

**现状（三条并存、互不协调）：**

| 处理器 | 位置 | 行为 |
|---|---|---|
| CanvasView 全局 keydown | `CanvasView.tsx:1260-1264` | `setSelectedId(null)` + `setConnectorStartId(null)` + `setTool("select")` |
| CanvasToolbarMenu keydown | `CanvasToolbarMenu.tsx:95-99` | 关菜单 + 焦点还给触发器（**不 `preventDefault`**） |
| 重命名 / 新建输入框 | `2262-2268`、`2368-2374` | 取消编辑（`isTextInput` 在 `1250` 提前 return，所以不与全局那条叠加） |

- **Bug 1（现网 Bug）**：菜单开着按 Esc，两个处理器都跑 → 菜单关掉，**同时选区被清空、工具复位成 `select`**。用户只想关菜单。
- **Bug 2**：侧栏开着时 Esc **不会关侧栏**（侧栏根本没有 Esc 处理器）。
- **修法（单点决策的优先级链）**：`CanvasToolbarMenu` 的 Esc 分支加 `event.preventDefault()`；`CanvasView.tsx:1260` 的分支前置 `if (event.defaultPrevented) return;`，然后：

  ```
  Esc → ① 输入框内取消（已有，1250 提前 return）
       → ② 有打开的胶囊菜单（preventDefault 已消费）
       → ③ canvasMenuOpen ? closeCanvasMenu() : 
       → ④ 清选区 / 复位工具
  ```

- **唯一容易做错的地方**：监听器都在 `window` 上，而 `CanvasToolbarMenu` 的 `useLayoutEffect` 注册晚于 `CanvasView` 的 mount effect → 它会**晚触发**，`defaultPrevented` 永远来不及设。所以菜单侧必须用 `{ capture: true }` 注册（capture 先于 bubble），否则这条链是假的。
- `closeCanvasMenu`（`750-757`）已经会一并清 `creatingCanvas / newCanvasName / renamingCanvasId / renamingCanvasName / deletingCanvasId`，所以 ③ 一行覆盖侧栏的全部子状态。
- **两级 Esc 是想要的**：焦点在重命名框里时第一次 Esc 取消重命名（`2370`），第二次 Esc 关面板。

#### 7.9.3 `aria-expanded` / `aria-haspopup` 完整性

| 位置 | 现状 | 结论 |
|---|---|---|
| 胶囊菜单触发器 `CanvasToolbarMenu.tsx:124-126` | `aria-haspopup="menu"` + `aria-expanded` + `aria-controls` | ✅ 齐全，不动 |
| 侧栏面板 `CanvasView.tsx:2245-2247` | `role="region"` 上挂 `aria-expanded` | ❌ **非法**：`aria-expanded` 不允许出现在 `region` 上，且 `region` 不是 disclosure。删掉这一对；面板保留 `role="region" + aria-label`，或改 `<nav aria-label>` |
| 侧栏 footer `2432` | 有 `aria-expanded`，无 `aria-controls` | 补 `aria-controls={listPanelId}`。footer 是 disclosure 按钮，**不加** `aria-haspopup`（弹出的是常驻面板，不是菜单） |
| 选择 / 平移 `1825` / `1828` | **没有 `aria-pressed`** | ❌ **与 §3.6 直接冲突**：`417` 的 `.canvas-pill button[aria-pressed="true"]:focus-visible { outline-color: var(--color-on-accent) }` 永远匹配不到。必须加 `aria-pressed={tool === "select"}` 等（`CanvasTextToolbar.tsx:39` 已有先例） |
| 撤销 / 重做 `1994-1995` | 只有 `title`，无 `aria-label` | 补显式 `aria-label`。`title` 只是可访问名的最后兜底，且它同时是 tooltip，改文案时容易只改一处 |
| 新建行 `2298-2315` | 无 `aria-label`，名字由 `max-w-0` 收起的 span 提供 | 可访问名"恰好"还在（`opacity:0` 不移出 a11y 树）。按 §4.4 改成 `max-width+opacity` 仍然安全；**但不要**为收起改 `display:none` / `visibility:hidden`，那会把可访问名一起干掉 |
| 保存状态 `1998` | 无 `role="status"` | 补（§7.7） |
| 行主按钮 | 无 `aria-current` | 补 `aria-current={active ? "true" : undefined}`——"当前画布"不能只靠底色（色弱 / 高对比模式） |

#### 7.9.4 28px 命中区（含 Windows 触控板）

**结论：胶囊内按钮采纳 28px；侧栏列表行建议改 32px。**

- 28px **满足** WCAG 2.2 AA 的 2.5.8（最小 24×24）；间距例外也满足——2px gap 下相邻目标中心距 30px > 24px，两个 24px 圆互不相交。
- **未满足** 2.5.5（AAA，44×44）与 Microsoft Fluent 的桌面 32px 建议。桌面应用 + 指针为主 → 可接受，不阻断。
- **但列表行不一样**：列表行是"同类相邻 + 误击代价高"。切错画布 = 一次 board 全量重载（§7.2），而胶囊里点错工具只是"选中了另一个工具"，代价差一个量级。28px 行高 + 2px gap 意味着垂直方向只有 30px 周期，触控板和小触屏上很容易选到相邻行。
- **实现指向**：把 `--canvas-rail-row-h` 单独设为 `2rem`（32px），与 `--canvas-ctl-h: 1.75rem` **解耦**（这两个值本来就不是一个概念：一个是列表行，一个是工具按钮）。§1.3 的"行节拍两态一致"仍然成立（两态都是 32px）。3 个画布时面板高 172px（原 160px），无实质影响。
- 若要覆盖粗指针：`@media (pointer: coarse)` 下一组覆盖 `--canvas-ctl-h: 2.25rem`(36) + `--canvas-pill-h: 3rem`(48) + 行高 40px 即可，**不需要改任何结构**。本轮不必做，但值写进文档。

#### 7.9.5 其他与代码现实的冲突

| # | 冲突 | 位置 | 处置 |
|---|---|---|---|
| 1 | §1.4 写 `CanvasRichTextEditor` 在 `2121`、`z-40`；实际 `className="absolute z-40"` 在 **`2125`** | `CanvasView.tsx:2125` | 改 `z-[45]`（Tailwind 无 `z-45`） |
| 2 | §3.6 的焦点环依赖 `aria-pressed`，代码里没有 | 见 §7.9.3 | 加 `aria-pressed` |
| 3 | §1.5 的 `canvas-pill--hidden` 用 `pointer-events:none`，挡不住键盘 / SR | `附录A:660` | 见 §7.6 |
| 4 | `switchingCanvas` 期间整个列表 `disabled` **且无进度指示**（无 spinner、无 `aria-busy`） | `2328 / 2341 / 2406 / 2415` | 面板加 `aria-busy={switchingCanvas}`，并在列表顶部显示一行 28px 的"正在切换…"；否则用户看到的是"点了没反应"（Nielsen #1） |
| 5 | 44px 条带是**滚轮死区**：画布的 `onWheel` 挂在 svg 上（`2032`），侧栏是 svg 的**兄弟**而非子节点，滚轮在条带上既不下传也不缩放 | `2032` / `2242` | 接受（44px 在最右缘，且"指针落在浮层上不缩放画布"是合理预期），记一条备查 |
| 6 | `role="application"` 挂在 svg 上 | `2023` | 本轮不动。记一条已知限制：画布对象对屏幕阅读器完全不可见（无 DOM 表示），属产品级缺口，不在本轮范围 |

---

### 7.10 建议修订清单（未改动 1–6 章正文）

| # | 位置 | 修订 | 依据 |
|---|---|---|---|
| R1 | §2.4 侧栏行规格、§1.3 高度表 | 行高 28 → **32px**（`--canvas-rail-row-h: 2rem`）；"行节拍两态一致"保留 | §7.9.4 |
| R2 | §2.4「行首指示点」 | 6px 圆点 → **monogram 文字槽**（32px 固定宽，12px 姓名缩写，无底色） | §7.1 |
| R3 | §2.4 行为连通表「点击行」 | 常驻态 = 展开；展开态 = 切换 | §7.2 |
| R4 | §2.4「删除…保持二次确认」 | 明确为"行内二次点击，**不渲染确认句**，问句只进 `✓` 的 `aria-label`" | §7.4 |
| R5 | §4.2 ⑤ / 附录 A 断点 | ⑤ 改为"C3 折叠成 ⋯ 溢出菜单"；新增 ⑥（视图▾ 并入）与 ⑦（横向滚动兜底）。**阈值以 §8.5.2 为准**（470 / 426 / 396 / 362，slack 4–6px，间隔 = 折叠减少量） | §7.5 + §4.2 + §8.5 |
| R6 | §1.5 / 附录 A `.canvas-pill--hidden` | `pointer-events:none` → `inert`（或 `visibility` 非对称过渡） | §7.6 |
| R7 | §2.1 控件表 #12、§1.4 C 段、§4.2 ② | 保存状态移入 A 段；常态只留 12px `Check`，文字只在 `title`/`sr-only`；② 与 ⑤ 各删一个选择器 | §7.7 |
| R8 | §3.6 | 补一条"选择/平移必须带 `aria-pressed`"，否则 `417` 的规则是死代码 | §7.9.3 |
| R9 | §1.3 面板规格 | `max-height: min(70vh, 480px, 100%)`；列表补 `padding-inline-end: 2px` + 上下 fade mask；打开时 `scrollIntoView({block:"nearest"})` | §7.8 |
| R10 | 新增（本章 §7.9.2） | Escape 单点决策链 + `CanvasToolbarMenu` 改 capture 注册 + `preventDefault` | §7.9.2 |
| R11 | 附录 B 落地顺序 | 第 5 步后插入"行结构与键盘路径（F2 / Delete）"+"Escape 链"；第 8 步前插入"0/1/20+ 三态与焦点归还" | §7.3 / §7.8 / §7.9.1 |

---

### 7.11 高风险交互与降级方案

| 交互 | 风险 | 降级方案 |
|---|---|---|
| **切换画布** | 误触（常驻态无标签）+ 全量重载 + 列表自动收起，三重叠加 | 常驻态只展开；切换中面板 `aria-busy` + 一行进度提示；切换后焦点回到被切换行 |
| **删除画布** | 行内确认的宾语被截断（现预算 3.8 字）；删的是"当前画布"时立刻换 board | 名字常驻显示（§7.4）；删当前画布时文案改"删除当前画布？"；删除后焦点交下一行 |
| **文字编辑互斥** | 胶囊不可见但仍可聚焦（13 个幽灵停留点） | `inert`；进入编辑态前 blur |
| **≤415px 胶囊** | 若"整段退出"= 静默删功能 | `⋯` 溢出菜单（⑤ C3 折叠 → ⑥ 视图▾ 并入 → ⑦ 横向滚动兜底，**阈值以 §8.5 的 488/442/412/378 为准**） |
| **展开的侧栏覆盖画布** | 248×480 不可绘制区，仅 footer 可关闭 | Esc 关闭 + outside-click 关闭；收起后焦点回 footer |
| **20+ 画布** | 打开时看不到当前行；滚动条贴边且自动隐藏 | `scrollIntoView` + 上下 fade mask |

---

### 7.12 前端落地最容易做错的一处结构

**行主按钮的宽度收缩点。**

现有代码把 `max-w-0 opacity-0 pointer-events-none` 打在**名字按钮自身**上（`CanvasView.tsx:2404`）——在旧结构里它就是一个"只有名字"的按钮，这么做没有副作用。新结构要求这个主按钮 `flex-1 h-full` 承载"整行点击"，如果把同一组类原样延续到主按钮上，折叠态下**主按钮宽度归零**：

- "整行可点"退化成"32px 的标记槽可点"，§7.2 的"常驻态点击 = 展开"在 44px 的整条上都不成立；
- 这个 bug **在视觉上完全看不出来**（折叠态本来只有标记可见），只能在 44px 状态下逐像素点一遍才能发现；
- 它还会连带毁掉 `focus-visible` 环的范围和 `aria-current` 的可读性。

**正确写法：收缩发生在主按钮内部的 `span.canvas-row__name`，主按钮本身永远 `flex-1 min-w-0 h-full`。**

```tsx
<button className="canvas-row__main flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left">
  <span className="canvas-row__mark w-8 shrink-0 text-center text-xs font-semibold">{mark}</span>
  <span
    className="canvas-row__name min-w-0 truncate transition-[max-width,opacity] duration-[var(--dur-base)] ease-[var(--ease-out)]"
    style={{ maxWidth: canvasMenuOpen ? "12rem" : 0, opacity: canvasMenuOpen ? 1 : 0 }}
  >
    {canvas.name}
  </span>
</button>
```

同样的模式在 `2312`（新建行标签）已经用了第一次——直接复制它就会把这个错误带进新结构，而两处的差别恰好是"新建行整行就是一个按钮"（可以收按钮）vs"行主按钮要撑满整行"（只能收内层 span）。这两者不能共用同一个类名。

---

## 8. 最终数值表（Phase 3 实现依据）

> **覆盖声明**：本节是**实现唯一数值依据**。§1–§6 中的同名项若与本节的数字不同，**以本节为准**（§1–§6 保留推导与理由，不删）。与 §7.5 / §7.7 / §7.10 冲突处在 §8.1 逐条标注。
>
> 全节不涉及代码改动，只定义数值与结构。对比度数字为 WCAG 相对亮度公式实算；几何数字为解析式预算，算式全部给出，便于前端复核。

### 8.1 R1–R11 裁决表

**总计：采纳 9 条、有条件采纳 2 条（其中 2 处数值/颜色被反驳）。**

| # | §7.10 原修订 | 裁决 | 最终值 / 反驳依据 |
|---|---|---|---|
| R1 | 侧栏行高 28 → 32px | **采纳** | `--canvas-rail-row-h: 2rem`，与 `--canvas-ctl-h: 1.75rem` 解耦。两态高度算式见 §8.2 |
| R2 | 行首 6px 圆点 → monogram 槽 | **采纳** | 槽固定 `2rem`，**占满折叠行宽**（32px，不额外留 6px）。展开态分配见 §8.3 |
| R3 | 常驻态点行 = 展开；展开态 = 切换 | **采纳** | 附带 `aria-label` 随状态切换、补 `aria-current` |
| R4 | 行内二次点击，不写确认句 | **采纳** | `✓` 用 `bg-danger text-on-danger`，`✕` 中性；完整问句只进 `aria-label` |
| R5 | ⑤ 折叠成 ⋯；新增 ⑥⑦ | **采纳结构，反驳原三个阈值** | 350 / 310 / 285 → 团队终值 **426 / 396 / 362**（档间间隔 30 / 34 = 折叠减少量，结构性、可定死；算式见 §8.5。⑥=310 放不下：该组内容 356 > 310，见 8.5.3） |
| R6 | `opacity+pointer-events:none` → `inert` | **采纳** | JSX `inert`（`undefined` 而非 `false`），CSS 只留 `opacity`；进态前 `blur()` |
| R7 | 保存状态移入 A 段、常态去文字 | **采纳迁移，反驳颜色** | 位置与"去文字"采纳；常态 `text-success` → **`text-text-muted`**（1.86/1.92/2.08 < 3:1，见 §8.4.3）；**saving 另用 `text-text-secondary`**（两态必须不同色） |
| R8 | 补 `aria-pressed`（否则 §3.6 死代码） | **采纳** | 最终类名与属性见 §8.6 |
| R9 | `max-height: min(70vh,480px,100%)` + `padding-inline-end:2px` + fade + `scrollIntoView` | **采纳，但 fade 方案改为叠加层** | `mask-image` 作废（会淡掉正在滚出视口的那一行）；改 `.canvas-rail-fade`：`absolute; bottom: 1.75rem; height: 24px; pointer-events: none; linear-gradient(to top, bg-secondary 96% → transparent)`，`canvases.length > 5` 预判 + "滚到底淡出"（见 §1.4 三条细节） |
| R10 | Escape 单点决策链 + capture 注册 + `preventDefault` | **采纳** | 顺序压成一行见 §8.7 |
| R11 | 落地顺序补行结构/键盘路径/Esc/三态 | **采纳** | 已并入附录 B 第 4–8 步 |

### 8.2 侧栏两态高度（32px 行高的连锁账）

**算式**（border 已含在 `h-8` / `h-7` 内，不另加）：

```
H(常驻) = 6 + 32(新建) + 0(小标题) + [n×32 + (n−1)×2] + 28(footer) + 6
H(展开) = 6 + 32(新建) + 20(小标题) + [n×32 + (n−1)×2] + 28(footer) + 6
```

| 画布数 | 常驻态 | 展开态 | 备注 |
|---|---|---|---|
| **0** | **72px** | **124px** | 展开态含 32px 空态行（与列表行同节拍，不用 28px）；常驻态不显示空态行 |
| **1** | **104px** | **124px** | 与"0 个画布"的展开态同高（124px）：空态行与唯一列表行都占一个 32px 槽。这是巧合，不是规律 |
| **3** | **172px** | **192px** | ← **覆盖 §1.4 表里的 160/180**（该表已在上轮改为 172/192；若某版本仍显示 160/180，以本行为准） |
| **20** | 内容 750px → 封顶 | 内容 770px → 封顶 | `max-height: min(70vh, 480px, 100%)` |

**封顶后的可见行数**（`34n − 2 ≤ 列表预算`）：

| 舞台高 | 带高（`−60−12`） | 实际上限 | 常驻可见行 | 展开可见行 |
|---|---|---|---|---|
| 800px | 728 | `min(560,480,728)` = **480** | 12 | 11 |
| 600px | 528 | `min(420,480,528)` = **420** | 10 | 9 |
| 400px | 328 | **328** | 7 | 6 |

- 展开态列表预算 = 上限 − 92；常驻 = 上限 − 72。11 行 = `11×32 + 10×2 = 372px`。
- **两态高度差恒为 20px**（小标题）；封顶时两态**同为上限值**（差 0），所以 20+ 画布时展开/收起也没有高度跳变，不需要额外过渡。
- 20 个画布：展开 11 行可见 / 9 行滚动（约 2 屏），常驻 12 行可见。两态可见行数差 1 行是 20px 小标题的必然结果，不是 bug。

### 8.3 monogram 槽与行内分配

**折叠行（44px 宽）**：行 `mx-1.5` 后行宽 = `44 − 12 = 32px`。

- 槽**占满整行 32px**，不额外留内距。理由：`32 − 12 = 20px` 放不下 2 个拉丁字符（约 26px），留内距会让 monogram 退化成 1 个字符 + 灰边。
- 折叠态行内容 = `[mark 32]` 恰好等于行宽，`text-center`，12px/600。

**展开行（248px 宽）**：行宽 = `248 − 1(border-left) − 12(mx) = 235px`。

```
235 = mark 32 + 6(name 的 margin-inline-start) + name 137 + 2 + pencil 28 + 2 + trash 28
name = 235 − 32 − 6 − 2 − 2 − 56 = 137px ≈ 11.4 个中文字
```

（若统一用 6px gap，则 name = 119px。**定稿取 137px**——name 与两个操作钮之间用 2px，因为它们平时不可见，紧贴是对的。）

**注意：`max-width: 0` 不会让 `gap` / `margin` 归零。** 折叠态若只写 `max-width:0 opacity:0`，行内容 = `32 + 6 + 0 + 2 + 0 + 2 + 0 = 42px > 32px` → mark 被挤出或行被撑破。折叠态必须同时：

```css
.canvas-row { gap: 2px; overflow: hidden; }
.canvas-row__name   { max-width: 0; opacity: 0; margin-inline-start: 0; }  /* margin 一起归零 */
.canvas-row__action { display: none; }   /* 不是 max-width:0；它们 tabIndex=-1，不依赖可聚焦 */
```

展开态恢复 `margin-inline-start: 6px` 与 `display: flex`。name 的 `max-width` 从 0 过渡到 `9rem`（144px，大于 137 即可），走 `--dur-base/--ease-out`；操作钮 `display` 硬切（展开瞬间行还很窄，看不见）。

### 8.4 A 段构成与宽度净减

**8.4.1 构成**

```
A = [ImagePlus 16] + 6 + [name ≤ 15rem] + 6 + [status 12]
  ① ② 档（name 可见）：40 – 280px（name 取 0 – 240）
  ③ 档以下（name display:none）：34px  ← 名字的两个 6px 间隙合成一个
```

- name 是**唯一可收缩项**（`flex-shrink:1; min-w-0; truncate`），其余全部 `shrink-0`。这是 §8.5 全部阈值计算的前提。
- **③ 触发时把 name 换成 `display:none`（不是 `max-width:0`）**，A 因此收敛到 34px。若保留两个间隙（40px），⑤⑥⑦ 的 slack 会从 6–8px 掉到 0–2px。
- 状态图标 12px：`Check`（常态，`text-text-muted`）/ `Loader2`（saving，`text-text-secondary`），**等宽替换**，0 布局位移。**两态必须不同色**——同色会让"正在保存"与"已保存"在视觉上无法区分，而这 12px 图标的全部价值就是状态变化。

**8.4.2 净减账**

| 位置 | 旧（C3，文字） | 新（A 段，图标） | 差 |
|---|---|---|---|
| 自身宽 | 「已保存」3 中文字 = 36px | 12px | −24 |
| 与邻居的间距 | `mr-1` = 4px | `gap` = 6px | +2 |
| **合计** | **40** | **18** | **−22px**（en「Saved」为 −14px；预算取中文 −22） |

→ 胶囊最大内容宽净减 **22px**（§7.7 估 24px，差 2px，以 22 为准；不影响任何阈值）。

**8.4.3 颜色反驳（R7 唯一被改的值）**

`Check` 落在胶囊底（`bg-secondary 95%` 合成值）上的对比：

| 主题 | `--color-success` | 判定 | `--color-text-muted` | 判定 |
|---|---|---|---|---|
| blue（默认 light） | **1.86** | ✗ < 3:1 | 5.04 | ✓ |
| dark | 7.62 | ✓ | 4.66 | ✓ |
| yellow | **1.92** | ✗ | 5.09 | ✓ |
| green | **2.08** | ✗ | 5.11 | ✓ |

这个勾是"已保存"的**唯一视觉证据**，不能靠对比度赌。定稿 `text-text-muted`，并附带消掉 §7.7 担心的"绿勾 = 任务完成"误读。`aria-live="polite"` **只播报 saving**（自动保存每 650ms 一次，否则播报风暴）。

**8.4.4 §4.2 ② 里的 `.canvas-toolbar-status` 选择器：可以删，而且必须删**

- 可以删：状态已无文字、宽 12px 固定，任何宽度下都不需要隐藏。
- **必须删**：若保留在 ② 的选择器里，`≤820px` 会把保存指示一起 `display:none`，那 820px 以下全应用就没有任何保存反馈了（侧栏与菜单里都没有第二处）。

### 8.5 七档断点（全部重算，覆盖 §4.2）

**8.5.1 组件预算**

固定量：`padding-inline 6×2 + border 1×2 = 14`；段间 `8 + 1 + 8 = 17`（两条 = 34）；簇间 6；簇内 2。

| 单元 | 收齐（最小） | 展开（最大） |
|---|---|---|
| A | **34**（③ 之后 name `display:none`，两间隙合成一个）；name 可见但收缩到 0 时是 40 | 280（name=240） |
| B1（选择/平移） | 58（28+2+28） | 58 |
| B2（4 个菜单） | 118（4×28+3×2） | 276（zh）/ 352（en）※ |
| C1（撤销/重做） | 58 | 58 |
| C2（视图▾ + 缩放读数） | 28（仅视图） | 115（zh）/ 117（en） |
| C3（开小窗/导出） | 58（仅图标） | 124（zh）/ 185（en）※ |
| ⋯ | 28 | — |

※ 触发器宽 = `6 + 15(icon) + 4(gap) + label + 2 + 12(chevron) + 6 = 45 + label`；label 按中文 12px/字、拉丁 6.2px/字估（拉丁是估值，见 §8.8）。

**8.5.2 各档内容宽与阈值（团队终值，覆盖 §4.2 表）**

| 档 | 触发时的内容宽 | **最终阈值** | 该档折叠减少量（结构性） |
|---|---|---|---|
| ① 动作文字收 | 876(en) / 743(zh) | **950**（沿用，保守） | 动作标签（en ≈127 / zh ≈66） |
| ② 菜单文字收 | 749(en) / 677(zh) | **820(en) / 755(zh)**（沿用，保守） | 菜单标签 + chevron（en 234 / zh 164） |
| ③ 画布名隐藏 | 466（名字已 0，本条为**美观规则**） | **545**（沿用，保守） | 名字段（已收缩到 0，故 ≈0） |
| ④ 缩放读数收 | 466（420 + 缩放 40 + 簇间 6） | **470** | 缩放读数 40 + 簇间 6 = **46** |
| ⑤ C3 → ⋯ | 420（390 + C3 58 − ⋯ 28） | **426** | C3 58 → ⋯ 28 = **30** |
| ⑥ 视图▾ → ⋯ | 390（356 + 视图 28 + 簇间 6） | **396** | 视图 28 + 簇间 6 = **34** |
| ⑦ 横向滚动 | 356（A34 + B1 58 + B2 118 + C1 58 + ⋯ 28 + 段线 34 + 簇间 12 + padding/border 14） | **362** | 无（兜底，允许溢出滚动） |

- **折叠减少量 46 / 30 / 34 是结构性的**（只由 28px 方格与固定间距决定），与字体渲染无关，可以直接定死；绝对值（阈值）待实测校准。
- 阈值 − 触发时内容宽的 slack：④ **4px**（唯一偏紧，必须实测）、⑤ 6px、⑥ 6px、⑦ 6px。
- ①②③ 沿用「旧实测 − 几何收益」的保守值：它们**比按内容预算算出的（892·759 / 765·693 / 530）更高**，即标签会更早收起 20–60px。这是有意的保守方向——**收早了只是少几个字，收晚了会切按钮**。实测若发现还有余量，再往 892·759 / 765·693 / 530 收。详见 §8.8。
- ④ 的 470 与团队口径 456 差 10px，来源是把 A 从 28 钉到 34（名字 `display:none` 后仍是 34，不是 28）。两种口径都无死区。

**核心原则（写进注释）**：**阈值 = 该档触发时的内容宽 + 6–12px slack；内容宽一律按「画布名已隐藏（A=34）」计算**——name 是唯一可收缩项，在任何阈值之上它都会先让步（truncate），不会溢出。这也是 ③ 必须被重新定义为"美观规则"的原因：466px 以下 name 早已是 0，没有宽度可省，隐藏它是为了不出现 20px 宽的省略号残片。

**8.5.3 反驳 1：⑥ 的 310px 放不下（算式）**

`A 34 + 段线 17 + B1 58 + 簇间 6 + B2 118 + 段线 17 + C1 58 + 簇间 6 + ⋯ 28 + padding/border 14 = 356px`

310 < 356，**差 46px**。310 时这组必然溢出（胶囊撞 `max-width:100%`，尾部被切）。所以 ⑥ 的阈值必须是"触发时内容宽 390 + 6 = **396**"，不是 310；⑦ 的 285 同理偏低：该档内容 356，阈值 **362**。

**8.5.4 反驳 2：⑦ 的圆角裁切需要 padding 补偿**

滚动容器按 padding-box 的圆角裁切，首/末按钮会被 10px 圆角切掉角。补偿：

```css
@container canvas-pill (max-width: 362px) {
  .canvas-pill-layer { justify-content: flex-start; }   /* 居中 + 滚动 = 左侧内容滚不到 */
  .canvas-pill {
    padding-inline: 10px;         /* 6 → 10，每侧 +4，共 +8；尾部 padding 计入滚动溢出，末按钮不会被切 */
    scroll-padding-inline: 10px;  /* 键盘聚焦时预留同样的 10px 槽 */
    overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none;
  }
}
```

- 该档内容因此变成 `356 + 8 = 364`，比阈值 362 大 2px——**这不是溢出事故**：⑦ 已经是滚动容器，超出部分本来就该滚。阈值管的是"何时开始滚"，不是"必须装得下"。
- 纵向不用补偿：胶囊 40px > 按钮 28px，`border-radius` 只吃水平两端。
- **不要**用 `mask-image` 做"淡化裁切"——它会把首尾按钮本身淡成半透明，比直角缺口更难读。

### 8.6 焦点环：选择/平移的最终写法

`aria-pressed` 必须存在，否则 §3.6 的 `[aria-pressed="true"]` 规则是死代码。

```tsx
const toolBtn = (active: boolean) => [
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px]",
  "transition-colors disabled:cursor-not-allowed disabled:opacity-40",
  active
    ? "bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent"
    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
].join(" ");

<button type="button" aria-pressed={tool === "select"} aria-label={t(lang, "canvasSelect")}
        className={toolBtn(tool === "select")} onClick={() => setTool("select")}>
  <MousePointer2 size={15} />
</button>
```

```css
.canvas-pill :where(button, [role="menuitem"]):focus-visible,
.canvas-switcher-panel :where(button, input):focus-visible {
  outline: 2px solid var(--color-accent-text);
  outline-offset: -2px;
}
.canvas-pill button[aria-pressed="true"]:focus-visible { outline-color: var(--color-on-accent); }
```

- 双条件同时成立：`aria-pressed="true"`（匹配选择器）+ `bg-accent`（实心底）。环色 `on-accent` 在 accent 底上 5.17–6.44 ✔；未选中项环色 `accent-text` 对胶囊底 5.00–5.13 ✔。
- 平移同理：`aria-pressed={tool === "pan"}`。
- 同批（R8 范围）：撤销/重做补显式 `aria-label`；侧栏面板 `role="region"` 上的 `aria-expanded` 删掉（它属于 footer 那个 disclosure 按钮，footer 另补 `aria-controls`）。

### 8.7 Escape 单点决策链（一行实现顺序）

**顺序**：`输入框 Esc（`CanvasView.tsx:1250` 的 `isTextInput` 提前 return）→ 胶囊菜单 Esc（`CanvasToolbarMenu` **以 `{capture:true}` 注册** window keydown，命中即 `close() + trigger.focus() + event.preventDefault()`）→ `CanvasView.tsx:1260` 的 Esc 分支**首行加 `if (event.defaultPrevented) return;`** → 侧栏开着则 `closeCanvasMenu()` → 否则清选区 + 复位工具`。

- capture 必须先于 bubble，否则菜单那条晚触发，`defaultPrevented` 永远来不及设，这条链是假的。
- `closeCanvasMenu` 已一并清 `creatingCanvas / newCanvasName / renamingCanvasId / deletingCanvasId`，侧栏子状态一行覆盖。
- 两级 Esc 是想要的：重命名框内第一次 Esc 取消重命名，第二次关面板。

### 8.8 必须实测重校的项

| 项 | 为什么 | 判据（怎么算过） |
|---|---|---|
| **① ≤950** | 唯一依赖拉丁字形宽度的档之一（`Insert/Draw/Arrange/Style` 按 6.2px/字估，实际字体可到 6.8）；现取保守值，实测若有余量可收到 892 / 759 | 名字留 3 个字（36px）时，5 个菜单标签**最后一个字刚好不被截**；再窄 10px 应触发 ① |
| **② ≤820 / ≤755** | 同上，且 label + chevron 一起收，误差放大；实测可收到 765 / 693 | 触发后 4 个触发器均为 28px 方钮，且 A 段名字仍至少剩 36px |
| **④ ≤470** | 全表**唯一 slack 只有 4px** 的档（内容 466），而 466 依赖 28px 满格与 12px 图标的实际渲染；差 5px 就会在 466–470 之间切按钮 | 名字已隐藏（A=34）时，缩放读数仍完整可见到 471px；再窄 1px 应触发 ④ |

⑤⑥⑦（426 / 396 / 362）与 ③（545）**不需要重校**：⑤⑥⑦ 只由 28px 方格与固定间距决定（误差 ≤8px，slack 6px 已覆盖），且它们的**间隔 30 / 34 是结构性的**——就算整体要平移，间隔也不会变，重测时不要动这两个相对值。③ 是美观规则，±20px 不影响任何东西。

> 重校方法沿用 `index.css:634-648` 那套：量胶囊 `scrollWidth` 与 `clientWidth`，逐个 10px 收窄，找到刚好相等的宽度再 −6~12px。**不要**用"把每项宽度加起来"验算。

### 8.9 前端实现顺序（以本节数值为准）

| 步 | 动作 | 验收 |
|---|---|---|
| 1 | `--canvas-*` 变量（含 `--canvas-rail-row-h: 2rem`、`--canvas-rail-mark-w: 2rem`）+ `.canvas-pill-layer` / `.canvas-pill` / `.canvas-seg*` / `.canvas-rail-layer` / `.canvas-rail-fade` | 胶囊 40px 高、layer `align-items: flex-start` |
| 2 | 拆 A/B/C、删 `flex-1`、`data-lang` 挂 `.canvas-pill`、`视图▾` 移到重做之后、保存状态移入 A | §8.4 构成一致 |
| 3 | 控件基类 `h-7 / rounded-[7px] / px-1.5` + 触发器 45+label | 28px 方格栅格 |
| 4 | 七档阈值 **950 / 820·755 / 545 / 470 / 426 / 396 / 362** | §8.8 三个判据 |
| 5 | 侧栏：行高 32、monogram 槽、折叠态 `margin`+`display` 归零、行内二次点击、`F2/Delete`、`aria-current`、`max-height min()`、`.canvas-rail-fade` 叠加层（滚到底淡出）、`scrollIntoView` | §8.2 / §8.3 全部数字 |
| 6 | 胶囊 `inert` + `z-[45]`（编辑器）+ `blur()` | Tab 走不到隐藏控件 |
| 7 | 焦点环 + `aria-pressed` + `aria-label` + `role="status"`（两态不同色）+ 删非法 `aria-expanded` | §8.6 |
| 8 | Escape 链 + 0/1/20+ 三态 + 焦点归还 | §8.7 |


---

## 9. 侧栏第二版（用户否决首版观感后修订）

状态：已落地。**覆盖** §1.4（面板贴边）、§2.4（行首 monogram 无形状、整行 accent）、§3.5（选中行整行 accent 填充）、§8.3（32px 槽）中与下列冲突的表述。

用户在实机（WebView2 截图）上判定首版"太丑，不如以前"，四项同时命中：① 常驻态标记太素；② 整行 accent 太重；③ 面板贴边/圆角怪；④ 展开态行不好看。

### 9.1 结论

| 项 | 首版（§1–§8） | 第二版（现行） | 理由 |
|---|---|---|---|
| 面板位置 | `inset-inline-end: 0`，贴卡片右缘 | **`0.375rem`（6px）内缩** | 贴边 + 只有左侧两个圆角 + `border-right: 0`，在实机上是"从卡片边缘切下来的一条"，右侧接缝处还能看到边框断口。浮起才是这两个浮层（胶囊/侧栏）的共同语言 |
| 面板边框/圆角 | 三边 1px，`10px 0 0 10px` | **四边 1px + 四角 10px** | 内缩后没有接缝要藏；四角与胶囊同值，两者说同一种圆角 |
| 投影 | `-10px 0 24px -16px`（向右的负偏移） | **`0 8px 22px -14px`（对称）** | 负偏移是为"贴边"补的左侧阴影；离边后左右对称，dark 覆盖同步改为 `0 10px 24px -16px` |
| 行首标记 | 纯文字 monogram，无底无形 | **24×24 圆角芯片（7px）**，底 `text-primary 8%`、字 `text-secondary` | 44px 条里一个裸字母读作"文字没渲染完"；芯片给了它形状，也让新增行（`+`）与画布行成为同一种对象 |
| 选中表达 | 整行 `bg-accent + text-on-accent` | **芯片实心 accent + 整行 `accent 14%` 洗底 + 行文字 `text-primary`**；**常驻态只换芯片，不给行洗底** | 44px 里整行 accent 是一枚 32px 蓝色圆角块，重得不像列表项，且与 60px 上方胶囊的 accent 按钮抢注意力。对比度反而更好：芯片 `on-accent/accent` 5.17–6.44 不变，行文字由 `accent-text on accent/15` 的 4.12 改为 `text-primary on accent/14`（>10:1） |
| 常驻态分隔线 | 新建行下 `border-bottom` 常驻 | **仅展开态显示** | 44px 里一条通栏线与"+"和芯片并列，读作表格单元格 |
| 新建行 | 裸 `+`（15px，居中） | `+` 放进同款 24px 芯片 | 与其他行同形，否则一个带形状一个不带 |
| 分组标题缩进 | `0.5rem` | **`0.375rem`** | 与芯片列左缘对齐（芯片左缘 = 行 margin 6px） |
| 行名宽度 | 235 − 32 − 6 − 4 − 56 = 137px | **235 − 24 − 6 − 4 − 56 = 145px**（仍 `max-width: 9rem`） | 芯片从 32 缩到 24，多出的 8px 归名字，约 12 个中文字 |

### 9.2 不变的部分（别顺手改回去）

- 行高 32px、`gap` 2px、`mx-6px`；`--canvas-rail-row-h` 与 `--canvas-ctl-h` 解耦。
- 折叠态 `name` 的 `max-width + margin-inline-start + opacity` 一起归零，操作钮 `display: none`。
- 折叠点行 = 展开、展开点行 = 切换；`F2`/`Delete`；行内二次点击删除；`aria-current`。
- 无 `backdrop-filter`、无 `isolation`、无光斑/扫光/发光竖条/`translateX`、无序号方块。
- `.canvas-rail-fade` 叠加层（`bottom: calc(1.75rem + 0.375rem)`）。

### 9.3 验证方式（本次新增的能力）

`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动 `target/debug` 的 exe，
再用 `scripts/.tmp-cdp.mjs shot <png>` 截图 + `sharp` 裁剪放大判读。**这条路径能拍到真实 WebView2 的观感**，
比 headless Chrome 搭预览页更可信（主界面依赖 Tauri API，纯浏览器下白屏）。注意：杀掉 exe 会连带停掉
`tauri dev` 起的那条 Vite，需重新 `npm run dev`。

### 9.4 深色专属修订（B 压印落地期，`fe-engineer` 实机反馈 → 设计定稿）

**修订 1｜胶囊沟槽：切口 + 单侧受光，不承诺跨主题同一物理方向。**
浅色：`--pill-divider`（2.70–2.96）比胶囊底暗，读作槽；右侧 `1px 0 0 #fff 45%` = 受光下缘。
深色：`--pill-divider` 在深色**比胶囊底亮**（2.70–2.96，方向反了），叠白会成"独立亮线"。改为 `1px 0 0 #fff 18%` 单侧受光。
**不要**在深色加 `-1px 0 0 #000 55%` 暗壁：加了之后整条是 3px 的"带左侧投影的浅色凸条"，比浅色的 2px 更重，还多出第三个结构权重档——而 `--pill-divider` 正是 ≤545px 时唯一还能读出"名字 / 工具 / 动作"三段的结构信号，它的亮度是**资产，不是缺陷**。两种主题都只叠右侧一条受光，布局宽度都仍是 1px，七档预算不变。

**修订 2｜压印方向是不变量。** 凹格必须比面板暗一档。浅色靠"墨"（`text-primary 7%`），深色靠"gutter"（`--color-bg-shell 55%`，实测 `#17181a`；面板 `#25252a`；选中格 `#25262b`）。验收时**逐主题（含自定义）目视方向**，不能只对数值。

**修订 3｜行的圆角与内距按行宽，不按使用频率。** 新建行 / 画布行 / 新建表单 / footer 一律 r8；阶梯为 10（面板·胶囊）→ 8（行）→ 6（20px 标记）。新建行的 `+` 与画布行的字母**共用同一个标记元素**，所以字形中心、文字列（x=32）、右缘天然一致。

**修订 4｜mark 必须"表面相对静止"，选中不许往上浮。** 选中只允许：换填充（凹 → 凸）、换环、换字色，**不加 `translateY`、不加放大**。理由：一行只允许有一个"高度"概念，位移会让 32px 行在高 DPI 下与相邻行的基线错开半像素。

**修订 5｜`--rail-wash` 是 hover 的唯一配方。** 自定义主题下 `--color-bg-hover` 等于面板底（对比 1.00），任何 `hover:bg-bg-hover` 在 rail 内都是"无反馈"。胶囊、菜单、行一律用 `--rail-wash`。

**已知取舍（记录，不改）**：浅色展开态最后一行到 footer 之间约 18px 空气（list 6 + panel 6 + footer 内距）。要收紧就去掉 `.canvas-list` 的 `padding-block-end`，**不要动 `max-height`**。

---

## 10. 侧栏第三版：压印（Letterpress）落地记录

状态：已实现并实机验收（浅色 / 深色 × 常驻 / 展开）。**覆盖** §9 的"整行 accent 洗底 + 芯片底色"表述；§9 的几何、单一标尺、无通栏线、无障碍结论全部保留。

### 10.1 语义（这一版的核心，比任何数值都重要）

**凹陷 = 默认，凸起 = 选中；实心 accent 只给命令。**

- 位置指示（当前画布）**永远不填充 accent**——位置是状态，不是命令。accent 实心只剩三处：胶囊里被按下的工具、菜单 active、删除确认的 `✓`。
- 选中 = 标记"顶起来"（面板色 + 1px 环 + 亮顶边 + 外投影）+ 行名 `text-primary`；**不洗底、不改字重**。
- 好处是量化的：旧版选中承载 1629px² accent 墨、胶囊工具选中只有 784px²，"位置"比"命令"还重 2 倍；现在约 80px²。

### 10.2 令牌与方向不变量

```css
--rail-mark: 1.25rem;   /* 20px 标记 */
--rail-ring: color-mix(in srgb, var(--color-accent-text) 80%, var(--color-border));
--rail-well: color-mix(in srgb, var(--color-text-primary) 7%, transparent);  /* 浅色：靠墨 */
.rail-wash: color-mix(in srgb, var(--color-text-primary) 8%, transparent);
.theme-dark { --rail-well: color-mix(in srgb, var(--color-bg-shell) 55%, transparent); } /* 深色：靠 gutter */
```

**不变量：凹格必须比面板暗一档。** 方向不能靠一个百分比推：`text-primary 7%` 在浅色是"墨"（变暗），在深色是亮色（变亮）——第二轮实机就是因为这个把凹读成了凸、选中读成了最平的一格。验收方式是**逐主题（含自定义）目视方向**，不是只验数值。

深色实测：凹 `#17181a`（Δ1.165）→ 面板 `#25252a` ≈ 选中 `#25262b`（Δ1.01）。深色还补了一条 `#fff 8%` 亮下缘，因为 55% 黑内影在暗底上没有对比。

### 10.3 单一对齐标尺（用户那条 6px 偏差的根治）

**横向位置只由 margin 决定**：面板 `padding-inline: 0`；新建行 / 列表行 / 分组标题 / 表单 / 空态 / 状态行 / footer 一律 `margin-inline: 6px` + 行内零横向 padding；行内 `gap: 0`，间距写在元素自己的 `margin-inline-start`（6 = 标记→文字，2 = 文字→操作钮）。

改前同一列有 **6 种起点**（6 / 8 / 10 / 12 / 14），文字列 36 vs 42；改后统一为「首元素 x = 6、文字 x = 32、右缘 = 6」，常驻态行盒 30×32（面板两侧各 1px 边框）、标记 x = 11（行内居中自然结果，不要手调）。

> `gap` 不能替代 margin：它不随 `max-width: 0` 归零，折叠态会撑破 32px 行——这正是 §8.3 记过的坑。

### 10.4 同时修掉的四个真实缺陷（与视觉无关，但都是"看着能用其实不能用"）

| 缺陷 | 事实 | 修法 |
|---|---|---|
| 自定义主题下 hover 无效 | `utils/theme.ts` 把 `--color-bg-hover` 赋成 `--color-bg-secondary`，面板底就是 `bg-secondary 96%` → 对比 **1.00** | 全部换 `--rail-wash`（胶囊按钮、菜单触发器、菜单项、侧栏行） |
| "切换中"降透明会吃掉位置指示 | `opacity 40%` 下 `--rail-ring` 只剩 **1.57–1.72**，当前画布的环直接消失；`disabled` 还会把握着焦点的按钮移出 tab 序 | 改 `aria-disabled` + handler 早退 + `aria-busy` + 顶部满对比状态行；**不降透明度** |
| 当前行点击无反应 | `switchCanvas` 对同 id 直接 return | 当前行点击 = 收起面板；`aria-label` 用「当前画布：{name}」 |
| 确认 `✓` 键盘不可用 | `autoFocus` 是挂载期行为，而两个分支在同一位置都渲染 `<button>`，React 复用 DOM 节点 → 实测 `focused: false` | 给四个按钮加显式 `key` 强制重挂载；`✓` 环用 `--color-on-danger` |

外加：`Delete` 的 `event.repeat` 判断必须放在 `preventDefault/stopPropagation` **之后**，否则长按会冒到 window 删掉画布图元；四处卸载点（删除取消 / 重命名提交与 Esc / 新建取消 / 切换画布）都要把焦点交回"同语义位置仍存在的元素"，没有则 footer。

### 10.5 深色胶囊段线

`--pill-divider` 在深色比面板亮（2.70–2.96），叠白 45% 会读成一条孤立亮线。定稿（§9.4 修订 1）：深色只叠右侧 `1px 0 0 #fff 18%` 的受光，**不加暗壁**——加了会变成 3px 的"带左侧投影的凸条"，比浅色那 2px 更重，还多一个结构权重档；而这条线正是 ≤545px 时唯一还能读出三段的信号，亮度是资产。
口径：**分割线 = 切口 + 单侧受光，不承诺跨主题同一物理方向**（浅色线比底暗读作槽，深色线比底亮读作接缝）。布局宽度两种主题都仍是 1px，七档预算不变。

### 10.6 验收与未验证

- `tsc --noEmit` 0；`npm run build` 通过（CSS gzip 25.52 kB）；`verify:ui-polish` 15/15、对比度 152 组 no failures。
- 对齐量测（真实 WebView2）：`padding-inline 0/0`，新建行 6/6/234、标记 6 w20、行名 32、操作钮 182、footer 6/6/234。
- 滚动条：删 `padding-inline-end: 2px` 后补 `scrollbar-width: thin`；实测滚动条占 10px、垃圾桶图标右缘到滚动条还有 13px，不被压。行宽从 234 收到 224 时所有行一起收，标尺仍只有一套。
- **未验证**：Δ6「≥9 画布时打开面板的滚动校正」只有静态保证。造 9 个临时画布会写用户的真实 `canvases.json`，不做。
