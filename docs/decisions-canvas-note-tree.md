# 决策记录：笔记文件树 → 画布结构图（2026-10-28）

> **TL;DR**：给宿主加一层「画布写 API」+ 一个参考插件。画布新增引用型节点（`ref`）、曲线连线、`hidden` 字段；插件读笔记树、算右向树布局、按 `noteId` 幂等写回画布。**只读引用，不做反向回写。**

## 背景

用户要求把笔记的 Markdown 内容"以文件树的形式拉取到 canvas 画布"，并明确要求模仿幕布的结构图（大纲 → 一键生成思维导图，可折叠、曲线连线、4 种布局）。

核对现状后确认：这不是"写一个插件"，而是**先给宿主加一层画布 API**——`src/plugin/bridge.ts` 当前只有 `notes` / `todo` / `clipboard` / `storage` / `ui` / `commands` / `views` / `editor` 通道，13 个权限码里没有 canvas；画布本身也只有 `text` / `shape` / `image` / `connector` / `doodle` 五种条目，无法表达"指向某篇笔记"。

## 结论

| # | 主题 | 决定 | 理由 |
| --- | --- | --- | --- |
| D1 | 树形态 | 连线树，**右导图**单向展开（根在左，向右生长）；单一虚拟根「全部笔记」 | 有唯一根才撑得起幕布那种"从中心发散"的观感；多布局（左右/上下）成本非线性，v1 只做一种，布局函数预留 `direction` 参数不暴露 UI |
| D2 | 引用节点 | 新增 `CanvasRefItem { type:"ref", ref, title, excerpt?, summary?, summaryHash? }`，`ref` 三态：`{kind:"note",id}` / `{kind:"folder",id}` / `{kind:"root",label}` | 一个类型覆盖根/文件夹/笔记，渲染与命中逻辑统一；比"note item + shape 当文件夹"少一套分支，也方便日后引用待办或画布 |
| D3 | 只读语义 | `ref` 节点**不可就地编辑**，双击打开源笔记；不做"画布改文字回写笔记" | 直接消掉一整类双向冲突。代价是画布上改不了正文，这是明确接受的边界 |
| D4 | 连线曲线 | `CanvasConnectorStyle` 增加 `"curve"` | 幕布观感有一半来自贝塞尔；纯增量枚举，四处改动都是加分支 |
| D5 | 折叠 | `CanvasItemBase` 增加 `hidden?: boolean`；宿主只负责"不画、不命中、不路由连线"，折叠逻辑（算隐藏集）留在插件 | 把"树"的语义留在插件里，宿主只给最基础能力，符合"宿主给能力、插件给产品逻辑"的分层 |
| D6 | 同步 | 按 `noteId` upsert 幂等；**位置以画布为准**（已存在节点只更新文本字段，不动 `x/y`）；**不做自动墓碑**，重新拉取会重建被删节点；源笔记已消失的节点由 `cleanMissing` 命令显式清理 | 画布是用户手工成果，且**画布没有回收站**，任何自动删除都不可撤销；墓碑需要额外状态和「恢复」入口，收益不抵复杂度（落地修正，见末节） |
| D7 | AI 概括 | 宿主提供复合能力 `qing.ai.summarize(noteId)`，prompt 与模型留在宿主内；**按需触发 + 内容 hash 缓存** | API 是 BYOK 用户自付，150 篇批量概括的费用与等待都不可接受；缓存 key 用 `noteId + 内容 hash`，正文没变不重算 |
| D8 | 权限 | 新增 `canvas:read`、`canvas:write`、`ai:summarize` 三个码；`read` **只返回引用节点的键**，不返回画布内容 | 落地时发现没有读取能力就无法对账（判断哪些节点被用户删了、哪些源笔记已消失）。把 `read` 收窄到「键列表」，既解决对账，又不暴露用户画的图 |
| D9 | 布局算法 | 自写（定宽定高 + 后序子树占高），不引入依赖 | 节点定宽 240 × 定高 92 之后，tidy tree 退化为"按叶子分配垂直槽位"，约 40 行；插件包对供应链敏感，能不加依赖就不加（详见 §五 选型） |
| D10 | 视觉 | **只迁移几何与结构**（定宽节点、层级字号递减、父节点右侧中点出发、同层垂直居中、兄弟等距），配色/圆角/阴影全部走现有 token | 幕布是极简单一浅色，我们有多主题（dark/blue/yellow/green）；照抄白卡片会在暗色主题下直接破功，也违反"色块上写 `text-on-*`、不写死颜色" |
| D11 | 规模降级 | 超过 150 个节点时降级：只画文件夹骨架 + 每夹最多 12 篇 + 一个「还有 N 篇」占位节点 | 连线树是 2N 条条目，上百节点后拖拽与缩放会明显变慢，视觉也会糊 |

## 宿主 API 设计

四个方法，全部落在 `canvas:write` 下。插件只提交数据，不渲染、不读画布。

```ts
// 0. 只列出引用键（不是画布内容），用于对账。落地时新增。
qing.canvas.listRefKeys({ boardId? }) => Promise<{ boardId: string; refKeys: string[] }>;

// 1. 批量 upsert 引用节点。已存在的按 noteId 只更新文本字段，不动 x/y。
qing.canvas.upsertRefNodes({
  boardId?, // 省略 = 用户当前打开的画布
  nodes: Array<{
    ref: { kind: "note"; id: string } | { kind: "folder"; id: string } | { kind: "root"; label: string };
    title: string;
    excerpt?: string;
    summary?: string;
    summaryHash?: string;
    x: number; y: number; width: number; height: number;   // 仅首次创建时采用
  }>;
}) => Promise<{ idByRefKey: Record<string, string>; created: number; updated: number }>;

// 2. 批量补连线。两端都能解析到节点才建，重复同向不重建。
qing.canvas.upsertRefConnectors({
  boardId?, // 省略 = 用户当前打开的画布
  edges: Array<{ from: string; to: string; style: "curve" }>;  // from/to 传 refKey
}) => Promise<{ created: number }>;

// 3. 隐藏/显示（折叠）。插件算好隐藏集后一次提交。
qing.canvas.setNodesHidden({ boardId?, refKeys: string[], hidden: boolean }) => Promise<{ changed: number }>;

// 4. 按 refKey 删节点（失效清理）。
qing.canvas.removeRefNodes({ boardId?, refKeys: string[] }) => Promise<{ removed: number }>;
```

`refKey` 是插件侧的稳定键：`note:<id>` / `folder:<id>` / `root`。宿主维护 `refKey → itemId` 的解析，插件永远不需要知道画布条目 id。

另加一个笔记侧方法（**不新增权限码**，落在已有 `notes:read`）：

```ts
qing.notes.tree() => Promise<{
  folders: Array<{ id: string; name: string; parentId: string | null; order: number }>;
  notes: Array<{ id: string; title: string; categoryId: string | null; order: number }>;
}>;
```

理由：现有 `qing.notes.list()` 只返回 `{id,title,tags}`，**没有 `categoryId`**，拿不到归属就画不出文件树；而它返回的仍是笔记元数据，权限语义没有扩大。

## 宿主改动清单

| 文件 | 改动 |
| --- | --- |
| `src/types/canvas.ts` | ① `CanvasConnectorStyle` 加 `"curve"`；② `CanvasItemBase` 加 `hidden?: boolean`；③ 新增 `CanvasRefItem` 与 `CanvasRefTarget`；④ `CanvasNodeItem` union 扩展为含 `ref`；⑤ `isCanvasNodeItem` 白名单同步 |
| `src/types/index.ts` | 导出 `CanvasRefItem` / `CanvasRefTarget` |
| `src/utils/canvasGeometry.ts` | 新增 `curvePath()`；`resolveCanvasConnector` 走三分支；两端任一 `hidden` 时返回空路径 |
| `src/utils/canvasExport.ts` | 导出支持 `curve` 路径与 `ref` 节点（缩略图/PDF 同源） |
| `src/components/Canvas/CanvasView.tsx` | ① 渲染分派加 `ref` 卡片（`tone` 按 kind 区分）；② `hidden` 条目跳过绘制与命中；③ 双击 `ref` → 打开源笔记；④ 工具栏加「曲线」菜单项；⑤ 删除/复制粘贴对 `ref` 的处理 |
| `src/components/Canvas/CanvasBoardPreview.tsx` | 缩略图分派加 `ref`，`hidden` 跳过 |
| `src/plugin/types.ts` | `PLUGIN_PERMISSIONS` 加 `canvas:write`、`ai:summarize`；`PERMISSION_LABEL_KEYS` 加两条 |
| `src/plugin/bridge.ts` | 新增 `canvas` 命名空间 4 方法 + `ai.summarize`；`notes.tree` |
| `src-tauri/src/plugin.rs`（含 manifest 校验） | 权限白名单同步两码；`E_PERMISSION_UNKNOWN` 语义不变 |
| `src/utils/i18n.ts` | 权限人话两条（zh/en）；画布「曲线」文案；ref 节点失效态文案 |
| `docs/plugin-guide.md` | 权限表 + API 速查 + 错误码补 `canvas` 分支 |
| `scripts/verify-plugin-e2e.mjs` / 新增 `verify-plugin-note-tree.mjs` | 断言见 §六 |

## 插件侧

`examples/qing-note-tree/`（`package.json` + TypeScript，产出 `dist/extension.js`）：

```text
src/
├── extension.ts      activate：注册命令、读 notes.tree、拼树、调 canvas API
├── tree.ts           文件夹/笔记 → 树节点（含未分类笔记挂根下）
├── layout.ts         右向树布局：定宽定高 + 后序子树占高（40 行）
├── fold.ts           折叠：从 collapsed 集合算隐藏集
└── sync.ts           墓碑 + summaryHash 缓存 + 幂等判定
```

命令贡献：

- `qing-note-tree.pull` —— 拉取/同步到选定画布（宿主弹画布选择器后注入 `boardId`）
- `qing-note-tree.collapse` / `qing-note-tree.expand` —— 当前选中节点折叠/展开
- `qing-note-tree.summarize` —— 对选中节点生成 AI 概括（单个）
- `qing-note-tree.cleanMissing` —— 清理失效节点

布局参数（写死，v1 不暴露 UI）：节点 240×92，层距 320，兄弟间距 24，根居中于子树组。

## 五、布局选型（architect）

| | 方案 A：自写 tidy tree | 方案 B：`d3-hierarchy` | 方案 C：`d3-flextree` |
| --- | --- | --- | --- |
| 技术栈 | 无依赖，40 行 | 成熟库，~18 KB | 专治变高节点 |
| 为什么适合 | 定宽定高后算法退化，叶子槽位分配即可 | `tree()` 处理分离度，边界情况稳 | 节点高度不等时唯一稳解 |
| 开发难度 | 低（但子树宽度边界要自己测） | 低 | 中 |
| 维护成本 | 零 | 跟上游版本 | 社区小、停更风险 |
| 目标地区可用性 | 不适用 | npm 正常 | npm 正常 |
| 你得自己管的东西 | 重叠边界用例 | 依赖升级与安全审计 | 同左，且更小众 |
| 主要风险 | 不同高度节点重叠 | 无 | 维护风险 |

**推荐：方案 A**。决定性理由：一旦接受"节点定宽定高、摘要最多两行"，方案 B/C 解决的"变尺寸分离"问题在本场景不存在；而插件包是本项目安全模型里最敏感的东西（索引审计、`E_NATIVE_MODULE`、体积上限），能不加依赖就不加。

## 六、验收判据

**可本地跑（无 GUI）**

1. `npx tsc --noEmit` 零错误。
2. `npm run verify:plugin-e2e` 通过（现有 14 项不回归）。
3. 新增 `npm run verify:plugin-note-tree`，在 mock 宿主里断言至少 6 条：
   - 空笔记库 → 只产出 1 个根节点，0 条连线；
   - 3 层文件夹 + 未分类笔记 → 节点数 = 文件夹数 + 笔记数 + 1，未分类挂在根下；
   - 同输入跑两次 `upsertRefNodes` → `created` 第二次为 0，`updated` 等于节点数，`x/y` 与第一次一致（幂等 + 位置不被重置）；
   - 用户在画布上删掉一个节点后再同步 → 该节点不重建（墓碑生效）；
   - 源笔记删除 → `removeRefNodes` 只删被点名的 refKey，其余不动；
   - 折叠一个分支 → `setNodesHidden` 收到的 refKeys 恰好是该分支的全部后代（不含自身）。

**必须 release 包手动验（本机无 GUI，不能声称已验）**

4. 装 `.qnp` → 命令面板执行「拉取笔记树」→ 选画布 → 出现右向树、曲线连线。
5. 拖动节点后再次同步 → 位置不变，标题改名会跟随。
6. 双击笔记节点 → 打开对应笔记。

## 暂未确定

- `collapsed` 状态存 item 字段还是插件 storage（当前倾向前者，随 board 保存，换设备也在）。
- 双击 `ref` 是否支持 Ctrl+点击在新标签页打开。
- 150 节点降级阈值是否按画布缩放再调。
- 是否要"从画布删除节点 = 写入墓碑"，还是只有显式命令才写墓碑（当前倾向：删除即墓碑，否则每次同步都会复活）。

## 实施偏离（2026-10-28 落地时）

落地过程中有五处与上文设计不同，以这里为准：

1. **多了 `canvas:read`**，只提供 `listRefKeys()`（返回 `note:<id>` / `folder:<id>` / `root`，不含任何画布内容）。原设计假定「写入不需要读」，实际做 `cleanMissing` 时发现无法对账：插件不知道画布上有什么，就分不清「用户删了这个节点」和「这篇笔记是新的」。收窄到键列表后，既解决问题又不扩大暴露面。
2. **`boardId` 改为可选**。原设计要宿主弹选择器注入，但宿主没有这个 UI；改为省略即「当前打开的画布」，不在画布视图时抛 `E_NO_CANVAS`。用户要写到别的画布，先在画布里切过去。
3. **不做墓碑**。原 D6 计划「用户删掉的节点不重建」，但重新拉取会让删除变得不可预期（删了又回来）。改为：pull 的语义是「让画布与笔记树一致」，要删就删源或手动删节点，清理由命令负责。
4. **AI 概括从「单节点按需」改为「批量补缺」**。画布没有「插件响应节点点击」的通道，节点上的按钮挂不上去；改为命令触发，一次最多 8 篇，只处理没有缓存的笔记。
5. **折叠未实现**。`setNodesHidden` 能力已交付（宿主侧工作正常），但插件端没有触发入口——同样受限于没有节点点击通道。能力先留着，等宿主补上交互通道再接。

## 下一步

1. 宿主类型层（`types/canvas.ts` + `types/index.ts`）→ `tsc` 过。
2. 几何层（`canvasGeometry.ts` 曲线 + hidden）→ 导出层同步。
3. 渲染层（`CanvasView.tsx` 三处 + 缩略图）。
4. 插件 API 层（`plugin/types.ts` + `bridge.ts` + `plugin.rs` + i18n）。
5. 参考插件 `examples/qing-note-tree/`。
6. 验收脚本 + `plugin-guide.md` 同步。
