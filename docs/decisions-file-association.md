# 决策：.md 右键「打开方式」与外部文件入库

> **TL;DR** 注册表只由 NSIS 安装器写一次 `HKCU` 的 `OpenWithProgids`，不抢 `.md` 默认程序；
> 键名固定、值按名覆盖，所以重装/升级不需要先卸载，也不会出现重复项。
> 从资源管理器打开的 `.md` 先进独立窗口的「草稿」，点「返回主软件」才由主窗口写入
> `notes/` 与 `notes/index.json`，笔记 id 由规范化路径哈希得到，重复打开同一个文件不会重复添加。

## D1 只进「打开方式」，不改默认程序

**结论**：注册 `HKCU\Software\Classes\QingNotepad.Markdown`（ProgID）与
`HKCU\Software\Classes\.md\OpenWithProgids\QingNotepad.Markdown`，**不写**
`HKCU\Software\Classes\.md` 的默认值。

**理由**：需求是「右键菜单里能选 QingNotepad」，不是「双击 .md 必须由青记打开」。
`.md` 的默认程序往往是 Typora / VS Code / Obsidian，安装时静默抢走属于越权。
Tauri 自带的 `bundle.fileAssociations` 走的是 `FileAssociation.nsh` 的 `APP_ASSOCIATE`，
该宏会无条件执行 `WriteRegStr ... ".md" "" "${FILECLASS}"`（见
`src-tauri/target/release/nsis/x64/FileAssociation.nsh` 第 68–80 行），因此**不能**直接用它。

## D2 注册表由安装器写，运行时零注册表写入

**结论**：`tauri.conf.json` 的 `bundle.windows.nsis.installerHooks` 指向
`src-tauri/windows/installer-hooks.nsh`，在 `NSIS_HOOK_POSTINSTALL` 写入、在
`NSIS_HOOK_PREUNINSTALL` 删除。

**理由**：

- 安装模式是 `currentUser`，`SHCTX` 即 `HKCU`，不需要管理员权限。
- 关联是安装行为而不是产品行为：dev 构建、`--no-bundle` 验收产物、便携版都不应该
  把用户机器上的 `.md` 指向一个构建目录里的 exe。
- 卸载时只删自己的 ProgID / Applications 项和 `OpenWithProgids` 里自己的值，
  不碰其它编辑器的默认值。

写入的键：

```text
HKCU\Software\Classes\QingNotepad.Markdown
  (Default)                = "Markdown 文档"
  DefaultIcon\(Default)    = "<install>\qing-notepad.exe,0"
  shell\open\command\(Default) = "<install>\qing-notepad.exe" "%1"
HKCU\Software\Classes\.md\OpenWithProgids
  QingNotepad.Markdown     = ""            (REG_SZ 空值)
HKCU\Software\Classes\.markdown\OpenWithProgids
  QingNotepad.Markdown     = ""
HKCU\Software\Classes\Applications\qing-notepad.exe
  shell\open\command\(Default) = "<install>\qing-notepad.exe" "%1"
  SupportedTypes\.md       = ""
  SupportedTypes\.markdown = ""
```

`Applications\...\SupportedTypes` 负责让 exe 出现在「选择其他应用」与
「设置 → 默认应用」里；只有 `OpenWithProgids` 时右键子菜单能出现，但「选择其他应用」
不一定列出它。`UPDATEFILEASSOC`（`SHChangeNotify`）让资源管理器立即刷新菜单缓存。

## D3 重装语义：不需要先卸载

**结论**：覆盖安装、自动更新、卸载后重装都不需要手工清理旧注册表项。

**理由**：

1. 每个值都由「固定键 + 固定值名」寻址：`WriteRegStr` 是覆盖，不是追加。
   `OpenWithProgids` 是「值名 = ProgID」的映射，同一个 ProgID 只可能有一个值，
   所以重复安装**结构上**无法产生第二条「打开方式」。
2. `shell\open\command` 每次都从新的 `$INSTDIR` 重建，换安装目录也会自动修正。
3. 自动更新跑的是同一个 NSIS 安装包（`installMode: passive`），
   `NSIS_HOOK_POSTINSTALL` 会再执行一次，等于每次升级都自愈。
4. 卸载只删自己的键；残留只可能来自「安装后被用户手工改过」，重装同样会覆盖回来。

真正需要手工处理的只有一种情况：**从未安装过**的便携/dev 副本。它没有关联，
这是刻意的（见 D2）。

## D4 打开链路：argv → 队列 → 独立窗口 → 主窗口入库

```text
Explorer 双击/右键
  → qing-notepad.exe "<path>"
     ├─ 冷启动：setup 里 external::capture_launch_args()
     └─ 已运行：single-instance 回调 external::enqueue(argv, cwd)
        → 队列 + "external-note:open" 事件
  → 主窗口 drain（挂载后 / 事件 / 获得焦点）
     → external_open_path：Rust 读文件（UTF-8 → GB18030 兜底）、算 id
     → 已在 notes 中：普通笔记窗口
     → 不在：草稿窗口（?noteWindow=<id>&source=external）
  → 草稿窗口自动保存到 <data>/external-drafts/<id>.md
  → 「返回主软件」：flush → external_note_commit(id, content)
     → Rust pending 队列 + "external-note:pending" 事件
     → 主窗口 drain → 写 notes/<id>.md → addNote(categoryId: null)
     → 切到笔记视图 + 选中「未分类笔记」→ 删草稿
```

**为什么草稿不直接写 `notes/`**：`loadNoteList()` 会把 `notes/` 下所有索引未收录的
`.md` 当作「恢复笔记」加载。草稿若写在那里，用户只是看了一眼的文件会在下次启动时
自动进笔记库，违反「点返回才入库」的约定。

**为什么由主窗口入库**：`notes/index.json` 只能有一个写者。`App.tsx` 的自动保存
effect 已经在写它；子窗口再写一次就可能「后写覆盖先写」，新笔记从索引里消失。
Rust 队列让子窗口只表达意图，不碰索引。

## D5 去重：路径决定 id，索引决定「已存在」

- id：`ext-<fnv1a64(小写化、正斜杠、去 \\?\ 前缀的规范路径)>`，16 位十六进制。
  同一个文件的不同拼写（大小写、`\\?\`、相对路径）得到同一个 id。
- 打开时：主窗口先查 Zustand `notes`（用 `getState()`，不是渲染期快照），
  有则按普通笔记打开，无则开草稿。
- 入库时：再查一次 `notes`，已有则跳过并删草稿；Rust 的 pending 队列对同一 id
  也做覆盖而不是追加。
- 跨重启：id 写在 `notes/index.json` 里，启动加载后同样命中。
- 文件本身位于 `<data>/notes` 且文件名是合法 note id 时，直接沿用该 id，
  避免把笔记文件再复制一份。

## D6 边界

- 只接受 `.md` / `.markdown`，单文件上限 8 MiB；其它扩展名从 argv 里忽略。
- 草稿窗口按 X 关闭不入库，草稿保留；下次打开同一路径优先读草稿（用户编辑优先于源文件）。
- 未入库的草稿不参与回收站、知识库索引与图谱。
- 手工「导入文件」仍生成随机 UUID 的副本，与「打开方式」的去重是两条路径；
  同一个文件先手工导入、再右键打开，会出现两份内容。这是刻意保留的差异：
  手工导入的语义就是「复制一份」，而右键打开是「打开这个文件」。
- 关联只在安装版存在；`npm run tauri dev` 与 `--no-bundle` 构建不会写注册表，
  本机验证需要手工装一次 NSIS 包，或用 `reg add` 临时复现（不要提交脚本）。

## 未验证 / 开放问题

- NSIS 钩子只验证到「生成的 `installer.nsi` 含宏、makensis 编译通过」；
  未在干净虚拟机上实机装/卸一轮。
- Windows 11 新版右键菜单把「打开方式」折叠在「显示更多选项」里，这是系统行为，
  不是注册表缺项。
- 草稿目录目前不做定期清理；未入库的草稿会一直留着（体积极小）。
