#!/usr/bin/env node
/**
 * Pack an example plugin into a `.qnp`.
 *
 * A `.qnp` is a plain zip whose *root* holds `plugin.json` — no enclosing
 * folder. That is the one structural rule the host enforces at install time, so
 * the packer copies the root files into a scratch directory and zips its
 * contents rather than zipping the plugin folder itself.
 *
 * Windows only, like the app: it shells out to `Compress-Archive`, which keeps
 * this script dependency-free (a zip writer would otherwise be another npm
 * package to audit for something that runs once per release).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const examplesRoot = import.meta.dirname;
const pluginRoot = process.cwd();

const manifestPath = join(pluginRoot, "plugin.json");
if (!existsSync(manifestPath)) {
  console.error(`No plugin.json in ${pluginRoot}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entry = manifest.main;
if (!entry || !existsSync(join(pluginRoot, entry))) {
  console.error(`Missing build output "${entry}" — run the build step first.`);
  process.exit(1);
}

// Everything at the package root except the sources and this script's own
// outputs. A manifest may point at additional assets, so the folder is scanned
// rather than a fixed file list being copied.
const SKIP = new Set(["src", "node_modules", "package.json", "package-lock.json", "README.md", ".qnp"]);
const files = readdirSync(pluginRoot, { withFileTypes: true })
  .filter((item) => item.isFile() && !item.name.endsWith(".qnp"))
  .map((item) => item.name)
  .filter((name) => !SKIP.has(name));

const staging = mkdtempSync(join(tmpdir(), "qing-plugin-"));
try {
  for (const name of files) {
    copyFileSync(join(pluginRoot, name), join(staging, name));
  }

  const target = join(examplesRoot, `${manifest.id}-${manifest.version}.qnp`);
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
  console.log(`Packed ${target}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
