#!/usr/bin/env node
/**
 * Headless verification for the plugin worker prelude (`src/plugin/worker-boot.js`).
 *
 * The app builds one blob per plugin:
 *
 *     <worker-boot.js>
 *     self.__qing_main = async function () { <bundled main.js> };
 *
 * which means the prelude cannot be imported and unit-tested — it only exists
 * as text that is concatenated. This script therefore builds the *same* blob
 * from the *same* source file and runs it in a `vm` context whose global object
 * plays the part of a worker's `self`, so the prelude and the bundle are
 * exercised exactly as they ship.
 *
 * What it pins down:
 *   - the CommonJS shim: a `--format=cjs` bundle (esbuild, UMD, hand-written)
 *     loads instead of dying with `exports is not defined`;
 *   - `require()` throws `E_REQUIRE_UNSUPPORTED` rather than pretending;
 *   - the prelude adds exactly four globals (`qing`, `module`, `exports`,
 *     `require`) and nothing else — no `window`, no `document`, no Tauri IPC;
 *   - `qing` is populated from `init` *before* module-level plugin code runs,
 *     and a command registered by a CJS bundle is reachable over postMessage.
 *
 *   node scripts/verify-plugin-runtime/run.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const bootSource = fs.readFileSync(path.join(root, "src", "plugin", "worker-boot.js"), "utf8");

let checks = 0;
let failures = 0;

function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const section = (title) => console.log(`\n${title}`);

/**
 * A context whose global object is `self`, like a worker. The prelude is
 * string-concatenated with the body, exactly as `headless.ts` does it.
 */
function makeWorker(bodySource) {
  const posted = [];
  const listeners = [];
  const sandbox = {
    // Worker surface the prelude and `bridge.ts` rely on.
    postMessage: (message) => posted.push(message),
    addEventListener: (type, listener) => listeners.push({ type, listener }),
    console,
    setTimeout,
    clearTimeout,
    // Not provided by a worker; present so the assertions below can prove the
    // prelude never reads or defines them.
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  const source =
    bodySource === undefined
      ? bootSource
      : `${bootSource}\nself.__qing_main = async function () {\n${bodySource}\n};\n`;
  vm.runInContext(source, context, { filename: "plugin-worker.js" });
  const dispatch = async (data) => {
    for (const { type, listener } of listeners) {
      if (type === "message") await listener({ data });
    }
  };
  return { sandbox, context, posted, dispatch };
}

const INIT = {
  t: "init",
  id: "qing.probe",
  version: "1.2.3",
  apiVersion: 1,
  hostVersion: "0.7.3",
  permissions: ["notes:read"],
};

/** Wait for the microtask queue the prelude resolves on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function bundle(entrySource, format, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qing-rt-"));
  const entry = path.join(dir, "extension.js");
  fs.writeFileSync(entry, entrySource);
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format,
    platform: "browser",
    target: "es2020",
    logLevel: "silent",
    ...extra,
  });
  return result.outputFiles[0].text;
}

// ---------------------------------------------------------------------------
section("Global surface: the prelude adds four bindings and nothing else");

{
  const { sandbox } = makeWorker();
  const added = Object.getOwnPropertyNames(sandbox)
    .filter((key) => !["postMessage", "addEventListener", "console", "setTimeout", "clearTimeout", "self"].includes(key))
    .sort();
  check("only qing/module/exports/require appear on the global", JSON.stringify(added) === JSON.stringify(["exports", "module", "qing", "require"]), added);
  check("no `window`, `document` or Tauri IPC is defined",
    sandbox.window === undefined &&
      sandbox.document === undefined &&
      sandbox.__TAURI_INTERNALS__ === undefined &&
      sandbox.__TAURI__ === undefined);
  check("CJS bindings are non-enumerable, so `for in` cannot see them",
    ["module", "exports", "require"].every((key) => !Object.getOwnPropertyDescriptor(sandbox, key).enumerable));
  check("qing is enumerable but neither writable nor configurable", (() => {
    const descriptor = Object.getOwnPropertyDescriptor(sandbox, "qing");
    return descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false;
  })());
}

// ---------------------------------------------------------------------------
section("CommonJS shim: an ESM bundle compiled to cjs loads and runs");

const cjsFixture = `
  export const MARKER = "cjs-ok";
  export function activate() {}
  qing.commands.register("qing.probe.run", () => ({ marker: MARKER, id: qing.plugin.id }));
`;

{
  const code = await bundle(cjsFixture, "cjs");
  check("the bundle really is CommonJS (it references `module.exports`)", code.includes("module.exports"), code.slice(0, 120));

  const { sandbox, posted, dispatch } = makeWorker(code);
  await dispatch(INIT);
  await settle();

  check("the worker reports `ready`", posted.some((message) => message.t === "ready"), posted);
  check("the bundle did not throw on load", !posted.some((message) => message.t === "log" && message.level === "error"), posted.filter((m) => m.t === "log"));
  check("`module.exports` is a real object, not undefined", sandbox.module && typeof sandbox.module.exports === "object");

  await dispatch({ t: "call", ns: "commands", method: "execute", args: ["qing.probe.run"], rid: 7 });
  await settle();
  const response = posted.find((message) => message.t === "res" && message.rid === 7);
  check("a command registered from CJS code answers over postMessage",
    response?.ok === true && response.value?.marker === "cjs-ok", response);
  check("qing.plugin.id is populated before the bundle's module code runs",
    response?.value?.id === "qing.probe", response?.value);
}

{
  // `exports.x = ...` and `module.exports = ...` agree until one rebinds.
  const { sandbox, dispatch } = makeWorker(`
    module.exports = { reassigned: true };
    exports.added = "still-the-original-object";
  `);
  await dispatch(INIT);
  await settle();
  check("`module.exports = …` is an allowed assignment", sandbox.module.exports?.reassigned === true, sandbox.module.exports);
  check("`exports` keeps pointing at the pre-reassignment object",
    sandbox.exports?.added === "still-the-original-object" && sandbox.exports.reassigned === undefined);
}

// ---------------------------------------------------------------------------
section("require(): refused with a code, never silently resolved");

{
  const { sandbox, dispatch, posted } = makeWorker(`
    let threw = null;
    try { require("node:fs"); } catch (error) { threw = { code: error.code, message: error.message }; }
    self.__requireResult = threw;
  `);
  await dispatch(INIT);
  await settle();
  const result = sandbox.__requireResult;
  check("require throws synchronously", result !== null, result);
  check("the error carries E_REQUIRE_UNSUPPORTED", result?.code === "E_REQUIRE_UNSUPPORTED", result);
  check("the message names the module that was asked for", String(result?.message).includes("node:fs"), result?.message);
  check("no host path resolution happened (the module was not loaded)",
    !posted.some((message) => message.t === "log" && message.level === "error"));
}

{
  // The realistic failure: a bundle with an external import emits `require(...)`
  // at load time. It must fail with a code the author can act on.
  const code = await bundle(`import { readFileSync } from "node:fs"; export const x = readFileSync;`, "cjs", {
    external: ["node:fs"],
  });
  check("an external import survives as `require(...)` in the bundle", code.includes("require("), code.slice(0, 200));
  const { posted, dispatch } = makeWorker(code);
  await dispatch(INIT);
  await settle();
  const logged = posted.filter((message) => message.t === "log" && message.level === "error");
  // `describe()` logs `error.stack`, which carries the message but not the
  // custom `.code`, so the sentence is what the author sees in the log pane.
  check("loading it logs the refusal instead of dying silently",
    logged.some((message) => String(message.args[0]).includes('require("node:fs") is not supported')), logged);
}

// ---------------------------------------------------------------------------
section("Regression: an ESM bundle still works, and the shim is not load-bearing");

{
  const code = await bundle(
    `qing.commands.register("qing.probe.esm", () => ({ format: "esm" }));`,
    "esm",
  );
  const { posted, dispatch } = makeWorker(code);
  await dispatch(INIT);
  await settle();
  await dispatch({ t: "call", ns: "commands", method: "execute", args: ["qing.probe.esm"], rid: 1 });
  await settle();
  const response = posted.find((message) => message.t === "res" && message.rid === 1);
  check("an esm bundle registers commands as before", response?.ok === true && response.value?.format === "esm", response);
}

// ---------------------------------------------------------------------------
section("Hostile plugin code stays inside the box");

{
  const { sandbox, dispatch, posted } = makeWorker(`
    self.__attempts = {};
    try { module.exports = { hijacked: true }; self.__attempts.exports = "already-allowed"; } catch (error) { self.__attempts.exports = error.name; }
    try { qing = { fake: true }; } catch (error) { self.__attempts.qing = error.name; }
    try { self.qing = { fake: true }; } catch (error) { self.__attempts.selfQing = error.name; }
  `);
  await dispatch(INIT);
  await settle();
  check("a plugin cannot replace `qing` (assignment is rejected)",
    sandbox.__attempts.qing === "TypeError" || sandbox.qing.fake === undefined, sandbox.__attempts);
  check("`qing` still has its real shape after the attempt",
    typeof sandbox.qing.log === "function" && typeof sandbox.qing.storage?.get === "function");
  check("the surviving `qing` is the one the prelude made",
    sandbox.qing.plugin?.id === "qing.probe", sandbox.qing.plugin);
  check("nothing was posted as an error for the rejected assignment",
    !posted.some((message) => message.t === "log" && message.level === "error"), posted);
}

// ---------------------------------------------------------------------------
section("CommonJS `activate` / `deactivate` exports are honoured");

{
  // The shape a VS Code extension is written in: register nothing at module
  // level, do all of it in `activate(ctx)`. Until the P0 close-out the host
  // never called it, so such a package loaded, answered `ready`, and had no
  // commands — a failure the author cannot see.
  const code = await bundle(
    `export function activate(context) {
       qing.commands.register("qing.probe.vscode", () => ({
         via: "exports.activate",
         subscriptions: Array.isArray(context && context.subscriptions),
       }));
     }
     export function deactivate() {}`,
    "cjs",
  );
  const worker = makeWorker(code);
  await worker.dispatch(INIT);
  await settle();
  await worker.dispatch({ t: "call", ns: "commands", method: "execute", args: ["qing.probe.vscode"], rid: 3 });
  await settle();
  const response = worker.posted.find((message) => message.t === "res" && message.rid === 3);
  check(
    "the exported activate() runs, so its command is reachable",
    response?.ok === true && response.value?.via === "exports.activate",
    response,
  );
  check(
    "activate() receives the documented `{ subscriptions: [] }` context",
    response?.value?.subscriptions === true,
    response?.value,
  );
  check(
    "activate() running did not break `ready` or log an error",
    worker.posted.some((message) => message.t === "ready") &&
      !worker.posted.some((message) => message.t === "log" && message.level === "error"),
    worker.posted,
  );
}

{
  // A throwing `activate` is a plugin bug, not a host crash: it has to land in
  // the log pane and leave the worker answering.
  const { dispatch, posted } = makeWorker(`
    exports.activate = function () { throw new Error("activate exploded"); };
  `);
  await dispatch(INIT);
  await settle();
  check(
    "a throwing activate() is logged as an error, not swallowed",
    posted.some((message) => message.t === "log" && message.level === "error" &&
      String(message.args[0]).includes("activate exploded")),
    posted,
  );
}

{
  const { sandbox, dispatch } = makeWorker(`
    exports.deactivate = function () { self.__deactivated = true; };
  `);
  await dispatch(INIT);
  await settle();
  await dispatch({ t: "event", name: "deactivate" });
  await settle();
  check("an exported deactivate() runs on the deactivate event", sandbox.__deactivated === true, sandbox.__deactivated);
}

{
  // Both directions of the guard: no exports at all must not throw, and
  // `activate` that is not a function must not be called.
  const { dispatch, posted } = makeWorker(`
    exports.activate = "not a function";
    qing.commands.register("qing.probe.plain", () => ({ ok: true }));
  `);
  await dispatch(INIT);
  await settle();
  await dispatch({ t: "call", ns: "commands", method: "execute", args: ["qing.probe.plain"], rid: 4 });
  await settle();
  const response = posted.find((message) => message.t === "res" && message.rid === 4);
  check("a non-function `activate` is ignored rather than called",
    response?.ok === true && !posted.some((m) => m.t === "log" && m.level === "error"), posted);
}

// ---------------------------------------------------------------------------
section("The prelude itself: one source of truth");

{
  // Guard against the shim drifting: the three bindings must be the only
  // `self.*` definitions in the file.
  const definitions = [...bootSource.matchAll(/Object\.defineProperty\(self,\s*"([^"]+)"/g)].map((match) => match[1]).sort();
  check("worker-boot.js defines exactly exports/module/qing/require on self",
    JSON.stringify(definitions) === JSON.stringify(["exports", "module", "qing", "require"]), definitions);
  check("worker-boot.js never mentions window/document/__TAURI_INTERNALS__",
    !/\b(window|document|__TAURI_INTERNALS__|__TAURI__)\b/.test(bootSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
