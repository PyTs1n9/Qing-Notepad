/**
 * Plugin index: the browsable list of installable plugins.
 *
 * The request itself runs in Rust (`plugin_fetch_index`) for the same reason
 * the update checker does: a webview `fetch` would force two GitHub hosts into
 * the main window's `connect-src` for a call that happens at most once a day.
 * Rust also owns the 24 h cache, so a second window or a reload cannot race it.
 */
import { invoke } from "@tauri-apps/api/core";
import type { IndexFetchResult, PluginIndexEntry } from "./types";
import { isPluginPermission, toPluginError } from "./types";

type RawIndexEntry = Omit<Partial<PluginIndexEntry>, "permissions"> & { permissions?: unknown };

function normalizeEntry(raw: RawIndexEntry): PluginIndexEntry | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.download !== "string" || !raw.download) return null;
  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions.filter((value): value is string => typeof value === "string" && isPluginPermission(value))
    : [];
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
    description: typeof raw.description === "string" ? raw.description : "",
    author: typeof raw.author === "string" ? raw.author : null,
    repo: typeof raw.repo === "string" ? raw.repo : null,
    repoGitee: typeof raw.repoGitee === "string" ? raw.repoGitee : null,
    version: typeof raw.version === "string" ? raw.version : "",
    apiVersion: typeof raw.apiVersion === "number" ? raw.apiVersion : null,
    engines: raw.engines && typeof raw.engines === "object" ? raw.engines : null,
    download: raw.download,
    sha256: typeof raw.sha256 === "string" ? raw.sha256 : null,
    permissions,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

export async function fetchPluginIndex(force = false): Promise<IndexFetchResult> {
  try {
    const result = await invoke<IndexFetchResult>("plugin_fetch_index", { force });
    const plugins = Array.isArray(result.plugins)
      ? result.plugins
          .map((entry) => normalizeEntry(entry as RawIndexEntry))
          .filter((entry): entry is PluginIndexEntry => entry !== null)
      : [];
    return { ...result, plugins };
  } catch (error) {
    // The command only fails on a broken data directory; a missing index
    // repository is reported as `status: "missing"` instead.
    const pluginError = toPluginError(error);
    console.warn("Plugin index fetch failed:", pluginError.message);
    return {
      status: "missing",
      plugins: [],
      source: "none",
      fetchedAt: null,
      updatedAt: null,
    };
  }
}
