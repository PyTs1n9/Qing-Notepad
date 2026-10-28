import type {
  CanvasConnectorItem,
  CanvasDoodleItem,
  CanvasItem,
  CanvasNodeItem,
  CanvasRefItem,
  CanvasRichTextItem,
  CanvasShapeItem,
} from "@/types";
import { getCanvasItemBounds, resolveCanvasConnector, visibleCanvasItems, type CanvasBounds } from "@/utils/canvasGeometry";
import { canvasHtmlToXhtml, getCanvasRichTextHtml } from "@/utils/canvasRichText";
import {
  canvasDoodleEraserMarkup,
  canvasDoodleMaskId,
  canvasDoodlePath,
} from "@/utils/canvasDoodle";

interface CanvasExportOptions {
  items: CanvasItem[];
  assets: Record<string, string>;
}

const MAX_EXPORT_SIDE = 16_384;
const MAX_EXPORT_PIXELS = 67_108_864;
const PNG_EXPORT_SCALE = 2;

function resolveCssColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rotatedNodeBounds(item: CanvasNodeItem): CanvasBounds {
  if (!item.rotation) return getCanvasItemBounds(item, [item]);
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  const radians = item.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const corners = [
    [item.x, item.y],
    [item.x + item.width, item.y],
    [item.x + item.width, item.y + item.height],
    [item.x, item.y + item.height],
  ].map(([x, y]) => ({
    x: centerX + (x - centerX) * cosine - (y - centerY) * sine,
    y: centerY + (x - centerX) * sine + (y - centerY) * cosine,
  }));
  return {
    minX: Math.min(...corners.map((point) => point.x)),
    minY: Math.min(...corners.map((point) => point.y)),
    maxX: Math.max(...corners.map((point) => point.x)),
    maxY: Math.max(...corners.map((point) => point.y)),
  };
}

function getContentBounds(items: CanvasItem[]): CanvasBounds | null {
  return items.reduce<CanvasBounds | null>((bounds, item) => {
    if (item.hidden) return bounds;
    const current = item.type === "connector"
      ? getCanvasItemBounds(item, items)
      : item.type === "doodle"
        ? getCanvasItemBounds(item, items)
        : rotatedNodeBounds(item);
    return bounds ? {
      minX: Math.min(bounds.minX, current.minX),
      minY: Math.min(bounds.minY, current.minY),
      maxX: Math.max(bounds.maxX, current.maxX),
      maxY: Math.max(bounds.maxY, current.maxY),
    } : current;
  }, null);
}

function richTextMarkup(item: CanvasRichTextItem, centered: boolean): string {
  const insetX = centered ? 12 : 8;
  const insetY = centered ? 10 : 6;
  const width = Math.max(1, item.width - insetX * 2);
  const height = Math.max(1, item.height - insetY * 2);
  const color = escapeXml(resolveCssColor(item.color));
  const family = escapeXml(item.fontFamily);
  const content = canvasHtmlToXhtml(getCanvasRichTextHtml(item));
  const alignment = centered ? "display:flex;flex-direction:column;justify-content:center;text-align:center;" : "";
  const css = [
    "*{box-sizing:border-box}",
    "p,h1,h2,h3,blockquote{margin:0}",
    "p+p,h1+p,h2+p,h3+p{margin-top:.35em}",
    "h1{font-size:1.7em;font-weight:700;line-height:1.15}",
    "h2{font-size:1.4em;font-weight:650;line-height:1.2}",
    "h3{font-size:1.18em;font-weight:600;line-height:1.25}",
    "ul,ol{margin:.25em 0;padding-left:1.4em}",
    "ul{list-style:disc}ol{list-style:decimal}",
    "blockquote{border-left:3px solid currentColor;padding-left:.6em;opacity:.82}",
    "mark{border-radius:.18em;padding:0 .12em}",
  ].join("");
  return `<foreignObject x="${insetX}" y="${insetY}" width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;overflow:hidden;overflow-wrap:anywhere;color:${color};font-family:${family};font-size:${item.fontSize}px;line-height:1.35;${alignment}"><style>${css}</style><div style="width:100%">${content}</div></div></foreignObject>`;
}

function shapeMarkup(item: CanvasShapeItem): string {
  const fill = escapeXml(resolveCssColor(item.fill));
  const stroke = escapeXml(resolveCssColor(item.stroke));
  if (item.shape === "ellipse") {
    return `<ellipse cx="${item.width / 2}" cy="${item.height / 2}" rx="${item.width / 2}" ry="${item.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${item.strokeWidth}" />`;
  }
  if (item.shape === "diamond") {
    return `<polygon points="${item.width / 2},0 ${item.width},${item.height / 2} ${item.width / 2},${item.height} 0,${item.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${item.strokeWidth}" />`;
  }
  return `<rect width="${item.width}" height="${item.height}" rx="${item.shape === "rounded" ? 18 : 2}" fill="${fill}" stroke="${stroke}" stroke-width="${item.strokeWidth}" />`;
}

function arrowMarkup(item: CanvasConnectorItem, items: CanvasItem[]): string {
  if (!item.endArrow) return "";
  const { start, end, path } = resolveCanvasConnector(item, items);
  if (!path) return "";
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  // Both orthogonal and curve connectors leave the node edge axis-aligned, so
  // the arrowhead has to follow that axis rather than the chord.
  if (item.style === "orthogonal" || item.style === "curve") {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const arrowLength = Math.max(9, item.strokeWidth * 4.5);
  const arrowWidth = arrowLength * 0.72;
  const baseX = end.x - ux * arrowLength;
  const baseY = end.y - uy * arrowLength;
  const perpendicularX = -uy * arrowWidth / 2;
  const perpendicularY = ux * arrowWidth / 2;
  const color = escapeXml(resolveCssColor(item.stroke));
  return `<polygon points="${end.x},${end.y} ${baseX + perpendicularX},${baseY + perpendicularY} ${baseX - perpendicularX},${baseY - perpendicularY}" fill="${color}" />`;
}

function doodleMarkup(item: CanvasDoodleItem): string {
  const color = escapeXml(resolveCssColor(item.stroke));
  const maskId = canvasDoodleMaskId("canvas-export-doodle-mask", item.id);
  const padding = Math.max(item.strokeWidth * 2, 4);
  const erasures = (item.erasures ?? []).map(canvasDoodleEraserMarkup).join("");
  const mask = `<mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="${item.x - padding}" y="${item.y - padding}" width="${item.width + padding * 2}" height="${item.height + padding * 2}" style="mask-type:luminance"><rect x="${item.x - padding}" y="${item.y - padding}" width="${item.width + padding * 2}" height="${item.height + padding * 2}" fill="white" />${erasures}</mask>`;
  const stroke = item.points.length === 1
    ? `<circle cx="${item.points[0].x}" cy="${item.points[0].y}" r="${item.strokeWidth / 2}" fill="${color}" opacity="${item.opacity}" mask="url(#${maskId})" />`
    : `<path d="${canvasDoodlePath(item.points)}" fill="none" stroke="${color}" stroke-width="${item.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${item.opacity}" mask="url(#${maskId})" />`;
  return `<g><defs>${mask}</defs>${stroke}</g>`;
}

function refMarkup(item: CanvasRefItem): string {
  const backdrop = escapeXml(resolveCssColor("var(--color-bg-secondary)"));
  const border = escapeXml(resolveCssColor("var(--color-border)"));
  const accent = escapeXml(resolveCssColor("var(--color-accent)"));
  const titleColor = escapeXml(resolveCssColor("var(--color-text-primary)"));
  const mutedColor = escapeXml(resolveCssColor("var(--color-text-secondary)"));
  const inset = 12;
  const body = item.summary || item.excerpt || "";
  const kindOpacity = item.ref.kind === "note" ? 0.35 : 1;
  const text = [
    `<div style="font-size:13px;font-weight:600;line-height:1.3;color:${titleColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeXml(item.title)}</div>`,
    body
      ? `<div style="margin-top:4px;font-size:11.5px;line-height:1.45;color:${mutedColor};max-height:${Math.max(1, item.height - inset * 2 - 20)}px;overflow:hidden">${escapeXml(body)}</div>`
      : "",
  ].join("");
  return [
    `<rect width="${item.width}" height="${item.height}" rx="10" fill="${backdrop}" stroke="${border}" stroke-width="1" />`,
    `<rect width="3" height="${Math.max(1, item.height - 8)}" y="4" rx="1.5" fill="${accent}" opacity="${kindOpacity}" />`,
    `<foreignObject x="${inset}" y="${inset}" width="${Math.max(1, item.width - inset * 2)}" height="${Math.max(1, item.height - inset * 2)}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;overflow:hidden;font-family:system-ui,sans-serif">${text}</div>`,
    "</foreignObject>",
  ].join("");
}

function itemMarkup(item: CanvasItem, items: CanvasItem[], assets: Record<string, string>): string {
  if (item.type === "doodle") return doodleMarkup(item);
  if (item.type === "connector") {
    const connector = resolveCanvasConnector(item, items);
    const stroke = escapeXml(resolveCssColor(item.stroke));
    return `<g><path d="${connector.path}" fill="none" stroke="${stroke}" stroke-width="${item.strokeWidth}" />${arrowMarkup(item, items)}</g>`;
  }

  const transform = `translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width / 2} ${item.height / 2})`;
  if (item.type === "image") {
    const dataUrl = assets[item.asset];
    if (!dataUrl) throw new Error(`Missing canvas asset: ${item.asset}`);
    return `<g transform="${transform}"><image href="${escapeXml(dataUrl)}" width="${item.width}" height="${item.height}" preserveAspectRatio="none" /></g>`;
  }
  if (item.type === "shape") {
    return `<g transform="${transform}">${shapeMarkup(item)}${richTextMarkup(item, true)}</g>`;
  }
  if (item.type === "ref") {
    return `<g transform="${transform}">${refMarkup(item)}</g>`;
  }
  return `<g transform="${transform}">${richTextMarkup(item, false)}</g>`;
}

function buildSvg({ items, assets }: CanvasExportOptions, pixelScale = 1): { svg: string; width: number; height: number } {
  const visible = visibleCanvasItems(items);
  const bounds = getContentBounds(visible);
  if (!bounds) throw new Error("Canvas has no visible content");
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const background = escapeXml(resolveCssColor("var(--canvas-background, var(--color-bg-primary))"));
  const content = visible
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((item) => itemMarkup(item, visible, assets))
    .join("");
  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.ceil(width * pixelScale)}" height="${Math.ceil(height * pixelScale)}" viewBox="${bounds.minX} ${bounds.minY} ${width} ${height}">`,
    `<rect x="${bounds.minX}" y="${bounds.minY}" width="${width}" height="${height}" fill="${background}" />`,
    content,
    "</svg>",
  ].join("\n");
  return { svg, width, height };
}

async function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to rasterize canvas SVG"));
      image.src = url;
    });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasToImage(canvas: HTMLCanvasElement, mimeType: "image/png" | "image/jpeg"): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to create canvas image"));
        return;
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, mimeType, mimeType === "image/jpeg" ? 0.95 : undefined);
  });
}

async function renderCanvasToRaster(options: CanvasExportOptions, mimeType: "image/png" | "image/jpeg"): Promise<Uint8Array> {
  await document.fonts.ready;
  const initial = buildSvg(options);
  const scale = Math.min(
    PNG_EXPORT_SCALE,
    MAX_EXPORT_SIDE / initial.width,
    MAX_EXPORT_SIDE / initial.height,
    Math.sqrt(MAX_EXPORT_PIXELS / (initial.width * initial.height)),
  );
  const rendered = buildSvg(options, scale);
  const image = await loadSvgImage(rendered.svg);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(initial.width * scale));
  canvas.height = Math.max(1, Math.ceil(initial.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasToImage(canvas, mimeType);
}

export function renderCanvasToPng(options: CanvasExportOptions): Promise<Uint8Array> {
  return renderCanvasToRaster(options, "image/png");
}

export function renderCanvasToJpeg(options: CanvasExportOptions): Promise<Uint8Array> {
  return renderCanvasToRaster(options, "image/jpeg");
}

export async function renderCanvasToSvg(options: CanvasExportOptions): Promise<string> {
  await document.fonts.ready;
  return buildSvg(options).svg;
}
