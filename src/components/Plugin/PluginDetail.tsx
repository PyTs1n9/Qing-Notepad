import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Puzzle,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  ShieldOff,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  countUpdates,
  findIndexEntry,
  findInstalled,
  isUpdateAvailable,
  usePluginStore,
} from "@/plugin/store";
import { beginInstallFromIndex } from "@/plugin/install";
import {
  PERMISSION_LABEL_KEYS,
  authorName,
  hasPermission,
  isPluginPermission,
  manifestCommands,
  manifestPermissions,
  type InstalledPlugin,
  type PluginPermission,
} from "@/plugin/types";
import { deactivatePlugin } from "@/plugin/headless";
import { useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import EmptyState from "@/components/Layout/EmptyState";
import ModalShell from "@/components/Layout/ModalShell";
import LoadingText from "@/components/LoadingText";
import PermissionList from "./PermissionList";
import PluginErrorBar from "./PluginErrorBar";

/**
 * Card language lifted verbatim from `WorkspaceOverview.tsx`.
 *
 * The extensions page renders inside the same editor card as the workspace
 * overview, one view apart. Inventing a second "Apple-like" system here made the
 * two screens read as two products, so every frame, header and row below is the
 * same class string the overview already uses.
 *
 * Row heights are `min-h-` on purpose, and there are three of them: 34px for a
 * single 13/18 line, 52px when a permission label wraps to two lines at the
 * 360 tier, and 38px in the sidebar's two-line rows. A fixed `h-` would clip the
 * wrapped case.
 */
const CARD = "plugin-detail-card rounded-xl border border-border bg-bg-secondary/40";
const CARD_HEAD = "flex items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5";
const CARD_TITLE = "text-xs font-semibold uppercase tracking-[0.12em] text-text-muted";
const ROW = "plugin-detail-row flex w-full min-h-[34px] items-center gap-2.5 rounded-lg px-2 py-2";
// `truncate` is what makes these shrinkable: `overflow: hidden` drops the flex
// automatic minimum size, so no `min-w-0` is needed - and none is wanted, since
// `min-w-` would turn the 360 wrapping rule back into an overflow.
const LABEL = "plugin-detail-label flex-1 truncate text-[13px] leading-[18px] text-text-primary";

const PRIMARY_BUTTON =
  "flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60";
const GHOST_BUTTON =
  "flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:bg-bg-hover/60 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
// Danger is carried by the icon, the border and the copy - never by the label
// colour: `text-danger` sits at 2.47:1 on the yellow theme and 2.51:1 on green.
const DANGER_BUTTON =
  "flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-danger/45 px-2.5 text-xs font-medium text-text-secondary transition-colors hover:border-danger/70 hover:bg-danger/12 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";

type LogState = {
  status: "idle" | "loading" | "ready" | "error";
  lines: string[];
  message?: string;
};

const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="plugin-detail-meta-row flex items-start gap-3 border-b border-border/60 px-3.5 py-2 last:border-b-0">
    <span className="plugin-detail-meta-label w-[72px] flex-shrink-0 text-[11px] leading-4 text-text-muted">
      {label}
    </span>
    <span className="min-w-0 flex-1 break-words text-[11px] leading-4 text-text-secondary">
      {children}
    </span>
  </div>
);

/**
 * Main pane of the extensions page.
 *
 * It resolves the selection from *either* list: an id can name an installed
 * plugin (show version, permissions, actions) or only an index entry (show the
 * install action). When it names both, the installed record wins and the index
 * entry is used only to decide whether an update exists.
 *
 * The two selections are two different pages, not one page with holes:
 *
 * - an index entry is a **decision page** - header, description, declared
 *   permissions, details - because `PluginIndexEntry` carries no commands
 *   (they live in `InstalledPlugin.manifest.contributes.commands`), so there is
 *   nothing to fill the rest with;
 * - an installed plugin is a **management page** - adding the stat cards, the
 *   command/info pair, the log card and the manage card.
 *
 * The header carries at most two buttons, filled first. Everything destructive
 * lives in the manage card at the bottom.
 */
const PluginDetailBody: React.FC = () => {
  const lang = useSettingsStore((state) => state.lang);
  const hydrated = usePluginStore((state) => state.hydrated);
  const installed = usePluginStore((state) => state.installed);
  const index = usePluginStore((state) => state.index);
  const selectedId = usePluginStore((state) => state.selectedId);
  const lastError = usePluginStore((state) => state.lastError);
  const busy = usePluginStore((state) => state.installBusy);
  const setEnabled = usePluginStore((state) => state.setEnabled);
  const rollback = usePluginStore((state) => state.rollback);
  const uninstall = usePluginStore((state) => state.uninstall);
  const setPermissions = usePluginStore((state) => state.setPermissions);
  const refreshIndex = usePluginStore((state) => state.refreshIndex);

  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [log, setLog] = useState<LogState>({ status: "idle", lines: [] });
  // The permission row whose request is in flight. It is per-row on purpose:
  // `installBusy` is the install pipeline's flag and a grant must not block it.
  const [busyPermission, setBusyPermission] = useState<string | null>(null);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const logToken = useRef(0);
  const keepDataRef = useRef<HTMLButtonElement | null>(null);

  // A different plugin must not inherit the previous one's confirm dialog, its
  // log panel, or - worst of all - an in-flight `plugin_read_log` that resolves
  // after the switch and paints the old plugin's lines into the new pane.
  useEffect(() => {
    setUninstallOpen(false);
    setBusyPermission(null);
    logToken.current += 1;
    setLog({ status: "idle", lines: [] });
  }, [selectedId]);

  // Selecting a plugin starts at its header, not wherever the last one was
  // scrolled to. Deliberately instant: a smooth scroll here reads as lag.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  const record: InstalledPlugin | null = findInstalled(installed, selectedId);
  const entry = findIndexEntry(index, selectedId);
  const updateAvailable = record ? isUpdateAvailable(record, index) : false;
  const updates = countUpdates(installed, index);

  const manifest = record?.manifest ?? null;
  const name = manifest?.name ?? entry?.name ?? selectedId ?? "";
  const description = manifest?.description ?? entry?.description ?? "";
  const author = manifest ? authorName(manifest) : entry?.author ?? "";
  const version = record?.version ?? entry?.version ?? "";
  const sourceLabel = record
    ? record.source === "index"
      ? t(lang, "pluginSourceIndex")
      : t(lang, "pluginSourceFile")
    : "";
  // The index wins over the manifest here. An installed package carries the
  // URL it was packed with, so trusting `manifest.repository` first kept the
  // pane pointing at a path that had already moved out of the source repo.
  const repoLinks = useMemo(() => {
    const links: { label: string; url: string }[] = [];
    if (entry?.repo) links.push({ label: "GitHub", url: entry.repo });
    if (entry?.repoGitee) links.push({ label: "Gitee", url: entry.repoGitee });
    // Third-party plugins installed from a file have no index entry: their
    // manifest is the only address there is.
    if (links.length === 0 && manifest?.repository) {
      links.push({ label: t(lang, "pluginRepository"), url: manifest.repository });
    }
    return links;
  }, [entry, manifest, lang]);
  const declared = useMemo(
    () => (manifest ? manifestPermissions(manifest) : (entry?.permissions ?? [])),
    [manifest, entry],
  );

  const loadLog = useCallback(async () => {
    if (!record) return;
    const token = ++logToken.current;
    setLog({ status: "loading", lines: [] });
    try {
      const lines = await invoke<string[]>("plugin_read_log", { id: record.id });
      // The selection changed while this was in flight; its answer is about a
      // plugin that is no longer on screen.
      if (token !== logToken.current) return;
      setLog({ status: "ready", lines });
    } catch (error) {
      if (token !== logToken.current) return;
      // The failure is *not* log content. It used to be pushed into the `<pre>`
      // as a single "line", which made a host error look like the plugin's own
      // output.
      setLog({ status: "error", lines: [], message: String(error) });
    }
  }, [record]);

  const chromeBar = (
    <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border px-3">
      <h1 className="plugin-detail-chrome-prefix text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {t(lang, "pluginsTitle")}
      </h1>
      {updates > 0 && (
        <span className="flex-shrink-0 rounded bg-accent-light px-1.5 py-0.5 text-[10px] font-medium text-accent-text">
          {updates}
        </span>
      )}
      {name && (
        // Hidden from screen readers: the hero below already names the plugin,
        // and a duplicate would be read twice on every selection.
        <span aria-hidden="true" className="min-w-0 truncate text-[11px] text-text-muted">
          <span className="plugin-detail-chrome-prefix">/ </span>
          {name}
        </span>
      )}
    </div>
  );

  // `installed` is empty until the first `plugin_list_installed` resolves, so an
  // ungated pane flashes "no extension selected" on every cold start.
  if (!hydrated) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {chromeBar}
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <LoadingText label={t(lang, "loading")} className="text-xs text-text-muted" />
        </div>
      </div>
    );
  }

  /**
   * The grant list is re-read from the store instead of closing over `granted`:
   * two clicks in the same tick both started from the render's snapshot and the
   * second write silently dropped the first one's change.
   *
   * It sits *above* the early return on purpose. A hook placed after a
   * conditional `return` changes the hook count between renders, which React
   * reports as "Rendered more hooks than during the previous render" - and it
   * fires exactly once, the first time the pane goes from empty to selected,
   * so the retry button appears to fix it.
   */
  const readGranted = useCallback((): PluginPermission[] => {
    if (!record) return [];
    const latest = findInstalled(usePluginStore.getState().installed, record.id);
    return (latest?.grantedPermissions ?? []).filter(isPluginPermission);
  }, [record]);

  if (!selectedId || (!record && !entry)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {chromeBar}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {lastError ? (
            // The empty state is exactly where a first install lands when it is
            // refused, so the reason has to be readable here rather than only in
            // a toast that has already faded.
            <div className="mx-auto w-full max-w-[880px] px-5 py-5 sm:px-7 sm:py-6">
              <PluginErrorBar
                message={lastError}
                onDismiss={() => usePluginStore.getState().setLastError(null)}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              {selectedId ? (
                // The id survived but the index no longer lists it. The selection
                // is *not* cleared here: the list already lost it, and silently
                // blanking the pane would hide the fact that something vanished.
                <EmptyState
                  icon={<Puzzle size={18} />}
                  title={t(lang, "pluginsGoneTitle")}
                  description={t(lang, "pluginsGoneBody")}
                  action={{
                    label: t(lang, "pluginsRefreshIndex"),
                    onClick: () => void refreshIndex(true),
                  }}
                />
              ) : (
                <EmptyState
                  icon={<Puzzle size={18} />}
                  title={t(lang, "pluginsSelectHint")}
                  description={t(lang, "pluginsSelectHintBody")}
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const granted = record?.grantedPermissions ?? [];
  const commands = manifest ? manifestCommands(manifest) : [];
  // The same list the permission card draws as dashed rows, so the number and
  // the rows cannot disagree (a write grant implies its read).
  const missing = record
    ? declared.filter(
        (permission) => isPluginPermission(permission) && !hasPermission(granted, permission),
      )
    : [];
  const impliedRead = (permission: PluginPermission) =>
    (permission === "notes:read" && hasPermission(granted, "notes:write")) ||
    (permission === "todo:read" && hasPermission(granted, "todo:write"));

  const grant = async (permission: PluginPermission) => {
    if (!record) return;
    const current = readGranted();
    if (hasPermission(current, permission)) return;
    setBusyPermission(permission);
    try {
      await setPermissions(record.id, [...current, permission]);
    } finally {
      setBusyPermission(null);
    }
  };

  const revoke = async (permission: PluginPermission) => {
    if (!record) return;
    const next = readGranted().filter(
      (item) =>
        item !== permission &&
        !(permission === "notes:write" && item === "notes:read") &&
        !(permission === "todo:write" && item === "todo:read"),
    );
    setBusyPermission(permission);
    try {
      await setPermissions(record.id, next);
    } finally {
      setBusyPermission(null);
    }
  };

  // A write grant carries its read; the button says so instead of quietly
  // taking two rows away.
  const revokeAlso = (permission: PluginPermission): string[] => {
    const implied: PluginPermission | null =
      permission === "notes:write" ? "notes:read" : permission === "todo:write" ? "todo:read" : null;
    if (!implied || !hasPermission(readGranted(), implied)) return [];
    return [t(lang, PERMISSION_LABEL_KEYS[implied])];
  };

  const confirmUninstall = (keepStorage: boolean) => {
    if (!record) return;
    setUninstallOpen(false);
    deactivatePlugin(record.id);
    void uninstall(record.id, keepStorage);
  };

  // Only the installed page has metrics. A version is not a metric: `v1.0.1` at
  // `text-2xl` breaks the numeral baseline and elevates the least useful fact on
  // the page, so it stays in the header's meta line.
  const stats: Array<{ key: string; label: string; value: number; icon: typeof ShieldCheck }> = [
    { key: "permissions", label: t(lang, "pluginPermissions"), value: granted.length, icon: ShieldCheck },
    { key: "commands", label: t(lang, "pluginCommands"), value: commands.length, icon: Terminal },
  ];
  // A missing count of zero is not a metric either - it reads as "nothing is
  // wrong", which no other card states. The cell exists only when it is non-zero.
  if (missing.length > 0) {
    stats.push({
      key: "missing",
      label: t(lang, "pluginPermissionsMissing"),
      value: missing.length,
      icon: ShieldOff,
    });
  }

  const toggleEnabled = record ? (
    <button
      type="button"
      disabled={busy}
      onClick={() => void setEnabled(record.id, !record.enabled)}
      className={GHOST_BUTTON}
    >
      {t(lang, record.enabled ? "pluginDisable" : "pluginEnable")}
    </button>
  ) : null;

  // At most two buttons, filled first; never a destructive one. The order is
  // fixed so Tab reaches the enable/disable toggle before the manage card's
  // uninstall.
  const headerAction = !record && entry ? (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => void beginInstallFromIndex(entry)}
      className={PRIMARY_BUTTON}
    >
      <ArrowDownToLine size={13} />
      {busy ? t(lang, "pluginBusyInstalling") : t(lang, "pluginInstall")}
    </button>
  ) : record && updateAvailable && entry ? (
    <>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => void beginInstallFromIndex(entry)}
        className={PRIMARY_BUTTON}
      >
        <ArrowUp size={13} />
        {busy ? t(lang, "pluginBusyInstalling") : t(lang, "pluginUpdate")}
      </button>
      {toggleEnabled}
    </>
  ) : (
    toggleEnabled
  );

  const permissionsCard = (
    <section className={`mt-3 ${CARD}`}>
      <div className={CARD_HEAD}>
        <h2 className={CARD_TITLE}>{t(lang, "pluginPermissions")}</h2>
      </div>
      <PermissionList
        permissions={record ? granted : declared}
        lang={lang}
        onRevoke={record ? (permission) => void revoke(permission) : undefined}
        canRevoke={(permission) => !impliedRead(permission)}
        missing={missing}
        onGrant={record ? (permission) => void grant(permission) : undefined}
        onRevokeAlso={record ? revokeAlso : undefined}
        busyPermission={busyPermission}
      />
      {record && granted.length > 0 && (
        <p className="px-3.5 pb-3 text-[11px] leading-relaxed text-text-muted">
          {t(lang, "pluginLockedNote")}
        </p>
      )}
    </section>
  );

  const commandsCard = (
    <section className={`min-w-0 ${CARD}`}>
      <div className={CARD_HEAD}>
        <h2 className={CARD_TITLE}>{t(lang, "pluginCommands")}</h2>
      </div>
      {commands.length === 0 ? (
        <p className="px-3.5 py-3 text-xs text-text-muted">{t(lang, "pluginNoCommands")}</p>
      ) : (
        // Static information, so no hover fill: a row that lights up on hover
        // promises a click that is not there.
        <ul className="p-1.5">
          {commands.map((command) => (
            <li key={command.id} className={ROW}>
              <span className={LABEL} title={command.title}>
                {command.title}
              </span>
              {command.category && (
                <span className="plugin-command-category flex-shrink-0 text-[11px] leading-4 text-text-muted">
                  {command.category}
                </span>
              )}
              <span className="plugin-command-hint flex-shrink-0 font-mono text-[11px] leading-4 text-text-muted">
                Ctrl+Shift+P
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const infoCard = (
    <aside className={`min-w-0 ${CARD}`}>
      <div className={CARD_HEAD}>
        <h2 className={CARD_TITLE}>{t(lang, "pluginInfo")}</h2>
      </div>
      <div>
        <MetaRow label="ID">
          <code className="font-mono">{record?.id ?? entry?.id}</code>
        </MetaRow>
        {version && <MetaRow label={t(lang, "pluginVersion")}>v{version}</MetaRow>}
        {record && <MetaRow label={t(lang, "pluginSource")}>{sourceLabel}</MetaRow>}
        {manifest?.license && (
          <MetaRow label={t(lang, "pluginLicense")}>{manifest.license}</MetaRow>
        )}
        {repoLinks.length > 0 && (
          <MetaRow label={t(lang, "pluginRepository")}>
            <span className="flex flex-col gap-1">
              {repoLinks.map((link) => (
                <button
                  key={link.url}
                  type="button"
                  onClick={() => void openInDefaultBrowser(link.url)}
                  title={link.url}
                  className="flex w-full min-w-0 items-center gap-1.5 text-accent-text hover:underline"
                >
                  {repoLinks.length > 1 && (
                    <span className="w-12 flex-shrink-0 text-left text-text-muted">{link.label}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-left">{link.url}</span>
                  <ExternalLink size={10} className="flex-shrink-0" />
                </button>
              ))}
            </span>
          </MetaRow>
        )}
      </div>
    </aside>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="sr-only" aria-live="polite">
        {tWithParams(lang, "pluginSelectedAnnounce", { name })}
      </p>

      {chromeBar}

      {/* The scroller owns `container-type` and therefore no padding (C1);
          `.plugin-detail-body` carries the gutter and does the querying. */}
      <div ref={scrollerRef} className="plugin-detail-scroller min-h-0 flex-1 overflow-y-auto">
        <div className="plugin-detail-body mx-auto w-full max-w-[880px] px-5 py-5 sm:px-7 sm:py-6">
          <header className="plugin-detail-header flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h1 className="plugin-detail-title brand-face min-w-0 truncate text-[19px] leading-tight text-text-primary">
                  {name}
                </h1>
                {updateAvailable && (
                  <span className="flex flex-shrink-0 items-center gap-1 rounded-full border border-accent/15 bg-accent-light px-2 py-0.5 text-[11px] font-semibold text-accent-text">
                    <ArrowUp size={12} />
                    {t(lang, "pluginUpdateAvailable")}
                  </span>
                )}
                {record && !record.enabled && (
                  <span className="flex-shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                    {t(lang, "pluginDisabled")}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-text-muted">
                {[author, version ? `v${version}` : null, sourceLabel].filter(Boolean).join(" · ")}
              </p>
            </div>
            {headerAction && (
              <div className="plugin-detail-actions flex flex-shrink-0 flex-wrap items-center gap-1.5">
                {headerAction}
              </div>
            )}
          </header>

          {lastError && (
            <div className="mt-3">
              <PluginErrorBar
                message={lastError}
                onDismiss={() => usePluginStore.getState().setLastError(null)}
              />
            </div>
          )}

          {description && (
            <p className="mt-3 max-w-[60ch] text-[13px] leading-[21px] text-text-secondary">
              {description}
            </p>
          )}

          {record && (
            <dl className="mt-5 flex gap-3">
              {stats.map((stat) => (
                <div
                  key={stat.key}
                  className={`${CARD} flex min-w-0 flex-1 flex-col-reverse gap-1.5 px-3.5 py-3`}
                >
                  <dt className="flex items-center gap-1.5 text-xs text-text-muted">
                    <stat.icon size={12} className="flex-shrink-0 opacity-70" />
                    <span className="min-w-0 truncate">{stat.label}</span>
                  </dt>
                  <dd className="text-2xl font-semibold leading-none tabular-nums text-text-primary">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {permissionsCard}

          {record ? (
            <div className="plugin-detail-columns mt-3 grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-3">
              {commandsCard}
              {infoCard}
            </div>
          ) : (
            <div className="mt-3">{infoCard}</div>
          )}

          {record && (
            <section className={`mt-3 ${CARD}`}>
              <div className={CARD_HEAD}>
                <h2 className={CARD_TITLE}>{t(lang, "pluginLogSection")}</h2>
                {log.status === "ready" && (
                  <button
                    type="button"
                    onClick={() => setLog({ status: "idle", lines: [] })}
                    className="flex-shrink-0 rounded px-1 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary"
                  >
                    {t(lang, "close")}
                  </button>
                )}
              </div>
              <div className="p-1.5">
                {log.status === "idle" && (
                  <button
                    type="button"
                    onClick={() => void loadLog()}
                    className={`${ROW} text-left transition-colors hover:bg-bg-hover/40`}
                  >
                    <ScrollText size={14} className="flex-shrink-0 text-text-muted" />
                    <span className="text-[13px] leading-[18px] text-text-primary">
                      {t(lang, "pluginViewLog")}
                    </span>
                    <ChevronRight size={13} className="ml-auto flex-shrink-0 text-text-muted" />
                  </button>
                )}

                {log.status === "loading" && (
                  <LoadingText
                    label={t(lang, "pluginLogLoading")}
                    className="px-2 py-2 text-xs text-text-muted"
                  />
                )}

                {log.status === "error" && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-danger/45 px-2.5 py-2"
                  >
                    <CircleAlert size={13} className="mt-px flex-shrink-0 text-text-secondary" />
                    <p
                      className="min-w-0 flex-1 break-words text-[11px] leading-4 text-text-primary"
                      title={log.message}
                    >
                      {t(lang, "pluginLogLoadFailed")}
                    </p>
                    <button
                      type="button"
                      onClick={() => void loadLog()}
                      className="flex-shrink-0 text-[11px] font-medium text-text-secondary underline-offset-2 transition-colors hover:text-text-primary hover:underline"
                    >
                      {t(lang, "pluginLogRetry")}
                    </button>
                  </div>
                )}

                {log.status === "ready" && (
                  <pre className="plugin-log-pre max-h-56 overflow-auto whitespace-pre-wrap break-words px-2 py-2 font-mono text-[11px] leading-[18px] text-text-secondary">
                    {log.lines.length === 0 ? t(lang, "pluginLogEmpty") : log.lines.join("\n")}
                  </pre>
                )}
              </div>
            </section>
          )}

          {record && (
            <section className={`mt-3 ${CARD}`}>
              <div className={CARD_HEAD}>
                <h2 className={CARD_TITLE}>{t(lang, "pluginManage")}</h2>
              </div>
              {record.previousVersion && (
                <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3.5 py-2.5">
                  {/* A permanent caption, not a `title`: after a broken update
                      this row is the only way back, and `title` is hover-only -
                      invisible to keyboard and touch. */}
                  <p className="min-w-0 text-[11px] leading-4 text-text-muted">
                    {tWithParams(lang, "pluginRollbackHint", { version: record.previousVersion })}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void rollback(record.id)}
                    className={GHOST_BUTTON}
                  >
                    <RotateCcw size={12} />
                    {t(lang, "pluginRollback")}
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <p className="min-w-0 text-[11px] leading-4 text-text-muted">
                  {t(lang, "pluginUninstallConsequence")}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setUninstallOpen(true)}
                  className={DANGER_BUTTON}
                >
                  <Trash2 size={12} />
                  {t(lang, "pluginUninstall")}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>

      {uninstallOpen && record && (
        // Portalled by ModalShell, which is what makes this survive the
        // `container-type` ancestor: a hand-rolled `fixed inset-0` overlay is
        // clipped into the panel (and had no Escape, no focus return and no
        // accessible name).
        <ModalShell
          role="alertdialog"
          tone="danger"
          size="sm"
          // `TONE_TILE.danger` is `bg-danger/10 text-danger` - 2.2:1. The solid
          // tile is passed in whole so the icon never renders in danger-on-tint.
          icon={
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-danger text-on-danger">
              <Trash2 size={16} />
            </span>
          }
          title={tWithParams(lang, "pluginUninstallTitle", { name })}
          description={t(lang, "pluginUninstallBody")}
          onClose={() => setUninstallOpen(false)}
          initialFocusRef={keepDataRef}
          footer={
            <>
              <button
                type="button"
                onClick={() => setUninstallOpen(false)}
                className={GHOST_BUTTON}
              >
                {t(lang, "pluginPermPromptCancel")}
              </button>
              <button
                ref={keepDataRef}
                type="button"
                disabled={busy}
                onClick={() => confirmUninstall(true)}
                className={GHOST_BUTTON}
              >
                {t(lang, "pluginUninstallKeep")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => confirmUninstall(false)}
                className="flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-danger transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t(lang, "pluginUninstallDrop")}
              </button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-text-secondary">
            {t(lang, "pluginUninstallConsequence")}
          </p>
        </ModalShell>
      )}
    </div>
  );
};

/**
 * The permission prompt is mounted *outside* the selection-dependent body.
 *
 * It used to live inside it, after the "nothing selected" early return — which
 * meant the very first install (started from the sidebar, so with no selection)
 * staged the package and then showed nothing at all. The prompt has to be able
 * to appear no matter what the detail pane is showing.
 */
const PluginDetail: React.FC = () => {
  // The install prompt is *not* mounted here: it belongs to the app, not to
  // this view. `InstallPermissionPrompt` (mounted next to `ToastHost`) is its
  // only mount point, so "install from folder" works from every view.
  return <PluginDetailBody />;
};

export default PluginDetail;
