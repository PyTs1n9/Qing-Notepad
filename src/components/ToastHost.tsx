import React from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore } from "@/stores/toastStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

/**
 * The only place toasts are painted. Fixed to the viewport, bottom centre, so a
 * notice never lands under the cursor or over the editor's top bar.
 */
const ToastHost: React.FC = () => {
  const items = useToastStore((state) => state.items);
  const dismiss = useToastStore((state) => state.dismiss);
  const lang = useSettingsStore((state) => state.lang);

  if (items.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-5 z-[120] flex flex-col items-center gap-2 px-4"
    >
      {items.map((item) => {
        const Icon = item.tone === "danger" ? AlertTriangle : item.tone === "success" ? CheckCircle2 : Info;
        const accent = item.tone === "danger" ? "text-danger" : item.tone === "success" ? "text-success" : "text-accent-text";
        return (
          <div
            key={item.id}
            className="app-toast pointer-events-auto flex w-[min(420px,100%)] items-center gap-2 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs text-text-primary shadow-lg"
          >
            <Icon size={14} className={`flex-shrink-0 ${accent}`} />
            <span className="min-w-0 flex-1 break-words leading-relaxed">{item.message}</span>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label={t(lang, "close")}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default ToastHost;
