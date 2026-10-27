import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Maximize2, Minus, Pin, PinOff, Plus, X } from "lucide-react";
import type { CanvasBoard, CanvasDocument, CanvasImageItem, CanvasViewport } from "@/types";
import type { CustomColors, LangType, ThemeType } from "@/stores/settingsStore";
import { loadCanvasAsset, loadCanvasBoard, loadCanvasList } from "@/utils/canvasStorage";
import { getCanvasItemBounds } from "@/utils/canvasGeometry";
import { loadSettings } from "@/utils/storage";
import { applyTheme } from "@/utils/theme";
import { t } from "@/utils/i18n";
import CanvasBoardPreview from "@/components/Canvas/CanvasBoardPreview";

interface CanvasTileSyncPayload {
  canvasId: string;
  board: CanvasBoard;
}

const EMPTY_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

export default function CanvasTileView() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const canvasId = params.get("canvasTile") || "";
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const svgRef = useRef<SVGSVGElement>(null);
  const titleDragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const panRef = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const [board, setBoard] = useState<CanvasBoard | null>(null);
  const [title, setTitle] = useState("");
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [viewport, setViewport] = useState<CanvasViewport>(EMPTY_VIEWPORT);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [lang, setLang] = useState<LangType>("zh");
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(true);

  const fitBoard = useCallback((candidate = board) => {
    if (!candidate || candidate.items.length === 0 || size.width <= 0 || size.height <= 0) {
      setViewport(EMPTY_VIEWPORT);
      return;
    }
    const bounds = candidate.items.map((item) => getCanvasItemBounds(item, candidate.items));
    const minX = Math.min(...bounds.map((item) => item.minX));
    const minY = Math.min(...bounds.map((item) => item.minY));
    const maxX = Math.max(...bounds.map((item) => item.maxX));
    const maxY = Math.max(...bounds.map((item) => item.maxY));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const zoom = Math.min(3, Math.max(0.2, Math.min((size.width - 48) / width, (size.height - 48) / height)));
    setViewport({
      zoom,
      x: size.width / 2 - (minX + maxX) / 2 * zoom,
      y: size.height / 2 - (minY + maxY) / 2 * zoom,
    });
  }, [board, size]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedBoard, canvases, settings] = await Promise.all([
        loadCanvasBoard(canvasId),
        loadCanvasList(),
        loadSettings(),
      ]);
      if (cancelled) return;
      const meta: CanvasDocument | undefined = canvases.find((canvas) => canvas.id === canvasId);
      setTitle(meta?.name || t((settings.lang as LangType) || "zh", "canvas"));
      setLang((settings.lang as LangType) || "zh");
      applyTheme((settings.theme as ThemeType) || "blue", (settings.customColors as CustomColors | null) || null);
      setBoard(storedBoard);
    })();
    return () => { cancelled = true; };
  }, [canvasId]);

  useEffect(() => {
    if (!board) return;
    let cancelled = false;
    const imageItems = board.items.filter((item): item is CanvasImageItem => item.type === "image");
    void Promise.all(imageItems.map(async (item) => {
      const asset = await loadCanvasAsset(item.asset);
      return asset ? [item.asset, asset.dataUrl] as const : null;
    })).then((entries) => {
      if (!cancelled) setAssets(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
    });
    return () => { cancelled = true; };
  }, [board]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const update = () => {
      const rect = svg.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [board]);

  useEffect(() => {
    if (board && size.width > 0 && size.height > 0) fitBoard(board);
  }, [board?.items.length, size.width, size.height]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unlisten = listen<CanvasTileSyncPayload>("canvas-tile-sync", (event) => {
      if (event.payload.canvasId === canvasId) setBoard(event.payload.board);
    });
    return () => { unlisten.then((dispose) => dispose()); };
  }, [canvasId]);

  useEffect(() => {
    const unlisten = listen<{ theme: ThemeType; customColors: CustomColors | null }>("tile-theme-sync", (event) => {
      applyTheme(event.payload.theme, event.payload.customColors);
    });
    return () => { unlisten.then((dispose) => dispose()); };
  }, []);

  const zoomBy = (factor: number) => setViewport((current) => ({ ...current, zoom: Math.min(4, Math.max(0.2, current.zoom * factor)) }));

  const toggleAlwaysOnTop = async () => {
    const nextValue = !isAlwaysOnTop;
    try {
      await appWindow.setAlwaysOnTop(nextValue);
      setIsAlwaysOnTop(nextValue);
    } catch (error) {
      console.error("Failed to toggle canvas tile pin:", error);
    }
  };

  const closeTile = () => void appWindow.close();

  return (
    <div className="canvas-surface flex h-screen w-screen flex-col overflow-hidden bg-bg-primary">
      <div
        className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border bg-bg-secondary px-2 select-none"
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button")) return;
          event.preventDefault();
          event.stopPropagation();
          closeTile();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
          titleDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = titleDragRef.current;
          if (!start || start.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
          titleDragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          void appWindow.startDragging();
        }}
        onPointerUp={(event) => {
          titleDragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          titleDragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      >
        <span
          className="min-w-0 flex-1 cursor-pointer truncate px-1 text-xs font-medium text-text-secondary"
          title={title || t(lang, "canvasTile")}
        >
          {title || t(lang, "canvasTile")}
        </span>
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary" onClick={() => zoomBy(0.8)} title={t(lang, "canvasZoomOut")}><Minus size={14} /></button>
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary" onClick={() => zoomBy(1.25)} title={t(lang, "canvasZoomIn")}><Plus size={14} /></button>
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary" onClick={() => fitBoard()} title={t(lang, "canvasFit")}><Maximize2 size={14} /></button>
        <button type="button" className={`flex h-7 w-7 items-center justify-center rounded hover:bg-bg-hover ${isAlwaysOnTop ? "text-accent-text" : "text-text-muted hover:text-text-primary"}`} onClick={() => void toggleAlwaysOnTop()} title={t(lang, isAlwaysOnTop ? "canvasUnpinTile" : "canvasPinTile")} aria-pressed={isAlwaysOnTop}>{isAlwaysOnTop ? <PinOff size={14} /> : <Pin size={14} />}</button>
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary" onClick={closeTile} title={t(lang, "close")}><X size={14} /></button>
      </div>
      {board ? (
        <svg
          ref={svgRef}
          className="min-h-0 flex-1 cursor-grab touch-none"
          onPointerDown={(event) => {
            panRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: viewport.x, y: viewport.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const pan = panRef.current;
            if (!pan || pan.pointerId !== event.pointerId) return;
            setViewport((current) => ({ ...current, x: pan.x + event.clientX - pan.clientX, y: pan.y + event.clientY - pan.clientY }));
          }}
          onPointerUp={(event) => {
            panRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={(event) => {
            panRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onWheel={(event) => {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const nextZoom = Math.min(4, Math.max(0.2, viewport.zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
            const worldX = (event.clientX - rect.left - viewport.x) / viewport.zoom;
            const worldY = (event.clientY - rect.top - viewport.y) / viewport.zoom;
            setViewport({ zoom: nextZoom, x: event.clientX - rect.left - worldX * nextZoom, y: event.clientY - rect.top - worldY * nextZoom });
          }}
        >
          <CanvasBoardPreview board={board} assets={assets} viewport={viewport} />
        </svg>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-text-muted">{t(lang, "canvasTileLoading")}</div>
      )}
    </div>
  );
}
