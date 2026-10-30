**简体中文**

<!-- markdownlint-disable -->

<div align="center">

<img src="https://s41.ax1x.com/2026/10/24/pnD66aV.png" alt="pnD66aV.png" border="0" width="155" alt="QingNotepad 图标">

# QingNotepad 青记

安装包 <strong><em><font color="#1f6feb">约 26MB</font></em></strong>，轻量级桌面应用<br>
QQ 讨论群 <strong><em><font color="#1f6feb">902898359</font></em></strong><br>
本地优先的 Markdown 记事、待办、画布、便签、知识图谱、插件与离线 AI 助手<br>
基于 **Tauri v2 + React 19 + TypeScript** 构建

[反馈问题](https://github.com/PyTs1n9/Qing-Notepad/issues) · [更新日志](https://github.com/PyTs1n9/Qing-Notepad/releases)<br>
[快速开始](#快速开始) · [功能手册](docs/user-manual.md) · [常见问答](docs/user-faq.md) · [从源码构建](#从源码构建)

[![Version](https://img.shields.io/github/v/release/PyTs1n9/Qing-Notepad?label=版本)](https://github.com/PyTs1n9/Qing-Notepad/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
</br>
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![TypeScript](https://img.shields.io/badge/TypeScript-5-%233178C6?logo=typescript)

</div>

<!-- markdownlint-restore -->

---

## 项目简介

QingNotepad 是一个面向 Windows 桌面的轻量工作台。它把 Markdown 记事、待办清单、自由画布、桌面便签与离线 AI 助手放在同一个应用中：本地内容无需登录即可使用，联网工作台则用于跨设备保存和多人协作。

## 功能特点

### 📚 Markdown 记事本

- 1️⃣ 提供「源码」「预览」「分屏」三种 Markdown 视图，分屏模式实时滚动同步
- 2️⃣ 笔记树支持文件夹归类，单击预览、双击固定为标签页，可同时打开多篇笔记
- 3️⃣ 搜索同时匹配标题与正文，可叠加文件夹与标签筛选
- 4️⃣ 支持导入 `.md` / `.markdown` / `.txt`，导出 Markdown、纯文本、Word（.docx）或 PDF
- 5️⃣ 图片粘贴或拖入即存为附件，预览支持本地附件、文件路径与网络图片
- 6️⃣ 按设定间隔自动保存，`Ctrl+S` 立即保存；删除的笔记进入回收站，可恢复或彻底删除

### 🗓️ 待办清单

- 1️⃣ 支持创建多个任务清单，清单内任务隔离，可重命名、置顶与拖动排序
- 2️⃣ 任务支持低 / 中 / 高三档优先级与截止日期日历选择
- 3️⃣ 任务可拆为子任务，勾选父任务会连带完成其子任务
- 4️⃣ 支持行内编辑与拖拽排序，按状态和优先级筛选，完成的任务自动沉底

### 🎨 自由画布

- 1️⃣ 支持创建多个本地画布，可放置图片与多行文本
- 2️⃣ 支持粘贴、拖放或选择本地图片，并可框选、拖动、缩放与画笔涂鸦
- 3️⃣ 支持将当前画布导出为 PNG、JPEG 或 SVG
- 4️⃣ 可把笔记或文件夹作为只读引用节点放进画布，双击回到源笔记；连线支持贝塞尔曲线
- 5️⃣ 画布内容和图片资源保存在本地，不参与在线工作台的实时协作

### 📌 便签与磁贴

- 1️⃣ 便签是可编辑的置顶小窗，用来随手记录而不打断当前笔记
- 2️⃣ 磁贴是只读小窗，可把笔记或画布钉在屏幕一角常驻查看
- 3️⃣ 关闭小窗不影响原笔记内容，两者相互独立

### 🕸️ 知识图谱

- 1️⃣ 把任意本地文件夹添加为「资料库」，只读扫描：不复制、不修改、不移位，移除资料库只解除引用
- 2️⃣ 本应用笔记与资料库中的 `.md` / `.markdown` / `.txt` 在同一张图里渲染，支持 `[[wiki 链接]]` 与 Markdown 链接
- 3️⃣ 指向不存在笔记的链接显示为断链节点，命中多篇同名笔记时提示改写路径
- 4️⃣ 选中节点可查看标题、路径与反链，并直接「在编辑器中打开」；本应用笔记还支持就地预览
- 5️⃣ 支持按标签筛选、「只看孤立节点」「只看断链」，以及按标题或路径搜索
- 6️⃣ 首次打开扫描文件并建立索引，之后走缓存；面板显示上次扫描时间、节点数与边数

### 🤖 AI 助手「小青」

- 1️⃣ 右侧栏 AI 面板，顶部可在「小青（本地）」与「DeepSeek（API）」等多个模型间切换；云端模型支持添加自定义 OpenAI 兼容端点，选择会被记住
- 2️⃣ 小青全程离线作答：索引覆盖功能手册、常见问答、笔记、便签、待办与画布文本，回收站不参与检索，不联网也不消耗额度
- 3️⃣ 云端模型以检索到的本地内容为上下文生成回答，回答中标注来源；支持添加多个厂商端点并一键「搜索模型」拉取可用模型，内置多家厂商品牌图标
- 4️⃣ 选中文字即可润色，内置「润色 / 更简洁 / 更正式 / 更口语化」四种风格并可补充自定义要求，结果先预览、点「应用」才写入
- 5️⃣ 可在对话中让 AI 直接修改笔记；每次写入前自动留存快照，支持按条撤销，修改权限分「仅助手」与「完全开放」两档
- 6️⃣ API Key 经 Windows 系统加密后仅存本机，不写入配置文件，也不上传

### 🧩 插件扩展

- 1️⃣ 扩展页分「已安装 / 可用」两组，搜索覆盖名称、描述与作者；支持 `.qnp` 包与带清单的文件夹两种安装方式
- 2️⃣ 安装前逐条确认权限：13 个权限码分属笔记、待办、剪贴板、编辑器、画布与 AI 六组，未授予的调用直接拒绝
- 3️⃣ 插件只在命令面板（`Ctrl+Shift+P`）里追加命令，不改动界面；命令与内置命令同列可搜
- 4️⃣ 插件代码在独立 Worker 中运行，拿不到 `window`、`document` 与系统能力，也没有联网能力
- 5️⃣ 详情页可停用、卸载或回滚到上一版本；卸载会收回已授予权限，并可选择保留设置数据
- 6️⃣ 宿主连续崩溃会自动切回内置模式，失败原因常驻显示在页头，详情页保留最近 100 条错误日志
- 7️⃣ 随仓库提供 8 个可直接安装的示例插件，`examples/pack.mjs` 可一键打成 `.qnp`

### 💻 在线工作台与实时协作

- 1️⃣ 支持 Supabase 邮箱注册、登录、退出、密码修改，以及昵称和头像管理
- 2️⃣ 可创建工作台或通过邀请码加入工作台，并设置新成员默认角色
- 3️⃣ 进入工作台先看到概览页，集中展示文档与成员概览、最近文档与快捷入口，不必再直接跳进第一篇文档
- 4️⃣ 实时编辑 Markdown 内容，实时显示在线用户，实时框选用户高光内容
- 5️⃣ 断网时的修改先存本机，恢复网络与登录后自动同步
- 6️⃣ 完整的数据库迁移、协作服务和 Render 部署说明见 [在线工作台部署](docs/online-workspace.md)

### 💎 个性化与系统集成

- 1️⃣ 提供深色 / 蓝调 / 忧郁黄 / 清新绿四套预设，支持自定义配色与背景图，最多保存 5 套自定义预设
- 2️⃣ 支持中文 / English 即时切换
- 3️⃣ 提供 VS Code 样式活动栏，侧边栏可拖动调宽或折叠
- 4️⃣ 支持自定义全局快捷键，默认 `Ctrl+Space` 显示 / 隐藏主窗口
- 5️⃣ 关闭按钮最小化到系统托盘，托盘菜单 `Quit` 或标题栏退出才会真正结束程序
- 6️⃣ 关于窗口可检查 GitHub 最新版本并跳转 Releases 下载
- 7️⃣ 设置 → 存储 可将整个数据目录迁移到任意磁盘，迁移前校验写入权限，过程安全可逆
- 8️⃣ 帮助菜单提供「更新日志」，随时回看本版说明；登录弹窗左侧展示「最新通告」，可逐条忽略
- 9️⃣ 设置中可关闭联网获取通告，改用随安装包分发的离线快照

## 快速开始

### 下载安装

请前往 [Releases 页面](https://github.com/PyTs1n9/Qing-Notepad/releases/latest) 下载最新版本。

| 系统 | 架构 | 推荐文件 |
| --- | --- | --- |
| Windows | x64 | Windows 安装包或自包含可执行文件 |

下载后运行安装包或可执行文件即可使用，首次启动无需登录。普通关闭会将应用隐藏到系统托盘；需要真正退出时，请使用标题栏退出逻辑或托盘菜单中的 Quit。

### 从源码构建

请先阅读 [README-dev.md](README-dev.md) 了解开发环境、Tauri 构建和发布流程。常用命令如下：

```powershell
npm ci
npm run dev                 # 仅启动 Vite 前端
npm run tauri dev           # 启动完整 Tauri 桌面应用
npm run build               # TypeScript 检查并构建前端
npm run tauri build         # 构建 Windows NSIS 安装包
```

若要本地运行协作服务：

```powershell
npm run collab:dev
```

### 在线工作台部署

在线工作台是可选能力，不配置服务时不影响本地记事、待办、画布和便签。部署时请按 [docs/online-workspace.md](docs/online-workspace.md) 的顺序执行 Supabase 迁移并启动协作服务。

桌面应用需要以下公开环境变量：

```env
VITE_SUPABASE_URL=https://你的项目.supabase.co
VITE_SUPABASE_ANON_KEY=你的 publishable key
VITE_COLLAB_URL=wss://你的协作服务域名
```

协作服务器还需要 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 和仅服务器可见的 `SUPABASE_SERVICE_ROLE_KEY`。`service_role` 密钥不能写入桌面应用、提交到 Git 或放进安装包。

## 数据存储

所有本地内容都保存在安装目录（开发构建为仓库根目录）下的 `data/` 中，应用不会静默改写到用户目录或注册表。数据目录可在「设置 → 存储」中迁移到任意磁盘：同卷迁移即时完成，跨卷迁移会先拷贝并逐项目校验再删除原文件，确保不会丢失资料。迁移指针（仅一小段路径）存放在系统配置目录，资料本体始终留在你指定的数据目录。主要内容包括：

```text
data/
├── todos.json              # 待办任务
├── todo-lists.json         # 待办清单和当前清单
├── fonts.json              # 导入字体注册表
├── settings.json           # 主题、语言、背景、快捷键、自动保存等设置
├── ui-state.json           # 当前打开的标签页
├── app-icon.png            # 自定义应用图标
├── img/                    # 笔记图片附件
├── img-canvas/             # 画布图片资源
├── img-need/               # 头像和应用背景历史
├── img-trash/              # 待清理的图片资源
├── notes/
│   ├── index.json          # 笔记元数据、文件夹与分类索引
│   └── <uuid>.md           # 笔记正文，兼容历史 HTML
├── trash/notes/            # 回收站中的笔记
├── canvas/
│   ├── index.json          # 画布列表
│   └── boards/*.json       # 画布内容
├── ai/
│   ├── chats.json          # AI 对话记录
│   ├── credentials.bin     # 经系统加密的 API Key
│   ├── preferences.json    # 模型与搜索偏好
│   └── snapshots/          # AI 改写前的笔记快照
├── plugins/                # 已安装扩展：包体与授权记录
└── graph/
    ├── vaults.json         # 资料库（只读文件夹）注册表
    └── index/              # 扫描索引与节点坐标缓存
```

知识图谱添加的资料库文件夹本身留在原地，`data/graph/` 只保存注册表与索引缓存，移除资料库不会影响磁盘上的文件。

备份本地内容时复制整个 `data/` 目录即可。在线工作台的数据不在上述本地目录中，而是保存于你配置的 Supabase 和协作服务。

## 常见问题与限制

**支持哪些操作系统？** 目前发行包面向 Windows x64 桌面环境。

**不登录能使用吗？** 可以。记事、待办、画布、便签、主题和本地小青都不需要登录；只有在线工作台与账户功能需要 Supabase，实时编辑还需要可访问的协作服务。

**关闭窗口后程序去哪了？** 普通关闭会隐藏到系统托盘；使用托盘菜单的 Quit 或标题栏退出操作才会真正退出。

更多操作细节见 [功能手册](docs/user-manual.md)，其余问答见 [常见问答](docs/user-faq.md)。

## 反馈与支持

- [提交 Issue](https://github.com/PyTs1n9/Qing-Notepad/issues)
- 发送邮件至 1990629881@qq.com

## 许可证

[MIT](LICENSE)
