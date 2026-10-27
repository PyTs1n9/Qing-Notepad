import React from "react";
import { Bell, CheckSquare, Clipboard, Database, FileText } from "lucide-react";
import type { LangType } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import {
  PERMISSION_LABEL_KEYS,
  isPluginPermission,
  type PluginPermission,
} from "@/plugin/types";

interface PermissionListProps {
  permissions: readonly string[];
  lang: LangType;
  /** Rendered with an accent mark: the ones a version bump just added. */
  emphasize?: readonly string[];
  onRevoke?: (permission: PluginPermission) => void;
  /** False hides the revoke action for that row (e.g. an implied read grant). */
  canRevoke?: (permission: PluginPermission) => boolean;
  /** Shown instead of the list when nothing was declared. */
  emptyLabel?: string;
}

const ICONS: Record<PluginPermission, React.ComponentType<{ size?: number; className?: string }>> = {
  storage: Database,
  "notes:read": FileText,
  "notes:write": FileText,
  "todo:read": CheckSquare,
  "todo:write": CheckSquare,
  "clipboard:read": Clipboard,
  "clipboard:write": Clipboard,
  notify: Bell,
};

/**
 * One row per permission, in plain language.
 *
 * The wording lives in `i18n` rather than here because this list is the main
 * thing a user reads before trusting a package — it has to be translatable and
 * it has to be identical in the install prompt and the detail pane.
 */
const PermissionList: React.FC<PermissionListProps> = ({
  permissions,
  lang,
  emphasize = [],
  onRevoke,
  canRevoke,
  emptyLabel,
}) => {
  const rows = permissions.filter(isPluginPermission);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-text-muted">
        {emptyLabel ?? t(lang, "pluginPermissionsNone")}
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {rows.map((permission) => {
        const Icon = ICONS[permission];
        const added = emphasize.includes(permission);
        return (
          <li
            key={permission}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-bg-secondary/40 px-2.5 py-1.5"
          >
            <Icon size={13} className="flex-shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1 text-xs text-text-primary">
              {t(lang, PERMISSION_LABEL_KEYS[permission])}
            </span>
            {added && (
              <span className="flex-shrink-0 rounded bg-accent-light px-1.5 py-0.5 text-[10px] font-medium text-accent-text">
                {t(lang, "pluginPermissionNew")}
              </span>
            )}
            <code className="flex-shrink-0 text-[10px] text-text-muted">{permission}</code>
            {onRevoke && !added && (!canRevoke || canRevoke(permission)) && (
              <button
                type="button"
                onClick={() => onRevoke(permission)}
                className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-danger"
              >
                {t(lang, "pluginPermissionRevoke")}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export default PermissionList;
