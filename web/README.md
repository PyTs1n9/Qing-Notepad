# 青记 · 网页版（`main-web` 分支）

零构建静态站点，是青记的第二产品线。桌面端（Tauri）在 `main`；这里只有 `web/`，
不引用 `src/` 与 `src-tauri/` 的任何代码。

## 它是什么

一屏两面的笔记本，壳层照桌面端的几何重画（36px 顶栏、6px 留白三张浮卡、48px 活动栏、
`.theme-dark` 调色板）：

- **碎片墙**：回车即存一条碎片，`#标签` 自动归类；「一键整理」把碎片拆成待办清单。
- **笔记**：Markdown 编辑 / 预览 / 分屏、文件夹、标题与正文一起搜；整理结果可「存为笔记」。

## 本地跑

```bash
cd web
npm test        # 文本管线单测（tidy.js 10 条 + md.js 9 条）
npm run serve   # http://127.0.0.1:4173/
npm run smoke   # 无头 Chrome 走一遍主流程，31 条断言 + 7 张截图
```

`smoke.mjs` 需要 Node 22+（自带 `WebSocket`）与本地 Chrome/Edge，找不到浏览器时用
`CHROME_PATH` 指定。截图落在系统临时目录，不写进仓库。

## 发布

站点根目录选 `web/`，不要指向仓库根——根目录的 `index.html` 是 Tauri 渲染进程的入口，
在浏览器里打开只会得到空壳（`storage.ts` 在非 Tauri 环境直接返回 `null`）。

发布后拿到的公开链接形如 `https://<name>.app.workbuddy.host/?sharecode=…`，分享前先用浏览器
重新打开一次，确认别人能直接写入。

## 目录

```text
web/
├── index.html    壳层骨架（顶栏 / 活动栏 / 资源管理器 / 编辑区 / 右侧面板）
├── styles.css    全部样式，深色单主题
├── app.js        DOM 与状态：两个面、筛选、整理面板、自动保存
├── tidy.js       碎片 → 清单（纯函数）
├── md.js         Markdown 子集解析（返回数据，不返回 HTML）
├── tidy.test.js  ┐
├── md.test.js    ┘ node --test
├── serve.mjs     零依赖静态服务
└── smoke.mjs     无头浏览器冒烟
```

## 数据与边界

内容只写 `localStorage`：`qing-fragment-wall:v1`（碎片）、`qing-notes:v1`（笔记与文件夹）。
不登录、不上传、不发网络请求；清理浏览器数据会一并清除。

网页版**刻意没有**：便签 / 磁贴多窗口、托盘与全局快捷键、画布、知识图谱、本地向量检索、
在线工作台。前四项依赖 Tauri 的窗口与文件系统能力，向量模型 24 MB 会拖垮首屏，协作需要
Supabase 与独立服务且要求评审先注册。这些能力在桌面端仍然完整，取舍依据见
`docs/decisions-web-tool.md`。
