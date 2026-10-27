# 磨砂参数（模糊 / 饱和度）可见性与 AI 空状态问候语

日期：2026-10-27（v0.7.2）

## 结论

1. **主卡不透明度不再固定 92%**：无背景图时也按 `deriveGlassEditorTint(sideTint)`
   （侧栏 −20，钳制 40–76）派生，默认 80 → 60。模糊强度与饱和度滑块因此恢复可见效果。
2. **「是否有背景图」只有一个真源**：由 `App.tsx` 的 `customBackgroundUrl` 决定，作为
   `hasWallpaper` 传入 `SettingsModal`；面板不再自行读 `customBackground` 文件名。
3. **平台关闭透明效果时禁用六个滑块**：`prefers-reduced-transparency: reduce` 命中时
   `index.css` 把 `backdrop-filter` 置 none，滑块此时不可能改变任何像素。
4. **AI 空状态问候语按名称规范化输出**：接口名 → 品牌名 → 「未命名接口」；模型名取路径末段；
   两者同名时只提一次。

## 理由

`backdrop-filter` 的可见度约等于 `1 − tint`：合成顺序是「先模糊背景，再盖不透明底色」。
实测（headless Chrome，同底纹、同模糊源、只改 tint）：

| 表面 | blur 0 vs 40 | sat 0 vs 200 |
| --- | --- | --- |
| editor tint 92（旧默认） | 不可辨 | 不可辨 |
| editor tint 60（新默认） | 可见（底纹边缘被抹平） | 明显 |
| rail tint 80 + 全强度条纹壁纸 | 明显 | — |

即使在无壁纸时把底纹加强到 70% 品牌色的点阵，tint 80 下仍不可辨（20% 透出量吃掉细节），
所以「加强底纹」不是解法，降低不透明度才是唯一物理路径。这也与有背景图时的派生规则一致，
消除了「只有壁纸模式才有景深」的不一致。

## 代价（已由用户确认）

- 默认主卡更透；`min(side, editor) < GLASS_READABILITY_FLOOR(75)` 恒成立，
  `data-contrast="boost"` 默认开启，弱化文字升级为次级文字，层级由三档变两档。
- 实测合成对比度在 tint 60 下仍达标：muted 最低 4.86（blue），accent-text 最低 4.81（blue）。
  `verify:ui-polish` 的 `composited` 组已随 `:root` 的 `--glass-tint-editor` 改为 60。

## 未决

- 无壁纸时底纹仍偏弱（品牌色晕 + 3.5% 纸纹），模糊可见但不如有壁纸明显；
  若要在 tint 60 下进一步强化，需要引入更强的图案层，属设计决策。
- `:root` 的 `--glass-tint-editor` 回退值同步为 60（仅用于无 JS 首帧与审计口径）；
  便签 / 贴纸窗口不使用 `.surface-glass`，不受影响。
