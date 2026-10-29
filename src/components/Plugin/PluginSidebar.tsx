import React, { useMemo } from "react";
import { ArrowUp, FilePlus2, FolderPlus, Puzzle, RefreshCw, Search, X } from "lucide-react";
import LoadingText from "@/components/LoadingText";
import { usePluginStore, isUpdateAvailable } from "@/plugin/store";
import { beginInstallFromFile, beginInstallFromFolder } from "@/plugin/install";
import { authorName, type InstalledPlugin, type PluginIndexEntry } from "@/plugin/types";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

interface RowProps {
  title: string;
  subtitle: string;
  active: boolean;
  /** Installed rows only: `undefined` on index rows, which carry no status. */
  enabled?: boolean;
  update?: boolean;
  /** Chip text for `update` — the row is module-level, so the label comes in. */
  updateLabel: string;
  onSelect: () => void;
}

/**
 * 38px is not a round number by accident: a 13px title box is 18px tall, an 11px
 * subtitle box is 16px, and 2+2 of vertical padding closes the row. A 34px row
 * clipped the second line of a two-line Chinese name.
 *
 * The trailing slot is one of three mutually exclusive signals — update chip,
 * status dot, nothing. Two of them at once reads as two different claims about
 * the same plugin.
 */
const Row: React.FC<RowProps> = ({ title, subtitle, active, enabled, update, updateLabel, onSelect }) => {
  // A disabled plugin with an update gets a neutral chip: "there is something
  // newer" is still worth knowing, but it must not compete with the accent used
  // by rows that are actually running.
  const chipTone =
    enabled === false
      ? "border-border bg-transparent text-text-secondary"
      : "border-border bg-accent-light text-accent-text";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`flex min-h-[38px] w-full items-center gap-2 rounded-lg px-2 py-[2px] text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
        active ? "bg-bg-active" : "hover:bg-bg-hover/50"
      }`}
    >
      {/* The fill needs its own 1px line: `accent-light` sits 1.04–1.27 away
          from the paper, so in the yellow theme it would read as no fill at
          all. */}
      <span
        className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border ${
          active ? "border-border bg-accent-light text-accent-text" : "border-transparent text-text-muted"
        }`}
      >
        <Puzzle size={12} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          {/* `leading-[18px]` is load-bearing: an arbitrary font-size alone
              inherits line-height 1.5 (19.5px) and the 38px row becomes 40. */}
          <span
            className={`truncate text-[13px] leading-[18px] text-text-primary ${
              active ? "font-medium" : "font-normal"
            }`}
          >
            {title}
          </span>
        </span>
        <span
          className={`block truncate text-[11px] leading-4 ${
            active ? "text-text-primary" : "text-text-secondary"
          }`}
        >
          {subtitle}
        </span>
      </span>
      {update ? (
        // Visually icon-only: the chip shares a 192px row with the plugin name,
        // and the words "有可用更新" cost about 62px of it. The statement is not
        // dropped, it moves to `sr-only` - the arrow is `aria-hidden`, so
        // removing the text outright would take the only mention of an update
        // out of the accessibility tree. Doing it unconditionally also means no
        // width-dependent CSS: this column is dragged, not resized by viewport.
        <span
          className={`inline-flex h-4 flex-shrink-0 items-center rounded border px-1 ${chipTone}`}
          title={updateLabel}
        >
          <ArrowUp size={12} aria-hidden="true" />
          <span className="sr-only">{updateLabel}</span>
        </span>
      ) : typeof enabled === "boolean" ? (
        // The dot only ever says enabled/not; "已停用" is spelled out in the
        // subtitle, so a row never carries two competing signals.
        // `h-1.5` is 6px: the brief's "1.5px" is shorthand for that class, not
        // a literal size — a 1.5px dot is invisible in a 38px row.
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${enabled ? "bg-success" : "bg-text-muted/50"}`}
        />
      ) : null}
    </button>
  );
};

/** ISO in a tooltip is a machine's date; a reader expects their own format. */
function formatFetchedAt(value: string | null, lang: "zh" | "en"): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
}

/**
 * Manifests may carry the `v` already (`version.ts` normalises `^v` for exactly
 * that reason), so prefixing blindly renders "vv1.0.1" in the English UI.
 */
function formatVersion(version: string): string {
  return `v${version.trim().replace(/^v/i, "")}`;
}

/**
 * Left column of the extensions page: installed on top, installable below.
 *
 * The two groups are separate lists on purpose — a screen reader should be able
 * to say "list, 3 items" for each, which a single flat list cannot.
 */
const PluginSidebar: React.FC = () => {
  const lang = useSettingsStore((state) => state.lang);
  const hydrated = usePluginStore((state) => state.hydrated);
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
  const busy = usePluginStore((state) => state.installBusy);

  const installedIds = useMemo(() => new Set(installed.map((plugin) => plugin.id)), [installed]);

  const matches = (haystack: Array<string | null | undefined>) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return haystack.some((value) => (value ?? "").toLowerCase().includes(needle));
  };

  const installedRows = useMemo(
    () =>
      installed
        .filter((plugin) =>
          // Author is searchable here too: it already is in the index list, and
          // a search that works on one side but not the other is a bug.
          matches([
            plugin.manifest?.name,
            plugin.manifest?.description,
            authorName(plugin.manifest),
            plugin.id,
          ]),
        )
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

  const indexIsEmpty = index.length === 0;
  const allInstalled = !indexIsEmpty && index.every((entry) => installedIds.has(entry.id));
  // Only `cached` means "this list is old". `missing` means there is no list at
  // all, so an "offline, may be out of date" note next to a footer that says
  // "no index" would contradict itself on the same screen.
  const offlineHintVisible = indexStatus === "cached";

  // `ok` means the fetch answered; `cached` means it did not and this is a disk
  // copy; `missing` is "there is no index at all yet", which is not a network
  // failure and must not borrow the offline wording.
  const fetchedAtLabel = formatFetchedAt(indexFetchedAt, lang);
  const statusLabel =
    indexStatus === "ok"
      ? t(lang, "pluginsOnline")
      : indexStatus === "cached"
        ? t(lang, "pluginsOffline")
        : t(lang, "pluginsIndexMissingShort");
  const statusTitle =
    indexStatus === "ok"
      ? fetchedAtLabel
      : indexStatus === "cached"
        ? t(lang, "pluginsOfflineHint")
        : t(lang, "pluginsIndexMissing");

  const subtitleFor = (plugin: InstalledPlugin) => {
    if (!plugin.enabled) return t(lang, "pluginDisabled");
    return plugin.manifest?.description?.trim() || formatVersion(plugin.version);
  };

  const subtitleForEntry = (entry: PluginIndexEntry) =>
    entry.description.trim() || entry.author || formatVersion(entry.version);

  const updateLabel = t(lang, "pluginUpdateAvailable");

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // An empty box has nothing to clear: let the key travel up and close the
      // modal, which is what the reader asked for.
      if (!query) return;
      event.preventDefault();
      setQuery("");
      return;
    }
    if (event.key === "Enter") {
      const first = installedRows[0]?.id ?? availableRows[0]?.id;
      if (!first) return;
      event.preventDefault();
      select(first);
    }
  };

  /** The empty state of the "available" group, in the order that matters. */
  const renderAvailableEmpty = () => {
    // `!hydrated` counts as loading: on the first frame the index is still the
    // initial `[]`/`missing`, and printing "the index has not been fetched yet"
    // before anything has been asked for is the same false negative as the
    // first-frame "no extensions installed".
    if ((!hydrated || indexLoading) && indexIsEmpty) {
      return (
        <div className="px-2 py-1.5">
          <LoadingText label={t(lang, "pluginsIndexLoading")} className="text-[11px] text-text-muted" />
        </div>
      );
    }
    if (indexIsEmpty && indexStatus === "missing") {
      return (
        <div className="px-2 py-1.5">
          <p className="text-[11px] leading-4 text-text-muted">{t(lang, "pluginsIndexMissing")}</p>
          <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
            {t(lang, "pluginsIndexMissingBody")}
          </p>
        </div>
      );
    }
    if (indexIsEmpty) {
      return (
        <p className="px-2 py-1.5 text-[11px] leading-4 text-text-muted">
          {t(lang, "pluginsEmptyAvailable")}
        </p>
      );
    }
    if (allInstalled) {
      return (
        <p className="px-2 py-1.5 text-[11px] leading-4 text-text-muted">
          {t(lang, "pluginsAvailableAllInstalled")}
        </p>
      );
    }
    // The index has uninstalled entries, so the list is empty only because the
    // search removed them. Saying so is not enough: a search that hides
    // everything is a dead end unless the state itself offers the way out.
    return (
      <div className="py-1.5">
        <p className="px-2 text-[11px] leading-4 text-text-muted">{t(lang, "pluginsSearchNoResult")}</p>
        {/* The scope is spelled out only here: someone who searched for an
            author and got nothing needs to know what was searched. */}
        <p className="px-2 pb-1 text-[10px] leading-4 text-text-muted">{t(lang, "pluginsSearchScope")}</p>
        <button
          type="button"
          onClick={() => setQuery("")}
          className="px-2 text-[11px] leading-4 text-accent-text transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:underline"
        >
          {t(lang, "pluginsSearchClear")}
        </button>
      </div>
    );
  };

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
        <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-2 transition-colors duration-[var(--dur-fast)] focus-within:border-accent">
          <Search size={13} className="flex-shrink-0 text-text-muted" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t(lang, "pluginsSearchPlaceholder")}
            aria-label={t(lang, "pluginsSearchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
          />
          {query && (
            <button
              type="button"
              // preventDefault keeps the caret in the input: clearing is not a
              // navigation, and losing focus mid-typing forces a click to resume.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setQuery("")}
              aria-label={t(lang, "pluginsSearchClear")}
              title={t(lang, "pluginsSearchClear")}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="plugin-list min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <h3
          id="plugin-installed-heading"
          className="px-2 pb-1 pt-2.5 text-[11px] font-semibold leading-4 text-text-muted"
        >
          {t(lang, "pluginsInstalledSection")}
        </h3>
        {!hydrated ? (
          // The first frame has an empty `installed` array that means "not read
          // yet", not "nothing installed". Saying the latter makes people think
          // their extensions are gone for the two frames before data lands.
          <div className="px-2 py-1.5">
            <LoadingText
              label={t(lang, "pluginsInstalledLoading")}
              className="text-[11px] text-text-muted"
            />
          </div>
        ) : installed.length === 0 ? (
          <div className="px-2 py-1.5">
            <p className="text-[11px] leading-4 text-text-muted">{t(lang, "pluginsEmptyInstalled")}</p>
            <button
              type="button"
              onClick={() => void beginInstallFromFile()}
              disabled={busy}
              className="mt-1 text-[11px] leading-4 text-accent-text transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
            >
              {t(lang, "pluginsInstallFromFile")}
            </button>
          </div>
        ) : installedRows.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-4 text-text-muted">
            {t(lang, "pluginsListHiddenBySearch")}
          </p>
        ) : (
          <ul aria-labelledby="plugin-installed-heading" className="space-y-0.5">
            {installedRows.map((plugin) => (
              <li key={plugin.id}>
                <Row
                  title={plugin.manifest?.name ?? plugin.id}
                  subtitle={subtitleFor(plugin)}
                  active={selectedId === plugin.id}
                  enabled={plugin.enabled}
                  update={isUpdateAvailable(plugin, index)}
                  updateLabel={updateLabel}
                  onSelect={() => select(plugin.id)}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center px-2 pb-1 pt-4">
          <h3
            id="plugin-available-heading"
            className="text-[11px] font-semibold leading-4 text-text-muted"
          >
            {t(lang, "pluginsAvailableSection")}
          </h3>
          {offlineHintVisible && (
            // `leading-4` keeps this 10px caveat on the group heading's own
            // 16px line box; without it the default 1.5 gives 15px and the two
            // baselines drift apart.
            <span className="ml-auto min-w-0 truncate pl-2 text-right text-[10px] font-normal normal-case leading-4 tracking-normal text-text-muted">
              {t(lang, "pluginsOfflineHint")}
            </span>
          )}
        </div>
        {availableRows.length === 0 ? (
          renderAvailableEmpty()
        ) : (
          <ul aria-labelledby="plugin-available-heading" className="space-y-0.5">
            {availableRows.map((entry) => (
              <li key={entry.id}>
                {/* No trailing signal: an index entry is not installed, and the
                    detail pane's install button is the only honest action cue. */}
                <Row
                  title={entry.name || entry.id}
                  subtitle={subtitleForEntry(entry)}
                  active={selectedId === entry.id}
                  updateLabel={updateLabel}
                  onSelect={() => select(entry.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="flex flex-shrink-0 items-center gap-1 border-t border-border px-2 py-1.5">
        {/*
          Both install buttons lock while one dialog is open: `install.ts` keeps a
          single module-level `pending`, so a second picker silently overwrites
          the first one's callback and the first file is never installed.
        */}
        <button
          type="button"
          onClick={() => void beginInstallFromFile()}
          disabled={busy}
          title={t(lang, "pluginsInstallFromFile")}
          className="flex h-6 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-secondary transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FilePlus2 size={12} aria-hidden="true" />
          {t(lang, "pluginsInstallFromFile")}
        </button>
        {/*
          Icon-only, like the refresh button: the footer is a fixed-width strip
          and a second label does not fit in English ("Install from folder").
          The tooltip and the accessible name carry the meaning.
        */}
        <button
          type="button"
          onClick={() => void beginInstallFromFolder()}
          disabled={busy}
          title={t(lang, "pluginsInstallFromFolder")}
          aria-label={t(lang, "pluginsInstallFromFolder")}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FolderPlus size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void refreshIndex(true)}
          disabled={indexLoading || busy}
          title={t(lang, "pluginsRefreshIndex")}
          aria-label={t(lang, "pluginsRefreshIndex")}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw size={12} className={indexLoading ? "animate-spin" : undefined} aria-hidden="true" />
        </button>
        <span
          title={statusTitle}
          className="ml-auto flex items-center gap-1 text-[10px] text-text-muted"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
              indexStatus === "ok"
                ? "bg-success"
                : indexStatus === "cached"
                  ? "bg-text-muted/60"
                  : // Hollow, not grey: a filled dot claims "we have data".
                    "border border-text-muted"
            }`}
          />
          {statusLabel}
        </span>
      </footer>
    </aside>
  );
};

export default PluginSidebar;
