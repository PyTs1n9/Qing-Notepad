# 决策：.md 右键「打开方式」与外部文件入库

> **TL;DR** 注册表只由 NSIS 安装器写一次 `HKCU` 的 `OpenWithProgids`，不抢 `.md` 默认程序；
> 键名固定、值按名覆盖，所以重装/升级不需要先卸载，也不会出现重复项。
> 从资源管理器打开的 `.md` 由独立窗口**直接读写源文件**（编码与换行原样保留）；
> 点「返回主软件」只是在 `notes/index.json` 里加一条带 `sourcePath` 的条目，
> 此后每次保存同时更新源文件与 `notes/<id>.md` 镜像，源文件始终是权威。

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

## D4 打开链路：直接编辑源文件

```text
Explorer 双击/右键
  → qing-notepad.exe "<path>"
     ├─ 冷启动：setup 里 external::capture_launch_args()
     └─ 已运行：single-instance 回调 external::enqueue(argv, cwd)
        → 队列 + "external-note:open" 事件
  → 主窗口 drain（挂载后 / 事件 / 获得焦点）
     → external_open_path：Rust 读文件（UTF-8 → GB18030 兜底）、记录编码/换行/基线、算 id
     → 已在 notes 中且带 sourcePath：普通笔记窗口（正文仍读源文件）
     → 已在 notes 中但无 sourcePath（旧版副本）：adoptLegacyCopy，见 D8
     → 不在：独立窗口（?noteWindow=<id>&source=external）
  → 窗口自动保存（800ms 防抖）→ saveNoteContent → external_note_write → 源文件
  → 「返回主软件」：flush → "external-note:add" 事件
     → 主窗口建索引条目（带 sourcePath）+ 写 notes/<id>.md 镜像
```

**为什么不再有草稿目录**：草稿存在的唯一理由是「不能让未入库的编辑落进 `notes/`」，
因为 `loadNoteList()` 会把 `notes/` 下未被索引的 `.md` 恢复成笔记。现在未入库的编辑
直接写源文件，根本不经过 `notes/`，这个中间态就没有存在必要了，`external-drafts/`
与 `external_note_commit` / `external_take_pending` 一并删除。

## D5 内容权威与镜像

- **源文件是唯一权威**。读：`external_note_read_path`；写：`external_note_write`。
- **入库后**同时写 `notes/<id>.md` 作为**镜像**：同一个 `saveNoteContent` 里先源文件、
  后镜像。镜像不是第二个编辑目标，只是数据目录丢失/源文件被移走时的兜底。
- **读优先源文件**；源文件不可读时回退镜像（网盘掉线、文件被移动）。
- 索引本来就不存正文（`NoteIndexEntry` 只有元数据），所以「链接」不产生第二份正文，
  只是给 note 加了一个 `sourcePath`。
- **删除链接笔记只删镜像与索引条目**，绝不删源文件；回收站条目保留 `sourcePath`，
  还原后仍指向同一个文件。

## D6 冲突：写前比对内容哈希

Rust 进程内维护 `path → {encoding, line_ending, mtime, size, hash}` 会话表，基线由本
进程最后一次读或写决定，两个窗口共享同一份基线（不放在渲染层，避免窗口重载把基线
重置掉）。

- 写前重算磁盘哈希；与基线相同 → 正常写。
- 不同 → `EXTERNAL_WRITE_CONFLICT`，**不写**，窗口暂停自动保存，顶部出现
  「重新加载源文件 / 保留我的修改」二选一。
- 只看哈希不看 mtime：OneDrive 之类的同步客户端会改 mtime 但不动内容，按时间戳判冲突
  会天天误报。
- 关闭窗口时若仍有未解决的冲突，`onCloseRequested` 不销毁窗口——没有草稿了，销毁等于
  把缓冲区扔进黑洞。

## D7 编码与换行原样写回

`decode_text` 返回的编码标签此前被丢弃（`_encoding`），现在映射为
`Utf8 | Utf8Bom | Gb18030 | Gb18030Lossy`，并额外记录主导换行（CRLF / LF）。

- 写入时先 `\r\n`/`\r` 归一为 `\n`，再按原换行展开：CRLF 文件保存后仍是 CRLF，
  git 不会出现整文件 diff。
- UTF-8 BOM 保留；GB18030 用 `encoding_rs` 回编，出现无法表示的字符则拒绝保存
  （`EXTERNAL_ENCODING_UNSUPPORTED`），不做有损写入。
- `gb18030-lossy`（读入时已经出现替换字符）一律拒绝写回：原始字节已经不可逆，
  再写一次会把损失固化。
- 写入用同目录临时文件 + `rename` 原子替换；只读文件直接返回
  `EXTERNAL_WRITE_DENIED`，不擅自改属性。

## D8 旧副本迁移

旧版把文件复制进 `notes/` 后**没有保存路径**（`Note` 与索引都没有该字段，
`PendingExternalNote.path` 在入库时被丢弃），所以无法自动反查。唯一可靠信号是
用户再次从资源管理器打开同一个文件：

- 副本与源文件正文一致 → 直接补 `sourcePath`，镜像保持原样。
- 正文不同 → 源文件成为权威；旧副本另存为一条独立笔记（标题加「（旧副本）」），
  并弹 toast 告知，不覆盖任何一方。

## D9 边界

- 只接受 `.md` / `.markdown`，单文件上限 8 MiB；其它扩展名从 argv 里忽略。
- 未入库的文件不参与回收站、知识库索引与图谱；入库后才进入索引（正文仍从源文件读）。
- 手工「导入文件」仍生成随机 UUID 的副本，与「打开方式」是两条路径：前者语义是
  「复制一份」，后者是「编辑这个文件」。
- 关联只在安装版存在；`npm run tauri dev` 与 `--no-bundle` 构建不会写注册表。
- 没有文件监听：外部程序在应用打开期间改动文件，只会在下一次写入前被发现。写入前
  检测能防丢数据，但不能做到实时同步；需要实时刷新时再加 `notify` watcher。

## 未验证 / 开放问题

- NSIS 钩子只验证到「生成的 `installer.nsi` 含宏、makensis 编译通过」；
  未在干净虚拟机上实机装/卸一轮。
- Windows 11 新版右键菜单把「打开方式」折叠在「显示更多选项」里，这是系统行为，
  不是注册表缺项。
- 主编辑器里遇到冲突只有 toast + 保留脏标记，完整的二选一 UI 只在独立窗口提供。

