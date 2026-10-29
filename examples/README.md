# 示例插件

八个插件示例。**只有 `qing.snippet` 已上架市场**（条目在 `Qing-Notepad-Plugins` 的
`index.json`，应用里能直接看到「安装」按钮）；其余七个不入索引，只能「从文件安装」或「从文件夹安装」。

| 目录 | 插件 id | 清单格式 | 用到的权限 |
| --- | --- | --- | --- |
| `qing-hello-headless/` | `qing.hello-headless` | `plugin.json` | `clipboard:write`、`notify` |
| `qing-note-wordcount/` | `qing.note-wordcount` | `plugin.json` | `notes:read`、`notify` |
| `qing-isolation-probe/` | `qing.isolation-probe` | `plugin.json` | `notify` |
| `qing-wordcount-ts/` | `qing.wordcount-ts` | `package.json` | `notes:read`、`notify` |
| `qing-editor-demo/` | `qing.editor-demo` | `package.json` | `editor:read`、`notify` |
| `qing-outline/` | `qing.outline` | `package.json` | `editor:read`、`editor:selection`、`views`、`notify` |
| `qing-snippet/` | `qing.snippet` | `package.json` | `storage`、`views`、`notify`、`editor:read`、`editor:write`、`editor:selection` |
| `qing-note-tree/` | `qing.note-tree` | `package.json` | `notes:read`、`canvas:read`、`canvas:write`、`ai:summarize`、`storage`、`notify` |

`qing-wordcount-ts` 与 `qing-note-wordcount` 功能完全相同，区别只在清单格式和源语言：
前者是「`package.json` + TypeScript」，后者是「`plugin.json` + JavaScript」。
这一对就是格式迁移的回归样本——同一个插件，两种写法，装完表现必须一致。

`qing-editor-demo` 是 `qing.editor` 的最小可跑样例（选区/整篇统计 + 词频 Top 5），
它的 `README.md` 里写了位置语义（CodeMirror 文档偏移）与文本语义（Markdown 源，不要传 HTML）。

`qing-outline` 是 P1a-2 两个新能力的样例：`qing.views` 侧边栏树 + `qing.editor.setSelection`，
把当前笔记的标题列在侧栏底部、点标题移光标。`README.md` 里有树的构造规则与点击语义。

`qing-snippet` 是第一个**同时用满四个权限面**的样例：`storage` 存片段、`views` 出面板、
`editor:write` 插入、`editor:selection` 把光标放到 `${cursor}` 的位置。
它也是「没有输入 UI 时怎么设计交互」的样本——片段靠选区首行命名、分组靠点分组行传递。
`docs/decisions-plugin-snippet.md` 记了八条取舍，`npm run verify:plugin-snippet` 是它的逻辑门禁
（43 条断言，把 `dist/extension.js` 装进 mock 宿主里跑）。

`qing-note-tree` 是第一个**写画布**的样例：`notes.tree()` 拿目录结构、插件自己算右向树布局、
`canvas.upsertRefNodes` / `upsertRefConnectors` 交给宿主落盘。它证明了「插件给逻辑、宿主给能力」
这条分层能走通——插件全程不知道任何画布条目 id，也不需要碰 board 文件。
`npm run verify:plugin-note-tree` 是它的逻辑门禁（30 条断言，mock 画布按引用键幂等 upsert）。

已经构建并打包好，可以直接在「扩展」页 → 「从文件安装」里选：

```
examples/qing.hello-headless-1.0.0.qnp
examples/qing.note-wordcount-1.0.0.qnp
examples/qing.isolation-probe-1.0.0.qnp
examples/qing.wordcount-ts-1.0.0.qnp
examples/qing.editor-demo-1.0.0.qnp
examples/qing.outline-1.0.0.qnp
examples/qing.snippet-1.0.1.qnp
examples/qing.note-tree-1.0.0.qnp
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
