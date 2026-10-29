# 当前笔记统计（编辑器 API 示例）

一条命令「统计当前笔记」：有选区就统计选区，否则统计整篇，报出字数与词频 Top 5。
它是 `qing.editor` 的最小可跑样例，也是 P1a 编辑器 API 的回归样本。

| | |
| --- | --- |
| 插件 id | `qing.editor-demo` |
| 权限 | `editor:read`、`notify` |
| 清单 | `package.json`（VS Code 风格，见 `../README.md` 的两种清单一节） |
| 入口 | `dist/extension.js`（`src/extension.ts` 打出来的单文件 ESM） |

## 三条硬约束（写代码前先读）

1. **位置是 CodeMirror 文档偏移**，不是 ProseMirror 位置，也不是行/列：`0` 到
   `getText().length`，按 UTF-16 码元计（也就是 `String.prototype.length` 数的那个）。
   `from <= to` 恒成立，`anchor`/`head` 才告诉你光标在哪一端。
2. **文本是 Markdown 源，不是 HTML。** `getText()` 读到什么，保存到磁盘的就是什么；
   把 HTML 交给 `replace()`，它会当成带 HTML 标签的 Markdown 原文存下来。转换归编辑器管，
   插件不要越俎代庖。
3. **`replace()` 走的是编辑器自己的变更管线**：落盘、脏标记、撤销历史都与手动输入完全一致，
   你不需要也不应该自己写文件。所以"改完没保存"这种情况不存在于这条路径上——
   如果你发现自己想绕过编辑器去持久化，那多半是走错了 API。

其余背景（`E_NO_EDITOR` 什么时候出现、装饰怎么跟随文本、为什么包必须是单文件）见
`src/qing.d.ts` 顶部的两段注释与 `../README.md`。

## 构建与打包

```bash
cd examples/qing-editor-demo
npm run typecheck   # tsc --noEmit，只检查 src/
npm run build       # src/extension.ts -> dist/extension.js（单文件 ESM）
npm run pack        # package.json + dist/ -> ../qing.editor-demo-1.0.0.qnp
```

`esbuild` 会从仓库根目录的 `node_modules` 解析，不装依赖也能构建；打包脚本
`../pack.mjs` 与宿主一样只支持 Windows（走 PowerShell 的 `Compress-Archive`）。

## 为什么它只申请两个权限

`editor:read` 读正文、`notify` 弹提示。它不写正文（不申请 `editor:write`）、不画标记
（不申请 `editor:decorate`）。安装弹窗里显示的权限就是这个插件能做的全部事情——
索引里也会声明同一份权限，两边不一致时宿主会直接拒装（`E_INDEX_PERMISSION_MISMATCH`）。
