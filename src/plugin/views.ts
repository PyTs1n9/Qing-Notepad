/**
 * Host side of `qing.views`: which sidebar panels exist, what is in them, and
 * who wants to know when they change.
 *
 * This module deliberately imports neither `bridge.ts` nor `headless.ts`:
 * `bridge` calls in here (`notifyViewRefresh`) and `headless` calls in here
 * (`clearPluginViews`), so anything imported back would make a cycle. The two
 * things that need a live worker — fetching children, running a command — live
 * in `headless.ts`, and the component wires the three together.
 *
 * Everything in a tree is untrusted input: ids, labels and especially
 * `command`, which names something the host will execute. `sanitizeTreeItem`
 * is therefore the only way an item enters this module's state.
 */
import { useSettingsStore } from "@/stores/settingsStore";
import {
  hasPermission,
  manifestCommands,
  manifestViews,
  type InstalledPlugin,
  type PluginTreeItem,
  type PluginViewContribution,
} from "./types";

/** What one contributed panel currently shows. */
export interface ViewSnapshot {
  /** Root items. */
  items: PluginTreeItem[];
  /** Children by parent item id, filled as rows are opened. */
  children: ReadonlyMap<string, PluginTreeItem[]>;
  /** Item ids the user has opened. */
  expanded: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
}

const EMPTY_SNAPSHOT: ViewSnapshot = {
  items: [],
  children: new Map(),
  expanded: new Set(),
  loading: false,
  error: null,
};

/** `pluginId::viewId` — one bucket per contributed panel. */
function snapshotKey(pluginId: string, viewId: string): string {
  return `${pluginId}::${viewId}`;
}

const snapshots = new Map<string, ViewSnapshot>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to every snapshot change. Returns an unsubscribe function. */
export function subscribeViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable identity: React's `useSyncExternalStore` compares snapshots with `===`. */
export function getViewSnapshot(pluginId: string, viewId: string): ViewSnapshot {
  return snapshots.get(snapshotKey(pluginId, viewId)) ?? EMPTY_SNAPSHOT;
}

function update(pluginId: string, viewId: string, patch: Partial<ViewSnapshot>): void {
  const key = snapshotKey(pluginId, viewId);
  const previous = snapshots.get(key) ?? EMPTY_SNAPSHOT;
  snapshots.set(key, { ...previous, ...patch });
  emit();
}

export function beginViewLoad(pluginId: string, viewId: string): void {
  update(pluginId, viewId, { loading: true, error: null });
}

export function completeViewLoad(pluginId: string, viewId: string, items: PluginTreeItem[]): void {
  update(pluginId, viewId, { items, loading: false, error: null });
}

export function failViewLoad(pluginId: string, viewId: string, error: string): void {
  update(pluginId, viewId, { loading: false, error });
}

/** Store one level of children and mark the parent open. */
export function setViewChildren(
  pluginId: string,
  viewId: string,
  parentId: string,
  items: PluginTreeItem[],
): void {
  const previous = snapshots.get(snapshotKey(pluginId, viewId)) ?? EMPTY_SNAPSHOT;
  const children = new Map(previous.children);
  children.set(parentId, items);
  const expanded = new Set(previous.expanded);
  expanded.add(parentId);
  update(pluginId, viewId, { children, expanded });
}

export function collapseViewItem(pluginId: string, viewId: string, itemId: string): void {
  const previous = snapshots.get(snapshotKey(pluginId, viewId)) ?? EMPTY_SNAPSHOT;
  const expanded = new Set(previous.expanded);
  expanded.delete(itemId);
  update(pluginId, viewId, { expanded });
}

/**
 * A plugin's data changed: tell the UI to fetch again.
 *
 * Scoped to the plugin that asked, so one plugin cannot make another plugin's
 * panel spin (the bridge has already checked the view id is theirs).
 */
export function notifyViewRefresh(pluginId: string, viewId: string): void {
  const key = snapshotKey(pluginId, viewId);
  if (!snapshots.has(key)) return;
  update(pluginId, viewId, { error: null });
  refreshListeners.forEach((listener) => listener(viewId));
}

type RefreshListener = (viewId: string) => void;
const refreshListeners = new Set<RefreshListener>();

/** The panel components use this to re-fetch after `views.refresh`. */
export function onViewRefresh(listener: RefreshListener): () => void {
  refreshListeners.add(listener);
  return () => {
    refreshListeners.delete(listener);
  };
}

/**
 * Drop everything a plugin's panels were showing.
 *
 * Called from `deactivatePlugin`, so a disable, uninstall, update, rollback or
 * crash cannot leave rows from code that is no longer running. Panels are
 * derived state — they are rebuilt by fetching from the next worker — so this
 * is a delete, not a reconciliation.
 */
export function clearPluginViews(pluginId: string): void {
  const prefix = `${pluginId}::`;
  let changed = false;
  for (const key of [...snapshots.keys()]) {
    if (key.startsWith(prefix)) {
      snapshots.delete(key);
      changed = true;
    }
  }
  if (changed) emit();
}

/**
 * The panels to render right now.
 *
 * A plugin contributes a panel only while it is enabled, the user has granted
 * `views`, and plugins are not globally switched off. All three are "the user
 * said no" in different words, and the sidebar honours all of them with the
 * same silence: when there is nothing to show, nothing is rendered.
 */
export function contributedViews(
  installed: readonly InstalledPlugin[],
): Array<{ plugin: InstalledPlugin; view: PluginViewContribution }> {
  if (useSettingsStore.getState().pluginsDisabled) return [];
  const out: Array<{ plugin: InstalledPlugin; view: PluginViewContribution }> = [];
  for (const plugin of installed) {
    if (!plugin.enabled || !plugin.manifest) continue;
    if (!hasPermission(plugin.grantedPermissions, "views")) continue;
    for (const view of manifestViews(plugin.manifest)) {
      if (!view.id) continue;
      out.push({ plugin, view });
    }
  }
  return out;
}

/**
 * Turn one provider result into something the sidebar may render.
 *
 * Rows the plugin got wrong are dropped rather than failing the panel: a tree
 * with one bad item is still useful, and a panel that goes blank because a
 * label was not a string is not. A `command` naming another plugin's command is
 * stripped here (the row stays, it just cannot be clicked) — the hard check is
 * `headless.ts::executePluginCommand`, this one keeps the button out of the UI.
 */
export function sanitizeTreeItem(value: unknown, ownCommandIds: readonly string[]): PluginTreeItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!id || !label || id.length > 200 || label.length > 500) {
    console.warn("[plugin-views] dropping a tree item with an empty id/label", raw);
    return null;
  }
  let command: string | null = null;
  if (typeof raw.command === "string" && raw.command.trim()) {
    const requested = raw.command.trim();
    if (ownCommandIds.includes(requested)) command = requested.slice(0, 200);
    else {
      console.warn(
        `[plugin-views] tree item ${id} names \`${requested}\`, which is not this plugin's command`,
      );
    }
  }
  const collapsibleState =
    raw.collapsibleState === "collapsed" || raw.collapsibleState === "expanded"
      ? raw.collapsibleState
      : "none";
  return {
    id: id.slice(0, 200),
    label: label.slice(0, 500),
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim().slice(0, 500)
        : null,
    command,
    collapsibleState,
  };
}

/** Command ids a plugin contributes — the allow-list `sanitizeTreeItem` uses. */
export function ownCommandIds(plugin: InstalledPlugin): string[] {
  return manifestCommands(plugin.manifest).map((command) => command.id);
}
