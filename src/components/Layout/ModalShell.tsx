import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { t } from "@/utils/i18n";
import { useSettingsStore } from "@/stores/settingsStore";

export type ModalTone = "accent" | "warning" | "danger" | "success";
export type ModalSize = "sm" | "md" | "lg" | "xl";

const TONE_TILE: Record<ModalTone, string> = {
  accent: "bg-accent-light text-accent-text",
  warning: "bg-warning/12 text-warning",
  danger: "bg-danger/10 text-danger",
  success: "bg-success/10 text-success",
};

/**
 * Widths are the ones the dialogs already used, rounded to one ladder so a new
 * dialog picks a size instead of inventing another `max-w-*`.
 */
const SIZE_PANEL: Record<ModalSize, string> = {
  sm: "max-w-[400px]",
  md: "max-w-[460px]",
  lg: "max-w-[560px]",
  xl: "max-w-[680px]",
};

interface ModalShellProps {
  onClose: () => void;
  title: ReactNode;
  /** One line under the title, 11px muted. Keep it short - it is a caption. */
  description?: ReactNode;
  icon?: ReactNode;
  tone?: ModalTone;
  size?: ModalSize;
  /** Tab strip rendered directly under the header (see the manage dialog). */
  tabs?: ReactNode;
  /** Right-aligned actions in the footer bar. */
  footer?: ReactNode;
  /** Left-aligned slot in the footer bar, e.g. a destructive side action. */
  footerStart?: ReactNode;
  /** Body. Scrolls by default; pass false when it owns its own scrollers. */
  scrollBody?: boolean;
  bodyClassName?: string;
  /** Blocks backdrop/Escape dismissal while a request is in flight. */
  closeDisabled?: boolean;
  role?: "dialog" | "alertdialog";
  /** Focus target on open; defaults to the panel itself. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * The one dialog shell.
 *
 * Every surface that opens over the app (confirmations, the workspace manage
 * dialog, the publication dialog, trash, move-to-folder, app prompts) renders
 * through this: one header height, one icon tile, one close button, one footer
 * bar, one shadow, one scrim. Before it, the same dialog was hand-built six
 * times with three different header paddings and two different scrims, which is
 * exactly what made the product feel assembled rather than designed.
 *
 * Responsiveness: the panel is capped by the viewport (not a fixed pixel
 * height), the body is the only element that scrolls, and the footer bar turns
 * into a column on narrow windows so two buttons never squeeze each other.
 */
export default function ModalShell({
  onClose,
  title,
  description,
  icon,
  tone = "accent",
  size = "md",
  tabs,
  footer,
  footerStart,
  scrollBody = true,
  bodyClassName = "",
  closeDisabled = false,
  role = "dialog",
  initialFocusRef,
  children,
}: ModalShellProps) {
  const lang = useSettingsStore((state) => state.lang);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Focus moves into the dialog so Escape and Tab work immediately, and returns
  // to whatever opened it on unmount.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target = initialFocusRef?.current ?? panelRef.current;
    target?.focus({ preventScroll: true });
    return () => {
      previous?.focus?.({ preventScroll: true });
    };
  }, [initialFocusRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!closeDisabled) onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeDisabled, onClose]);

  // Portalled: the cards keep `overflow: hidden` and some of them are container
  // query containers, both of which would otherwise trap a fixed overlay.
  return createPortal(
    <div
      className="app-modal-backdrop fixed inset-0 z-[10000] flex items-center justify-center px-3 py-4 sm:px-4"
      onMouseDown={(event) => {
        // Only a click that starts on the scrim dismisses; dragging a selection
        // out of an input must not close the dialog.
        if (event.target !== event.currentTarget || closeDisabled) return;
        onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`app-modal-panel flex max-h-[calc(100dvh-1.5rem)] w-full ${SIZE_PANEL[size]} flex-col overflow-hidden rounded-xl border border-border bg-bg-primary text-text-primary outline-none`}
      >
        <header className="flex flex-shrink-0 items-center gap-2.5 border-b border-border bg-bg-sidebar/45 px-4 py-3">
          {icon && (
            <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${TONE_TILE[tone]}`}>
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-sm font-semibold text-text-primary">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 truncate text-[11px] leading-4 text-text-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label={t(lang, "close")}
            title={t(lang, "close")}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={15} />
          </button>
        </header>

        {tabs && <div className="flex-shrink-0 border-b border-border bg-bg-sidebar/20">{tabs}</div>}

        {scrollBody ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-gutter:stable]">
            {children}
          </div>
        ) : (
          <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${bodyClassName}`}>
            {children}
          </div>
        )}

        {(footer || footerStart) && (
          <footer className="flex flex-shrink-0 flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">{footerStart}</div>
            <div className="flex flex-shrink-0 items-center justify-end gap-2">{footer}</div>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
