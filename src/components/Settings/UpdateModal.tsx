import { BellOff, Clock3, Download } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import ModalShell from "@/components/Layout/ModalShell";

interface UpdateModalProps {
  currentVersion: string;
  latestVersion: string;
  onUpdateNow: () => void;
  onUpdateLater: () => void;
  onNeverRemind: () => void;
}

export default function UpdateModal({
  currentVersion,
  latestVersion,
  onUpdateNow,
  onUpdateLater,
  onNeverRemind,
}: UpdateModalProps) {
  const lang = useSettingsStore((state) => state.lang);

  return (
    <ModalShell
      onClose={onUpdateLater}
      title={t(lang, "updateAvailableTitle")}
      description={tWithParams(lang, "updateAvailableMessage", { version: latestVersion })}
      icon={<Download size={16} />}
      size="sm"
      footer={(
        <>
          <button
            type="button"
            onClick={onNeverRemind}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <BellOff size={13} />
            {t(lang, "neverRemind")}
          </button>
          <button
            type="button"
            onClick={onUpdateLater}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <Clock3 size={13} />
            {t(lang, "updateLater")}
          </button>
          <button
            type="button"
            onClick={onUpdateNow}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
          >
            <Download size={13} />
            {t(lang, "updateNow")}
          </button>
        </>
      )}
    >
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-bg-secondary/40 px-3 py-2.5 text-xs">
        <div>
          <div className="text-text-muted">{t(lang, "currentVersion")}</div>
          <div className="mt-0.5 font-medium tabular-nums text-text-primary">v{currentVersion}</div>
        </div>
        <div>
          <div className="text-text-muted">{t(lang, "latestVersion")}</div>
          <div className="mt-0.5 font-medium tabular-nums text-accent-text">v{latestVersion}</div>
        </div>
      </div>
    </ModalShell>
  );
}
