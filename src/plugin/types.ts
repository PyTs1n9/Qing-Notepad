/**
 * Shared plugin types.
 *
 * These mirror the Rust side in `src-tauri/src/plugin.rs` and
 * `plugin_manifest.rs`; `camelCase` on both ends, and `Option<T>` comes across
 * as `null` rather than `undefined`, so optional fields are typed `| null`.
 */
import type { TranslationKeys } from "@/utils/i18n";

/** The API contract this build implements (see `decisions-plugin-system.md` D5). */
export const PLUGIN_API_VERSION = 1;

/** The complete L1 permission set. Anything else is rejected at install time. */
export const PLUGIN_PERMISSIONS = [
  "storage",
  "notes:read",
  "notes:write",
  "todo:read",
  "todo:write",
  "clipboard:read",
  "clipboard:write",
  "notify",
  // P1a editor surface. Three codes instead of one because they are three
  // different decisions for the user: read the document they are looking at,
  // change it, or paint marks on it. `editor:read` is deliberately *not*
  // implied by `editor:write` (unlike `notes:write` → `notes:read`): replacing
  // a range does not let a plugin see anything, so "can rewrite my note" is not
  // a reason to hand it the whole text.
  "editor:read",
  "editor:write",
  "editor:decorate",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** i18n key holding the plain-language explanation of each permission. */
export const PERMISSION_LABEL_KEYS: Record<PluginPermission, keyof TranslationKeys> = {
  storage: "pluginPermStorage",
  "notes:read": "pluginPermNotesRead",
  "notes:write": "pluginPermNotesWrite",
  "todo:read": "pluginPermTodoRead",
  "todo:write": "pluginPermTodoWrite",
  "clipboard:read": "pluginPermClipboardRead",
  "clipboard:write": "pluginPermClipboardWrite",
  notify: "pluginPermNotify",
  "editor:read": "pluginPermEditorRead",
  "editor:write": "pluginPermEditorWrite",
  "editor:decorate": "pluginPermEditorDecorate",
};

export function isPluginPermission(value: string): value is PluginPermission {
  return (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

export interface PluginAuthor {
  name: string;
  url?: string | null;
}

export interface PluginCommandContribution {
  id: string;
  title: string;
  category?: string | null;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  engines: { host: string };
  description?: string | null;
  /** `plugin.json` allows a bare string; the index uses one too. */
  author?: PluginAuthor | string | null;
  license?: string | null;
  repository?: string | null;
  main: string;
  activationEvents?: string[];
  permissions?: string[];
  contributes?: { commands?: PluginCommandContribution[] | null } | null;
}

export interface InstalledPlugin {
  id: string;
  version: string;
  previousVersion: string | null;
  enabled: boolean;
  grantedPermissions: string[];
  installedAt: string;
  updatedAt: string;
  source: string;
  manifest: PluginManifest | null;
}

export interface PluginIndexEntry {
  id: string;
  name: string;
  description: string;
  author: string | null;
  repo: string | null;
  version: string;
  apiVersion: number | null;
  engines: { host: string } | null;
  download: string;
  sha256: string | null;
  permissions: string[];
  updatedAt: string | null;
}

export type IndexStatus = "ok" | "cached" | "missing";

export interface IndexFetchResult {
  status: IndexStatus;
  plugins: PluginIndexEntry[];
  source: string;
  fetchedAt: string | null;
  updatedAt: string | null;
}

export interface InstallResult {
  dryRun: boolean;
  stagingId: string | null;
  manifest: PluginManifest;
  sha256: string | null;
  record: InstalledPlugin | null;
}

/**
 * What the permission prompt is asking about. Kept in shared types rather than
 * in the component so the install orchestrator can set it without importing UI.
 */
export interface PluginInstallPrompt {
  manifest: PluginManifest;
  /** The permissions the dialog lists. */
  permissions: string[];
  /** The subset that is new relative to an existing grant. */
  added: string[];
  mode: "install" | "update";
}

/** Error codes the bridge and the install chain share. */
export type PluginErrorCode =
  | "E_PERMISSION_DENIED"
  | "E_TIMEOUT"
  | "E_INTERNAL"
  | "E_NOT_INSTALLED"
  | "E_DISABLED"
  | "E_API_VERSION"
  | "E_HOST_VERSION"
  | "E_COMMAND_CONFLICT"
  | "E_NO_HANDLER"
  | "E_QUOTA_EXCEEDED"
  /** P1a: no note is open, so there is no document to act on. */
  | "E_NO_EDITOR"
  /** P1a: a document range that is not inside the current text. */
  | "E_RANGE_INVALID"
  | string;

export class PluginError extends Error {
  readonly code: PluginErrorCode;

  constructor(code: PluginErrorCode, message: string) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

/**
 * Rust prefixes every failure with `CODE: detail`. Splitting here keeps callers
 * from string-matching prose, and a code-less message still surfaces verbatim.
 */
export function toPluginError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/);
  if (match) return new PluginError(match[1], match[2] || match[1]);
  return new PluginError("E_INTERNAL", raw);
}

export function authorName(manifest: PluginManifest | null | undefined): string {
  if (!manifest?.author) return "";
  return typeof manifest.author === "string" ? manifest.author : manifest.author.name ?? "";
}

export function manifestCommands(manifest: PluginManifest | null | undefined): PluginCommandContribution[] {
  return manifest?.contributes?.commands ?? [];
}

export function manifestPermissions(manifest: PluginManifest | null | undefined): PluginPermission[] {
  return (manifest?.permissions ?? []).filter(isPluginPermission);
}

/**
 * `notes:write` implies `notes:read` (and the same for todo). The grant list is
 * expanded once when it is recorded, but a manifest can still be read straight
 * from disk, so every consumer goes through this.
 */
export function expandPermissions(permissions: readonly string[]): PluginPermission[] {
  const out = new Set<PluginPermission>();
  for (const permission of permissions) {
    if (!isPluginPermission(permission)) continue;
    out.add(permission);
    if (permission === "notes:write") out.add("notes:read");
    if (permission === "todo:write") out.add("todo:read");
  }
  return [...out];
}

export function hasPermission(granted: readonly string[], required: PluginPermission): boolean {
  if (granted.includes(required)) return true;
  if (required === "notes:read") return granted.includes("notes:write");
  if (required === "todo:read") return granted.includes("todo:write");
  return false;
}

/** Permissions the new version adds on top of what the user already granted. */
export function addedPermissions(
  granted: readonly string[],
  next: readonly string[],
): PluginPermission[] {
  return expandPermissions(next).filter((permission) => !hasPermission(granted, permission));
}

/**
 * Without `activationEvents` a plugin activates when any of its commands runs —
 * the only trigger that exists in L1 besides an explicit `onStartup`.
 */
export function activationEventsFor(manifest: PluginManifest): string[] {
  const declared = manifest.activationEvents ?? [];
  if (declared.length > 0) return declared;
  return manifestCommands(manifest).map((command) => `onCommand:${command.id}`);
}

export function activatesOnStartup(manifest: PluginManifest): boolean {
  return activationEventsFor(manifest).includes("onStartup");
}
