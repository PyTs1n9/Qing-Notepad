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

  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
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
