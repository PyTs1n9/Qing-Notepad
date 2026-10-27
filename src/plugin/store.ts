/**
 * Plugin store: the installed list, the index, and the per-plugin actions the
 * management UI drives.
 *
 * Anything that touches a worker goes through `headless.ts`; anything that
 * touches a file goes through a Rust command. This module is only the shared
 * state between the sidebar, the detail pane and the palette.
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  addedPermissions,
  toPluginError,
  type IndexStatus,
  type InstalledPlugin,
  type PluginIndexEntry,
  type PluginInstallPrompt,
} from "./types";
import { fetchPluginIndex } from "./index-fetch";
import { deactivateAllPlugins, deactivatePlugin, onPluginAutoDisabled, setRunnerPermissions } from "./headless";
import { isNewerVersion } from "./version";

interface PluginStoreState {
  hydrated: boolean;
  installed: InstalledPlugin[];
  index: PluginIndexEntry[];
  indexStatus: IndexStatus;
  indexSource: string;
  indexFetchedAt: string | null;
  indexLoading: boolean;
  selectedId: string | null;
  query: string;
  /** Last failure shown inside the detail pane instead of a toast. */
  lastError: string | null;
  /** Non-null while the permission dialog is up. */
  installPrompt: PluginInstallPrompt | null;
  installBusy: boolean;

  hydrate: () => Promise<void>;
  refreshInstalled: () => Promise<void>;
  refreshIndex: (force?: boolean) => Promise<void>;
  select: (id: string | null) => void;
  setQuery: (query: string) => void;
  replaceInstalled: (plugin: InstalledPlugin) => void;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  uninstall: (id: string, keepStorage: boolean) => Promise<void>;
  rollback: (id: string) => Promise<void>;
  setPermissions: (id: string, permissions: string[]) => Promise<void>;
  clearError: () => void;
  setLastError: (message: string | null) => void;
  setInstallPrompt: (prompt: PluginInstallPrompt | null) => void;
  setInstallBusy: (busy: boolean) => void;
}

let autoDisableWired = false;

export const usePluginStore = create<PluginStoreState>((set, get) => ({
  hydrated: false,
  installed: [],
  index: [],
  indexStatus: "missing",
  indexSource: "none",
  indexFetchedAt: null,
  indexLoading: false,
  selectedId: null,
  query: "",
  lastError: null,
  installPrompt: null,
  installBusy: false,

  hydrate: async () => {
    if (!autoDisableWired) {
      autoDisableWired = true;
      // A failing plugin disables itself in Rust; the list has to follow.
      onPluginAutoDisabled(() => {
        void get().refreshInstalled();
      });
    }
    await get().refreshInstalled();
    set({ hydrated: true });
    // The index is a network call: never block the first paint on it.
    void get().refreshIndex(false);
  },

  refreshInstalled: async () => {
    try {
      const installed = await invoke<InstalledPlugin[]>("plugin_list_installed");
      set({ installed: Array.isArray(installed) ? installed : [] });
    } catch (error) {
      const pluginError = toPluginError(error);
      console.warn("Failed to read installed plugins:", pluginError.message);
      set({ installed: [], lastError: pluginError.message });
    }
  },

  refreshIndex: async (force = false) => {
    set({ indexLoading: true });
    const result = await fetchPluginIndex(force);
    set({
      index: result.plugins,
      indexStatus: result.status,
      indexSource: result.source,
      indexFetchedAt: result.fetchedAt,
      indexLoading: false,
    });
  },

  select: (id) => set({ selectedId: id, lastError: null }),
  setQuery: (query) => set({ query }),

  replaceInstalled: (plugin) =>
    set((state) => ({
      installed: state.installed.some((item) => item.id === plugin.id)
        ? state.installed.map((item) => (item.id === plugin.id ? plugin : item))
        : [...state.installed, plugin],
    })),

  setEnabled: async (id, enabled) => {
    try {
      // Stop the worker before flipping the flag: a disabled plugin must not
      // keep a live message channel to the host.
      if (!enabled) deactivatePlugin(id);
      await invoke("plugin_set_enabled", { id, enabled });
      await get().refreshInstalled();
    } catch (error) {
      set({ lastError: toPluginError(error).message });
    }
  },

  uninstall: async (id, keepStorage) => {
    try {
      deactivatePlugin(id);
      await invoke("plugin_uninstall", { id, keepStorage });
      if (get().selectedId === id) set({ selectedId: null });
      await get().refreshInstalled();
    } catch (error) {
      set({ lastError: toPluginError(error).message });
    }
  },

  rollback: async (id) => {
    try {
      // The running worker is bound to the old version's main.js.
      deactivatePlugin(id);
      const record = await invoke<InstalledPlugin>("plugin_rollback", { id });
      get().replaceInstalled(record);
    } catch (error) {
      set({ lastError: toPluginError(error).message });
    }
  },

  setPermissions: async (id, permissions) => {
    try {
      const record = await invoke<InstalledPlugin>("plugin_set_permissions", { id, permissions });
      get().replaceInstalled(record);
      // A running worker keeps its own copy of the grant; push the new one so a
      // revoke takes effect on the next call instead of after a restart.
      setRunnerPermissions(id, record.grantedPermissions);
    } catch (error) {
      set({ lastError: toPluginError(error).message });
    }
  },

  clearError: () => set({ lastError: null }),
  setLastError: (lastError) => set({ lastError }),

  setInstallPrompt: (installPrompt) => set({ installPrompt }),
  setInstallBusy: (installBusy) => set({ installBusy }),
}));

/** Stop every worker — used when "disable all plugins" is switched on. */
export function stopAllPluginWorkers(): void {
  deactivateAllPlugins();
}

export function findInstalled(list: InstalledPlugin[], id: string | null): InstalledPlugin | null {
  if (!id) return null;
  return list.find((plugin) => plugin.id === id) ?? null;
}

export function findIndexEntry(list: PluginIndexEntry[], id: string | null): PluginIndexEntry | null {
  if (!id) return null;
  return list.find((entry) => entry.id === id) ?? null;
}

/** An update is available when the index advertises a strictly newer version. */
export function isUpdateAvailable(
  plugin: InstalledPlugin,
  index: PluginIndexEntry[],
): boolean {
  const entry = findIndexEntry(index, plugin.id);
  if (!entry) return false;
  return isNewerVersion(entry.version, plugin.version);
}

export function countUpdates(installed: InstalledPlugin[], index: PluginIndexEntry[]): number {
  return installed.filter((plugin) => isUpdateAvailable(plugin, index)).length;
}

/** Permissions an update would add. The install prompt is mandatory when this is
 * non-empty (D4: growing the grant always needs a fresh confirmation). */
export function pendingUpdatePermissions(
  plugin: InstalledPlugin,
  entry: PluginIndexEntry,
): string[] {
  return addedPermissions(plugin.grantedPermissions, entry.permissions);
}
