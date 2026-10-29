import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

interface CanvasToolbarMenuProps {
  label: string;
  icon: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  active?: boolean;
  disabled?: boolean;
  align?: "start" | "end";
  panelClassName?: string;
  children: ReactNode;
}

interface CanvasToolbarMenuItemProps {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  active?: boolean;
  disabled?: boolean;
  closeOnSelect?: boolean;
  className?: string;
}

const MenuCloseContext = createContext<(() => void) | null>(null);

export function CanvasToolbarMenu({
  label,
  icon,
  open,
  onOpenChange,
  active = false,
  disabled = false,
  align = "start",
  panelClassName = "w-64",
  children,
}: CanvasToolbarMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [position, setPosition] = useState({ left: 8, top: 8 });

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const padding = 8;
    const gap = 6;
    const triggerRect = trigger.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const preferredLeft = align === "end" ? triggerRect.right - panelWidth : triggerRect.left;
    const left = Math.max(padding, Math.min(window.innerWidth - panelWidth - padding, preferredLeft));
    const roomBelow = window.innerHeight - triggerRect.bottom - gap - padding;
    const top = roomBelow >= panelHeight
      ? triggerRect.bottom + gap
      : Math.max(padding, triggerRect.top - panelHeight - gap);

    setPosition({ left, top });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useLayoutEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`canvas-toolbar-trigger inline-flex h-8 flex-shrink-0 items-center justify-center gap-0.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          active
            ? "bg-accent text-on-accent hover:bg-accent-hover"
            : open
              ? "bg-bg-hover text-text-primary"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        }`}
        onClick={() => onOpenChange(!open)}
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        {icon}
        <span className="canvas-toolbar-menu-label">{label}</span>
        <ChevronDown size={12} className={`canvas-toolbar-menu-chevron transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && createPortal(
        <MenuCloseContext.Provider value={close}>
          <div
            ref={panelRef}
            id={panelId}
            role="menu"
            className={`fixed z-[200] rounded-xl border border-border bg-bg-primary/98 p-2 text-xs text-text-primary shadow-2xl backdrop-blur-sm ${panelClassName}`}
            style={position}
          >
            {children}
          </div>
        </MenuCloseContext.Provider>,
        document.body,
      )}
    </>
  );
}

export function CanvasToolbarMenuItem({
  label,
  icon,
  onSelect,
  active = false,
  disabled = false,
  closeOnSelect = true,
  className = "",
}: CanvasToolbarMenuItemProps) {
  const close = useContext(MenuCloseContext);

  return (
    <button
      type="button"
      role="menuitem"
      className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-accent text-on-accent"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      } ${className}`}
      onClick={() => {
        onSelect();
        if (closeOnSelect) close?.();
      }}
      disabled={disabled}
      title={label}
    >
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
