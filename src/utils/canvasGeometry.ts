import type {
  CanvasAnchor,
  CanvasConnectorItem,
  CanvasItem,
  CanvasNodeItem,
} from "@/types";
import { isCanvasNodeItem } from "@/types/canvas";

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasConnectorGeometry {
  start: CanvasPoint;
  end: CanvasPoint;
  path: string;
}

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function getCanvasItemCenter(item: CanvasNodeItem): CanvasPoint {
  return { x: item.x + item.width / 2, y: item.y + item.height / 2 };
}

export function getCanvasAnchorPoint(item: CanvasNodeItem, anchor: CanvasAnchor): CanvasPoint {
  switch (anchor) {
    case "top": return { x: item.x + item.width / 2, y: item.y };
    case "right": return { x: item.x + item.width, y: item.y + item.height / 2 };
    case "bottom": return { x: item.x + item.width / 2, y: item.y + item.height };
    case "left": return { x: item.x, y: item.y + item.height / 2 };
  }
}

export function chooseCanvasAnchors(
  startItem: CanvasNodeItem,
  endItem: CanvasNodeItem,
): { start: CanvasAnchor; end: CanvasAnchor } {
  const start = getCanvasItemCenter(startItem);
  const end = getCanvasItemCenter(endItem);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontalWeight = Math.abs(dx) / Math.max(1, (startItem.width + endItem.width) / 2);
  const verticalWeight = Math.abs(dy) / Math.max(1, (startItem.height + endItem.height) / 2);
  if (horizontalWeight >= verticalWeight) {
    return dx >= 0 ? { start: "right", end: "left" } : { start: "left", end: "right" };
  }
  return dy >= 0 ? { start: "bottom", end: "top" } : { start: "top", end: "bottom" };
}

function orthogonalPath(start: CanvasPoint, end: CanvasPoint): string {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  if (dx >= dy) {
    const middleX = (start.x + end.x) / 2;
    return `M ${start.x} ${start.y} H ${middleX} V ${end.y} H ${end.x}`;
  }
  const middleY = (start.y + end.y) / 2;
  return `M ${start.x} ${start.y} V ${middleY} H ${end.x} V ${end.y}`;
}

/**
 * Smooth cubic used by structure-tree connectors. The control points leave
 * each endpoint horizontally (or vertically) so the curve meets the node edge
 * flush; the reach is sign-aware, otherwise a right-to-left edge would bow
 * backwards into the nodes.
 */
function curvePath(start: CanvasPoint, end: CanvasPoint): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const reach = Math.max(40, Math.abs(dx) / 2) * (dx < 0 ? -1 : 1);
    return `M ${start.x} ${start.y} C ${start.x + reach} ${start.y}, ${end.x - reach} ${end.y}, ${end.x} ${end.y}`;
  }
  const reach = Math.max(40, Math.abs(dy) / 2) * (dy < 0 ? -1 : 1);
  return `M ${start.x} ${start.y} C ${start.x} ${start.y + reach}, ${end.x} ${end.y - reach}, ${end.x} ${end.y}`;
}

export function resolveCanvasConnector(
  connector: CanvasConnectorItem,
  items: CanvasItem[],
): CanvasConnectorGeometry {
  const startItem = connector.startBinding
    ? items.find((item): item is CanvasNodeItem => item.id === connector.startBinding?.itemId && isCanvasNodeItem(item))
    : undefined;
  const endItem = connector.endBinding
    ? items.find((item): item is CanvasNodeItem => item.id === connector.endBinding?.itemId && isCanvasNodeItem(item))
    : undefined;
  const start = startItem && connector.startBinding
    ? getCanvasAnchorPoint(startItem, connector.startBinding.anchor)
    : { x: connector.x, y: connector.y };
  const end = endItem && connector.endBinding
    ? getCanvasAnchorPoint(endItem, connector.endBinding.anchor)
    : { x: connector.x + connector.width, y: connector.y + connector.height };
  // A folded branch hides its items but keeps them in the board; the edges to
  // those items must disappear with them, otherwise a collapsed subtree still
  // shows a fan of lines running into nothing.
  if (startItem?.hidden || endItem?.hidden) {
    return { start, end, path: "" };
  }
  return {
    start,
    end,
    path: connector.style === "curve"
      ? curvePath(start, end)
      : connector.style === "orthogonal"
        ? orthogonalPath(start, end)
        : `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
  };
}

/**
 * Items that should be drawn: hidden ones are dropped, and so are connectors
 * whose endpoints are hidden — otherwise a folded subtree still shows a fan of
 * lines running into nothing.
 */
export function visibleCanvasItems(items: CanvasItem[]): CanvasItem[] {
  const hiddenIds = new Set(items.filter((item) => item.hidden).map((item) => item.id));
  return items.filter((item) => {
    if (item.hidden) return false;
    if (item.type !== "connector") return true;
    if (item.startBinding && hiddenIds.has(item.startBinding.itemId)) return false;
    if (item.endBinding && hiddenIds.has(item.endBinding.itemId)) return false;
    return true;
  });
}

export function getCanvasItemBounds(item: CanvasItem, items: CanvasItem[]): CanvasBounds {
  if (item.type === "connector") {
    const { start, end } = resolveCanvasConnector(item, items);
    const margin = Math.max(6, item.strokeWidth * 3);
    return {
      minX: Math.min(start.x, end.x) - margin,
      minY: Math.min(start.y, end.y) - margin,
      maxX: Math.max(start.x, end.x) + margin,
      maxY: Math.max(start.y, end.y) + margin,
    };
  }
  return {
    minX: item.x,
    minY: item.y,
    maxX: item.x + item.width,
    maxY: item.y + item.height,
  };
}
