import { AlertCircle, Download, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import type { UpdatePhase } from "@/stores/updateStore";
import { t, tWithParams } from "@/utils/i18n";
import type { UpdateProgressPayload } from "@/utils/updateChecker";

interface UpdateStatusPanelProps {
  phase: UpdatePhase;
  progress: UpdateProgressPayload | null;
  error: string;
  onDownload: () => void;
  onInstall: () => void;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 下载 / 就绪 / 失败三种状态的唯一画法，顶栏卡片与帮助弹窗共用。
 *
 * 进度只能靠 `update:progress` 事件：下载走 Rust 侧，前端拿不到流。安装阶段没有事件可
 * 观察 —— 进程会在启动安装器后结束，所以这里画一行提示而不是进度。
 */
export default function UpdateStatusPanel({
  phase,
  progress,
  error,
  onDownload,
  onInstall,
}: UpdateStatusPanelProps) {
  const lang = useSettingsStore((state) => state.lang);

  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  if (phase === "downloading") {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>
            {tWithParams(lang, "updateDownloading", {
              percent: percent === null ? "…" : String(percent),
            })}
          </span>
          <span className="shrink-0 tabular-nums text-text-muted">
            {formatMegabytes(progress?.downloaded ?? 0)}
            {progress?.total ? ` / ${formatMegabytes(progress.total)}` : ""}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-hover">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)]"
            style={{ width: `${percent ?? 0}%` }}
          />
        </div>
        <p className="text-[11px] leading-4 text-text-muted">{t(lang, "updateRestartHint")}</p>
      </div>
    );
  }

  if (phase === "installing") {
    return (
      <div className="flex items-center gap-2 text-xs text-accent-text">
        <Loader2 size={14} className="animate-spin" />
        <span>{t(lang, "updateInstalling")}</span>
      </div>
    );
  }

  if (phase === "ready") {
    return (
      <div className="space-y-2">
        <p className="text-[11px] leading-4 text-text-muted">{t(lang, "updateReadyHint")}</p>
        <button
          type="button"
          onClick={onInstall}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-accent-hover"
        >
          <RotateCcw size={13} />
          {t(lang, "updateReadyAction")}
        </button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-danger">
          <AlertCircle size={14} />
          <span>{t(lang, "updateInstallFailed")}</span>
        </div>
        {error && (
          <p className="max-h-16 overflow-y-auto break-words text-[11px] leading-4 text-text-muted">
            {tWithParams(lang, "updateCheckErrorDetail", { detail: error })}
          </p>
        )}
        <button
          type="button"
          onClick={onDownload}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary"
        >
          <RefreshCw size={13} />
          {t(lang, "retry")}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onDownload}
      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-accent-hover"
    >
      <Download size={13} />
      {t(lang, "updateNow")}
    </button>
  );
}
