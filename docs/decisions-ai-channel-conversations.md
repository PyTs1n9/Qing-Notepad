# 决策记录：AI 会话按接口（渠道）隔离（2026-10-27）

## 背景

侧栏空状态此前无论选哪个模型都自称"小青"（已修）。根因不在文案，而在**会话本身不分渠道**：
`AiConversation` 没有渠道字段，`setChatModel` 只换模型不清消息，启动时恢复"全局最近"会话。
于是用户在 DeepSeek 下看到的是上一段 DeepSeek 之外产生的对话，换个渠道继续问，上下文就被发给了另一家服务。

## 结论

| 主题 | 决定 | 理由 |
| --- | --- | --- |
| 隔离粒度 | 按接口（endpoint），不是按模型 | 渠道 = 用户添加的那个接口；同一接口内换模型仍是对同一段对话换模型，且历史条数不被模型数量放大 |
| 小青的位置 | 小青是独立渠道，但其会话在**所有**渠道可见 | 小青是应用内置助手，历史属于产品自身；接口会话仍严格互不可见 |
| 切换渠道 | 恢复该渠道最近一段会话，没有则空白 | 符合"接着上次说"；空会话本来就不入列表 |
| 打开跨渠道会话 | 模型跟着会话走（点开小青会话即切回小青） | 否则从 DeepSeek 列表点开小青会话，下一条问题会带着小青的上下文发给 DeepSeek —— 原 bug 换方向复现 |
| 历史面板 | 只列当前渠道（小青选中时只列小青会话） | 列表短、边界清楚；小青会话在接口渠道下额外出现并带"小青"标记 |
| 老数据 | 迁移时归当前选中接口（当前是 local 则归小青） | 这些会话基本产自用户当时的渠道；归小青会让 API 用户的历史凭空消失 |
| 删除接口 | 连带删除该接口名下的会话，确认框显示条数 | 渠道没了，会话的模型与 Key 也没了，留着只能看不能续；属用户显式删除，但必须写清代价 |
| 存储 | 会话 JSON 内加可选 `endpointId`，启动后内存过滤 | 唯一无破坏性迁移、且与"一会话一分片、每轮只写一片"兼容的方案 |

## 否决的方案

- **按渠道分目录 `ai/chats/<channel>/`**：搬现有 shard 是唯一有数据风险的步骤，中断会留半迁移状态；切渠道还要变异步加载。
- **中心索引 `ai/chats/index.json`**：与现有"每轮只写该会话一片、不重写列表"的设计目标冲突，等于把已避开的双写问题带回来。

## 不变量

- `endpointId === null` = 小青；字段缺失 = 旧数据，迁移时补写一次（只补缺字段的，幂等）。
- 活动会话的渠道必须等于当前选中渠道；渠道切换一律经 `setChatModel` / `switchConversation` / `removeEndpoint` 三条路径，均先 stash 当前会话。
- 同接口内换模型不换会话；跨接口换模型必换会话。
- 流式生成中切渠道：先 abort（复用 `stopGenerating`），再 stash。

## 暂未确定

- 无（会话数量上限仍不设，沿用 `decisions-ai-conversations.md`）。

## 落地（2026-10-27 已完成）

1. `storage.ts`：`StoredAiConversation.endpointId?: string | null`（可选，旧文件兼容）
2. `utils/ai/conversationScope.ts`：`sessionsForChannel` / `latestSessionIn` / `adoptChannel` 三个纯函数，
   store 与侧栏共用，隔离规则只此一处
3. `utils/ai/chat/endpoints.ts`：`channelOf(selection)` —— `"local"` → null
4. `aiStore.ts`：`AiConversation.endpointId`；`enterChannel`（切渠道 = stash + 恢复目标渠道最近会话）；
   `setChatModel` 只在渠道变化时走它；`switchConversation` 采用会话渠道（`modelForChannel`）；
   `syncConversations` / `sendMessage` 写入渠道；`hydrate` 按渠道恢复 + `adoptChannel` 回填；
   `removeEndpoint` 连带删除该渠道会话并落到目标渠道最近会话
5. UI：历史面板按渠道过滤（接口渠道下小青会话带"小青"标记）；设置里删除接口时显示
   "{count} 段会话将一并删除，不可恢复。"

验证：`npx tsc --noEmit`、`npm run build`、`npm run verify:ui-polish` 均通过；
12 条纯函数断言（渠道可见性、恢复目标、迁移归属、脏值处理）全绿。
本机无 GUI，交互观感需桌面会话确认。
