# L1 插件机制：实现与验收记录

> **TL;DR**（`apiVersion: 1`，目标宿主 0.7.3；只记「做了什么 / 验到哪 / 还差什么」）
> - 隔离实测（release 包）：Worker 里 `window` / `document` / `__TAURI_INTERNALS__` 全 `undefined`，`fetch=blocked`。
> - **CSP 只在正式包生效**：`tauri dev` 下 `fetch=ALLOWED`，第 4 项验收必须用 release 包。
> - 安装两阶段（`dryRun`）：Rust 解压校验清单 → 前端判 `engines.host` / 命令冲突 / 授权 → 原子 rename。
> - 权限撤销必须 `setRunnerPermissions()`；更新或回滚后要 `deactivatePlugin`，否则 Worker 跑旧 `main.js`。
> - 14 项验收中 #11 断网、#12 权限扩容未实测；`tsc` / `build` / 单元测试全绿。

> 目标宿主 `0.7.3`，`apiVersion: 1`。决策见 `docs/decisions-plugin-system.md`，
> 本文件只记录**这次实际做了什么、验证到了哪一步、还差什么**。
>
> 方案原文 `docs/plan-plugin-system.md` 在工作区里是已删除状态（`git status` 显示
> ` D`），所以探针结论没有写回那份文件，而是记在这里。

## 1. 阶段 0：隔离前提（已实测）

探针有两份，回答同一个问题：

- `src/probe/workerProbe.ts`：**只在 dev 构建**的 `?probe=1` 下加载，生产构建里整段被摇掉；
- `examples/qing-isolation-probe`：装进任意构建，在**真实 Worker 里**检查同样四件事，
  用一条提示消息报告。正式包靠它验收。

**2026-10-27 12:52 在 release 包（`0.7.3`，NSIS 安装版同源）实测结果**：

```
window=undefined document=undefined tauri=undefined fetch=blocked
```

| # | 验证项 | 期望 | 实测 |
| --- | --- | --- | --- |
| 1 | blob URL 的 module worker 能创建并执行命令 | 能 | ✅ 命令执行、剪贴板写入均成功 |
| 2 | Worker 里 `typeof window` / `typeof document` | `undefined` | ✅ 两者都 `undefined` |
| 3 | Worker 里 `typeof __TAURI_INTERNALS__` | `undefined` | ✅ `undefined` |
| 4 | Worker 里 `fetch("https://example.com")` | 被 CSP 拦 | ✅ `blocked`（**仅正式包**） |

> **关键事实：CSP 只在正式包里生效。** 同一份插件在 `tauri dev`（前端走
> `http://localhost:8787`）里跑出的是 `fetch=ALLOWED`——Tauri 不会给 dev server 的
> 响应加 `Content-Security-Policy` 头，显式配置的 CSP 只注入生产构建的自定义协议响应。
> 所以第 4 条**必须用 release 包验收**，dev 下的结果没有意义。这不影响安全性结论：
> 发布出去的是 release 包。

CSP 侧的静态依据（`src-tauri/tauri.conf.json`，本次未改动）：

- `worker-src 'self' blob:` 与 `child-src 'self' blob:` → blob worker 合法；
- `script-src 'self' 'wasm-unsafe-eval'` **不含 `blob:`** → 主线程 `import(blobUrl)` 必被拦，
  Worker 是唯一路径；
- `connect-src` 是显式列表，没有通配符 → `example.com` 被拦。

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

2026-10-27 12:40–12:55 在**真实运行的应用**上逐条跑过（dev 构建用于改代码，
最终结论以 release 包为准）。「实测」列是界面上读到的原文，不是推断。

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 安装 `qing-hello-headless`，执行命令 | ✅ 弹窗授权 → toast「已复制 2026-10-27T12:48:01.495+08:00」→ `Get-Clipboard` 读到同一串 |
| 2 | 撤销 `clipboard:write` 后再执行 | ✅ toast「命令执行失败：E_PERMISSION_DENIED」，剪贴板保持哨兵值不变 |
| 3 | 安装 `qing-note-wordcount`，执行 | ✅ toast「共 50 篇笔记，26213 字」 |
| 4 | zip slip 包（`../../evil.js`） | ✅ 单元测试：`E_ZIP_SLIP` |
| 5 | 含 `main.dll` 的包 | ✅ 单元测试：`E_NATIVE_MODULE`（6 种后缀全覆盖） |
| 6 | 25 MB 的包 | ✅ 单元测试：`E_TOO_LARGE`（单文件 5 MB / 总量 20 MB 各一条边界） |
| 7 | 插件里 `while(true){}` | 构造上在 Worker 内；同一进程里连跑 3 个插件命令，主界面无卡顿 |
| 8 | 未声明 `notes:write` 却调 `notes.create` | ✅ 同 #2 的路径：`bridge.ts` 先查权限，返回 `E_PERMISSION_DENIED` |
| 9 | 插件里 `fetch("https://example.com")` | ✅ release 包：`fetch=blocked`（dev 下放行，见 §1） |
| 10 | 索引 URL 404 | ✅ 扩展页「可安装」段显示「暂无可用插件」，无报错、不影响安装 |
| 11 | 断网打开扩展页 | 未实测（当前网络可用）；代码路径为 `status: "cached"` → 标注「离线，数据可能是旧的」 |
| 12 | 更新到权限更大的版本 | 未实测（需要索引里有第二个版本）；代码路径为 `addedPermissions` 非空 → 强制重新授权 |
| 13 | 停用插件后执行其命令 | ✅ 停用后命令面板搜索「时间戳」返回「没有匹配的命令」 |
| 14 | 连装 5 个插件看启动时间 | 装了 3 个，均无 `onStartup`；冷启动到可交互无可见延迟 |

自动化部分（本机已跑）：

```
npx tsc --noEmit           通过
npm run build              通过
npm run verify:ui-polish   15/15；对比度 152 组，0 失败
cargo test --lib           13 passed / 0 failed
                           （plugin 7 条 + plugin_manifest 3 条 + credentials 3 条）
```

> `cargo test --lib` 要链接整个 Tauri 测试二进制，默认带调试信息时在这台机器上会
> 卡在链接阶段（rustc 0% CPU 挂 20 分钟）。加 `CARGO_PROFILE_TEST_DEBUG=0`
> 关掉测试二进制里的调试信息后，首次 2 分半、增量 0.3 秒。

### 4.1 界面项（已截图核对）

- ActivityBar 第 5 项（`Puzzle`）位置正确，与其余四项同一胶囊滑动指示器，无第二个元素；
- 扩展页左栏与笔记/待办同源：`h-9` 标题条、卡片圆角、虚线分段；
- 授权弹窗：标题「安装 XXX？」、逐条人话权限 + 权限代码、取消在左主按钮在右，
  遮罩覆盖全窗且不穿透；
- 命令面板：`Ctrl+Shift+P` 打开，模糊过滤，插件命令带「扩展」标签。

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

## 5.1 首次实测后的修复（12:30）

用户在已安装的 0.7.3 上首次安装示例插件时「选完文件没反应」。查磁盘：
`<data>/plugins/.staging/<token>/{plugin.json,main.js}` 已经解压完成，但 `installed.json`
不存在——说明 Rust 第一阶段成功，卡在授权弹窗之前。

根因：`PluginDetail` 把 `<PermissionPrompt>` 放在「未选中任何插件」的提前 `return`
之后，而首次安装是从左栏「从文件安装」发起的，此时 `selectedId` 还是 `null`，
主体渲染的是空状态分支，弹窗组件根本没挂载。**弹窗被选中状态挡住了。**

修法：拆成 `PluginDetailBody`（依赖选中项）+ `PluginDetail`（外层），授权弹窗挂在外层，
与选中状态无关。顺带：

- 安装失败不再只靠 toast（3 秒就消失）：错误同时写进 `lastError`，空状态与详情页都会
  常驻显示，直到用户手动关闭。
- 安装成功后自动选中新插件，列表里立刻能看到「已安装」。

另外补了第三个示例 `qing.isolation-probe`：正式包里的 Worker 自己检查
`window` / `document` / `__TAURI_INTERNALS__` / `fetch`，用一条提示消息报告。
这样阶段 0 的四条前提**不需要 dev 构建**也能在真实安装包上验证。

## 5.2 第二轮修复（12:50，实测暴露的两个问题）

**① 命令执行失败一律报 `E_INTERNAL`。** `worker-boot.js` 的命令分发把任何异常都
压成 `E_INTERNAL`，于是"权限被撤销"和"插件写崩了"在 toast 上长得一模一样。
改成透传 `error.code`——宿主拒绝调用时构造的错误本来就带码（`E_PERMISSION_DENIED`、
`E_QUOTA_EXCEEDED`…）。修完实测：#2 的 toast 变成「命令执行失败：E_PERMISSION_DENIED」。

**② 权限只能撤销不能恢复。** 详情页只渲染「已授予」的权限，撤销之后就只剩重装一条路。
`PermissionList` 增加 `missing` / `onGrant`：清单里声明但未授予的权限以虚线行显示，
右侧给「授予」。这样撤销是一次可逆操作，也让「权限可见可管理」这句产品话术站得住。

## 6. 已知限制

- `apiVersion: 1` 没有「当前打开的笔记」这个能力，字数示例统计整个笔记库。
- 插件命令执行失败只在 toast 上给错误码，没有重试。
- 索引仓库 `PyTs1n9/qing-notepad-plugins` 还不存在，所以「可安装」段现在恒为空，
  这是设计内行为（降级为仅本地安装）。
- 发布者签名（ed25519）没做，索引的 `sha256` 是唯一完整性校验。
- 插件网络能力不是靠代码扫描禁掉的，是靠 CSP；如果将来给 `connect-src` 加通配符，
  这条保证会一起消失。
