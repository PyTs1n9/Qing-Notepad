#!/usr/bin/env node
/**
 * Bundle `src/extension.ts` into the single file the host loads.
 *
 * Two constraints come from the host, not from taste:
 *
 * 1. **One file.** The host creates the plugin worker from a blob URL, and a
 *    relative `import` cannot be resolved from a blob URL.
 * 2. **No top-level `import` / `export`.** The host wraps the built file in
 *    `self.__qing_main = async function () { ... }`, so an ES module export
 *    statement at the top level is a syntax error. The check at the bottom of
 *    this file fails the build if that ever stops being true.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

const root = import.meta.dirname;
const outfile = join(root, "dist", "extension.js");

await build({
  entryPoints: [join(root, "src", "extension.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  charset: "utf8",
  legalComments: "none",
  logLevel: "info",
});

const output = readFileSync(outfile, "utf8");
const offending = output
  .split("\n")
  .findIndex((line) => /^\s*(import|export)\b/.test(line));
if (offending >= 0) {
  console.error(
    `dist/extension.js has a top-level import/export at line ${offending + 1}: ` +
      "the host wraps this file in a function and cannot parse it.",
  );
  process.exit(1);
}

console.log(`Built ${outfile}`);
