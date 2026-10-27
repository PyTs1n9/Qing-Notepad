# 大纲（侧边栏视图 + setSelection 示例）

把当前笔记的 Markdown 标题列在笔记侧栏底部，点标题把光标移到那一行。
它是 P1a 两个新能力的可跑样例：`qing.views`（声明式侧边栏树）与
`qing.editor.setSelection`；另加两条命令补齐 `editor:write` 与
`editor:decorate` 的可运行实证。

| | |
| --- | --- |
| 插件 id | `qing.outline` |
| 权限 | `editor:read`、`editor:write`、`editor:decorate`、`editor:selection`、`views`、`notify` |
| 清单 | `package.json`（VS Code 风格） |
| 视图 | `contributes.views: [{ id: "qing.outline.toc", title: "大纲" }]` |
| 入口 | `dist/extension.js`（单文件 ESM） |

## 三条硬约束（写代码前先读）

1. **位置是 CodeMirror 文档偏移**，不是 ProseMirror 位置，也不是行/列：`0` 到
   `getText().length`，按 UTF-16 码元计（`String.prototype.length` 数的那个）。
   `from <= to` 在读取侧恒成立，写选区时 `anchor`/`head` 可以反向（shift+方向键就是）。
2. **文本是 Markdown 源，不是 HTML。** `getText()` 读到什么，保存到磁盘的就是什么；
   把 HTML 交给 `replace()`，它会当成带 HTML 标签的 Markdown 原文存下来。
3. **写操作走编辑器自己的变更管线**：`replace` 与 `setSelection` 都是普通事务，
   落盘、脏标记、撤销历史与手动输入完全一致，插件不要绕过编辑器去持久化。

## 这个示例在演示什么

**树怎么建**：`qing.editor.getText()` 按行扫描，`^#{1,6}\s+` 是标题（ATX），
围栏代码块（```` ``` ```` / `~~~`）里的 `#` 不算；层级按 `#` 数量压栈成树。
`collapsibleState`：有子节点的给 `"expanded"`，叶子 `"none"`（宿主只在承诺了的行画箭头）。
没有标题时给一行 `（这篇没有标题）`，不留空白面板。

**点一行之后**：宿主把**该行的 `id`** 作为参数调用 `qing.outline.focus`，
示例据此重建大纲（保证偏移是当前文档的）再 `setSelection({ anchor: 行首, head: 行首 })`，
光标落在标题行行首。从命令面板跑同一条命令时没有 id，会提示「请在侧栏的大纲面板里点一个标题」。

**一个命令服务整棵树**：所有行都带同一个 `command`，靠行 id 区分目标，
清单里只声明一条命令，命令面板也只会出现一条。

**`qing.views.refresh("qing.outline.toc")`**：编辑器自己的数据变了就调它。
宿主在切换笔记时会自动重取视图根节点；「大纲：刷新」这条命令演示的是另一类情况
（在原地改了标题）。

## 另外两条命令：写入与标记

**「大纲：给选中标题加粗」**（`editor:write`）
- 有选区：把选中文本包成 `**…**`；**已经是 `**…**` 就拆掉**（幂等，连按两次回到原文，
  最短的粗体是 `**a**` 共 5 字符，低于此不判为已加粗）。
- 无选区：提示「请先选中要加粗的文字」，不动文档。
- 边界：`replace({from,to}, text)` 走的是编辑器自己的变更管线，所以落盘、脏标记、
  **Ctrl+Z 可撤销**，与手动输入完全一致。选区会被 CM6 的 change mapping 自然调整。

**「大纲：标记重复词」**（`editor:decorate`）
- 扫全篇，找**长度 ≥3 的拉丁/数字词**（忽略大小写），出现 ≥2 次的，从**第 2 次起**
  每一处都标 `kind: "warning"`（第 1 次是定义，后面才是回声）。key 用 `"dup"`。
- **再跑一次 = 清除**（`setDecorations("dup", [])`），提示「已清除标记」。
- 没有重复词时也走清空：用户删掉重复后再跑一次，旧标记会从屏幕上消失，不会残留。
- 边界：标记是装饰不是编辑，**不动文档内容**；宿主会把标记跟着文本改动一起平移
  （在标记前插字，标记跟着走），插件停用/卸载/更新时宿主自动清空全部标记。

## 构建与打包

```bash
cd examples/qing-outline
npm run typecheck   # tsc --noEmit
npm run build       # src/extension.ts -> dist/extension.js
npm run pack        # package.json + dist/ -> ../qing.outline-1.0.0.qnp
```

`esbuild` 从仓库根目录的 `node_modules` 解析，不装依赖也能构建；打包脚本
`../pack.mjs` 与宿主一样只支持 Windows。

## 已知取舍

- 标题识别只做 ATX（`#`）；Setext（`===`/`---` 下划线）不识别。
- 点击时按当前文档重建大纲再按同一序号定位；如果文档刚被改得面目全非，
  先跑「大纲：刷新」更稳。
- 单视图超过 200 项再考虑虚拟滚动，这是 P1a-2 明确的取舍。
