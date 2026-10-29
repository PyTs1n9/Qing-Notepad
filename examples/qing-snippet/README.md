# 片段库（侧栏视图 + 占位符插入）

把常用段落存成片段，一条命令插到光标处。它是**第一个同时用满四个权限面**的示例：
`storage`（片段数据）、`views`（侧栏面板）、`editor:write`（插入）、`editor:selection`（光标落位）。

| | |
| --- | --- |
| 插件 id | `qing.snippet` |
| 权限 | `storage`、`views`、`editor:read`、`editor:write`、`editor:selection` |
| 清单 | `package.json`（VS Code 风格） |
| 视图 | `contributes.views: [{ id: "qing.snippet.panel", title: "片段" }]` |
| 入口 | `dist/extension.js`（单文件 ESM） |

## 怎么用

1. 选中一段文字 → `Ctrl+Shift+P` → **把选中文字存为片段**。名字取选区首行的纯文本。
2. 打开侧栏「片段」面板 → 点一条片段 → 插入到光标处（或替换当前选区）。
3. 想放进别的分组：**先点分组名**（这一步就是「在该分组里新建片段」），再执行同一条命令。

| 命令 | 作用 |
| --- | --- |
| 插入片段 | 通常从面板点，命令面板里执行会提示先点一条 |
| 把选中文字存为片段 | 名字 = 选区首行；分组 = 刚才点中的分组，否则「未分组」 |
| 删除片段 | 先从面板点中一条；删除前整表快照，可撤销一次 |
| 恢复上次删除的片段 | 覆盖式写回，只保留一层 |
| 导出全部片段到光标处 | 插入一个 ```` ```json ```` 代码块 |
| 从选中内容导入片段 | 选那段 JSON（围栏可有可无）后执行；按 id 去重 |

## 占位符

| 占位符 | 替换成 |
| --- | --- |
| `${date}` | `2026-10-28` |
| `${time}` | `20:19` |
| `${cursor}` | 空，但**插入后光标停在这里** |
| `${selection}` | 当前选中的文字；没有选区时塌成空串 |

未识别的 `${…}` **原样保留**，不会被吃掉。`${title}` 明确不支持——`apiVersion: 1` 没有「当前打开的是哪篇笔记」这个调用，拿不到标题（`qing-note-wordcount` 的注释记录了同一限制）。

## 三条来自宿主的约束

1. **插件没有输入 UI。** `qing.ui` 只有 `toast`，没有 prompt / 对话框。所以片段靠选区内容命名，分组靠「点分组行」传递（`commands.register` 的 `handler(itemId)` 收到行 id），**不能自由新建分组**。
2. **`storage` 共 1 MB。** 单条 body 上限 20,000 字符、最多 500 条、写盘前按 UTF-8 字节估算并卡在 800 KB，超了主动拒绝并提示，而不是让宿主抛 `E_QUOTA_EXCEEDED`。
3. **删除没有确认框。** 快照先写 `trash` 键再删，所以「恢复」是唯一的安全网，且只保一层。

## 构建

```bash
npm run typecheck   # tsc -p tsconfig.json
npm run build       # esbuild → dist/extension.js（会检查顶层 import/export）
npm run pack        # 再打成 examples/qing.snippet-1.0.0.qnp
```

`esbuild` 从仓库根的 `node_modules` 解析，插件目录不必单独安装依赖。
