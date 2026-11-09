# 侧栏全局搜索 — 决策记录

日期：2026-11-09（分支 `md-plus`）
主题：左侧栏新增全局搜索入口，点击后在侧栏内联搜索，实时给出最多 10 篇笔记，并在结果片段中高亮关键词。

## 背景事实（已核实，非假设）

- **`noteStore.notes[].content` 冷启动时全是空串**：`notes/index.json` 只存元数据（`storage.ts` 的 `NoteIndexEntry` 无 `content` 字段），`listNoteFileIds` 的注释写明「reading every body on boot is what this replaces」，崩溃恢复路径 `recoverNoteListFromFiles` 显式写 `content: ""`。正文由 `NoteEditor` 打开笔记时 `loadNoteContent(id)` 读回 store。
  这条决定了「纯内存搜索」会静默漏检未打开过的笔记，是本轮方案的分水岭。
- `noteStore.searchQuery` 是树过滤状态（`NoteTree` 消费），当前**没有任何 UI 入口**。
- 回收站笔记不在 `notes` 里（走文件系统），因此搜索天然不含回收站。
- 片段高亮已有既定写法：`NoteOutlinePanel.tsx` 的 `<mark className="rounded-[2px] bg-accent/25 px-0.5 text-inherit">`。

## 结论

### 1. 形态 — 侧栏内联，不是浮层

- 结论：点标题行最左侧搜索键后，标题行下方出现一条 36px 搜索行，**树区域被结果列表替换**；Esc 或再次点按钮收起搜索行、树回来。**清空输入不等于退出**：清空后 `searchActive` 为假，树回到搜索行下方，搜索行本身还在，再按 Esc（或点按钮）才收起。
- 理由：侧栏只有 240–320px 宽，浮层会盖住树且与既有 `Ctrl+Shift+P` 命令面板在观感上撞车；内联还能让「输入框固定、结果滚动」用现成的 `flex-col` 布局表达，零新 CSS。
- 附带收益：树被**卸载**而不是隐藏，`NoteTree` 挂在 window 上的 `Delete` 键监听随之消失 —— 搜索态按 Delete 不会误删笔记。**因此禁止改用 `hidden`/`opacity-0` 隐藏树**。

### 2. 状态归属 — 留在 `Sidebar` 局部，不动 `noteStore.searchQuery`

- 结论：`searchOpen` / `searchText` 是 `Sidebar` 的 `useState`；搜索面板自己读 `notes`。
- 理由：`searchQuery` 一改就会同时改变 `NoteTree` 的过滤语义（隐藏未命中节点、强制展开命中路径），回归面翻倍；两件事共用一个输入框也会让「搜索」与「过滤」互相污染。

### 3. 正文来源 — store 优先 + 未载入者按需补读

- 结论：`buildSearchIndex` 取 `note.content`，为空时回退到面板私有的 `bodyCache`；`bodyCache` 未命中且 `content === ""` 的笔记，用 `loadNoteContent` 以 **6 并发、单轮 ≤ 800 篇**补读，每批 bump 一个版本号触发重算，失败静默（外部链接笔记读源文件可能失败，退化为标题命中）。
- 理由：零 Rust 改动、零持久化格式变更、不进 store（不触发持久化与订阅）。代价是首次搜索有一次读盘，且**同一会话内不再重读**。
- 已知上限：**同一条查询最多补读 800 篇**（`MAX_BODY_READS`）。补读只在一次 `useEffect` 轮次里跑完，查询不变不会自动续批；把查询词改一下（哪怕改一个字符）才会接着读下一批，已缓存的不重读。也就是说，**超过 800 篇的库，一条固定查询下「仅正文命中」的笔记可能不出现**。当前笔记量级远低于此；真要全量，走开放问题 4（Rust 批量读）或直接去掉上限，不要在面板里堆续批状态机。

### 4. 高亮 — 只在结果列表，编辑器不动

- 结论：结果行里标题与片段各渲染一次 `<mark>`（沿用 `NoteOutlinePanel` 的类），**不做正文内高亮、不跳转定位**。
- 理由：正文高亮要动 livePreview 装饰层 + 跨笔记定位，属于另一档工作面；片段内的偏移经过「清洗后重扫」保证与显示文本一致，已经能满足「看得出命中在哪」。

### 5. 输入框内 Enter 不绑定任何动作

- 结论：只有 `Escape` 有绑定；打开笔记只能点击（或 Tab 到结果行后原生 Enter/Space）。
- 理由：中文/日文输入法确认候选字就是 Enter，误开会把用户从正在写的笔记弹到另一篇。本机无法验 IME，宁可不给这个快捷键。
- 代价：键盘用户在输入框里按 Enter 无反应；Tab 一次进入结果区。

### 6. 打开姿势与树内单击一致

- 结论：`openTab(noteId, { preview: true })` + `setActiveNoteId(noteId)` + 切到 `note` 视图；**面板不关闭、输入不清空**，便于连续翻看多个命中。
- 理由：只 `setActiveNoteId` 会被 `App` 的标签兜底 effect 以 `preview:false` 补成常驻标签，与树内单击语义不一致。

### 7. 索引分两段 + 按 `Note` 对象缓存投影

- 结论：`buildSearchIndex(notes, bodies)` 负责小写投影（以 `Note` 对象为键的 `WeakMap` 缓存，source 变化才重算），`searchIndex(index, query, limit)` 负责每次按键的匹配。
- 理由：补读每批都会 bump 版本触发重算，若不缓存投影，1000 篇库每批都要重新小写全库正文。

### 8. 命中数 — 分段封顶、加总不封顶、显示端收敛

- 结论：标题与正文各自封顶 `MAX_COUNT = 999`，`matchCount` 直接相加（可达 1998），徽标按 `> MAX_COUNT` 显示 `${MAX_COUNT}+`。
- 理由：对加总再封一次会让 999 同时表示「正好 999」与「999 或更多」，`999+` 变成死分支、徽标说谎。

### 9. 排序

- 结论：标题命中 → 命中数降序 → `updatedAt` 降序（`Date.parse` 失败按 0）→ `id` 升序。
- 理由：先给出「标题上就写着这个词」的笔记，再用命中密度与新鲜度排序；最后用 id 兜底保证结果稳定可测。

## 实现位置

| 文件 | 角色 |
| --- | --- |
| `src/utils/noteSearch.ts`（新） | 纯函数：`buildSearchIndex` / `searchIndex` / `searchNotes` / `countOccurrences` / `cleanSnippetText` + 常量。只 `import type { Note }` |
| `src/components/Layout/SidebarSearchPanel.tsx`（新） | 输入行 + 结果区 + 高亮 + 正文补读 |
| `src/components/Layout/Sidebar.tsx` | 标题行最左搜索键、折叠 rail 搜索键、面板挂载、`openNoteFromSearch` |
| `src/utils/i18n.ts` | 6 个新 key（中英双表 + 类型），尾部追加 |
| `scripts/verify-sidebar-search.mjs`（新） | 纯函数回归门禁：esbuild 打包到系统临时目录后跑 53 条断言，常量从模块导入，不写仓库内文件 |
| `package.json` | 只加一行 `"verify:sidebar-search": "node scripts/verify-sidebar-search.mjs"` |

## 已知边界

- 单轮补读上限 800 篇，且**不自动续批**（见结论 3「已知上限」）；`bodyCache` 只增不减（键域被笔记数封住）。
- 正文超过 200k 字符截断后再索引。
- 片段窗口 140 字符；清洗（HTML/Markdown 标记、链接 URL、围栏行）后重新定位关键词，若命中恰好落在被删片段里则回退为「只折叠空白」的原文。
- 标题命中但正文无命中时不渲染片段行（不留空行、不写「正文无匹配」）。
- 外部链接笔记（`sourcePath`）补读失败时只能按标题命中。

## 验收

- `npx tsc --noEmit` 零诊断；`npm run build`（PowerShell）PASS：`3655 modules transformed` / `✓ built in 17.43s`；`verify:architecture` R1–R5 全 PASS（`utils` 无 stores/components 依赖）；`verify:contrast` 152 组 150 组 ≥4.5:1、0 失败（本轮未改配色，属基线）。
- `npm run tauri -- build --no-bundle` **成功**：`Finished release profile [optimized] in 1m 40s`，产物 `src-tauri/target/release/qing-notepad.exe`（45,420,032 B），全文无 Rust 源码错误。此前「本机缺 MSVC」是误判，见 `topics/env.md`；正确做法是把 MSVC 14.36.32532 + SDK 10.0.22000.0 的四个变量内联进会话。
- 纯函数：`npm run verify:sidebar-search`（`scripts/verify-sidebar-search.mjs`，esbuild 把 `src/utils/noteSearch.ts` 打到系统临时目录后断言，跑完自清）—— **53 checks / 0 failures**。覆盖：排序（标题命中 → 命中数 → `updatedAt` → `id`）、空 query、纯空白 query、正则元字符 5 例（`(`/`*`/`.`/`[`/`\`）、大小写等价、`limit` 与 `totalMatched` 分离、片段每个 range 的切片 `.toLowerCase()` 等于 needle（中英各一组）、标题命中 → `snippet === null`、`bodies` 补读生效、`countOccurrences` 非重叠且 999 封顶、`cleanSnippetText` 保护 `2*3` 与 `snake_case`、`İ` 长度漂移退化、长正文 head/tail 裁剪、200k 截断、CJK 命中偏移。
- **真实 WebView2**：`npm run verify:webview` → `ok: true`，buildId `7c7420eae372.45420032-1794227503030`，`consoleErrors []` / `consoleWarnings []` / `failures []`，`shellCards 3`，`editorCard 546×752`，`fontsStatus loaded`；`--replace` 复跑同样 ok:true。DOM 断言全过：搜索键唯一且位于 explorer 标题行按钮组 index 0（共 6 键、不换行、行高 36px）；点击 `aria-pressed false→true`、输入框出现并聚焦；输入 `n` → 10 行 +「共 11 篇匹配，显示前 10 篇」；`mark` 类含 `bg-accent/25` 与 `text-inherit`、文本全为命中词；层级 `[role="list"] > [role="listitem"] > button[data-sidebar-search-result]` 成立；Esc 后面板卸载、`[role="tree"]` 回归；真实库里 `数据` / `学习` / `的` 各有正文命中，证明 `loadNoteContent` 补读链路在真机可用。对比度实算：暗色 标题 16.5 / 标题 mark 12.14 / 徽标 8.68 / 汇总 9.43 / 片段 7.27；亮色 9.26 / 6.98 / 6.19 / **4.80（最弱仍过 AA）** / 6.12。
- **隔离渲染探针**（headless Edge + 真实 `Sidebar`/`SidebarSearchPanel` + mock notes）：240px 与 180px 两档按钮组均 `wrapped:false` / `overlap:false` / 无横向溢出；13px 标题 / 11px 两行片段（17.875px 行高）/ 17px 徽标实测；排序十行逐位符合规则；折叠 rail 一键「展开 + 进搜索态」（48 → 238px）；标签区开关闭态切换正确。900ms 慢读桩证明「正在读取正文…」会出现也会消失、延迟读到的正文会带 mark 与片段重排进结果。截图 `test_temp/qa-screens/real-dark-search.png` / `real-light-search.png` / `real-webview-search.png` 判读：无重叠、无裁切、无空黑区、无回退字体。
- **证据缺口（如实记录，不写成已验证）**：① 最后一次「全新窗口」的 `verify:webview` 被孤立的 `qing-notepad.exe pid 38416` 挡住（exit 2、无 session、CDP 9333 不通、`--close` 收不掉），按纪律未 kill；放行依据是**同一 bundle（`index-BvSv3syU.js`）已有的两次 ok:true**。② 240/180 两档的中间截图被并行会话清理 `test_temp/` 时删除，只剩 20:19–20:23 的判读记录。③ 真机库正文命中偏少（自定义数据目录里未见 `notes/`），无法判定是数据侧还是代码侧；stub 已证明补读机制可用，不计为源码缺陷。
- **需人工目视（本机无 GUI）**：IME 组合态与 Enter 手感、点击结果后的 preview 标签语义、冷启动大库的补读流式观感、滚动惯性、托盘/多窗口/真拖拽改侧栏宽度、通过设置面板切换亮暗主题、20:22:52 那个窗口曾出现「点 toggle 无响应」在干净窗口未复现（疑似他方探针遗留 UI 状态）。

## 开放问题

1. 是否给搜索一个全局快捷键（`Ctrl+Shift+F`）直接聚焦；涉及全局快捷键分配，本轮不做。
2. 命中数是否拆成「标题 N / 正文 M」两段。
3. 补读期间是否给进度（当前只给一行「正在读取正文…」）。
4. 是否升级到 Rust 批量读正文（一次 IPC 拿全量），取决于笔记库量级是否继续增长。
5. 是否补 `↑/↓` 在结果间移动（当前只有 Tab 与鼠标）。
