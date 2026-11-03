import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, type LucideIcon } from "lucide-react";

export interface DropdownAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Right-aligned accelerator text, e.g. `Ctrl+Shift+E`. */
  shortcut?: string;
  /** Second line under the label: why an action is unavailable, or what it does. */
  hint?: string;
  disabled?: boolean;
  /** Required whenever `disabled` is set — a greyed button with no reason is a defect. */
  disabledReason?: string;
  danger?: boolean;
  /**
   * Radio state. The presence of the key (true or false) reserves the left slot
   * for a check mark, so a list of mutually exclusive items keeps one text column.
   */
  checked?: boolean;
  onSelect: () => void;
}

export type DropdownEntry = DropdownAction | { separator: true };

const isSeparator = (entry: DropdownEntry): entry is { separator: true } =>
  (entry as { separator?: boolean }).separator === true;

const PANEL_WIDTH = 224;
const VIEWPORT_MARGIN = 8;
const GAP = 2;

/** Both item roles are actionable; the arrow-key walk must see the same set. */
const ITEM_SELECTOR =
  '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])';

interface DropdownMenuProps {
  /** Accessible name of the trigger; also the default tooltip. */
  label: string;
  /** Icon trigger. Omit this and `triggerLabel` to get an empty trigger. */
  icon?: LucideIcon;
  /**
   * Text trigger. Used by the editor menu bar, where a row of words reads as a
   * menu bar and a row of icons reads as a toolbar.
   */
  triggerLabel?: string;
  entries: DropdownEntry[];
  align?: "start" | "end";
  triggerClassName?: string;
  iconSize?: number;
  /** Cap the panel and scroll. A 20-item menu must not exceed the window. */
  maxHeight?: number;
  /** Controlled mode, required for a menu bar where only one panel is open. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Fired when the pointer enters the trigger; a menu bar switches panels here. */
  onTriggerHover?: () => void;
  /** ArrowLeft / ArrowRight inside the panel; a menu bar moves between menus. */
  onNavigate?: (direction: -1 | 1) => void;
}

/**
 * The single dropdown implementation in the app.
 *
 * Contract:
 * - a fixed 224px panel, never content-sized
 * - one visual language: groups via `{ separator: true }`, icons left, accelerators right
 * - a disabled item always carries `disabledReason`, rendered as a second line because
 *   Chromium never fires pointer events on a `disabled` control (so `title` alone
 *   would never show up)
 * - keyboard: Escape / ArrowUp / ArrowDown / Home / End / Tab, focus returns to the
 *   trigger on Escape
 * - the panel is `position: fixed` and flips above the trigger when the viewport
 *   bottom is too close, so a narrow or short window never clips it
 * - the panel is rendered through a portal on `document.body`. Fixed positioning
 *   alone is not enough: the editor card carries `container-type: inline-size`,
 *   which implies `contain: layout` and therefore makes that card the containing
 *   block for fixed descendants — the panel would be positioned against the card
 *   and then clipped by its `overflow: hidden`. A portal escapes both.
 * - no submenus. The editor menu uses grouping + `maxHeight` instead; a second
 *   level would need a hover-intent model and a second flip axis for no item that
 *   actually needs two dimensions (see docs/decisions-editor-menubar.md).
 */
export default function DropdownMenu({
  label,
  icon: Icon,
  triggerLabel,
  entries,
  align = "end",
  triggerClassName = "",
  iconSize = 14,
  maxHeight,
  open: controlledOpen,
  onOpenChange,
  onTriggerHover,
  onNavigate,
}: DropdownMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      setPosition(null);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [setOpen],
  );

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const panelHeight = panel?.offsetHeight ?? 0;
    const preferredLeft = align === "end" ? rect.right - PANEL_WIDTH : rect.left;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, preferredLeft),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
    );
    const below = rect.bottom + GAP;
    const overflowsBelow = below + panelHeight > window.innerHeight - VIEWPORT_MARGIN;
    const above = rect.top - GAP - panelHeight;
    const top = overflowsBelow && above >= VIEWPORT_MARGIN ? above : below;
    setPosition({ top, left });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // A second pass once the panel has real height: the first paint may not know
    // its own height yet, and the flip decision depends on it.
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
      setPosition(null);
    };
    const onResize = () => close(false);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    };
  }, [open, close, setOpen]);

  // Focus the first actionable item so the menu is usable without a mouse.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>(ITEM_SELECTOR)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        return;
      case "Tab":
        // Tab leaves the menu; it must not walk through the items.
        close(false);
        return;
      case "ArrowLeft":
        if (!onNavigate) return;
        event.preventDefault();
        onNavigate(-1);
        return;
      case "ArrowRight":
        if (!onNavigate) return;
        event.preventDefault();
        onNavigate(1);
        return;
      case "ArrowDown":
        event.preventDefault();
        items[(current + 1 + items.length) % items.length]?.focus();
        return;
      case "ArrowUp":
        event.preventDefault();
        items[(current - 1 + items.length) % items.length]?.focus();
        return;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        return;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        return;
      default:
    }
  };

  const runAction = (action: DropdownAction) => {
    if (action.disabled) return;
    close(false);
    action.onSelect();
  };

  const isTextTrigger = triggerLabel !== undefined;
  // 24px, not 28: the note editor's menu row is compressed to 28px total (see
  // EditorStatusBar for the matching bottom bar), and a trigger taller than the
  // row would push the text baseline off-centre. Text triggers exist only in
  // that menu bar today; an icon trigger supplies its own height via
  // `triggerClassName`.
  const textTriggerClass = `inline-flex h-6 items-center rounded-md px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:bg-bg-hover focus-visible:text-text-primary ${
    open ? "bg-bg-hover text-text-primary" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
  }`;

  return (
    <div className="relative flex h-full items-center">
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={isTextTrigger ? undefined : label}
        onMouseEnter={onTriggerHover}
        onClick={() => {
          if (open) close(false);
          else setOpen(true);
        }}
        className={isTextTrigger ? `${textTriggerClass} ${triggerClassName}` : triggerClassName}
      >
        {isTextTrigger ? triggerLabel : Icon ? <Icon size={iconSize} aria-hidden="true" /> : null}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          onKeyDown={handlePanelKeyDown}
          style={{
            position: "fixed",
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            width: PANEL_WIDTH,
            maxHeight,
            overflowY: maxHeight === undefined ? undefined : "auto",
            visibility: position ? "visible" : "hidden",
          }}
          className="z-50 rounded-lg border border-border bg-bg-secondary p-1 shadow-xl shadow-black/20"
        >
          {entries.map((entry, index) =>
            isSeparator(entry) ? (
              <div key={`sep-${index}`} className="my-1 h-px bg-border" aria-hidden="true" />
            ) : (
              <div
                key={entry.id}
                // The wrapper owns the pointer events a disabled button never gets.
                title={entry.disabled ? entry.disabledReason : undefined}
              >
                <button
                  type="button"
                  role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={entry.checked}
                  aria-disabled={entry.disabled || undefined}
                  disabled={entry.disabled}
                  onClick={() => runAction(entry)}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus:outline-none ${
                    entry.disabled
                      ? "cursor-not-allowed text-text-muted opacity-55"
                      : entry.danger
                        ? "text-danger hover:bg-danger/10 focus:bg-danger/10"
                        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary"
                  }`}
                >
                  {entry.checked !== undefined ? (
                    <span className="flex w-3 flex-shrink-0 justify-center pt-0.5">
                      {entry.checked && <Check size={12} strokeWidth={2.4} aria-hidden="true" />}
                    </span>
                  ) : (
                    entry.icon && (
                      <entry.icon size={13} strokeWidth={1.9} className="mt-0.5 flex-shrink-0" />
                    )
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate">{entry.label}</span>
                      {entry.shortcut && (
                        <kbd className="flex-shrink-0 text-[10px] font-normal text-text-muted">
                          {entry.shortcut}
                        </kbd>
                      )}
                    </span>
                    {entry.hint && (
                      <span className="mt-0.5 block text-[10px] leading-4 text-text-muted">
                        {entry.hint}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            ),
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
