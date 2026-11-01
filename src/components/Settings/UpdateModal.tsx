import { useState } from "react";
import { BellOff, Clock3, Download } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import ModalShell from "@/components/Layout/ModalShell";
import UpdateAction from "@/components/Help/UpdateAction";

interface UpdateModalProps {
  currentVersion: string;
  latestVersion: string;
  onUpdateLater: () => void;
  onNeverRemind: () => void;
}

/**
 * 启动时发现新版本用的提示框。
 *
 * 「立刻更新」不再是打开浏览器 —— 它和帮助菜单里的检查更新走同一个
 * `UpdateAction`，点下去就是下载、安装、自动重启。进度起来之后
 * 「稍后 / 不再提醒」会禁用：安装已经开始，这时候给出口只会让人以为能取消。
 */
export default function UpdateModal({
  currentVersion,
  latestVersion,
  onUpdateLater,
  onNeverRemind,
}: UpdateModalProps) {
  const lang = useSettingsStore((state) => state.lang);
  const [busy, setBusy] = useState(false);

  return (
    <ModalShell
      onClose={busy ? () => {} : onUpdateLater}
      title={t(lang, "updateAvailableTitle")}
      description={tWithParams(lang, "updateAvailableMessage", { version: latestVersion })}
      icon={<Download size={16} />}
      size="sm"
      footer={(
        <>
          <button
            type="button"
            onClick={onNeverRemind}
            disabled={busy}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <BellOff size={13} />
            {t(lang, "neverRemind")}
          </button>
          <button
            type="button"
            onClick={onUpdateLater}
            disabled={busy}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-text-secondary transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Clock3 size={13} />
            {t(lang, "updateLater")}
          </button>
        </>
      )}
    >
      <div className="space-y-2.5">
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
        <UpdateAction onBusyChange={setBusy} />
      </div>
    </ModalShell>
  );
}
