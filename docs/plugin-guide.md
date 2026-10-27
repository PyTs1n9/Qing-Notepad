# 插件系统使用与开发指南

> 目标宿主 `0.7.3`，`apiVersion: 1`。设计取舍见 `analysis-extension-host.md`，实测记录见 `verification-plugin-l1.md`。

## 1. 这次给青记加了什么

| 能力 | 说明 |
| --- | --- |
| **插件运行时** | 插件代码跑在 **Web Worker** 里（无 `window` / `document` / Tauri IPC），作恶只能调宿主给的 API |
| **安装链路** | `.qnp` / `.zip` / **直接选文件夹** 三种来源；两阶段安装（解压校验 → 授权 → 落盘），含 zip-slip、原生模块、5MB/20MB 限额、NTFS ADS 防护 |
| **权限模型** | 13 个权限码，安装时逐条人话告知，运行时强制；可撤销、可重新授予 |
| **命令面板** | 插件命令进 `Ctrl+Shift+P`，停用插件命令自动消失 |
| **编辑器 API** | 读/写当前笔记（Markdown 源）、选区、语义装饰、移动光标 |
| **侧边栏视图** | 插件可贡献声明式树（点节点触发命令），无贡献时不占一像素 |
| **插件市场** | `index.json` 索引（GitHub → Gitee → JSdelivr 三源兜底），下载地址钉 commit SHA，sha256 强制校验 |
| **隔离增强** | 可选「独立扩展宿主进程」：隐藏 webview + Worker 池，OOM/崩溃只带走宿主，主窗口存活 |
| **示例** | 6 个可安装示例（含 TypeScript + `package.json` 新格式） |

## 2. 如何维护

### 2.1 改完代码跑门禁

```powershell
npx tsc --noEmit
npm run build
npm run verify:plugin-runtime    # 55+ 条：Worker 沙箱、协议、写入纪律
npm run verify:ui-polish         # 15 条 UI 静态审计 + 152 组对比度
. .\env.ps1; $env:CARGO_PROFILE_TEST_DEBUG="0"; cargo test --manifest-path src-tauri/Cargo.toml --lib
```

### 2.2 两个最容易踩的坑

1. **权限码在 Rust 侧**（`plugin_manifest.rs::KNOWN_PERMISSIONS`）。改了必须**重编译**，只跑 `npm run dev` 会看到假的 `unknown permission`——症状和真 bug 一模一样。
2. **扩展宿主页的脚本必须外链**（`<script src=...>`）。全局 CSP 是 `script-src 'self'`，无 `unsafe-inline`，内联脚本会被**静默**拦掉：页面加载成功、零报错、什么都不执行。

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

- `index.json` 条目：`id` / `name` / `version` / `download` / `sha256` / `permissions` / `engines.host`
- **`download` 必须钉 commit SHA**（`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<40位SHA>/examples/<file>`），可变引用会被 `download.mutable` 警告
- **重打包 = 同时改 `sha256` 与 URL 里的 SHA**，否则 `E_SHA256_MISMATCH` 拒装（故意 fail closed）
- 合并 `index.json` 后 CI 自动 purge JSdelivr 缓存；失败才人工介入（`https://purge.jsdelivr.net/gh/<owner>/<repo>@main/index.json`，看 `throttled` 字段，不只看 `finished`）
- 仓库已配双推送：`git push` 一次推 GitHub + Gitee

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

- **id** = `publisher.name`（点分、小写、≥2 段，每段可含 `-`）；没写 `publisher` 时 `name` 必须本身是合法 id
- **`engines.qing`** 必填（也接受 `engines.host`）
- **`main`** 可写 `./dist/extension.js`（`./` 会被归一化）
- 旧格式 `plugin.json` 仍可用，但新插件请用 `package.json`

### 4.3 打包

```js
// build.mjs
import { build } from "esbuild";
await build({ entryPoints: ["src/extension.ts"], bundle: true, format: "esm",
              platform: "browser", target: "es2020", outfile: "dist/extension.js" });
```

产物根目录打成 zip（**根目录直接放 `package.json` + `dist/`**，别多套一层），改名 `.qnp` 可选。

> **两条硬约束**：① 产物**不能有顶层 `import`/`export`**（宿主把正文包进 `self.__qing_main`）；② 不支持 `require()`、原生模块、wasm、多文件——都按安装错误拒绝。

### 4.4 API 速查

位置一律是 **CodeMirror 文档偏移**（`0 … getText().length`，UTF-16 码元）；文本一律是 **Markdown 源**，不是 HTML。

| 命名空间 | 方法 | 权限 |
| --- | --- | --- |
| `qing.commands` | `register(id, handler)` | 声明 `contributes.commands` |
| `qing.editor` | `getText(range?)` | `editor:read` |
| | `getSelection()` → `{from,to,anchor,head,text}` | `editor:read` |
| | `replace({from,to}, text)` | `editor:write` |
| | `setDecorations(key, ranges)` | `editor:decorate` |
| | `setSelection({anchor,head})` | `editor:selection` |
| `qing.views` | `registerTreeDataProvider(viewId, {getChildren})` | `views` |
| | `refresh(viewId)` | `views` |
| `qing.notes` | `list()` / `get(id)` / `create()` / `update()` | `notes:read` / `notes:write` |
| `qing.todo` | 同上 | `todo:read` / `todo:write` |
| `qing.clipboard` | `read()` / `write(text)` | `clipboard:read` / `clipboard:write` |
| `qing.storage` | 插件私有 KV（1 MB 配额） | `storage` |
| `qing.ui` | `toast(msg, tone?)` | `notify` |

装饰 `kind` 只接受语义值：`error` / `warning` / `success` / `muted` / `highlight`（不接受任意 CSS 类名）。

### 4.5 一个最小插件

```ts
// src/extension.ts
declare const qing: any;

qing.commands.register("yourname.text-stats.run", async () => {
  const text = await qing.editor.getText();          // Markdown 源
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9]+/g) || []).length;
  await qing.ui.toast(`共 ${cjk} 字 · ${words} 词`, "success");
});
```

### 4.6 发布到市场

1. 打好包，挂到你自己的 GitHub Release（**固定 tag**，不要用 `main`）
2. 算 sha256：`Get-FileHash .\yourname.text-stats-1.0.0.zip -Algorithm SHA256`
3. 往 `Qing-Notepad-Plugins` 提 PR，在 `index.json` 加一条（`download` 指向 Release 资产、`sha256` 小写 64 位、`permissions` 与包内清单**一致**，否则 `E_INDEX_PERMISSION_MISMATCH` 拒装）
4. 合并后 CI 自动 purge 缓存，用户下次打开扩展页可见

## 5. 已知边界

- **不支持**：多文件包、`require()`、原生模块（`.node`/`.wasm`）、网络访问、跨插件调用、自动更新、直接跑 `.vsix`
- **云笔记**（协同编辑）不在插件 API 范围内，`qing.editor.*` 在云笔记上返回 `E_NO_EDITOR`
- **独立扩展宿主**是可选模式（默认 in-process），代价约 5–15 ms/次 RPC + 约 100–190 MB/会话
- 位置在文档改动后可能漂移（装饰随 `tr.changes` 跟随，但不做复杂重映射）
