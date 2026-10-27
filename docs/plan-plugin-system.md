# Qing Notepad 插件扩展机制：完整落地方案

> 决策依据见 `docs/decisions-plugin-system.md`。本文件是实施方案，包含规范、接口、
> 加载隔离、安装更新、版本依赖、安全模型、文件级改动与分阶段计划。
> 目标宿主版本：`0.8.0` 起（`apiVersion: 1`）。

---

## 0. 一句话架构

宿主把插件当**不受信代码**处理：纯逻辑插件关进 Web Worker，带界面的插件关进独立窗口，
两者都只能通过宿主桥调用**被权限声明限定**的最小 API 集合，插件代码本身永不进入主窗口上下文。

---

## 1. 总体架构

```
┌──────────────────────────── 主窗口 (label: main) ────────────────────────────┐
│  React App / Zustand stores / TipTap                                        │
│                                                                             │
│  src/plugin/registry.ts   插件注册表 + 激活器（activation events）           │
│  src/plugin/bridge.ts     权限校验 + RPC 分发（唯一出口）                    │
│         │                                                                   │
│         │ postMessage                       │ invoke(仅白名单命令)          │
│         ▼                                   ▼                               │
│  ┌──────────────────┐              ┌──────────────────────┐                 │
│  │ Worker (blob)    │              │ Rust: plugin.rs      │                 │
│  │ 无 DOM / 无 IPC  │              │ 安装·卸载·启用·存储  │                 │
│  │ 无 fs / 无网络   │              └──────────────────────┘                 │
│  └──────────────────┘                        │                              │
└──────────────────────────────────────────────┼──────────────────────────────┘
                                               │ qplugin:// 协议（根目录 jail）
┌──────────────────── 插件窗口 (label: plugin-<id>) ─────────────────────────┐
│  文档来源：http://qplugin.localhost/<id>/index.html                        │
│  CSP：宿主按权限生成（默认 connect-src 'none'）                            │
│  IPC：capability 按 label 收紧，只允许 core:event + plugin_host_call       │
└────────────────────────────────────────────────────────────────────────────┘
```

**两条轨道的判定规则**：`plugin.json` 里有 `ui.entry` → Track B；只有 `main` → Track A。
两者可以同时存在（一个插件既有视图又提供命令），此时以 Track B 为主，`main` 在插件窗口内加载。

### 1.1 数据布局

```
<data>/                                  ← 沿用现有唯一真源，不新增数据根
├── plugins/
│   ├── installed.json                   ← 安装清单（版本、启用态、授权、时间）
│   ├── .staging/<id>/                   ← 解压中转，校验通过后原子 rename
│   └── <id>/
│       ├── 1.2.0/                       ← 版本目录，保留上一版以支持回滚
│       │   ├── plugin.json
│       │   ├── main.js
│       │   ├── index.html
│       │   └── assets/
│       ├── 1.1.0/
│       └── storage.json                 ← 插件私有键值，宿主代读写
```

插件目录位于现有数据根之下，因此**不需要修改 `fs:scope`**，也不需要新增
`register_startup_roots` 的注册逻辑（用户迁移自定义数据目录时自动跟随）。

---

## 2. 插件规范

### 2.1 包格式

- 扩展名 `.qnp`，本质是 **zip**（store 或 deflate）。
- 根目录必须直接包含 `plugin.json`（不允许再套一层文件夹）。
- 文件名固定 `<id>-<version>.qnp`，例如 `com.example.markdown-toc-1.2.0.qnp`。
- 解压限制（Rust 侧强制）：总解压大小 ≤ 20 MB、文件数 ≤ 2000、单文件 ≤ 5 MB。
- **禁止**：`.dll` `.node` `.exe` `.so` `.dylib`（含大小写变体）。v1 也不接受 `.wasm`，
  这条是为了堵住「用原生模块绕过隔离」的路径。
- 拒绝路径穿越：条目名规范化后必须仍在包根内，拒绝 `..`、前导 `/`、`C:`、
  以及符号链接/硬链接条目（zip slip）。

### 2.2 `plugin.json` 完整字段

```json
{
  "id": "com.example.markdown-toc",
  "name": "Markdown 目录",
  "version": "1.2.0",
  "apiVersion": 1,
  "engines": { "host": ">=0.8.0 <1.0.0" },
  "description": "为当前笔记生成目录并跳转。",
  "author": { "name": "example", "url": "https://github.com/example" },
  "license": "MIT",
  "repository": "https://github.com/example/qing-toc",
  "icon": "assets/icon.png",
  "keywords": ["markdown", "toc"],

  "main": "main.js",
  "ui": { "entry": "index.html", "width": 720, "height": 560, "modal": false },

  "activationEvents": ["onView:com.example.markdown-toc.panel"],
  "permissions": ["storage", "notes:read", "clipboard:write"],

  "contributes": {
    "commands": [
      { "id": "com.example.markdown-toc.build", "title": "生成目录", "category": "目录" }
    ],
    "views": [
      {
        "id": "com.example.markdown-toc.panel",
        "title": "目录",
        "icon": "list",
        "location": "activitybar",
        "order": 120
      }
    ]
  }
}
```

字段约束：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 反向域名式，`^[a-z0-9]+(\.[a-z0-9-]+)+$`，长度 ≤ 64，全局唯一，**安装后不可变** |
| `version` | 是 | 严格 semver（`x.y.z`，允许 `-prerelease`） |
| `apiVersion` | 是 | 整数，v1 阶段只接受 `1` |
| `engines.host` | 是 | semver range，须与当前 `APP_VERSION` 匹配才可安装/加载 |
| `main` / `ui.entry` | 至少一个 | 相对路径，必须落在包内 |
| `permissions` | 否 | 缺省 = 零权限 |
| `activationEvents` | 否 | 缺省 = 按 `contributes` 推导（有 view 则 `onView:<id>`，有 command 则 `onCommand:<id>`） |
| `contributes.*.id` | 是 | 建议以插件 id 为前缀，避免与其他插件冲突（宿主只做去重校验，不强制） |

### 2.3 权限清单（v1 全部集合）

| 权限 | 授予的能力 | 用户可见说明 |
| --- | --- | --- |
| `storage` | 插件私有的 `storage.json` 键值读写，配额 1 MB | 保存插件设置 |
| `notes:read` | `notes.list()` / `notes.get()`，仅返回标题、标签、纯文本正文 | 读取你的笔记 |
| `notes:write` | `notes.create()` / `notes.update()`，含 `notes:read` | 修改你的笔记 |
| `todo:read` | `todo.list()` | 读取待办 |
| `todo:write` | `todo.create()` / `todo.update()`，含 `todo:read` | 修改待办 |
| `clipboard:read` | `clipboard.read()` | 读取剪贴板 |
| `clipboard:write` | `clipboard.write()` | 写入剪贴板 |
| `network:<origin>` | 放开插件页 CSP 的 `connect-src`（`network:*` 表示任意 https） | 访问网络 |
| `notify` | `ui.toast()` 主动弹出 | 发送通知 |
| `dialog:open` | 打开系统文件选择器（结果路径不返回给插件） | 打开你的文件 |

**默认零权限。** 未声明的 API 调用直接返回 `E_PERMISSION_DENIED`，不是静默失败。

### 2.4 贡献点（v1）

- `contributes.commands[]` → 命令面板条目。点击时激活插件并派发 `commands.execute(id)`。
- `contributes.views[]` → ActivityBar 图标（`location: "activitybar"`）+ 主区视图。
  `icon` 取 `lucide-react` 的图标名白名单（沿用小写名），未知值回退为 `Puzzle`。
- 命令可以「无 UI」，但**视图必须同时有 `ui.entry`**。

### 2.5 激活事件

| 事件 | 触发时机 | 说明 |
| --- | --- | --- |
| `onCommand:<id>` | 命令面板执行该命令前 | 惰性激活的默认方式 |
| `onView:<id>` | 视图首次被展示前 | |
| `onStartup` | 宿主首批渲染完成后 | 需要额外审批：启动即运行的插件在索引里必须标注 |

### 2.6 构建约束（写进开发者文档）

1. **必须产出单文件 ESM**（`esbuild --bundle --format=esm`）。Track A 用 blob worker 加载，
   相对路径 import 在 blob URL 下无法解析。
2. **不得依赖 React / 宿主源码**。插件 UI 是独立文档，宿主只注入 `window.qing`。
3. **不得使用 `eval` / `new Function`**：插件页面 CSP 不含 `unsafe-eval`。
4. **不得使用 `localStorage` 存业务数据**：同协议源下所有插件共享存储，改用 `storage` API。

---

## 3. 宿主 API

### 3.1 命名空间

Track B 注入 `window.qing`；Track A 在 worker 全局拿到同名对象（无 DOM 相关方法）。
两者签名一致，由同一份 `apiVersion: 1` 定义。

```ts
interface QingApi {
  readonly apiVersion: number;          // 1
  readonly hostVersion: string;         // "0.8.0"
  readonly plugin: { id: string; version: string };
  readonly permissions: readonly string[];

  log(...args: unknown[]): void;

  commands: {
    register(id: string, handler: () => unknown | Promise<unknown>): Disposable;
    execute(id: string): Promise<unknown>;
  };

  storage: {                            // 需 storage
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };

  notes: {                              // 需 notes:read / notes:write
    list(): Promise<NoteSummary[]>;
    get(id: string): Promise<NoteDetail | null>;
    create(input: { title: string; content: string }): Promise<{ id: string }>;
    update(id: string, patch: { title?: string; content?: string }): Promise<void>;
  };

  todo: { /* 同构，v1 只有 list / create / update */ };

  clipboard: { read(): Promise<string>; write(text: string): Promise<void> };

  ui: { toast(message: string, tone?: "info" | "success" | "danger"): void };

  view: {                               // 仅 Track B
    getState(): Promise<{ theme: "dark" | "light"; lang: "zh" | "en" }>;
    onThemeChange(cb: (t: "dark" | "light") => void): Disposable;
    close(): void;
  };

  on(event: "activate" | "deactivate", cb: () => void): Disposable;
}
```

**为什么只有这些**：v1 的 API 面越小，将来新增的自由度越大。每加一个方法都是一次
不可撤回的公开承诺。`view.setSize` / `selection` / 编辑器操作一律留到 `apiVersion: 2`。

### 3.2 契约与版本

- `apiVersion` 是**接口契约**编号；宿主只承诺同一编号内向后兼容（新增可选方法算兼容，
  改签名或删方法算 `apiVersion + 1`）。
- 宿主侧维护 `SUPPORTED_API_VERSIONS = [1]`。插件声明的编号不在列表内 → 拒绝激活并提示。
- `hostVersion` 只用于插件自己的降级判断，宿主不读它。

---

## 4. 加载与隔离

### 4.1 选型对比（为什么是自定义协议 + Worker）

| | 方案 A：自定义协议 + 双轨（推荐） | 方案 B：asset 协议加载 | 方案 C：同进程 `import()` |
| --- | --- | --- | --- |
| 技术栈 | `register_asynchronous_uri_scheme_protocol` + blob worker + 独立窗口 | 复用 `asset:` 协议 + 主窗口 CSP 放开 `asset:` | 直接 `import(pluginUrl)` |
| 为什么适合 | 协议处理器天然能做根目录 jail、能按插件生成 CSP；worker 拦截掉 IPC 与 DOM | 零新增 Rust 代码 | 改动最小 |
| 开发难度 | 中（协议 + 权限推导 + 窗口生命周期） | 低 | 低 |
| 维护成本 | 中：协议与 CSP 生成逻辑需要跟权限表同步 | 低 | 低 |
| 目标地区可用性 | 本地协议，无网络依赖 | 同 | 同 |
| 你得自己管的东西 | 协议路径校验、CSP 生成、窗口回收 | CSP 放开范围（`asset:` 覆盖 `$APPDATA` 与对话框选中的任意路径） | **一切**：插件与主程序同权限 |
| 主要风险 | Windows 下自定义协议的 origin 与 IPC 注入需实测（见阶段 0） | 把脚本执行权扩到「数据目录 + 用户任选路径」 | 插件可读写整个数据目录、可解密凭据、可读 Supabase 会话 |

**推荐：方案 A。** 决定性理由：这是唯一能在**不改动主窗口 CSP、不给任意外部路径脚本执行权**的
前提下，拿到真实隔离边界的方案。

### 4.2 Track A：headless 运行时

```
pluginStore.enable(id)
  → bridge.activate(id)
  → 读 <data>/plugins/<id>/<ver>/main.js （fs:allow-read-text-file，在既有 scope 内）
  → new Blob([source], { type: "text/javascript" })
  → new Worker(URL.createObjectURL(blob), { type: "module" })
  → 首帧发送 { type: "init", plugin, permissions, hostVersion }
  → 插件回 { type: "ready" }，bridge 记为 running
```

RPC 协议（请求-响应 + 单向事件）：

```ts
// 宿主 → 插件
{ t: "init", id, version, apiVersion, permissions, hostVersion }
{ t: "call", rid, ns: "commands", method: "execute", args: ["..."] }
{ t: "event", name: "activate" | "deactivate" }
// 插件 → 宿主
{ t: "ready" }
{ t: "rpc", rid, ns: "storage", method: "get", args: ["key"] }
{ t: "res", rid, ok: true, value: null } | { t: "res", rid, ok: false, code: "E_PERMISSION_DENIED" }
{ t: "log", level: "info", args: [...] }
```

**隔离性质**（这是方案成立的前提，必须写进文档）：
- Worker 全局没有 `window` / `document` / `fetch` 的宿主上下文，也拿不到
  `window.__TAURI_INTERNALS__`，因此**无法直接调用任何 Tauri 命令**。
- 唯一的出站通道是 `postMessage`，而 `bridge.ts` 在转发前校验 `permissions`。
- 因此 Track A 的权限检查是**强制执行**的，不是约定。

### 4.3 Track B：UI 运行时

1. 创建窗口：`new WebviewWindow(\`plugin-${id}\`, { url: \`http://qplugin.localhost/${id}/index.html\`, ... })`
   沿用 `src/utils/tile.ts` 的 `getByLabel` 去重模式，尺寸取 `plugin.json` 的 `ui.width/height`。
2. 文档由协议处理器返回，响应头**自带 CSP**：

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'none';            ← 声明 network 权限后才追加具体 origin
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

3. 宿主在响应时向 HTML 头部注入主题变量（`--color-bg-*` / `--color-text-*` / `--radius-*`），
   并注入 `<script src="/__host/runtime.js">`（由同一协议提供的宿主运行时，
   定义 `window.qing`）。主题后续变化通过 `core:event` 推送，插件用 `view.onThemeChange` 订阅。

> 这条注入是必需的：不注入主题 token，插件界面的配色和圆角与宿主完全是两个视觉世界，
> 一眼就能看出「外挂的」。

4. IPC：插件窗口可以 `invoke("plugin_host_call")` 走宿主桥，也可以直接 `postMessage` 给自己的
   `window`。**能力收窄靠 capability**，不靠插件自觉：

```json
// src-tauri/capabilities/plugin-window.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "plugin-window",
  "description": "第三方插件窗口：只允许事件订阅与插件宿主桥，其余全部拒绝",
  "windows": ["plugin-*"],
  "permissions": ["core:event:default", "plugin-host:default"]
}
```

Tauri v2 的 ACL 按 window label 生效，`plugin-*` 匹配到的窗口**不具备** `fs` / `dialog` /
`opener` / `http` 等任何既有权限——即使插件代码知道命令名，IPC 层也会拒绝。

### 4.4 `qplugin` 协议实现要点（Rust）

```rust
// src-tauri/src/plugin_protocol.rs
builder.register_asynchronous_uri_scheme_protocol("qplugin", move |app, req, responder| {
    // 1. URL: http://qplugin.localhost/<id>/<path>
    // 2. 取出 id 与 path，拒绝 id 非白名单（必须是 installed.json 中已启用的插件）
    // 3. 根目录 jail：<data>/plugins/<id>/<active_version>/ 下 canonicalize 后做前缀比对
    // 4. 扩展名 → MIME 白名单（html/js/css/png/jpg/svg/woff2/json），其余 404
    // 5. __host/* 为虚拟路径，由宿主提供（runtime.js / theme.css）
    // 6. HTML 响应：注入主题变量 + runtime script，并写 Content-Security-Policy 头
    //    其余资源：写 CSP 头 + 长缓存（版本目录不可变）
});
```

关键细节：
- **每次请求都重新解析「当前激活版本」**，避免回滚后旧窗口继续读旧版本。
- `Cache-Control: no-store` 只给 HTML，`assets/*` 可以 `immutable`（版本目录内容不变）。
- 不做目录列表、不返回 `plugin.json`（manifest 由宿主命令提供，避免插件互相读取声明）。

### 4.5 崩溃隔离与恢复

| 故障 | 行为 |
| --- | --- |
| Worker `onerror` / `onmessageerror` | 标记 `crashed`，该插件命令置灰；连续 3 次失败自动禁用并提示 |
| Worker 无响应（RPC 超时 5s） | 终止 worker，返回 `E_TIMEOUT`，不计入崩溃计数 |
| 插件窗口被 `destroyed` | 清理注册的视图状态；下次打开重建 |
| 激活期抛错 | 只回滚该插件，主窗口继续；错误写入 `plugins/error.log`（按插件分文件，最近 100 条） |
| 插件死循环阻塞 | Track A 在 worker 内，主线程不受影响；Track B 在独立窗口，同理 |

**宿主永不为插件错误抛出未捕获异常**：`bridge.ts` 的每个入口都包 `try/catch`，
统一转成 `{ ok: false, code }`。这一条与现有「扩展 `PanelErrorBoundary`」的约定一致。

---

## 5. 安装与更新

### 5.1 状态机

```
发现(NOT_INSTALLED) → 下载 → 校验 → 解压(.staging) → 声明体检 → 授权确认
   → 原子 rename 到 <id>/<ver> → 写 installed.json → ENABLED
ENABLED ⇄ DISABLED（用户开关，不影响文件）
ENABLED → 更新中 → 成功（旧版本目录保留）/ 失败（回滚到旧目录）
任意 → 卸载（删目录 + 询问是否保留 storage.json）
```

`installed.json` 结构：

```json
{
  "schema": 1,
  "plugins": {
    "com.example.markdown-toc": {
      "version": "1.2.0",
      "previousVersion": "1.1.0",
      "enabled": true,
      "grantedPermissions": ["storage", "notes:read", "clipboard:write"],
      "installedAt": "2026-10-27T02:10:00Z",
      "updatedAt": "2026-10-27T02:10:00Z",
      "source": "index"
    }
  }
}
```

### 5.2 索引格式（`qing-notepad-plugins/index.json`）

```json
{
  "schema": 1,
  "updatedAt": "2026-10-27T02:00:00Z",
  "plugins": [
    {
      "id": "com.example.markdown-toc",
      "name": "Markdown 目录",
      "description": "为当前笔记生成目录并跳转。",
      "author": "example",
      "repo": "https://github.com/example/qing-toc",
      "version": "1.2.0",
      "apiVersion": 1,
      "engines": { "host": ">=0.8.0 <1.0.0" },
      "download": "https://github.com/example/qing-toc/releases/download/v1.2.0/com.example.markdown-toc-1.2.0.qnp",
      "sha256": "<64 hex>",
      "signature": null,
      "permissions": ["storage", "notes:read", "clipboard:write"],
      "keywords": ["markdown", "toc"],
      "onStartup": false
    }
  ]
}
```

拉取策略（复用 `src/utils/updateChecker.ts` 已确立的做法——走 `plugin-http` 在 Rust 侧请求，
不污染主窗口 CSP）：

1. 首选 `https://raw.githubusercontent.com/PyTs1n9/qing-notepad-plugins/main/index.json`
2. 失败兜底 `https://cdn.jsdelivr.net/gh/PyTs1n9/qing-notepad-plugins@main/index.json`
3. 结果缓存 24h（`<data>/plugins/index-cache.json`），带 `ETag`/`If-None-Match`；
   拉取失败时用缓存并标注「离线，数据可能是旧的」。

### 5.3 安装流程（Rust 命令 `plugin_install`）

1. 下载 `.qnp` 到 `<data>/plugins/.staging/<id>.qnp`（大小上限 20 MB，超限即中断）。
2. 校验 `sha256` 与索引一致；索引带 `signature` 时用内置公钥验 ed25519。
3. 解压到 `.staging/<id>/`，逐条做 zip slip 与二进制扫描。
4. 解析 `plugin.json`：schema 校验 → `id` 与索引一致 → `version` 与索引一致 →
   `apiVersion ∈ SUPPORTED_API_VERSIONS` → `engines.host` 匹配 `APP_VERSION`。
5. 返回「待确认清单」给前端：名称、作者、仓库、权限逐条人类可读描述。
6. 用户确认后：`rename(.staging/<id>, plugins/<id>/<ver>)`（同盘原子），写 `installed.json`。

**任何一步失败都必须清理 `.staging/<id>*`**，不留半成品；启动时扫一次 `.staging` 并清空。

### 5.4 更新

- 启动后（或打开插件页时）比对索引版本与 `installed.json`，发现更高版本只做**提示**。
- 用户点更新 → 走同一套下载/校验流程 → 解压到新版本目录 → 权限比对：
  - `newPermissions ⊄ grantedPermissions` → 强制重新授权，弹窗列出**新增项**；
  - 否则沿用原授权，仅提示版本变化。
- 成功后写 `version` / `previousVersion`，旧目录保留（保留最近 2 个版本），
  「回滚」按钮就是把目录指针切回去。
- **不做定时自动更新**（见 `decisions-plugin-system.md` D4）。

### 5.5 市场与管理页

`ViewType` 新增 `"plugins"`（核心视图，非插件视图），入口放 ActivityBar 底部区域
（与 AI、设置同组，不占主导航槽位）：

- **浏览**：卡片列表（图标、名称、作者、一句话描述、当前状态），支持关键词过滤；
  仅在本地区没有索引缓存时显示骨架 + 「获取插件索引」按钮，不阻塞启动。
- **详情**：描述、权限清单（人类可读）、仓库链接、版本、更新说明。
- **已安装**：版本、启用开关、更新按钮、回滚、卸载、查看错误日志。
- **离线安装**：「从文件安装」按钮，走 `dialog` 选 `.qnp`，校验流程相同（信任等级标注为「非索引来源」）。

---

## 6. 版本与依赖

### 6.1 三个版本号各管什么

| 版本 | 归属 | 作用 | 变更规则 |
| --- | --- | --- | --- |
| `APP_VERSION` | 宿主 | 应用版本，已在 `updateChecker.ts` 使用 | 现有规则不变 |
| `apiVersion` | 契约 | 插件 API 接口编号 | 破坏性改动 +1，宿主维护支持列表 |
| 插件 `version` | 插件 | 插件自身迭代 | semver，索引与 `plugin.json` 必须一致 |

### 6.2 `engines.host` 判定

需要判断 semver range（`>=0.8.0 <1.0.0`、`^0.8`、`~0.8.2`）。
`src/utils/updateChecker.ts` 里只有「比较两个版本大小」的手写逻辑，没有 range 解析。

**选型**：引入 `semver`（~15 KB）而不是手写解析。理由：range 语法边界多（预发布、`||`、
`x` 通配），手写实现出错时表现为「插件莫名装不上」，排查成本远高于 15 KB 体积。
引入范围限定在 `src/plugin/version.ts`，由它包一层 `satisfies()`，其余代码不直接依赖。

### 6.3 依赖关系

- **插件间依赖：不支持**。安装阶段若 `dependencies` 非空 → 直接拒绝并说明原因。
- **宿主对插件的依赖：无**（插件是可选增强，卸载后宿主功能必须完整）。
- **插件对既有数据的兼容性**：`notes:write` 的插件改动经 `noteStore` 走正常路径，
  因此 `updatedAt`、索引指纹、`noteIndexFingerprint` 的自动保存逻辑不需要为插件特判。

### 6.4 兼容矩阵（写入开发者文档）

| `apiVersion` | 支持宿主版本 | 状态 |
| --- | --- | --- |
| 1 | `>=0.8.0 <1.0.0` | 当前 |

宿主升级到 `1.0.0` 时若改动 API，`apiVersion` 升到 2，并在一段窗口期内同时支持 1 与 2。

---

## 7. 安全与权限

### 7.1 威胁模型

| 攻击 | 缓解 | 残余风险 |
| --- | --- | --- |
| 插件偷读全部笔记 | 无 `notes:*` 权限时 API 直接拒绝；`notes.get` 只返回声明范围内内容 | 有 `notes:read` 且经过审核的插件仍可批量读取——靠审核与权限可见性约束 |
| 插件改写 `todos.json` 破坏数据 | Track A 无 fs；Track B 的 fs 权限被 capability 拒绝 | 无 |
| 插件读取 Supabase 会话 / 凭据 | 插件页是 `qplugin` 源，与主窗口**不同源**，读不到主窗口 `localStorage`；解密命令不在白名单 | 同协议源下插件之间共享存储（v1 限制，见下） |
| 插件外联上报 | 默认 `connect-src 'none'`；声明 `network:` 才放开且限定 origin | 声明了 `network:*` 的插件无法按域名约束 |
| 恶意插件包（zip slip / 炸弹） | 路径规范化 + 大小与条目上限 + 拒绝链接条目 | 无 |
| 供应链：索引被篡改 | `sha256` 强制；`signature` 字段留给 ed25519 | 索引仓库本身失守时，sha256 与索引一起被改——只能靠签名兜底（见待定问题 1） |
| 插件冒充热门插件 | 索引审核；`id` 全局唯一且安装后不可变；UI 展示仓库链接 | 首次安装的仿冒难以自动识别 |
| 插件崩溃拖垮应用 | 两条轨道都在隔离上下文中；RPC 超时 5s；连续 3 次失败自动禁用 | 无 |
| 插件把宿主 IPC 当后门 | 命令白名单 + 逐调用权限校验；Track A 物理上无 IPC | Track B 若 IPC 从自定义源不可用，需改走中继（阶段 0 结论决定） |

### 7.2 权限授予的用户可见性

- 安装/更新弹窗必须逐条列出**即将授予的能力**及一句人话解释（表 2.3 的最后一列）。
- 「已安装」页常驻显示每个插件当前的权限集合，可单独撤销（撤销后插件立即降级，
  调用被拒并 toast 提示）。
- 撤销任一权限 → `grantedPermissions` 收缩 → 下次更新按 5.4 重新判定。

### 7.3 已知限制（必须写进 README，不要藏）

1. 所有插件共享 `http://qplugin.localhost` 这一个源，因此它们共享该源的存储空间。
   对策：把插件业务数据一律走 `storage` API（宿主按插件 id 分文件），并在 CSP 与文档中
   明确禁止使用 `localStorage`。
2. Track A 的插件没有任何网络能力（worker 内的 `fetch` 未被代理，且默认拒绝），
   需要联网的插件必须做成 Track B。
3. v1 不做插件隔离级别的用户可选降级（比如「我信任这个插件，给它完整权限」）。

---

## 8. 代码落地清单

### 8.1 新增（Rust）

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/plugin.rs` | 安装/卸载/启用/回滚/存储读写/清单查询，zip 校验与解压 |
| `src-tauri/src/plugin_protocol.rs` | `qplugin` 协议：根目录 jail、MIME、按权限生成 CSP、HTML 注入 |
| `src-tauri/src/plugin_manifest.rs` | `plugin.json` 反序列化 + 校验（id/版本/权限/apiVersion） |
| `src-tauri/capabilities/plugin-window.json` | `windows: ["plugin-*"]` 的最小权限集 |

命令清单（加进 `lib.rs` 的 `generate_handler!`）：

```
plugin_list_installed      plugin_install            plugin_uninstall
plugin_set_enabled         plugin_rollback           plugin_read_manifest
plugin_storage_get         plugin_storage_set        plugin_storage_delete
plugin_storage_keys        plugin_index_fetch        plugin_read_log
```

新增 Cargo 依赖：`zip`（解压）、`sha2`（校验）、`ed25519-dalek`（可选签名，待定问题 1）、
`tauri_plugin_http::reqwest`（下载，复用现有插件，不新增网络栈）。

### 8.2 新增（前端）

```
src/plugin/
├── types.ts               PluginManifest / InstalledPlugin / Permission 等
├── version.ts             semver 封装（satisfies / 比较）
├── registry.ts            注册表：命令、视图、激活状态
├── bridge.ts              权限校验 + RPC 分发（唯一出口）
├── headless/
│   ├── host.ts            Worker 生命周期、RPC 超时、崩溃计数
│   └── worker-entry.ts    宿主侧 boot（可选，若改为 qplugin 直取则删除）
├── ui/
│   ├── runtime.ts         注入 window.qing 的实现（协议侧提供）
│   └── window.ts          openPluginWindow(id, viewId)
├── market/
│   ├── index.ts           索引拉取 + 缓存 + 双源兜底
│   └── install.ts         下载→校验→授权→落盘 的前端编排
└── store.ts               usePluginStore（Zustand，与现有 stores 同风格）
src/components/Plugin/
├── PluginMarketplace.tsx  浏览 / 已安装 / 详情
├── PermissionList.tsx     权限人类可读列表（安装与详情复用）
└── PluginViewHost.tsx     主区承载插件视图（未就绪时显示占位）
src/components/Layout/CommandPalette.tsx   命令面板（Ctrl+Shift+P）
```

### 8.3 需要改动的既有文件

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `src/types/index.ts` | `ViewType` 改为 `CoreViewType \| \`plugin:${string}:${string}\`` | 影响面广，先跑 `npx tsc --noEmit` 全量确认 |
| `src/App.tsx` | 主区渲染从三元表达式改为查表；挂载 `<CommandPalette />` | 第 1234-1253 行，注意保持 `Suspense` 边界 |
| `src/components/Layout/ActivityBar.tsx` | `items` 由内建 4 项 + 插件视图拼装 | 图标需要 `lucide-react` 白名单映射 |
| `src/components/Settings/SettingsModal.tsx` | 新增「插件」分区入口（跳转市场页） | 与现有分区样式保持一致 |
| `src/utils/i18n.ts` | 新增插件相关文案（中英双语，typed table） | 缺键会静默回退到 key，务必两边都加 |
| `src-tauri/src/lib.rs` | 注册协议、挂命令、启动时清理 `.staging` | |
| `src-tauri/tauri.conf.json` | **不改 CSP**（Track A 走 blob worker，Track B 的 CSP 由协议响应自带） | 若阶段 0 结论要求放开 `frame-src`，在此单独评审 |

---

## 9. 分阶段实施

每个阶段独立可交付、可回滚。**阶段 0 不通过就不要启动阶段 3。**

### 阶段 0：技术验证（先做，1-2 天）
验证 4 个「方案成立的前提」，全部通过才继续：

1. `qplugin` 协议在 Windows/WebView2 下的实际 origin 是否为 `http://qplugin.localhost`。
2. 该源下的文档里 `invoke("plugin_host_call")` 是否可用；若不可用，改走
   「app 源中继页 + 跨源 iframe」，并同步确认 `frame-src` 放开的影响。
3. `plugin-*` label 的 capability 是否真的拦住了 `fs:writeTextFile`（**反向验证**：
   显式尝试一次，必须失败）。
4. blob worker 里 `import()` 是否被 CSP 拦住（预期：单文件产物可行，相对路径不可行）。

> 本机没有 GUI 能力，这 4 条必须由你在真实窗口里跑一遍。我会给出一个最小验证页
> （`src-tauri` 临时命令 + 一个 `?probe=1` 的调试入口），跑完删掉。

**验收**：4 条结论写回本文件第 4 节的「已知实现事实」。

### 阶段 1：清单与安装（无代码执行）
- Rust：`plugin_install` / `plugin_uninstall` / `plugin_list_installed` / 存储命令。
- 前端：`usePluginStore`、市场页的「已安装」与「从文件安装」。
- 此时没有任何插件代码会被执行，风险最低。

**验收**：装一个只有 `plugin.json` 的空包能出现在列表；故意构造 zip slip 与超限包被拒。

### 阶段 2：headless 运行时
- `bridge.ts` + `headless/host.ts` + RPC 协议 + 崩溃计数。
- 命令面板（`Ctrl+Shift+P`）+ 命令注册/执行。
- 示例插件 `qing.hello-headless`（一条命令，往剪贴板写时间戳）。

**验收**：安装并执行示例命令；撤销 `clipboard:write` 后命令返回 `E_PERMISSION_DENIED`；
死循环插件不影响主窗口响应。

### 阶段 3：UI 视图
- `qplugin` 协议 + 主题注入 + `runtime.js`。
- `openPluginWindow` + ActivityBar 注册 + `PluginViewHost`。
- 示例插件 `qing.hello-view`（显示当前主题与笔记数，需 `notes:read`）。

**验收**：视图窗口的配色与宿主一致（切换主题后跟随）；窗口内 `fs` 调用被 ACL 拒绝。

### 阶段 4：市场与更新
- 索引双源拉取 + 缓存 + 24h TTL。
- 详情页、更新、回滚、权限重新授权、离线安装。
- 错误日志查看。

**验收**：断网时用缓存展示；同一插件从 1.0.0 升到 1.1.0 且新增权限时强制重新授权。

### 阶段 5：索引仓库与开发者生态
- 新建 `qing-notepad-plugins`：`index.json`、`schema/plugin.schema.json`、PR 模板、CI 校验脚本
  （schema 校验 + 拉 Release 算 sha256 + 权限越界告警）。
- `docs/plugin-dev-guide.md`：包结构、`plugin.json` 字段、API 参考、构建脚手架
  （`npm create qing-plugin` 或一个 esbuild 模板仓库）、上架流程。
- 示例插件仓库 2 个（headless + UI），都带 GitHub Actions 自动打包发 Release。

**验收**：一个陌生人只看文档能做出并上架一个插件（用你或朋友的账号做一次真实演练）。

---

## 10. 需要你确认的遗留项

1. 发布者签名（ed25519）是否 v1 就上——影响索引 schema 与作者上架步骤。
2. `<data>/plugins/` 是否写进 `docs/user-manual.md` 的备份/迁移说明。
3. ~~命令面板快捷键冲突~~ —— 已查证：`shortcutReference.ts` 里只有 `Ctrl+Alt+T`，
   `settingsStore` 的全局快捷键里也没有 `Ctrl+Shift+*`，故 `Ctrl+Shift+P` 可用
   （按 `Ctrl+W` 的既有做法做成窗口级 `keydown`，不进 `global-shortcut`，
   避免抢走系统里其他应用的组合键）。
4. 插件页的位置：ActivityBar 底部按钮（本方案）vs 设置弹层内的一个分区。
