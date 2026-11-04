/**
 * WebView2 acceptance runner with a long-lived session.
 *
 * Loads the *built* product — `src-tauri/target/release/qing-notepad.exe`, whose
 * frontend is the embedded `dist/` bundle — inside the real WebView2, drives it
 * over the Chrome DevTools Protocol, then reports layout assertions, console
 * errors and a screenshot.
 *
 * Why the release exe and not `npm run dev`: a dev-server screenshot proves the
 * source renders, not that the shipped bundle renders. CSP, asset paths and the
 * minified CSS all differ between the two.
 *
 * Lifecycle (this is the point of the script):
 *   - After a successful run the window STAYS OPEN. It is the acceptance surface a
 *     human looks at, so the runner must not tidy it away at the end of a turn.
 *   - Only two things close it: a human (tray → 退出, or the X button followed by
 *     quitting the tray, since close-to-tray only hides the window), or
 *     `npm run verify:webview:close`. `--replace` also closes it, explicitly, when
 *     a stale build is in the way.
 *   - A running instance locks its own exe on Windows, so the next build cannot
 *     overwrite it. Close before rebuilding; `--status` tells you whether that is
 *     needed.
 *
 * Usage:
 *   node scripts/verify-webview.mjs                 # assert, screenshot, keep open
 *   node scripts/verify-webview.mjs --close-after   # one-shot: assert then close
 *   node scripts/verify-webview.mjs --replace       # close a stale build, open the new one
 *   node scripts/verify-webview.mjs --status        # report the live session
 *   node scripts/verify-webview.mjs --close         # close the live session
 *   node scripts/verify-webview.mjs --eval "<js>"   # probe the running build
 *   node scripts/verify-webview.mjs --app-arg "<path>"  # launch as Explorer would
 *   node scripts/verify-webview.mjs --target noteWindow= --no-assert --eval "<js>"
 *                                                   # probe a detached note window
 *
 * Exit codes (run): 0 = every check passed, 1 = an assertion or console error
 * failed, 2 = the runner could not start (missing exe, blocked by another
 * instance, CDP never came up).
 * Exit codes (--status): 0 = running and matches the current build, 1 = not
 * running, 2 = running but stale (a build happened since it opened).
 *
 * Data safety: the app resolves its data root from
 * `%APPDATA%/com.qing-notepad.app/storage.json`, which may point outside the
 * repo. This runner never types, clicks destructive controls or writes files on
 * the app's behalf; the only writes are the app's own startup autosave.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = join(repoRoot, ".workbuddy", "state");
const statePath = join(stateDir, "webview-session.json");

function readFlag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const hasFlag = (name) => process.argv.includes(`--${name}`);

const port = Number(readFlag("port", "9333"));
const exePath = resolve(repoRoot, readFlag("exe", "src-tauri/target/release/qing-notepad.exe"));
const shotPath = resolve(repoRoot, readFlag("shot", "local_img/webview-main.png"));
const timeoutMs = Number(readFlag("timeout", "45000"));
// Entry animations (motion) run for a few hundred ms after mount; measuring or
// screenshotting before they finish produces clipped/offset readings that look
// like layout bugs.
const settleMs = Number(readFlag("settle", "900"));
const probeExpression = readFlag("eval", null);
/**
 * Second window to probe (e.g. `--target noteWindow=`). Without it the runner
 * deliberately prefers the shell page, not a detached note window that happens
 * to be open: the shell is what the assertions describe.
 */
const targetFilter = readFlag("target", null);
/** Probe a non-shell window: skip the shell assertions, keep the screenshot. */
const noAssert = hasFlag("no-assert");
const appArg = readFlag("app-arg", null);
const closeAfter = hasFlag("close-after");
const replace = hasFlag("replace");

const failures = [];
const consoleErrors = [];
const consoleWarnings = [];
// Cloud calls (announcements, workspace notifications) 404 when the account or the
// network is unavailable. They are reported, but they are not proof that the build
// is broken — only same-origin failures are treated as fatal.
const networkNoise = [];

function log(message) {
  console.log(`[verify:webview] ${message}`);
}

function readState() {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function clearState() {
  if (existsSync(statePath)) rmSync(statePath, { force: true });
}

/** `dist/index.html` carries the hashed asset names, so its hash identifies a build. */
function currentBuildId() {
  const indexPath = join(repoRoot, "dist", "index.html");
  const distHash = existsSync(indexPath)
    ? createHash("sha256").update(readFileSync(indexPath)).digest("hex").slice(0, 12)
    : "no-dist";
  let exeStamp = "no-exe";
  if (existsSync(exePath)) {
    const stat = statSync(exePath);
    exeStamp = `${stat.size}-${Math.round(stat.mtimeMs)}`;
  }
  return `${distHash}.${exeStamp}`;
}

function listAppPids() {
  const result = spawnSync(
    "tasklist",
    ["/FI", "IMAGENAME eq qing-notepad.exe", "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  if (!result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^"([^"]+)","(\d+)"/))
    .filter(Boolean)
    .map((match) => ({ name: match[1], pid: Number(match[2]) }));
}

const isAlive = (pid) => Boolean(pid) && listAppPids().some((entry) => entry.pid === pid);

function killPid(pid) {
  if (!pid) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

async function waitPidExit(pid, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((done) => setTimeout(done, 200));
  }
  return !isAlive(pid);
}

/**
 * `spawn(..., { detached: true })` is not enough here: the tool host reaps the
 * whole process tree when the command that started it exits. Handing the launch
 * to explorer.exe puts the app outside that tree, which is what lets the window
 * outlive this script. The batch file sets the CDP flag because explorer inherits
 * its own environment, not ours.
 */
function launchViaExplorer() {
  mkdirSync(stateDir, { recursive: true });
  const launcher = join(stateDir, `webview-launch-${port}.cmd`);
  // `--app-arg` is how the acceptance drives "Explorer opened a .md": the app
  // must treat it as a real command-line launch, not a test-only path.
  const command = appArg ? `start "" "${exePath}" "${appArg}"` : `start "" "${exePath}"`;
  writeFileSync(
    launcher,
    [
      "@echo off",
      `set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${port}"`,
      command,
      "",
    ].join("\r\n"),
    "utf8",
  );
  const before = new Set(listAppPids().map((entry) => entry.pid));
  spawn("explorer.exe", [launcher], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return before;
}

async function waitForNewPid(before, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const fresh = listAppPids().find((entry) => !before.has(entry.pid));
    if (fresh) return fresh.pid;
    await new Promise((done) => setTimeout(done, 200));
  }
  return null;
}

async function waitFor(check, { timeout = timeoutMs, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* keep polling */
    }
    if (Date.now() > deadline) return null;
    await new Promise((done) => setTimeout(done, interval));
  }
}

function pickPage(targets) {
  const pages = targets.filter((target) => target.type === "page");
  if (targetFilter) {
    return pages.find((target) => (target.url ?? "").includes(targetFilter)) ?? null;
  }
  // Prefer the shell: with a detached note window open (or opened by
  // `--app-arg`), both pages load `index.html`, and the shell is the one the
  // assertions below describe.
  return (
    pages.find((target) => /tauri\.localhost|index\.html/.test(target.url ?? "") && !/[?&]noteWindow=/.test(target.url ?? "")) ??
    pages.find((target) => /tauri\.localhost|index\.html/.test(target.url ?? "")) ??
    pages.find((target) => !/^(devtools|chrome)/.test(target.url ?? "")) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Session-only modes: they never build, assert or screenshot.
// ---------------------------------------------------------------------------

function reportStatus() {
  const buildId = currentBuildId();
  const state = readState();
  if (!state) {
    console.log(JSON.stringify({ running: false, reason: "no-session", currentBuildId: buildId }, null, 2));
    return 1;
  }
  if (!isAlive(state.pid)) {
    clearState();
    console.log(
      JSON.stringify(
        { running: false, reason: "process-dead", staleState: state, currentBuildId: buildId },
        null,
        2,
      ),
    );
    return 1;
  }
  const match = state.buildId === buildId;
  console.log(
    JSON.stringify(
      {
        running: true,
        pid: state.pid,
        port: state.port,
        startedAt: state.startedAt,
        screenshot: state.screenshot ?? null,
        stateBuildId: state.buildId,
        currentBuildId: buildId,
        buildMatch: match,
      },
      null,
      2,
    ),
  );
  return match ? 0 : 2;
}

async function closeSession() {
  const state = readState();
  if (!state) {
    log("no tracked session — nothing to close");
    return 0;
  }
  if (!isAlive(state.pid)) {
    clearState();
    log(`pid ${state.pid} already gone; cleared stale state`);
    return 0;
  }
  killPid(state.pid);
  const exited = await waitPidExit(state.pid);
  clearState();
  log(exited ? `closed pid ${state.pid}` : `pid ${state.pid} did not exit`);
  return exited ? 0 : 1;
}

// ---------------------------------------------------------------------------

if (hasFlag("status")) {
  process.exit(reportStatus());
}
if (hasFlag("close")) {
  process.exit(await closeSession());
}

if (!existsSync(exePath)) {
  console.error(`[verify:webview] missing release exe: ${exePath}`);
  console.error("[verify:webview] build it first: npm run tauri -- build --no-bundle");
  process.exit(2);
}

let appPid = null;
let reused = false;
const buildId = currentBuildId();
const existing = readState();
const existingAlive = existing ? isAlive(existing.pid) : false;

if (existing && !existingAlive) {
  clearState();
  log(`cleared stale state for pid ${existing.pid}`);
}

if (existing && existingAlive) {
  if (existing.buildId !== buildId && !replace) {
    console.error(
      `[verify:webview] a stale build is still open (pid ${existing.pid}).\n` +
        `  running: ${existing.buildId}\n  current: ${buildId}\n` +
        "  rebuilds cannot overwrite a locked exe, so close it first:\n" +
        "    npm run verify:webview:close\n" +
        "  or re-run with --replace to close it and open the new build.",
    );
    process.exit(2);
  }
  if (replace && existing.buildId !== buildId) {
    log(`--replace: closing stale build (pid ${existing.pid})`);
    killPid(existing.pid);
    if (!(await waitPidExit(existing.pid))) {
      console.error(`[verify:webview] pid ${existing.pid} refused to exit; aborting`);
      process.exit(2);
    }
    clearState();
  } else {
    appPid = existing.pid;
    reused = true;
    log(`reusing the open build (pid ${appPid}); no new window was created`);
  }
}

if (!appPid) {
  const untracked = listAppPids();
  if (untracked.length > 0) {
    console.error(
      `[verify:webview] another qing-notepad.exe is already running (pid ${untracked[0].pid}).\n` +
        "  It is probably the installed build, and its single-instance lock would swallow this launch.\n" +
        "  Quit it from the tray (退出) and retry.",
    );
    process.exit(2);
  }

  const before = launchViaExplorer();
  const launchedPid = await waitForNewPid(before);
  if (!launchedPid) {
    console.error("[verify:webview] the app process never appeared; check explorer launch permissions");
    process.exit(2);
  }
  appPid = launchedPid;
  writeState({
    pid: appPid,
    port,
    exe: exePath,
    buildId,
    startedAt: new Date().toISOString(),
    screenshot: null,
  });
  log(`opened pid ${appPid} (build ${buildId})`);
}

// WebView2 binds the debugging port a moment after the process appears; on a
// cold start that can take a second or two. Poll instead of checking once:
// a single check turns a slow start into "this build cannot be inspected".
let alreadyListening = false;
const cdpDeadline = Date.now() + 10_000;
while (Date.now() < cdpDeadline) {
  alreadyListening = await fetch(`http://127.0.0.1:${port}/json/version`)
    .then((response) => response.ok)
    .catch(() => false);
  if (alreadyListening) break;
  await new Promise((done) => setTimeout(done, 200));
}

if (!alreadyListening) {
  // Only a window this script opened carries the CDP flag.
  console.error(
    `[verify:webview] pid ${appPid} is running but CDP is not listening on ${port}.\n` +
      "  It was not opened by this runner (likely a manual launch), so it cannot be inspected.\n" +
      `  Close it (pid ${appPid}) and re-run the acceptance flow.`,
  );
  if (reused) clearState();
  process.exit(2);
}

let socket = null;
let keptOpen = false;

async function main() {
  const version = await waitFor(async () => {
    if (!isAlive(appPid)) throw new Error("app exited");
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok ? response.json() : null;
  });
  if (!version) throw new Error(`WebView2 CDP never answered on port ${port}`);

  const page = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return pickPage(targets);
  });
  if (!page) throw new Error("no page target in the WebView2 instance");

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });

  // Re-attaching replays the page's whole console history. Without a cut-off, a
  // long-lived window would fail acceptance with errors that predate this run.
  const attachAt = Date.now();
  let replaying = reused;
  if (replaying) setTimeout(() => { replaying = false; }, 500);

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      if (replaying) return;
      const detail = message.params.exceptionDetails;
      consoleErrors.push(detail.exception?.description ?? detail.text ?? "unknown exception");
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      if (replaying) return;
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" ");
      if (message.params.type === "error") consoleErrors.push(text);
      else if (message.params.type === "warning") consoleWarnings.push(text);
      return;
    }
    if (message.method === "Log.entryAdded") {
      const entry = message.params.entry;
      // `timestamp` is wall-clock, so on a reused window the replayed entries are
      // older than attachAt. A fresh launch keeps everything.
      if (reused && typeof entry.timestamp === "number" && entry.timestamp < attachAt - 500) return;
      if (replaying) return;
      const url = entry.url ?? "";
      const line = `${entry.source}: ${entry.text}${url ? ` [${url}]` : ""}`;
      if (entry.level === "error") {
        // A 404 on our own origin means a missing asset — that is a build defect.
        // Anything cross-origin is the cloud layer, not this build.
        const localOrigin = /^(https?:\/\/tauri\.localhost\/|https?:\/\/asset\.localhost\/|asset:)/.test(url);
        (localOrigin || !url ? consoleErrors : networkNoise).push(line);
      } else if (entry.level === "warning") {
        consoleWarnings.push(line);
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolveCall, rejectCall) => {
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    }
    return result.result.value;
  }

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");

  const booted = await waitFor(async () =>
    evaluate(`(() => {
      const root = document.getElementById("root");
      return Boolean(root && root.childElementCount > 0);
    })()`),
  );
  if (!booted) {
    const startupError = await evaluate(
      `document.getElementById("startup-error")?.textContent ?? ""`,
    ).catch(() => "");
    failures.push(`renderer never mounted${startupError ? `: ${startupError}` : ""}`);
  }

  // Let fonts, theme classes and the first layout pass settle before measuring.
  await evaluate(
    `(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return true;
    })()`,
  ).catch(() => {});

  // Tabs restore before their bodies arrive: a screenshot taken too early shows
  // the CodeMirror placeholder and "0 字", which reads as a data-loss bug. Wait
  // until the layout signature stops changing instead of trusting a fixed delay.
  const signature = `(() => {
    const cm = document.querySelector(".cm-content");
    return [
      document.querySelectorAll(".cm-line").length,
      cm ? cm.innerText.length : -1,
      document.querySelectorAll(".ai-msg-list > *").length,
      document.querySelectorAll("[role=tab]").length,
    ].join(":");
  })()`;
  let lastSignature = null;
  let stableSince = Date.now();
  const settleDeadline = Date.now() + 8000;
  while (Date.now() < settleDeadline) {
    const current = await evaluate(signature).catch(() => null);
    if (current !== lastSignature) {
      lastSignature = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 600) {
      break;
    }
    await new Promise((done) => setTimeout(done, 200));
  }

  await new Promise((done) => setTimeout(done, Number.isFinite(settleMs) ? settleMs : 900));

  let probe = null;
  if (probeExpression) {
    probe = await evaluate(probeExpression);
  }

  const snapshot = await evaluate(`(() => {
    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
    };
    const root = document.querySelector(".app-root");
    const cards = [...document.querySelectorAll(".shell-box")];
    const editor = document.querySelector("main.shell-box");
    const drag = [...document.querySelectorAll("[data-tauri-drag-region]")];
    const railButtons = [...document.querySelectorAll('button[aria-label]')].filter((b) => b.closest(".shell-box"));
    const brokenImages = [...document.images]
      .filter((img) => img.getBoundingClientRect().width > 0 && img.complete && img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.src);
    const body = document.body;
    const overflowX = body.scrollWidth - body.clientWidth;
    return {
      hasTauri: Boolean(window.__TAURI_INTERNALS__),
      startupError: document.getElementById("startup-error")?.textContent?.slice(0, 400) ?? null,
      rootChildren: document.getElementById("root")?.childElementCount ?? 0,
      appRoot: rect(root),
      shellCards: cards.length,
      editorCard: rect(editor),
      dragRegions: drag.length,
      railButtons: railButtons.length,
      textSample: (root?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 160),
      brokenImages: brokenImages.slice(0, 5),
      overflowX,
      fontsStatus: document.fonts?.status ?? "unknown",
      glass: root?.getAttribute("data-glass") ?? null,
      themeClass: [...document.documentElement.classList].concat([...body.classList]).join(" "),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      url: location.href,
    };
  })()`);

  // ---- assertions -------------------------------------------------------
  // `--no-assert` exists for probes of a second window (sticky / tile / note),
  // which have no `.shell-box` by design. The screenshot still lands.
  if (!noAssert) {
    if (snapshot.startupError) failures.push(`startup error panel: ${snapshot.startupError}`);
    if (!snapshot.appRoot) failures.push("`.app-root` is missing — App never rendered");
    if (snapshot.rootChildren < 1) failures.push("#root is empty");
    if (!snapshot.hasTauri) failures.push("window.__TAURI_INTERNALS__ missing — this is not the Tauri webview");
    if (snapshot.shellCards < 2) failures.push(`expected >=2 floating shell cards, saw ${snapshot.shellCards}`);
    if (!snapshot.editorCard || snapshot.editorCard.w < 320 || snapshot.editorCard.h < 200) {
      failures.push(`editor card collapsed: ${JSON.stringify(snapshot.editorCard)}`);
    }
    if (snapshot.dragRegions < 1) failures.push("title bar drag region missing");
    if (snapshot.railButtons < 3) failures.push(`activity rail looks empty (${snapshot.railButtons} labelled buttons)`);
    if (!snapshot.textSample) failures.push("shell rendered no visible text");
    if (snapshot.brokenImages.length > 0) failures.push(`broken images: ${snapshot.brokenImages.join(", ")}`);
    if (snapshot.overflowX > 1) failures.push(`horizontal overflow of ${snapshot.overflowX}px on <body>`);
  }

  mkdirSync(dirname(shotPath), { recursive: true });
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));

  const report = {
    exe: exePath,
    pid: appPid,
    reused,
    buildId,
    url: snapshot.url,
    viewport: snapshot.viewport,
    themeClass: snapshot.themeClass,
    glass: snapshot.glass,
    shellCards: snapshot.shellCards,
    editorCard: snapshot.editorCard,
    dragRegions: snapshot.dragRegions,
    railButtons: snapshot.railButtons,
    fontsStatus: snapshot.fontsStatus,
    textSample: snapshot.textSample,
    probe,
    consoleErrors,
    networkNoise: networkNoise.slice(0, 10),
    consoleWarnings: consoleWarnings.slice(0, 10),
    screenshot: shotPath,
    failures,
    keptOpen: false,
    ok: failures.length === 0 && consoleErrors.length === 0,
  };

  if (consoleErrors.length > 0) {
    report.failures = failures.concat(consoleErrors.map((error) => `console error: ${error}`));
  }

  socket.close();

  // Persist the session even when assertions failed: the window is still the
  // thing a human needs to look at, and `--status` must be able to find it.
  if (!closeAfter) {
    keptOpen = true;
    report.keptOpen = true;
    writeState({
      pid: appPid,
      port,
      exe: exePath,
      buildId,
      startedAt: existing?.pid === appPid ? existing.startedAt : new Date().toISOString(),
      screenshot: shotPath,
    });
  }

  console.log(JSON.stringify(report, null, 2));

  if (keptOpen) {
    log(`window left open (pid ${appPid}). Close it from the tray, or: npm run verify:webview:close`);
  } else {
    killPid(appPid);
    await waitPidExit(appPid);
    clearState();
    log(`--close-after: closed pid ${appPid}`);
  }

  return report.ok;
}

let ok = false;
try {
  ok = await main();
} catch (error) {
  console.error(`[verify:webview] ${error instanceof Error ? error.message : String(error)}`);
  ok = false;
  socket?.close();
  if (closeAfter && appPid) {
    killPid(appPid);
    await waitPidExit(appPid);
    clearState();
  }
}

process.exit(ok ? 0 : 1);
