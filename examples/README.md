# 示例插件

四个用来验收 L1 插件机制的最小插件。**都不入索引**，只能「从文件安装」或「从文件夹安装」。

| 目录 | 插件 id | 清单格式 | 用到的权限 |
| --- | --- | --- | --- |
| `qing-hello-headless/` | `qing.hello-headless` | `plugin.json` | `clipboard:write`、`notify` |
| `qing-note-wordcount/` | `qing.note-wordcount` | `plugin.json` | `notes:read`、`notify` |
| `qing-isolation-probe/` | `qing.isolation-probe` | `plugin.json` | `notify` |
| `qing-wordcount-ts/` | `qing.wordcount-ts` | `package.json` | `notes:read`、`notify` |

`qing-wordcount-ts` 与 `qing-note-wordcount` 功能完全相同，区别只在清单格式和源语言：
前者是「`package.json` + TypeScript」，后者是「`plugin.json` + JavaScript」。
这一对就是格式迁移的回归样本——同一个插件，两种写法，装完表现必须一致。

已经构建并打包好，可以直接在「扩展」页 → 「从文件安装」里选：

```
examples/qing.hello-headless-1.0.0.qnp
examples/qing.note-wordcount-1.0.0.qnp
examples/qing.isolation-probe-1.0.0.qnp
examples/qing.wordcount-ts-1.0.0.qnp
```

「从文件夹安装」直接选上表的目录即可（`qing-note-wordcount/` 里同时有 `package.json`
和 `plugin.json`，见下节：那个 `package.json` 没有 `main`，只会被当成构建脚本）。

`qing.isolation-probe` 用来回答「隔离到底成没成立」：装上、在命令面板执行「运行隔离自检」，
提示消息会打印 `window=undefined document=undefined tauri=undefined fetch=blocked`。
四项全对才说明 Worker 拿不到 DOM、拿不到 Tauri IPC、也联不了网。

## 两种清单：`package.json` 与 `plugin.json`

宿主先找 `package.json`，没有再回落 `plugin.json`。判断依据是 **`main`**：一个只用来跑构建的
`package.json`（有 `scripts`、`devDependencies`，没有 `main`）不算清单，会被跳过——
所以老插件在仓库里多一个 `package.json` 也不会被误读。

| `package.json` 写法 | `plugin.json` 写法 | 说明 |
| --- | --- | --- |
| `name` + `publisher` | `id` | 两者都给时 id 是 `` `${publisher}.${name}` ``；只给 `name` 时它本身必须是合法 id（含点） |
| `displayName` / `name` | `name` | 展示名优先用 `displayName` |
| `engines.qing` | `engines.host` | 两种写法等价，同时给时以 `qing` 为准 |
| `contributes.commands[].command` | `contributes.commands[].id` | 同时给时以 `command` 为准 |
| `main: "./dist/extension.js"` | `main: "dist/extension.js"` | 前导 `./` 会被归一化掉，然后照常做越界检查 |
| `activationEvents: ["*"]` | —— | `*` 等价于 `onStartup`（本宿主只有「启动时激活」这一个早激活时机） |
| `apiVersion`（可选，缺省 1） | `apiVersion`（必填） | 都必须等于宿主支持的版本 |
| `dependencies` / `devDependencies` | 非空即拒 | `package.json` 里这两个是正常字段，忽略；`plugin.json` 里出现非空 `dependencies` 仍然直接拒绝 |

其余字段（`description`、`license`、`author`、`repository`、`permissions`）两边一致。
`author` 允许字符串或 `{name, url}`，`repository` 允许字符串或 `{url}`。

推荐用 `package.json`：字段名和 VS Code 一致，插件作者不用学第二套词汇，`dependencies`
之类的 npm 字段也不会因为"看起来像声明"而被拒。`plugin.json` 保留只是为了已经装了的老包
和不喜欢 `publisher` 的极简插件。

## 两个硬约束

1. **产物必须是单文件 ESM。** 宿主用 blob URL 创建 Worker，相对路径 `import`
   在 blob URL 下解析不了。源码里可以拆多个模块，但必须用
   `esbuild --bundle --format=esm` 打成一个文件。
2. **入口文件不能用顶层 `export`。** 宿主把插件正文包进
   `self.__qing_main = async function () { ... }`，这样 `qing` 对象在插件模块级代码
   执行前就已经填好。真正的 ES 模块导出语句在这个包装里是语法错误。

顺带说一句 CommonJS：宿主给了 `module` / `exports` / `require` 三个绑定，所以
`esbuild --format=cjs` 的产物不会因为 `exports is not defined` 直接崩；但这**不是**
模块解析能力，`require(...)` 一律抛 `E_REQUIRE_UNSUPPORTED`，包必须是单文件。

`.qnp` 就是 zip，**根目录**直接放清单（`package.json` 或 `plugin.json`），不要再套一层
文件夹。打包脚本 `examples/pack.mjs` 会把包内文件（`src/`、`node_modules/`、`tsconfig.json`、
`build.mjs`、另一个清单等除外）复制到临时目录再压缩，这样条目就是平的，`dist/` 之类的
子目录也会保留。

## 改代码后

```bash
cd examples/qing-hello-headless
npm install          # 只装 esbuild
npm run build        # src/main.js -> main.js（单文件 ESM）
npm run pack         # main.js + plugin.json -> ../qing.hello-headless-1.0.0.qnp
```

TypeScript 示例多一步类型检查，`esbuild` 会从仓库根目录的 `node_modules` 解析，
不装也能构建：

```bash
cd examples/qing-wordcount-ts
npm run typecheck    # tsc --noEmit，只检查 src/
npm run build        # src/extension.ts -> dist/extension.js
npm run pack         # package.json + dist/ -> ../qing.wordcount-ts-1.0.0.qnp
```

`pack.mjs` 走 PowerShell 的 `Compress-Archive`（它只认 `.zip`，所以先压成 zip 再改名），
和宿主一样只支持 Windows。

## 已知限制（L1）

- `apiVersion: 1` 没有「当前打开的笔记」这个概念，所以字数示例统计的是**整个笔记库**
  （`共 N 篇笔记，M 字`），不是编辑器里那篇。
- 插件无联网能力：Worker 继承主窗口 CSP，`connect-src` 里没有通配符，`fetch` 会直接抛错。
- 插件之间不能互相调用，也不能依赖其它插件。
