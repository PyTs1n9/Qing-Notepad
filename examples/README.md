# 示例插件

两个用来验收 L1 插件机制的最小插件。两者都**不入索引**，只能「从文件安装」。

| 目录 | 插件 id | 用到的权限 |
| --- | --- | --- |
| `qing-hello-headless/` | `qing.hello-headless` | `clipboard:write`、`notify` |
| `qing-note-wordcount/` | `qing.note-wordcount` | `notes:read`、`notify` |

已经构建并打包好，可以直接在「扩展」页 → 「从文件安装」里选：

```
examples/qing.hello-headless-1.0.0.qnp
examples/qing.note-wordcount-1.0.0.qnp
```

## 两个硬约束

1. **产物必须是单文件 ESM。** 宿主用 blob URL 创建 Worker，相对路径 `import`
   在 blob URL 下解析不了。源码里可以拆多个模块，但必须用
   `esbuild --bundle --format=esm` 打成一个文件。
2. **`main.js` 不能用顶层 `export`。** 宿主把插件正文包进
   `self.__qing_main = async function () { ... }`，这样 `qing` 对象在插件模块级代码
   执行前就已经填好。真正的 ES 模块导出语句在这个包装里是语法错误。

`.qnp` 就是 zip，**根目录**直接放 `plugin.json`，不要再套一层文件夹。打包脚本
`examples/pack.mjs` 会把根目录的文件（`src/`、`node_modules/`、`package.json` 除外）
复制到临时目录再压缩，这样条目就是平的。

## 改代码后

```bash
cd examples/qing-hello-headless
npm install          # 只装 esbuild
npm run build        # src/main.js -> main.js（单文件 ESM）
npm run pack         # main.js + plugin.json -> ../qing.hello-headless-1.0.0.qnp
```

`pack.mjs` 走 PowerShell 的 `Compress-Archive`（它只认 `.zip`，所以先压成 zip 再改名），
和宿主一样只支持 Windows。

## 已知限制（L1）

- `apiVersion: 1` 没有「当前打开的笔记」这个概念，所以字数示例统计的是**整个笔记库**
  （`共 N 篇笔记，M 字`），不是编辑器里那篇。
- 插件无联网能力：Worker 继承主窗口 CSP，`connect-src` 里没有通配符，`fetch` 会直接抛错。
- 插件之间不能互相调用，也不能依赖其它插件。
