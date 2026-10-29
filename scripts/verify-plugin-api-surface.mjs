#!/usr/bin/env node
/**
 * The plugin API surface exists in two places, and they must agree.
 *
 * `src/plugin/worker-boot.js` is the object a plugin actually calls (`qing.x.y`);
 * `src/plugin/bridge.ts` is the host side that answers it. Neither imports the
 * other — one is a raw string injected into a blob worker, the other is main
 * thread code — so a method added to one and forgotten in the other produces the
 * worst kind of failure: the host has the implementation, the plugin gets
 * `undefined is not a function`, and the transport flattens it to `E_INTERNAL`
 * with no hint of what is missing.
 *
 * That is exactly how `notes.tree()` and the whole `canvas` namespace shipped
 * broken the first time. This script is the check that would have caught it.
 *
 * Zero dependencies, so CI can run it.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
let failures = 0;
let checks = 0;

function fail(label, detail) {
  failures += 1;
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

function pass(label) {
  checks += 1;
  console.log(`  ok   ${label}`);
}

/** `{ "notes.get": true, ... }` from the worker-side object literal. */
function readExposedSurface() {
  const source = readFileSync(join(root, "src", "plugin", "worker-boot.js"), "utf8");
  const exposed = new Set();
  let namespace = null;
  for (const line of source.split("\n")) {
    const open = /^ {4}([a-zA-Z]+): \{/.exec(line);
    if (open) {
      namespace = open[1];
      continue;
    }
    if (/^ {4}\}/.test(line)) {
      namespace = null;
      continue;
    }
    const method = /^ {6}([a-zA-Z]+): function/.exec(line);
    if (method && namespace) exposed.add(`${namespace}.${method[1]}`);
  }
  return exposed;
}

/** `{ "notes.get": "notes:read", ... }` from the bridge's permission table. */
function readBridgeSurface() {
  const source = readFileSync(join(root, "src", "plugin", "bridge.ts"), "utf8");
  const start = source.indexOf("const REQUIREMENTS");
  if (start < 0) throw new Error("REQUIREMENTS table not found in bridge.ts");
  const end = source.indexOf("\n};", start);
  const block = source.slice(start, end);
  const surface = new Map();
  let namespace = null;

  for (const raw of block.split("\n")) {
    const line = raw.trimEnd();
    const inline = /^ {2}([a-zA-Z]+): \{ (.+) \},?$/.exec(line);
    if (inline) {
      for (const entry of inline[2].split(",")) {
        const method = /^\s*([a-zA-Z]+):/.exec(entry);
        if (method) surface.set(`${inline[1]}.${method[1]}`, inline[1]);
      }
      continue;
    }
    const open = /^ {2}([a-zA-Z]+): \{$/.exec(line);
    if (open) {
      namespace = open[1];
      continue;
    }
    if (/^ {2}\},?$/.test(line)) {
      namespace = null;
      continue;
    }
    const method = /^ {4}([a-zA-Z]+):/.exec(line);
    if (method && namespace) surface.set(`${namespace}.${method[1]}`, namespace);
  }
  return surface;
}

/**
 * `qing.<namespace>.<method>(` occurrences in a bundled plugin. esbuild runs
 * without minification here, so the chain survives intact.
 */
function readPluginCalls(bundlePath) {
  const source = readFileSync(bundlePath, "utf8");
  const calls = new Set();
  const pattern = /\bqing\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g;
  let match = pattern.exec(source);
  while (match) {
    calls.add(`${match[1]}.${match[2]}`);
    match = pattern.exec(source);
  }
  return calls;
}

// ---------------------------------------------------------------------------

const exposed = readExposedSurface();
const bridged = readBridgeSurface();

console.log(`1. worker-boot 暴露 ${exposed.size} 个方法，bridge 声明 ${bridged.size} 个`);

/** Every method the bridge gates must exist on the object plugins call. */
{
  const missing = [...bridged.keys()].filter((key) => !exposed.has(key));
  if (missing.length === 0) {
    pass("bridge 声明的每个方法都在 worker-boot 里");
  } else {
    fail(
      "bridge 有、worker-boot 没有 —— 插件调用会得到 undefined",
      missing.join(", "),
    );
  }
}

/** And the reverse: exposing something the bridge never answers is a dead end. */
{
  // These two never cross the transport — they register locally inside the
  // worker, and the host reaches the result through its own message types.
  const localOnly = new Set(["views.registerTreeDataProvider", "commands.register"]);
  const orphaned = [...exposed].filter((key) => !bridged.has(key) && !localOnly.has(key));
  if (orphaned.length === 0) {
    pass("worker-boot 没有悬空方法（本地注册项已排除）");
  } else {
    fail("worker-boot 有、bridge 没有 —— 调用必然 E_INTERNAL", orphaned.join(", "));
  }
}

console.log("2. 每个示例插件实际调用的方法都已暴露");

const examplesDir = join(root, "examples");
const bundles = readdirSync(examplesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(examplesDir, entry.name, "dist", "extension.js"))
  .filter((path) => existsSync(path));

if (bundles.length === 0) {
  fail("没有找到任何 dist/extension.js，先构建示例插件");
} else {
  for (const bundle of bundles) {
    const name = bundle.split(/[\\/]/).at(-3);
    const calls = readPluginCalls(bundle);
    const missing = [...calls].filter((key) => !exposed.has(key));
    if (missing.length === 0) {
      pass(`${name}（${calls.size} 个调用）`);
    } else {
      fail(`${name} 调用了未暴露的方法`, missing.join(", "));
    }
  }
}

console.log(`\n${checks} 项断言，${failures} 项失败`);
if (failures > 0) process.exit(1);
