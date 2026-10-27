import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  alertDialog,
  beginProgress,
  confirmDialog,
  endProgress,
  updateProgress,
} from "@/stores/dialogStore";
import { AlertTriangle, FolderOpen, HardDrive, RotateCcw } from "lucide-react";
import type { LangType } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import {
  adoptDataDirectory,
  getStorageLocation,
  migrateDataDirectory,
  probeStorageLocation,
  restoreDefaultDataDirectory,
  type StorageLocationState,
  type StorageProbeResult,
} from "@/utils/storage";

const PROGRESS_EVENT = "storage:migrate-progress";

interface MigrationProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
}


function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function describeFailure(error: unknown, lang: LangType): string {
  const detail = error instanceof Error ? error.message : String(error);
  // The Rust/JS layer prefixes an unreachable custom root; report it as such
  // instead of showing the raw sentinel.
  if (detail.startsWith("DATA_DIRECTORY_UNAVAILABLE:")) {
    return tWithParams(lang, "storageUnavailable", {
      path: detail.slice("DATA_DIRECTORY_UNAVAILABLE:".length),
    });
  }
  return tWithParams(lang, "storageMigrateFailed", { message: detail });
}

/**
 * Storage location settings.
 *
 * Moving the directory is a filesystem operation performed in Rust: same-volume
 * entries are renamed, cross-volume ones are copied and byte-verified before the
 * source is removed, and only a successful run rewrites the pointer file. The
 * app then reloads so every store re-reads from the new location.
 */
export default function StorageSection({ lang }: { lang: LangType }) {
  const [location, setLocation] = useState<StorageLocationState | null>(null);
  const [probe, setProbe] = useState<StorageProbeResult | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const state = await getStorageLocation();
    setLocation(state);
    setProbe(state.available ? await probeStorageLocation(state.path) : null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Registered once on mount: migrating is fast enough that waiting for a
  // listener set up after `busy` flips would miss the first events.
  useEffect(() => {
    const pending = listen<MigrationProgress>(PROGRESS_EVENT, (event) => {
      updateProgress(event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  const handleChangeDirectory = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;

    const target = await probeStorageLocation(selected);
    if (!target) return;

    // A folder that already holds a library is adopted as-is; nothing is moved.
    if (!target.isEmpty) {
      if (!target.isLibrary) {
        await alertDialog({
          title: t(lang, "storageChangeDir"),
          body: t(lang, "storageNotALibrary"),
          confirmLabel: t(lang, "dialogConfirm"),
          tone: "danger",
        });
        return;
      }
      const adopt = await confirmDialog({
        title: t(lang, "storageChangeDir"),
        body: tWithParams(lang, "storageAdoptBody", { files: target.fileCount }),
        confirmLabel: t(lang, "dialogConfirm"),
        cancelLabel: t(lang, "dialogCancel"),
        tone: "warning",
      });
      if (!adopt) return;
      setBusy(true);
      beginProgress({ title: t(lang, "storageChangeDir"), label: t(lang, "storageReloading") });
      try {
        await adoptDataDirectory(selected);
        window.location.reload();
      } catch (error) {
        endProgress();
        await alertDialog({
          title: t(lang, "storageChangeDir"),
          body: describeFailure(error, lang),
          confirmLabel: t(lang, "dialogConfirm"),
          tone: "danger",
        });
        setBusy(false);
      }
      return;
    }

    const confirmed = await confirmDialog({
      title: t(lang, "storageMigrateTitle"),
      body: tWithParams(lang, "storageMigrateBody", { path: selected }),
      confirmLabel: t(lang, "dialogConfirm"),
      cancelLabel: t(lang, "dialogCancel"),
      tone: "warning",
    });
    if (!confirmed) return;

    setBusy(true);
    beginProgress({ title: t(lang, "storageMigrateTitle"), label: t(lang, "storageMigratingStart") });
    try {
      const report = await migrateDataDirectory(selected);
      endProgress();
      await alertDialog({
        title: t(lang, "storageMigrateTitle"),
        body: tWithParams(lang, "storageMigrateDone", {
          files: report.files,
          size: formatBytes(report.bytes),
        }),
        confirmLabel: t(lang, "dialogConfirm"),
        tone: "info",
      });
      window.location.reload();
    } catch (error) {
      endProgress();
      await alertDialog({
        title: t(lang, "storageMigrateTitle"),
        body: describeFailure(error, lang),
        confirmLabel: t(lang, "dialogConfirm"),
        tone: "danger",
      });
      setBusy(false);
      await refresh();
    }
  }, [lang, refresh]);

  const handleRestoreDefault = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t(lang, "storageRestoreDefault"),
      body: tWithParams(lang, "storageRestoreMigrateBody", {
        path: location?.path || "…",
      }),
      confirmLabel: t(lang, "dialogConfirm"),
      cancelLabel: t(lang, "dialogCancel"),
      tone: "warning",
    });
    if (!confirmed) return;

    setBusy(true);
    beginProgress({ title: t(lang, "storageRestoreDefault"), label: t(lang, "storageMigratingStart") });
    try {
      const report = await restoreDefaultDataDirectory();
      endProgress();
      if (report) {
        await alertDialog({
          title: t(lang, "storageRestoreDefault"),
          body: tWithParams(lang, "storageMigrateDone", {
            files: report.files,
            size: formatBytes(report.bytes),
          }),
          confirmLabel: t(lang, "dialogConfirm"),
          tone: "info",
        });
      }
      window.location.reload();
    } catch (error) {
      endProgress();
      await alertDialog({
        title: t(lang, "storageRestoreDefault"),
        body: describeFailure(error, lang),
        confirmLabel: t(lang, "dialogConfirm"),
        tone: "danger",
      });
      setBusy(false);
      await refresh();
    }
  }, [lang, location?.path, refresh]);

  const unavailable = location !== null && !location.available;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-bg-secondary/35 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-accent-light text-accent-text">
            <HardDrive size={21} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-text-primary">{t(lang, "storageCurrent")}</h3>
              {location && (
                <span className="rounded-full bg-bg-hover px-2 py-0.5 text-[11px] font-medium text-text-muted">
                  {location.custom ? t(lang, "storageBadgeCustom") : t(lang, "storageBadgeDefault")}
                </span>
              )}
            </div>
            <p
              className="mt-1 break-all font-mono text-xs leading-relaxed text-text-secondary"
              title={location?.path ?? ""}
            >
              {location?.path || "—"}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {probe
                ? tWithParams(lang, "storageUsage", {
                    files: probe.fileCount,
                    size: formatBytes(probe.totalBytes),
                  })
                : null}
            </p>
          </div>
        </div>

        {unavailable && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2">
            <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 text-danger" />
            <p className="text-xs leading-relaxed text-text-primary">
              {tWithParams(lang, "storageUnavailable", { path: location?.path ?? "" })}
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleChangeDirectory()}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors
              hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          >
            <FolderOpen size={15} />
            {t(lang, "storageChangeDir")}
          </button>
          {location?.custom && (
            <button
              type="button"
              onClick={() => void handleRestoreDefault()}
              disabled={busy}
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary
                transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              <RotateCcw size={15} />
              {t(lang, "storageRestoreDefault")}
            </button>
          )}
        </div>

      </section>
    </div>
  );
}
