/**
 * The install-time permission prompt, mounted where the *user* is.
 *
 * It used to live inside `PluginDetail`, which only exists inside the plugins
 * view — so "install from folder" triggered from the note view (or anywhere
 * else) put a prompt in the store and drew nothing at all. The user's reading of
 * that is "I clicked and nothing happened", which is worse than a refusal: it
 * teaches them the button is broken. This is the same shape as the earlier
 * "prompt hidden behind a selection" bug — the dialog's *mount condition* was
 * coupled to some unrelated view state — and the fix is the same: give it one
 * mount point that does not depend on which view is showing, next to `ToastHost`.
 *
 * The prompt itself stays a presentational component with props; this is only
 * the wiring.
 */
import React from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { usePluginStore } from "@/plugin/store";
import { cancelPendingInstall, confirmPendingInstall } from "@/plugin/install";
import PermissionPrompt from "./PermissionPrompt";

const InstallPermissionPrompt: React.FC = () => {
  const lang = useSettingsStore((state) => state.lang);
  const state = usePluginStore((state) => state.installPrompt);
  const busy = usePluginStore((state) => state.installBusy);

  return (
    <PermissionPrompt
      state={state}
      lang={lang}
      busy={busy}
      onCancel={() => void cancelPendingInstall()}
      onConfirm={() => void confirmPendingInstall()}
    />
  );
};

export default InstallPermissionPrompt;
