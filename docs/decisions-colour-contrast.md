# 主题文字对比度：拆分 accent 的填充色与文字色

状态：已实施（2026-10-27）

## 背景

`npm run verify:ui-polish` 长期全绿（56 组色块对比度 0 失败），但界面上次要文字与主题色文字
实际不可读。原因是该脚本只测 `--color-on-*` 在饱和色块上的对比度，**正文前景色从未进入审计**。
补测 120 组后 75 组低于 4.5:1，39 组低于 3.0。

## 结论

### 1. `--color-accent` 拆成两个 token

填充色块与文字颜色对明度的要求相反：色块只需与 `--color-on-accent` 拉开 4.5，文字色却要与
`--color-bg-primary` / `--color-bg-secondary` / `--color-bg-sidebar` 拉开 4.5。一个值无法同时满足。

- `--color-accent`：保持不变，只用于 `bg-*` / `border-*` / 焦点环 / caret。
- `--color-accent-text`：新增，专供 `text-accent-text`（原 161 处 `text-accent` 已全部迁移）。

| 主题 | accent（填充） | accent-text（文字） | 填充块对比度 | 文字对比度（bg/bg2/侧栏合成） |
| --- | --- | --- | --- | --- |
| blue | #2563eb | #245acf | 5.30 | 5.53 / 4.95 / 4.57 |
| dark | #5c7cfa | #738df9 | 5.40 | 5.66 / 4.97 / 5.60 |
| yellow | #c4a24a | #736139 | 6.44 | 5.56 / 5.09 / 4.60 |
| green | #4aaa6a | #37704c | 5.66 | 5.54 / 5.12 / 4.58 |

### 2. `text-muted` / `text-secondary` 按对比度反解，不再凭肉眼

| 主题 | muted 旧 → 新 | secondary 旧 → 新 |
| --- | --- | --- |
| blue | #64748b (4.31) → #596270 (5.58) | 不变 #475569 (6.86) |
| dark | #6c757d (3.67) → #8c8e91 (5.24) | 不变 #adb5bd (8.30) |
| yellow | #a09478 (2.78) → #6b6253 (5.56) | #7a6e55 (4.65) → #605747 (6.59) |
| green | #88a694 (2.50) → #506b5c (5.52) | #5a7a66 (4.50) → #425f4f (6.66) |

括号内为对 `bg-primary` 的比值。yellow/green 的 secondary 在 `bg-secondary` 上原本只有 4.25 / 4.16，
必须一并下沉，否则 muted 达标后会比 secondary 更深，造成层级倒挂。

### 3. 审计口径扩到「真实表面」

`scripts/verify-contrast.mjs` 从 1 组扩到 4 组、144 个组合：

1. `block` — 色块上的 `on-*`（原逻辑，56 组）
2. `text` — 四个文字 tier × `bg-primary` / `bg-secondary` / `bg-sidebar`，外加层级顺序断言
   （primary > secondary > muted，防止把三档压成同一个灰）
3. `composited` — 磨砂卡片实际底色 = `tint%` panel over shell（侧栏 80、编辑器 92），
   取自 `:root` 而非写死；默认 tint 下侧栏合成底色比 `bg-sidebar` 更深，这是第一轮漏掉的量
4. `wash` — 选中行 `bg-accent/15` 洗色上的 `text-accent-text`

`bg-hover` / `bg-active` 不设闸门：瞬时态，行内文字为 `text-primary`。

### 4. 自定义主题改为测量式派生

`src/utils/theme.ts` 原先把 `text-muted` 固定成 `56% textPrimary + 44% bgPrimary`——数学上直接
损失近半对比度，与用户选了什么颜色无关。改为 `tierFor()` 从地面端向正文色求解，取**最浅的达标值**
（保留弱化语义而非复制正文色）；`accentTextFor()` 同理，从用户选定的 accent 向 textPrimary 求解。
`--color-accent-text` 已加入 `CUSTOM_PROPS`，切回预设时会被清除。

## 未采用

- **整体压深 accent**：会让 `bg-accent` 色块与 `on-accent` 的对比失衡，且暗色主题方向相反。
- **只放宽审计阈值**：3:1 只适用于 ≥18.66px 粗体或 ≥24px 的文本，而本次失效集中在 11–12px。

## 未决

- 纸纹（`fractalNoise` opacity 0.035）铺在字形下方会削弱边缘锐度，未量化，需桌面会话确认。
- 壁纸模式下文字压在照片上，对比度上限由「照片本身」决定，代码层无法保证（见下条）。

## 追加：磨砂下限（2026-10-27，两次迭代）

原 `MIN_GLASS_TINT = 0` 允许侧栏完全透明，`text-muted` 直接坐在 shell 色上（3.0–3.9:1）。
`MIN_GLASS_EDITOR_TINT = 40` 允许壁纸模式主卡只有 40% 不透明，正文压在 60% 的照片上
（中灰照片实测 3.16）。

实测各主题在「极端壁纸」与「中灰壁纸」下要保住 4.5:1 所需的 tint：

| 参考面 | blue | dark | yellow | green |
| --- | --- | --- | --- | --- |
| 纯黑/纯白壁纸 | 98 | 97 | 98 | 98 |
| 中灰 #808080 壁纸 | 95 | 92 | 94 | 96 |
| 纯色 shell（无壁纸） | 74 | 0 | 66 | 66 |

结论：**半透明卡片 + 12px 正文 + 4.5:1，在任意壁纸下不可同时成立**。壁纸模式下无论把 tint 提到
多高，照片都会吃掉对比度——只有接近完全不透明才达标，那等于取消壁纸。

### 第一版（已推翻）

把 `MIN_GLASS_TINT` 直接压到 75。结果是滑块只剩 25% 行程，用户反馈「拖了没反应」——
用**削减控件能力**换达标，是把可读性问题转成了可用性问题。已撤销。

### 第二版（现行）

滑块恢复 0–100 全行程，可读性交给运行时提升：

- `MIN_GLASS_TINT = 0`，新增 `GLASS_READABILITY_FLOOR = 75`。
- 侧栏 tint < 75 时，`App.tsx` 在根节点写 `data-contrast="boost"`；`index.css` 里
  `--color-text-muted → var(--color-text-secondary)`、
  `--color-accent-text → color-mix(accent 25%, text-primary)`。
  实测全透明（tint 0，卡片底色 = shell）下：muted 4.74–9.43，accent-text 4.53–12.77，四主题全过。
  代价是极透明时层级从三档塌成两档，属于有意取舍。判定基准取
  `min(sideTint, editorTint)`——壁纸模式下主卡比侧栏低约 20 点，而正文就在主卡上。
- `MIN_GLASS_EDITOR_TINT` / `MAX_GLASS_EDITOR_TINT` / `GLASS_EDITOR_TINT_DROP` 先被抬到
  72/94/6，**同日又改回 40/76/20**（见下一节）。

## 追加：模糊强度为什么被「稀释」掉

用户反馈「有背景图时模糊完全没效果，以前可以」。实测定位到**是我把主卡 tint 抬到 72 造成的**：
主卡只剩 28% 的背景能透出来，`blur` 的作用对象被压到几乎没有观感。

用四组 tint 做对照（同一底纹、同一卡片，只改 blur）：

| 卡片不透明度 | blur 0 / 12 / 40 的观感差异 |
| --- | --- |
| 80% | 三档完全相同（几乎不可辨） |
| 40% | 有差异，偏弱 |
| 20% | 差异明显 |
| 40% + 饱和度 0 / 120 / 200 | 差异明显 |

结论：**模糊的可见度由「背景透出比例」决定，即 `1 - tint`**。tint 80 时只有 20% 的背景参与
模糊，任何 blur 值都接近不可见。这不是接线问题，是合成顺序的必然结果——先模糊背景，再盖一层
不透明度 80% 的底色。

因此：

- `MIN_GLASS_EDITOR_TINT` 72 → **40**，`MAX_GLASS_EDITOR_TINT` 94 → **76**，
  `GLASS_EDITOR_TINT_DROP` 6 → **20**，cap 恢复 `max(side - 6, 0)`。
  侧栏 77 → 主卡 57（背景透出 43%），模糊恢复可见。
- 可读性不再靠抬高 tint，交给 `GLASS_READABILITY_FLOOR` + `data-contrast="boost"`。
- 两个 blur 滑块在 tint > 60 时附一行提示「底色不透明度低于 60% 时模糊才明显」。

## 追加：无背景图时模糊为什么也没反应

`backdrop-filter` 模糊的是卡片背后的像素。没有背景图时背后是单色 shell，模糊单色仍是单色。
为了让滑块在这个状态下也有物理作用，`.app-root` 增加三层 underlay：

```
radial-gradient(72% 58% at 16% 10%, accent 26%, transparent 68%)
radial-gradient(64% 52% at 84% 90%, accent 18%, transparent 70%)
var(--paper-grain)
```

低频色晕响应 blur 与 saturation，高频纸纹被 blur 抹平——这正是滑块承诺的可见变化。
有背景图时 `App.tsx` 在该元素上内联写 `backgroundImage`，三层被壁纸整体替换，互不干扰。

**注**：无背景图时主卡仍保持 `max(glassTint, 92)` 的近实心地板（`App.tsx`），因此主卡上看不出
模糊，效果体现在侧栏。要让主卡也通透，需要用户主动降低不透明度。

## 追加：基础组在有背景图时整组不生效

`App.tsx` 写的是 `hasBackground ? glassBlurBg : glassBlur`，所以有背景图时基础组的三个值全部被
背景组覆盖。用户界面上两组都能拖，但只有一组真正生效——这是「拖了没反应」的另一条成因。

修复：`hasWallpaper` 为真时基础组整组禁用，并标注「已设置背景图，实际生效的是下方一组」。


### 平台层的三条限制

1. **`backdrop-filter` 模糊的是卡片背后**。无背景图时背后是单色 shell，因此需要新增 underlay
   才有可模糊的源（见上一节）。
2. **两组 profile 互相覆盖**。`App.tsx` 用 `hasBackground ? *Bg : *` 取值，所以任何时刻只有一组
   生效；接口上却两组都能拖。
3. **`@media (prefers-reduced-transparency: reduce)`** 把 `backdrop-filter` 直接置为 `none`。
   Windows 关闭「透明效果」时命中，整段磨砂失效，原先界面上没有任何提示。

对应处理：

- 第一版曾移除基础组的 blur/saturate 滑块（理由是它们被背景组覆盖），**已回滚**——滑块本身
  有价值，问题在于没有标明生效条件。
- `hasWallpaper` 为真时基础组禁用并标注覆盖关系；为假时背景组禁用并提示「需先设置背景图」。
- `matchMedia("(prefers-reduced-transparency: reduce)")` 命中时，在磨砂设置顶部显示提示，
  指明去 Windows 设置开启透明效果。

**曾试过但否决**：用 16% 强度的单层色晕充当模糊源——截图显示 blur 0/12/40 无可辨识差异，
强度不足。最终采用 26%/18% 双层色晕叠加纸纹的三层 underlay。


