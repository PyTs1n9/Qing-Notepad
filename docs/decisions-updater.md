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

## 每次发布的流程（新增一步）

1. `npm run version:set -- vX.Y.Z` → 提交 → `git pushall`
2. 打 tag 并推 **origin**（触发 CI），再推 gitee（`git push origin vX.Y.Z && git push gitee vX.Y.Z`）
3. CI 构建后自动：创建 GitHub Release、产出 `QingNotepad_X.Y.Z_x64-setup.exe` + `.sig`、
   生成并上传 `latest.json` 与 `latest-gitee.json`
4. **手动**：在 Gitee 建同名发行版，上传 `QingNotepad_X.Y.Z_x64-setup.exe` **和** `latest-gitee.json`
   （后者从 GitHub Release 资产里下，不要改名）
5. 这一步不能省：Gitee 是主源，少了 `latest-gitee.json` 只靠 GitHub 的人会收不到更新；
   而两端都缺时用户会看到"检查更新失败"（刻意不静默）

## 未决问题

1. Gitee 的 `/releases/latest` 是否把 prerelease 也算"最新"——本项目不发 prerelease，暂不影响。
2. Gitee 附件 302 目标里的 `token` / `ts` 是有时效的签名参数。reqwest 会跟随 302，暂时无碍；
   但若哪天 Gitee 改成要求先拿票再下载，这条链路要重做。
3. 27 MB 无断点续传。弱网下的重试与"下载到一半切网"的策略未定（当前只有 600s 上限 + 用户手动重试）。
4. 存量用户（≤0.8.0）**第一次仍要手动装**：带 updater 的第一个版本是 v0.8.1，它自己收不到"下一条推送"。
   发布说明与通告栏都已写明这一点，否则会被当成"自动更新坏了"。
