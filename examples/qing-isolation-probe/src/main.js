/**
 * Example plugin: check the isolation assumptions from inside a real worker.
 *
 * The dev probe (`?probe=1`) can only run in a dev build, because production
 * strips it. This plugin checks the same four facts through the production code
 * path — the blob worker the host actually creates — so the answer reflects the
 * build the user is running, not a debugging arrangement of it.
 *
 * Expected result on a healthy build:
 *   window=undefined document=undefined tauri=undefined fetch=blocked
 */
const COMMAND_ID = "qing.isolation-probe.run";

function describe(value) {
  return typeof value;
}

qing.commands.register(COMMAND_ID, async () => {
  const scope = globalThis;

  // 1 & 2: a dedicated worker has no DOM globals at all.
  const hasWindow = describe(scope.window) !== "undefined";
  const hasDocument = describe(scope.document) !== "undefined";

  // 3: Tauri injects its IPC object into the main webview's window only.
  const hasTauri = describe(scope.__TAURI_INTERNALS__) !== "undefined";

  // 4: the worker inherits the window's CSP; `connect-src` has no wildcard, so
  // this must reject. A resolved request means the network policy is open.
  let network;
  try {
    await fetch("https://example.com/", { mode: "no-cors" });
    network = "ALLOWED";
  } catch {
    network = "blocked";
  }

  const summary =
    `window=${hasWindow ? "VISIBLE" : "undefined"} ` +
    `document=${hasDocument ? "VISIBLE" : "undefined"} ` +
    `tauri=${hasTauri ? "VISIBLE" : "undefined"} ` +
    `fetch=${network}`;

  const isolated = !hasWindow && !hasDocument && !hasTauri && network === "blocked";
  qing.ui.toast(summary, isolated ? "success" : "danger");
  qing.log(summary);
});
