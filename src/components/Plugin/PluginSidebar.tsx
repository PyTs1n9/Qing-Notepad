import React, { useMemo } from "react";
import { ArrowUp, FilePlus2, Puzzle, RefreshCw, Search } from "lucide-react";
import { usePluginStore, isUpdateAvailable } from "@/plugin/store";
import { beginInstallFromFile } from "@/plugin/install";
import type { InstalledPlugin, PluginIndexEntry } from "@/plugin/types";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

interface RowProps {
  title: string;
  subtitle: string;
  active: boolean;
  enabled?: boolean;
  update?: boolean;
  onSelect: () => void;
}

const Row: React.FC<RowProps> = ({ title, subtitle, active, enabled, update, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    aria-current={active ? "true" : undefined}
    className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
      active ? "bg-accent-light/60" : "hover:bg-bg-hover"
    }`}
  >
    <span
      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ${
        active ? "bg-accent-light text-accent-text" : "bg-bg-secondary text-text-muted"
      }`}
    >
      <Puzzle size={13} />
    </span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1">
        <span className="truncate text-[13px] text-text-primary">{title}</span>
        {update && (
          <ArrowUp size={11} className="flex-shrink-0 text-accent-text" aria-hidden="true" />
        )}
      </span>
      <span className="block truncate text-[11px] text-text-muted">{subtitle}</span>
    </span>
    {typeof enabled === "boolean" && (
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${enabled ? "bg-success" : "bg-text-muted/40"}`}
      />
    )}
  </button>
);

/**
 * Left column of the extensions page: installed on top, installable below a
 * dashed rule. The split mirrors VS Code closely enough that the layout needs
 * no explanation, which is the point of copying it.
 */
const PluginSidebar: React.FC = () => {
  const lang = useSettingsStore((state) => state.lang);
  const installed = usePluginStore((state) => state.installed);
  const index = usePluginStore((state) => state.index);
  const indexStatus = usePluginStore((state) => state.indexStatus);
  const indexLoading = usePluginStore((state) => state.indexLoading);
  const indexFetchedAt = usePluginStore((state) => state.indexFetchedAt);
  const selectedId = usePluginStore((state) => state.selectedId);
  const query = usePluginStore((state) => state.query);
  const select = usePluginStore((state) => state.select);
  const setQuery = usePluginStore((state) => state.setQuery);
  const refreshIndex = usePluginStore((state) => state.refreshIndex);

  const installedIds = useMemo(() => new Set(installed.map((plugin) => plugin.id)), [installed]);

  const matches = (haystack: Array<string | null | undefined>) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return haystack.some((value) => (value ?? "").toLowerCase().includes(needle));
  };

  const installedRows = useMemo(
    () =>
      installed
        .filter((plugin) => matches([plugin.manifest?.name, plugin.manifest?.description, plugin.id]))
        .sort((left, right) => (left.manifest?.name ?? left.id).localeCompare(right.manifest?.name ?? right.id)),
    // `matches` closes over `query`; listing it keeps the memo honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [installed, query],
  );

  const availableRows = useMemo(
    () =>
      index
        .filter((entry) => !installedIds.has(entry.id))
        .filter((entry) => matches([entry.name, entry.description, entry.author, entry.id]))
        .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, installedIds, query],
  );

  // `cached` is the only state that really means offline: the fetch failed and
  // the list came from disk. `missing` is "there is no index yet" — a 404 on a
  // repository that has not been created, which is not a network problem and
  // should not be reported as one.
  const offline = indexStatus === "cached";
  const statusLabel = indexStatus === "missing"
    ? ""
    : offline
      ? t(lang, "pluginsOffline")
      : t(lang, "pluginsOnline");
  const statusTitle = indexStatus === "missing"
    ? t(lang, "pluginsEmptyAvailable")
    : indexFetchedAt ?? undefined;

  const subtitleFor = (plugin: InstalledPlugin) => {
    if (!plugin.enabled) return t(lang, "pluginDisabled");
    return plugin.manifest?.description?.trim() || `v${plugin.version}`;
  };

  const subtitleForEntry = (entry: PluginIndexEntry) =>
    entry.description.trim() || entry.author || `v${entry.version}`;

  return (
    <aside className="flex h-full w-full flex-col">
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {t(lang, "pluginsTitle")}
        </h2>
        <span className="ml-auto flex-shrink-0 text-[11px] tabular-nums text-text-muted">
          {installed.length}
        </span>
      </div>

      <div className="flex-shrink-0 px-2 pb-1 pt-2">
        <div className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-2">
          <Search size={12} className="flex-shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(lang, "pluginsSearchPlaceholder")}
            aria-label={t(lang, "pluginsSearchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <h3 className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {t(lang, "pluginsInstalledSection")}
        </h3>
        {installedRows.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-relaxed text-text-muted">
            {t(lang, "pluginsEmptyInstalled")}
          </p>
        ) : (
          installedRows.map((plugin) => (
            <Row
              key={plugin.id}
              title={plugin.manifest?.name ?? plugin.id}
              subtitle={subtitleFor(plugin)}
              active={selectedId === plugin.id}
              enabled={plugin.enabled}
              update={isUpdateAvailable(plugin, index)}
              onSelect={() => select(plugin.id)}
            />
          ))
        )}

        <div className="mx-2 my-2 border-t border-dashed border-border" />

        <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {t(lang, "pluginsAvailableSection")}
        </h3>
        {indexLoading && availableRows.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-relaxed text-text-muted">
            {t(lang, "pluginsIndexLoading")}
          </p>
        ) : availableRows.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-relaxed text-text-muted">
            {t(lang, "pluginsEmptyAvailable")}
          </p>
        ) : (
          availableRows.map((entry) => (
            <Row
              key={entry.id}
              title={entry.name || entry.id}
              subtitle={subtitleForEntry(entry)}
              active={selectedId === entry.id}
              onSelect={() => select(entry.id)}
            />
          ))
        )}
      </div>

      <footer className="flex flex-shrink-0 items-center gap-1 border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => void beginInstallFromFile()}
          title={t(lang, "pluginsInstallFromFile")}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <FilePlus2 size={12} />
          {t(lang, "pluginsInstallFromFile")}
        </button>
        <button
          type="button"
          onClick={() => void refreshIndex(true)}
          disabled={indexLoading}
          title={t(lang, "pluginsRefreshIndex")}
          aria-label={t(lang, "pluginsRefreshIndex")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw size={12} className={indexLoading ? "animate-spin" : undefined} />
        </button>
        <span
          title={statusTitle}
          className="ml-auto flex items-center gap-1 text-[10px] text-text-muted"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${indexStatus === "ok" ? "bg-success" : "bg-text-muted/50"}`}
          />
          {statusLabel}
        </span>
      </footer>
    </aside>
  );
};

export default PluginSidebar;
