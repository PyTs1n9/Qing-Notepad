# 软件内自动更新 —— 决策记录

> **TL;DR**：接 `tauri-plugin-updater`，点「立刻更新」= 下载 → NSIS passive 安装 → 自动重启，
> 不再跳浏览器；签名走 minisign（**私钥 = 发布权**，丢了就永久断更）；**主源只认 Gitee**
> （`raw.githubusercontent.com` 在本项目已实测不通），GitHub 只作"能连就用"的备源，
> 且**不靠 `endpoints` 数组回落**（它只在非 2xx 时换下一个，超时类失败不回落）；
> 不做前端产物热替换。存量用户（≤0.8.0）没有 updater 代码，**第一次仍要手动装**。

## 背景与约束

- 旧流程：`api.github.com/releases/latest` 只比版本号 → 点「下载更新」`openInDefaultBrowser`
  把用户丢给 GitHub 页面，剩下 27 MB 下载与安装全手动。
- `bundle.targets = "nsis"`、`installMode = "currentUser"` → 静默安装不需要 UAC，
  `installMode: "passive"` 是带进度条的小窗、零交互。这是自动更新能真正跑起来的前提。
- 用户数据在 `resource_dir()/data`，即**安装目录内**（`storage.rs::default_data_root`）；
  插件包在 `<data_root>/plugins`。更新会往同一个目录写文件。
- 安装包 ≈ 27 MB（v0.7.0 实测 26,996,343 B）。官方 updater 全量替换，**没有增量补丁**。

## 决策

### D1｜用官方 updater，不做前端产物热替换

Tauri v2 的前端产物由 `tauri::generate_context!` 在**编译期**内嵌进 exe，运行时没有可替换的资源目录。
要"换前端不换 exe"，只能自建 `register_uri_scheme_protocol` 从可写目录读 dist 再把窗口指过去。代价：
CSP 的 `'self'` 语义失效、IPC 与 capability 全暴露给能被远程替换的代码、签名链只保护 exe 不保护前端、
Rust 侧 100+ command 无法同步（长期"新前端 + 旧命令"错配）。

**结论**：真「热」只保留 `.qnp` 插件通道（Worker 隔离 + 13 个权限码 + 回滚）。易变功能外置成插件，不动主体。

### D2｜人工确认，确认后自动重启

`check()` → 弹窗展示版本与发行说明 → 用户点「立刻更新」→ 进度条 → Windows 上进程被结束 →
NSIS passive 安装 → 安装器 `/R` 拉起新版本（`Update::restart_after_install` 默认 true）。

实现上必须绕开三个坑：

1. **Windows 上 `download_and_install()` 之后的代码执行不到**。进度只能用事件
   （`update:progress` / `update:installing`），"已更新"的收尾逻辑不能写在 `await` 之后。
2. **探测超时不能拿来下载**。`locate()` 给端点的是 6s / 4s 预算，而 `Update.timeout` 会被
   `download_and_install` 复用；所以下载前显式改成 600s（`update.timeout = Some(...)`）。
3. **安装阶段 IPC 会断**。`install_update` 的 invoke 在 Windows 上通常以"连接断开"告终，
   前端不能把它画成失败——见过 `update:installing` 之后就不再报错。

按钮态：进度起来后「稍后 / 不再提醒」禁用。安装已经开始，这时候给出口只会让人以为能取消。

> **v0.9 已改**：这一节描述的「一次点击 = 下载 + 安装」已被 D8 的两段式取代；
> `install_update`、`update:installing` 与启动弹窗都已删除。上面三条约束仍然成立，
> 只是现在分别落在 `download_update`（第 1、2 条）与 `install_downloaded`（第 3 条）上。

### D3｜签名密钥 = 发布权

- `tauri signer generate` 生成一对 minisign 密钥。公钥进 `tauri.conf.json` 的 `plugins.updater.pubkey`，
  随每个安装包分发；私钥只在构建时用（`TAURI_SIGNING_PRIVATE_KEY`），对每个安装包产出 `.sig`。
- 它管三件事：① 证明安装包出自作者；② 阻断中间人替换（没私钥签不出能过验的 `.sig`）；
  ③ 决定"还能不能继续发版"——老版本 exe 里烧死公钥，**换 key 等于老用户永久停在旧版**。
- 它**不是** Authenticode 证书（那个管 SmartScreen/UAC 的"发布者"，要另行购买），也不是 GitHub token。
- 止损不对称：token 泄露可吊销；私钥泄露只能"发更高版本去覆盖"，覆盖前攻击者推的版本是**合法签名**的。
- **本项目的密钥于 2026-11-01 生成**：私钥 `%USERPROFILE%\.tauri\qing-notepad.key`、密码同名 `.key.pass`，
  两处都不进仓库（`.gitignore` 新增 `*.key` / `*.key.pub` / `*.key.pass`）。待办：迁进密码库 + 离线备份，
  并把两份内容分别写进 GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 轮换预案：要换 key，必须先用旧 key 签一个"内置新公钥"的过渡版本，铺开之后再换。旧 key 至少保留到那之后。

### D4｜Gitee 主源，GitHub 尽力而为

实测（2026-11-01，本机网络）：

| 探测 | 结果 |
| --- | --- |
| `gitee.com/.../releases/download/v0.8.0/<exe>` | **200**，302 到 `foruda.gitee.com/attach_file/...?token=...`，整包 27,546,229 B 下完 |
| 同上，空 UA / `tauri-updater` UA | **200**，同样整包；不校验 UA、不校验 Referer |
| `gitee.com/.../releases/latest` | **302 → `/releases/tag/v0.8.0`**（tag 可以白拿） |
| `gitee.com/.../releases/latest/download/<file>` | **不支持**，302 到 `/repository/archive/latest/download/...` |
| `raw.githubusercontent.com` | 本项目早已实测不通（见 `decisions-announcements.md`） |

于是：

- **端点不是固定 URL，而是按版本定位**：先取 `/releases/latest` 的 302 拿 tag，再拼
  `gitee.com/.../releases/download/<tag>/latest-gitee.json`。
- **两份清单，同一份签名**：`latest.json` 的 `url` 指 GitHub、`latest-gitee.json` 指 Gitee。
  文件名不同是因为两份内容只差在 `url`，同名会让人分不清手里这份指向哪个源。
- **顺序 Gitee → GitHub**，任一方返回"有新版本"就停。只要有源明确回答"已是最新"就算成功
  （另一个源挂了不该让用户看到"检查失败"）；**全部失败**才抛错——这样"忘了给 Gitee 传清单"
  是可见的错误，而不是静默的"已是最新"。
- **不把两个地址写进 `tauri.conf.json` 的 `endpoints`**：官方回落语义是"只有返回非 2xx 才试下一个"，
  连接超时 / DNS 污染不会回落，双源会静默退化成单源。`update.rs` 自己按顺序解析出一个确定可用的端点，
  签名校验、版本比较、安装器调用仍全部复用官方实现。

### D5｜数据目录暂不迁移，但发布前必须实机验证

Tauri 的 NSIS 模板（`crates/tauri-bundler/.../nsis/installer.nsi`）：更新模式（`/UPDATE`）下不运行旧卸载器；
卸载段只 `Delete` 已知文件数组，收尾是**非递归**的 `RMDir "$INSTDIR"`（目录非空即失败）。
按此推断 `data/` 与 `plugins/` 会在原地保留。

但这是读模板源码的结论，**没有在真机上装过**（本机无 GUI）。首个带 updater 的版本发布前，
必须在干净虚拟机上走一遍「旧版 → 新版」，检查 `data/` 完好、`.qnp` 插件仍在。

### D6｜打开 `requireSignedVersion`

`plugins.updater.requireSignedVersion = true`：要求签名里带版本号，并与清单里声明的 `version` 比对。
它挡的是"拿一个旧的合法签名包、把清单里的 version 改成更高"这种重放攻击。

可行性已实测：`tauri bundle` 产出的 `.sig` 里 trusted comment 是
`timestamp:… file:QingNotepad_0.8.0_x64-setup.exe version:0.8.0`，而手动 `signer sign` 不带
`--app-version` 时没有 `version:` 段。也就是说构建链路自己就会带上版本号，开关打开不需要额外动作。
前提是发布时先跑 `npm run version:set`（CI 里已有），让 `tauri.conf.json` 与 tag 一致。

## 实现落点

| 文件 | 作用 |
| --- | --- |
| `src-tauri/src/update.rs` | 源解析 + `check_update` / `install_update` 两个命令，进度事件 |
| `src-tauri/src/lib.rs` | 注册 updater 插件与两个命令 |
| `src-tauri/Cargo.toml` | `tauri-plugin-updater`（关默认特性）+ `reqwest`（复用 0.13，不新增 HTTP 栈） |
| `src-tauri/tauri.conf.json` | `createUpdaterArtifacts`、`pubkey`、`requireSignedVersion`、`windows.installMode: passive` |
| `src/utils/updateChecker.ts` | `checkForUpdate` / `installUpdate` / 事件名常量；删掉 `api.github.com` 那条路 |
| `src/components/Help/UpdateAction.tsx` | 唯一下载/安装入口，两个弹窗共用 |
| `src/components/Help/UpdateCheckModal.tsx`、`src/components/Settings/UpdateModal.tsx` | 接入 `UpdateAction`，busy 时关掉次要出口 |
| `scripts/updater-manifest.mjs` | 由构建产物的 `.sig` 生成两份清单 |
| `.github/workflows/release.yml` | 注入签名 secret、生成并上传两份清单 |

`tauri-plugin-updater` 默认特性带 `rustls-tls` 与 `zip`：前者会再塞一整套 rustls + ring（而
`tauri-plugin-http` 走 native-tls/schannel），后者只为解压 Windows 用不到的包，却会拉进 `tar`。
这里只保留 `native-tls` + `system-proxy`。

## 每次发布的流程

0. **三处文案同步，缺一不可**：`release.yml` 的 `releaseBody`（GitHub Release 正文）、
   `UPDATE.md`（更新卡片正文，CI 用 `--notes-file` 写进两份清单）、`announcements.json`
   新增一条（公告板 / 更新日志，`id` 形如 `YYYY-MM-DD-vX-Y-Z`、放数组最前、
   `publishedAt` 用 **UTC** 发版时间）。三处用户可见正文必须一致，公告只可补一句入口位置。
   规则与发版前自检命令见 `AGENTS.md` §Release Content Sync。
1. `npm run version:set -- vX.Y.Z` → 提交 → `git pushall`
2. 打 tag 并推 **origin**（触发 CI），再推 gitee（`git push origin vX.Y.Z && git push gitee vX.Y.Z`）
3. CI 构建后自动：创建 GitHub Release、产出 `QingNotepad_X.Y.Z_x64-setup.exe` + `.sig`、
   生成并上传 `latest.json` 与 `latest-gitee.json`
4. **手动**：在 Gitee 建同名发行版，上传 `QingNotepad_X.Y.Z_x64-setup.exe` **和** `latest-gitee.json`
   （后者从 GitHub Release 资产里下，不要改名）
5. 这一步不能省：Gitee 是主源，少了 `latest-gitee.json` 只靠 GitHub 的人会收不到更新；
   而两端都缺时用户会看到"检查更新失败"（刻意不静默）

## 顶栏更新入口（v0.9）

> **TL;DR**：把「发现新版本」从启动弹窗搬到标题栏右侧：平时不占位，有新版本才出现；
> hover 展开卡片读更新内容，第一次点击 = 下载，第二次点击 = 启动安装器并重启。
> 启动弹窗下线，检查时机改为「启动 + 窗口聚焦（1h 限频）」。

### D7｜入口只在有新版本时出现

**结论**：标题栏右上角、公告喇叭与账号胶囊之间放一个 32×32 图标；无更新时整块不渲染，
检查失败也不占位。手动检查仍走帮助菜单。

**理由**：36px 高的标题栏里，常驻灰态图标会与公告图标争夺注意力，而「没有更新」本身不提供
信息。出现即信号，比「灰态 + hover 解释」少一次阅读。

### D8｜点击 = 两阶段：先下载，再重启

**结论**：第一次点击触发 `download_update`，图标换成重启图标；下载完成后第二次点击触发
`install_downloaded`，安装器接管、应用退出、装完自动拉起新版本。

**理由**：Windows 上不存在「装完再重启」——`Update::install` 的文档写明启动安装器成功后应用
即退出，NSIS 必须先结束进程才能覆盖 exe。可等待的节点只有「下载完成」。官方 `download()` 与
`install(bytes)` 本来就是分开的 API，签名在两边各校验一次，拆分不需要自写安装逻辑。

**代价（接受）**：下载结果放内存（约 27 MB），应用退出即丢弃，下次启动重下。不落临时文件，
因为临时文件要处理版本失效、权限与残留清理，而 27 MB 的重复下载成本低于一套缓存目录。

### D9｜更新内容来自 UPDATE.md，由 CI 写进清单

**结论**：仓库根新增 `UPDATE.md`，每个版本发布前手工改写；CI 调用 `updater-manifest.mjs` 时
补 `--notes-file UPDATE.md`，两份清单的 `notes` 都取它；卡片用 `renderMarkdown` 渲染
`UpdateInfo.body`。

**理由**：把 UPDATE.md 打包进 exe（`?raw`）只能描述「已经装上的版本」，而卡片要展示的是新版本，
必然滞后一个版本。随清单分发时，`vX.Y.Z` 的清单里就是 `vX.Y.Z` 的正文，版本与内容天然对齐，
且不新增网络请求（清单本来就要取）。

**被否决**：前端直接抓远程 `UPDATE.md`。多一次请求、`raw.githubusercontent.com` 在本项目实测
不通，且正文与「是否有新版本」来自两个不同时刻，会出现文案已更新而清单未更新的错配。

### D10｜忽略 = 仅本次会话隐藏

**结论**：卡片右上「忽略此版本」只写内存标记，徽标与卡片在本次运行内不再出现，重启应用后恢复。
不写 settings；`updateReminderDisabledForVersion` 随启动弹窗一起删除。

**理由**：一次误点不该让用户永久错过后续版本。「永久不再提醒」在只有徽标、没有弹窗的界面里
也没有存在意义——不点就不打扰。

### D11｜检查时机：启动一次 + 聚焦时重查，1 小时限频

**结论**：应用初始化后查一次；窗口从后台/托盘回到前台时再查，两次至少间隔 1 小时。帮助菜单的
检查更新仍然强制查。

**理由**：桌面应用常开数天，只在启动查会让徽标永远不出现；每次聚焦都发请求会打满 Gitee 的探测
预算（6s 超时）并浪费流量。1 小时与公告源的软 TTL 一致。

### D12｜卡片形态

- 锚在图标下方右对齐，宽 360px；正文 `max-h-[300px] overflow-y-auto`
- 头部：`vX.Y.Z 可以更新` + 右侧「忽略此版本」；下一行「当前版本 vX.Y.Z」
- 正文：`UpdateInfo.body`；为空时整段不渲染，不留空白框
- 底部：「查看完整说明 ↗」→ `https://gitee.com/PyTs1N9/Qing-Notepad/releases/tag/vX.Y.Z`
- 下载态：进度条 + 百分比 + 已下载/总量，复用现有 `update:progress` 事件
- 就绪态：图标换 `RotateCcw`，卡片底部换成「重启以完成更新」
- 关闭：指针离开「按钮 ∪ 卡片」150ms 后关闭；`Escape` 关闭；`Tab` 聚焦到按钮时展开

**理由**：hover 卡片必须能在指针从按钮移进卡片时不闪断；正文长度不可控，限高滚动比撑高窗口安全。

### 本次落点

| 文件 | 作用 |
| --- | --- |
| `src-tauri/src/update.rs` | 拆出 `download_update` / `install_downloaded`，用托管状态存 `Update` 与字节；删除 `install_update` |
| `src-tauri/src/lib.rs` | 注册两个新命令与托管状态 |
| `src/stores/updateStore.ts` | 只存内存状态（阶段、进度、版本、本次会话忽略） |
| `src/hooks/useUpdateController.ts` | 事件订阅、启动/聚焦检查、调用两个命令并写 store |
| `src/components/Layout/UpdateBadge.tsx` | 图标 + hover 卡片 |
| `src/components/Layout/TitleBar.tsx` | 挂载徽标 |
| `src/components/Help/UpdateAction.tsx`、`Settings/UpdateModal.tsx` | 改走共享流程 / 删除 |
| `src/App.tsx` | 移除启动检查与 `UpdateModal`，挂载控制器 |
| `UPDATE.md`、`.github/workflows/release.yml` | 正文源与 `--notes-file` |

**分层**：`stores` 不 import `@tauri-apps/*`（见 `decisions-architecture-layering.md`），
事件订阅与 `invoke` 全部留在 hook 里。

## 未决问题

1. Gitee 的 `/releases/latest` 是否把 prerelease 也算"最新"——本项目不发 prerelease，暂不影响。
2. Gitee 附件 302 目标里的 `token` / `ts` 是有时效的签名参数。reqwest 会跟随 302，暂时无碍；
   但若哪天 Gitee 改成要求先拿票再下载，这条链路要重做。
3. 27 MB 无断点续传。弱网下的重试与"下载到一半切网"的策略未定（当前只有 600s 上限 + 用户手动重试）。
4. 存量用户（≤0.8.0）**第一次仍要手动装**：带 updater 的第一个版本是 v0.8.1，它自己收不到"下一条推送"。
   发布说明与通告栏都已写明这一点，否则会被当成"自动更新坏了"。
5. 卡片在 <900px 宽窗口下的收窄/贴边策略：`preview-update-badge.html` 在 820px 下实测贴边对齐
   （右侧与按钮右缘重合，宽 360 未压缩）。真机的 hover 时序、拖拽与多显示器缩放仍需实测。
6. 下载完成后长时间不点重启，内存里会一直压着 27 MB。是否需要「超时丢弃」尚未决定。
7. `install` 启动安装器后应用退出的时序按文档是「立即退出」，需一次真机验证（与 D5 同批走）。

## 静态验证记录（2026-11-03）

- `npx tsc --noEmit` 通过；`cargo check` 通过（仅 `plugin_host` 的两条既有 dead_code 警告）。
- `npm run build` 通过；产物 CSS 里 `.compact-markdown` 的 `list-style-type: disc` 与
  `.markdown-blank-lines { display: none }` 均存活 —— 压缩器会把 `list-style: disc outside`
  压成 `list-style: outside`，所以这两个属性刻意写成 longhand。
- `npm run verify:ui-polish` 152 组配色无失败；`node scripts/verify-architecture.mjs` 的
  R1–R4 通过，R5 失败来自 `src/utils/livePreview/index.ts` 未登记，与本次改动无关。
- `preview-update-badge.html` 截了空闲 / 下载中 / 就绪 / 失败四种状态与 820px 窄窗口，卡片
  右缘始终与按钮右缘对齐（`btn 1034–1066 · card 706–1066`）。
