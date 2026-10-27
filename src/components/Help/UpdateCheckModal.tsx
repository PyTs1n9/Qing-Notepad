import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle, Download, Loader2, RefreshCw } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import { APP_VERSION, fetchLatestRelease, isVersionNewer } from "@/utils/updateChecker";
import ModalShell from "@/components/Layout/ModalShell";

type UpdateState = "checking" | "upToDate" | "newVersion" | "error";

interface UpdateCheckModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * First-class "check for updates" entry (Help → Check for Updates).
 *
 * The four states are explicit and the failure state carries the underlying
 * reason plus a retry, instead of the previous bare "Update check failed" label
 * buried two levels deep inside About.
 */
export default function UpdateCheckModal({ open, onClose }: UpdateCheckModalProps) {
  const lang = useSettingsStore((state) => state.lang);
  const [state, setState] = useState<UpdateState>("checking");
  const [latestVersion, setLatestVersion] = useState("");
  const [releaseUrl, setReleaseUrl] = useState("");
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const check = useCallback(async () => {
    const id = ++requestId.current;
    setState("checking");
    setError("");
    try {
      const release = await fetchLatestRelease();
      if (id !== requestId.current) return;
      setLatestVersion(release.version);
      setReleaseUrl(release.url);
      setState(isVersionNewer(release.version, APP_VERSION) ? "newVersion" : "upToDate");
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (open) void check();
    else requestId.current += 1;
  }, [open, check]);

  if (!open) return null;

  return (
    <ModalShell
      onClose={onClose}
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

        {state === "newVersion" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-accent-text">
              <Download size={14} />
              <span>{tWithParams(lang, "newVersion", { version: latestVersion })}</span>
            </div>
            <button
              type="button"
              onClick={() => void openInDefaultBrowser(releaseUrl)}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
            >
              <Download size={13} />
              {t(lang, "downloadUpdate")}
            </button>
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
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
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
