# 更新日志 / 通告栏 —— 决策记录

> **TL;DR**：告示牌挂在登录弹窗左侧，内容走**远程结构化 JSON**（源 = Gitee 仓库内
> `announcements.json`，raw 直读），同一份文件在构建期打进包做**离线快照**；
> 拉取非阻塞、4s 超时、三层降级；**不改 capability / CSP / `release.yml`**。
> 不做 Supabase（容量受限，用户已否），不做裸 Markdown（无法表达版本区间与多语言）。

## 背景与约束

- 需求：软件内新增「更新日志 / 通告栏」，告示牌样式 UI，放在登录组件（`src/components/Auth/AuthModal.tsx`）左侧。
- 已否方案：**内置文件重新构建**——已安装用户不升级就永远看不到新通告，而登录弹窗的观众恰恰是旧版本用户，位置与机制自相矛盾。它降级为"离线兜底快照"，不淘汰。
- 已否数据源：**Supabase**（用户明确：容量有限，不可用）；**`raw.githubusercontent.com`**（用户侧实测不通）；**Render `collab-server`**（免费实例冷启动 30–60s，会把登录弹窗拖死）；**jsDelivr**（沙箱实测不可达，边缘缓存不可控）。
- 传输通道已存在：`@tauri-apps/plugin-http`（Rust 侧发请求，绕开 webview CSP），`http:default` 已允许 `https://**` 与 `https://**:*`，`src/utils/updateChecker.ts` 是同一套写法的先例。

## 决策

### D1｜主通道 = Gitee 仓库内 `announcements.json`，单源

`https://gitee.com/PyTs1n9/Qing-Notepad/raw/main/announcements.json`

理由（实测）：200 / 0.22s，302 → `raw.giteeusercontent.com`，`Cache-Control: public, max-age=60`；
raw 不走 Gitee OpenAPI，**不吃 60 次/小时/IP 的配额**（该配额实测存在于 `/api/v5/` 下）。
内容进 git：有历史、可回滚、改文案 = 一次 push（不需发版、不需打 tag）。
代码里把源写成**数组**并留好扩展位，但**首版只启用一个**——双源在客户端里通常退化成"两套都没测透"。

### D2｜一份文件两用，杜绝漂移

仓库根 `announcements.json` **同时**是运行时远程 feed 与构建期包内快照（Vite `?raw` 导入）。
不另建 `src/data/changelog/*.md`，避免"包里写 A、远程写 B"。

### D3｜格式 = 结构化 JSON，禁止裸 Markdown

裸 Markdown 缺三样机器可读的东西：版本适用区间、locale 维度、时效/严重度状态。硬从标题里正则解析人类自由文本，一次文案微调就静默失效。

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-28T12:00:00Z",
  "items": [{
    "id": "2026-10-28-blur-0-7-2",
    "kind": "update",
    "publishedAt": "2026-10-28T09:00:00Z",
    "startsAt": null,
    "endsAt": null,
    "minAppVersion": "0.7.0",
    "maxAppVersionExclusive": null,
    "showOnPrerelease": true,
    "title": { "zh": "…", "en": "…" },
    "body":  { "zh": "…", "en": "…" },
    "dismissible": true,
    "pinned": false,
    "link": { "url": "https://github.com/PyTs1n9/Qing-Notepad/releases", "label": { "zh": "查看详情", "en": "Details" } }
  }]
}
```

- `title` / `body` / `label` 用 `{zh,en}` 对象，**不塞进 `src/utils/i18n.ts`**（远程文案注定绕过强类型表，在 schema 层把"绕过"约束住）；缺 `en` 降级到 `zh`，两者都缺则该条丢弃。
- `id` 与 `publishedAt` 必填：前者是"已读"的键，后者是稳定排序的依据。
- 单条 `body` ≤ 8 KB，整包 ≤ 64 KB，`items` ≤ 20，`title` ≤ 120 字符；超限丢该条，不丢整包。

### D4｜缓存与刷新

- **两层缓存**：模块级内存（会话内）+ `<数据根>/announcements/cache.json`（跨启动，经 `src/utils/storage.ts`，禁止 localStorage/IndexedDB）。
- **软 TTL 1 小时**（源边缘缓存 60s，1h 已足够新鲜）；**硬冷却 1 小时**（两次网络尝试的最小间隔，任何触发路径都过这道闸）。
- **触发**：① 打开登录弹窗；② `initialized` 之后 `setTimeout(3000)` 的 idle 一次（受设置开关控制）。两者共用 single-flight。**明确不轮询**。
- **不用 `?t=` 破缓存**：等于每次击穿 Gitee 边缘缓存，迟早触反爬。
- `etag` 存下来发 `If-None-Match` 只省流量、**不省配额**（GitHub 官方文档限定：未带 `Authorization` 头的 304 不保证豁免），配额保护完全靠 TTL。
- 时钟不可信：TTL 用相对差值，`fetchedAt > now + 5min` 视为过期。`startsAt/endsAt` 只用于文案，不作为可见性唯一闸门。

### D5｜降级链与"不阻塞"硬约束

```
内存缓存 → 磁盘缓存（超软 TTL 也照用）→ 包内快照 → 空态（不渲染告示牌）
```

- 单次请求 **4s 硬超时**；`void load()` 调用，**永不 await**，不加入 `App.tsx` 的 `init()` 链。
- 403/429 读 `x-ratelimit-reset` / `retry-after` 把冷却推到该时刻；404 记为该源本会话不可用。
- 200 但 body 非 JSON → 校验失败即降级，**绝不把非 JSON 当 Markdown 渲染**。
- 缓存损坏（解析失败/`schemaVersion` 不认识/`items` 非数组）→ 丢整份（best-effort 删除）回落快照；单条字段非法 → 只丢该条。
- `DATA_DIRECTORY_UNAVAILABLE` → 只走内存 + 快照，不重试、**不重建空目录**。
- 告示牌整体挂 `PanelErrorBoundary`（项目没有根错误边界）。

### D6｜版本匹配

- `appVersion` 用 `APP_VERSION`（`package.json`），**不引入 `getVersion()`**（异步、会逼出 boot 期状态与"两套版本号谁是真的"）。
- 在 `updateChecker.ts` **新增导出 `compareAppVersions`**（内部复用已有 `parseVersion` / `comparePrerelease`），**不复制解析逻辑、不引入 range 语法**：`semver.satisfies("0.8.0-beta.1", ">=0.7.0")` 默认返回 false，这个坑用"`minAppVersion` + `maxAppVersionExclusive` + 三元组比较（忽略 prerelease）"可以整条绕开。
- 预发布用户默认可见（`showOnPrerelease: true`，比较时忽略 prerelease 段），仅当明确不该给 beta 看时才置 `false`。

### D7｜安全

- **唯一渲染入口** `src/utils/markdown.ts` 的 `renderMarkdown()`（raw HTML 已 escape、链接走 scheme allowlist）。严禁 `dangerouslySetInnerHTML` 直塞远程 HTML。
- **在 feed 层剥掉图片**（`![]()` 与 `<img>`）：`img-src` 含 `https:`，远程图会直连并暴露 IP + 打开时间，且通告栏不需要图。
- **链接 host 白名单**在 feed/组件层自校验（`openInDefaultBrowser` 只校验 scheme，不管 host），点击统一走 `src/utils/externalLinks.ts`，禁止 `window.open` / `location.href`。
- **不做签名**：本项目未接 `tauri-plugin-updater`，feed 不能安装或执行任何东西，最坏后果是一段文字 + 一个链接；后者的损害已被"host 白名单 + 外部浏览器打开"压到最低。Ed25519 的密钥/轮换/内置成本远超收益。
- **隐私**：请求只带 `Accept`，不带用户标识、不带 `X-App-Version`；不与 Supabase Auth 会话混用；失败静默（不出现"网络不可用"红字）；设置里给开关。

### D8｜已读状态

`<数据根>/announcements/seen.json`，结构 `{ schemaVersion, seen: { "<id>": "<ISO>" } }`，经 `storage.ts`。
**按 `id` 单键**，不用 `id + 版本` 复合键（否则每升一版把历史通告重看一遍）。不参与云同步；卸载重装会丢、迁移数据目录会保留，可接受。

**忽略（dismiss）另存 `announcements/dismissed.json`**（结构 `{ schemaVersion, dismissed: { "<id>": "<ISO>" } }`）。
它是缓存/已读之外的第三个运行时文件，理由：忽略必须跨弹窗开关存活，否则用户关掉登录窗再打开，刚关掉的通告又回来（QA 第一轮实测复现）。
**忽略是永久的、没有"取消忽略"入口** —— 因此**改一条已发布通告的文案要换新 `id`**，否则只有没忽略过它的人能看到。

### D9｜UI

- 登录弹窗现状 `max-w-[400px]` 居中卡，窗口 `minWidth: 480` → 并排需 400 + 板宽 300 + gutter ≈ **≥ 780px**。
  必须做断点：宽屏并排、窄屏折叠为弹窗上方一条"最新通告"（可展开）；断点按 **`en` 最坏长度**定。
- `kind: critical` **只换配色/图标，不做阻塞弹窗**；全部通告可关闭、永不阻塞登录。
- 同一组件复用到 Help 菜单（否则从不登录的用户永远看不到通告）。
- 注意 `AuthModal.tsx` 已有 `Escape` 全局 keydown，告示牌内部不得吞掉或重复处理。

**布局硬规则（踩过一次，别再踩）**：行容器**不得**在 780 断点用 `w-auto` 收缩宽度
——它让 flex 行变成 shrink-to-fit，子项 `w-full` 失去可解析的百分比基准、静默退回 `max-content`，
400px 的登录卡实测被压到 **270px**，且**不产生横向滚动条、tsc 与构建零信号**，只有量尺寸能抓。
宽度由 `w-full` + `min-[780px]:max-w-[740px]` 决定；验收基准 **row 740 / section 400 / side 300**，
用无头浏览器量 `getBoundingClientRect()`，别用静态算。

**自指陷阱（会误导验收，已知且不修）**：Tailwind v4 默认扫描项目内全部文本（本仓库 `src/index.css` 只有
`@import "tailwindcss";`，没有 `@source` 限定），**文档里出现的裸类名也会被当成候选类编译进产物**。
后果三条：① 用「产物里 grep 类名」证明"类已从元素上删除"是无效判据；② CSS 文件 hash 会随**文档文字**变化，
`index-*.css` 文件名不能当版本凭据；③ 产物里多出无人使用的工具类（约 30 字节）。
**不改 `@source` 收紧扫描范围**——那会影响所有现有样式的生成来源，风险远大于收益。
验收一律以「源码 hash + 量出来的尺寸」为准。本段规避开裸类名，所以不会再自我生成。

**已知取舍**：通告 ≥4 条时侧板（≈442–455px）比登录卡（≈367px）高，`items-start` 下左列会多出一截。
这不是错误（侧板内容驱动高度），要齐平就把 `max-h` 从列表挪到板子外层。**待真机确认观感**。

**刷新按钮不要按"节流就置灰"做**：`isAnnouncementRefreshThrottled()` 不是响应式的，弹窗打开时自动刷新
成功后立刻进入 1h 冷却，若把 `throttled` 放进 `disabled`，按钮从打开就是灰的、而"已是最新"文案只有点击
才会设置 → 文案永久不可达，且长开 1h 也不会自动解除。正确做法：按钮只按 `refreshing || !announcementsEnabled`
置灰，点击时**现算**节流并显示 `announcementUpToDate`；代价是连点两次会重复显示同一句 muted 说明，可接受。

### D10｜明确不改的东西

`src-tauri/capabilities/default.json`、`src-tauri/tauri.conf.json`（CSP）、`.github/workflows/release.yml` —— **零改动**。
隐患留档：将来若收紧 `http:default` 的 allowlist，必须把重定向目标 `raw.giteeusercontent.com` 一并加上，否则是只在发布版复现的 403。

## 落地改动面

| 类型 | 路径 |
| --- | --- |
| 新增 | `announcements.json`（仓库根，远程 feed + 包内快照） |
| 新增 | `src/utils/announcements.ts` |
| 新增 | `src/components/Auth/AnnouncementBoard.tsx` |
| 新增 | `src/components/Help/ChangelogModal.tsx`（用 `ModalShell` 复用同一块牌子） |
| 修改 | `src/components/Auth/AuthModal.tsx`（左侧挂载 + 780 断点 + 窄屏折叠条） |
| 修改 | `src/utils/storage.ts`（**6 个**函数：cache 读/写、seen 读/写、dismissed 读/单条写） |
| 修改 | `src/utils/updateChecker.ts`（导出 `remoteFetch`、`compareAppVersions`、`isPrereleaseVersion`） |
| 修改 | `src/utils/i18n.ts`、`src/index.css`、`src/components/Help/HelpMenu.tsx` |
| 修改 | `src/stores/settingsStore.ts` + `SettingsModal.tsx`（"获取更新通告"开关） |
| 修改 | `src/App.tsx`（D4 触发②：`initialized` 后 idle 3s 刷新；settings 自动保存 payload 带 `announcementsEnabled`） |

**运行时数据文件**（数据根 `announcements/` 下，按需生成，不进版本库）：`cache.json`、`seen.json`、`dismissed.json`。

**提交提醒（多人共用同一工作区时）**：`src/index.css` 的改动里**只有 `.announcement-body` 那一个 hunk 属于本功能**，
其余 hunk 是在途的插件/画布样式，必须 `git add -p` 挑；也**不要 `git add -A`**，工作区混着别人的未跟踪产物。

## 留白 / 后续可做

- 双源（GitHub contents API）已留扩展位，未启用；触发条件是 Gitee 侧不可用或审核风险成真。
- 渠道灰度（按内测名单）需要用户维度，与"完全不标识用户"的隐私立场冲突，明确不做。
- `release.yml` 的 `releaseBody` 与 `announcements.json` 目前是两份文字；后续可让发版脚本从前者生成后者，减少一次手抄。
