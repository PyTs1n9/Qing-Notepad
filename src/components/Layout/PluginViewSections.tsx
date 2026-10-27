/**
 * The sidebar panels plugins contribute (`contributes.views` + permission
 * `views`).
 *
 * Rendered at the bottom of the note sidebar, one collapsible section per
 * panel. When no plugin contributes anything — the common case — this returns
 * `null` and costs the column nothing: no divider, no header, no reserved
 * height. A plugin panel earns its space by existing.
 *
 * Rows come from the plugin's own `getChildren` and are rendered as the sidebar
 * rows the rest of the app already uses. There is no new visual language here
 * on purpose: a plugin panel should read as part of the sidebar, not as an
 * embedded web page.
 */
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { usePluginStore } from "@/plugin/store";
import { useSettingsStore, type LangType } from "@/stores/settingsStore";
import { toast } from "@/stores/toastStore";
import { tWithParams } from "@/utils/i18n";
import { executePluginCommand, getPluginViewChildren } from "@/plugin/headless";
import {
  beginViewLoad,
  collapseViewItem,
  completeViewLoad,
  contributedViews,
  failViewLoad,
  getViewSnapshot,
  onViewRefresh,
  setViewChildren,
  subscribeViews,
} from "@/plugin/views";
import type { InstalledPlugin, PluginTreeItem, PluginViewContribution } from "@/plugin/types";

interface SectionProps {
  plugin: InstalledPlugin;
  view: PluginViewContribution;
  lang: LangType;
}

/** One panel: header, then the rows its provider returned. */
const PluginViewSection: React.FC<SectionProps> = ({ plugin, view, lang }) => {
  const [open, setOpen] = useState(true);
  const snapshot = useSyncExternalStore(
    subscribeViews,
    () => getViewSnapshot(plugin.id, view.id),
  );

  const loadRoot = useCallback(async () => {
    beginViewLoad(plugin.id, view.id);
    try {
      // Activation is lazy, exactly like the command palette: the provider is
      // registered when the worker starts, and the first render of its panel is
      // what starts it. `ensureRunner` is idempotent, so a plugin that also has
      // commands or another panel starts once.
      //
      // A plugin may say `onView:<id>` in `activationEvents` to declare that
      // intent, but rendering activates regardless: a package that contributes
      // a view and lists no activation events would otherwise show an empty
      // panel forever, which reads as a broken plugin rather than a deferred
      // one.
      const items = await getPluginViewChildren(plugin, view.id);
      completeViewLoad(plugin.id, view.id, items);
    } catch (error) {
      failViewLoad(plugin.id, view.id, error instanceof Error ? error.message : String(error));
    }
  }, [plugin, view.id]);

  useEffect(() => {
    void loadRoot();
    return onViewRefresh((viewId) => {
      if (viewId === view.id) void loadRoot();
    });
  }, [loadRoot, view.id]);

  const runCommand = useCallback(
    async (item: PluginTreeItem) => {
      if (!item.command) return;
      const result = await executePluginCommand(plugin, item.command);
      if (!result.ok) {
        toast(
          tWithParams(lang, "pluginCommandFailed", { code: result.code ?? "E_INTERNAL" }),
          "danger",
        );
      }
    },
    [lang, plugin],
  );

  const toggleChildren = useCallback(
    async (item: PluginTreeItem) => {
      if (item.collapsibleState === "none") return;
      if (snapshot.expanded.has(item.id)) {
        collapseViewItem(plugin.id, view.id, item.id);
        return;
      }
      try {
        const children = await getPluginViewChildren(plugin, view.id, item.id);
        setViewChildren(plugin.id, view.id, item.id, children);
      } catch (error) {
        failViewLoad(plugin.id, view.id, error instanceof Error ? error.message : String(error));
      }
    },
    [plugin, snapshot.expanded, view.id],
  );

  const renderRows = (items: readonly PluginTreeItem[], depth: number): React.ReactNode =>
    items.map((item) => {
      const isExpanded = snapshot.expanded.has(item.id);
      const children = snapshot.children.get(item.id) ?? [];
      return (
        <React.Fragment key={item.id}>
          <div className="flex items-center">
            {item.collapsibleState !== "none" ? (
              <button
                type="button"
                onClick={() => void toggleChildren(item)}
                aria-label={isExpanded ? "collapse" : "expand"}
                className="flex h-6 w-5 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : (
              <span className="w-5 flex-shrink-0" aria-hidden="true" />
            )}
            <button
              type="button"
              onClick={() => void runCommand(item)}
              disabled={!item.command}
              title={item.description || undefined}
              className={`flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 text-left text-xs transition-colors ${
                item.command
                  ? "cursor-pointer text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  : "cursor-default text-text-secondary"
              }`}
              style={{ paddingLeft: `${6 + depth * 12}px` }}
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.description && (
                <span className="flex-shrink-0 truncate text-[10px] text-text-muted">
                  {item.description}
                </span>
              )}
            </button>
          </div>
          {isExpanded && children.length > 0 && renderRows(children, depth + 1)}
        </React.Fragment>
      );
    });

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-1 px-3 text-left transition-colors hover:bg-bg-hover"
      >
        {open ? (
          <ChevronDown size={12} className="flex-shrink-0 text-text-muted" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0 text-text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {view.title}
        </span>
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto px-1.5 pb-1.5">
          {renderRows(snapshot.items, 0)}
        </div>
      )}
    </div>
  );
};

/**
 * All panels contributed right now, or nothing at all.
 *
 * Derived from the install list rather than kept in a registry of its own: a
 * plugin that is disabled, uninstalled, or had `views` revoked simply stops
 * contributing, and the section goes away with it. The same for the global
 * "plugins are off" switch — it is subscribed here, not read once, so flipping
 * it empties the column immediately.
 */
const PluginViewSections: React.FC<{ lang: LangType }> = ({ lang }) => {
  const installed = usePluginStore((state) => state.installed);
  const pluginsDisabled = useSettingsStore((state) => state.pluginsDisabled);
  const panels = useMemo(
    () => contributedViews(installed),
    [installed, pluginsDisabled],
  );

  if (panels.length === 0) return null;

  return (
    <div className="flex-shrink-0">
      {panels.map(({ plugin, view }) => (
        <PluginViewSection key={`${plugin.id}::${view.id}`} plugin={plugin} view={view} lang={lang} />
      ))}
    </div>
  );
};

export default PluginViewSections;
