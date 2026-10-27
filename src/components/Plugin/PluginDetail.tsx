import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine,
  ArrowUp,
  ExternalLink,
  Puzzle,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  countUpdates,
  findIndexEntry,
  findInstalled,
  isUpdateAvailable,
  usePluginStore,
} from "@/plugin/store";
import {
  beginInstallFromIndex,
  cancelPendingInstall,
  confirmPendingInstall,
} from "@/plugin/install";
import {
  authorName,
  hasPermission,
  manifestCommands,
  isPluginPermission,
  manifestPermissions,
  type InstalledPlugin,
  type PluginPermission,
} from "@/plugin/types";
import { deactivatePlugin } from "@/plugin/headless";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import PermissionList from "./PermissionList";
import PermissionPrompt from "./PermissionPrompt";

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="mt-5">
    <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
      {title}
    </h2>
    {children}
  </section>
);

const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-3 border-b border-border/60 py-1.5 last:border-b-0">
    <span className="w-20 flex-shrink-0 text-[11px] text-text-muted">{label}</span>
    <span className="min-w-0 flex-1 break-words text-[11px] text-text-secondary">{children}</span>
  </div>
);

const EmptyState: React.FC<{ lang: "zh" | "en" }> = ({ lang }) => (
  <div className="flex h-full flex-col items-center justify-center px-6 text-center">
    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-bg-secondary text-text-muted">
      <Puzzle size={20} />
    </span>
    <h2 className="mt-3 text-sm font-medium text-text-primary">{t(lang, "pluginsSelectHint")}</h2>
    <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-text-muted">
      {t(lang, "pluginsSelectHintBody")}
    </p>
  </div>
);

/**
 * Main pane of the extensions page.
 *
 * It resolves the selection from *either* list: an id can name an installed
 * plugin (show version, permissions, actions) or only an index entry (show the
 * install action). When it names both, the installed record wins and the index
 * entry is used only to decide whether an update exists.
 */
const PluginDetailBody: React.FC = () => {
  const lang = useSettingsStore((state) => state.lang);
  const installed = usePluginStore((state) => state.installed);
  const index = usePluginStore((state) => state.index);
  const selectedId = usePluginStore((state) => state.selectedId);
  const lastError = usePluginStore((state) => state.lastError);
  const busy = usePluginStore((state) => state.installBusy);
  const setEnabled = usePluginStore((state) => state.setEnabled);
  const rollback = usePluginStore((state) => state.rollback);
  const uninstall = usePluginStore((state) => state.uninstall);
  const setPermissions = usePluginStore((state) => state.setPermissions);

  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [logLines, setLogLines] = useState<string[] | null>(null);

  // A different plugin must not inherit the previous one's confirm dialog.
  useEffect(() => {
    setUninstallOpen(false);
    setLogLines(null);
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
  const repository = manifest?.repository ?? entry?.repo ?? null;
  const declared = useMemo(
    () => (manifest ? manifestPermissions(manifest) : (entry?.permissions ?? [])),
    [manifest, entry],
  );

  const loadLog = useCallback(async () => {
    if (!record) return;
    try {
      const lines = await invoke<string[]>("plugin_read_log", { id: record.id });
      setLogLines(lines);
    } catch (error) {
      setLogLines([String(error)]);
    }
  }, [record]);

  if (!selectedId || (!record && !entry)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border px-3">
          <h1 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            {t(lang, "pluginsTitle")}
          </h1>
          {updates > 0 && (
            <span className="rounded bg-accent-light px-1.5 py-0.5 text-[10px] font-medium text-accent-text">
              {updates}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {lastError ? (
            // The empty state is exactly where a first install lands when it is
            // refused, so the reason has to be readable here rather than only in
            // a toast that has already faded.
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <p className="max-w-md rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-danger">
                {lastError}
              </p>
              <button
                type="button"
                onClick={() => usePluginStore.getState().setLastError(null)}
                className="mt-3 rounded-lg border border-border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {t(lang, "close")}
              </button>
            </div>
          ) : (
            <EmptyState lang={lang} />
          )}
        </div>
      </div>
    );
  }

  const granted = record?.grantedPermissions ?? [];
  const impliedRead = (permission: PluginPermission) =>
    (permission === "notes:read" && hasPermission(granted, "notes:write")) ||
    (permission === "todo:read" && hasPermission(granted, "todo:write"));

  const revoke = (permission: PluginPermission) => {
    if (!record) return;
    const next = granted.filter(
      (item) =>
        item !== permission &&
        !(permission === "notes:write" && item === "notes:read") &&
        !(permission === "todo:write" && item === "todo:read"),
    );
    void setPermissions(record.id, next);
  };

  const commands = manifest ? manifestCommands(manifest) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border px-3">
        <h1 className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {t(lang, "pluginsTitle")}
        </h1>
        <span className="min-w-0 truncate text-[11px] text-text-muted">/ {name}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent-light text-accent-text">
            <Puzzle size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-sm font-semibold text-text-primary">{name}</h2>
              {updateAvailable && (
                <span className="flex items-center gap-1 rounded bg-accent-light px-1.5 py-0.5 text-[10px] font-medium text-accent-text">
                  <ArrowUp size={10} />
                  {t(lang, "pluginUpdateAvailable")}
                </span>
              )}
              {record && !record.enabled && (
                <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">
                  {t(lang, "pluginDisabled")}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-text-muted">
              {[author, version ? `v${version}` : null].filter(Boolean).join(" · ")}
            </p>
          </div>

          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
            {!record && entry && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void beginInstallFromIndex(entry)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-on-accent transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
              >
                <ArrowDownToLine size={12} />
                {t(lang, "pluginInstall")}
              </button>
            )}
            {record && updateAvailable && entry && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void beginInstallFromIndex(entry)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-on-accent transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
              >
                <ArrowUp size={12} />
                {t(lang, "pluginUpdate")}
              </button>
            )}
            {record && (
              <>
                <button
                  type="button"
                  onClick={() => void setEnabled(record.id, !record.enabled)}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                >
                  {t(lang, record.enabled ? "pluginDisable" : "pluginEnable")}
                </button>
                {record.previousVersion && (
                  <button
                    type="button"
                    onClick={() => void rollback(record.id)}
                    title={`v${record.previousVersion}`}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    <RotateCcw size={12} />
                    {t(lang, "pluginRollback")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setUninstallOpen(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-danger/40 px-2.5 py-1.5 text-[11px] text-danger transition-colors hover:bg-danger/10"
                >
                  <Trash2 size={12} />
                  {t(lang, "pluginUninstall")}
                </button>
              </>
            )}
          </div>
        </div>

        {description && (
          <p className="mt-3 max-w-2xl text-xs leading-relaxed text-text-secondary">{description}</p>
        )}

        {lastError && (
          <p className="mt-3 rounded-lg border border-danger/40 bg-danger/5 px-2.5 py-1.5 text-[11px] text-danger">
            {lastError}
          </p>
        )}

        <Section title={t(lang, "pluginPermissions")}>
          <PermissionList
            permissions={record ? granted : declared}
            lang={lang}
            onRevoke={record ? revoke : undefined}
            canRevoke={(permission) => !impliedRead(permission)}
            missing={
              record
                ? declared.filter(
                    (permission) => isPluginPermission(permission) && !hasPermission(granted, permission),
                  )
                : []
            }
            onGrant={
              record
                ? (permission) => void setPermissions(record.id, [...granted, permission])
                : undefined
            }
          />
          {record && granted.length > 0 && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-text-muted">
              {t(lang, "pluginLockedNote")}
            </p>
          )}
        </Section>

        <Section title={t(lang, "pluginCommands")}>
          {commands.length === 0 ? (
            <p className="text-xs text-text-muted">{t(lang, "pluginNoCommands")}</p>
          ) : (
            <ul className="space-y-1">
              {commands.map((command) => (
                <li
                  key={command.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-bg-secondary/40 px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                    {command.title}
                  </span>
                  {command.category && (
                    <span className="flex-shrink-0 text-[10px] text-text-muted">{command.category}</span>
                  )}
                  <span className="flex-shrink-0 text-[10px] text-text-muted">Ctrl+Shift+P</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t(lang, "pluginInfo")}>
          <div className="rounded-lg border border-border bg-bg-secondary/40 px-3 py-1">
            <MetaRow label="ID">
              <code className="text-[10px]">{record?.id ?? entry?.id}</code>
            </MetaRow>
            {version && <MetaRow label={t(lang, "pluginVersion")}>v{version}</MetaRow>}
            {record && (
              <MetaRow label={t(lang, "pluginSource")}>
                {record.source === "index" ? t(lang, "pluginSourceIndex") : t(lang, "pluginSourceFile")}
              </MetaRow>
            )}
            {manifest?.license && (
              <MetaRow label={t(lang, "pluginLicense")}>{manifest.license}</MetaRow>
            )}
            {repository && (
              <MetaRow label={t(lang, "pluginRepository")}>
                <button
                  type="button"
                  onClick={() => void openInDefaultBrowser(repository)}
                  className="inline-flex max-w-full items-center gap-1 truncate text-accent-text hover:underline"
                >
                  <span className="truncate">{repository}</span>
                  <ExternalLink size={10} className="flex-shrink-0" />
                </button>
              </MetaRow>
            )}
          </div>
        </Section>

        {record && (
          <Section title={t(lang, "pluginViewLog")}>
            {logLines === null ? (
              <button
                type="button"
                onClick={() => void loadLog()}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <ScrollText size={12} />
                {t(lang, "pluginViewLog")}
              </button>
            ) : (
              <div className="rounded-lg border border-border bg-bg-primary">
                <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
                  <span className="text-[10px] text-text-muted">{t(lang, "pluginLogTitle")}</span>
                  <button
                    type="button"
                    onClick={() => setLogLines(null)}
                    className="text-[10px] text-text-secondary hover:text-text-primary"
                  >
                    {t(lang, "close")}
                  </button>
                </div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-[10px] leading-relaxed text-text-secondary">
                  {logLines.length === 0 ? t(lang, "pluginLogEmpty") : logLines.join("\n")}
                </pre>
              </div>
            )}
          </Section>
        )}
      </div>

      {uninstallOpen && record && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <div className="app-modal-backdrop absolute inset-0" onClick={() => setUninstallOpen(false)} />
          <section
            role="dialog"
            aria-modal="true"
            className="isolate surface-glass surface-glass--dialog relative w-[min(440px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border bg-bg-primary shadow-2xl"
          >
            <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
                <ShieldCheck size={16} />
              </span>
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
                {t(lang, "pluginUninstallTitle").replace("{name}", name)}
              </h2>
            </header>
            <p className="px-4 py-3 text-xs leading-relaxed text-text-secondary">
              {t(lang, "pluginUninstallBody")}
            </p>
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setUninstallOpen(false)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {t(lang, "pluginPermPromptCancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUninstallOpen(false);
                  deactivatePlugin(record.id);
                  void uninstall(record.id, true);
                }}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {t(lang, "pluginUninstallKeep")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUninstallOpen(false);
                  deactivatePlugin(record.id);
                  void uninstall(record.id, false);
                }}
                className="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-on-danger transition-opacity hover:opacity-90"
              >
                {t(lang, "pluginUninstallDrop")}
              </button>
            </footer>
          </section>
        </div>
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
  const lang = useSettingsStore((state) => state.lang);
  const installPrompt = usePluginStore((state) => state.installPrompt);
  const busy = usePluginStore((state) => state.installBusy);

  return (
    <>
      <PluginDetailBody />
      <PermissionPrompt
        state={installPrompt}
        lang={lang}
        busy={busy}
        onCancel={() => void cancelPendingInstall()}
        onConfirm={() => void confirmPendingInstall()}
      />
    </>
  );
};

export default PluginDetail;
