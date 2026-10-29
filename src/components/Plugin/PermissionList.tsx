import React from "react";
import {
  Bell,
  CheckSquare,
  Clipboard,
  Database,
  Eye,
  FileText,
  Highlighter,
  LayoutDashboard,
  PanelLeft,
  PenLine,
  Sparkles,
  TextCursorInput,
} from "lucide-react";
import type { LangType } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
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
  /**
   * Declared by the plugin but not currently granted. Shown after the granted
   * rows so a permission taken away can be given back without reinstalling.
   */
  missing?: readonly string[];
  onGrant?: (permission: PluginPermission) => void;
  /** Shown instead of the list when nothing was declared. */
  emptyLabel?: string;
  /** The row whose grant/revoke request is in flight; its action is disabled. */
  busyPermission?: string | null;
  /**
   * Extra permissions a revoke would also take away (a write grant carries its
   * read). Returns their labels; when non-empty the button explains itself in
   * `title`/`aria-description` instead of silently doing more than it says.
   */
  onRevokeAlso?: (permission: PluginPermission) => string[];
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
  // The editor codes get distinct icons rather than one shared one: the three
  // are different asks, and the install prompt is where the user decides.
  "editor:read": Eye,
  "editor:write": PenLine,
  "editor:decorate": Highlighter,
  views: PanelLeft,
  "editor:selection": TextCursorInput,
  "canvas:read": LayoutDashboard,
  "canvas:write": LayoutDashboard,
  "ai:summarize": Sparkles,
};

/**
 * A read grant that only exists because its write grant does. The store expands
 * the pair on write, so revoking the write takes the read with it - which is why
 * the row cannot be revoked on its own.
 */
const IMPLIED_BY: Partial<Record<PluginPermission, PluginPermission>> = {
  "notes:read": "notes:write",
  "todo:read": "todo:write",
};

// The colour is not in the base: `text-*` utilities have equal specificity, so
// appending an override would resolve by stylesheet order, not by class order.
// Revoke and grant pick their own.
const ACTION_BUTTON =
  "flex h-5 flex-shrink-0 items-center rounded px-1 text-[11px] font-medium underline-offset-2 transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50";

/**
 * One row per permission, in plain language.
 *
 * The wording lives in `i18n` rather than here because this list is the main
 * thing a user reads before trusting a package — it has to be translatable and
 * it has to be identical in the install prompt and the detail pane.
 *
 * The row is borderless by default: the caller's card supplies the frame, and
 * doubling it here put a 1px box inside every card in the product.
 */
const PermissionList: React.FC<PermissionListProps> = ({
  permissions,
  lang,
  emphasize = [],
  onRevoke,
  canRevoke,
  missing = [],
  onGrant,
  emptyLabel,
  busyPermission = null,
  onRevokeAlso,
}) => {
  const granted = permissions.filter(isPluginPermission);
  const absent = missing
    .filter(isPluginPermission)
    .filter((permission) => !granted.includes(permission));

  if (granted.length === 0 && absent.length === 0) {
    return (
      <p className="p-1.5 text-xs text-text-muted">
        {emptyLabel ?? t(lang, "pluginPermissionsNone")}
      </p>
    );
  }

  return (
    <ul className="space-y-0.5 p-1.5">
      {granted.map((permission) => {
        const Icon = ICONS[permission];
        const added = emphasize.includes(permission);
        const revocable = !canRevoke || canRevoke(permission);
        const impliedBy = IMPLIED_BY[permission];
        const alsoRevoked = onRevoke && revocable && !added ? onRevokeAlso?.(permission) ?? [] : [];
        const busy = busyPermission === permission;
        return (
          <li
            key={permission}
            className={`plugin-detail-row flex min-h-[34px] items-center gap-2.5 rounded-lg px-2 py-2 ${
              onRevoke && revocable && !added ? "transition-colors hover:bg-bg-hover/40" : ""
            }`}
          >
            <Icon size={14} className="flex-shrink-0 text-text-muted" />
            <span className="plugin-detail-label min-w-0 flex-1 text-[13px] leading-[18px] text-text-primary">
              {t(lang, PERMISSION_LABEL_KEYS[permission])}
            </span>
            {added && (
              <span className="inline-flex h-4 flex-shrink-0 items-center rounded border border-border bg-accent-light px-1 text-[10px] font-medium leading-none text-accent-text">
                {t(lang, "pluginPermissionNew")}
              </span>
            )}
            <code className="plugin-perm-code flex-shrink-0 font-mono text-[11px] text-text-muted">
              {permission}
            </code>
            {onRevoke && !added &&
              (revocable ? (
                <button
                  type="button"
                  onClick={() => onRevoke(permission)}
                  disabled={busy}
                  title={alsoRevoked.length > 0 ? tWithParams(lang, "pluginPermRevokeAlso", { list: alsoRevoked.join("、") }) : undefined}
                  aria-description={alsoRevoked.length > 0 ? tWithParams(lang, "pluginPermRevokeAlso", { list: alsoRevoked.join("、") }) : undefined}
                  className={`${ACTION_BUTTON} text-text-secondary hover:text-text-primary`}
                >
                  {t(lang, "pluginPermissionRevoke")}
                </button>
              ) : impliedBy ? (
                // Not a dead end any more: the row says why it cannot be taken
                // away on its own instead of dropping the action silently.
                <span className="flex-shrink-0 text-[10px] leading-3 text-text-muted">
                  {tWithParams(lang, "pluginPermImplied", {
                    permission: t(lang, PERMISSION_LABEL_KEYS[impliedBy]),
                  })}
                </span>
              ) : null)}
          </li>
        );
      })}

      {absent.map((permission) => {
        const Icon = ICONS[permission];
        const busy = busyPermission === permission;
        return (
          <li
            key={permission}
            className="plugin-detail-row flex min-h-[34px] items-center gap-2.5 rounded-lg border border-dashed border-border px-2 py-2"
          >
            <Icon size={14} className="flex-shrink-0 text-text-muted/70" />
            <span className="plugin-detail-label min-w-0 flex-1 text-[13px] leading-[18px] text-text-secondary">
              {t(lang, PERMISSION_LABEL_KEYS[permission])}
            </span>
            <code className="plugin-perm-code flex-shrink-0 font-mono text-[11px] text-text-muted">
              {permission}
            </code>
            {onGrant && (
              <button
                type="button"
                onClick={() => onGrant(permission)}
                disabled={busy}
                className={`${ACTION_BUTTON} text-accent-text hover:text-text-primary`}
              >
                {t(lang, "pluginPermissionGrant")}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export default PermissionList;
