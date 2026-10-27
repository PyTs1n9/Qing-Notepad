# 决策记录：插件扩展机制

> 完整落地方案见 `docs/plan-plugin-system.md`。本文件只记录「定了什么 + 为什么」，
> 以及仍未定的问题。新增决策请追加到对应小节末尾，不要删除历史条目。

## D1｜运行模型：双轨（同进程 headless + 独立窗口 UI）

**结论**：插件分两条轨道。
- **Track A（headless）**：插件代码在 Web Worker（`worker-src blob:` 已允许）中运行，
  无 DOM、无 Tauri IPC、无文件系统，只能通过 `postMessage` RPC 走宿主桥。
- **Track B（UI）**：插件界面跑独立 `WebviewWindow`（label `plugin-<id>`），
  文档来自宿主自定义协议，CSP 由宿主按权限生成，IPC 权限由 label 级 capability 收紧。

**理由**：
1. 同进程直接 `import()` 插件 JS 会把 `fs:allow-write-file` + `$APPDATA/**` 的既有
   权限全部暴露给第三方代码，等于没有边界。
2. 全部塞进独立窗口会让「只是加一条命令」的插件也背上一个 webview 的内存开销，
   而这类纯逻辑插件（格式化、转换、统计）是最常见的一类。
3. Worker 拦截的是一个真实的隔离边界：Worker 全局对象上没有 `__TAURI_INTERNALS__`，
   拿不到 `window`，也拿不到 `document`，不需要改主窗口 CSP。

**影响文件**：`src-tauri/src/plugin.rs`（新增）、`src/plugin/**`（新增）、
`src-tauri/capabilities/plugin-window.json`（新增）。

## D2｜贡献点：A 档（命令 + 独立视图）

**结论**：v1 只开放两类贡献点：
- `commands`：注册到命令面板（v1 需要同时新建命令面板，宿主目前没有）。
- `views`：ActivityBar 增一个入口，主区渲染插件自己的视图（独立窗口承载）。

**明确不做**（记录以便日后拒绝需求时有据可依）：
- 编辑器工具栏按钮、TipTap Extension、替换核心视图、笔记/待办字段扩展、全量事件监听。
- 原因：TipTap Extension 是编译期对象，必须能在主 webview 执行，会直接拆掉 D1 的隔离；
  而编辑器 schema 与 Yjs 协同文档结构一旦被插件污染，笔记数据完整性无法保证。

**代价（已知并接受）**：`ViewType` 从硬编码 union 改为可扩展、`ActivityBar` 由注册表拼接、
`App.tsx` 主区改为查表渲染。这是 v1 唯一必须动的核心渲染路径。

## D3｜分发：中央索引仓库 + PR 审核

**结论**：新建 `qing-notepad-plugins` 仓库，`index.json` 为唯一索引；插件代码留在作者
自己的 GitHub 仓库，Release 挂 `.qnp` 包；上架 = 往 `index.json` 提 PR，CI 校验后合并。

**理由**：
1. 满足「软件内可浏览」——没有索引就没有列表可浏览，纯自托管 manifest 与此需求冲突。
2. 不引入长期运维成本——自建 registry 对当前 0 个第三方插件的生态是纯支出。
3. 下载与索引都走 GitHub，`plugin-http` 在 Rust 侧执行，主窗口 CSP 无需加入 GitHub 域。

**已知风险**：`raw.githubusercontent.com` 国内不稳定。对策：索引双源（raw → jsdelivr 兜底），
与 `topics/env.md` 里已有的 GitHub 代理经验同一类处理。

## D4｜更新策略：手动确认 + 权限扩大必须重新授权

**结论**：插件不做静默自动更新。发现新版本后由用户在插件页点击更新；更新前后比对
`permissions`，**只要权限集合变大，就重新弹授权**。

**理由**：插件自动更新等于在用户机器上自动执行新代码，且绕过了一次人类确认。
VSCode 在这一点上被批评过，不重踩。

## D5｜版本契约：`apiVersion` 整数 + `engines.host` semver

**结论**：`plugin.json` 用整数 `apiVersion`（v1 起为 `1`）表示对宿主 API 契约的依赖，
用 `engines.host` 的 semver range 表示可运行的宿主版本区间（如 `">=0.8.0 <1.0.0"`）。
宿主只承诺同一 `apiVersion` 内向后兼容；跨 `apiVersion` 由插件作者适配，宿主不做兼容层。

**理由**：单人维护的项目背不起 VSCode 那种多年兼容层。宁可让插件拒绝加载并明确提示
「该插件不支持当前宿主版本」，也不要让宿主内部被历史包袱拖住。

## D6｜插件间依赖：v1 不支持

**结论**：`plugin.json` 保留 `dependencies` 字段但在安装阶段直接拒绝非空值。

**理由**：两条轨道之间无法共享运行时代码，跨插件 `import` 会破坏隔离边界；
真要做依赖解析就得引入模块加载器与版本仲裁，收益远小于成本。确有复用需求时的替代方案是
「作者把公共代码打进自己的包」（构建规范本来就要求单文件产物）。

## 待定问题

1. **发布者签名是否 v1 就上**。当前方案把 sha256 设为强制、ed25519 签名设为索引可选字段。
   若索引仓库只有你一个人合并 PR，签名带来的收益主要是「索引被篡改时兜底」，
   成本是作者要多一步 `minisign` 操作。
2. **插件数据的用户可见性**。`<data>/plugins/<id>/storage.json` 是否纳入现有的
   `docs/user-manual.md` 备份/迁移说明，还是完全对用户隐藏。
3. **索引规模上限**。若某天索引条目超过数百条，单文件 `index.json` 需要分页或按分类拆分，
   触发条件建议定为「条目 > 200」。
