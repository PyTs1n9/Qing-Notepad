# 决策记录：分层契约（layering / 原子落盘）

日期：2026-10-29
状态：已执行（T1/T3/T4 只新增文件；T2 起按"只换写入原语"改动了 `storage.ts` 的 5 个写入点，
路径 / 格式 / 异常语义均未变）

> **TL;DR**：依赖方向是 `components → stores → utils → 宿主命令`，单向。唯一例外是
> 11 个 `utils` 文件用到 `stores`（7 个值导入、4 个仅类型），已逐条登记在
> `scripts/verify-architecture.mjs` 的 `UTILS_TO_STORES_WHITELIST` 里，新增即门禁失败。
> 所有"保存到磁盘"必须走 `src/utils/atomicWrite.ts`（临时文件 + rename），失败必须抛出。
> 本文是**契约**，不是新方案；与既有 `decisions-*.md` 冲突时以既有 decision 为准。

## 背景

2026-10-29 的架构复核（`docs/review-architecture.md`）实测结论：

- 181 个源文件、0 条循环依赖；`src/stores/**` 对 `@tauri-apps/` 0 引用；
  `src/utils/**` 对 `@/components/**` 0 引用。分层方向整体是健康的。
- 最大风险不在分层，而在**数据落盘没有失败语义**：`src/utils/storage.ts` 有 20 处
  `writeTextFile` 调用（改造前基线），只有 `storage.ts:1004`（笔记索引）是先写临时文件再
  `rename`；其余 19 处直接写目标路径（改造前基线），进程在写一半时崩溃 = 文件被截断。
- `saveNoteContent` 在 `storage.ts:1048-1050` 把异常 `catch` 掉只 `console.error`，
  调用方拿到的是"保存成功"，磁盘上却是半份文件。
- 唯一的反向依赖：`utils → stores`，7 个文件值导入、4 个文件仅类型；其中
  `storage.ts:23` 引入 `@/stores/settingsStore`，在 `storage.ts:642` 读
  `useSettingsStore.getState()`。

本文把上述事实固化成契约，并交给两个可在任何机器上零安装运行的脚本守门
（`scripts/verify-architecture.mjs`、`scripts/verify-atomic-write.mjs`）。
`storage.ts` 的迁移是**分批**的：T2 已把 5 个写入点换成原子写原语（`saveTodos`、
`saveTodoLists`、`saveNoteContent`、`saveSettings`、`saveUiState`），**剩余 14 处直写待 P1**，
见"待明确"。异常语义本轮未动（`saveNoteContent` 仍吞异常，同样在 P1）。

## 结论

### 1. 依赖方向单向

结论：`components → stores → utils → 宿主命令（@tauri-apps/*）`，只允许向下。

理由：向下依赖能被静态验证，向上依赖只能靠人记。反过来（`utils` 引用 `stores`）会让
"纯函数层"带上单例状态，`scripts/verify-graph-*.mjs` 这类 headless 脚本就无法在 node 里
直接跑——`graphFs.ts:7` 已经为这个限制写过注释（"imports `@tauri-apps/plugin-fs` at the
top cannot be bundled for `node`"），类型层同理。

`utils → stores` 的既有例外共 11 条，全部登记在
`scripts/verify-architecture.mjs` 的 `UTILS_TO_STORES_WHITELIST`，每条一行理由：

| 文件 | 形态 | 依赖原因 |
| --- | --- | --- |
| `src/utils/storage.ts:23` | 值 | 读 `trashRetentionDays` 与 AI 端点设置（`storage.ts:642` / `getAiEndpoints`） |
| `src/utils/tile.ts:4` | 值 | 便签平铺尺寸与配色来自设置 |
| `src/utils/canvasTile.ts:4` | 值 | 画布平铺几何要读网格设置 |
| `src/utils/announcements.ts:15-16` | 值 + 类型 | 通告文案按语言/主题出 |
| `src/utils/noteDeletion.ts:1` | 值 | 删除后同步 `noteStore` 内存列表 |
| `src/utils/graph/graphSync.ts:26` | 值 | 同步进度写回 `graphStore`（见 `decisions-knowledge-graph.md`） |
| `src/utils/ai/noteWrite.ts:14` | 值 | AI 改笔记落到 `noteStore`（见 `decisions-ai-note-write.md`） |
| `src/utils/i18n.ts:1` | 仅类型 | `LangType`，编译后擦除 |
| `src/utils/theme.ts:1` | 仅类型 | `ThemeType` / `CustomColors`，编译后擦除 |
| `src/utils/shortcutManager.ts:3` | 仅类型 | `AppShortcuts`，编译后擦除 |
| `src/utils/ai/emptyState.ts:20` | 仅类型 | `LangType`，编译后擦除 |

验证：门禁 R3。白名单外出现任何 `utils → stores` 边即失败；白名单里已消失的条目会以
"已过期"提示但不判负（删条目不值得卡住 CI）。

### 2. 状态层不碰宿主

结论：`store` 只管内存状态与派生，不 import `@tauri-apps/*`、不读写文件。落盘统一经 `utils`。

理由：store 在子窗口、主窗口、headless 脚本三种环境都会实例化；一旦 store 直接调
`plugin-fs`，它就只能在 Tauri 运行时里跑，`scripts/verify-graph-*.mjs` 这类把 store
打进 node 的验证会全部失效。当前基线是 0（`src/stores/dialogStore.ts:6` 只在注释里提到
`@tauri-apps/plugin-dialog`，门禁先剥注释再扫，不会误报）。

验证：门禁 R2（阈值 0）。

### 3. 数据落盘必须是"临时文件 + rename"

结论：目标文件的写入只允许两种形态——整文件替换走 `src/utils/atomicWrite.ts`；
追加/流式走宿主提供的 append 通道。**禁止** `writeTextFile(target, …)` 直写。

理由：直写会先截断目标，"截断了但还没写完"这个中间态对读者是可见的（崩溃、断电、磁盘满
都会命中）。`rename` 是原子的，读者只会看到完整旧版或完整新版——Windows 上 `rename` 即
`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，目标不会瞬时消失，正常路径就是一次调用、无需回退。
`storage.ts:1006-1015` 的既有分支在 `rename` 失败后会 `remove(target)` 再重试，**这条回退
原子写刻意不照抄**（原因见下），所以本契约只沿用它的"临时文件 + rename"主干，不沿用它的回退。

配套两条硬约束：

- 临时文件必须与目标**同目录**（跨卷 rename 会失败），命名 `<目标文件名>.<唯一后缀>.tmp`；
  唯一后缀使并发写同一目标不会撞名。
- **失败必须抛出**，不得 `catch` 后静默返回；清理临时文件的 try/catch 独立，只 `console.error`，
  不得覆盖原始错误。`storage.ts:1048-1050` 的吞异常写法是反例，迁移时一并改掉。

**rename 回退必须是非破坏性的**（`atomicWrite.ts` 的 `renameIntoPlace`）。`storage.ts:1006-1015`
的兼容分支是 `remove(target)` → 重试 `rename`：一旦重试再失败，旧文件已经删了，用户数据直接丢。
笔记应用不接受这种最坏情况，所以这里**刻意不照抄**：失败且目标存在时，先把目标改名成
`<目标文件名>.<唯一后缀>.bak` 备份，再重试替换；重试失败就把备份改名回目标，抛原始错误；
重试成功后删除备份（备份清不掉只 `console.error`，不回滚一次已经成功的写入）。
备份名带唯一后缀，并发两次写同一文件时不会互相覆盖。代价是最坏情况下磁盘上会短暂多一份副本
（文件大小的两倍峰值），收益是"写失败"永远只损失新内容，不损失旧内容。

**目标不存在时仍重试一次**（与 `storage.ts` 既有行为一致）。这个分支覆盖的是全应用最高频的路径
——**新建笔记的第一次保存**，那时目标文件本来就不存在；只要一次瞬时锁（索引器、杀毒、另一个
写入者）就会让新笔记彻底存不进去。所以"没有旧数据可保护"不等于"不该重试"。两次都失败时抛
**第一次**的错误：第二次通常是同一原因的重复，替换掉会丢失原始信息。

这套语义由 `verify-atomic-write.mjs` 的 E7 / E8 / F / G 钉住：E7（目标不存在、首次失败、重试
成功）要求调用成功且无 `.bak`/`.tmp` 残留；E8（两次都失败）要求 reject 且抛的是第一次的错误
对象；F（temp→target 永久失败、目标存在）要求旧内容一字不差且 `.bak` 已回滚清掉；
G（连 `target→backup` 都失败）要求目标不动、原错误上抛。

验证：`node scripts/verify-atomic-write.mjs`（42 条断言，含并发 100 次不重名、rename 失败必
reject 且清理、备份-回滚不丢旧数据、首建重试）。

### 4. 名称/标题规则只有一个实现

结论：笔记标题的推导唯一实现在 `src/utils/graph/noteTitle.ts`；`graphIndexer.fallbackTitle()`
只是转发它。任何"再写一份取标题逻辑"的改动都不接受。

理由与完整候选链（frontmatter → H1 → H2–H6 → 正文首行 → 文件名）已由
`docs/decisions-knowledge-graph.md:1336` 定稿，本文不复述、不推翻。近期那次 bug（UUID 文件名
显示成标题）正是"两处实现"的代价，回归用例在 `scripts/verify-graph-title.mjs`。

验证：`node scripts/verify-graph-title.mjs`。

### 5. 子窗口不得调用依赖 `settingsStore` 的逻辑

结论：子窗口（标签独立窗口、便签窗口等）不得调用那些内部读 `useSettingsStore.getState()`
的路径，典型是 `storage.ts:642` 的 `getTrashRetentionDays()` 及其下游（回收站清理、
`img-trash` 保留期）。

理由：`settingsStore` 只在主窗口 hydrate；子窗口读到的永远是 store 的初值（默认 30 天），
于是"用户在设置里关了回收站"在子窗口里不生效，删除行为会随窗口不同而不同。这类 bug 在
本机无 GUI 环境下极难复现，所以按契约禁止，而不是靠测试兜住。

替代做法：需要设置值的子窗口逻辑，由主窗口把值当作参数传进来，或把该逻辑留在主窗口侧。

验证：门禁 R3 覆盖"新增依赖"，人工 review 覆盖"调用链"（本契约无法纯静态判定，
`--self-test` 里的探针只能证明依赖边可被判负，不能证明调用链安全）。

### 6. 画布与图谱侧直连 `plugin-fs` 是合法例外

结论：`src/utils/canvasStorage.ts:1`、`src/utils/graph/graphFs.ts:35`（另含
`src/utils/markdown.ts:17` 只读）继续直接使用 `@tauri-apps/plugin-fs`，不收敛进 `storage.ts`。

理由：

- 画布资产有自己的回收分区（`canvasStorage.ts:153-224` 读写 `img-trash/canvas`，对应
  `storage.ts:32-35` 的 `IMAGE_TRASH_PARTITION_DIRS` 把 `notes` / `canvas` 分开），
  画布侧还需要按需建目录、批量 `readDir`；把它塞回 `storage.ts` 会立刻引入
  `canvasStorage → storage → stores` 的反向依赖，与契约 1 直接冲突。
- 图谱侧的 fs 抽象（`graphFs.ts`）存在的目的就是**可测试**：`nodeGraphFs` 让
  `scripts/verify-graph-*.mjs` 在 node 里跑真实现。合并会毁掉这个接缝。

**与 `decisions-knowledge-graph.md:21` 的关系（重要，不推翻）**：那份决策写的是
"`src/utils/storage.ts` 是唯一持久化入口，原子写 = 临时文件 + rename"。本文**保留**它的结论：
新增的用户数据落盘仍然只走 `storage.ts` 或 `atomicWrite.ts`，不得因为本节而扩散；本节只是
把**已经存在的**两处直连（`canvasStorage.ts:1` 与 `graphFs.ts:35`）登记为已知例外，
使门禁不必为此放宽。两者冲突时以既有 decision 为准——即"例外清单只有这两处，
不进清单的一律按唯一入口处理"。图谱侧其余结论（索引格式、compact 阈值等）同样以
`decisions-knowledge-graph.md` 为准。

边界：例外只覆盖"读目录/读文件/流式 append"，整文件替换仍应走 `atomicWrite.ts`（画布索引类
小文件不属于高频流式场景）。

验证：门禁 R4 只拦 `utils → components/plugin`，不会误伤这条例外；本契约靠 review 与
本文留痕。

## 待明确

1. **停止吞异常 = P1，不在本批次**。`saveNoteContent`（`storage.ts:1040-1052`）已换成
   `writeFileAtomic`，但外层 `try/catch` + `console.error` **按原样保留**（本批次只换写入原语，
   不改异常语义）。改语义要逐个审计 8 个调用点的 catch：
   `App.tsx:953`、`App.tsx:971`、`NoteEditor.tsx:157`、`NoteEditor.tsx:214`、
   `StickyNote.tsx:144`、`plugin/bridge.ts:520`、`plugin/bridge.ts:536`、`ai/noteWrite.ts:65`，
   每个都要决定"给用户 toast / 自动重试 / 上层已处理"，属行为变更，P1 单独立项。
2. **`storage.ts` 剩余直写迁移（P1）**：T2 已换 5 处（`saveTodos:793`、`saveTodoLists:901`、
   `saveNoteContent:1046`、`saveSettings:1673`、`saveUiState:1711`）。注意**计数陷阱**：
   `grep -c "await writeTextFile"` 现在得 **15**，但其中 `:1005` 是 `saveNoteIndex` 写
   **自己的临时文件**（`writeTextFile(tempPath, …)`），不是直写目标。真实待迁移的是
   **14 处直写**：

   | 分组 | 行号 |
   | --- | --- |
   | AI 端点与密钥 | `:307`、`:342`、`:375`、`:421` |
   | AI 会话 | `:551`、`:584`、`:613` |
   | 索引备份拷贝 | `:1003` |
   | 回收站索引与正文 | `:1368`、`:1427`、`:1482` |
   | 字体与画布缓存 | `:1648`、`:1809`、`:1893` |

   `:1005` 属 `saveNoteIndex` 的**原子写序列**（写 temp → `:1009` rename），**不在迁移范围**。
   建议按"丢了最疼"排：索引备份 `:1003` → 回收站 `:1368/:1427/:1482` → AI 会话 `:551` → 其余。
   **警告**：不要按"15 处"批量套 `writeFileAtomic`。`saveNoteIndex` 已经是原子写，把 `:1005`
   换成 `writeFileAtomic` 会得到 **tmp-of-tmp 的双重原子写**（临时文件的临时文件），多一次
   rename，还会让 `:1009` 的 rename 目标变成另一个 temp。
3. **`utils → stores` 的 4 个仅类型依赖**：理论上可用 `import type` 搬到 `src/types/`，但会牵动
   `i18n.ts` / `theme.ts` 的类型归属，属于纯整理，暂不动。
4. **门禁的接入点**：`package.json` 已挂 `verify:architecture` / `verify:atomic-write`；
   自检的合成探针只落在 `src/__arch_probe__/`（已进 `.gitignore`，脚本扫门前会先清残留），
   不散落在 `src/utils/`、`src/stores/` 里。尚未接进 CI，接的时候建议加一条
   `node scripts/verify-architecture.mjs --self-test`。
5. **`atomicWrite.ts` 的 rollback 语义**：目前"失败即抛出"，不做返回值区分。上层若要区分
   "可重试/不可重试"，需要先定义错误分类，暂不引入。
6. **孤儿 `.tmp` / `.bak` 的回收（P1）**：临时文件与备份只在**崩溃 / 断电 / 进程被杀**时才会
   残留（正常路径下 rename 会带走 `.tmp`，成功后删除 `.bak`；已被 E7b / E8c / F5 / F6 / G4 / G5
   覆盖）。残留不会污染图谱——笔记扫描只看 `md|markdown|txt`（`linkResolver.ts:18-34`，与 Rust 侧
   `vault.rs` 一致）——但会一直占磁盘。建议在启动时清理 `data/notes/` 与 `data/` 下超过 N 小时
   （如 24h）的 `*.tmp` / `*.bak`，与回收站的惰性清理同时机；本轮不做。
7. **`saveNoteIndex` 内联 rename 仍是破坏性回退（P1，QA 发现）**：`storage.ts:1006-1015` 里那份
   索引写的 `try { rename } catch { remove → rename }`，就是本批在 `atomicWrite.ts` 中**刻意不
   照抄**的形状——原件这半边还留在 `storage.ts`：

   ```ts
   1013:   if (await exists(indexPath)) await remove(indexPath);   // 先删旧索引
   1014:   await rename(tempPath, indexPath);                       // 再失败就没了
   ```

   它离 `saveNoteContent` 只有十行，后果却更重：**笔记索引丢失 → 目录树 / 分类结构丢失**
   （正文 `.md` 还在，但索引里的 `categoryId` / 排序没了）。QA 的变异 M1（把原子写的回退改回
   remove-then-rename）行为与之同构，可作复现证据。

   本轮不改的原因：属既有代码，不在"直写迁移"范围（`:1005` 的 temp 写本身没问题，坏的是回退
   分支）；改它要单独回归整条索引读写路径（`loadNoteList` / `writeNoteIndex` / 备份
   `index.backup.json` 的选优逻辑）。P1 修法：把 `atomicWrite.ts` 的 rename 回退导出（如
   `renameIntoPlace`）供 `saveNoteIndex` 复用，**删掉 `:1013` 的 `remove`**，让索引写与正文写
   共用同一套备份-回滚语义。

## 相关文件

- 新模块：`src/utils/atomicWrite.ts`（`writeFileAtomic` / `writeJsonAtomic`）
- 门禁：`scripts/verify-architecture.mjs`（R1–R5，含 `--self-test`）
- 门禁：`scripts/verify-atomic-write.mjs`（原子写，42 条断言，含非破坏性回滚 F/G 与首建重试 E7/E8）
- 复核原文：`docs/review-architecture.md`
- 既有决策（不推翻，仅引用）：`docs/decisions-knowledge-graph.md`、
  `docs/decisions-ai-note-write.md`、`docs/decisions-recycle-bin.md`
