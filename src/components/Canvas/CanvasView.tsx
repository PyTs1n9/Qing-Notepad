import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  ArrowDown,
  ArrowUp,
  Check,
  Circle,
  Copy,
  Diamond,
  Download,
  Eraser,
  Hand,
  ImagePlus,
  Layers3,
  Maximize2,
  MousePointer2,
  Palette,
  PanelRight,
  PenLine,
  Pin,
  Plus,
  RectangleHorizontal,
  Redo2,
  Spline,
  SquareRoundCorner,
  Trash2,
  Type,
  Undo2,
  Waypoints,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { emit } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useCanvasStore } from "@/stores/canvasStore";
import type {
  CanvasConnectorItem,
  CanvasConnectorStyle,
  CanvasDocument,
  CanvasDoodleEraserMark,
  CanvasDoodleEraserShape,
  CanvasDoodleItem,
  CanvasImageItem,
  CanvasItem,
  CanvasNodeItem,
  CanvasRichTextItem,
  CanvasShapeItem,
  CanvasShapeType,
  CanvasTextItem,
} from "@/types";
import { createEmptyCanvasBoard, isCanvasNodeItem } from "@/types/canvas";
import {
  deleteCanvasBoard,
  loadCanvasAsset,
  loadCanvasBoard,
  loadCanvasList,
  saveCanvasAsset,
  saveCanvasBoard,
  saveCanvasList,
} from "@/utils/canvasStorage";
import { renderCanvasToJpeg, renderCanvasToPng, renderCanvasToSvg } from "@/utils/canvasExport";
import {
  chooseCanvasAnchors,
  getCanvasAnchorPoint,
  getCanvasItemBounds,
  resolveCanvasConnector,
} from "@/utils/canvasGeometry";
import { t, tWithParams } from "@/utils/i18n";
import { getCanvasRichTextHtml, plainTextToCanvasHtml } from "@/utils/canvasRichText";
import { appendCanvasDoodlePoint, canvasDoodlePath, getCanvasDoodleBounds } from "@/utils/canvasDoodle";
import { openCanvasTileWindow } from "@/utils/canvasTile";
import { CanvasDoodleDefinitions, CanvasDoodleStroke } from "@/components/Canvas/CanvasDoodleLayer";
import CanvasRichTextEditor from "@/components/Canvas/CanvasRichTextEditor";
import CanvasTextToolbar from "@/components/Canvas/CanvasTextToolbar";
import { CanvasToolbarMenu, CanvasToolbarMenuItem } from "@/components/Canvas/CanvasToolbarMenu";

type CanvasTool =
  | "select"
  | "pan"
  | "text"
  | "doodle-pen"
  | "doodle-eraser"
  | `shape-${CanvasShapeType}`
  | `connector-${CanvasConnectorStyle}`;
type SaveState = "saved" | "saving";
type ToolbarMenu = "insert" | "draw" | "arrange" | "view" | "style";
type CanvasClipboardItem = CanvasImageItem | CanvasTextItem | CanvasShapeItem | CanvasConnectorItem;

interface Point {
  x: number;
  y: number;
}

interface PanInteraction {
  kind: "pan";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
}

interface ItemInteraction {
  kind: "drag" | "resize";
  pointerId: number;
  id: string;
  ids: string[];
  startClientX: number;
  startClientY: number;
  moved: boolean;
  startWorld: Point;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  startPositions: Record<string, Point>;
  updates: Record<string, Partial<CanvasItem>>;
}

interface DoodlePenInteraction {
  kind: "doodle-pen";
  id: string;
  pointerId: number;
  points: Point[];
  color: string;
  strokeWidth: number;
}

interface DoodleEraserInteraction {
  kind: "doodle-eraser";
  id: string;
  pointerId: number;
  points: Point[];
  shape: CanvasDoodleEraserShape;
  size: number;
  opacity: number;
}

type DoodleInteraction = DoodlePenInteraction | DoodleEraserInteraction;
type Interaction = PanInteraction | ItemInteraction | DoodleInteraction;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const GRID_SIZE = 12;
const SNAP_THRESHOLD = 6;
const DRAG_START_THRESHOLD_PX = 6;
const TEXT_DOUBLE_CLICK_INTERVAL_MS = 360;
const TEXT_DOUBLE_CLICK_DISTANCE_PX = 8;
const DEFAULT_FONT = "Segoe UI, PingFang SC, Microsoft YaHei, sans-serif";
const CANVAS_ITEM_CLIPBOARD_MIME = "application/x-qing-notepad-canvas-items";
const CANVAS_ITEM_CLIPBOARD_PREFIX = "qing-notepad:canvas-items:";

interface CanvasClipboardPayload {
  kind: "qing-notepad-canvas-items";
  version: 1;
  items: CanvasClipboardItem[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isShapeTool(tool: CanvasTool): tool is `shape-${CanvasShapeType}` {
  return tool.startsWith("shape-");
}

function isConnectorTool(tool: CanvasTool): tool is `connector-${CanvasConnectorStyle}` {
  return tool.startsWith("connector-");
}

function snapCanvasNode(
  item: CanvasNodeItem,
  nextX: number,
  nextY: number,
  otherItems: CanvasNodeItem[],
): { x: number; y: number; guides: { x?: number; y?: number } } {
  let x = Math.round(nextX / GRID_SIZE) * GRID_SIZE;
  let y = Math.round(nextY / GRID_SIZE) * GRID_SIZE;
  let bestX = SNAP_THRESHOLD + 1;
  let bestY = SNAP_THRESHOLD + 1;
  const guides: { x?: number; y?: number } = {};
  const sourceX = [0, item.width / 2, item.width];
  const sourceY = [0, item.height / 2, item.height];

  otherItems.forEach((candidate) => {
    const targetsX = [candidate.x, candidate.x + candidate.width / 2, candidate.x + candidate.width];
    const targetsY = [candidate.y, candidate.y + candidate.height / 2, candidate.y + candidate.height];
    sourceX.forEach((offset) => targetsX.forEach((target) => {
      const distance = Math.abs(x + offset - target);
      if (distance <= SNAP_THRESHOLD && distance < bestX) {
        x = target - offset;
        bestX = distance;
        guides.x = target;
      }
    }));
    sourceY.forEach((offset) => targetsY.forEach((target) => {
      const distance = Math.abs(y + offset - target);
      if (distance <= SNAP_THRESHOLD && distance < bestY) {
        y = target - offset;
        bestY = distance;
        guides.y = target;
      }
    }));
  });

  return { x, y, guides };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function extensionFromName(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "png";
}

function mimeFromName(name: string): string {
  switch (extensionFromName(name)) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    default:
      return "image/png";
  }
}

function makeId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCanvasClipboardBinding(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.itemId === "string"
    && (binding.anchor === "top" || binding.anchor === "right" || binding.anchor === "bottom" || binding.anchor === "left");
}

function isCanvasClipboardRichText(item: Record<string, unknown>): boolean {
  return typeof item.text === "string"
    && (item.html === undefined || typeof item.html === "string")
    && isFiniteNumber(item.fontSize)
    && typeof item.color === "string"
    && typeof item.fontFamily === "string";
}

function isCanvasClipboardItem(value: unknown): value is CanvasClipboardItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string"
    || !isFiniteNumber(item.x)
    || !isFiniteNumber(item.y)
    || !isFiniteNumber(item.width)
    || !isFiniteNumber(item.height)
    || !isFiniteNumber(item.rotation)
    || !isFiniteNumber(item.zIndex)) return false;

  if (item.type === "image") {
    return typeof item.asset === "string"
      && /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(item.asset)
      && typeof item.mimeType === "string"
      && item.mimeType.startsWith("image/")
      && typeof item.name === "string";
  }
  if (item.type === "text") return isCanvasClipboardRichText(item);
  if (item.type === "shape") {
    return isCanvasClipboardRichText(item)
      && (item.shape === "rectangle" || item.shape === "rounded" || item.shape === "ellipse" || item.shape === "diamond")
      && typeof item.fill === "string"
      && typeof item.stroke === "string"
      && isFiniteNumber(item.strokeWidth);
  }
  if (item.type === "connector") {
    return (item.style === "straight" || item.style === "orthogonal")
      && typeof item.stroke === "string"
      && isFiniteNumber(item.strokeWidth)
      && typeof item.endArrow === "boolean"
      && (item.startBinding === undefined || isCanvasClipboardBinding(item.startBinding))
      && (item.endBinding === undefined || isCanvasClipboardBinding(item.endBinding));
  }
  return false;
}

function readCanvasClipboard(clipboardData: DataTransfer | null): { raw: string; items: CanvasClipboardItem[] } | null {
  if (!clipboardData) return null;
  let raw = clipboardData.getData(CANVAS_ITEM_CLIPBOARD_MIME);
  if (!raw) {
    const text = clipboardData.getData("text/plain");
    if (!text.startsWith(CANVAS_ITEM_CLIPBOARD_PREFIX)) return null;
    raw = text.slice(CANVAS_ITEM_CLIPBOARD_PREFIX.length);
  }
  try {
    const payload = JSON.parse(raw) as Partial<CanvasClipboardPayload>;
    if (payload.kind !== "qing-notepad-canvas-items"
      || payload.version !== 1
      || !Array.isArray(payload.items)
      || payload.items.length === 0
      || !payload.items.every(isCanvasClipboardItem)) return null;
    return { raw, items: payload.items };
  } catch {
    return null;
  }
}

const toolbarButton = "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

export default function CanvasView() {
  const lang = useSettingsStore((state) => state.lang);
  const {
    board,
    selectedId,
    selectedIds,
    loaded,
    history,
    future,
    loadBoard,
    setSelectedId,
    setSelectedIds,
    toggleSelectedId,
    setViewport,
    addItem,
    addItems,
    updateItem,
    updateItems,
    moveLayer,
    removeItems,
    undo,
    redo,
  } = useCanvasStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const lastTextClickRef = useRef<{
    id: string;
    time: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const spaceHeldRef = useRef(false);
  const canvasClipboardPasteRef = useRef<{ raw: string; count: number } | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [openToolbarMenu, setOpenToolbarMenu] = useState<ToolbarMenu | null>(null);
  const [doodleColor, setDoodleColor] = useState("#2563eb");
  const [doodleWidth, setDoodleWidth] = useState(4);
  const [eraserShape, setEraserShape] = useState<CanvasDoodleEraserShape>("circle");
  const [eraserSize, setEraserSize] = useState(32);
  const [eraserOpacity, setEraserOpacity] = useState(1);
  const [activeDoodle, setActiveDoodle] = useState<DoodleInteraction | null>(null);
  const [doodleHoverPoint, setDoodleHoverPoint] = useState<Point | null>(null);
  const [connectorStartId, setConnectorStartId] = useState<string | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<{ x?: number; y?: number }>({});
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [draftItems, setDraftItems] = useState<Record<string, Partial<CanvasItem>>>({});
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [editingHtml, setEditingHtml] = useState("");
  const [canvasTextEditor, setCanvasTextEditor] = useState<Editor | null>(null);
  const editingDraftRef = useRef({ html: "", text: "" });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [exporting, setExporting] = useState(false);
  const [lastPointer, setLastPointer] = useState<Point | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [canvases, setCanvases] = useState<CanvasDocument[]>([]);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const [canvasListLoaded, setCanvasListLoaded] = useState(false);
  const [switchingCanvas, setSwitchingCanvas] = useState(false);
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [creatingCanvas, setCreatingCanvas] = useState(false);
  const [newCanvasName, setNewCanvasName] = useState("");
  const [renamingCanvasId, setRenamingCanvasId] = useState<string | null>(null);
  const [renamingCanvasName, setRenamingCanvasName] = useState("");
  const [deletingCanvasId, setDeletingCanvasId] = useState<string | null>(null);
  const newCanvasInputRef = useRef<HTMLInputElement>(null);
  const renameCanvasInputRef = useRef<HTMLInputElement>(null);

  const hasUndo = history.length > 0;
  const hasRedo = future.length > 0;
  const orderedItems = useMemo(() => [...board.items].sort((a, b) => a.zIndex - b.zIndex), [board.items]);
  const doodleItems = useMemo(
    () => orderedItems.filter((item): item is CanvasDoodleItem => item.type === "doodle"),
    [orderedItems],
  );
  const activeEraserMark = useMemo<CanvasDoodleEraserMark | null>(() => (
    activeDoodle?.kind === "doodle-eraser"
      ? {
          id: activeDoodle.id,
          points: activeDoodle.points,
          shape: activeDoodle.shape,
          size: activeDoodle.size,
          opacity: activeDoodle.opacity,
        }
      : null
  ), [activeDoodle]);
  const selectedLayerIndex = selectedId ? orderedItems.findIndex((item) => item.id === selectedId) : -1;
  const canMoveLayerDown = selectedLayerIndex > 0;
  const canMoveLayerUp = selectedLayerIndex >= 0 && selectedLayerIndex < orderedItems.length - 1;

  const clearPageDoodles = useCallback(() => {
    const ids = board.items
      .filter((item) => item.type === "doodle")
      .map((item) => item.id);
    if (ids.length > 0) removeItems(ids);
    interactionRef.current = null;
    setActiveDoodle(null);
    setDoodleHoverPoint(null);
    setTool("select");
    setOpenToolbarMenu(null);
  }, [board.items, removeItems]);

  const selectDoodleTool = useCallback((kind: "pen" | "eraser") => {
    setTool(kind === "pen" ? "doodle-pen" : "doodle-eraser");
    setConnectorStartId(null);
    setSelectedId(null);
  }, [setSelectedId]);

  const startEditingText = useCallback((item: CanvasRichTextItem) => {
    const html = getCanvasRichTextHtml(item);
    editingDraftRef.current = { html, text: item.text };
    setSelectedId(item.id);
    setEditingTextId(item.id);
    setEditingText(item.text);
    setEditingHtml(html);
  }, [setSelectedId]);

  const finishEditingText = useCallback((cancel = false) => {
    if (!editingTextId) return;
    if (!cancel) {
      const draft = editingDraftRef.current;
      updateItem(editingTextId, {
        html: draft.html,
        text: draft.text.trim() || "Text",
      });
    }
    setEditingTextId(null);
    setCanvasTextEditor(null);
  }, [editingTextId, updateItem]);

  const handleEditingTextUpdate = useCallback((html: string, text: string) => {
    editingDraftRef.current = { html, text };
    setEditingHtml(html);
    setEditingText(text);
  }, []);

  useEffect(() => {
    if (editingTextId && tool !== "select") finishEditingText();
  }, [editingTextId, finishEditingText, tool]);

  useEffect(() => {
    if (!creatingCanvas) return;
    const frame = window.requestAnimationFrame(() => newCanvasInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [creatingCanvas]);

  useEffect(() => {
    if (!renamingCanvasId) return;
    const frame = window.requestAnimationFrame(() => {
      renameCanvasInputRef.current?.focus();
      renameCanvasInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renamingCanvasId]);

  const getWorldPoint = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - board.viewport.x) / board.viewport.zoom,
      y: (clientY - rect.top - board.viewport.y) / board.viewport.zoom,
    };
  }, [board.viewport]);

  const getViewportCenter = useCallback((): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 120, y: 100 };
    const rect = svg.getBoundingClientRect();
    return getWorldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [getWorldPoint]);

  useEffect(() => {
    let cancelled = false;
    void loadCanvasList().then(async (storedCanvases) => {
      if (cancelled) return;
      const firstCanvas = storedCanvases[0];
      setCanvases(storedCanvases);
      if (!firstCanvas) {
        loadBoard(createEmptyCanvasBoard());
        setCanvasListLoaded(true);
        return;
      }
      setActiveCanvasId(firstCanvas.id);
      const storedBoard = await loadCanvasBoard(firstCanvas.id);
      if (!cancelled) {
        loadBoard(storedBoard ?? createEmptyCanvasBoard());
        setCanvasListLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadBoard]);

  useEffect(() => {
    if (!loaded || !canvasListLoaded || !activeCanvasId || switchingCanvas) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      void saveCanvasBoard(board, activeCanvasId).then(() => setSaveState("saved"));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [activeCanvasId, board, canvasListLoaded, loaded, switchingCanvas]);

  useEffect(() => {
    if (!loaded || !activeCanvasId) return;
    void emit("canvas-tile-sync", { canvasId: activeCanvasId, board });
  }, [activeCanvasId, board, loaded]);

  useEffect(() => {
    let cancelled = false;
    const imageItems = board.items.filter((item): item is CanvasImageItem => item.type === "image");
    void Promise.all(imageItems.map(async (item) => {
      if (assets[item.asset]) return null;
      const loadedAsset = await loadCanvasAsset(item.asset);
      return loadedAsset ? { asset: item.asset, dataUrl: loadedAsset.dataUrl } : null;
    })).then((loadedAssets) => {
      if (cancelled) return;
      const nextAssets = loadedAssets.reduce<Record<string, string>>((result, asset) => {
        if (asset) result[asset.asset] = asset.dataUrl;
        return result;
      }, {});
      if (Object.keys(nextAssets).length > 0) {
        setAssets((current) => ({ ...current, ...nextAssets }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [assets, board.items]);

  const getDisplayItem = useCallback((item: CanvasItem): CanvasItem => ({
    ...item,
    ...(draftItems[item.id] ?? {}),
  } as CanvasItem), [draftItems]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateSize = () => {
      const rect = svg.getBoundingClientRect();
      const nextSize = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setCanvasSize((current) => current.width === nextSize.width && current.height === nextSize.height ? current : nextSize);
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const minimap = useMemo(() => {
    const items = board.items.map(getDisplayItem);
    const bounds = items.map((item) => getCanvasItemBounds(item, items));
    const minItemX = bounds.length > 0 ? Math.min(...bounds.map((item) => item.minX)) : 0;
    const minItemY = bounds.length > 0 ? Math.min(...bounds.map((item) => item.minY)) : 0;
    const maxItemX = bounds.length > 0 ? Math.max(...bounds.map((item) => item.maxX)) : 900;
    const maxItemY = bounds.length > 0 ? Math.max(...bounds.map((item) => item.maxY)) : 560;
    const contentWidth = Math.max(1, maxItemX - minItemX);
    const contentHeight = Math.max(1, maxItemY - minItemY);
    const padding = Math.max(48, Math.max(contentWidth, contentHeight) * 0.08);
    const viewBox = {
      x: minItemX - padding,
      y: minItemY - padding,
      width: contentWidth + padding * 2,
      height: contentHeight + padding * 2,
    };
    const visibleWidth = canvasSize.width > 0 ? canvasSize.width / board.viewport.zoom : contentWidth;
    const visibleHeight = canvasSize.height > 0 ? canvasSize.height / board.viewport.zoom : contentHeight;
    return {
      items,
      viewBox,
      viewport: {
        x: -board.viewport.x / board.viewport.zoom,
        y: -board.viewport.y / board.viewport.zoom,
        width: visibleWidth,
        height: visibleHeight,
      },
    };
  }, [board.items, board.viewport, canvasSize, getDisplayItem]);

  const centerViewportOnPoint = useCallback((point: Point) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setViewport({
      zoom: board.viewport.zoom,
      x: rect.width / 2 - point.x * board.viewport.zoom,
      y: rect.height / 2 - point.y * board.viewport.zoom,
    });
  }, [board.viewport.zoom, setViewport]);

  const handleMinimapItemClick = useCallback((event: React.MouseEvent<SVGGElement>, rawItem: CanvasItem) => {
    event.stopPropagation();
    const item = getDisplayItem(rawItem);
    const items = board.items.map(getDisplayItem);
    const bounds = getCanvasItemBounds(item, items);
    setSelectedId(item.id);
    centerViewportOnPoint({
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    });
  }, [board.items, centerViewportOnPoint, getDisplayItem, setSelectedId]);

  const switchCanvas = useCallback(async (canvasId: string) => {
    if (!canvasId || canvasId === activeCanvasId || switchingCanvas || !loaded) return;
    if (editingTextId) finishEditingText();
    setSwitchingCanvas(true);
    try {
      if (activeCanvasId) {
        await saveCanvasBoard(useCanvasStore.getState().board, activeCanvasId);
      }
      const storedBoard = await loadCanvasBoard(canvasId);
      setActiveCanvasId(canvasId);
      setAssets({});
      setDraftItems({});
      setEditingTextId(null);
      setCreatingCanvas(false);
      setNewCanvasName("");
      setRenamingCanvasId(null);
      setRenamingCanvasName("");
      setDeletingCanvasId(null);
      loadBoard(storedBoard ?? createEmptyCanvasBoard());
      setCanvasMenuOpen(false);
    } finally {
      setSwitchingCanvas(false);
    }
  }, [activeCanvasId, editingTextId, finishEditingText, loadBoard, loaded, switchingCanvas]);

  const createCanvas = useCallback(async () => {
    const name = newCanvasName.trim();
    if (!name || switchingCanvas || !loaded) return;
    if (editingTextId) finishEditingText();

    const now = new Date().toISOString();
    const canvas: CanvasDocument = {
      id: makeId(),
      name,
      createdAt: now,
      updatedAt: now,
    };
    const nextCanvases = [...canvases, canvas];
    setSwitchingCanvas(true);
    try {
      if (activeCanvasId) {
        await saveCanvasBoard(useCanvasStore.getState().board, activeCanvasId);
      }
      const emptyBoard = createEmptyCanvasBoard();
      await saveCanvasBoard(emptyBoard, canvas.id);
      await saveCanvasList(nextCanvases);
      setCanvases(nextCanvases);
      setActiveCanvasId(canvas.id);
      setAssets({});
      setDraftItems({});
      setEditingTextId(null);
      loadBoard(emptyBoard);
      setCreatingCanvas(false);
      setNewCanvasName("");
      setRenamingCanvasId(null);
      setRenamingCanvasName("");
      setDeletingCanvasId(null);
      setCanvasMenuOpen(false);
    } finally {
      setSwitchingCanvas(false);
    }
  }, [activeCanvasId, canvases, editingTextId, finishEditingText, loadBoard, loaded, newCanvasName, switchingCanvas]);

  const beginRenameCanvas = useCallback((canvas: CanvasDocument) => {
    if (switchingCanvas || !loaded) return;
    setCreatingCanvas(false);
    setNewCanvasName("");
    setDeletingCanvasId(null);
    setRenamingCanvasId(canvas.id);
    setRenamingCanvasName(canvas.name);
    setCanvasMenuOpen(true);
  }, [loaded, switchingCanvas]);

  const cancelRenameCanvas = useCallback(() => {
    setRenamingCanvasId(null);
    setRenamingCanvasName("");
  }, []);

  const renameCanvas = useCallback(async () => {
    if (!renamingCanvasId || switchingCanvas || !loaded) return;
    const name = renamingCanvasName.trim();
    if (!name) return;
    const current = canvases.find((canvas) => canvas.id === renamingCanvasId);
    if (!current) return;
    if (current.name === name) {
      cancelRenameCanvas();
      return;
    }
    const nextCanvases = canvases.map((canvas) => (
      canvas.id === renamingCanvasId
        ? { ...canvas, name, updatedAt: new Date().toISOString() }
        : canvas
    ));
    await saveCanvasList(nextCanvases);
    setCanvases(nextCanvases);
    cancelRenameCanvas();
  }, [canvases, cancelRenameCanvas, loaded, renamingCanvasId, renamingCanvasName, switchingCanvas]);

  const requestDeleteCanvas = useCallback((canvasId: string) => {
    if (switchingCanvas || !loaded) return;
    setCreatingCanvas(false);
    setNewCanvasName("");
    setRenamingCanvasId(null);
    setRenamingCanvasName("");
    setDeletingCanvasId((current) => current === canvasId ? null : canvasId);
    setCanvasMenuOpen(true);
  }, [loaded, switchingCanvas]);

  const closeCanvasMenu = useCallback(() => {
    setCanvasMenuOpen(false);
    setCreatingCanvas(false);
    setNewCanvasName("");
    setRenamingCanvasId(null);
    setRenamingCanvasName("");
    setDeletingCanvasId(null);
  }, []);

  const toggleCanvasMenu = useCallback(() => {
    if (canvasMenuOpen) {
      closeCanvasMenu();
    } else {
      setCanvasMenuOpen(true);
    }
  }, [canvasMenuOpen, closeCanvasMenu]);

  const removeCanvas = useCallback(async (canvasId: string) => {
    const canvas = canvases.find((candidate) => candidate.id === canvasId);
    if (!canvas) return;

    const nextCanvases = canvases.filter((candidate) => candidate.id !== canvasId);
    setSwitchingCanvas(true);
    try {
      if (canvasId === activeCanvasId && activeCanvasId) {
        if (editingTextId) finishEditingText();
        await saveCanvasBoard(useCanvasStore.getState().board, activeCanvasId);
      }
      setCreatingCanvas(false);
      setNewCanvasName("");
      setRenamingCanvasId(null);
      setRenamingCanvasName("");
      setDeletingCanvasId(null);
      await deleteCanvasBoard(canvasId);
      await saveCanvasList(nextCanvases);
      setCanvases(nextCanvases);
      if (canvasId === activeCanvasId) {
        const nextActive = nextCanvases[Math.max(0, canvases.findIndex((candidate) => candidate.id === canvasId) - 1)] ?? nextCanvases[0];
        setAssets({});
        setDraftItems({});
        setEditingTextId(null);
        if (nextActive) {
          const storedBoard = await loadCanvasBoard(nextActive.id);
          setActiveCanvasId(nextActive.id);
          loadBoard(storedBoard ?? createEmptyCanvasBoard());
        } else {
          setActiveCanvasId(null);
          loadBoard(createEmptyCanvasBoard());
        }
      }
      setCanvasMenuOpen(false);
    } finally {
      setSwitchingCanvas(false);
    }
  }, [activeCanvasId, canvases, editingTextId, finishEditingText, loadBoard]);

  const updateViewportAt = useCallback((clientX: number, clientY: number, zoom: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const oldWorldX = (clientX - rect.left - board.viewport.x) / board.viewport.zoom;
    const oldWorldY = (clientY - rect.top - board.viewport.y) / board.viewport.zoom;
    setViewport({
      zoom,
      x: clientX - rect.left - oldWorldX * zoom,
      y: clientY - rect.top - oldWorldY * zoom,
    });
  }, [board.viewport, setViewport]);

  const zoomBy = useCallback((factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    updateViewportAt(rect.left + rect.width / 2, rect.top + rect.height / 2, clamp(board.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM));
  }, [board.viewport.zoom, updateViewportAt]);

  const resetZoom = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    updateViewportAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1);
  }, [updateViewportAt]);

  const fitCanvas = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || board.items.length === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const rect = svg.getBoundingClientRect();
    const items = board.items.map(getDisplayItem);
    const bounds = items.map((item) => getCanvasItemBounds(item, items));
    const minX = Math.min(...bounds.map((item) => item.minX));
    const minY = Math.min(...bounds.map((item) => item.minY));
    const maxX = Math.max(...bounds.map((item) => item.maxX));
    const maxY = Math.max(...bounds.map((item) => item.maxY));
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const zoom = clamp(Math.min((rect.width - 80) / contentWidth, (rect.height - 80) / contentHeight), MIN_ZOOM, 2.5);
    setViewport({
      zoom,
      x: rect.width / 2 - (minX + maxX) / 2 * zoom,
      y: rect.height / 2 - (minY + maxY) / 2 * zoom,
    });
  }, [board.items, getDisplayItem, setViewport]);

  const addTextAt = useCallback((point: Point) => {
    const item: CanvasTextItem = {
      id: makeId(),
      type: "text",
      text: "Text",
      html: plainTextToCanvasHtml("Text"),
      x: point.x,
      y: point.y,
      width: 260,
      height: 86,
      fontSize: 22,
      color: "var(--color-text-primary)",
      fontFamily: DEFAULT_FONT,
      rotation: 0,
      zIndex: board.items.length,
    };
    addItem(item);
    startEditingText(item);
    setTool("select");
  }, [addItem, board.items.length, startEditingText]);

  const addShapeAt = useCallback((point: Point, shape: CanvasShapeType) => {
    const item: CanvasShapeItem = {
      id: makeId(),
      type: "shape",
      shape,
      text: t(lang, "canvasNodeText"),
      html: plainTextToCanvasHtml(t(lang, "canvasNodeText")),
      x: point.x - 110,
      y: point.y - 60,
      width: 220,
      height: 120,
      fontSize: 18,
      color: "var(--color-text-primary)",
      fontFamily: DEFAULT_FONT,
      fill: "var(--color-bg-secondary)",
      stroke: "var(--color-accent)",
      strokeWidth: 2,
      rotation: 0,
      zIndex: board.items.length,
    };
    addItem(item);
    startEditingText(item);
    setTool("select");
  }, [addItem, board.items.length, lang, startEditingText]);

  const connectToNode = useCallback((item: CanvasNodeItem, style: CanvasConnectorStyle) => {
    if (!connectorStartId) {
      setConnectorStartId(item.id);
      setSelectedId(item.id);
      return;
    }
    if (connectorStartId === item.id) {
      setConnectorStartId(null);
      setSelectedId(null);
      return;
    }
    const startItem = board.items.find((candidate): candidate is CanvasNodeItem => (
      candidate.id === connectorStartId && isCanvasNodeItem(candidate)
    ));
    if (!startItem) {
      setConnectorStartId(item.id);
      return;
    }
    const anchors = chooseCanvasAnchors(startItem, item);
    const start = getCanvasAnchorPoint(startItem, anchors.start);
    const end = getCanvasAnchorPoint(item, anchors.end);
    const connector: CanvasConnectorItem = {
      id: makeId(),
      type: "connector",
      style,
      stroke: "var(--color-accent)",
      strokeWidth: 2,
      endArrow: true,
      startBinding: { itemId: startItem.id, anchor: anchors.start },
      endBinding: { itemId: item.id, anchor: anchors.end },
      x: start.x,
      y: start.y,
      width: end.x - start.x,
      height: end.y - start.y,
      rotation: 0,
      zIndex: board.items.length,
    };
    addItem(connector);
    setConnectorStartId(null);
    setSelectedId(connector.id);
    setTool("select");
  }, [addItem, board.items, connectorStartId, setSelectedId]);

  const duplicateSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    const selectedSet = new Set(selectedIds);
    const idMap = new Map(selectedIds.map((id) => [id, makeId()]));
    const zIndexStart = board.items.length;
    const duplicates = board.items
      .filter((item) => selectedSet.has(item.id))
      .map((item, index) => {
        const duplicate = {
          ...item,
          id: idMap.get(item.id)!,
          x: item.x + 24,
          y: item.y + 24,
          zIndex: zIndexStart + index,
        } as CanvasItem;
        if (duplicate.type === "connector") {
          const originalConnector = item as CanvasConnectorItem;
          const geometry = resolveCanvasConnector(originalConnector, board.items);
          duplicate.x = geometry.start.x + 24;
          duplicate.y = geometry.start.y + 24;
          duplicate.width = geometry.end.x - geometry.start.x;
          duplicate.height = geometry.end.y - geometry.start.y;
          duplicate.startBinding = duplicate.startBinding
            && idMap.has(duplicate.startBinding.itemId)
            ? { ...duplicate.startBinding, itemId: idMap.get(duplicate.startBinding.itemId)! }
            : undefined;
          duplicate.endBinding = duplicate.endBinding
            && idMap.has(duplicate.endBinding.itemId)
            ? { ...duplicate.endBinding, itemId: idMap.get(duplicate.endBinding.itemId)! }
            : undefined;
        }
        return duplicate;
      });
    addItems(duplicates);
    setSelectedIds(duplicates.map((item) => item.id));
  }, [addItems, board.items, selectedIds, setSelectedIds]);

  const handleCanvasClipboardWrite = useCallback((event: ClipboardEvent, cut: boolean) => {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || (active instanceof HTMLElement && active.isContentEditable)) return;
    const selectedSet = new Set(selectedIds);
    const items = board.items
      .filter((item): item is CanvasClipboardItem => item.type !== "doodle" && selectedSet.has(item.id))
      .map((item): CanvasClipboardItem => {
        if (item.type !== "connector") return item;
        const geometry = resolveCanvasConnector(item, board.items);
        return {
          ...item,
          x: geometry.start.x,
          y: geometry.start.y,
          width: geometry.end.x - geometry.start.x,
          height: geometry.end.y - geometry.start.y,
        };
      });
    if (items.length === 0) return;

    const raw = JSON.stringify({
      kind: "qing-notepad-canvas-items",
      version: 1,
      items,
    } satisfies CanvasClipboardPayload);
    const finishWrite = () => {
      canvasClipboardPasteRef.current = null;
      if (cut) removeItems(items.map((item) => item.id));
    };

    if (event.clipboardData) {
      try {
        event.clipboardData.setData("text/plain", `${CANVAS_ITEM_CLIPBOARD_PREFIX}${raw}`);
        event.clipboardData.setData(CANVAS_ITEM_CLIPBOARD_MIME, raw);
        event.preventDefault();
        finishWrite();
        return;
      } catch (error) {
        console.warn("Failed to write canvas image clipboard data:", error);
      }
    }

    if (navigator.clipboard?.writeText) {
      event.preventDefault();
      void navigator.clipboard.writeText(`${CANVAS_ITEM_CLIPBOARD_PREFIX}${raw}`)
        .then(finishWrite)
        .catch((error) => console.warn("Failed to write canvas image clipboard text:", error));
    }
  }, [board.items, removeItems, selectedIds]);

  const alignSelection = useCallback((axis: "horizontal" | "vertical") => {
    const items = board.items.filter((item): item is CanvasNodeItem => selectedIds.includes(item.id) && isCanvasNodeItem(item));
    if (items.length < 2) return;
    const center = items.reduce((sum, item) => sum + (axis === "horizontal"
      ? item.x + item.width / 2
      : item.y + item.height / 2), 0) / items.length;
    const updates = Object.fromEntries(items.map((item) => [item.id, axis === "horizontal"
      ? { x: center - item.width / 2 }
      : { y: center - item.height / 2 }]));
    updateItems(updates);
  }, [board.items, selectedIds, updateItems]);

  const addImageBytes = useCallback(async (data: Uint8Array, name: string, mimeType: string) => {
    if (!mimeType.startsWith("image/")) return;
    const extension = extensionFromName(name);
    const dataUrl = `data:${mimeType};base64,${bytesToBase64(data)}`;
    const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType }));
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({ width: image.naturalWidth || 640, height: image.naturalHeight || 420 });
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({ width: 640, height: 420 });
      };
      image.src = objectUrl;
    });
    const asset = await saveCanvasAsset(data, extension);
    const maxWidth = 620;
    const scale = Math.min(1, maxWidth / dimensions.width);
    const width = Math.max(120, Math.round(dimensions.width * scale));
    const height = Math.max(80, Math.round(dimensions.height * scale));
    const center = getViewportCenter();
    const item: CanvasImageItem = {
      id: makeId(),
      type: "image",
      asset,
      mimeType,
      name: name || "image",
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      rotation: 0,
      zIndex: board.items.length,
    };
    setAssets((current) => ({ ...current, [asset]: dataUrl }));
    addItem(item);
    setSelectedId(item.id);
    setTool("select");
  }, [addItem, board.items.length, getViewportCenter, setSelectedId]);

  const importImageFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        await addImageBytes(new Uint8Array(await file.arrayBuffer()), file.name || "pasted-image.png", file.type);
      }
    }
  }, [addImageBytes]);

  const handleChooseImage = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"] }],
    });
    const paths = selected ? (Array.isArray(selected) ? selected : [selected]) : [];
    for (const path of paths) {
      const data = new Uint8Array(await readFile(path));
      const name = path.split(/[\\/]/).pop() || "image.png";
      await addImageBytes(data, name, mimeFromName(name));
    }
  }, [addImageBytes]);

  const handleExport = useCallback(async () => {
    if (board.items.length === 0 || exporting) return;
    const activeCanvas = canvases.find((canvas) => canvas.id === activeCanvasId);
    const safeName = (activeCanvas?.name || t(lang, "canvas"))
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "") || "canvas";
    setExporting(true);
    try {
      const exportPath = await save({
        defaultPath: `${safeName}.png`,
        filters: [
          { name: "PNG", extensions: ["png"] },
          { name: "JPEG", extensions: ["jpg", "jpeg"] },
          { name: "SVG", extensions: ["svg"] },
        ],
      });
      if (!exportPath) return;

      const exportAssets = { ...assets };
      await Promise.all(board.items.filter((item): item is CanvasImageItem => item.type === "image").map(async (item) => {
        if (exportAssets[item.asset]) return;
        const loadedAsset = await loadCanvasAsset(item.asset);
        if (loadedAsset) exportAssets[item.asset] = loadedAsset.dataUrl;
      }));
      const exportItems = board.items.map((item) => {
        const displayItem = getDisplayItem(item);
        if ((displayItem.type === "text" || displayItem.type === "shape") && displayItem.id === editingTextId) {
          return { ...displayItem, html: editingHtml, text: editingText.trim() || "Text" };
        }
        return displayItem;
      });
      if (exportPath.toLowerCase().endsWith(".svg")) {
        await writeFile(exportPath, new TextEncoder().encode(await renderCanvasToSvg({ items: exportItems, assets: exportAssets })));
      } else if (/\.jpe?g$/i.test(exportPath)) {
        await writeFile(exportPath, await renderCanvasToJpeg({ items: exportItems, assets: exportAssets }));
      } else {
        await writeFile(exportPath, await renderCanvasToPng({ items: exportItems, assets: exportAssets }));
      }
    } catch (error) {
      console.error("Failed to export canvas:", error);
    } finally {
      setExporting(false);
    }
  }, [activeCanvasId, assets, board.items, canvases, editingHtml, editingText, editingTextId, exporting, getDisplayItem, lang]);

  const handleOpenCanvasTile = useCallback(async () => {
    if (!activeCanvasId) return;
    if (editingTextId) finishEditingText();
    const currentBoard = useCanvasStore.getState().board;
    await saveCanvasBoard(currentBoard, activeCanvasId);
    await openCanvasTileWindow(activeCanvasId);
  }, [activeCanvasId, editingTextId, finishEditingText]);

  const handlePaste = useCallback(async (event: ClipboardEvent) => {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || (active instanceof HTMLElement && active.isContentEditable)) return;
    const canvasClipboard = readCanvasClipboard(event.clipboardData);
    if (canvasClipboard) {
      event.preventDefault();
      const previousPaste = canvasClipboardPasteRef.current;
      const pasteCount = previousPaste?.raw === canvasClipboard.raw ? previousPaste.count + 1 : 1;
      canvasClipboardPasteRef.current = { raw: canvasClipboard.raw, count: pasteCount };
      const offset = pasteCount * 24;
      const imageAssets = canvasClipboard.items
        .filter((item): item is CanvasImageItem => item.type === "image")
        .map((image) => image.asset);
      const loadedAssets = await Promise.all([...new Set(imageAssets)].map(async (asset) => (
        [asset, (await loadCanvasAsset(asset))?.dataUrl] as const
      )));
      setAssets((current) => {
        const next = { ...current };
        loadedAssets.forEach(([asset, dataUrl]) => {
          if (dataUrl) next[asset] = dataUrl;
        });
        return next;
      });
      const zIndexStart = board.items.length;
      const idMap = new Map(canvasClipboard.items.map((item) => [item.id, makeId()]));
      const pastedItems = canvasClipboard.items.map((item, index): CanvasClipboardItem => {
        const pasted = {
          ...item,
          id: idMap.get(item.id)!,
          x: item.x + offset,
          y: item.y + offset,
          zIndex: zIndexStart + index,
        } as CanvasClipboardItem;
        if (pasted.type === "connector") {
          pasted.startBinding = pasted.startBinding && idMap.has(pasted.startBinding.itemId)
            ? { ...pasted.startBinding, itemId: idMap.get(pasted.startBinding.itemId)! }
            : undefined;
          pasted.endBinding = pasted.endBinding && idMap.has(pasted.endBinding.itemId)
            ? { ...pasted.endBinding, itemId: idMap.get(pasted.endBinding.itemId)! }
            : undefined;
        }
        return pasted;
      });
      addItems(pastedItems);
      setSelectedIds(pastedItems.map((item) => item.id));
      setTool("select");
      return;
    }
    const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        event.preventDefault();
        await importImageFiles([file]);
        return;
      }
    }
    const text = event.clipboardData?.getData("text/plain")?.trim();
    if (text) {
      event.preventDefault();
      const point = lastPointer ?? getViewportCenter();
      const item: CanvasTextItem = {
        id: makeId(),
        type: "text",
        text,
        html: plainTextToCanvasHtml(text),
        x: point.x,
        y: point.y,
        width: 300,
        height: 100,
        fontSize: 18,
        color: "var(--color-text-primary)",
        fontFamily: DEFAULT_FONT,
        rotation: 0,
        zIndex: board.items.length,
      };
      addItem(item);
      startEditingText(item);
    }
  }, [addItem, addItems, board.items.length, getViewportCenter, importImageFiles, lastPointer, setSelectedIds, startEditingText]);

  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => handleCanvasClipboardWrite(event, false);
    const onCut = (event: ClipboardEvent) => handleCanvasClipboardWrite(event, true);
    const onPaste = (event: ClipboardEvent) => { void handlePaste(event); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = true;
      const target = event.target;
      const isTextInput = target instanceof HTMLTextAreaElement
        || target instanceof HTMLInputElement
        || (target instanceof HTMLElement && target.isContentEditable);
      if (isTextInput) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (event.key === "Delete" && selectedIds.length > 0) {
        event.preventDefault();
        removeItems(selectedIds);
      } else if (event.key === "Escape") {
        setSelectedId(null);
        setConnectorStartId(null);
        setTool("select");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = false;
    };
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [handleCanvasClipboardWrite, handlePaste, redo, removeItems, selectedIds, setSelectedId, undo]);

  const startPan = (event: React.PointerEvent<SVGElement>) => {
    interactionRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: board.viewport.x,
      startY: board.viewport.y,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const startDoodle = (event: React.PointerEvent<SVGElement>) => {
    if (event.button !== 0 || (tool !== "doodle-pen" && tool !== "doodle-eraser")) return;
    event.preventDefault();
    const point = getWorldPoint(event.clientX, event.clientY);
    const interaction: DoodleInteraction = tool === "doodle-pen"
      ? {
          kind: "doodle-pen",
          id: makeId(),
          pointerId: event.pointerId,
          points: [point],
          color: doodleColor,
          strokeWidth: doodleWidth,
        }
      : {
          kind: "doodle-eraser",
          id: makeId(),
          pointerId: event.pointerId,
          points: [point],
          shape: eraserShape,
          size: eraserSize,
          opacity: eraserOpacity,
        };
    interactionRef.current = interaction;
    setActiveDoodle(interaction);
    setSelectedId(null);
    setOpenToolbarMenu(null);
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const startItemDrag = (event: React.PointerEvent<SVGGElement>, item: CanvasItem) => {
    event.stopPropagation();
    if (editingTextId && editingTextId !== item.id) finishEditingText();
    if (event.button === 1 || tool === "pan" || spaceHeldRef.current) {
      startPan(event);
      return;
    }
    if (tool === "doodle-pen" || tool === "doodle-eraser") {
      startDoodle(event);
      return;
    }
    if (isConnectorTool(tool)) {
      if (isCanvasNodeItem(item)) connectToNode(item, tool.replace("connector-", "") as CanvasConnectorStyle);
      return;
    }
    if (tool === "text") {
      if (item.type === "text" || item.type === "shape") {
        event.preventDefault();
        startEditingText(item);
      }
      return;
    }
    if (tool !== "select") return;
    if (item.type !== "text" && item.type !== "shape") lastTextClickRef.current = null;
    if (event.shiftKey) {
      toggleSelectedId(item.id);
      if (selectedIds.includes(item.id)) return;
    } else if (!selectedIds.includes(item.id)) {
      setSelectedId(item.id);
    }
    if (item.type === "connector") return;
    const ids = (selectedIds.includes(item.id) ? selectedIds : [...selectedIds, item.id])
      .filter((id) => board.items.some((candidate) => candidate.id === id && candidate.type !== "connector"));
    const dragIds = event.shiftKey ? ids : (selectedIds.includes(item.id) ? ids : [item.id]);
    const point = getWorldPoint(event.clientX, event.clientY);
    const startPositions = Object.fromEntries(board.items
      .filter((candidate) => dragIds.includes(candidate.id))
      .map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }]));
    interactionRef.current = {
      kind: "drag",
      pointerId: event.pointerId,
      id: item.id,
      ids: dragIds,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
      startWorld: point,
      startX: item.x,
      startY: item.y,
      startWidth: item.width,
      startHeight: item.height,
      startPositions,
      updates: {},
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const startResize = (event: React.PointerEvent<SVGRectElement>, item: CanvasItem) => {
    event.stopPropagation();
    if (tool !== "select") return;
    const point = getWorldPoint(event.clientX, event.clientY);
    interactionRef.current = {
      kind: "resize",
      pointerId: event.pointerId,
      id: item.id,
      ids: [item.id],
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
      startWorld: point,
      startX: item.x,
      startY: item.y,
      startWidth: item.width,
      startHeight: item.height,
      startPositions: { [item.id]: { x: item.x, y: item.y } },
      updates: {},
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tool === "doodle-pen" || tool === "doodle-eraser") {
      setDoodleHoverPoint(getWorldPoint(event.clientX, event.clientY));
    } else if (doodleHoverPoint) {
      setDoodleHoverPoint(null);
    }
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    if (interaction.kind === "pan") {
      setViewport({
        x: interaction.startX + event.clientX - interaction.startClientX,
        y: interaction.startY + event.clientY - interaction.startClientY,
        zoom: board.viewport.zoom,
      });
      return;
    }
    if (interaction.kind === "doodle-pen" || interaction.kind === "doodle-eraser") {
      const point = getWorldPoint(event.clientX, event.clientY);
      const maximumStep = interaction.kind === "doodle-eraser"
        ? Math.max(1, interaction.size / 4)
        : Math.max(1, interaction.strokeWidth / 2);
      const points = appendCanvasDoodlePoint(interaction.points, point, maximumStep);
      interaction.points = points;
      setActiveDoodle({ ...interaction, points });
      return;
    }
    if (!interaction.moved) {
      const distance = Math.hypot(
        event.clientX - interaction.startClientX,
        event.clientY - interaction.startClientY,
      );
      if (distance < DRAG_START_THRESHOLD_PX) return;
      interaction.moved = true;
      lastTextClickRef.current = null;
    }
    const point = getWorldPoint(event.clientX, event.clientY);
    if (interaction.kind === "drag") {
      const primary = board.items.find((item): item is CanvasNodeItem => item.id === interaction.id && isCanvasNodeItem(item));
      if (!primary) return;
      const rawX = interaction.startX + point.x - interaction.startWorld.x;
      const rawY = interaction.startY + point.y - interaction.startWorld.y;
      const snap = snapCanvasNode(
        primary,
        rawX,
        rawY,
        board.items.filter((item): item is CanvasNodeItem => (
          isCanvasNodeItem(item) && !interaction.ids.includes(item.id)
        )),
      );
      const deltaX = snap.x - interaction.startX;
      const deltaY = snap.y - interaction.startY;
      interaction.updates = Object.fromEntries(interaction.ids.map((id) => {
        const start = interaction.startPositions[id];
        return [id, start ? { x: start.x + deltaX, y: start.y + deltaY } : {}];
      }));
      setAlignmentGuides(snap.guides);
    } else {
      const width = Math.max(48, Math.round((interaction.startWidth + point.x - interaction.startWorld.x) / GRID_SIZE) * GRID_SIZE);
      const height = Math.max(36, Math.round((interaction.startHeight + point.y - interaction.startWorld.y) / GRID_SIZE) * GRID_SIZE);
      interaction.updates = { [interaction.id]: { width, height } };
    }
    setDraftItems((current) => ({ ...current, ...interaction.updates }));
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    if (interaction.kind === "doodle-pen" || interaction.kind === "doodle-eraser") {
      if (interaction.kind === "doodle-pen") {
        const bounds = getCanvasDoodleBounds(interaction.points, interaction.strokeWidth / 2);
        const item: CanvasDoodleItem = {
          id: interaction.id,
          type: "doodle",
          points: interaction.points,
          stroke: interaction.color,
          strokeWidth: interaction.strokeWidth,
          opacity: 1,
          erasures: [],
          rotation: 0,
          zIndex: Math.max(-1, ...board.items.map((item) => item.zIndex)) + 1,
          ...bounds,
        };
        addItem(item);
      } else if (doodleItems.length > 0) {
        const mark: CanvasDoodleEraserMark = {
          id: interaction.id,
          points: interaction.points,
          shape: interaction.shape,
          size: interaction.size,
          opacity: interaction.opacity,
        };
        const updates: Record<string, Partial<CanvasItem>> = {};
        doodleItems.forEach((item) => {
          updates[item.id] = { erasures: [...(item.erasures ?? []), mark] } as Partial<CanvasItem>;
        });
        updateItems(updates);
      }
      interactionRef.current = null;
      setActiveDoodle(null);
      if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
      return;
    }
    let textItemToEdit: CanvasRichTextItem | null = null;
    if (interaction.kind !== "pan" && Object.keys(interaction.updates).length > 0) {
      updateItems(interaction.updates);
      setDraftItems((current) => {
        const next = { ...current };
        Object.keys(interaction.updates).forEach((id) => delete next[id]);
        return next;
      });
    }
    if (interaction.kind === "drag" && !interaction.moved) {
      const item = board.items.find((candidate): candidate is CanvasRichTextItem => (
        candidate.id === interaction.id && (candidate.type === "text" || candidate.type === "shape")
      ));
      if (item) {
        const now = performance.now();
        const previous = lastTextClickRef.current;
        const closeToPrevious = previous
          ? Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY)
            <= TEXT_DOUBLE_CLICK_DISTANCE_PX
          : false;
        if (
          previous?.id === item.id
          && now - previous.time <= TEXT_DOUBLE_CLICK_INTERVAL_MS
          && closeToPrevious
        ) {
          textItemToEdit = item;
          lastTextClickRef.current = null;
        } else {
          lastTextClickRef.current = {
            id: item.id,
            time: now,
            clientX: event.clientX,
            clientY: event.clientY,
          };
        }
      }
    } else if (interaction.kind !== "pan") {
      lastTextClickRef.current = null;
    }
    setAlignmentGuides({});
    interactionRef.current = null;
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
    if (textItemToEdit) startEditingText(textItemToEdit);
  };

  const handleRootPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = getWorldPoint(event.clientX, event.clientY);
    setLastPointer(point);
    lastTextClickRef.current = null;
    if (editingTextId) finishEditingText();
    if (event.button === 1 || tool === "pan" || spaceHeldRef.current) {
      startPan(event);
      return;
    }
    if (tool === "doodle-pen" || tool === "doodle-eraser") {
      startDoodle(event);
      return;
    }
    if (tool === "text") {
      event.preventDefault();
      addTextAt(point);
      return;
    }
    if (isShapeTool(tool)) {
      event.preventDefault();
      addShapeAt(point, tool.replace("shape-", "") as CanvasShapeType);
      return;
    }
    if (isConnectorTool(tool)) {
      setConnectorStartId(null);
      setSelectedId(null);
      return;
    }
    if (event.target === event.currentTarget || event.target instanceof SVGRectElement) {
      setSelectedId(null);
    }
  };

  const handleWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const selectedItem = selectedId
      ? board.items.find((item) => item.id === selectedId)
      : null;

    // Ctrl/Cmd + wheel is reserved for zooming the whole canvas. Without the
    // modifier, wheel-resizing applies only to the currently selected object.
    if (event.ctrlKey || event.metaKey) {
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      updateViewportAt(event.clientX, event.clientY, clamp(board.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM));
      return;
    }

    if (!selectedItem) return;

    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    if (selectedItem.type === "text") {
      updateItem(selectedItem.id, { fontSize: clamp(selectedItem.fontSize * factor, 8, 256) });
      return;
    }

    const nextWidth = clamp(selectedItem.width * factor, 48, 4096);
    const nextHeight = clamp(selectedItem.height * (nextWidth / selectedItem.width), 36, 4096);
    const centerX = selectedItem.x + selectedItem.width / 2;
    const centerY = selectedItem.y + selectedItem.height / 2;
    updateItem(selectedItem.id, {
      x: centerX - nextWidth / 2,
      y: centerY - nextHeight / 2,
      width: nextWidth,
      height: nextHeight,
    });
  };

  const handleDrop = (event: React.DragEvent<SVGSVGElement>) => {
    event.preventDefault();
    void importImageFiles(Array.from(event.dataTransfer.files));
  };

  const renderSelection = (item: CanvasNodeItem) => {
    if (!selectedIds.includes(item.id)) return null;
    return (
      <>
        <rect x={-2} y={-2} width={item.width + 4} height={item.height + 4} fill="none" stroke="var(--color-accent)" strokeWidth={2 / board.viewport.zoom} strokeDasharray={`${5 / board.viewport.zoom} ${3 / board.viewport.zoom}`} pointerEvents="none" />
        <rect
          x={item.width - 7}
          y={item.height - 7}
          width={14}
          height={14}
          rx={2}
          fill="var(--color-accent)"
          stroke="var(--color-bg-primary)"
          strokeWidth={2 / board.viewport.zoom}
          className="cursor-nwse-resize"
          onPointerDown={(event) => startResize(event, item)}
        />
      </>
    );
  };

  const renderRichTextContent = (item: CanvasRichTextItem, centered = false) => {
    if (editingTextId === item.id) return null;
    return (
      <foreignObject x={centered ? 12 : 8} y={centered ? 10 : 6} width={Math.max(1, item.width - (centered ? 24 : 16))} height={Math.max(1, item.height - (centered ? 20 : 12))} pointerEvents="none">
        <div
          className={`canvas-rich-text-content h-full w-full overflow-hidden ${centered ? "canvas-rich-text-content--centered" : ""}`}
          style={{ color: item.color, fontFamily: item.fontFamily, fontSize: item.fontSize, lineHeight: 1.35 }}
          dangerouslySetInnerHTML={{ __html: getCanvasRichTextHtml(item) }}
        />
      </foreignObject>
    );
  };

  const renderItem = (rawItem: CanvasItem) => {
    const item = getDisplayItem(rawItem);
    if (item.type === "doodle") {
      return <CanvasDoodleStroke key={item.id} item={item} maskPrefix="canvas-doodle-mask" />;
    }
    if (item.type === "connector") {
      const displayItems = orderedItems.map(getDisplayItem);
      const connector = resolveCanvasConnector(item, displayItems);
      const selected = selectedIds.includes(item.id);
      return (
        <g key={item.id} onPointerDown={(event) => startItemDrag(event, item)}>
          <path
            d={connector.path}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(14, item.strokeWidth + 10)}
            pointerEvents="stroke"
          />
          {selected && (
            <path
              d={connector.path}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={item.strokeWidth + 5 / board.viewport.zoom}
              strokeDasharray={`${6 / board.viewport.zoom} ${4 / board.viewport.zoom}`}
              opacity={0.35}
              pointerEvents="none"
            />
          )}
          <path
            d={connector.path}
            fill="none"
            stroke={item.stroke}
            strokeWidth={item.strokeWidth}
            markerEnd={item.endArrow ? `url(#canvas-arrowhead-${item.id})` : undefined}
            pointerEvents="none"
          />
        </g>
      );
    }
    const transform = `translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width / 2} ${item.height / 2})`;
    if (item.type === "image") {
      return (
        <g key={item.id} transform={transform} onPointerDown={(event) => startItemDrag(event, item)}>
          <rect width={item.width} height={item.height} fill="var(--color-bg-secondary)" opacity={assets[item.asset] ? 0 : 0.8} />
          {assets[item.asset] && <image href={assets[item.asset]} width={item.width} height={item.height} preserveAspectRatio="none" style={{ userSelect: "none" }} />}
          {renderSelection(item)}
        </g>
      );
    }
    if (item.type === "shape") {
      return (
        <g key={item.id} transform={transform} onPointerDown={(event) => startItemDrag(event, item)}>
          {item.shape === "ellipse" ? (
            <ellipse cx={item.width / 2} cy={item.height / 2} rx={item.width / 2} ry={item.height / 2} fill={item.fill} stroke={item.stroke} strokeWidth={item.strokeWidth} />
          ) : item.shape === "diamond" ? (
            <polygon points={`${item.width / 2},0 ${item.width},${item.height / 2} ${item.width / 2},${item.height} 0,${item.height / 2}`} fill={item.fill} stroke={item.stroke} strokeWidth={item.strokeWidth} />
          ) : (
            <rect width={item.width} height={item.height} rx={item.shape === "rounded" ? 18 : 2} fill={item.fill} stroke={item.stroke} strokeWidth={item.strokeWidth} />
          )}
          {renderRichTextContent(item, true)}
          {renderSelection(item)}
        </g>
      );
    }
    return (
      <g key={item.id} transform={transform} onPointerDown={(event) => startItemDrag(event, item)}>
        <rect width={item.width} height={item.height} fill="transparent" />
        {renderRichTextContent(item)}
        {renderSelection(item)}
      </g>
    );
  };

  const toolTitle = (name: string) => `${t(lang, "canvas")}: ${name}`;
  const zoomLabel = `${Math.round(board.viewport.zoom * 100)}%`;
  const activeCanvas = canvases.find((canvas) => canvas.id === activeCanvasId);
  const editingTextItem = editingTextId
    ? orderedItems.find((item): item is CanvasRichTextItem => item.id === editingTextId && (item.type === "text" || item.type === "shape")) ?? null
    : null;
  const selectedShape = selectedId
    ? orderedItems.find((item): item is CanvasShapeItem => item.id === selectedId && item.type === "shape") ?? null
    : null;
  const selectedConnector = selectedId
    ? orderedItems.find((item): item is CanvasConnectorItem => item.id === selectedId && item.type === "connector") ?? null
    : null;
  useEffect(() => {
    if (openToolbarMenu === "style" && !selectedShape && !selectedConnector) {
      setOpenToolbarMenu(null);
    }
  }, [openToolbarMenu, selectedConnector, selectedShape]);
  const insertToolActive = tool === "text" || isShapeTool(tool) || isConnectorTool(tool);
  const drawToolActive = tool === "doodle-pen" || tool === "doodle-eraser";
  const insertMenuIcon = tool === "text"
    ? <Type size={15} />
    : tool === "shape-rectangle"
      ? <RectangleHorizontal size={15} />
      : tool === "shape-rounded"
        ? <SquareRoundCorner size={15} />
        : tool === "shape-ellipse"
          ? <Circle size={15} />
          : tool === "shape-diamond"
            ? <Diamond size={15} />
            : tool === "connector-straight"
              ? <Spline size={15} />
              : tool === "connector-orthogonal"
                ? <Waypoints size={15} />
                : <ImagePlus size={15} />;

  return (
    <section className="canvas-surface flex min-h-0 flex-1 flex-col bg-bg-primary">
      <div className="flex h-11 flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-bg-secondary px-3">
        <div className="mr-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ImagePlus size={16} className="text-accent-text" />
          <span>{activeCanvas?.name || t(lang, "canvas")}</span>
        </div>
        <div className="h-5 w-px bg-border" />
        <button type="button" className={`${toolbarButton} ${tool === "select" ? "bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent" : ""}`} onClick={() => setTool("select")} title={toolTitle(t(lang, "canvasSelect"))} aria-label={t(lang, "canvasSelect")}>
          <MousePointer2 size={15} />
        </button>
        <button type="button" className={`${toolbarButton} ${tool === "pan" ? "bg-accent text-on-accent hover:bg-accent-hover hover:text-on-accent" : ""}`} onClick={() => setTool("pan")} title={toolTitle(t(lang, "canvasPan"))} aria-label={t(lang, "canvasPan")}>
          <Hand size={15} />
        </button>
        <CanvasToolbarMenu
          label={t(lang, "canvasInsert")}
          icon={insertMenuIcon}
          open={openToolbarMenu === "insert"}
          onOpenChange={(open) => setOpenToolbarMenu(open ? "insert" : null)}
          active={insertToolActive}
          panelClassName="w-72"
        >
          <div className="grid grid-cols-2 gap-1">
            <CanvasToolbarMenuItem label={t(lang, "canvasAddImage")} icon={<ImagePlus size={15} />} onSelect={() => void handleChooseImage()} />
            <CanvasToolbarMenuItem label={t(lang, "canvasAddText")} icon={<Type size={15} />} onSelect={() => setTool("text")} active={tool === "text"} />
            <CanvasToolbarMenuItem label={t(lang, "canvasShapeRectangle")} icon={<RectangleHorizontal size={15} />} onSelect={() => { setTool("shape-rectangle"); setConnectorStartId(null); }} active={tool === "shape-rectangle"} />
            <CanvasToolbarMenuItem label={t(lang, "canvasShapeRounded")} icon={<SquareRoundCorner size={15} />} onSelect={() => { setTool("shape-rounded"); setConnectorStartId(null); }} active={tool === "shape-rounded"} />
            <CanvasToolbarMenuItem label={t(lang, "canvasShapeEllipse")} icon={<Circle size={15} />} onSelect={() => { setTool("shape-ellipse"); setConnectorStartId(null); }} active={tool === "shape-ellipse"} />
            <CanvasToolbarMenuItem label={t(lang, "canvasShapeDiamond")} icon={<Diamond size={15} />} onSelect={() => { setTool("shape-diamond"); setConnectorStartId(null); }} active={tool === "shape-diamond"} />
            <CanvasToolbarMenuItem label={t(lang, "canvasConnectorStraight")} icon={<Spline size={15} />} onSelect={() => { setTool("connector-straight"); setConnectorStartId(null); }} active={tool === "connector-straight"} />
            <CanvasToolbarMenuItem label={t(lang, "canvasConnectorOrthogonal")} icon={<Waypoints size={15} />} onSelect={() => { setTool("connector-orthogonal"); setConnectorStartId(null); }} active={tool === "connector-orthogonal"} />
          </div>
        </CanvasToolbarMenu>
        <CanvasToolbarMenu
          label={t(lang, "canvasDraw")}
          icon={tool === "doodle-eraser" ? <Eraser size={15} /> : <PenLine size={15} />}
          open={openToolbarMenu === "draw"}
          onOpenChange={(open) => setOpenToolbarMenu(open ? "draw" : null)}
          active={drawToolActive}
          panelClassName="w-72"
        >
          <div className="grid grid-cols-2 gap-1">
            <CanvasToolbarMenuItem label={t(lang, "canvasDoodlePen")} icon={<PenLine size={15} />} onSelect={() => selectDoodleTool("pen")} active={tool === "doodle-pen"} closeOnSelect={false} />
            <CanvasToolbarMenuItem label={t(lang, "canvasDoodleEraser")} icon={<Eraser size={15} />} onSelect={() => selectDoodleTool("eraser")} active={tool === "doodle-eraser"} closeOnSelect={false} />
          </div>
          <div className="my-2 h-px bg-border" />
          {tool === "doodle-eraser" ? (
            <div className="space-y-3 px-1 pb-1">
              <div className="font-semibold">{t(lang, "canvasDoodleEraser")}</div>
              <div>
                <div className="mb-1.5 text-text-secondary">{t(lang, "canvasEraserShape")}</div>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg-secondary p-1">
                  {(["circle", "square"] as const).map((shape) => (
                    <button
                      key={shape}
                      type="button"
                      onClick={() => setEraserShape(shape)}
                      className={`h-7 rounded-md transition-colors ${
                        eraserShape === shape
                          ? "bg-accent text-on-accent"
                          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                      }`}
                    >
                      {t(lang, shape === "circle" ? "canvasEraserCircle" : "canvasEraserSquare")}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block text-text-secondary">
                <span className="mb-1.5 flex items-center justify-between">
                  <span>{t(lang, "canvasEraserSize")}</span>
                  <span className="tabular-nums text-text-primary">{eraserSize}px</span>
                </span>
                <input type="range" min="8" max="96" step="2" value={eraserSize} onChange={(event) => setEraserSize(Number(event.target.value))} className="w-full accent-accent" />
              </label>
              <label className="block text-text-secondary">
                <span className="mb-1.5 flex items-center justify-between">
                  <span>{t(lang, "canvasEraserOpacity")}</span>
                  <span className="tabular-nums text-text-primary">{Math.round(eraserOpacity * 100)}%</span>
                </span>
                <input type="range" min="0.1" max="1" step="0.1" value={eraserOpacity} onChange={(event) => setEraserOpacity(Number(event.target.value))} className="w-full accent-accent" />
              </label>
            </div>
          ) : (
            <div className="space-y-3 px-1 pb-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{t(lang, "canvasDoodlePen")}</span>
                <span className="h-5 w-10 rounded-full border border-border" style={{ backgroundColor: doodleColor }} />
              </div>
              <label className="flex items-center justify-between gap-3 text-text-secondary">
                <span>{t(lang, "canvasDoodleColor")}</span>
                <input type="color" value={doodleColor} onChange={(event) => setDoodleColor(event.target.value)} className="h-7 w-12 cursor-pointer rounded border border-border bg-transparent p-0" />
              </label>
              <label className="block text-text-secondary">
                <span className="mb-1.5 flex items-center justify-between">
                  <span>{t(lang, "canvasDoodleWidth")}</span>
                  <span className="tabular-nums text-text-primary">{doodleWidth}px</span>
                </span>
                <input type="range" min="1" max="24" step="1" value={doodleWidth} onChange={(event) => setDoodleWidth(Number(event.target.value))} className="w-full accent-accent" />
              </label>
            </div>
          )}
          <button
            type="button"
            onClick={clearPageDoodles}
            disabled={doodleItems.length === 0}
            className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-danger/30 text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 size={14} />
            <span>{t(lang, "canvasClearDoodles")}</span>
          </button>
        </CanvasToolbarMenu>
        <CanvasToolbarMenu
          label={t(lang, "canvasArrange")}
          icon={<Layers3 size={15} />}
          open={openToolbarMenu === "arrange"}
          onOpenChange={(open) => setOpenToolbarMenu(open ? "arrange" : null)}
          panelClassName="w-60"
        >
          <div className="space-y-1">
            <CanvasToolbarMenuItem label={t(lang, "canvasDuplicate")} icon={<Copy size={15} />} onSelect={duplicateSelection} disabled={selectedIds.length === 0} />
            <CanvasToolbarMenuItem label={t(lang, "canvasAlignHorizontal")} icon={<AlignCenterVertical size={15} />} onSelect={() => alignSelection("horizontal")} disabled={selectedIds.length < 2} />
            <CanvasToolbarMenuItem label={t(lang, "canvasAlignVertical")} icon={<AlignCenterHorizontal size={15} />} onSelect={() => alignSelection("vertical")} disabled={selectedIds.length < 2} />
            <CanvasToolbarMenuItem label={t(lang, "canvasMoveLayerUp")} icon={<ArrowUp size={15} />} onSelect={() => selectedId && moveLayer(selectedId, "up")} disabled={!canMoveLayerUp} />
            <CanvasToolbarMenuItem label={t(lang, "canvasMoveLayerDown")} icon={<ArrowDown size={15} />} onSelect={() => selectedId && moveLayer(selectedId, "down")} disabled={!canMoveLayerDown} />
            <div className="my-1 h-px bg-border" />
            <CanvasToolbarMenuItem label={t(lang, "canvasDelete")} icon={<Trash2 size={15} />} onSelect={() => removeItems(selectedIds)} disabled={selectedIds.length === 0} className="text-danger hover:bg-danger/10 hover:text-danger" />
          </div>
        </CanvasToolbarMenu>
        <CanvasToolbarMenu
          label={t(lang, "canvasView")}
          icon={<Maximize2 size={15} />}
          open={openToolbarMenu === "view"}
          onOpenChange={(open) => setOpenToolbarMenu(open ? "view" : null)}
          panelClassName="w-56"
        >
          <div className="grid grid-cols-2 gap-1">
            <CanvasToolbarMenuItem label={t(lang, "canvasZoomOut")} icon={<ZoomOut size={15} />} onSelect={() => zoomBy(0.8)} />
            <CanvasToolbarMenuItem label={t(lang, "canvasZoomIn")} icon={<ZoomIn size={15} />} onSelect={() => zoomBy(1.25)} />
            <CanvasToolbarMenuItem label={t(lang, "canvasResetZoom")} icon={<span className="font-semibold">1:1</span>} onSelect={resetZoom} />
            <CanvasToolbarMenuItem label={t(lang, "canvasFit")} icon={<Maximize2 size={15} />} onSelect={fitCanvas} />
          </div>
        </CanvasToolbarMenu>
        {(selectedShape || selectedConnector) && (
          <CanvasToolbarMenu
            label={t(lang, "canvasStyle")}
            icon={<Palette size={15} />}
            open={openToolbarMenu === "style"}
            onOpenChange={(open) => setOpenToolbarMenu(open ? "style" : null)}
            active
            align="end"
            panelClassName="w-56"
          >
            <div className="space-y-2 p-1">
              {selectedShape && (
                <label className="flex h-9 items-center justify-between gap-3 rounded-lg px-2 text-text-secondary" title={t(lang, "canvasShapeFill")}>
                  <span>{t(lang, "canvasFill")}</span>
                  <input type="color" value={selectedShape.fill.startsWith("#") ? selectedShape.fill : "#f4f7fb"} onChange={(event) => updateItem(selectedShape.id, { fill: event.target.value })} className="h-7 w-12 cursor-pointer rounded border border-border bg-transparent p-0" />
                </label>
              )}
              <label className="flex h-9 items-center justify-between gap-3 rounded-lg px-2 text-text-secondary" title={t(lang, "canvasShapeStroke")}>
                <span>{t(lang, "canvasStroke")}</span>
                <input
                  type="color"
                  value={(selectedShape?.stroke ?? selectedConnector?.stroke ?? "#3b82f6").startsWith("#") ? (selectedShape?.stroke ?? selectedConnector?.stroke ?? "#3b82f6") : "#3b82f6"}
                  onChange={(event) => {
                    if (selectedShape) updateItem(selectedShape.id, { stroke: event.target.value });
                    if (selectedConnector) updateItem(selectedConnector.id, { stroke: event.target.value });
                  }}
                  className="h-7 w-12 cursor-pointer rounded border border-border bg-transparent p-0"
                />
              </label>
            </div>
          </CanvasToolbarMenu>
        )}
        <div className="mx-1 h-5 w-px bg-border" />
        <button type="button" className={toolbarButton} onClick={undo} disabled={!hasUndo} title={t(lang, "undo")}><Undo2 size={15} /></button>
        <button type="button" className={toolbarButton} onClick={redo} disabled={!hasRedo} title={t(lang, "redo")}><Redo2 size={15} /></button>
        <span className="inline-flex h-8 min-w-12 items-center justify-center rounded-md px-2 text-xs tabular-nums text-text-secondary" title={zoomLabel}>{zoomLabel}</span>
        <div className="flex-1" />
        <span className="mr-1 hidden whitespace-nowrap text-xs text-text-muted sm:inline">{saveState === "saving" ? t(lang, "canvasSaving") : <><Check size={12} className="mr-1 inline text-success" />{t(lang, "canvasSaved")}</>}</span>
        <button type="button" className={toolbarButton} onClick={() => void handleOpenCanvasTile()} disabled={!activeCanvasId} title={t(lang, "canvasOpenTile")}>
          <Pin size={15} />
          <span className="hidden xl:inline">{t(lang, "canvasOpenTile")}</span>
        </button>
        <button type="button" className={toolbarButton} onClick={() => void handleExport()} disabled={board.items.length === 0 || exporting} title={t(lang, "canvasExport")} aria-busy={exporting}>
          <Download size={15} />
          <span className="hidden sm:inline">{exporting ? t(lang, "canvasExporting") : t(lang, "canvasExport")}</span>
        </button>
      </div>
      <div className="app-work-area-overlay relative min-h-0 flex-1 overflow-hidden">
        {canvasTextEditor && (
          <div className="absolute inset-x-0 top-0 z-50 shadow-md">
            <CanvasTextToolbar editor={canvasTextEditor} lang={lang} onDone={() => finishEditingText()} />
          </div>
        )}
        <svg
          ref={svgRef}
          className={`h-full w-full touch-none select-none ${
            tool === "pan" || spaceHeldRef.current
              ? "cursor-grab"
              : tool === "doodle-pen" || tool === "doodle-eraser"
                ? "cursor-none"
                : "cursor-default"
          }`}
          role="application"
          aria-label={t(lang, "canvas")}
          onPointerDown={handleRootPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={() => {
            if (!activeDoodle) setDoodleHoverPoint(null);
          }}
          onWheel={handleWheel}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <defs>
            <pattern id="canvas-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M 24 0 L 0 0 0 24" fill="none" stroke="var(--color-border)" strokeWidth="0.7" opacity="0.48" />
            </pattern>
            {orderedItems.filter((item): item is CanvasConnectorItem => item.type === "connector" && item.endArrow).map((item) => (
              <marker key={item.id} id={`canvas-arrowhead-${item.id}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="strokeWidth">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={item.stroke} />
              </marker>
            ))}
            <CanvasDoodleDefinitions
              items={doodleItems}
              maskPrefix="canvas-doodle-mask"
              activeEraser={activeEraserMark}
            />
          </defs>
          <rect width="100%" height="100%" fill="var(--canvas-background, var(--color-bg-primary))" />
          <g transform={`translate(${board.viewport.x} ${board.viewport.y}) scale(${board.viewport.zoom})`}>
            <rect x={-10000} y={-10000} width={20000} height={20000} fill="url(#canvas-grid)" />
            {orderedItems.map(renderItem)}
            {activeDoodle?.kind === "doodle-pen" && (
              activeDoodle.points.length === 1 ? (
                <circle
                  cx={activeDoodle.points[0].x}
                  cy={activeDoodle.points[0].y}
                  r={activeDoodle.strokeWidth / 2}
                  fill={activeDoodle.color}
                  pointerEvents="none"
                />
              ) : (
                <path
                  d={canvasDoodlePath(activeDoodle.points)}
                  fill="none"
                  stroke={activeDoodle.color}
                  strokeWidth={activeDoodle.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pointerEvents="none"
                />
              )
            )}
            {doodleHoverPoint && tool === "doodle-pen" && !activeDoodle && (
              <circle
                cx={doodleHoverPoint.x}
                cy={doodleHoverPoint.y}
                r={Math.max(1.5, doodleWidth / 2)}
                fill={doodleColor}
                stroke="var(--color-bg-primary)"
                strokeWidth={1 / board.viewport.zoom}
                pointerEvents="none"
              />
            )}
            {doodleHoverPoint && tool === "doodle-eraser" && (
              eraserShape === "circle" ? (
                <circle
                  cx={doodleHoverPoint.x}
                  cy={doodleHoverPoint.y}
                  r={eraserSize / 2}
                  fill="var(--color-bg-primary)"
                  fillOpacity={0.2}
                  stroke="var(--color-danger)"
                  strokeWidth={1.5 / board.viewport.zoom}
                  pointerEvents="none"
                />
              ) : (
                <rect
                  x={doodleHoverPoint.x - eraserSize / 2}
                  y={doodleHoverPoint.y - eraserSize / 2}
                  width={eraserSize}
                  height={eraserSize}
                  fill="var(--color-bg-primary)"
                  fillOpacity={0.2}
                  stroke="var(--color-danger)"
                  strokeWidth={1.5 / board.viewport.zoom}
                  pointerEvents="none"
                />
              )
            )}
            {alignmentGuides.x !== undefined && <line x1={alignmentGuides.x} y1={-10000} x2={alignmentGuides.x} y2={10000} stroke="var(--color-accent)" strokeWidth={1 / board.viewport.zoom} strokeDasharray={`${4 / board.viewport.zoom} ${4 / board.viewport.zoom}`} pointerEvents="none" />}
            {alignmentGuides.y !== undefined && <line x1={-10000} y1={alignmentGuides.y} x2={10000} y2={alignmentGuides.y} stroke="var(--color-accent)" strokeWidth={1 / board.viewport.zoom} strokeDasharray={`${4 / board.viewport.zoom} ${4 / board.viewport.zoom}`} pointerEvents="none" />}
          </g>
        </svg>
        {editingTextItem && (
          <CanvasRichTextEditor
            key={editingTextItem.id}
            content={editingHtml}
            onUpdate={handleEditingTextUpdate}
            onEditorChange={setCanvasTextEditor}
            onSubmit={() => finishEditingText()}
            onCancel={() => finishEditingText(true)}
            className="absolute z-40 overflow-hidden"
            style={{
              boxSizing: "border-box",
              left: board.viewport.x + editingTextItem.x * board.viewport.zoom,
              top: board.viewport.y + editingTextItem.y * board.viewport.zoom,
              width: editingTextItem.width * board.viewport.zoom,
              height: editingTextItem.height * board.viewport.zoom,
              transform: `rotate(${editingTextItem.rotation}deg)`,
              transformOrigin: "center",
              border: "2px solid var(--color-accent)",
              borderRadius: Math.max(3, 6 * board.viewport.zoom),
              outline: "none",
              padding: Math.max(2, 8 * board.viewport.zoom),
              background: editingTextItem.type === "shape" ? "color-mix(in srgb, var(--color-bg-primary) 86%, transparent)" : "var(--color-bg-primary)",
              color: editingTextItem.color,
              fontFamily: editingTextItem.fontFamily,
              fontSize: editingTextItem.fontSize * board.viewport.zoom,
              lineHeight: 1.35,
              userSelect: "text",
              WebkitUserSelect: "text",
            }}
          />
        )}
        {!loaded && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-primary/80 text-sm text-text-muted">{t(lang, "canvasLoading")}</div>}
        {loaded && board.items.length === 0 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="rounded-xl border border-border bg-bg-secondary/90 px-5 py-4 text-center shadow-sm"><ImagePlus size={24} className="mx-auto mb-2 text-accent-text" /><p className="text-sm font-medium text-text-primary">{t(lang, "canvasEmpty")}</p><p className="mt-1 text-xs text-text-muted">{t(lang, "canvasPasteHint")}</p></div></div>}
        <div className="pointer-events-auto absolute bottom-4 right-4 z-20 w-[220px] overflow-hidden rounded-xl border border-border bg-bg-secondary/90 shadow-xl ring-1 ring-black/5 backdrop-blur-sm">
          <div className="flex h-8 items-center justify-between border-b border-border px-3 text-[11px] font-semibold text-text-secondary">
            <span>{t(lang, "canvasOverview")}</span>
            <span className="rounded-full bg-bg-hover px-1.5 py-0.5 text-[10px] font-medium text-text-muted">{minimap.items.length}</span>
          </div>
          <svg
            width="220"
            height="132"
            viewBox={`${minimap.viewBox.x} ${minimap.viewBox.y} ${minimap.viewBox.width} ${minimap.viewBox.height}`}
            className="block h-[132px] w-full cursor-default bg-bg-primary"
            aria-hidden="true"
          >
            <defs>
              <pattern id="canvas-minimap-grid" width="36" height="36" patternUnits="userSpaceOnUse">
                <path d="M 36 0 L 0 0 0 36" fill="none" stroke="var(--color-border)" strokeWidth="1" opacity="0.42" />
              </pattern>
              {minimap.items.filter((item): item is CanvasImageItem => item.type === "image").map((item) => (
                <clipPath key={`clip-${item.id}`} id={`canvas-minimap-clip-${item.id}`}>
                  <rect x={item.x} y={item.y} width={Math.max(8, item.width)} height={Math.max(5, item.height)} rx={Math.max(2, Math.min(8, item.width * 0.04))} />
                </clipPath>
              ))}
              <CanvasDoodleDefinitions
                items={minimap.items.filter((item): item is CanvasDoodleItem => item.type === "doodle")}
                maskPrefix="canvas-minimap-doodle-mask"
              />
            </defs>
            <rect x={minimap.viewBox.x} y={minimap.viewBox.y} width={minimap.viewBox.width} height={minimap.viewBox.height} fill="var(--color-bg-primary)" />
            <rect x={minimap.viewBox.x} y={minimap.viewBox.y} width={minimap.viewBox.width} height={minimap.viewBox.height} fill="url(#canvas-minimap-grid)" />
            {minimap.items.map((item) => {
              const strokeWidth = Math.max(0.5, minimap.viewBox.width / 420);
              if (item.type === "connector") {
                const connector = resolveCanvasConnector(item, minimap.items);
                return (
                  <g key={item.id} className="cursor-pointer" onClick={(event) => handleMinimapItemClick(event, item)}>
                    <path d={connector.path} fill="none" stroke={selectedIds.includes(item.id) ? "var(--color-text-primary)" : item.stroke} strokeWidth={selectedIds.includes(item.id) ? strokeWidth * 2.2 : strokeWidth * 1.4} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              }
              if (item.type === "doodle") {
                return (
                  <g key={item.id}>
                    <CanvasDoodleStroke item={item} maskPrefix="canvas-minimap-doodle-mask" />
                  </g>
                );
              }
              const width = Math.max(8, item.width);
              const height = Math.max(5, item.height);
              if (item.type === "image") {
                return (
                  <g key={item.id} className="cursor-pointer" onClick={(event) => handleMinimapItemClick(event, item)}>
                    <rect x={item.x + strokeWidth} y={item.y + strokeWidth} width={Math.max(1, width - strokeWidth * 2)} height={Math.max(1, height - strokeWidth * 2)} rx={Math.max(2, Math.min(8, width * 0.04))} fill="var(--color-accent-light)" opacity="0.95" />
                    {assets[item.asset] && <image href={assets[item.asset]} x={item.x} y={item.y} width={width} height={height} preserveAspectRatio="xMidYMid slice" clipPath={`url(#canvas-minimap-clip-${item.id})`} />}
                    <rect x={item.x} y={item.y} width={width} height={height} rx={Math.max(2, Math.min(8, width * 0.04))} fill="none" stroke={selectedIds.includes(item.id) ? "var(--color-text-primary)" : "var(--color-accent)"} strokeWidth={selectedIds.includes(item.id) ? strokeWidth * 1.8 : strokeWidth} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              }
              if (item.type === "shape") {
                return (
                  <g key={item.id} className="cursor-pointer" onClick={(event) => handleMinimapItemClick(event, item)}>
                    {item.shape === "ellipse" ? (
                      <ellipse cx={item.x + width / 2} cy={item.y + height / 2} rx={width / 2} ry={height / 2} fill={item.fill} stroke={selectedIds.includes(item.id) ? "var(--color-text-primary)" : item.stroke} strokeWidth={selectedIds.includes(item.id) ? strokeWidth * 1.8 : strokeWidth} vectorEffect="non-scaling-stroke" />
                    ) : item.shape === "diamond" ? (
                      <polygon points={`${item.x + width / 2},${item.y} ${item.x + width},${item.y + height / 2} ${item.x + width / 2},${item.y + height} ${item.x},${item.y + height / 2}`} fill={item.fill} stroke={selectedIds.includes(item.id) ? "var(--color-text-primary)" : item.stroke} strokeWidth={selectedIds.includes(item.id) ? strokeWidth * 1.8 : strokeWidth} vectorEffect="non-scaling-stroke" />
                    ) : (
                      <rect x={item.x} y={item.y} width={width} height={height} rx={item.shape === "rounded" ? Math.min(12, height * 0.15) : 2} fill={item.fill} stroke={selectedIds.includes(item.id) ? "var(--color-text-primary)" : item.stroke} strokeWidth={selectedIds.includes(item.id) ? strokeWidth * 1.8 : strokeWidth} vectorEffect="non-scaling-stroke" />
                    )}
                  </g>
                );
              }
              return (
                <g key={item.id} className="cursor-pointer" onClick={(event) => handleMinimapItemClick(event, item)}>
                  <rect x={item.x} y={item.y} width={width} height={height} rx={3} fill="var(--color-accent)" fillOpacity="0.16" stroke={selectedIds.includes(item.id) ? "var(--color-text-primary)" : "var(--color-accent)"} strokeWidth={selectedIds.includes(item.id) ? strokeWidth * 1.8 : strokeWidth} vectorEffect="non-scaling-stroke" />
                  <rect x={item.x + width * 0.12} y={item.y + height * 0.25} width={Math.max(4, width * 0.7)} height={Math.max(1, height * 0.08)} rx={1} fill="var(--color-accent)" opacity="0.7" />
                  <rect x={item.x + width * 0.12} y={item.y + height * 0.46} width={Math.max(3, width * 0.52)} height={Math.max(1, height * 0.08)} rx={1} fill="var(--color-accent)" opacity="0.45" />
                </g>
              );
            })}
            <rect
              x={minimap.viewport.x}
              y={minimap.viewport.y}
              width={Math.max(1, minimap.viewport.width)}
              height={Math.max(1, minimap.viewport.height)}
              fill="var(--color-accent)"
              fillOpacity="0.1"
              stroke="var(--color-accent)"
              strokeWidth={Math.max(1, minimap.viewBox.width / 260)}
              strokeDasharray={`${Math.max(3, minimap.viewBox.width / 90)} ${Math.max(2, minimap.viewBox.width / 150)}`}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          </svg>
        </div>
        <div className="canvas-switcher absolute right-0 top-1/2 z-30 -mt-[30px] -translate-y-1/2">
          <div
            className={`canvas-switcher-panel flex flex-col ${canvasMenuOpen ? "canvas-switcher-panel--open" : ""}`}
            role="region"
            aria-label={t(lang, "canvas")}
            aria-expanded={canvasMenuOpen}
          >
            {creatingCanvas ? (
              <form
                className="canvas-switcher-create flex h-10 w-full flex-shrink-0 items-center gap-1 border-b border-border px-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createCanvas();
                }}
              >
                <Plus size={16} className="flex-shrink-0 text-accent-text" />
                <input
                  ref={newCanvasInputRef}
                  value={newCanvasName}
                  onChange={(event) => setNewCanvasName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCreatingCanvas(false);
                      setNewCanvasName("");
                    }
                  }}
                  className="canvas-switcher-input min-w-0 flex-1 bg-transparent px-2 text-xs text-text-primary outline-none placeholder:text-text-muted"
                  placeholder={t(lang, "canvasNamePlaceholder")}
                  maxLength={80}
                  aria-label={t(lang, "canvasNamePlaceholder")}
                  disabled={switchingCanvas || !canvasListLoaded || !loaded}
                />
                <button
                  type="submit"
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-accent-text transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={switchingCanvas || !canvasListLoaded || !loaded || !newCanvasName.trim()}
                  title={t(lang, "add")}
                  aria-label={t(lang, "add")}
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                  onClick={() => {
                    setCreatingCanvas(false);
                    setNewCanvasName("");
                  }}
                  title={t(lang, "close")}
                  aria-label={t(lang, "close")}
                >
                  <X size={14} />
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="canvas-switcher-new flex h-10 w-full flex-shrink-0 items-center gap-2 border-b border-border px-3 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  setCanvasMenuOpen(true);
                  setCreatingCanvas(true);
                  setNewCanvasName("");
                }}
                disabled={switchingCanvas || !canvasListLoaded || !loaded}
                title={t(lang, "canvasNew")}
              >
                <span className="canvas-switcher-plus flex h-6 w-6 flex-shrink-0 items-center justify-center">
                  <Plus size={15} />
                </span>
                <span className={`overflow-hidden whitespace-nowrap text-xs font-medium transition-[max-width,opacity] duration-200 ${canvasMenuOpen ? "max-w-40 opacity-100" : "max-w-0 opacity-0"}`}>
                  {t(lang, "canvasNew")}
                </span>
              </button>
            )}
            <div className="min-h-0 max-h-[116px] overflow-x-hidden overflow-y-auto py-1">
              {canvases.map((canvas, index) => (
                <div
                  key={canvas.id}
                  className={`canvas-switcher-row mx-1 flex items-center rounded-md ${canvas.id === activeCanvasId ? "canvas-switcher-row--active bg-accent/15 text-accent-text" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
                  style={{ animationDelay: `${Math.min(index * 35, 210)}ms` }}
                >
                  <button
                    type="button"
                    className="flex h-9 w-8 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-bg-active/70 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void switchCanvas(canvas.id)}
                    disabled={switchingCanvas || !canvasListLoaded || !loaded}
                    title={canvas.name}
                    aria-label={`${t(lang, "canvas")}: ${canvas.name}`}
                  >
                    <span className="canvas-switcher-index flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-bg-hover text-[10px] font-semibold text-text-muted">{index + 1}</span>
                  </button>
                  {deletingCanvasId === canvas.id ? (
                    <div className="canvas-switcher-confirm flex h-9 min-w-0 flex-1 items-center gap-1 pr-1">
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-danger">{tWithParams(lang, "canvasDeleteQuestion", { name: canvas.name })}</span>
                      <button
                        type="button"
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded bg-danger text-on-danger transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void removeCanvas(canvas.id)}
                        disabled={switchingCanvas || !canvasListLoaded || !loaded}
                        title={t(lang, "confirmYes")}
                        aria-label={t(lang, "confirmYes")}
                      >
                        <Check size={13} />
                      </button>
                      <button
                        type="button"
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-active hover:text-text-primary"
                        onClick={() => setDeletingCanvasId(null)}
                        title={t(lang, "confirmNo")}
                        aria-label={t(lang, "confirmNo")}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ) : renamingCanvasId === canvas.id ? (
                    <form
                      className="canvas-switcher-rename flex h-9 min-w-0 flex-1 items-center gap-1 pr-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void renameCanvas();
                      }}
                    >
                      <input
                        ref={renameCanvasInputRef}
                        value={renamingCanvasName}
                        onChange={(event) => setRenamingCanvasName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRenameCanvas();
                          }
                        }}
                        className="canvas-switcher-input h-7 min-w-0 flex-1 px-2 text-xs text-text-primary outline-none placeholder:text-text-muted"
                        placeholder={t(lang, "canvasNamePlaceholder")}
                        maxLength={80}
                        aria-label={t(lang, "canvasRename")}
                        disabled={switchingCanvas || !canvasListLoaded || !loaded}
                      />
                      <button
                        type="submit"
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-accent-text transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={switchingCanvas || !canvasListLoaded || !loaded || !renamingCanvasName.trim()}
                        title={t(lang, "confirmYes")}
                        aria-label={t(lang, "confirmYes")}
                      >
                        <Check size={13} />
                      </button>
                      <button
                        type="button"
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-active hover:text-text-primary"
                        onClick={cancelRenameCanvas}
                        title={t(lang, "confirmNo")}
                        aria-label={t(lang, "confirmNo")}
                      >
                        <X size={13} />
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={`h-9 min-w-0 flex-1 truncate whitespace-nowrap px-1 text-left text-xs transition-[max-width,opacity,color] duration-200 hover:underline disabled:cursor-not-allowed ${canvasMenuOpen ? "max-w-40 opacity-100" : "pointer-events-none max-w-0 opacity-0"}`}
                        onClick={() => beginRenameCanvas(canvas)}
                        disabled={switchingCanvas || !canvasListLoaded || !loaded}
                        title={`${t(lang, "canvasRename")}: ${canvas.name}`}
                      >
                        {canvas.name}
                      </button>
                      <button
                        type="button"
                        className={`canvas-switcher-delete flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed ${canvasMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
                        onClick={() => requestDeleteCanvas(canvas.id)}
                        disabled={switchingCanvas || !canvasListLoaded || !loaded}
                        title={t(lang, "canvasDeleteCanvas")}
                        aria-label={`${t(lang, "canvasDeleteCanvas")}: ${canvas.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="canvas-switcher-footer flex h-8 w-full flex-shrink-0 cursor-pointer items-center justify-center border-t border-border transition-colors hover:bg-bg-hover hover:text-accent-text"
              onClick={toggleCanvasMenu}
              title={t(lang, canvasMenuOpen ? "canvasCloseList" : "canvasOpenList")}
              aria-label={t(lang, canvasMenuOpen ? "canvasCloseList" : "canvasOpenList")}
              aria-expanded={canvasMenuOpen}
            >
              <PanelRight size={14} className={`transition-transform duration-300 ${canvasMenuOpen ? "rotate-180 text-accent-text" : ""}`} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
