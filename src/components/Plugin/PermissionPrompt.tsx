import React from "react";
import { ShieldCheck } from "lucide-react";
import type { LangType } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import type { PluginInstallPrompt } from "@/plugin/types";
import PermissionList from "./PermissionList";

interface PermissionPromptProps {
  state: PluginInstallPrompt | null;
  lang: LangType;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The one moment where a plugin's reach is actually visible.
 *
 * No default focus on "allow": the dialog opens with the cancel button focused,
 * so an Enter pressed out of habit does not grant anything. The permission rows
 * are the same component the detail pane uses, so what the user approves here is
 * literally the list they will see afterwards.
 */
const PermissionPrompt: React.FC<PermissionPromptProps> = ({
  state,
  lang,
  busy = false,
  onCancel,
  onConfirm,
}) => {
  if (!state) return null;
  const name = state.manifest.name || state.manifest.id;
  const isUpdate = state.mode === "update";

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="app-modal-backdrop absolute inset-0" onClick={busy ? undefined : onCancel} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-permission-title"
        className="isolate surface-glass surface-glass--dialog relative flex w-[min(520px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-border bg-bg-primary shadow-2xl"
      >
        <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
            <ShieldCheck size={16} />
          </span>
          <h1 id="plugin-permission-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
            {tWithParams(
              lang,
              isUpdate ? "pluginPermPromptUpdateTitle" : "pluginPermPromptInstallTitle",
              { name },
            )}
          </h1>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-2.5 text-xs leading-relaxed text-text-secondary">
            {t(lang, isUpdate ? "pluginPermPromptAddedBody" : "pluginPermPromptBody")}
          </p>
          <PermissionList
            permissions={isUpdate ? state.added : state.permissions}
            lang={lang}
            emphasize={isUpdate ? state.added : []}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-text-muted">
            {t(lang, "pluginsSidebarFooterHint")}
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-60"
          >
            {t(lang, "pluginPermPromptCancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
          >
            {t(
              lang,
              isUpdate ? "pluginPermPromptUpdate" : "pluginPermPromptApprove",
            )}
          </button>
        </footer>
      </section>
    </div>
  );
};

export default PermissionPrompt;
