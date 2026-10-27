#!/usr/bin/env node
/**
 * Pack an example plugin into a `.qnp`.
 *
 * A `.qnp` is a plain zip whose *root* holds the manifest — no enclosing folder.
 * That is the one structural rule the host enforces at install time, so the
 * packer copies the package files into a scratch directory and zips its
 * contents rather than zipping the plugin folder itself.
 *
 * Two manifests are understood, matching what the host reads: `package.json`
 * (with a `main` entry) wins, `plugin.json` is the fallback. Whichever one is
 * used has to end up inside the archive — it *is* the package description —
 * while the other one is skipped, so a package never ships a second,
 * contradictory manifest.
 *
 * Nested entries are supported: the TypeScript example builds to
 * `dist/extension.js`, and `main` points there.
 *
 * Windows only, like the app: it shells out to `Compress-Archive`, which keeps
 * this script dependency-free (a zip writer would otherwise be another npm
 * package to audit for something that runs once per release).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const examplesRoot = import.meta.dirname;
const pluginRoot = process.cwd();

/** Source, build bookkeeping and vcs state: never part of the package. */
const SKIP_NAMES = new Set([
  "node_modules",
  ".git",
  "src",
  "package-lock.json",
  "README.md",
  "tsconfig.json",
  "build.mjs",
]);

/** `package.json` describes a plugin only when it declares an entry point. */
function isPluginPackageJson(path) {
  if (!existsSync(path)) return false;
  try {
    const document = JSON.parse(readFileSync(path, "utf8"));
    return typeof document.main === "string" && document.main.trim().length > 0;
  } catch {
    return false;
  }
}

const packagePath = join(pluginRoot, "package.json");
const legacyPath = join(pluginRoot, "plugin.json");
const manifestPath = isPluginPackageJson(packagePath)
  ? packagePath
  : existsSync(legacyPath)
    ? legacyPath
    : null;

if (!manifestPath) {
  console.error(`No package.json (with a main entry) or plugin.json in ${pluginRoot}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

/** Same composition rule as the host: `publisher.name`, or `name` alone. */
const id =
  typeof manifest.id === "string" && manifest.id.length > 0
    ? manifest.id
    : typeof manifest.publisher === "string" && manifest.publisher.length > 0
      ? `${manifest.publisher}.${manifest.name}`
      : manifest.name;

if (!id) {
  console.error(`${basename(manifestPath)} has no id, publisher+name or name`);
  process.exit(1);
}

// `./dist/extension.js` and `dist/extension.js` are the same entry.
const entry = String(manifest.main ?? "").replace(/^\.\//, "");
if (!entry || !existsSync(join(pluginRoot, entry))) {
  console.error(`Missing build output "${entry}" — run the build step first.`);
  process.exit(1);
}

// The manifest that is *not* used must not be packed: two manifests in one
// package means the archive's meaning depends on which one the host reads first.
const skip = new Set(SKIP_NAMES);
if (manifestPath === legacyPath) skip.add("package.json");
else skip.add("plugin.json");

const staging = mkdtempSync(join(tmpdir(), "qing-plugin-"));
try {
  cpSync(pluginRoot, staging, {
    recursive: true,
    filter: (source) => {
      if (source === pluginRoot) return true;
      const name = basename(source);
      if (skip.has(name)) return false;
      if (name.endsWith(".qnp") || name.endsWith(".zip")) return false;
      return true;
    },
  });

  const target = join(examplesRoot, `${id}-${manifest.version}.qnp`);
  // `Compress-Archive` refuses any extension but `.zip`, so it writes a zip
  // that is renamed afterwards. A `.qnp` *is* a zip; the extension only exists
  // so a double-click opens the app instead of the archive tool.
  const zipPath = `${target}.zip`;
  rmSync(target, { force: true });
  rmSync(zipPath, { force: true });
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path '${join(staging, "*")}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: "inherit" },
  );
  renameSync(zipPath, target);
  console.log(`Packed ${target} (manifest: ${basename(manifestPath)}, entry: ${entry})`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
