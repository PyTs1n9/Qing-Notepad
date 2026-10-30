/**
 * Headless smoke test: boots the static server, drives real Chrome through the
 * DevTools protocol, and asserts the three things reviewers will do — write a
 * fragment, open the tidy drawer, tick something off.
 *
 * `npm run smoke`. Needs Node 22+ (global WebSocket) and a local Chrome/Edge.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 4173);
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9333);
const PAGE_URL = `http://127.0.0.1:${PORT}/`;

const BROWSERS = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const browser = BROWSERS.find((path) => existsSync(path));
if (!browser) {
  console.error("✗ 找不到 Chrome/Edge，请通过 CHROME_PATH 指定可执行文件");
  process.exit(1);
}
if (typeof WebSocket === "undefined") {
  console.error("✗ 需要 Node 22+ 才自带 WebSocket");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 20000, interval = 120, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}（最后结果 ${String(last)}）`);
}

const results = [];
function assert(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const server = spawn(process.execPath, ["serve.mjs"], {
  cwd: process.cwd(),
  stdio: "ignore",
  env: { ...process.env, PORT: String(PORT) },
});

const profile = await mkdtemp(join(tmpdir(), "fragment-wall-"));
const chrome = spawn(
  browser,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let socket;
try {
  await waitFor(() => fetch(PAGE_URL).then((res) => res.ok), { label: "静态服务器" });

  const target = await waitFor(
    async () => {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((res) => res.json());
      return list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    },
    { label: "Chrome 调试目标" },
  );

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("WebSocket 连接失败"));
  });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      consoleErrors.push(details?.exception?.description ?? details?.text ?? "未捕获异常");
    }
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
    });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url: PAGE_URL });

  await waitFor(
    async () => {
      const { result } = await send("Runtime.evaluate", {
        expression: "document.readyState === 'complete' && document.querySelectorAll('.card').length > 0",
        returnByValue: true,
      });
      return result.value === true;
    },
    { label: "碎片墙渲染" },
  );

  const scenario = `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const out = { assets: {} };
    for (const path of ["./styles.css", "./app.js", "./tidy.js"]) {
      try {
        const response = await fetch(path);
        out.assets[path] = response.status;
      } catch (error) {
        out.assets[path] = String(error);
      }
    }

    out.seedCards = document.querySelectorAll(".card").length;
    out.guideVisible = !document.getElementById("guide").hidden;

    const box = document.getElementById("composer-input");
    box.value = "把碎片墙的截图发给运营确认 #工作";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(50);
    out.afterSubmit = document.querySelectorAll(".card").length;
    out.newest = document.querySelector(".card .card-text")?.textContent ?? "";
    out.composerCleared = box.value === "";

    document.getElementById("tidy-button").click();
    await sleep(120);
    out.panelOpen = document.getElementById("panel").classList.contains("is-open");
    out.markdown = document.getElementById("panel-markdown").textContent;
    out.summary = document.getElementById("panel-summary").textContent;

    document.getElementById("panel-close").click();
    await sleep(280);
    out.panelClosed = !document.getElementById("panel").classList.contains("is-open");

    const first = document.querySelector(".card");
    first.querySelector('[data-act="toggle"]').click();
    await sleep(60);
    out.afterToggleCards = document.querySelectorAll(".card").length;
    const stored = JSON.parse(localStorage.getItem("qing-fragment-wall:v1") || "[]");
    out.stored = stored.length;
    out.doneInStore = stored.filter((item) => item.done).length;

    const tagButton = document.querySelector(".tag-filter");
    if (tagButton) {
      tagButton.click();
      await sleep(60);
      out.tagFiltered = document.querySelectorAll(".card").length;
      out.tagActive = tagButton.classList.contains("is-active");
      // The tag row re-renders on every paint, so the original node is detached
      // by now; clear the filter through the button the fresh render produced.
      const clear = Array.from(document.querySelectorAll(".tag-filter")).find(
        (node) => node.textContent === "清除筛选",
      );
      clear?.click();
      await sleep(60);
      out.afterClear = document.querySelectorAll(".card").length;
    }
    out.errors = [];
    return out;
  })()`;

  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression: scenario,
    awaitPromise: true,
    returnByValue: true,
  });

  if (exceptionDetails) {
    assert("页面脚本执行", false, exceptionDetails.text ?? "Runtime.evaluate 抛错");
  }

  const out = result?.value ?? {};
  const markdown = out.markdown ?? "";

  assert("样式与脚本全部 200", Object.values(out.assets ?? {}).every((code) => code === 200), JSON.stringify(out.assets));
  assert("首屏渲染出示例碎片", out.seedCards >= 5, `${out.seedCards} 张卡片`);
  assert("首屏展示三步上手", out.guideVisible === true);
  assert("回车存下新碎片", out.afterSubmit === (out.seedCards ?? 0) + 1, `${out.seedCards} → ${out.afterSubmit}`);
  assert("新碎片置顶且内容正确", String(out.newest).includes("把碎片墙的截图发给运营确认"), String(out.newest));
  assert("输入框提交后清空", out.composerCleared === true);
  assert("一键整理打开抽屉", out.panelOpen === true, String(out.summary ?? ""));
  assert("整理结果含清单语法", markdown.includes("- [ ]") && markdown.includes("## 待办清单"));
  assert("整理结果按标签分组", markdown.includes("### 工作"));
  assert("问句进入待确认", markdown.includes("## 待确认") && markdown.includes("要不要把便签做成置顶小窗？"));
  assert("抽屉可以关闭", out.panelClosed === true);
  assert("勾选后从待办列表移出", out.afterToggleCards === (out.afterSubmit ?? 0) - 1, `${out.afterSubmit} → ${out.afterToggleCards}`);
  assert("状态写回本地存储", (out.stored ?? 0) >= 7 && (out.doneInStore ?? 0) >= 2, `共 ${out.stored} 条，已完成 ${out.doneInStore} 条`);
  assert("标签筛选生效", (out.tagFiltered ?? 99) < (out.afterToggleCards ?? 0), `筛选后 ${out.tagFiltered} 张`);
  assert("清除筛选恢复全部", out.afterClear === out.afterToggleCards, `恢复到 ${out.afterClear} 张`);
  assert("控制台无报错", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  const shots = [];
  const shoot = async (name) => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const path = join(tmpdir(), `fragment-wall-${name}.png`);
    await writeFile(path, Buffer.from(shot.data, "base64"));
    shots.push(path);
  };

  await shoot("desktop");
  await send("Runtime.evaluate", { expression: "document.getElementById('tidy-button').click()" });
  await sleep(320);
  await shoot("drawer");
  await send("Runtime.evaluate", { expression: "document.getElementById('panel-close').click()" });
  await sleep(320);

  const notesScenario = `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const out = {};
    const click = (selector) => document.querySelector(selector).click();

    click('[data-surface="notes"]');
    await sleep(120);
    out.notesVisible = !document.getElementById("notes-view").hidden;
    out.wallHidden = document.getElementById("wall-view").hidden;
    out.listCount = document.querySelectorAll(".note-item").length;
    out.firstTitle = document.getElementById("note-title").textContent;
    out.previewHeading = document.querySelector("#note-preview h1")?.textContent ?? "";
    out.previewCode = Boolean(document.querySelector("#note-preview pre code"));
    out.previewTasks = document.querySelectorAll("#note-preview li.is-task").length;

    click('.view-button[data-view="preview"]');
    await sleep(80);
    out.editorHiddenInPreview = document.getElementById("note-editor").offsetParent === null;
    click('.view-button[data-view="split"]');
    await sleep(80);
    out.splitShowsBoth =
      document.getElementById("note-editor").offsetParent !== null &&
      document.getElementById("note-preview").offsetParent !== null;

    click("#new-note-button");
    await sleep(120);
    out.afterCreate = document.querySelectorAll(".note-item").length;
    out.newTitle = document.getElementById("note-title").textContent;

    const editor = document.getElementById("note-editor");
    editor.value = "# 测试笔记\\n\\n- 一条要点\\n- [ ] 一件待办\\n";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(460);
    const store = JSON.parse(localStorage.getItem("qing-notes:v1") || "{}");
    out.persisted = Boolean(store.notes?.some((note) => note.body.includes("一条要点")));
    out.titleAfterTyping = document.getElementById("note-title").textContent;

    const search = document.getElementById("search");
    search.value = "卡片";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);
    out.searchCount = document.querySelectorAll(".note-item").length;
    out.searchHit = document.querySelector(".note-item-title")?.textContent ?? "";
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(80);

    click('[data-surface="wall"]');
    await sleep(80);
    click("#tidy-button");
    await sleep(140);
    click("#panel-save-note");
    await sleep(160);
    out.surfaceAfterSave = !document.getElementById("notes-view").hidden;
    out.afterSaveNote = document.querySelectorAll(".note-item").length;
    out.savedNoteTitle = document.getElementById("note-title").textContent;
    return out;
  })()`;

  const notesRun = await send("Runtime.evaluate", {
    expression: notesScenario,
    awaitPromise: true,
    returnByValue: true,
  });
  const notes = notesRun.result?.value ?? {};

  assert("切到笔记面", notes.notesVisible === true && notes.wallHidden === true);
  assert("示例笔记已就位", notes.listCount === 2, `${notes.listCount} 篇`);
  assert("笔记标题取首行", notes.firstTitle === "周会记录", String(notes.firstTitle));
  assert("预览渲染标题与代码块", notes.previewHeading === "周会记录" && notes.previewCode === true);
  assert("任务列表渲染成勾选框", notes.previewTasks === 2, `${notes.previewTasks} 条`);
  assert("预览视图隐藏编辑器", notes.editorHiddenInPreview === true);
  assert("分屏同时显示两栏", notes.splitShowsBoth === true);
  assert("新建笔记进入列表", notes.afterCreate === 3 && notes.newTitle === "新笔记", `${notes.afterCreate} 篇`);
  assert("输入 320ms 后落盘", notes.persisted === true);
  assert("标题跟随首行", notes.titleAfterTyping === "测试笔记", String(notes.titleAfterTyping));
  assert("笔记搜索命中", notes.searchCount === 1 && String(notes.searchHit).includes("卡片"), `${notes.searchCount} 篇`);
  assert("整理结果存为笔记", notes.surfaceAfterSave === true && notes.afterSaveNote === 4, `${notes.afterSaveNote} 篇`);
  assert("存下的笔记可取标题", String(notes.savedNoteTitle).startsWith("碎片整理"), String(notes.savedNoteTitle));

  await shoot("notes");

  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(240);
  await shoot("notes-mobile");

  await send("Runtime.evaluate", { expression: 'document.getElementById("note-back").click()' });
  await sleep(240);
  const listMode = await send("Runtime.evaluate", {
    expression:
      '({ mainHidden: getComputedStyle(document.querySelector(".pane-main")).display === "none", explorerShown: getComputedStyle(document.querySelector(".explorer")).display !== "none", items: document.querySelectorAll(".note-item").length })',
    returnByValue: true,
  });
  const mobileList = listMode.result?.value ?? {};
  assert(
    "手机端返回笔记列表",
    mobileList.mainHidden === true && mobileList.explorerShown === true && mobileList.items === 4,
    JSON.stringify(mobileList),
  );
  await shoot("notes-list-mobile");

  await send("Runtime.evaluate", { expression: 'document.querySelector(\'[data-surface="wall"]\').click()' });
  await sleep(240);
  await shoot("mobile");

  // Force an empty store and reload so the first-run copy is exercised rather
  // than assumed.
  await send("Runtime.evaluate", {
    expression: 'localStorage.setItem("qing-fragment-wall:v1", "[]"); location.reload();',
  });
  await waitFor(
    async () => {
      const { result } = await send("Runtime.evaluate", {
        expression: "document.readyState === 'complete' && document.querySelectorAll('.card').length === 0",
        returnByValue: true,
      });
      return result.value === true;
    },
    { label: "空状态渲染" },
  );
  const emptyState = await send("Runtime.evaluate", {
    expression:
      '({ hidden: document.getElementById("empty").hidden, title: document.querySelector(".empty-title").textContent, cta: document.getElementById("empty-focus").textContent })',
    returnByValue: true,
  });
  const empty = emptyState.result?.value ?? {};
  assert(
    "空状态给出引导",
    empty.hidden === false && String(empty.title).includes("墙上还是空的") && empty.cta === "开始写",
    JSON.stringify(empty),
  );
  await shoot("empty");

  console.log(`\n截图：\n${shots.map((path) => `  ${path}`).join("\n")}`);
} catch (error) {
  assert("冒烟流程跑完", false, error instanceof Error ? error.message : String(error));
} finally {
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  server.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
