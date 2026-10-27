import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GripHorizontal } from "lucide-react";

interface CategoryResizeHandleProps {
  /** Accessible label for the separator. */
  label: string;
  /** Tooltip describing the interaction. */
  hint: string;
  onResizeStart: () => void;
  onResize: (clientY: number) => void;
  onResizeEnd: () => void;
  /** Double click / double tap restores the automatic height. */
  onReset: () => void;
}

const DOUBLE_TAP_MS = 320;

/**
 * Horizontal drag handle between the category panel and the note list.
 *
 * It doubles as the section divider, so the sidebar does not grow an extra
 * decorative line just to host the drag affordance. Because the pointer down is
 * cancelled to avoid text selection, the browser's native `dblclick` is not
 * reliable here, so the double click is detected from two taps without movement.
 */
export default function CategoryResizeHandle({
  label,
  hint,
  onResizeStart,
  onResize,
  onResizeEnd,
  onReset,
}: CategoryResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const lastTapRef = useRef(0);

  const stopDragging = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    onResizeEnd();

    if (movedRef.current) {
      lastTapRef.current = 0;
      return;
    }
    const now = performance.now();
    if (now - lastTapRef.current <= DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      onReset();
    } else {
      lastTapRef.current = now;
    }
  };

  useEffect(() => {
    if (!dragging) return;
    const handleBlur = () => stopDragging();
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [dragging]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    movedRef.current = false;
    setDragging(true);
    onResizeStart();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    movedRef.current = true;
    onResize(event.clientY);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onDoubleClick={onReset}
      title={hint}
      className="group flex h-3 w-full flex-shrink-0 cursor-row-resize touch-none select-none items-center gap-1.5 px-5"
    >
      <span
        aria-hidden="true"
        className={`h-[3px] w-8 rounded-full transition-colors ${
          dragging ? "bg-accent" : "bg-accent/45 group-hover:bg-accent/80"
        }`}
      />
      <span
        aria-hidden="true"
        className={`h-[2px] flex-1 rounded-full transition-colors ${
          dragging
            ? "sidebar-resize-guide--active bg-accent"
            : "bg-border group-hover:bg-accent/40"
        }`}
      />
      <GripHorizontal
        size={12}
        aria-hidden="true"
        className={`flex-shrink-0 transition-opacity ${
          dragging ? "text-accent-text opacity-100" : "text-text-muted opacity-0 group-hover:opacity-70"
        }`}
      />
    </div>
  );
}
