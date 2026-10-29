/*
 * Extension host: a hidden webview whose only door is the `qing-plugin-rpc`
 * custom scheme. It owns a pool of plugin workers and translates between their
 * `postMessage` protocol and the protocol's request/response.
 *
 * Two facts about this page are load-bearing and were each paid for once:
 *
 *   1. **This file is external, not inline.** The app CSP is
 *      `script-src 'self'` with no `'unsafe-inline'`, so an inline `<script>`
 *      is *silently* discarded — the page loads, nothing errors, nothing runs.
 *   2. **A diagnostic must not report through the channel it is testing.**
 *      The first probe reported its verdict by fetching the custom scheme,
 *      which is exactly what a blocked custom scheme prevents: "blocked" and
 *      "never ran" looked identical. The probe reports over a same-origin
 *      navigation, which no amount of `connect-src` trouble can stop.
 *
 * The page has no capabilities at all — no `invoke`, no `listen` — so the
 * protocol is its only channel in either direction. That is the sandbox.
 */

/** Candidate base URLs for the protocol, most-likely-first. */
const BASE_CANDIDATES = [
  // Tauri on Windows rewrites a custom scheme to `http://<scheme>.localhost/`,
  // and that is the form that measurably works here.
  "http://qing-plugin-rpc.localhost/host",
  // The bare scheme form, which is what a POSIX build resolves to.
  "qing-plugin-rpc://host",
];

/** How long one detection attempt may take before it counts as "no". */
const DETECT_TIMEOUT_MS = 1500;

const workers = new Map();
let base = null;
let running = true;

/**
 * Identifies *this* page instance to the host.
 *
 * WebView2 restarts a crashed renderer and the page comes back — the window
 * never looks gone. So "the host restarted" cannot be observed as a dead
 * window; it has to be observed as a **new page announcing itself**. The host
 * keeps the last epoch and treats a changed one as "everything I was doing here
 * is lost".
 */
const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** POST a plugin → host message. Never throws: the poll loop must survive. */
async function postUp(pluginId, message) {
  if (!base) return;
  try {
    await fetch(`${base}/up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId, message }),
    });
  } catch (error) {
    // The host sees a missing answer and times the call out; nothing useful
    // can be done from in here without the very channel that just failed.
  }
}

/**
 * Pick the base URL, once, by asking both candidates.
 *
 * Idempotent and time-boxed: the worker pool must start even when the protocol
 * is entirely unreachable — a dead transport is a *reported* failure at the
 * call sites (they time out), whereas a page that hangs on startup is a silent
 * one. The Windows form is the default because it is the measured one.
 */
async function detectBase() {
  const probe = async (candidate) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
    try {
      const response = await fetch(`${candidate}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "probe",
          message: { t: "log", level: "info", args: ["base-detect"] },
        }),
        signal: controller.signal,
      });
      return response.ok ? candidate : null;
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const found = await Promise.all(BASE_CANDIDATES.map(probe));
  base = found.find(Boolean) || BASE_CANDIDATES[0];
  return base;
}

/** Create (or replace) one plugin's worker from a `load` message. */
function loadWorker(pluginId, body) {
  stopWorker(pluginId);
  const blob = new Blob([body], { type: "text/javascript" });
  const objectUrl = URL.createObjectURL(blob);
  let worker;
  try {
    worker = new Worker(objectUrl, { type: "module" });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    void postUp(pluginId, { t: "gone", reason: `the plugin worker could not start: ${error}` });
    return;
  }
  workers.set(pluginId, { worker, objectUrl });
  worker.onmessage = (event) => {
    void postUp(pluginId, event.data);
  };
  worker.onerror = (event) => {
    void postUp(pluginId, {
      t: "gone",
      reason: (event && event.message) || "the plugin worker crashed",
    });
    stopWorker(pluginId);
  };
  worker.onmessageerror = () => {
    void postUp(pluginId, {
      t: "gone",
      reason: "the plugin sent a message that could not be deserialised",
    });
    stopWorker(pluginId);
  };
}

function stopWorker(pluginId) {
  const entry = workers.get(pluginId);
  if (!entry) return;
  workers.delete(pluginId);
  entry.worker.onmessage = null;
  entry.worker.onerror = null;
  entry.worker.onmessageerror = null;
  entry.worker.terminate();
  URL.revokeObjectURL(entry.objectUrl);
}

/** One host → ext-host message: either for the pool, or for a worker. */
function handleHostMessage(pluginId, message) {
  if (!message || typeof message !== "object") return;
  switch (message.t) {
    case "load":
      loadWorker(pluginId, message.body);
      return;
    case "unload":
      stopWorker(pluginId);
      return;
    default: {
      const entry = workers.get(pluginId);
      if (entry) entry.worker.postMessage(message);
      return;
    }
  }
}

/**
 * The down poll: one in flight at a time, for every worker at once.
 *
 * The Rust side blocks until there is something to deliver, so this is
 * push-shaped for the callers despite being a `GET`. A failure backs off rather
 * than spinning — a dead protocol must not become a hot loop.
 */
async function pollDown() {
  let backoffMs = 250;
  while (running) {
    try {
      const response = await fetch(`${base}/down`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });
      const payload = await response.json();
      backoffMs = 250;
      if (!payload || !payload.item) continue;
      handleHostMessage(payload.item.pluginId, payload.item.message);
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 5000);
    }
  }
}

/**
 * The probe, kept because it has already caught two silent failures in one
 * day. Only runs when Rust put `?probe=1` on the URL (`QING_EXT_HOST_PROBE`).
 */
async function runProbe() {
  const attempt = async (url) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "probe",
          message: { t: "log", level: "info", args: ["csp-probe ping"] },
        }),
      });
      return "ok-" + response.status;
    } catch (error) {
      return "blocked:" + (error && error.name ? error.name : "unknown");
    }
  };
  const a = await attempt("qing-plugin-rpc://host/up");
  const b = await attempt("http://qing-plugin-rpc.localhost/host/up");
  try {
    location.href =
      location.origin + "/__probe?a=" + encodeURIComponent(a) + "&b=" + encodeURIComponent(b);
  } catch (error) {
    // Nothing else to try.
  }
}

(async function main() {
  if (new URLSearchParams(location.search).has("probe")) {
    await runProbe();
    return;
  }
  await detectBase();
  // Announce this page instance before anything else: the host uses the epoch
  // to tell "a fresh worker pool" from "the same pool answering again", and it
  // has to know that before the first real message arrives.
  void postUp("$ext-host", { t: "hello", epoch });
  void pollDown();
})();
