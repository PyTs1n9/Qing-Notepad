# L1 插件机制：实现与验收记录

> 目标宿主 `0.7.3`，`apiVersion: 1`。决策见 `docs/decisions-plugin-system.md`，
> 本文件只记录**这次实际做了什么、验证到了哪一步、还差什么**。
>
> 方案原文 `docs/plan-plugin-system.md` 在工作区里是已删除状态（`git status` 显示
> ` D`），所以探针结论没有写回那份文件，而是记在这里。

## 1. 阶段 0：隔离前提

探针代码留在 `src/probe/workerProbe.ts`，**只在 dev 构建的 `?probe=1` 下加载**
（`import.meta.env.DEV` 在生产构建里是字面 `false`，整段连同动态 import 一起被
摇掉）。这比"验证完删掉"更有用：以后换 WebView2 版本可以随时复跑。

| # | 验证项 | 期望 | 状态 |
| --- | --- | --- | --- |
| 1 | blob URL 的 module worker 能创建并回消息 | 能 | **待运行时确认**（`npm run tauri dev` → `?probe=1`） |
| 2 | Worker 里 `typeof window` / `typeof document` | `undefined` | **待运行时确认** |
| 3 | Worker 里 `typeof __TAURI_INTERNALS__` | `undefined` | **待运行时确认** |
| 4 | Worker 里 `fetch("https://example.com")` | 被 CSP 拦 | **待运行时确认** |

本机没有 GUI，这四条**没有实测**，不写成"已验证"。能从仓库里静态确认的部分：

- `src-tauri/tauri.conf.json` 的 CSP 含 `worker-src 'self' blob:` 与
  `child-src 'self' blob:`，blob worker 在允许范围内；
- `script-src 'self' 'wasm-unsafe-eval'` **不含 `blob:`**，所以主线程
  `import(blobUrl)` 一定被拦，Worker 是唯一可行路径（这也是选 Worker 而不是
  `import()` 的直接原因）；
- `connect-src` 是一张显式列表（`'self' ipc: http://ipc.localhost` + Supabase +
  onrender + 本地回环），**没有通配符**，Worker 继承同一份 CSP，`fetch` 到
  `example.com` 会被拦；
- 专用 Worker 的全局对象按规范就没有 `window` / `document`；Tauri 的 IPC 注入
  发生在主 webview 的 `window` 上，Worker 不经过那段初始化。

**若第 1 条失败**（worker 起不来），先查 CSP `worker-src`，再退回 `child-src`；
**若第 2/3 条失败**（Worker 能拿到 `window` 或 `__TAURI_INTERNALS__`），方案不成立，
必须停下来重新评估——代码里所有权限检查都以这条为前提。

## 2. 这次实际落了什么

### Rust（`src-tauri/src/`）

| 文件 | 内容 |
| --- | --- |
| `plugin_manifest.rs` | `plugin.json` 反序列化 + 校验：id 模式、严格 semver、`apiVersion`、`engines.host` 非空、`main` 必须在包内、权限必须属于 L1 全集、`dependencies` 非空直接拒 |
| `plugin.rs` | 两阶段安装、zip 防护、sha256、卸载/启用/回滚、私有存储（1 MB 配额）、索引双源 + 24 h 缓存、错误日志 |
| `clipboard.rs` | Win32 剪贴板读写（`CF_UNICODETEXT`），供 `clipboard:*` 权限使用 |
| `storage.rs` | 新增 `pub fn data_root()`，插件目录跟随用户迁移的数据根 |
| `lib.rs` | 注册命令 + 启动时清理 `.staging/` |
| `Cargo.toml` | `zip`（仅 deflate）、`sha2`；`windows-sys` 补 `Win32_System_DataExchange` / `Win32_System_Memory` |

命令清单（比 §7 多三条，都是被验收项逼出来的，见 §5）：

```
plugin_list_installed  plugin_install          plugin_uninstall
plugin_set_enabled     plugin_set_permissions  plugin_rollback
plugin_read_manifest   plugin_discard_staging
plugin_storage_get     plugin_storage_set      plugin_storage_delete  plugin_storage_keys
plugin_fetch_index     plugin_read_log         plugin_append_log
clipboard_read         clipboard_write
```

### 前端（`src/plugin/`、`src/components/`）

```
src/plugin/
├── types.ts          清单/安装记录/索引/权限类型 + 权限蕴含 + 报错码
├── version.ts        唯一 import semver 的文件（satisfies / gt）
├── semver.d.ts       semver 的最小类型声明（没有 @types/semver）
├── store.ts          usePluginStore：已安装、索引、选中项、安装弹窗状态
├── bridge.ts         唯一出口：先查权限，再落到 noteStore/todoStore/剪贴板
├── headless.ts       Worker 生命周期、RPC 5s 超时、连续 3 次崩溃自动停用
├── worker-boot.js    Worker 内的 qing 对象（`?raw` 内联进同一个 blob）
├── index-fetch.ts    索引拉取的封装与字段校验
├── install.ts        暂存 → 校验 → 授权 → 落盘的编排
└── commands.ts       内建命令表 + 模糊匹配
src/components/Plugin/
├── PluginSidebar.tsx 左栏：已安装 / 可安装 + 搜索 + 底部动作
├── PluginDetail.tsx  主区：详情、权限、命令、操作区、日志
├── PermissionList.tsx
└── PermissionPrompt.tsx
src/components/Layout/CommandPalette.tsx
src/components/ToastHost.tsx            提示消息宿主（ui.toast 的落点）
src/probe/workerProbe.ts                仅 dev
examples/qing-hello-headless/           示例插件（已构建 + 已打包）
examples/qing-note-wordcount/           示例插件（已构建 + 已打包）
examples/pack.mjs                       `.qnp` 打包脚本
```

### 改动的既有文件

| 文件 | 改动 |
| --- | --- |
| `src/types/index.ts` | `ViewType` 加 `"plugins"`，纯增量 |
| `src/components/Layout/ActivityBar.tsx` | `items` 加第 5 项（`Puzzle`）+ 更新角标；仍走 `items.map` + `indicator("activity-indicator")` |
| `src/App.tsx` | 左栏与主区各一个 `plugins` 分支、挂载 `CommandPalette` / `ToastHost`、初始化插件 store、停用全部插件时结束 Worker |
| `src/components/Settings/SettingsModal.tsx` | 新增「扩展」分区：打开扩展页 + 禁用所有插件 |
| `src/utils/i18n.ts` | 新增 92 个 key（zh + en + `TranslationKeys`） |
| `src/stores/settingsStore.ts` | `pluginsDisabled` + `setPluginsDisabled` |
| `src/stores/toastStore.ts` | 新增 |
| `src/index.css` | `.app-toast` / `.command-palette` 入场动画（只用 `--dur-*` / `--ease-*`） |
| `package.json` | `semver ^6.3.1` |

**没改**：`tauri.conf.json`（CSP 一行未动）、`fs:scope`、`Sidebar.tsx`、
`App.tsx` 的 `leftSidebarListVisible`。

## 3. 安装链路的两阶段设计

`plugin_install` 用 `dryRun` 分成两步，起因是**不能有第二份 semver range 实现**：

1. `dryRun: true`：下载/读取 → 校验大小 → sha256 → 解压到 `.staging/<token>/` →
   解析并校验 `plugin.json` → 返回清单 + `stagingId`；
2. 前端用 `semver` 判断 `engines.host`、查命令 id 冲突、弹授权；
3. `dryRun: false` + `stagingId`：把暂存目录 rename 到 `<id>/<version>/`，写
   `installed.json`，裁剪到最近两个版本。

任一步失败都清空该次暂存；取消授权走 `plugin_discard_staging`。启动时无条件清空
`.staging/`。

## 4. 验收矩阵

| # | 场景 | 状态 |
| --- | --- | --- |
| 1 | 安装 `qing-hello-headless`，执行命令 | 需桌面会话确认（剪贴板写入 + 插件页状态） |
| 2 | 撤销 `clipboard:write` 后再执行 | 需桌面会话确认（预期 toast 报 `E_PERMISSION_DENIED`，剪贴板不变） |
| 3 | 安装 `qing-note-wordcount`，执行 | 需桌面会话确认（预期 toast：`共 N 篇笔记，M 字`） |
| 4 | zip slip 包（`../../evil.js`） | **单元测试通过**：`E_ZIP_SLIP` |
| 5 | 含 `main.dll` 的包 | **单元测试通过**：`E_NATIVE_MODULE`（`.dll/.node/.exe/.so/.dylib/.wasm` 全部覆盖，大小写不敏感） |
| 6 | 25 MB 的包 | **单元测试通过**：`E_TOO_LARGE`（单文件 > 5 MB 与总量 > 20 MB 各一条） |
| 7 | 插件里 `while(true){}` | 需桌面会话确认（按构造在 Worker 内，主线程不受影响） |
| 8 | 未声明 `notes:write` 却调 `notes.create` | 代码路径确定（`bridge.ts` 先查权限）；需运行时确认一次 |
| 9 | 插件里 `fetch("https://example.com")` | 静态可确认 CSP 无通配符；运行时见阶段 0 第 4 条 |
| 10 | 索引 URL 404 | 已有实现：`status: "missing"` → 显示「暂无可用插件」，不抛错 |
| 11 | 断网打开扩展页 | 已有实现：`status: "cached"` → 标注「离线，数据可能是旧的」 |
| 12 | 更新到权限更大的版本 | 已有实现：`addedPermissions` 非空 → 强制重新授权，只列新增项 |
| 13 | 停用插件后执行其命令 | 已有实现：命令面板只从 `enabled` 的插件生成条目 |
| 14 | 连装 5 个插件看启动时间 | 已有实现：只有 `onStartup` 才启动 Worker |

自动化部分（本机已跑）：

```
npx tsc --noEmit           通过
npm run build              通过（2551 modules）
npm run verify:ui-polish   15/15；对比度 152 组，0 失败
cargo test --lib           13 passed / 0 failed
                           （plugin 7 条：正常包解压、zip slip、绝对路径与盘符、
                             原生模块 6 种后缀、单文件 >5MB、总量 >20MB、时间戳）
                           （plugin_manifest 3 条：id 模式、严格 semver、main 越界）
                           （credentials 3 条为既有测试）
```

> `cargo test --lib` 要链接整个 Tauri 测试二进制，默认带调试信息时在这台机器上会
> 卡在链接阶段（rustc 0% CPU 挂 20 分钟）。加 `CARGO_PROFILE_TEST_DEBUG=0` 后
> 首次 2 分半、增量 0.3 秒。`cargo check` 不受影响，仍是 40 秒级。

## 5. 需要说明的偏离

1. **多出三个命令**：`plugin_set_permissions`（验收 2 要能撤销单个权限）、
   `plugin_discard_staging`（取消授权要能清暂存）、`plugin_append_log`（Worker
   没有 fs，错误日志只能由宿主代写）。`plugin_read_log` 在 §7 的命令表里，没有
   写入侧它读不到任何东西。
2. **剪贴板用 Win32 FFI 而不是插件**：`@tauri-apps/plugin-clipboard-manager` 需要
   新增 npm 依赖，而 dev 进程正在运行（禁止 `npm install`）。Win32 方案零新依赖，
   且不依赖 `navigator.clipboard` 的焦点/授权前提。
3. **加了一个 `qing.commands.register`**：§6 的接口表里没有它，但 §6.1 的 RPC 协议
   明确要求宿主能发 `ns: "commands", method: "execute"` —— 没有注册侧，这条调用
   没有落点。实现只加 `register`，`commands.execute`（跨插件调用）仍然不存在。
4. **探针保留为 dev-only**，理由见 §1 开头。
5. **示例插件的 `engines.host` 写 `>=0.7.3 <1.0.0`**：当前宿主就是 `0.7.3`，写
   `>=0.8.0` 会让示例装不上，验收无从谈起。

## 6. 已知限制

- `apiVersion: 1` 没有「当前打开的笔记」这个能力，字数示例统计整个笔记库。
- 插件命令执行失败只在 toast 上给错误码，没有重试。
- 索引仓库 `PyTs1n9/qing-notepad-plugins` 还不存在，所以「可安装」段现在恒为空，
  这是设计内行为（降级为仅本地安装）。
- 发布者签名（ed25519）没做，索引的 `sha256` 是唯一完整性校验。
- 插件网络能力不是靠代码扫描禁掉的，是靠 CSP；如果将来给 `connect-src` 加通配符，
  这条保证会一起消失。
