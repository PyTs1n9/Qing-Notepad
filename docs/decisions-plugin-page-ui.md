# 扩展页 UI 改版（苹果式）决策记录

> 2026-10-29。范围：`src/components/Plugin/` 下的扩展页（`PluginSidebar` + `PluginDetail`），
> 以及共用组件 `PermissionList`。参照系为 macOS「系统设置」（Ventura 之后的分组侧栏 + 内嵌圆角卡片）。
> 相关：`docs/decisions-plugin-system.md`（扩展系统的行为约定）、`topics/tokens-colour.md`（颜色与对比度）、
> `topics/ui-rules.md`（壳层不变量）。

## 现状

- 左栏 `PluginSidebar`（241 行）：`h-9` 标题条 + 32px 搜索框 + 「已安装 / 可用」两组紧凑行（24px 图标底 + 13px 标题 + 11px 副标题），
  中间用 `border-dashed` 分割，底部一行安装/刷新工具条。视觉语言来自 VS Code。
- 右栏 `PluginDetail`（478 行）：`h-9` 面包屑标题条 + 六段平铺 `Section`（权限 / 命令 / 信息 / 日志），
  区块标题为 11px 大写小字，内容多为 `border-border` 描边行。
- 两栏都是「描边 + 小字」的密度风格，没有层级差：标题与正文同为 11–14px，卡片没有深度，主操作和次操作只靠颜色区分。

## 结论

### D1 参照系 = 本仓库工作台概览页（2026-10-29 修订）

> 初版定为 macOS「系统设置」（分组侧栏 + inset grouped）。用户随后给出参考图，
> 该图正是本仓库的 `src/components/Workspace/WorkspaceOverview.tsx`，故修订为：
> **复用工作台概览的卡片语言**，不另造一套苹果式。

采用「左栏分组侧栏 + 右侧（页头 + 数字卡 + 内容卡）」的结构，卡片语言与工作台概览逐类对齐：

| 元素 | 规格（与 `WorkspaceOverview.tsx` 同源） |
| --- | --- |
| 页面容器 | `mx-auto w-full max-w-[880px] px-5 py-5 sm:px-7 sm:py-6` |
| 页头标题 | `brand-face truncate text-[19px] leading-tight` |
| 页头徽章 | `rounded-full border border-accent/15 bg-accent-light px-2 py-0.5 text-[11px] font-semibold text-accent-text` |
| 页头动作 | `h-8 rounded-lg border border-border px-2.5 text-xs font-medium` |
| 数字卡 | `rounded-xl border border-border bg-bg-secondary/40 px-3.5 py-3`，数字 `text-2xl font-semibold tabular-nums` |
| 内容卡 | `rounded-xl border border-border bg-bg-secondary/40` |
| 卡头 | `border-b border-border/70 px-3.5 py-2.5`，标题 `text-xs font-semibold uppercase tracking-[0.12em] text-text-muted` |
| 卡内行 | `rounded-lg px-2 py-2` + `hover:bg-bg-primary/60`；列表 `p-1.5` |

**理由**：工作台概览已经是同一应用里成型的卡片语言，扩展页与它同屏相邻（都渲染在编辑卡里）。
另造一套「苹果式」会让用户在两个页面之间感到两份设计；复用既有类名同时消除了风格漂移的风险，
并把实现风险压到「换类名」级别，而不是「新建一套设计系统」。App Store 详情页需要 hero 截图区与
评分模块，会显著拉长详情区；iOS 设置是单栏列表，会废掉双栏。


### D2 改动范围 = 扩展页 + 共用组件 `PermissionList`

**理由**：`PermissionList` 同时被扩展页详情与「安装权限弹窗」使用。只改一处会让同一个权限列表在两个
场合呈现两套视觉语言，用户刚在弹窗里建立的印象会立刻被详情页推翻。弹窗跟随对齐，两个面保持一致。

### D3 密度：只放宽详情页

- 详情页：hero 图标 40 → 64px，名称 14 → 20px 级别，区块标题 11px 保留但改为常规字重 + 更明确的层级，
  行内 `py-1.5 → py-2`/`py-2.5`，区块间距 `mt-5 → mt-6`。
- 左栏：搜索框 28 → 32px，行高 28 → 34px，其余保持紧凑。

**理由**：苹果风格的「高级感」主要来自字号阶差与留白，而不是圆角。但左栏是扫描型列表，
一屏能看到的扩展数量是真实可用性指标，放宽过多会直接减少约 20% 可见条目。

### D4 信息层级：允许折叠与降级

- 首屏聚焦：hero（图标 / 名称 / 作者 · 版本 / 状态徽章 / 主操作）+ 描述 + 权限 + 命令。
- 「信息」区降级为更轻的次要分组（ID / 许可证 / 来源 / 仓库），视觉权重低于权限与命令。
- 日志保持默认收起的单行入口（现状即如此），不做成常驻区块。

**理由**：现在六段同级平铺，用户要读完 ID 和许可证才能看到命令；分组后首屏信息密度与决策相关度都更高。
日志是排障路径，不是日常路径，展开式入口足够。

### D5 验收方式 = 静态预览页

新增 `preview-plugins.html` + `src/__preview-plugins.tsx`，沿用仓库已有的
`preview-todo.html` / `vite.preview.config.ts` 惯例，用真实 token 与真实 DOM 结构渲染两栏，提供主题切换。

**理由**：本机构建环境无 GUI，`npm run dev` 的观感无法在本地确认（见 `topics/verify-runbook.md`）。
预览页是唯一能让用户肉眼验收、且不需要启动桌面端的路径。

### D6 决策记录

即本文件。每条结论带理由，另列待定问题，避免下一轮改版推翻已定结论。

## 硬约束（实现时必须遵守）

1. **不新增颜色 token**。只用现役 `bg-primary/secondary/sidebar/hover/active`、`text-primary/secondary/muted`、
   `border`、`accent(-light/-text)`、`danger`、`success`。文字用 `text-accent-text`，色块上用 `text-on-*`，
   禁止 `text-white`。
2. **不动 `index.css` 的壳层几何**：`--shell-pad` / `--shell-gutter` / `--shell-top-gap` 由
   `Layout/shellLayout.ts` 单点持有。
3. **动效只用 `--ease-*` / `--dur-*`**，不手写 `cubic-bezier`（`verify:ui-polish` 会判失败）。
4. **禁止在 flex 行容器上写 `w-auto`**（会让子项 `w-full` 静默退回 `max-content`）。
5. **磨砂只走 `.surface-glass`**，不在新组件上直接写 `backdrop-filter`。
6. `PermissionList` 的 props 契约（`permissions` / `missing` / `onRevoke` / `onGrant` / `canRevoke` / `emphasize`）
   不得破坏——安装弹窗依赖它。
7. 改完必须跑 `npx tsc --noEmit` 与 `npm run verify:ui-polish`。

## 实施中的裁定（2026-10-29，落地后回填）

两份规范在施工期间迭代到第 3 版并互相冲突，以下为最终裁定，均已在代码中生效：

| # | 争议 | 裁定 | 理由 |
| --- | --- | --- | --- |
| 1 | 卡片描边 `/70` + `p-[3px]` vs 全量 + `p-1.5` | **全量 `border-border`** | 填充分离度实测仅 1.01–1.27，不参与成形；既然描边是唯一的形，就该给 100% |
| 2 | 区块标题在卡外（句式大小写） vs 卡内（uppercase 0.12em） | **卡内** | 标题进卡头压着分隔线后是「牌匾」不是标题，层级由位置承担；`0.12em` 在中文下同样成立 |
| 3 | 行 hover `bg-bg-primary/60` vs `bg-hover/40` | **`bg-hover/40`** | `bg-bg-primary/60` 在深色主题的分离度只有 **1.01**（卡底 #1b1c20 ≈ primary #1a1b1e），hover 不可见 |
| 4 | 详情行 32 / 34 / 38 | **34px**（13px + `leading-[18px]` + `py-2`） | 38 属于左栏双行；两个数都必须 `min-h-`，360 档折行时自然长到 52 |
| 5 | 卡头标题 `text-secondary` vs `text-muted` | **`text-muted`** | 卡头无行填充覆盖，muted 在卡底 4.91–5.18 达标；「muted 不落填充」指行 hover/选中态 |
| 6 | 按钮 `h-7` vs `h-8` | **`h-8`** | 工作台页头/卡内/`ModalShell` footer 全是 h-8，h-7 是唯一孤例 |
| 7 | 页头 hero 大图标 | **删除** | 底板与纸面分离度 1.04、需补描边、16px 圆角孤例，三个问题随删除一起消失 |
| 8 | 更新 chip 是否带文字（视口查询 vs 容器查询 vs 视隐） | **纯图标 + `sr-only`** | 文字在 192px 行里占 62px，会把标题挤到 5 字；`display:none` 会把唯一的更新信号从无障碍树摘掉，故用 `sr-only` 常驻 |

**其他落地决定**
- 数字卡用 `flex` + `flex-1 min-w-0`，不做按数量的断点；第三格「未授予」为 0 时不渲染（异常指示器，不是指标）。
- 版本号不进数字卡：`text-2xl tabular-nums` 是指标面，`v1.2.3` 会打乱基线，且版本无量级语义。
- 卡头右槽只放动作/状态，不重复数字卡里的计数（同一数字出现两处是纯噪音）。
- 「未安装」与「已安装」是两套结构：前者是决策页（页头+描述+权限卡+信息卡），后者是管理页（+数字卡+命令卡+日志卡+管理卡）。
- 三个断点 640 / 460 / 360，全部用容器查询（`.plugin-detail-scroller` 为容器、`.plugin-detail-body` 承担内边距——`container-type` 的元素不匹配自己的查询）。
- 权限文案**永不截断**；`code` 与快捷键的隐藏放在 360 档而非 460（`notes:write` 是页面唯一的机器可读标识）。

**已知边界（记录，不修）**
- 最小窗口（480）且左卡拖到 240 时，详情卡约 173px、内容宽约 149px，权限标签每行约 5 字；`canvas:read` / `ai:summarize` 这类 23–24 字标签折 5 行＝106px。保持可读、不截断。根治方案是窗口 < 640 时自动折叠左卡（App 级），不是继续压行尺寸。
- 工作台概览页自身的行 hover 在深色主题下分离度 1.01（同一机制问题的既有缺陷），不在本次范围。
- `PermissionPrompt.tsx` 仍是手写 `fixed` 弹窗（无 Escape / 焦点回填），与已迁移的卸载弹窗同类，留待下一轮。

## 待定问题

- 侧栏分组标题是否保留全大写 + 字距（现为 `uppercase tracking-[0.08em]`），还是改成 macOS 风格的
  常规大小写小标题。
- 「已安装 / 可用」两组之间是否仍用虚线分割，还是改为纯留白分组。
- 详情页在窄容器（编辑卡被压缩到 500px 以下）时，hero 的图标与操作按钮是否换行分组。
- 主操作按钮体系：是否统一为「填充主操作 / 描边次操作 / 纯文字危险操作」三档。
