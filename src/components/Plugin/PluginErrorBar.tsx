import { CircleAlert, X } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

interface PluginErrorBarProps {
  message: string;
  onDismiss: () => void;
}

/**
 * The one failure strip of the extensions page.
 *
 * It used to be a `text-danger` paragraph painted on `bg-danger/5`: on the
 * yellow and green themes `danger` lands at 2.47:1 and 2.51:1 against the page,
 * so the error was the least readable text on screen. The semantic colour now
 * lives in the border and the icon only; the copy itself is `text-primary`.
 *
 * `role="alert"` because this bar appears *after* the pane has rendered (an
 * install refused, a rollback failed) - there is no other cue that anything
 * went wrong once the toast has faded.
 */
export default function PluginErrorBar({ message, onDismiss }: PluginErrorBarProps) {
  const lang = useSettingsStore((state) => state.lang);

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-danger/45 px-2.5 py-2"
    >
      <CircleAlert size={13} className="mt-px flex-shrink-0 text-text-secondary" />
      <p className="min-w-0 flex-1 break-words text-[11px] leading-4 text-text-primary">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t(lang, "close")}
        title={t(lang, "close")}
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:text-text-primary"
      >
        <X size={12} />
      </button>
    </div>
  );
}
