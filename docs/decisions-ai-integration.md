# 决策记录：AI 助手与笔记润色

> **TL;DR**（2026-10-22 起多轮迭代，现状以 `topics/ai-module.md` 与后续决策为准）
> - 双模型并存：小青（本地 BM25 + 向量 RRF 检索，只出检索片段）+ 用户自建 API 端点（BYOK，Key 走 DPAPI）。
> - 检索语料只有本地内容；出口唯一 = 用户自己的 base URL。联网搜索已于 2026-10-23 删除，勿复活。
> - 权限两档（`noteWriteMode` 默认 `readonly`），边界写在代码里不靠提示词。
> - 第六/七轮推翻"下拉切模型"：改为「档位即模型」+ portal 模型 chip（`ModelPicker`）。
> - **后续演进未同步进本文**：渠道会话隔离见 `decisions-ai-channel-conversations.md`；空状态文案改动只记在 `.workbuddy/memory/2026-10-27.md`。

日期：2026-10-22（同日第二轮增补：双模型）
状态：第一轮已落地并通过构建；第二轮结论与选型均已确认，实施中

## 需求

第一轮（已落地）：

1. **右侧栏 AI 助手「小青」**：检索知识库，回答「这个软件怎么用」这一类问题。
2. **用户可配置自己的 DeepSeek API Key**：用于润色、修改本地笔记的选中内容。

第二轮（本轮新增）：

1. **两个可切换模型**：小青（本地读取知识库）+ DeepSeek（调 API），侧栏下拉切换。
2. **知识库范围扩到全部本地内容**：笔记、便签、待办、画布文本。
3. **DeepSeek 支持实时网页搜索**；**预留接入更多 API 的接口**。

## 排查到的现状

- 技术栈固定 Tauri v2 + React 19 + TypeScript，数据全部落在本地 `data/`（Markdown + JSON）。
- `src-tauri/src/credentials.rs` 已有 Windows DPAPI 封装与两个命令，可直接复用。
- `NoteEditor.tsx` 的编辑最终汇聚为单一字符串 `content`，经 `saveNoteContent` 落盘。
- 第一轮已落地：DeepSeek 适配（`provider.ts`）、手册 + FAQ 的 BM25 检索（`manualEngine.ts`）、侧栏对话、润色 diff/快照/撤销。
- 项目已有 Supabase 与 `collab-server`，安全边界为「EXE 只含公开信息，secret 仅存在于服务端」。

## 结论

### 1. 双模型并存，侧栏下拉切换

结论：AI 侧栏顶部模型下拉两项——「小青（本地）」「DeepSeek（API）」，切换后整会话生效并记住上次选择；后续接入的 API 模型追加进同一列表。

理由：本地/云端职责清晰，用户按场景切换，与常见 agent 产品的模型切换心智一致。
（第二轮修订：取消第一轮「不做模型选择器」。）

### 2. 小青：本地文本检索模型，只出检索片段

结论：小青只做知识库检索，答案 = 原文片段 + 来源位置，不生成自然语言、不联网、不需 Key。「本地模型」指文本检索（embedding）模型；**仍不内置本地生成模型**。

理由：帮助类问题的答案就在文档里，片段直出比小模型复述更准、更可信；生成型本地 LLM 的内存与质量代价维持第一轮否决。检索接口保持与语义检索同形，将来可升级。

### 3. DeepSeek：RAG 问答 + 实时网页搜索 + 润色

> **2026-10-23 作废**：实时网页搜索（联网搜索）功能已整体移除，见 `docs/decisions-ai-api-settings.md`「后续变更」。

结论：选中 DeepSeek 时，知识库检索片段注入上下文后生成回答（RAG）；「联网问答」= 实时网页搜索，**默认开启、可关闭**；文章润色走 DeepSeek。当前有效模型 `deepseek-flash`（V4.1 Flash，1M ctx）。

理由：用户明确「要实时搜索」「默认开可关」。

### 4. 知识库范围：全部本地内容

结论：索引范围 = 功能手册 +《常见问答》+ 用户笔记 + 便签 + 待办 + 画布文本；回收站内容不进索引。

理由：用户选定「全部本地内容」，「我记过什么」与「软件怎么用」同属助手职责。
（第二轮修订：第一轮「助手只检索功能手册」作废；「AI 助手不检索笔记」的隔离随之取消——笔记进上下文已获准许。）

### 5. 隐私边界

结论：小青模式完全离线；DeepSeek 模式下笔记内容（检索片段、选中段落、提问）会发往 DeepSeek 与搜索服务，配置 Key 时隐私告知。

理由：用户明确允许笔记进 DeepSeek 上下文；边界从「笔记不出机」调整为「出机需告知」。告知沿用第一轮的设置页内联说明。

### 6. Key 存储：复用 DPAPI

结论：API Key（DeepSeek、搜索服务）经 Windows DPAPI 加密存 `data/ai/credentials.bin`，不进 `settings.json`。

理由：`credentials.rs` 已有封装；密文不随数据目录备份/分享泄露。（不变）

### 7. 润色：独立模型选择器 + 预览后应用

结论：润色面板自带模型选择器（只列生成型 API 模型），与侧栏对话下拉互不影响；生成结果先 diff 预览，应用走编辑器状态变更管线，写入前存快照可撤销。

理由：用户明确「润色单独选模型」；润色与对话的模型偏好可能不同。（第一轮润色结论保留。）

### 8. 协作会话期间禁用润色：不适用

结论：已核实 Yjs/Hocuspocus 只存在于云文档，本地 NoteEditor 无协作绑定，无需禁用逻辑。（第一轮该条经实施核实作废，保留一行备查。）

### 9. 收费：模式 1（软件功能费），不代收 token

结论：不做 API 中转，用户自己的 Key 直连服务商；授权校验随收款一并暂缓。（不变）

### 10. 检索实现：BM25 + 向量混合（RRF 融合），模型打进安装包

结论：混合检索——现有 BM25（`manualEngine.ts`）+ `bge-small-zh-v1.5` int8（Xenova ONNX，约 24MB）向量层，RRF 合并（k=60）；语义检索模型随 NSIS 安装包分发，Web Worker 内运行，Rust 侧零改动。实际打包增量约 51MB：模型 24MB + onnxruntime-web WASM 运行时 27MB。模型文件从 ModelScope 的 Xenova 镜像取得（HF 直连被网络环境拦截）。

理由：语料一半术语密集（手册/FAQ 的菜单名、快捷键）、一半口语（笔记/待办/便签），两路各补盲区；BM25 是现成资产，增量只在向量侧。
（第二轮修订：第一轮「纯 BM25、零安装包增量」降级为混合的一路；2026-10-22 选型确认混合方案。）

### 11. API 扩展：Provider 适配器接口（2026-10-22 选型确认）

结论：请求层做成 `ChatProvider` 适配器接口（`stream` / `testKey`），本期只内置 DeepSeek 预设（第一个实现）；扩展位分两类留好——OpenAI 兼容协议（Kimi/GLM/通义等共用一个适配器）与非兼容协议（每家一个小适配器挂同一接口）；搜索侧同理挂 `SearchProvider`，默认预设博查 Web Search（用户自配 Key，BYOK）。不做用户自定义 endpoint UI。

理由：用户明确「预留接口、仅代码层抽象」「后续可能接入更多 API」；博查国内直连、引用字段（标题/摘要/站点/时间）齐备。API 费用全部用户自理，选型不比价。

> **2026-10-23 作废**：「不做用户自定义 endpoint UI」与「只内置 DeepSeek 预设」两条均被推翻，
> 改为多接口 + 用户自配 baseUrl/Key + `/models` 勾选。见 `docs/decisions-ai-api-settings.md`。
> 适配器接口本身（`ChatProvider` / `stream` / `testKey`）仍然有效，只是注册表改为运行时派生。

## 实现约定（按实际落地更新）

- `src/utils/ai/`：
  - `chat/`：`types.ts`（ChatProvider 接口）、`openaiCompat.ts`（OpenAI 兼容通用适配器）、`deepseek.ts`（首个预设）、`index.ts`（注册表，加厂商 = 加一个预设文件）。
  - `search/`：`types.ts`（SearchProvider 接口）、`bocha.ts`（博查预设，POST /v1/web-search）、`index.ts`（注册表，Tavily 留位）。
  - `provider.ts` 降级为兼容门面（re-export），`errors.ts`/`http.ts` 为共享底座。
  - `knowledgeRetrieval.ts`：全语料（手册+FAQ+笔记+便签/磁贴同源+待办+画布文本）单 BM25 索引，分块 ≤370 字；`knowledgeDirty.ts`（叶子模块，storage/canvasStorage 写入点标脏）；`vectorIndex.ts` + `vectorWorker.ts`（bge-small-zh-v1.5 int8，Web Worker，chunk 向量缓存，RRF 融合；模型不可用时静默退化为纯 BM25）。
  - 索引维护：标脏重建 + 30s TTL 兜底（覆盖进程外写入）。
- 手册以 Vite `?raw` 导入打进前端包；FAQ 已并入同一索引（`## Qn｜` 自动分块）。
- Key 存储：DPAPI 密文两个文件——`data/ai/credentials.bin`（对话）与 `data/ai/search-credentials.bin`（搜索），偏好 `data/ai/preferences.json`（chatModel/polishModel/searchEnabled）。（较原文的单文件方案更名独立，避免两类密钥耦合。）
- 模型文件：`public/models/bge-small-zh-v1.5/`（config/tokenizer/model_quantized.onnx），经 Vite 原样拷入 dist，随 NSIS 分发；`env.allowRemoteModels=false` 保证离线。
- 依赖新增：`@tauri-apps/plugin-http`、`@huggingface/transformers`（+ motion 等 UI 依赖）。
- i18n：`ai*` 系列词条，中英双语（含模型下拉、搜索开关）。
- 问答呈现（2026-10-22 12:20 终版，用户定稿）：**完全不输出摘要/来源卡片**，本地小青与外部 API 模型一律文字流式进同一个回答气泡。本地回答 = top-1 命中（标题加粗首行 + 整段正文，分块 ≤370 字不截断），经 `pacedStreamText` 分片写入 `message.content`（约 8ms/字，clamp 600–2400ms，`prefers-reduced-motion` 直出），与模型 token 流共用 `AssistantBubble` 渐进 Markdown 渲染与「停止」（共用 AbortController，可掐断本地打字）；其余命中不展示（仍进模型上下文）。无命中显「手册里没有找到相关内容」；出错/中止回合显错误文案、不回退出卡。此前「4 张来源卡整批弹出」「默认折叠」「逐张流出」「top-1 答案卡」各版呈现均已作废。

## 实施中发现并修正的两个事实

1. **协作期间禁用润色不适用**：Yjs/Hocuspocus 只在云文档，本地 NoteEditor 纯 CodeMirror。
2. **隐私告知以设置页内联说明实现**（原设想首次弹窗）：说明文字与填 Key 同屏，更不容易被忽略。

## 状态

| 模块 | 状态 |
| --- | --- |
| Key 配置、DPAPI 命令、设置页、隐私说明 | 第一轮完成 |
| 《功能手册》《常见问答》+ BM25 检索 | 第一轮完成（12 组查询冒烟全中） |
| 侧栏对话（来源卡片、无 Key 降级、流式、可中断） | 第一轮完成 |
| 润色（选区、指令、diff、应用、快照、撤销） | 第一轮完成 |
| provider 抽象（ChatProvider/SearchProvider + DeepSeek/博查预设） | 2026-10-22 完成，构建通过 |
| 双模型切换（侧栏下拉、偏好持久化、润色独立选模型） | 2026-10-22 完成，构建通过 |
| 小青本地检索（全语料 + BM25/向量混合 RRF + 标脏重建） | 2026-10-22 完成，构建通过（混合质量待 GUI 手测） |
| 实时网页搜索（博查接入、搜索 Key、默认开可关、来源标注） | 2026-10-22 完成，构建通过（联网链路待真 Key 手测） |

## 待定问题

1. ~~检索模型与算法选型~~：已定——BM25 + `bge-small-zh-v1.5` int8 混合（RRF），模型打进安装包。
2. ~~搜索 API 选型~~：已定——博查 Web Search 默认预设（BYOK，不比价），Tavily 留作后续预设位。
3. ~~便签/待办/画布文本的索引维护~~：已实现——storage/canvasStorage 写入点标脏 + 30s TTL 兜底重建（便签内容与笔记同源，无需单独索引）。
4. 《功能手册》的维护归属：发布检查清单或 CI 比对 UI 词条与手册覆盖度。
5. 非兼容协议第一个适配器接哪家厂商（本期不接，留位即可）。

## 暂缓事项：收费与授权（本期不做）

不开放收款与定价，授权校验一并移出范围。收费上线时再定三项：授权校验方式（Ed25519 离线签名码 / Supabase 在线校验 / 不校验）、收款渠道、定价形式。需认清：客户端校验挡不住破解，宜「不封锁功能、只显示激活状态」的轻量做法。

## 下一步

1. ~~选型~~：已完成（混合检索 / Provider 适配器 / 博查），见结论 10、11。
2. ~~实施~~：provider 抽象、双模型切换、小青本地检索（扩范围 + 混合）、博查搜索均已落地（2026-10-22）。
3. GUI 手测（需真实 Key）：双模型切换、离线小青、混合检索召回质量、DeepSeek 联网问答与来源标注、润色独立选模型。
4. 打包验证：NSIS 体积增量（约 51MB）与 WebView2 WASM 多线程兼容性（`ort-wasm-simd-threaded` 需要跨源隔离头，Tauri 资源协议下如遇 SharedArrayBuffer 不可用，向量层会自动退化为 BM25，可改用单线程 wasm 兜底）。

## 第三轮：缺陷审查与修复（2026-10-22）

审查范围：AI 模块全部新增文件（约 4,600 行）+ capability/依赖/打包产物。结论与处置：

1. **联网搜索无法出网（P0，已修）**：`capabilities/default.json` 的 `http:default` 只放行 DeepSeek 域名，博查请求被 `tauri-plugin-http` 以 `UrlNotAllowed` 拒绝（源码 `commands.rs` 已核），失败又被 `catch` 静默吞掉。处置：白名单加 `https://api.bochaai.com/*`；失败时在回答下方显示「本次联网搜索未成功」而非无声降级。
2. **「停止」被当成网络错误（P0，已修）**：`aborted` 原本映射到 `aiErrorNetwork`。处置：新增 `aiErrorAborted`（已停止生成），设置页与侧栏同源。
3. **当前提问在 prompt 中出现两次（P1，已修）**：`runGeneration` 的 history 未排除本轮用户消息，随后又以「检索片段 + 问题」重发一次。处置：按 `questionIndex` 截断 history（重新生成时也一并排除被替换的旧回答）。
4. **清空对话留下空会话（P1，已修）**：`clearChat` 只清 messages 又回写快照。处置：连会话一起删除，与 `stashActiveConversation` 的空会话策略一致。
5. **检索失败导致提问丢失（P1，已修）**：提问先 `await` 检索再出气泡，而向量层无超时、worker 崩溃时 Promise 永不 settle。处置：先出气泡与 `sending` 再检索；embedding 增加超时（查询 10s / 每批 32 条 10s）；worker 报错时拒绝全部在途请求；`fuseHits` 失败回落 BM25。
6. **索引重建代价（P2，已修）**：任何保存都标脏，重建会重读所有笔记与画布。处置：`saveNoteContent` / `saveCanvasBoard` 带 id 标脏，重建只重读变动过的正文，其余走缓存；标脏标志改为重建开始时清除，避免构建期间的写入丢失。
7. **向量缓存无上限（P2，已修）**：chunk 向量按 `heading+text` 只增不减。处置：每次融合前按当前 chunk 集合裁剪。
8. **默认值与规格不一致（已对齐）**：结论 3 要求联网问答默认开启，实现原为关闭。处置：默认改为开启（无搜索 Key 时不发请求）。
9. **文档缺口（已补）**：《功能手册》补「联网搜索」条目，FAQ 补 Q20（含费用归属），并修正 Q1「不联网、不上传」的表述与设置页隐私告知（补搜索服务）。

## 第四轮：小青回答组装层（2026-10-22）

问题：小青（本地检索模式）的回答与提问的**问法**无关，只与命中的 chunk 有关。`composeLocalAnswer` 取 top-1 后直接拼成 `**标题**\n\n正文`，BM25 与 RRF 都是确定性的，于是同一个问题逐字重复，不同问法命中同一段时也一字不差。「死板」的根因是本地模式**没有生成环节**，不是模板写少了。

结论：新增 `src/utils/ai/answerComposer.ts`，把「chunk → 回答」的搬运换成两段式组装——**先定位块内最相关的一行，再按提问意图从该行展开**。仍是零模型、零依赖、零新增安装体积，素材全部来自知识库原文。

四类意图与结构：操作步骤（`怎么/如何/怎样`）、位置定位（`在哪/哪里/去哪`）、能力确认（`能不能/支持吗/吗？`）、概念解释（`是什么/区别`），识别不出则沿用原样直出。

理由：

1. **用户选定的边界是「纯离线、不增体积」**（2026-10-22 澄清），因此端侧小模型（约 300–500MB）与「强制调用云端 Key」两条路都被排除。能做的只有重排输出，不能同义改写——这一条已明确告知，不是实现缺陷。
2. **变化必须来自问法，不能来自随机**。同一意图配 2–3 套小标题变体，按**轮换游标**取下一套（确定性递增，可复现、可测试），而不是 `Math.random()`。同一句问两次会换模板；不同问法命中同一段则结构不同（实测：`待办能设优先级吗` → 结论式，`待办怎么设优先级` → 步骤式）。
3. **有意不做句子顺序轮换**：步骤一旦乱序就会引导用户做错事，收益远小于风险。展开始终沿原文顺序。
4. **完整优先**：摘句只覆盖原文八成以下时，追加 `> 原文补充：…` 引回全段，保证结构化摘要失真时不丢信息。

三处实现上的实测修正（都是先写错、跑真实语料才发现）：

1. **`manualEngine` 增加 `ManualChunk.lineBreaks`**。原先把 `lines` 用空格拼平，组装层拿不到行边界，「活动栏底部点「设置」：」与紧跟的「主题：…」粘成一句，导致问「怎么切换主题」时把主题描述混成第 1 步。改为记录行末在 `text` 中的偏移（几个整数，不是文本副本），`text` 本身不变，BM25 / 向量 / `chunkKey` / 已持久化的 hits 全部不受影响。
2. **中文分号不算单元边界**。曾把 `；` 当边界，「找到 data 文件夹（…；找不到就看 …）；」被切成两半，第二半以「找不到」开头，阻断了步骤起点回溯，迁移笔记的答案只剩第二步。
3. **意图识别按提问的语言，不按命中块的语言**。英文提问命中中文手册时，用中文规则匹配 `How do I…` 必然落到 fallback；英文规则还漏了大小写折叠（`How` 未匹配小写 `how`）。

不做的：跨段合成（仍只用 top-1，用户未选此项）；检索相关性下限（完全无关的提问仍会拿到某个 chunk，组装层只在块内零重合时退回原样直出）。

验证：`scripts/smoke-manual-bm25.mts` 21/21 通过（检索层未受影响）；12 个侧栏示例问题逐条人工核对组装结果；连续两次同问确认模板轮换；`tsc --noEmit` 与 `npm run build` 通过。

## 下一步（第四轮之后）

1. GUI 手测：真实侧栏里连问两次、追问、以及对同一知识点的不同问法。
2. 同档句子的重合阈值（当前 `keepsGoing` 取 2）是用 12 个示例问题的先验值，语料扩充后需复测；有 `scripts/smoke-manual-bm25.mts` 的语料一变就该重跑。
3. 遗留：`hits` 会随对话持久化，新增的 `lineBreaks` 字段会让旧会话在读取时缺失（组装层容错为纯标点切分，质量略降但不报错）。

## 第五轮：联网搜索改用 DeepSeek 官方搜索（2026-10-23）

> 该功能已于同日整体移除，本节仅作历史记录。

结论：删除 `search/bocha.ts`，新增 `search/deepseek.ts`（`POST https://api.deepseek.com/v1/tools/search`），注册表只留 `deepseek`，`DEFAULT_SEARCH_PROVIDER_ID = "deepseek"`。搜索不再有独立 Key：`aiStore` 删掉 `searchApiKey` / `hasSearchKey` / `saveSearchKey` / `clearSearchKey` / `verifySearchKey` 与 `ai/search-credentials.bin` 的读写（`storage.ts` 同步移除三个 cipher 函数），`sendMessage` 直接把已校验的聊天 key 传给搜索适配器，并把问题原文作为 `ori_question` 一起发。

理由：

1. **Bug 根因是「注册表只有一家 + 测试请求硬编码」**：`verifySearchKey` 永远打 `api.bochaai.com`，填 DeepSeek key 必然 401，于是「测试连接」对搜索永远失败。既然 DeepSeek 官方已提供搜索端点且与聊天同一把 key，独立 Key 只剩成本没有收益。
2. **少一个凭据就少一类失败态**：`search-credentials.bin` 只增不减的旧 blob 不再读取，老用户启动不会因为解不开它而报错（读取路径整段删除，不是 try/catch 兜住）。
3. **`ori_question` 让引擎拿到原始问法**：query 可能被改写或截断到 128 字符，`ori_question` 保留原句，排序质量更好。
4. **失败降级保持不变**：搜索抛错仍只置 `searchError` 提示，不阻塞回答、不改变 `sending`。

验证：`npm run build` 通过；`scripts/smoke-manual-bm25.mts` 21/21（手册/FAQ 的联网搜索条目已改为「复用同一把 DeepSeek Key」，Q20 仍独占其问法）。真实 key 的联网问答与来源标注待 GUI 手测。

## 第六轮：思考档位即模型选择（2026-10-23）

结论：聊天栏的「思考档位」从「只调推理参数」升级为**决定用哪个模型**的唯一入口，设置页那份删除，只保留输入栏控件。

做法：

1. `ChatProvider` 新增 `resolveTarget(level: ThinkingLevel): ModelTarget`，`ModelTarget = { model, thinking, reasoningEffort }`。映射逻辑集中在 `utils/ai/thinking.ts` 的 `resolveTarget()`，`openaiCompat` 通过 preset 的可选 `modelByLevel?` 表注入差异（目前 DeepSeek 三档都指向 `deepseek-flash`，所以表为空）。
2. `ChatRequest` 新增可选 `model`：适配器用 `request.model ?? config.model`，于是「档位 → 模型」的解析结果可以逐次请求传递，而不必改 provider 实例。
3. 三处生成入口统一走 `provider.resolveTarget(level)`：`aiStore.runGeneration`（对话）、`polish.generateSelectionAction`（选区动作）、`structured.generateSummaryCard`（摘要卡）。没有任何调用点再自己拼 `thinking` / `reasoning_effort`。
4. 输入栏模型芯片显示**解析后的模型名**（`activeTargetModel`）而不是 provider 默认模型，保证「看到的模型 = 会答的模型」。

理由：

1. 用户后续要加更多 API 与模型，如果档位和模型是两个独立旋钮，就会出现「选了 pro 但档位关着」这种自相矛盾的状态；把档位作为唯一决策点，状态空间是线性的。
2. 加一个更重的模型只需要在 preset 里写一行 `modelByLevel: { high: "..." }`，UI、偏好字段、调用点都不用动 —— 这正是 `decisions-ai-integration.md #11` 想要的扩展槽。
3. 设置页里的那份是纯重复：两个入口写同一个字段，用户看到两份控件却不知道哪份生效。

验证：`npx tsc --noEmit` 通过；`npm run build` 通过。GUI 表现（弹出层、芯片文案、档位切换后请求体里的 `model`）待手测。

### 第六轮补充：面板形态（2026-10-23，按参考图调整）

参考了两种模型选择器的交互（左侧模型列表 + 右侧模型详情/思考强度、触发条显示「模型 + 档位」），
本项目的输入栏宽度只有一列，因此合成为单列两段式面板，而不是两栏：

```
[deepseek-flash 低 ⌃]     ← 触发条：模型名 + 当前档位徽标
  模型
    小青            本地检索，不联网
    deepseek-flash  DeepSeek          ✓
  思考强度
    关闭            deepseek-flash
    低              deepseek-flash    ✓
    高              deepseek-flash
  提示：思考按输出计费、与正文共享预算
```

键点：

1. **模型行按模型去重，不按档位展开**。`ChatProvider.models` 由档位表折叠得出（`LEVEL_ORDER`
   以 `low` 打头，保证同一模型的多档只留一条，且代表档位不是看起来最便宜的 `off`）。这样
   DeepSeek 三档共用一个模型时只显示一行，等 `modelByLevel` 引入第二个模型才自然分裂成两行。
2. **行与档位两个轴都在同一个面板里**：选模型行只在「模型真的变了」时才改写档位
   （`levelOfTarget`），否则保留用户已有的更细档位；选档位行永远直接生效。避免「点回当前模型
   把 low 降级成 off」这类静默改状态。
3. **悬停与点击都能开**，二者共用一个 `menuOpen`。但点击态才渲染全屏遮罩——悬停态渲染遮罩会
   把鼠标压在遮罩上，`mouseleave` 立刻触发，面板闪一下就关。面板与触发条之间不留 margin，
   否则指针穿过间隙时会触发容器的 `mouseleave`（面板虽是 DOM 子节点，但空隙不在容器盒内）。
4. 触发条上的档位徽标让「当前档位」不用展开即可见，对应参考图里模型名后面的 High 标签。

验证：`npx tsc --noEmit` 通过；`npm run build` 8.51s 通过；改动的 5 个模块已 curl 核对转换结果。

### 第六轮补充二：档位改为「悬停模型行内展开」（2026-10-23）

按用户反馈调整两点：

1. **思考强度不再是常驻区块**，只在指针停在某个模型行时，于该行下方缩进展开（左侧 1px 竖线 +
   缩进）。原因：常驻会让面板一打开就有 4 行，其中一个模型的情况下三档全指向同一模型名，信息密度
   极低。展开状态用 `hoveredModelKey`（`providerId:model`），行与展开区包在同一个 wrapper 里，
   指针从行移到档位不会触发容器的 `mouseleave`；切到下一行时用 `current === key ? null : current`
   避免「新行的 enter 被旧行的 leave 清空」。
2. **删除底部提示文案**（`aiThinkingHint` 及中英词条）。面板只保留可操作项。`aiThinkingTitle`
   保留为展开区的 `aria-label`。

档位行里只在「该档位解析出的模型与本行模型不同」时才显示模型名，同一模型三档不重复三遍。

## 第七轮：模型选择改为「列表卡 + 行旁档位浮卡」（2026-10-23，grill 细问收敛）

背景：第六轮的「档位在模型行内展开」有两个问题——展开/收起会改变列表高度，鼠标移向某行时
列表在指针下位移，点击落空；用户反馈「点小青无法选中、面板直接消失」。另外用户要求：只有
**有思考模式**的模型才展示档位，且档位在**右侧**以悬浮卡展开。

结论：

| 主题 | 决定 | 理由 |
| --- | --- | --- |
| 结构 | 列表卡（模型）+ 行旁档位浮卡，不再行内展开 | 行内展开改变布局高度，是丢点击的根因；浮卡不占布局高度 |
| 触发 | 悬停有思考能力的模型行展开浮卡；**点击模型行也能固定浮卡** | 纯 hover 在触屏与键盘下不可达 |
| 无思考能力的模型 | 只用点击正常选中并收起，不展开浮卡 | 小青无生成阶段，档位对它无意义 |
| 浮卡内容 | 小标题「思考强度」+ 关闭/低/高，每行附该档解析出的模型名 | 用户指定；模型名让「档位=模型」可验证 |
| 浮卡初始 | 面板打开时即显示当前模型的档位（不是空白等悬停） | 否则第一眼像没有档位可选 |
| 窄宽度 | 不做断点，按用户要求「直接悬浮处理」 | 已知代价：合计宽度约 294px，侧栏窄于 ~320px 时贴边裁剪 |

实现几何（既定）：列表卡与浮卡各 `w-36`（144px），间距 6px，浮卡 `left-full` 贴列表卡右侧；
默认侧栏 340px、胶囊内边距 10px，可用约 320px，恰好容纳。

已排除：向右溢出到编辑区（AI 卡在壳层里是 `overflow-hidden`，会被裁）；面板内左右两栏（用户
改选「列表 + 行旁浮卡」）。

### 第七轮修正：改用 portal 悬浮（2026-10-23，按参考图最终定稿）

用户给了宽列表卡参考图（模型名 + 副行 + 勾选 + 底部「配置自定义模型」），并明确「类似这样悬浮」。
几何约束随之改变：

- **AI 卡在壳层里是 `overflow-hidden`**（`App.tsx` 的 `sidebar-width-shell`），所以任何在卡内
  absolute 定位的浮层都会被裁。340px 侧栏里塞不下「240 列表 + 160 档位」。
- 结论：模型选择器改为 **portal 到 `document.body` + `fixed` 定位**。这样浮卡可以超出侧栏边界，
  不再受裁剪；代价是要自己做视口夹取与定位重算。

实现（`components/AI/ModelPicker.tsx`，从 `AiSidebar` 抽出）：

| 项 | 值 / 行为 |
| --- | --- |
| 列表卡 | 宽 240，`left` 夹取在 `[8, innerWidth-8-240]`，锚点取触发条 `getBoundingClientRect` |
| 档位卡 | 宽 160，默认贴列表卡右侧 +8；右侧放不下时镜像到左侧并夹取到 `left>=8` |
| 垂直 | 档位卡 `top` 对齐被悬停行的 `rect.top`，夹取到视口内 |
| 触发 | 悬停（140ms 宽限）与点击（pin）都能开；pin 后渲染全屏遮罩，点外部关闭 |
| 无思考能力模型 | `supportsThinking === false`（小青）→ 点击即选中并全部收起，不弹档位卡 |
| 有思考能力模型 | 点击选中模型并 pin 档位卡，接着选档位后收起 |
| 键盘 | 行 `onFocus` 等价于悬停，Tab 可依次到达模型行与档位 |
| 层级 | 遮罩 `z-70` / 列表 `z-71` / 档位 `z-72`（在应用内容之上、上下文菜单之下） |

同时把 `AiSidebar` 里的 `modelMenuOpen/modelMenuHover/hoveredModelKey/chooseModel/chooseLevel`
全部删掉，头部模型名改由 `headerModelLabel` 计算（与 chip 同源，避免两处漂移）。

已知代价：列表滚动时档位卡不跟随（悬停离开即收，实际不可见）；侧栏拖得极窄时列表卡靠 `left`
夹取保持可见，但会盖住部分输入区。
