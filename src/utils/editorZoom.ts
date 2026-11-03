import { useCallback, useEffect, useMemo, useState } from "react";

interface EditorZoomOptions {
  initialSize?: number;
  minSize?: number;
  maxSize?: number;
  step?: number;
}

interface EditorContainerRef {
  readonly current: HTMLElement | null;
}

export interface EditorZoom {
  /** Current body font size in px. */
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Back to `initialSize`. */
  resetZoom: () => void;
}

/**
 * Body font size of an editor card.
 *
 * Two entry points share one state: Ctrl+wheel while the pointer is over the
 * card, and the 视图 menu (放宽 / 缩小 / 实际大小). Both are clamped to the same
 * bounds so the menu cannot reach a size the wheel refuses to produce.
 */
export function useEditorZoom(
  containerRef: EditorContainerRef,
  {
    initialSize = 16,
    minSize = 12,
    maxSize = 32,
    step = 1,
  }: EditorZoomOptions = {},
): EditorZoom {
  const [fontSize, setFontSize] = useState(initialSize);

  const clamp = useMemo(
    () => (value: number) => Math.min(maxSize, Math.max(minSize, value)),
    [maxSize, minSize],
  );

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
      const container = containerRef.current;
      if (!container || !(event.target instanceof Node) || !container.contains(event.target)) return;

      event.preventDefault();
      setFontSize((current) => clamp(
        event.deltaY < 0 ? current + step : current - step,
      ));
    };

    window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", handleWheel, true);
  }, [containerRef, clamp, step]);

  const zoomIn = useCallback(() => setFontSize((current) => clamp(current + step)), [clamp, step]);
  const zoomOut = useCallback(() => setFontSize((current) => clamp(current - step)), [clamp, step]);
  const resetZoom = useCallback(() => setFontSize(clamp(initialSize)), [clamp, initialSize]);

  return { fontSize, zoomIn, zoomOut, resetZoom };
}
