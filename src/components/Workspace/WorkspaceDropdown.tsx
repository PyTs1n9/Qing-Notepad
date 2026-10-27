import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, type LucideIcon } from "lucide-react";

interface WorkspaceDropdownOption {
  value: string;
  label: string;
}

interface WorkspaceDropdownProps {
  value: string;
  options: WorkspaceDropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  containerClassName?: string;
  triggerClassName?: string;
  icon?: LucideIcon;
  /** `plain` drops the field chrome so the trigger can pass as a list row. */
  tone?: "default" | "accent" | "plain";
}

interface WorkspaceDropdownMenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

export default function WorkspaceDropdown({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  containerClassName = "",
  triggerClassName = "h-8 min-w-[96px]",
  icon: Icon,
  tone = "default",
}: WorkspaceDropdownProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<WorkspaceDropdownMenuPosition | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? placeholder ?? "";

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!dropdownRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || disabled) {
      setMenuPosition(null);
      return;
    }

    const updateMenuPosition = () => {
      const trigger = dropdownRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const viewportPadding = 8;
      const menuGap = 4;
      const maxMenuHeight = 224;
      const estimatedMenuHeight = Math.min(maxMenuHeight, Math.max(40, options.length * 32 + 8));
      const spaceBelow = window.innerHeight - rect.bottom - menuGap - viewportPadding;
      const spaceAbove = rect.top - menuGap - viewportPadding;
      const openAbove = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow;
      const maxHeight = Math.max(40, Math.min(maxMenuHeight, openAbove ? spaceAbove : spaceBelow));
      const width = rect.width;
      const left = Math.max(
        viewportPadding,
        Math.min(rect.left, window.innerWidth - viewportPadding - width),
      );

      setMenuPosition({
        left,
        width,
        maxHeight,
        ...(openAbove
          ? { bottom: Math.max(viewportPadding, window.innerHeight - rect.top + menuGap) }
          : { top: Math.min(window.innerHeight - viewportPadding - maxHeight, rect.bottom + menuGap) }),
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [disabled, open, options.length]);

  return (
    <div ref={dropdownRef} className={`relative min-w-0 ${containerClassName}`}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !disabled) {
            event.preventDefault();
            setOpen((current) => !current);
          }
          if (event.key === "ArrowDown" && !disabled) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-2.5 text-left
          outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent
          ${tone === "accent"
            ? "border-accent/25 bg-accent-light text-accent-text hover:border-accent/45 hover:bg-accent/15"
            : tone === "plain"
              ? "border-transparent bg-transparent text-text-primary hover:bg-bg-hover"
              : "border-border bg-bg-secondary text-text-primary hover:bg-bg-hover"}
          disabled:cursor-not-allowed disabled:opacity-60 ${triggerClassName}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {Icon && <Icon size={13} className="flex-shrink-0 text-accent-text" />}
          <span className="min-w-0 truncate text-inherit">{selectedLabel}</span>
        </span>
        <ChevronDown
          size={13}
          className={`flex-shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && !disabled && menuPosition && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          className="fixed z-[10001] overflow-y-auto rounded-lg border border-border bg-bg-primary p-1 text-text-primary shadow-lg shadow-black/15"
          style={{
            left: menuPosition.left,
            width: menuPosition.width,
            maxHeight: menuPosition.maxHeight,
            ...(menuPosition.top !== undefined
              ? { top: menuPosition.top }
              : { bottom: menuPosition.bottom }),
          }}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-xs transition-colors
                  ${selected
                    ? "bg-accent-light text-accent-text"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
              >
                {option.label}
              </button>
            );
          })}
          {options.length === 0 && (
            <div className="px-2.5 py-1.5 text-xs text-text-muted">{placeholder}</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
