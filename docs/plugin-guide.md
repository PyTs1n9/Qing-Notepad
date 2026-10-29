# 插件系统使用与开发指南

> 目标宿主 `0.7.3`，`apiVersion: 1`。设计取舍见 `analysis-extension-host.md`，实测记录见 `verification-plugin-l1.md`，进程隔离方案与接线状态见 `plan-plugin-p1b-extension-host.md`。

## 1. 插件系统提供什么

| 能力 | 说明 |
| --- | --- |
| **插件运行时** | 插件代码跑在 **Web Worker** 里（无 `window` / `document` / Tauri IPC），作恶只能调宿主给的 API |
| **安装链路** | `.qnp` / `.zip` / **直接选文件夹** 三种来源；两阶段安装（解压校验 → 授权 → 落盘），含 zip-slip、原生模块、5MB/20MB 限额、NTFS ADS 防护 |
| **权限模型** | 16 个权限码，安装时逐条人话告知，运行时强制；可撤销、可重新授予 |
| **命令面板** | 插件命令进 `Ctrl+Shift+P`，停用插件命令自动消失 |
| **编辑器 API** | 读/写当前笔记（Markdown 源）、选区、语义装饰、移动光标 |
| **侧边栏视图** | 插件可贡献声明式树（点节点触发命令），无贡献时不占一像素 |
| **插件市场** | `index.json` 索引（GitHub → Gitee → JSdelivr 三源兜底），下载地址钉 commit SHA，sha256 强制校验 |
| **隔离增强（未启用）** | 「独立扩展宿主」的传输层已实现（隐藏 webview + Worker 池，`transport.ts::createProtocolTransport`），但当前构建固定走 in-process，**没有用户可见开关**——详见 §5 |
| **示例** | 8 个可安装示例（含 TypeScript + `package.json` 新格式、用满四个权限面的 `qing.snippet`，以及第一个写画布的 `qing.note-tree`） |

## 2. 如何维护

### 2.1 改完代码跑门禁

```powershell
npx tsc --noEmit
npm run build
npm run verify:plugin-runtime    # 58 条：Worker 沙箱、协议、写入纪律、读取路径
npm run verify:plugin-snippet    # 43 条：片段插件的纯逻辑（占位符偏移、导入去重、删除可撤销）
npm run verify:plugin-e2e        # 5 阶段联网端到端：搜索→选择→安装→加载→功能
npm run verify:ui-polish         # 15 条 UI 静态审计 + 152 组对比度
. .\env.ps1; $env:CARGO_PROFILE_TEST_DEBUG="0"; cargo test --manifest-path src-tauri/Cargo.toml --lib
. .\env.ps1; cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored --nocapture   # 联网实测 4 条
```

最后一条是**联网探针**：用宿主真实的 reqwest/TLS 栈去取索引与包，逐域名打印结果。它默认 `#[ignore]`，因为“CDN 挂了导致 CI 红”比“没有检查”更糟；但在排查网络类安装失败时，它给出的是**应用视角**的答案——Node 的 `fetch` 与 curl 的 schannel 经常和 reqwest 不一致，端到端脚本绿了不代表应用里也绿。

### 2.2 四个最容易踩的坑

1. **权限码在 Rust 侧**（`plugin_manifest.rs::KNOWN_PERMISSIONS`）。改了必须**重编译**，只跑 `npm run dev` 会看到假的 `unknown permission`——症状和真 bug 一模一样。
2. **扩展宿主页的脚本必须外链**（`<script src=...>`）。全局 CSP 的 `script-src` 是 `'self' 'wasm-unsafe-eval'`、没有 `unsafe-inline`，内联脚本会被**静默**拦掉：页面加载成功、零报错、什么都不执行。注意 CSP 由宿主在打包产物里注入，`devUrl` 走 Vite（`localhost:8787`）时不注入——所以这个坑通常在 `tauri build` 之后才现形，别用 dev 的正常表现否定它。
3. **权限白名单有第二份，而且在另一个仓库。** `Qing-Notepad-Plugins/scripts/validate-index.mjs` 的 `KNOWN_PERMISSIONS` 必须跟着改——漏了的后果不是报错，而是「插件装得上、市场校验器过不去、于是永远上不了架」。2026-10-28 它停在 8 个码（P1a 之前），`qing.outline` 一直上不去就是卡在这里；补到 13 个之后 `qing.snippet` 才能上架。
4. **`ui.toast` 要 `notify`，漏了会静默失败。** 这是最坏的失败形态：面板能渲染、数据能落盘、命令里的插入逻辑也对，唯独最后一句提示抛 `E_PERMISSION_DENIED`，用户的观感是"点了没反应"。`qing.snippet` 1.0.0 就这样发了出去，详情页错误日志里 7 条拒绝、其余全部正常。**写清单时逐条过 `bridge.ts::REQUIREMENTS`，不要按"我要什么能力"凭意图列。**

### 2.3 加一个新权限码：6 处同步点

| # | 位置 | 漏了会怎样 |
| --- | --- | --- |
| 1 | `plugin_manifest.rs::KNOWN_PERMISSIONS` | `E_PERMISSION_UNKNOWN`，装不上 |
| 2 | `types.ts::PLUGIN_PERMISSIONS` | 类型缺失 |
| 3 | `types.ts::PERMISSION_LABEL_KEYS` | tsc 红 |
| 4 | `i18n.ts` 三处（接口 / zh / en） | 文案缺失 |
| 5 | `bridge.ts::REQUIREMENTS` | 权限闸门不生效 |
| 6 | `PermissionList.tsx::ICONS` | tsc 红、弹窗无图标 |

外加 **2 张蕴含表 / 5 个函数镜像**（`expand_permissions` / `expandPermissions` / `is_grantable` / `hasPermission` / `install.ts::isDeclared`）**必须原样不动**——蕴含关系是产品决策，不是遗漏。最后才改计数绊线 `assert_eq!(KNOWN_PERMISSIONS.len(), N)`，别先改数字关掉拦网。

### 2.4 维护插件市场（`Qing-Notepad-Plugins` 仓库）

两个远端（GitHub `PyTs1n9` / Gitee `PyTs1N9`）的 `main` 必须指向同一个 commit，`git push` 一次推两端。

- `index.json` 顶层是 `schema`（=1）/ `updatedAt` / `plugins[]`；条目字段 `id` / `name` / `description` / `author` / `repo` / `repoGitee` / `version` / `apiVersion` / `engines.host` / `download` / `sha256` / `permissions` / `updatedAt`（`repo` 是 GitHub 地址，`repoGitee` 是同一路径的 Gitee 镜像，详情页分两行显示；缺 `repoGitee` 时只显示一条）
- 改动后先本地跑 `npm run validate`（零依赖校验器 `scripts/validate-index.mjs`，约 195 次规则检查：字段形态、id/权限白名单、semver、sha256 格式、示例孤儿包、可变引用、BOM…）。CI 跑的是同一条命令，所以「本地过 = CI 过」
- **`download` 必须钉 commit SHA**（`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<40位SHA>/examples/<file>`）。宿主自己不检查引用是否可变，这条靠市场仓库校验器的 `download.mutable` **警告**兜住；`@main` / 未固定版本的 jsDelivr 地址同样命中，因为包一重打包 sha256 就会失配
- **重打包 = 同时改 `sha256` 与 URL 里的 SHA**，否则 `E_SHA256_MISMATCH` 拒装（故意 fail closed）
- **删旧包或改错地址 = 客户端 `E_PACKAGE_GONE`**（404/410 不再报成网络故障）。已经发布出去的索引条目一旦指向不存在的文件，用户那边重试多少次都没用，只能靠你修索引
- 合并 `index.json` 后 `purge-jsdelivr` 工作流自动跑（只在 `push: main` 且改动含 `index.json` 时触发）：成功判据是 `status: finished` **且** 不含 `throttled: true`，最多试 3 次仍不行就让 job 红掉；之后还会把 CDN 内容与 GitHub main 逐字节比对，不一致只 `::warning::`（边缘节点非原子，判红会出假警报）。人工补救走 `workflow_dispatch`，或直接请求 `https://purge.jsdelivr.net/gh/<owner>/<repo>@main/index.json`
- 当前索引 5 个条目；应用内 8 个示例里 `qing-editor-demo` / `qing-outline` / `qing-note-tree` 还没上架
  （`qing.snippet` 已于 2026-10-28 上架，包在 `@81e13dc`）

## 3. 如何安装与管理插件（用户）

**三种安装入口**，都走同一条「解压 → 校验 → 授权 → 落盘」链路：

| 入口 | 用法 |
| --- | --- |
| 从文件安装 | 侧栏「从文件安装」，选 `.qnp` 或 `.zip` |
| 从文件夹安装 | 侧栏文件夹图标，选含 `package.json` 的目录（开发期最方便） |
| 从市场安装 | 扩展页「可安装」段点「安装」 |

- **授权弹窗**会列出插件要的每一条权限，可点「同意并安装」或取消
- **管理**：详情页可 停用 / 启用 / 卸载 / 查看错误日志；权限可「撤销」也可「授予」（可逆）
- **更新**：市场有新版本时详情页出现「更新」，新增权限会强制重新授权
- **回滚**：只保留上一版，所以「回滚」只能退一步；上一版目录已被清理时报 `E_NO_ROLLBACK`
- **全局开关**：设置里有「临时停用全部扩展」，文件保留、面板命令全部消失——排查「插件不工作」时先看这个
- 数据落在 `<data>/plugins/<id>/<version>/`，索引缓存 24 小时

## 4. 如何开发插件（作者）

### 4.1 目录结构

```
my-plugin/
├── package.json          # 清单（VS Code 风格）
├── src/
│   ├── extension.ts      # 源码
│   └── qing.d.ts         # API 类型（抄 examples/*/src/qing.d.ts）
├── build.mjs             # esbuild 打包脚本
└── dist/extension.js     # 产物（单文件、无顶层 import/export）
```

`src/qing.d.ts` 是**环境声明**（文件内不写顶层 `import`/`export`，以 `declare const qing: QingApi` 收尾），这样 `extension.ts` 不用 import 任何东西就能拿到类型。带这份文件的示例：`qing-editor-demo`、`qing-outline`、`qing-wordcount-ts`。

### 4.2 `package.json`

```json
{
  "publisher": "yourname",
  "name": "text-stats",
  "displayName": "文本统计",
  "version": "1.0.0",
  "engines": { "qing": ">=0.7.3 <1.0.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onCommand:yourname.text-stats.run"],
  "permissions": ["editor:read", "notify"],
  "contributes": {
    "commands": [
      { "command": "yourname.text-stats.run", "title": "统计当前笔记" }
    ],
    "views": [
      { "id": "yourname.text-stats.panel", "title": "统计" }
    ]
  }
}
```

- **id** = `publisher.name`。规则比看上去严：≥2 段（点分）、总长 ≤64、每段只能含小写字母 / 数字 / `-`，且**必须以小写字母或数字开头、不以 `-` 结尾**。没写 `publisher` 时 `name` 必须本身是合法 id
- **`version`** 必须是严格 semver（`1.0.0`，不接受 `1.0`）
- **`engines.qing`** 必填（也接受 `engines.host`），缺失或为空直接 `E_MANIFEST_INVALID`；不匹配宿主版本 `E_HOST_VERSION`
- **`apiVersion`** 可省（默认 1）。本构建只接受 `1`，写 `2` 报 `E_API_VERSION`
- **`main`** 可写 `./dist/extension.js`（`./` 会被归一化）
- **`activationEvents`** 可省。省略时等价于「本插件每条命令一条 `onCommand:<id>`」。支持的取值：`onStartup`（随应用启动激活）、`onCommand:<id>`。侧栏面板不需要声明激活事件——第一次渲染面板时宿主就会懒启动 Worker；`onView:<id>` 可以写，但它只是意图声明，宿主不解析、也不影响行为
- 旧格式 `plugin.json` 仍可用，但新插件请用 `package.json`

### 4.3 打包

```js
// build.mjs
import { build } from "esbuild";
await build({ entryPoints: ["src/extension.ts"], bundle: true, format: "esm",
              platform: "browser", target: "es2020", charset: "utf8",
              legalComments: "none", outfile: "dist/extension.js" });
```

产物根目录打成 zip（**根目录直接放 `package.json` + `dist/`**，别多套一层），改名 `.qnp` 可选。`charset: "utf8"` 别省，否则中文文案会被转成 `\uXXXX`，包体明显变大。

> **两条硬约束**：① 产物**不能有顶层 `import`/`export`**（宿主把正文包进 `self.__qing_main`）；② 不支持多文件包、`require()`（宿主提供 shim，只会抛 `E_REQUIRE_UNSUPPORTED`）、原生模块、wasm——都按安装错误拒绝。

### 4.4 API 速查

> **新增一个 API 要同时改两处**：`src/plugin/worker-boot.js`（插件真正调用的那个对象）与 `src/plugin/bridge.ts`（宿主的权限表与应答）。两者互不 import，漏掉任何一处都不会编译报错，而是插件拿到 `undefined`、被传输层压成一句没有上下文的 `E_INTERNAL`。`npm run verify:plugin-api` 专门比对这两张表，并检查每个示例插件实际调用的方法都已暴露——加 API 后先跑它。

所有方法都通过 `postMessage` 转发，**每次往返都有 5 秒上限**（见 §4.6）；纯本地注册（`commands.register`、`views.registerTreeDataProvider`、`log`、`on`）不产生往返。

**通用门面**（无权限要求）

| 成员 | 说明 |
| --- | --- |
| `qing.plugin` | `{ id, version }` |
| `qing.permissions` | 已授予权限的副本数组 |
| `qing.apiVersion` / `qing.hostVersion` | 契约版本与宿主版本 |
| `qing.log(...args)` | 写进插件日志（面板详情页可看），单条截断 2000 字符 |
| `qing.on("activate" \| "deactivate", fn)` | 返回取消订阅函数；`activate` 在模块体执行完之后触发 |

**命令**（需在 `contributes.commands` 里声明）

| 方法 | 说明 |
| --- | --- |
| `qing.commands.register(id, handler)` | `handler(itemId?)`——命令来自侧栏树节点时收到该节点 id，来自命令面板时收到 `undefined` |

**编辑器**（`qing.editor.*`）

位置一律是 **CodeMirror 文档偏移**（`0 … getText().length`，UTF-16 码元）；文本一律是 **Markdown 源**，不是 HTML。写入走编辑器自身的变更管线，因此自动保存、脏标记、撤销栈都当作「用户敲的字」处理（`Ctrl+Z` 可撤销）。

| 方法 | 权限 |
| --- | --- |
| `getText(range?)` → 全文或 `[from, to)` 切片 | `editor:read` |
| `getSelection()` → `{from,to,anchor,head,text}`（`from <= to` 有保证） | `editor:read` |
| `replace({from,to}, text)` | `editor:write` |
| `setDecorations(key, ranges)` | `editor:decorate` |
| `setSelection({anchor,head})`（也接受 `{from,to}`） | `editor:selection` |

装饰 `kind` 只接受语义值：`error` / `warning` / `success` / `muted` / `highlight`（不接受任意 CSS 类名）。同一个 `key` 再调一次即替换该 key 的标记，传空数组即清除。

**侧边栏视图**（`qing.views.*`）

| 方法 | 权限 |
| --- | --- |
| `registerTreeDataProvider(viewId, { getChildren })` | 本地注册，不需要权限；只有 `views` 权限的插件才会被渲染成面板 |
| `refresh(viewId)` | `views`，且 `viewId` 必须是本插件自己的 view，否则 `E_PERMISSION_DENIED` |

`getChildren(elementId?)` 返回行数组，每行是 `{ id, label, description?, command?, collapsibleState? }`：`id` 用于取下一层，`command` 只能指向**本插件**的命令，`collapsibleState` 取 `none`/`collapsed`/`expanded`（省略 = 没有子节点）。行必须可 `JSON` 序列化——单个行序列化失败会被单独丢弃并记一条 warn，不会拖垮整个面板。

**笔记 / 待办**

| 方法 | 权限 |
| --- | --- |
| `qing.notes.list()` → `{id,title,tags}[]`（只有元数据，**不含 `categoryId`**） | `notes:read` |
| `qing.notes.tree()` → `{folders:[{id,name,parentId,order}], notes:[{id,title,categoryId,order}]}`，画文件树/结构图用 | `notes:read` |
| `qing.notes.get(id)` → `{id,title,tags,content}`，`content` 是 Markdown，不存在返回 `null` | `notes:read` |
| `qing.notes.create({title,content})` → `{id}`（不会抢走用户当前笔记焦点） | `notes:write` |
| `qing.notes.update(id, {title,content})` | `notes:write` |
| `qing.todo.list()` → `{id,title,completed,priority,dueDate}[]` | `todo:read` |
| `qing.todo.create({title})` → `{id}`（需要有活跃清单） | `todo:write` |
| `qing.todo.update(id, {title,completed})` | `todo:write` |

> **`notes.get` 的 `content` 是 Markdown。** `data/notes/*.md` 里既有 Markdown（现在）也有编辑器 HTML（早期富文本时期写入的），宿主会用 `utils/htmlToMarkdown.ts` 统一转成 Markdown 再交出去——和编辑器加载、文件导出用的是同一套 turndown 规则，只有一处配置。所以「读 → 改 → 写」往返不会丢格式。反过来也别把裸 HTML 塞给 `notes.update`：它会被当成 Markdown 字面量存下去。

**画布引用节点**（`qing.canvas.*`）

插件只能写「引用型节点」：`{ kind:"note", id }` / `{ kind:"folder", id }` / `{ kind:"root", label }`。**拿不到画布条目 id，也拿不到用户画的其它内容**——写入用引用键（`note:<id>` / `folder:<id>` / `root`），读取只返回键本身。

| 方法 | 权限 |
| --- | --- |
| `listRefKeys({boardId?})` → `{boardId, refKeys: string[]}` | `canvas:read` |
| `upsertRefNodes({boardId?, nodes})` → `{idByRefKey, created, updated}` | `canvas:write` |
| `upsertRefConnectors({boardId?, edges})` → `{created}` | `canvas:write` |
| `setNodesHidden({boardId?, refKeys, hidden})` → `{changed}` | `canvas:write` |
| `removeRefNodes({boardId?, refKeys})` → `{removed}` | `canvas:write` |

`boardId` 省略表示「用户当前打开的画布」；不在画布视图、也没有打开的画布时省略会得到 `E_NO_CANVAS`。

**幂等语义**：`upsertRefNodes` 按引用键匹配，**已存在的节点只刷新 `title` / `excerpt` / `summary` / `summaryHash`，不动 `x/y/width/height`**。位置属于用户——插件重跑不会打乱手工排版。节点尺寸须在 40..4000 × 24..4000，单次调用最多 2000 个节点或连线。

`upsertRefConnectors` 的 `edges` 是 `{from, to, style?, startAnchor?, endAnchor?}`，`from`/`to` 传引用键；任一端解析不到就跳过，同向已存在则不重建。`style` 取 `straight` / `orthogonal` / `curve`，锚点取 `top` / `right` / `bottom` / `left`（默认 `right` → `left`，适合右向结构树）。

**AI 概括**

| 方法 | 权限 |
| --- | --- |
| `qing.ai.summarize(noteId)` → `{summary, title}`，空笔记返回 `null` | `ai:summarize` |

跑在用户自己配置的端点上（BYOK），**花用户的钱**：只在用户显式触发的命令里调用，并按内容 hash 缓存结果。没有配置端点时抛 `E_NO_PROVIDER`，单次上限 45 秒。

**剪贴板 / 存储 / 提示**

| 方法 | 权限 |
| --- | --- |
| `qing.clipboard.read()` / `write(text)` | `clipboard:read` / `clipboard:write` |
| `qing.storage.get(key)` / `set(key, value)` / `delete(key)` / `keys()`（插件私有 KV，1 MB） | `storage` |
| `qing.ui.toast(msg, tone?)`，`tone` ∈ `info` / `success` / `danger`（默认 `info`，消息截断 500 字符） | `notify` |

### 4.5 一个最小插件

```ts
// src/extension.ts
// 有 src/qing.d.ts 时删掉下一行，直接拿到类型
declare const qing: any;

qing.commands.register("yourname.text-stats.run", async () => {
  const text = await qing.editor.getText();          // Markdown 源
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9]+/g) || []).length;
  await qing.ui.toast(`共 ${cjk} 字 · ${words} 词`, "success");
});
```

### 4.6 错误码与运行时约束

失败一律以 `PluginError` 抛出，`error.code` 是机器可读的码（`error.message` 只有细节）：

| 码 | 什么时候出现 | 作者该做什么 |
| --- | --- | --- |
| `E_PERMISSION_DENIED` | 调了未授权的宿主方法；`views.refresh` 指向别人的 viewId | 对照 §4.4 补 `permissions` |
| `E_NO_EDITOR` | 当前没有笔记编辑器（待办页 / 设置 / 云笔记） | 提示用户先打开一篇笔记，别在启动时就假设有编辑器 |
| `E_RANGE_INVALID` | `from`/`to` 非整数或越界；装饰 `kind` 不是语义值 | 用 `getText().length` 兜边界 |
| `E_NO_CANVAS` | 画布方法省略了 `boardId`，但用户当前不在任何画布上 | 命令入口提示「先打开画布」，或显式传 `boardId` |
| `E_INVALID_ARGUMENT` | 节点尺寸越界（须 40..4000 × 24..4000）、`ref.kind` 不认识、`boardId` 不存在 | 按 `qing.d.ts` 的类型写，别自己构造 union |
| `E_NO_PROVIDER` | `ai.summarize` 时用户没配置可用的 AI 端点/模型 | 引导去「设置 → AI 接口」，不要重试 |
| `E_TOO_LARGE` | `replace` 超过 1,000,000 字符；装饰超过 1000 段 | 分批写、只标记可见范围 |
| `E_TIMEOUT` | 5 秒内没应答（该插件 Worker 随即被销毁） | 别在 handler 里跑长任务；拆成多次短调用 |
| `E_QUOTA_EXCEEDED` | 插件存储超过 1 MB | 压数据、删旧 key |
| `E_NO_HANDLER` | 命令没 `register`；视图没注册 provider | 查 id 拼写是否与 `contributes` 一致 |
| `E_DISABLED` / `E_NOT_INSTALLED` | 插件被停用 / 记录缺失 | 让用户重新启用；`notes.update` 找不到 id 时也复用 `E_NOT_INSTALLED` |
| `E_REQUIRE_UNSUPPORTED` | 调了 `require()` | 打包成单文件 |
| `E_API_VERSION` / `E_HOST_VERSION` | `apiVersion` 或 `engines` 不匹配 | 改清单，不要试图绕过 |

两条会自己发生的运行时行为，写代码前必须知道：

1. **超时即销毁。** 任何一次宿主调用或命令执行 5 秒不返回，宿主直接干掉该插件的 Worker 并抛 `E_TIMEOUT`；下一次调用会重新启动 Worker。`while(true)` 不是「卡住而已」，是「这一轮全废」。
2. **连续 3 次启动失败会被自动停用。** Worker 崩溃 / 启动抛错累计 3 次（成功启动即清零）后，宿主把插件置为停用并弹提示——用户的观感是「插件自己消失了」。排查入口是详情页的错误日志。

其余限额一览：`storage` 1 MB、`replace` 单次 1,000,000 字符、装饰 1000 段、装饰 key 只取前 64 字符、`toast` 500 字符、`qing.log` 单条 2000 字符。

### 4.7 发布到市场

1. 打好包，挂到你自己的 GitHub Release（**固定 tag**，不要用 `main`）
2. 算 sha256：`Get-FileHash .\yourname.text-stats-1.0.0.zip -Algorithm SHA256`
3. 往 `Qing-Notepad-Plugins` 提 PR，在 `index.json` 加一条（`download` 指向 Release 资产、`sha256` 为 64 位十六进制、`permissions` 与包内清单**一致**，否则 `E_INDEX_PERMISSION_MISMATCH` 拒装）。sha256 校验本身大小写不敏感，小写是市场约定；索引条目缺 `sha256` 直接 `E_SHA256_MISSING`
4. 合并后 CI 自动 purge 缓存，用户下次打开扩展页可见

## 5. 已知边界

- **不支持**：多文件包、`require()`、原生模块（`.node`/`.wasm`）、网络访问、跨插件调用、自动更新、直接跑 `.vsix`。网络访问既没有 API，也基本走不通：宿主 CSP 的 `connect-src` 只放行 IPC 与几个宿主自用端点。跨插件调用的判定分两种清单：`plugin.json` 里 `dependencies` 非空会被拒；`package.json` 的 `dependencies` / `devDependencies` 会被忽略（否则每个真实包都装不上），既不报错也不生效
- **云笔记**（协同编辑）不在插件 API 范围内，`qing.editor.*` 在云笔记上返回 `E_NO_EDITOR`
- **独立扩展宿主当前不可选。** 传输层与隐藏宿主页（`plugin_host.rs` + `public/ext-host.html` + `transport.ts::createProtocolTransport`）都已实现，但 `headless.ts` 固定 `createInProcessTransport()`，没有任何设置项或启动参数能切过去；P1b 计划里的「第 7 步模式开关」尚未做。代价参考：约 5–15 ms/次 RPC、约 100–190 MB/会话（两组实测，取区间）
- 位置在文档改动后可能漂移（装饰随 `tr.changes` 跟随，但不做复杂重映射）

## 6. 端到端验收：搜索 → 选择 → 安装 → 加载 → 功能

`npm run verify:plugin-e2e` 把整条链路走一遍（需要联网）。它用的是真实索引、真实安装包、真实 `worker-boot.js` 与真实插件产物；宿主侧（`bridge.ts` 的权限表与应答）由脚本按同一张表模拟——因为它依赖 Tauri IPC，不能在 Node 里跑。

| 阶段 | 脚本做什么 | 成功判据 | 失败时界面应看到 |
| --- | --- | --- | --- |
| 1 搜索 | 按 github → gitee → jsdelivr 取索引，校验 `schema=1` | 取到 ≥1 条目，并报告来源与耗时 | 「索引不可用」，**不是**空列表 |
| 2 选择 | 条目字段、`download` 是否钉 40 位 SHA、权限白名单、`engines` 是否兼容 | 有一条被判定为「可装」 | 条目拒绝安装：`E_HOST_VERSION` / `E_PERMISSION_UNKNOWN` |
| 3 安装 | 下载（cdn → fastly → gcore）→ sha256 → 解包防线 → 清单 → 落盘 | hash 与索引一致，文件落到 `plugins/<id>/<version>/` | `E_PACKAGE_GONE` / `E_NETWORK` / `E_SHA256_MISMATCH` / `E_ZIP_SLIP` / `E_TOO_LARGE` / `E_INDEX_PERMISSION_MISMATCH` |
| 4 加载 | 产物无顶层 `import`/`export`、有命令贡献、真启动 Worker 并等 `ready` | Worker 应答 `call` | 「加载失败」+ 详情页错误日志（`E_NO_HANDLER`） |
| 5 功能 | 下一条命令，断言**可观测结果**（toast 文案 / 剪贴板内容） | 与脚本独立计算的结果一致 | 命令失败提示 + 日志（`E_PERMISSION_DENIED` / `E_TIMEOUT` / `E_NO_EDITOR`） |

已实测通过（宿主 0.7.3，2026-10-27）：

```
[1/5] 搜索  PASS  source=gitee 4 条 393ms（前序源失败：github: fetch failed）
[2/5] 选择  PASS  qing.hello-headless@1.0.0 engines=>=0.7.3 <1.0.0 pinned@94e30d0
[3/5] 安装  PASS  1178B via fastly.jsdelivr.net sha256✓（cdn FAIL → fastly 619ms）
[4/5] 加载  PASS  main.js 868B 无顶层 import/export，命令 qing.hello-headless.run
[5/5] 功能  PASS  剪贴板←「2026-10-27T21:02:44.812+08:00」 toast 同文案
```

三个插件均已通过（`qing.hello-headless` 走 `plugin.json`、`qing.note-wordcount` 走 `plugin.json`、`qing.wordcount-ts` 走 `package.json`），覆盖 `clipboard:write` 与 `notes:read` 两类权限面。

**失败路径也验过**，不靠「能跑通」自证：

- `--tamper`（下载后翻一个字节）→ 阶段 3 停在 `E_SHA256_MISMATCH：索引登记 d98e8bcc…，实际 fa9dd935…`，并保留现场目录供排查
- `--plugin qing.does-not-exist` → 阶段 2 停在「索引里没有该 id」，不会继续去下载

### 6.1 必须在应用窗口里人工过的三步

脚本覆盖不到 UI 与 Rust 落盘，这三步要人工点一次（尤其发版前）：

1. **搜索**：打开扩展页 → 「可安装」段有条目。判据：来源是 `gitee` 或 `cache`，列表非空。
2. **安装**：点「安装」→ 授权弹窗逐条列出权限 → 「同意并安装」。判据：弹窗条目数与清单 `permissions` 一致；取消后 `plugins/<id>/` 下无残留。
3. **功能**：`Ctrl+Shift+P` 搜命令标题 → 回车。判据：toast 文案与脚本阶段 5 的输出一致。

**2026-10-27 21:24–21:28 已在真实应用里走通一次**（dev 构建，数据目录 `E://QingNotepad//data`），当时的证据链：

| 时间 | 磁盘/系统证据 | 对应阶段 |
| --- | --- | --- |
| 21:24:14 | `index-cache.json` 刷新，`source = gitee`，4 条 | 搜索（GitHub 不通 → Gitee 兜底） |
| 21:28:22 | `.staging` 0 → 1 项 | 安装第一阶段（解压到暂存） |
| 21:28:25 | `installed.json` 0 → 1 条（`source=index`、`perms=[clipboard:write,notify]`），`.staging` 归零，`plugins/qing.hello-headless/1.0.0/` 出现 `main.js` + `plugin.json` | 授权 + 落盘 |
| 21:28:25 | 落盘文件与包内文件 sha256 逐一相同 | 完整性 |
| 21:28:37 | 系统剪贴板 = `2026-10-27T21:28:37.588+08:00` | 功能（命令在应用内真实执行） |

### 6.2 安装期错误码：哪个值得重试

同一个「装不上」在界面上有十几种成因，处置完全不同。下表按“重试有没有用”分组，全部有代码或实测支撑：

| 码 | 含义 | 重试有用？ | 建议动作 |
| --- | --- | --- | --- |
| `E_NETWORK` | 三个下载域名全不可达；或 CDN 回 5xx / 403 限流 | **有** | 换网络、稍后再试；文案里会列出试过哪些域名 |
| `E_PACKAGE_GONE` | 索引指向的文件不存在（404/410） | **没有** | 刷新索引；仍失败说明作者删了包或改错了地址，找作者 |
| `E_SHA256_MISMATCH` | 下到的字节与索引登记不符 | 没有 | CDN 缓存脏或索引没同步，刷新索引后找作者 |
| `E_SHA256_MISSING` | 索引条目缺 `sha256` | 没有 | 作者补字段 |
| `E_TOO_LARGE` / `E_TOO_MANY_FILES` | 包超 20 MB / 单文件超 5 MB / 超 2000 个文件 | 没有 | 作者减包 |
| `E_ZIP_SLIP` | 条目名含 `..`、绝对路径或 NTFS 数据流 | 没有 | 恶意或损坏包，别装 |
| `E_NATIVE_MODULE` | 包内含 `.node` / `.wasm` | 没有 | 平台不支持，找作者 |
| `E_MANIFEST_INVALID` / `E_MISSING_MAIN` | 清单缺字段或 `main` 指向的文件不在包内 | 没有 | 作者修包 |
| `E_PERMISSION_UNKNOWN` | 清单里写了宿主不认识的权限码 | 没有 | 多为宿主版本旧，升级应用 |
| `E_HOST_VERSION` / `E_API_VERSION` | 插件要求的宿主版本或契约版本不匹配 | 没有 | 升级应用或装旧版插件 |
| `E_INDEX_PERMISSION_MISMATCH` | 索引广告的权限与包内清单不一致 | 没有 | 作者改索引；这是故意拒装 |
| `E_IO` | 本地磁盘读写失败（权限、只读、空间） | 有时 | 查数据目录权限 |

实测证据（宿主 0.7.3，2026-10-27，`cargo test --lib -- --ignored`）：

```
[candidate] cdn.jsdelivr.net    ERR E_NETWORK: error sending request for url (…)
[candidate] fastly.jsdelivr.net OK 1178B
[candidate] gcore.jsdelivr.net  OK 1178B
[download]  1178 bytes            # sha256 与索引一致
[index]     source=gitee schema=1 plugins=4
[missing]   E_PACKAGE_GONE: HTTP 404   # 未跨镜像重试
```

### 6.3 已知的两处断点

- **全源不可达且本地无缓存**：`plugin_fetch_index` 返回 `status: "missing"`，界面显示空列表且不提示——`missing` 的语义本来是「索引仓库不存在」，目前和「网络全挂」共用一个状态。
- **下载域名单点**：已加 cdn → fastly → gcore 回退，但三个域名属于同一家 CDN；若整体不可达，只能等用户在「从文件安装」里手动装包。索引格式目前没有多镜像字段。
