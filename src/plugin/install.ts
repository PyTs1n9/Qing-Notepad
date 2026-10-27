/**
 * Install / update orchestration: download → verify → stage → authorise → commit.
 *
 * The split matters. Rust stages (phase 1) and commits (phase 2); the frontend
 * owns the two checks Rust cannot make well:
 *
 * - `engines.host` is a semver *range*, and the only real parser in this build
 *   is the `semver` package in `version.ts` (see `plugin_manifest.rs` for why
 *   this is not duplicated in Rust);
 * - command ids have to be unique across every installed plugin, which is
 *   knowledge the host keeps, not the installer.
 *
 * A failed or cancelled preparation always discards its staging directory, so a
 * rejected package cannot leave a half-installed version behind.
 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { toast } from "@/stores/toastStore";
import { t, tWithParams } from "@/utils/i18n";
import { BUILTIN_COMMAND_IDS } from "./commands";
import { deactivatePlugin } from "./headless";
import { usePluginStore } from "./store";
import {
  PLUGIN_API_VERSION,
  PluginError,
  addedPermissions,
  expandPermissions,
  manifestCommands,
  manifestPermissions,
  manifestViews,
  toPluginError,
  type InstallResult,
  type InstalledPlugin,
  type PluginIndexEntry,
  type PluginManifest,
  type PluginPermission,
} from "./types";
import { isHostCompatible, isNewerVersion } from "./version";

export interface PreparedInstall {
  stagingId: string;
  manifest: PluginManifest;
  sha256: string | null;
  source: "index" | "file";
  indexEntry: PluginIndexEntry | null;
  /** Permissions that need a human decision right now. */
  added: PluginPermission[];
  /** The install this one replaces, when it is an update. */
  previous: InstalledPlugin | null;
  isUpdate: boolean;
}

function currentInstalled(): InstalledPlugin[] {
  return usePluginStore.getState().installed;
}

async function discardStaging(stagingId: string): Promise<void> {
  try {
    await invoke("plugin_discard_staging", { stagingId });
  } catch (error) {
    // Startup clears `.staging/` too, so this is best effort by design.
    console.warn("Failed to discard plugin staging:", error);
  }
}

/** Mirrors `is_grantable` on the Rust side: a write permission implies read. */
function isDeclared(permission: string, declared: readonly string[]): boolean {
  if (declared.includes(permission)) return true;
  if (permission === "notes:read") return declared.includes("notes:write");
  if (permission === "todo:read") return declared.includes("todo:write");
  return false;
}

function commandConflicts(manifest: PluginManifest, installed: InstalledPlugin[]): string[] {
  const taken = new Set<string>(BUILTIN_COMMAND_IDS);
  for (const plugin of installed) {
    if (plugin.id === manifest.id) continue;
    for (const command of manifestCommands(plugin.manifest)) taken.add(command.id);
  }
  return manifestCommands(manifest)
    .map((command) => command.id)
    .filter((id) => taken.has(id));
}

/**
 * A view id is a global key — the sidebar section, `views.refresh(viewId)` and
 * `onView:<id>` activation all name it — so two packages may not contribute the
 * same one. The manifest convention (`<plugin id>.<name>`) makes collisions
 * unlikely on purpose; this is the check that makes it impossible to ship one.
 */
function viewConflicts(manifest: PluginManifest, installed: InstalledPlugin[]): string[] {
  const taken = new Set<string>();
  for (const plugin of installed) {
    if (plugin.id === manifest.id) continue;
    for (const view of manifestViews(plugin.manifest)) taken.add(view.id);
  }
  return manifestViews(manifest)
    .map((view) => view.id)
    .filter((id) => taken.has(id));
}

function assertCompatible(manifest: PluginManifest): void {
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginError(
      "E_API_VERSION",
      `apiVersion ${manifest.apiVersion} is not supported by this build`,
    );
  }
  if (!isHostCompatible(manifest.engines.host)) {
    throw new PluginError(
      "E_HOST_VERSION",
      `the plugin needs host ${manifest.engines.host}`,
    );
  }
  const conflicts = commandConflicts(manifest, currentInstalled());
  if (conflicts.length > 0) {
    throw new PluginError(
      "E_COMMAND_CONFLICT",
      `command id already taken: ${conflicts.join(", ")}`,
    );
  }
  const viewTaken = viewConflicts(manifest, currentInstalled());
  if (viewTaken.length > 0) {
    // `E_MANIFEST_INVALID` rather than a code of its own: the manifest is only
    // wrong in the context of what is already installed, and the message names
    // the ids so the author can rename one.
    throw new PluginError(
      "E_MANIFEST_INVALID",
      `view id already contributed by another plugin: ${viewTaken.join(", ")}`,
    );
  }
}

async function finalize(
  result: InstallResult,
  source: "index" | "file",
  indexEntry: PluginIndexEntry | null,
): Promise<PreparedInstall> {
  const stagingId = result.stagingId;
  if (!stagingId) {
    throw new PluginError("E_INTERNAL", "the installer did not return a staging id");
  }
  try {
    const manifest = result.manifest;
    assertCompatible(manifest);

    const previous = currentInstalled().find((plugin) => plugin.id === manifest.id) ?? null;
    const isUpdate = previous !== null && isNewerVersion(manifest.version, previous.version);
    const added = previous
      ? addedPermissions(previous.grantedPermissions, manifest.permissions ?? [])
      : manifestPermissions(manifest);

    return {
      stagingId,
      manifest,
      sha256: result.sha256,
      source,
      indexEntry,
      added,
      previous,
      isUpdate,
    };
  } catch (error) {
    await discardStaging(stagingId);
    throw toPluginError(error);
  }
}

/**
 * Install from a package the user picked: a `.qnp`, a `.zip`, or a folder.
 * Not index-sourced: there is no `sha256` to check against, and Rust refuses a
 * digest for a directory rather than pretending to verify one.
 */
export async function prepareInstallFromFile(path: string): Promise<PreparedInstall> {
  const result = await invoke<InstallResult>("plugin_install", {
    request: { archivePath: path, dryRun: true, source: "file" },
  });
  return finalize(result, "file", null);
}

/**
 * The index lists permissions too, and that is what the market shows before
 * anyone clicks "install" — the grant prompt, meanwhile, shows the package's own
 * manifest. When the two disagree one of them is lying to the user, and the one
 * they read while browsing is the index. So an install that would land a
 * different grant than the one advertised is refused, before the prompt opens.
 *
 * Both sides go through `expandPermissions` first: `notes:write` implies
 * `notes:read` (same for todo), so a package declaring `["notes:write"]` is not
 * a mismatch against an index listing `["notes:write"]` just because the
 * expanded grant also contains the read code.
 *
 * An empty list means "the index says nothing about permissions" and skips the
 * check — entries written before the field existed must keep installing.
 */
function assertIndexPermissionsAgree(
  entry: PluginIndexEntry,
  manifest: PluginManifest,
): void {
  const advertised = entry.permissions ?? [];
  if (advertised.length === 0) return;
  const declared = expandPermissions(manifest.permissions ?? []);
  const shown = expandPermissions(advertised);
  const declaredSet = new Set(declared);
  const shownSet = new Set(shown);
  const unlisted = declared.filter((permission) => !shownSet.has(permission));
  const undeclared = shown.filter((permission) => !declaredSet.has(permission));
  if (unlisted.length === 0 && undeclared.length === 0) return;
  throw new PluginError(
    "E_INDEX_PERMISSION_MISMATCH",
    `the index lists [${shown.sort().join(", ")}] but the package declares [${declared
      .sort()
      .join(", ")}]`,
  );
}

/**
 * Install from an index entry. `sha256` is mandatory here — it is the only
 * integrity signal between "the index says X" and "the bytes are X".
 */
export async function prepareInstallFromIndex(entry: PluginIndexEntry): Promise<PreparedInstall> {
  if (!entry.sha256) {
    throw new PluginError("E_SHA256_MISSING", "the index entry has no sha256");
  }
  const result = await invoke<InstallResult>("plugin_install", {
    request: {
      archiveUrl: entry.download,
      expectedSha256: entry.sha256,
      dryRun: true,
      source: "index",
    },
  });
  const prepared = await finalize(result, "index", entry);
  try {
    if (prepared.manifest.id !== entry.id) {
      throw new PluginError("E_MANIFEST_MISMATCH", "the package id does not match the index");
    }
    if (prepared.manifest.version !== entry.version) {
      throw new PluginError(
        "E_MANIFEST_MISMATCH",
        "the package version does not match the index",
      );
    }
    assertIndexPermissionsAgree(entry, prepared.manifest);
  } catch (error) {
    await discardStaging(prepared.stagingId);
    throw toPluginError(error);
  }
  return prepared;
}

/**
 * Promote a prepared install. `approved` must contain the permissions the user
 * just agreed to; anything else keeps the existing grant (an update that adds
 * nothing keeps the old one instead of silently widening it).
 */
export async function commitPreparedInstall(
  prepared: PreparedInstall,
  approved: readonly string[] = [],
): Promise<InstalledPlugin> {
  const declared = prepared.manifest.permissions ?? [];
  const granted = prepared.previous
    ? expandPermissions([
        ...prepared.previous.grantedPermissions.filter((permission) =>
          isDeclared(permission, declared),
        ),
        ...approved,
      ])
    : expandPermissions(declared);

  const result = await invoke<InstallResult>("plugin_install", {
    request: {
      stagingId: prepared.stagingId,
      dryRun: false,
      grantedPermissions: granted,
      source: prepared.source,
    },
  });
  if (!result.record) {
    throw new PluginError("E_INTERNAL", "the installer did not return an install record");
  }
  usePluginStore.getState().replaceInstalled(result.record);
  // The worker was started from the previous version's main.js; keep it alive
  // and it would keep running the old code after an update or a rollback.
  deactivatePlugin(result.record.id);
  return result.record;
}

export async function discardPreparedInstall(prepared: PreparedInstall): Promise<void> {
  await discardStaging(prepared.stagingId);
}

// ---------------------------------------------------------------------------
// Prompt-driven flow
//
// The prompt itself lives in the store because the sidebar (which starts an
// install) and the detail pane (which starts an update) are rendered in
// different subtrees of the shell — they cannot share a hook instance.
// ---------------------------------------------------------------------------

let pending: PreparedInstall | null = null;

function lang() {
  return useSettingsStore.getState().lang;
}

/**
 * Turn a Rust error code into the sentence the user actually sees.
 *
 * Every code Rust can produce while *reading a package* is listed here, because
 * the alternative is a mixed-language error list: before this, a 21 MB package
 * said "安装包超过 20 MB 上限" and a 2001-file package said
 * `E_TOO_MANY_FILES: package has more than 2000 files` in the same dialog.
 * Codes that carry a detail (`{detail}` in the copy) keep it — it is where
 * "main `dist/x.js` is not in the package" actually says which file.
 */
export function describeInstallError(error: unknown): string {
  const pluginError = toPluginError(error);
  const current = lang();
  // Rust writes `CODE: detail`; `toPluginError` already split the code off, and
  // a message-less failure falls back to the code so nothing is ever blanked.
  const detail = pluginError.message || pluginError.code;
  switch (pluginError.code) {
    case "E_HOST_VERSION":
      return t(current, "pluginHostIncompatible");
    case "E_API_VERSION":
      return t(current, "pluginApiIncompatible");
    case "E_COMMAND_CONFLICT":
      return tWithParams(current, "pluginCommandConflict", { ids: pluginError.message });
    case "E_NATIVE_MODULE":
      return t(current, "pluginNativeModule");
    case "E_TOO_LARGE":
      return t(current, "pluginPackageTooLarge");
    case "E_TOO_MANY_FILES":
      return t(current, "pluginTooManyFiles");
    case "E_MANIFEST_MISSING":
      // The detail here is a sentence about the two file names; the copy says
      // the same thing in one line, so it is not repeated.
      return t(current, "pluginManifestMissing");
    case "E_MANIFEST_INVALID":
      return tWithParams(current, "pluginManifestInvalid", { detail });
    case "E_MISSING_MAIN":
      return tWithParams(current, "pluginMissingMain", { detail });
    case "E_PERMISSION_UNKNOWN":
      return tWithParams(current, "pluginPermissionUnknown", { detail });
    case "E_INDEX_PERMISSION_MISMATCH":
      return tWithParams(current, "pluginIndexPermissionMismatch", { detail });
    case "E_HOST_RESTARTED":
      return t(current, "pluginHostRestarted");
    case "E_BUSY":
      return t(current, "pluginHostBusy");
    case "E_ZIP_SLIP":
      return t(current, "pluginEntryNameInvalid");
    default:
      return detail;
  }
}

function reportFailure(error: unknown): void {
  const message = describeInstallError(error);
  // A toast disappears in three seconds; an install that refuses a package needs
  // to stay readable while the user goes back to look at the file.
  usePluginStore.getState().setLastError(message);
  toast(tWithParams(lang(), "pluginInstallFailed", { message }), "danger");
}

async function begin(prepare: () => Promise<PreparedInstall>): Promise<void> {
  const store = usePluginStore.getState();
  store.setLastError(null);
  store.setInstallBusy(true);
  try {
    const prepared = await prepare();
    pending = prepared;
    if (prepared.isUpdate && prepared.added.length === 0) {
      // Nothing new to approve: the existing grant carries over unchanged.
      await finishPending([]);
      return;
    }
    store.setInstallPrompt({
      manifest: prepared.manifest,
      permissions: prepared.isUpdate ? prepared.added : manifestPermissions(prepared.manifest),
      added: prepared.added,
      mode: prepared.isUpdate ? "update" : "install",
    });
  } catch (error) {
    reportFailure(error);
  } finally {
    usePluginStore.getState().setInstallBusy(false);
  }
}

async function finishPending(approved: readonly string[]): Promise<void> {
  if (!pending) return;
  const prepared = pending;
  pending = null;
  const record = await commitPreparedInstall(prepared, approved);
  const current = lang();
  toast(
    tWithParams(current, prepared.isUpdate ? "pluginUpdated" : "pluginInstalled", {
      name: prepared.manifest.name || record.id,
    }),
    "success",
  );
  usePluginStore.getState().setInstallPrompt(null);
  // Jump to the new plugin so "installed" is visibly true, not just a toast.
  usePluginStore.getState().select(record.id);
}

/**
 * The dialog plugin returns a string for a single selection, but has returned
 * an array in that same call before. Accepting both costs one line and removes
 * a silent "nothing happened".
 */
function firstSelectedPath(selection: string | string[] | null): string | null {
  if (typeof selection === "string") return selection;
  if (Array.isArray(selection)) return selection[0] ?? null;
  return null;
}

/**
 * Pick a package file (`.qnp` or `.zip`) and start the install; the permission
 * prompt follows.
 *
 * `selectedPath` skips the OS picker. Nothing in the UI passes it yet — it
 * exists so the acceptance harness can drive the *same* code path as a click
 * (a native dialog cannot be scripted), and it is what a future "drop a package
 * on the window" handler will call.
 */
export async function beginInstallFromFile(selectedPath?: string): Promise<void> {
  let path = selectedPath ?? null;
  if (!path) {
    const selection = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Qing Plugin", extensions: ["qnp", "zip"] }],
    });
    path = firstSelectedPath(selection);
  }
  if (!path) return;
  await begin(() => prepareInstallFromFile(path));
}

/**
 * Pick an unpacked package directory and start the install.
 *
 * This is the same three-step install as the file path — stage, authorise,
 * commit — with the picker swapped. Skipping the prompt here would be the
 * obvious shortcut and the one thing that must not happen: a folder is exactly
 * as untrusted as an archive, so it goes through `plugin_install` with
 * `dryRun: true` and the user sees the same permission list.
 *
 * The folder is usually a working copy, so Rust skips `node_modules/` and
 * `.git/` while copying and applies the same 5 MB / 20 MB budget an archive
 * gets.
 */
export async function beginInstallFromFolder(selectedPath?: string): Promise<void> {
  let path = selectedPath ?? null;
  if (!path) {
    const selection = await open({ multiple: false, directory: true });
    path = firstSelectedPath(selection);
  }
  if (!path) return;
  await begin(() => prepareInstallFromFile(path));
}

export async function beginInstallFromIndex(entry: PluginIndexEntry): Promise<void> {
  await begin(() => prepareInstallFromIndex(entry));
}

export async function confirmPendingInstall(): Promise<void> {
  const store = usePluginStore.getState();
  const approved = store.installPrompt?.added ?? [];
  store.setInstallBusy(true);
  try {
    await finishPending(approved);
  } catch (error) {
    reportFailure(error);
  } finally {
    usePluginStore.getState().setInstallBusy(false);
  }
}

export async function cancelPendingInstall(): Promise<void> {
  const prepared = pending;
  pending = null;
  usePluginStore.getState().setInstallPrompt(null);
  if (prepared) await discardStaging(prepared.stagingId);
}
