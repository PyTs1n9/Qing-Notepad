import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, Download, Loader2, RefreshCw } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import {
  installUpdate,
  UPDATE_INSTALLING_EVENT,
  UPDATE_PROGRESS_EVENT,
  type UpdateProgressPayload,
} from "@/utils/updateChecker";

type Phase = "idle" | "downloading" | "installing" | "error";

interface UpdateActionProps {
  /** 进度起来之后父层要把"稍后 / 不再提醒"之类的出口关掉，否则用户会以为取消成功。 */
  onBusyChange?: (busy: boolean) => void;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 更新的唯一执行入口：检查弹窗与启动提示共用这一个组件。
 *
 * 进度只能靠事件拿 —— Windows 上安装阶段进程会被结束，
 * `installUpdate()` 的 promise 不会走到"成功"分支。见 `updateChecker.ts` 的注释。
 */
export default function UpdateAction({ onBusyChange }: UpdateActionProps) {
  const lang = useSettingsStore((state) => state.lang);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UpdateProgressPayload | null>(null);
  const [error, setError] = useState("");

  // 事件回调里要读"当前阶段"，但监听只注册一次；用 ref 避免把阶段的每次变化
  // 都变成一次重新订阅。`onBusyChange` 同理，父层传内联箭头函数也不会重订阅。
  const phaseRef = useRef<Phase>("idle");
  const busyRef = useRef(onBusyChange);
  useEffect(() => {
    busyRef.current = onBusyChange;
  }, [onBusyChange]);

  const enter = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
    busyRef.current?.(next === "downloading" || next === "installing");
  }, []);

  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];

    const keep = (stop: () => void) => {
      if (disposed) stop();
      else stops.push(stop);
    };

    void listen<UpdateProgressPayload>(UPDATE_PROGRESS_EVENT, (event) => {
      if (disposed) return;
      setProgress(event.payload);
      if (phaseRef.current !== "downloading") enter("downloading");
    }).then(keep);

    void listen(UPDATE_INSTALLING_EVENT, () => {
      if (disposed) return;
      enter("installing");
    }).then(keep);

    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [enter]);

  const start = useCallback(async () => {
    setError("");
    setProgress({ downloaded: 0, total: null });
    enter("downloading");
    try {
      await installUpdate();
    } catch (cause) {
      // 安装阶段进程被结束会让 IPC 直接断掉，那不是失败，是预期内的收尾。
      if (phaseRef.current === "installing") return;
      setError(cause instanceof Error ? cause.message : String(cause));
      enter("error");
    }
  }, [enter]);

  const percent = progress && progress.total && progress.total > 0
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

  if (phase === "error") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-danger">
          <AlertCircle size={14} />
          <span>{t(lang, "updateInstallFailed")}</span>
        </div>
        {error && (
          <p className="break-words text-[11px] leading-4 text-text-muted">
            {tWithParams(lang, "updateCheckErrorDetail", { detail: error })}
          </p>
        )}
        <button
          type="button"
          onClick={() => void start()}
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
      onClick={() => void start()}
      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-accent-hover"
    >
      <Download size={13} />
      {t(lang, "updateNow")}
    </button>
  );
}
