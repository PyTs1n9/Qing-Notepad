import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUpdateStore } from "@/stores/updateStore";
import { t, tWithParams } from "@/utils/i18n";
import { APP_VERSION } from "@/utils/updateChecker";
import {
  beginUpdateDownload,
  installUpdateAndRestart,
  runUpdateCheck,
} from "@/hooks/updateActions";
import ModalShell from "@/components/Layout/ModalShell";
import UpdateNotes from "@/components/Help/UpdateNotes";
import UpdateStatusPanel from "@/components/Help/UpdateStatusPanel";

interface UpdateCheckModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 帮助菜单里的手动检查入口。
 *
 * 与顶栏徽标共用同一份状态（`updateStore`）与同一组动作：下载、就绪、失败三种画法都在
 * `UpdateStatusPanel` 里，这里只负责「检查中 / 已是最新 / 失败 / 有新版本」的取舍。
 * 手动检查强制穿过 1 小时限频 —— 用户点进来就是想知道此刻的结果。
 */
export default function UpdateCheckModal({ open, onClose }: UpdateCheckModalProps) {
  const lang = useSettingsStore((state) => state.lang);
  const available = useUpdateStore((state) => state.available);
  const phase = useUpdateStore((state) => state.phase);
  const progress = useUpdateStore((state) => state.progress);
  const error = useUpdateStore((state) => state.error);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      await runUpdateCheck(true);
    } catch {
      // 失败已经写进 store（`phase: "error"`），这里只负责收掉 spinner。
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (open) void check();
  }, [open, check]);

  if (!open) return null;

  const busy = phase === "downloading" || phase === "installing";

  return (
    <ModalShell
      onClose={busy ? () => {} : onClose}
      title={t(lang, "checkUpdate")}
      description={`${t(lang, "currentVersion")} v${APP_VERSION}`}
      icon={<RefreshCw size={16} />}
      size="sm"
    >
      <div className="rounded-lg border border-border bg-bg-secondary/40 px-3 py-2.5">
        {checking && !available && (
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>{t(lang, "checkingUpdate")}</span>
            <Loader2 size={14} className="animate-spin text-accent-text" />
          </div>
        )}

        {!checking && !available && phase === "error" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-danger">
              <AlertCircle size={14} />
              <span>{t(lang, "checkUpdateFailed")}</span>
            </div>
            {error && (
              <p className="break-words text-[11px] leading-4 text-text-muted">
                {tWithParams(lang, "updateCheckErrorDetail", { detail: error })}
              </p>
            )}
            <button
              type="button"
              onClick={() => void check()}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary"
            >
              <RefreshCw size={13} />
              {t(lang, "retry")}
            </button>
          </div>
        )}

        {!checking && !available && phase !== "error" && (
          <div className="flex items-center gap-2 text-xs text-success">
            <CheckCircle size={14} />
            <span>{t(lang, "upToDate")}</span>
          </div>
        )}

        {available && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 text-xs text-accent-text">
              <Sparkles size={14} />
              <span>{tWithParams(lang, "newVersion", { version: available.version })}</span>
            </div>
            {available.body && (
              <div className="max-h-40 overflow-y-auto">
                <UpdateNotes notes={available.body} />
              </div>
            )}
            <UpdateStatusPanel
              phase={phase}
              progress={progress}
              error={error}
              onDownload={() => void beginUpdateDownload()}
              onInstall={() => void installUpdateAndRestart()}
            />
          </div>
        )}
      </div>
    </ModalShell>
  );
}
