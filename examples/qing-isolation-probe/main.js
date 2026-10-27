// src/main.js
var COMMAND_ID = "qing.isolation-probe.run";
function describe(value) {
  return typeof value;
}
qing.commands.register(COMMAND_ID, async () => {
  const scope = globalThis;
  const hasWindow = describe(scope.window) !== "undefined";
  const hasDocument = describe(scope.document) !== "undefined";
  const hasTauri = describe(scope.__TAURI_INTERNALS__) !== "undefined";
  let network;
  try {
    await fetch("https://example.com/", { mode: "no-cors" });
    network = "ALLOWED";
  } catch {
    network = "blocked";
  }
  const summary = `window=${hasWindow ? "VISIBLE" : "undefined"} document=${hasDocument ? "VISIBLE" : "undefined"} tauri=${hasTauri ? "VISIBLE" : "undefined"} fetch=${network}`;
  const isolated = !hasWindow && !hasDocument && !hasTauri && network === "blocked";
  qing.ui.toast(summary, isolated ? "success" : "danger");
  qing.log(summary);
});
