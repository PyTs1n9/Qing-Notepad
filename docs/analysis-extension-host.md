# 架构评审：把 Worker 插件机制改造成 VS Code 式扩展宿主

> 评审对象：`0.7.3` 上刚落地的 L1 插件机制（`docs/verification-plugin-l1.md`）。
> 评审输入：用户新诉求（脚本、独立扩展宿主、`package.json` 声明、可操作界面/文本/命令/侧边栏）。
> 本文件只做判断与取舍，不含实现代码。所有体积数字均为本机实测，工期为人日量级估算。

---

## 1. 结论先行

**能做到，但"VS Code 式"只能做到形状，做不到生态——推荐走「保留 Worker 作为唯一代码执行边界 + 对外形态改成 VS Code 风格包与 API + 独立进程只作为可选增强 + 不自带 Node」这条路。**

一句话拆开说：

| 用户诉求 | 能否满足 | 代价 | 结论 |
| --- | --- | --- | --- |
| 不用 `.qnp`，直接写 JS/TS 脚本 | ✅ 完全能 | ≈ 0.5 人日 | 做（`.zip`/文件夹/`.qnp` 三收，布局不变，**零迁移**） |
| `package.json` 声明 `main`/`activationEvents`/`contributes`/`engines` | ✅ 能，`plugin.json` 已有 4 个字段中的 3 个 | 3–5 人日 | 做（改名 `package.json`，`contributes` 用 VS Code 词汇） |
| 插件能操作编辑器界面/文本/命令/侧边栏 | ✅ 能，但必须经宿主代理 | 10–14 人日 | 做（P1，声明式侧边栏 + TipTap 区间 API） |
| 插件跑在**独立扩展宿主进程** | ⚠️ 能，但**不能是 Node 进程** | 12–18 人日 | 有条件做（专用隐藏 webview 承载 Worker） |
| 自带 Node 运行时以便 `require('fs')`/npm | ⚠️ 能，但**会同时废掉现有安全模型并让安装包翻倍** | +25–30 MiB + 10–15 人日 | **不做**，改为"用户自备 Node"的可选后端 |
| 直接跑现成 `.vsix` | ❌ **不能，且不建议追** | — | 不做 |

**决定性的一条依据**：Node 官方文档对自带权限模型的自我定性是
> "This feature does not protect against malicious code… Malicious code can bypass the permission model and execute arbitrary code without the restrictions imposed by the permission model."（[nodejs.org/api/permissions.html](https://nodejs.org/api/permissions.html)，`--permission` 自 v22.13/v23.5 起 stable）

也就是说：**一旦插件拿到 Node 进程，`fs`/`net`/`child_process` 就绕过了 `bridge.ts`，而 Node 自身无法把权限收回来。** 项目当前唯一的安全性差异化（"权限可见 + 安装时逐条告知 + 运行时强制"）会随之消失——这正是 `docs/analysis-vscode-extension-ecosystem.md` §5.2 记录的 VS Code 根本缺陷（extension host 是崩溃隔离，不是安全隔离）。为了跑 npm 包而重新踩进去，是本末倒置。

---

## 2. 选项对比

打分 1–5，5 最好。"安全性"= 能否在插件作恶时仍然只给它授权的能力。

| 选项 | 体积增量（实测/估算） | 工期（人日） | Node 兼容 | 安全性 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **a) 保留 blob Worker（现状）** | **0 MiB** | 0 | 1（无 `require`/内置模块） | **5**（Worker 全局对象上根本没有 `__TAURI_INTERNALS__`） | 基线，保留 |
| **b) 打包 `node.exe` 作 sidecar** | **+25–30 MiB**（见 §2.1 实测推导）→ 安装包 26.05 → **约 51–56 MiB** | 12–16 | **5** | **1**（Node 官方承认权限模型不防恶意代码；且 `fs:scope`/CSP 全部失效） | 不做 |
| **c) 嵌 Rust JS 引擎** | `deno_core`(V8)：量级与 b 同源（V8+ICU 就是 `node.exe` 83 MiB 的主体）；`rquickjs`(QuickJS)：约 +1–2 MiB；`boa`：约 +2–3 MiB。**均未在本仓库实测** | 10–14 | 1–2（无 npm、无 Node API；QuickJS 对 ES2023 覆盖不全） | 4–5（默认可零能力，完全自定义） | 不推荐（小体积选项牺牲兼容性，大体积选项不如 b 省事） |
| **d) 双运行时（Worker 默认 + 可选 Node）** | **0 MiB**（Node 不随包，检测用户环境或用户指定路径） | 22–30（含 a 的全部 + 桥接） | 4（仅对装了 Node 的用户） | 3（Worker 侧仍 5；Node 侧需单独"全信任"红字授权） | **采用，但只作为 P2 出口** |
| **e) 专用隐藏 webview 作扩展宿主（本评审补充）** | **0 MiB**（复用已打包的 WebView2） | 12–18 | 1 | 4（renderer 进程隔离 + capability 为空的 deny-by-default；代价是 `__TAURI_INTERNALS__` 存在而非缺失） | **推荐作为"独立进程"诉求的答案（P1b）** |

### 2.1 体积数据（本机实测，非引用）

| 项 | 字节 | MiB | 来源 |
| --- | --- | --- | --- |
| `QingNotepad_0.7.1_x64-setup.exe`（L1 之前） | 27,001,499 | **25.75** | `src-tauri/target/release/bundle/nsis/` + `build-tauri.log` 末行 `(25.75 MiB)` |
| `QingNotepad_0.7.3_x64-setup.exe`（L1 之后） | 27,317,882 | **26.05** | 同上 |

→ **L1 整套插件机制（两阶段安装 + zip 防护 + sha256 + Worker 运行时 + 6 个界面组件）净增 316,383 B ≈ 0.30 MiB。**
这条基线很重要：`zip` + `sha2` + Worker 方案的成本几乎可以忽略，说明"体积敏感"不等于"不能做功能"。

| 项 | 字节 | 说明 |
| --- | --- | --- |
| `node.exe` v22.22.2 (win-x64) | 87,074,816（**83.04 MiB**） | 本机实测 |
| 同文件 `gzip -9`（deflate） | 33,050,633（**31.52 MiB**） | 本机实测，压缩比 ≈ 2.63:1 |

NSIS 用 LZMA（比 deflate 通常再小 10–20%），据此估 **+25–30 MiB**。该 LZMA 比率**未在本机用真实 `makensis` 验证**，标注为估算；但无论取区间哪一端，结论都是"安装包接近翻倍"。

### 2.2 为什么"作者自己 bundle 依赖"已经覆盖了 Node 的绝大部分价值

现有规范要求插件是**单文件产物**（三个示例的 `package.json` 都是 `esbuild --bundle --format=esm --platform=browser`）。这已经覆盖了纯 JS npm 依赖（markdown 转换、日期库、格式化器）——`main.js` 里内联即可，体积记在插件包上（单文件上限 5 MB）。

于是打包 Node 实际只多买到三样东西：**未 bundle 的 `node_modules`、原生插件（`.node`）、`fs`/`net`/`child_process`**。而：

- 原生模块已被安装器硬拒（`plugin.rs::is_native_module`，6 种后缀）；
- `fs`/`net`/`child_process` 正是我们**不想给**的能力。

**结论：为这三样付出 +25–30 MiB 和整个权限模型，性价比不成立。**

---

## 3. 推荐方案

### 3.1 推荐：a + e + P2 可选 d

> **代码执行边界永远是 Worker；包与 API 向 VS Code 对齐；"独立宿主进程"用隐藏 webview 承载 Worker 实现；Node 只作为不自带的、默认关闭的第二后端。**

三条关键判断：

1. **`Worker` 是唯一一处"对象不存在"的隔离。** 实测 `window=undefined document=undefined tauri=undefined fetch=blocked`（release 包）。webview 里 `__TAURI_INTERNALS__` 一定存在（Tauri 必注入），只能靠 capability 白名单拒绝调用——这是"约束"不是"缺失"。两者都可用，但**不要为了形式统一而把 Worker 换成 webview 主线程执行**。
2. **用户要"独立进程"，真实收益是崩溃与内存隔离，不是权限隔离。** 现状 `headless.ts` 全文没有内存上限或监控：一个插件在 Worker 里吃光内存，会带走整个 renderer（主界面一起没）。VS Code 的 extension host 解决的正是这件事。把它做成"隐藏 webview 里跑 Worker"，可以**同时**拿到进程隔离和"无 `window`/无 `__TAURI_INTERNALS__`"，且插件代码零改动。
3. **`bridge.ts` 必须留在原位。** 数据 API（笔记/待办/编辑器）的真实状态在主窗口的 zustand store 里，权限判断和状态访问天然同址。P1b 后链路变长，但闸门位置不动。

### 3.2 目标架构（P1 完成态）

```mermaid
flowchart TB
  subgraph MAIN["主窗口 renderer（现有 WebView2）"]
    UI["React UI / TipTap 编辑器 / ActivityBar"]
    CP["CommandPalette"]
    BR["bridge.ts<br/>权限闸门：REQUIREMENTS + hasPermission"]
    NS["noteStore / todoStore / toastStore"]
    UI --> BR
    CP --> BR
    BR --> NS
  end

  subgraph EH["extension-host webview（隐藏窗口，capabilities = 空）"]
    BOOT["host-boot.js<br/>Transport 实现 + 生命周期"]
    W1["Worker: plugin A<br/>（无 window/document/__TAURI_INTERNALS__）"]
    W2["Worker: plugin B"]
    BOOT <-->|"postMessage（协议不变）"| W1
    BOOT <-->|"postMessage（协议不变）"| W2
  end

  subgraph RUST["Rust 核心（src-tauri）"]
    PM["plugin.rs<br/>安装/校验/存储/索引/日志"]
    RP["custom protocol: qing-plugin-rpc<br/>（JSON-RPC 入口）"]
    BRG["plugin_bridge_call<br/>（转发到主窗口）"]
    PM --- RP
    RP --- BRG
  end

  BOOT <-->|"fetch('qing-plugin-rpc://call')<br/>CSP: connect-src qing-plugin-rpc:"| RP
  BRG <-->|"Tauri event（只传 id/range/句柄，不传全文）"| BR
  PM --- DISK[("<data>/plugins/<id>/<version>/<br/>storage.json / error.log")]
```

P0 阶段同一张图去掉 `EH` 与 `RP`：Worker 仍在主窗口，`headless.ts` 直接调 `dispatchPluginCall`（= 今天的样子）。**Transport 抽成接口，两条路径共用同一套协议与权限表**，切换是配置项而不是分支重写——这是控制风险的关键。

### 3.3 五个关键决策点

| # | 决策 | 选择 | 依据 |
| --- | --- | --- | --- |
| K1 | 插件代码在哪执行 | Worker（P0 在主窗口 / P1 在 extension-host） | 唯一"对象缺失"级隔离；插件代码零改动 |
| K2 | 权限在哪强制 | 数据 API 在 `bridge.ts`；存储/剪贴板/网络在 Rust；编辑器在 `bridge.ts` 新分支 | 状态所在处判断，避免跨进程裁决 |
| K3 | 大文本怎么传 | **传句柄不传值**：`{noteId, from, to}`，由持有文件的进程读写 | 已有先例：`notes.get` 返回纯文本、`notes.update` 落盘 + 双事件广播 |
| K4 | 侧边栏形态 | **声明式树**（VS Code `TreeDataProvider` 式） | 3–4 人日、复用现有 `PluginSidebar` 样式、无新进程/CSP |
| K5 | Node 怎么给 | 不随包；用户可选启用，启用即"全信任"红字授权 | Node 官方权限模型不足以当边界；+25–30 MiB |

### 3.4 "VS Code 扩展能不能直接拿来跑"——真实边界

| 能力 | Worker（现状/P0/P1） | Node 后端（P2） | 说明 |
| --- | --- | --- | --- |
| `require('fs')` | ❌ 没有 `require`，没有内置模块 | ✅ | Worker 里只有 ESM 全局，`import 'node:fs'` 直接解析失败 |
| npm 依赖（已 bundle） | ✅ | ✅ | 三个示例就是这么做的（esbuild 单文件） |
| npm 依赖（未 bundle 的 `node_modules`） | ❌ | ✅ | 需要模块解析 + 目录树，与"单文件 5 MB"限制冲突 |
| ESM | ✅ | ✅ | blob module worker 只认 ESM |
| CJS（`module.exports`） | ⚠️ 可垫片 | ✅ | boot 前注入 6–10 行 `module/exports` 垫片即可吃掉大部分 CJS 脚本，成本极低，建议 P0 做 |
| `require('vscode')` | ❌ | ❌ | **这才是 `.vsix` 跑不起来的真正原因**，不是运行时 |
| `contributes` 语法 | ❌ 不兼容 | ❌ | VS Code 用 `command` 不是 `id`，另有 `when` 子句、`menus`、`viewsContainers` |
| Monaco / LSP / DAP | ❌ | ❌ | 编辑器是 TipTap（ProseMirror），没有语言服务与调试协议 |

**所以"能跑 VS Code 扩展"是假的；能跑的是"用 `package.json` 描述、`main` 指向单个 JS 文件的脚本"——只共享形状。**

---

## 4. 分期交付计划

每期都以"能在真实 release 包上验收"为界，沿用 `verification-plugin-l1.md` 的验收风格。

### P0｜包格式与清单对齐（8–12 人日，体积 ±0）

**可验收的最小成果**：丢进一个文件夹或 `.zip`（根目录有 `package.json`）就能装，`package.json` 用 VS Code 的字段名，现有三个示例插件不改一行代码仍能装。

| 内容 | 说明 |
| --- | --- |
| `plugin.json` → `package.json` | 双读：`package.json` 优先，`plugin.json` 兜底（已装用户不动） |
| 接受 `.zip` / `.qnp` / **目录** | Rust 侧本来就是"按字节当 zip 读"，改的是前端 dialog filter（`install.ts:317` 一行）+ 目录分支 |
| 清单校验扩展 | `main` 允许 `.mjs`；新增 `contributes.commands[].command`（VS Code 拼写）与 `id`（现状）双收 |
| CJS 垫片 | `worker-boot.js` 前置 `module/exports`，把"写了 CJS 直接崩"变成"能跑" |
| `qing.workspace` 命名空间 | `workspace.activeNote`（只读 id/title）、`workspace.onDidChangeActiveNote` |

**验收**：目录安装成功；`package.json` 版本安装成功；`.qnp` 旧包安装成功；CJS 示例能跑。

### P1a｜API 面扩张（10–14 人日，体积 ±0）

**可验收的最小成果**：一个插件能声明一个侧边栏树、读到当前笔记的选中文本、把选中文本替换掉，全程走权限。

| 贡献点 | 最小 API 面 |
| --- | --- |
| **命令** | 已有 `commands.register`；补 `commands.execute(id)` 仅限**自己**的命令（跨插件仍禁止，D6 不变） |
| **侧边栏（声明式树）** | `contributes.views: [{id,title,icon}]`（第 6 个 ActivityBar 图标，或并进 plugins 页左栏）；`qing.views.registerTreeProvider(id, {getChildren})`；节点 `{id,label,description,icon,tooltip,command,collapsibleState}`；`onView:xxx` 激活事件 |
| **编辑器（TipTap 映射）** | `getDoc()` → `{text, length, selection:{from,to}}`（ProseMirror 文档位置）；`getText({from,to})`；`replaceRange({from,to,text})`；`setSelection({from,to})`；`setDecorations(key, ranges[])` |
| **界面** | `ui.toast` 已有；补 `ui.showQuickPick(items)`（复用 `CommandPalette` 的渲染） |
| 新权限码 | `editor:read`、`editor:write`、`editor:decorate`、`views`（前三个加进 `PLUGIN_PERMISSIONS` 与 `KNOWN_PERMISSIONS`，两处必须同步） |

**TipTap 映射的三条硬约束**（写进实现与文档）：

1. `replaceRange` 必须在主窗口执行，并复用 `notes.update` 已有的收尾：落盘 + `emit(NOTE_EXTERNAL_SAVE_EVENT)` + `emit("sticky:note-updated")`——否则打开的编辑器、便签窗口会看到旧内容（`bridge.ts:165–171` 是现成先例）。
2. **装饰只允许 `class` 与白名单 `attrs`**，不接受任意 CSS/HTML。`setDecorations` 在宿主侧维护"每插件一个 PM Plugin + DecorationSet"，禁用即整套拆除。
3. **永不开放 schema/node/mark 注册**（维持 D2）。这是"笔记数据完整性"的最后一条线，比任何功能都重要。
4. 位置语义只承诺"当前活动文档的 PM 位置"，不承诺跨 Markdown 源模式（CodeMirror）一致。

### P1b｜独立扩展宿主进程（12–18 人日，体积 ±0）

**可验收的最小成果**：任务管理器里多一个 renderer 进程；插件里 `while(1){}` + 内存炸弹只死那个进程，主窗口存活并弹出"扩展宿主已重启"。

| 内容 | 说明 |
| --- | --- |
| 第二个 Vite 入口 `extension-host.html` | 只加载 `host-boot.js`，不含 React |
| 隐藏 `WebviewWindow`（label `extension-host`） | 新增 `capabilities/extension-host.json`，`permissions: []` → deny-by-default |
| `qing-plugin-rpc` custom protocol | Rust `register_asynchronous_uri_scheme_protocol`；请求体 JSON，响应体 JSON；**大文本走句柄** |
| CPS | `default-src 'none'; script-src 'self'; worker-src 'self' blob:; connect-src qing-plugin-rpc:` |
| 监督者 | 心跳 + 崩溃计数（沿用"连崩 3 次停用"）+ 指数退避重启 |
| Transport 抽象 | `headless.ts` 抽出 `Transport` 接口，P0 路径用 `inprocess` 实现，P1b 用 `protocol` 实现 |

**未验证项（必须实测后再排期确认）**：
- 隐藏 WebView2 窗口是否稳定拿到**独立 renderer 进程**（Chromium 进程模型下通常成立，但本项目未测）；
- `register_asynchronous_uri_scheme_protocol` 在 P1 的 CSP 下与 blob worker 共存的时序；
- 隐藏窗口的内存基线（量级参考 30–60 MB，未测）。

### P2｜可选 Node 后端（10–15 人日，体积 ±0）

**只有在 P0/P1 上线后确有"必须用 npm 原生能力"的真实需求时才启动。**

- 检测顺序：用户显式指定路径 → `PATH` 里的 `node` → 不启用（**绝不静默回退到某个捆绑二进制**）；
- 协议：`stdio` 上的 **JSON-RPC 2.0，按行分隔（NDJSON）**，不用 LSP 的 `Content-Length` 头（多一层解析、无收益）；
- 启动参数尽量收：`node --permission --allow-fs-read=<pluginDir> --allow-fs-write=<dataDir>/plugins/<id> --allow-net=false`。**明确告知：这是"安全带"不是"边界"**（Node 官方原文见 §1）；
- 安装授权：单独一段红字 + 独立的 `runtime:node` 权限码，与现有 8 个权限码并列展示；
- 索引策略：带 `runtime:node` 的插件在列表里明确标注"需要本机 Node"，且不进入默认推荐；
- 更强的隔离（AppContainer / 受限令牌）列为**未验证的后续项**，不要写进这一期的承诺。

### 4.1 工期汇总（量级，不是承诺）

| 期 | 人日 | 累计 |
| --- | --- | --- |
| P0 | 8–12 | 8–12 |
| P1a | 10–14 | 18–26 |
| P1b | 12–18 | 30–44 |
| P2（可选） | 10–15 | 40–59 |
| 若改"打包 node.exe"（不推荐） | +3（sidecar 配置与 NSIS 侧车替换）+ 前述隔离工作的重做 | — |

---

## 5. 与现有 L1 的关系

**核心结论：没有一处需要重写，全部是增量。已装用户与新装用户的磁盘布局完全不变。**

| 现有资产 | 处置 | 说明 |
| --- | --- | --- |
| `plugin.rs`（1295 行） | **保留** | 只改两处：接受 `.zip`/目录入口；`main` 后缀校验放宽到 `.mjs` |
| `plugin_manifest.rs` | **改** | 加 `contributes.views`、`editor` 相关字段；`KNOWN_PERMISSIONS` 加 4 个码；其余校验（id/semver/engines/越界/原生模块）**一条都不动** |
| `bridge.ts` | **保留为唯一闸门** | 新增 `workspace`/`editor`/`views` 三个 namespace 的 `REQUIREMENTS` 行与实现分支 |
| `headless.ts` | **保留 + 抽接口** | Worker 生命周期、5 s 超时、连崩 3 次停用全部沿用；只把"怎么把消息送出去"抽成 `Transport` |
| `worker-boot.js` | **保留 + 扩** | `qing` 对象加命名空间；加 CJS 垫片 |
| `types.ts` | **改** | 权限码 + 贡献点类型 |
| `components/Plugin/*` | **保留 + 加** | 加 `ViewTree` 渲染器（复用现有侧栏样式），其余不动 |
| `capabilities/default.json`、`tile.json` | **不动** | 新增 `extension-host.json`（空权限） |
| `tauri.conf.json` 的 CSP | **不动** | 主窗口 `connect-src` 不加任何新域；extension-host 窗口单独 CSP |
| 三个示例插件 | **改 3 行** | `plugin.json` → `package.json`；`pack.mjs` 的 SKIP 列表加 `package.json` 改为"打包时重命名" |
| 索引仓库 `index.json` | **不动** | `download` 是 URL，`sha256` 是字节哈希，与扩展名无关 |

**包格式的迁移成本几乎为零，原因是**：Rust 侧把入口文件按字节当 zip 读（`plugin.rs:532` 只是给临时文件起名 `.qnp`），`install.ts:317` 的 `extensions: ["qnp"]` 是唯一硬编码扩展名的地方。同时 `tauri.conf.json` 里**没有 `fileAssociations`**——`.qnp` 从来没有真正注册为文件关联，"双击安装"这件事本来就没实现，所以放弃 `.qnp` 不损失任何东西。

**双格式并存，不硬切**：新文档只写 `.zip` 与文件夹；`.qnp` 永久接受但不再宣传。

---

## 6. 风险与"不做什么"

### 6.1 前三大风险

| # | 风险 | 触发条件 | 缓解 |
| --- | --- | --- | --- |
| R1 | **编辑器 API 污染文档结构**（最严重） | 插件写坏 HTML/PM 结构；或 decoration 注入恶意 class | 只读能力先上线；装饰白名单；写操作强制走 `notes.update` 同一条落盘+广播路径；schema/node/mark 注册**永久不开放**；Yjs 协同路径需单独实测（`@hocuspocus` 在场时的远程事务映射**未验证**） |
| R2 | **P1b 链路变长导致难调试** | 三跳（Worker → ext-host → Rust → 主窗口），时序/超时/错误码归属混乱 | P0 就把 `Transport` 抽出来，两种 transport 共用一套协议与权限表；用 `qing-isolation-probe` 同款插件做端到端探针（时延、崩溃注入、权限拒绝）；feature flag 可回退到 in-process |
| R3 | **Node 后端的"假安全感"** | 用户以为"有权限弹窗所以安全"，实际 Node 侧 `fs` 全开 | 默认关闭；独立红字授权；只在用户显式指定时启用；索引对 `runtime:node` 插件显著标注；不做自动更新（D4）；把"Node 插件 = 全信任"写进开发者文档第一屏 |

### 6.2 明确不做（即使做了也拿不到 VS Code 那种生态）

- ❌ **`.vsix` 兼容 / `vscode` 命名空间 shim**。`require('vscode')` 是 10 万扩展的第一行代码，实现一个语义正确的 shim 等于重做一个 Monaco 语义层，且永远追不上版本。**投多少人都追不上，这是结构性事实，不是工期问题。**
- ❌ **LSP / DAP**。TipTap 是富文本编辑器，没有文件式工作区语义；协议化的前提不存在。
- ❌ **Monaco 式 `TextEditor` 语义**（多编辑器组、语言服务、跳转定义、断点）。
- ❌ **schema / TipTap Extension 注册**（D2 已定，本次维持）。
- ❌ **插件间 `import` 与依赖解析**（D6 维持）。
- ❌ **自动更新**（D4 维持；生态分析里 GlassWorm 的投递通道正是自动更新）。
- ❌ **下载量排行**（已定结论：只给"最近更新 / 兼容区间 / 权限数量"）。

### 6.3 一个必须说清的结构性事实

VS Code 的生态来自"平台方自己就是最大开发者 + 10 万扩展 + 协议化（LSP/DAP）+ 编辑器即工作台"。青记是笔记应用，插件能触达的只有富文本、待办、画布——**同样的机制只能长出"几十个垂直小插件"的量级**，这已经是成功的定义。按 VS Code 的规模去设计 API 面，是为不存在的问题付成本。

---

## 7. 待用户决策（4 条）

1. **目标是"VS Code 式的开发者手感"，还是"能跑现成的 VS Code 扩展"？**
   前者 P0+P1a 就能交付；后者建议当场放弃（理由见 §3.4 / §6.2）。这个答案决定后面全部排期。

2. **"独立扩展宿主进程"是硬需求还是"希望别一个插件崩掉整个应用"的手段？**
   若是后者，P1b（隐藏 webview 承载 Worker，12–18 人日，0 MiB）是答案；若只是要"像 VS Code"，P0+P1a 就够，P1b 可以推迟到真的出现"一个插件拖垮应用"的事故之后。

3. **安装包从 26.05 MiB 涨到约 51–56 MiB，可接受吗？**
   若不可接受 → Node 只能走"用户自备"路线（P2）。若可接受 → 我仍不建议：+25–30 MiB 换来的能力与现有安全模型互斥（§2.1 / §2.2）。

4. **侧边栏先做声明式树，还是一步到位做 webview 面板？**
   建议声明式树（3–4 人日，视觉与现有侧栏一致）；webview 面板（5–8 人日 + 每面板一份内存与 CSP）留给真正需要图表/画布的插件，等有具体需求再开。

---

## 附录 A：本次评审确认的现状事实（代码为准）

| 事实 | 证据 |
| --- | --- |
| 只有 `commands` 一个贡献点 | `plugin_manifest.rs::Contributions` 只有 `commands` 字段；`types.ts::PluginManifest.contributes` 同 |
| D1 的 Track B（插件独立窗口）**未落地** | `capabilities/` 只有 `default.json`、`tile.json`，无 `plugin-window.json`；全仓搜不到 `plugin-window` |
| 权限校验位置 | `bridge.ts::REQUIREMENTS` + `hasPermission`；8 个权限码两处同步（`types.ts::PLUGIN_PERMISSIONS`、`plugin_manifest.rs::KNOWN_PERMISSIONS`） |
| RPC 超时 5 s / 连崩 3 次停用 | `headless.ts:36–37` |
| Worker 无内存上限 | `headless.ts` 全文无内存监控逻辑；堆受 renderer 进程约束 |
| CSP 关键位 | `tauri.conf.json`：`script-src` 无 `blob:`（主线程不能 `import(blob)`）、`worker-src 'self' blob:`、`connect-src` 显式列表 |
| 安装限制 | 单文件 5 MB / 总量 20 MB / 2000 条目 / 禁 `.dll .node .exe .so .dylib .wasm` |
| 私有存储配额 | 1 MB（`STORAGE_QUOTA_BYTES`），日志 100 行，索引 24 h 缓存双源 |
| `.qnp` 无文件关联 | `tauri.conf.json` 无 `fileAssociations`；唯一硬编码是 `install.ts:317` 的 dialog filter |
| Rust 侧与扩展名无关 | `plugin.rs:532` 仅用 `.qnp` 作暂存文件名，读的是字节 |

## 附录 B：未验证项清单（不要当成结论引用）

- NSIS LZMA 对 `node.exe` 的实际压缩比（§2.1 的 +25–30 MiB 是估算）；
- `deno_core` / `rquickjs` / `boa` 嵌入后的真实二进制增量；
- 隐藏 WebView2 窗口是否稳定拿到独立 renderer 进程、其内存基线；
- TipTap 在 Yjs 协同（`@hocuspocus/provider`）在场时，插件驱动的远程事务映射是否与本地一致；
- `register_asynchronous_uri_scheme_protocol` 与 blob worker 在同一 CSP 下的共存时序。
