# 下一轮开发提示词：知识库 + 知识图谱模块实现

> 本文件是一次性任务书，供下一轮开发会话直接整段复制给工程师使用。
> 设计已定稿，实现零进度，下一轮从 T01 干净起步。
> 权威设计文档：`docs/decisions-knowledge-graph.md`（完整），其中 **§8 增量修订** 与 **§9 任务列表** 是本次实现的直接依据。

---

## 一、任务目标（一句话）

为 Qing-Notepad（Tauri v2 + React 19 + TypeScript + Zustand + Tailwind v4）实现「本地文件夹知识库 + 双链解析 + 知识图谱可视化」模块的**主链路**，对应设计文档 §9 的 **T01–T08**（T09 由 QA 单独跑，T10/T11 可选、本次不做）。

---

## 二、开工前必读（权威，禁止凭记忆另起方案）

1. `docs/decisions-knowledge-graph.md` —— 重点章节：
   - §0.2 已核实事实（id 白名单、fs:scope、ViewType 引用、跳转链路等）
   - §2 模块划分与三条硬隔离线
   - §3 数据组织与链接解析（节点 id 前缀化、索引结构、六级语法、四级消歧、写放大）
   - §4 图谱可视化（现成库选型、布局、交互、主题取色）
   - §8 增量修订（用户三条决策的最终结论，与主体冲突时以 §8 为准）
   - §9 文件级任务列表（T01–T11，含依赖顺序与验收方式）
2. `AGENTS.md` —— 项目构建命令、Windows 构建环境、Session Workflow。

---

## 三、已拍板的三条核心决策（直接采用，不要再权衡）

1. **vault 只读 + 外部编辑自动同步**：目录监听从 v2 提到 v1。用 Rust `notify` crate 建 watcher，经 `app.emit("vault://changed")` 推送 renderer；renderer 用 `@tauri-apps/api/event` 的 `listen()` 订阅后走「先 stat 后哈希」增量扫描。**(relPath, mtimeMs) 300ms 去抖**；递归 watch 单根；60s 目录条目数比对兜底防 watcher 静默死亡；**不需新增 capability**（`core:event:allow-listen/emit` 已含）。
2. **索引写路径 = 按 vault 分片 + 追加日志 journal + compact**：`data/graph/index/vaults/<vaultKey>/` 每分片含 `nodes/edges/stamps/journal.ndjson`；journal 每行 `{op:"upsert"|"remove", ...}`；compact 阈值 5000 行 / 2MB；启动先重放（upsert 幂等、remove 忽略不存在）；半行截断则截到最后一个完整换行。原生笔记归 `vaults/native/`。
3. **图谱渲染用现成库 `react-force-graph-2d@^1.29.2`**（MIT，3 直接依赖，Canvas，底层 d3-force）。`GraphRenderer` 退化为薄适配层；`LayoutEngine` 瘦身为「坐标缓存 + 增量 reheat + 首屏预计算」三件事，库内建 d3-force 算主。`warmupTicks=0`、`cooldownTicks=Infinity` 配 `cooldownTime`；有 `positions.ndjson` 缓存时以缓存坐标初始化跳过首布局。

---

## 四、实现范围（§9 任务列表，按依赖顺序）

### T01 Rust vault 命令族 + 白名单 + 路径校验
- 新增 `src-tauri/src/vault.rs`：`vault_register` / `vault_list` / `vault_remove` / `vault_scan` / `vault_read_file`；canonicalize + 前缀校验；`data/graph/vaults.json` 原子读写（照 `storage.rs` 原子写模式：临时文件 + rename）；scan 递归 read_dir + 批量 stat；read 批量读 + BOM/GB18030 兜底 + >2MB 跳过；内嵌 `#[cfg(test)]` 路径校验单测。
- 修改 `src-tauri/src/lib.rs`：`invoke_handler` 注册 5 命令，**全部 `async`**（非 async 命令跑主线程，5000 文件扫描会冻 UI）。
- **capabilities 无需改动**。
- 验收：`cd src-tauri && cargo check` + `cargo test`（覆盖 `../` 逃逸、不在白名单、canonicalize 越界）。

### T02 renderer 类型 + store + invoke 封装
- 新增 `src/types/graph.ts`：GraphNode / GraphEdge / DanglingRef / FileStamp / VaultRecord / GraphSnapshot / GraphIndexMeta / ParsedLink / Resolution。
- 新增 `src/stores/graphStore.ts`（snapshot/selection/hover/filter/status）、`src/stores/vaultStore.ts`（注册表状态）。
- 新增 `src/utils/graph/vaultService.ts`（invoke 封装 + `listen("vault://changed")` 订阅骨架，供 T08 填充）。
- 验收：`npx tsc --noEmit`。

### T03 链接扫描 + 消歧
- 新增 `src/utils/graph/noteSourceAdapter.ts`（TipTap HTML / 纯 MD / 裸 txt 三种正文形态）。
- 新增 `src/utils/graph/linkScanner.ts`（先等长屏蔽围栏代码块/行内代码/HTML 注释，再扫六种语法）。
- 新增 `src/utils/graph/linkResolver.ts`（NFKC 归一化 + 四级消歧：相对路径 → 同目录同名 → 全局唯一文件名 → 全局唯一标题；歧义不猜，进悬空表）。
- 新增单测脚本 `scripts/verify-graph-scan.mjs`（三态正文、屏蔽、消歧四级断言）。
- 验收：`node scripts/verify-graph-scan.mjs` + `npx tsc --noEmit`。

### T04 索引落盘：分片 + journal + compact
- 新增 `src/utils/graph/graphIndexer.ts`（唯一写入口：upsert/remove/派生入向/重命名修补）。
- 新增 `src/utils/graph/graphIndexStore.ts`（分片、journal.ndjson、compact 阈值、启动重放幂等、原子替换）。
- 新增单测脚本 `scripts/verify-graph-index.mjs`（重放幂等、compact 触发、半行截断）。
- 验收：`node scripts/verify-graph-index.mjs` + `npx tsc --noEmit`。

### T05 布局缓存 + 增量
- 新增 `src/utils/graph/layoutEngine.ts`（positions.ndjson 读写、新增节点 1 跳邻居 reheat、冷启动分簇网格预计算）。
- 新增单测脚本 `scripts/verify-graph-layout.mjs`（缓存读写、邻居质心、分簇网格确定性）。
- 验收：`node scripts/verify-graph-layout.mjs` + `npx tsc --noEmit`。

### T06 现成库渲染适配层 + 图谱页
- 修改 `package.json`：加 `react-force-graph-2d@^1.29.2`（`npm install react-force-graph-2d@^1.29.2`）。
- 新增 `src/components/Graph/GraphRenderer.tsx`（薄适配层：mount/setPositions/setViewport/setSelection/setFilter/dispose/subscribe + §8.3 的 5 个自研回调）。
- 新增 `src/components/Graph/GraphPage.tsx`（工具栏 + 画布容器 + 只读文档面板 + 反链 + 筛选/搜索/vault 列表 overlay 浮层）。
- 新增 `src/components/Graph/NodeListPanel.tsx`（键盘可达节点列表）。
- 验收：`npm run build`；渲染/缩放/拖拽/点击/标签显隐「需人工目视」。

### T07 外壳接线
- 修改 `src/types/index.ts`：`ViewType` 联合类型加 `"graph"`。
- 修改 `src/components/Layout/ActivityBar.tsx`：`items` 数组在 todo 项后插入 `{ view: "graph", label: t(lang, "knowledgeBase"), icon: <Network size={22} strokeWidth={1.7} /> }`，`Network` 从 `lucide-react` 引入。
- 修改 `src/components/Layout/CommandPalette.tsx`：加「打开知识库」命令。
- 修改 `src/plugin/commands.ts`：`BUILTIN_COMMAND_IDS` + `buildHostCommands` 各加一条（`qing.view.graph`）。
- 修改 `src/utils/i18n.ts`：强类型翻译表加 `knowledgeBase`，zh「知识库」/ en「Knowledge Base」。
- 修改 `src/App.tsx`：视图分支（约 1249/1290 行）渲染 GraphPage；`leftSidebarListVisible`（约 1126 行）排除 `"graph"`，即 `currentView !== "canvas" && currentView !== "graph" && (currentView !== "workspace" || authUser)`。
- 修改 `src/components/Layout/Sidebar.tsx`：确认类型兼容（通常无逻辑改动）。
- 验收：`npx tsc --noEmit` + `npm run build`；入口顺序、侧栏隐藏「需人工目视」。

### T08 目录监听 + renderer 订阅
- 修改 `src-tauri/Cargo.toml`：加 `notify` crate。
- 修改 `src-tauri/src/vault.rs` 或 `lib.rs`：watcher（`RecursiveMode::Recursive`）+ (relPath, mtimeMs) 300ms 去抖 + 60s 目录条目数兜底 + `app.emit("vault://changed", …)`。
- 修改 `src/utils/graph/vaultService.ts`：`listen("vault://changed")` → 触发增量扫描。
- 验收：`cd src-tauri && cargo check` + `cargo test`（去抖合并单测）；外部编辑器改文件后图自动更新「需人工目视」。

---

## 五、必须遵守的项目硬规则（踩了就返工）

1. **id 白名单**：现有 `Note.id` 有 `NOTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/`，导入的 md/txt 文件名是中文/空格/括号，**绝不能**直接进 `noteStore` 或 `notes/index.json`。vault 节点 id 用前缀化方案（`v-<vaultKey>-<hash>`、`n-<uuid>`），不造「幽灵 Note」。
2. **数据持久化**：图数据只写 `data/graph/`（派生缓存，可删重建）；原生笔记数据仍走 `storage.ts`。
3. **颜色/主题硬规则**：`text-accent` 必须写 `text-accent-text`；色块上用 `text-on-*` 不用 `text-white`；磨砂只在 `.surface-glass::before`；画布取色必须来自 CSS 变量（缓存成 `GraphPalette`，别每帧 `getComputedStyle`，别硬编码 hex）。
4. **外壳几何**：pad/gutter/top-gap 全 6px 挂 sash，不用 flex gap；图谱页按 §8.4 完全隐藏 sash 侧栏、筛选面板做画布内 overlay 浮层。
5. **flex 行容器禁写 `w-auto`**（会让子项 `w-full` 静默退回 max-content）。
6. **动效只用 `--ease-*`/`--dur-*`**；`scrollbar-width` 必须留在 `@supports not selector(::-webkit-scrollbar)` 内。
7. **代码风格**：字符串/键用 ASCII 直引号；不写 emoji；TypeScript 严格类型。

---

## 六、验证命令与约束

- TypeScript：`npx tsc --noEmit`。**若被 PowerShell 的 npx.ps1 执行策略拦截，只记录、不要反复重试或升级**，继续用 node 脚本 + cargo 验证。
- Rust：`cd src-tauri && cargo check` 然后 `cargo test`；Windows 需 MSVC 环境，先 `. .\env.ps1`（若存在）。
- 单测脚本：`node scripts/verify-graph-scan.mjs`、`node scripts/verify-graph-index.mjs`、`node scripts/verify-graph-layout.mjs`。
- 前端构建：`npm run build`（**用 PowerShell 跑**）。
- 依赖安装：`npm install react-force-graph-2d@^1.29.2`。**dev server 在跑时绝不要 npm install；不要并行跑多个 npm install**。
- **本机无 GUI**：流式/拖拽/窗口/缩放/点击跳转/标签显隐等视觉行为无法本地验证，代码写对即可，验收报告标「需人工目视」，**禁止写"已验证"/"跑过"**。

---

## 七、完成标准

1. 对照 §9 逐条确认 T01–T08 的文件全部落地、依赖顺序正确、无遗漏。
2. 自查上述 7 条硬规则全部遵守。
3. 执行全局一致性审查，输出 `IS_PASS: YES/NO`；NO 则修复后重审（最多 2 轮）。
4. 回传代码摘要：新增/修改文件清单、`cargo check`/`cargo test`/`tsc`/单测脚本/`npm run build` 的实际结果（如实报，含失败项）、「需人工目视」清单、IS_PASS 结论。

---

## 八、禁止事项

- 不要 commit、不要 push。
- 不要动 `docs/`（设计文档已定稿）。
- 不要删任何现有文件。
- 不要碰 `release.yml` 或 capabilities 里设计未要求改的项。
- 不要实现 T10/T11（可选基准），除非明确要求。
