import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import { APP_VERSION, checkForUpdate, type UpdateInfo } from "@/utils/updateChecker";
import ModalShell from "@/components/Layout/ModalShell";
import UpdateAction from "@/components/Help/UpdateAction";

type UpdateState = "checking" | "upToDate" | "newVersion" | "error";

interface UpdateCheckModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * First-class "check for updates" entry (Help → Check for Updates).
 *
 * 这一版起「有新版本」不再是跳浏览器：源解析、签名校验、下载与安装都在 Rust 侧
 * 完成，这里只负责把状态画出来。四种状态保持显式，失败状态仍然带着底层原因和重试。
 */
export default function UpdateCheckModal({ open, onClose }: UpdateCheckModalProps) {
  const lang = useSettingsStore((state) => state.lang);
  const [state, setState] = useState<UpdateState>("checking");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const check = useCallback(async () => {
    const id = ++requestId.current;
    setState("checking");
    setError("");
    try {
      const result = await checkForUpdate();
      if (id !== requestId.current) return;
      setInfo(result);
      setState(result ? "newVersion" : "upToDate");
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (open) {
      void check();
    } else {
      requestId.current += 1;
      setBusy(false);
    }
  }, [open, check]);

  if (!open) return null;

  return (
    <ModalShell
      onClose={busy ? () => {} : onClose}
      title={t(lang, "checkUpdate")}
      description={`${t(lang, "currentVersion")} v${APP_VERSION}`}
      icon={<RefreshCw size={16} />}
      size="sm"
    >
      <div className="rounded-lg border border-border bg-bg-secondary/40 px-3 py-2.5">
        {state === "checking" && (
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>{t(lang, "checkingUpdate")}</span>
            <Loader2 size={14} className="animate-spin text-accent-text" />
          </div>
        )}

        {state === "upToDate" && (
          <div className="flex items-center gap-2 text-xs text-success">
            <CheckCircle size={14} />
            <span>{t(lang, "upToDate")}</span>
          </div>
        )}

        {state === "newVersion" && info && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 text-xs text-accent-text">
              <Sparkles size={14} />
              <span>{tWithParams(lang, "newVersion", { version: info.version })}</span>
            </div>
            {info.body && (
              <p className="max-h-24 overflow-y-auto whitespace-pre-line break-words text-[11px] leading-4 text-text-muted">
                {info.body}
              </p>
            )}
            <UpdateAction onBusyChange={setBusy} />
          </div>
        )}

        {state === "error" && (
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
      </div>
    </ModalShell>
  );
}
