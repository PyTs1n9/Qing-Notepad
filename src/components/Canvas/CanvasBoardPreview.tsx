import type { CanvasBoard, CanvasDoodleItem, CanvasItem, CanvasRefItem, CanvasRichTextItem, CanvasShapeItem, CanvasViewport } from "@/types";
import { resolveCanvasConnector, visibleCanvasItems } from "@/utils/canvasGeometry";
import { getCanvasRichTextHtml } from "@/utils/canvasRichText";
import { CanvasDoodleDefinitions, CanvasDoodleStroke } from "@/components/Canvas/CanvasDoodleLayer";

interface CanvasBoardPreviewProps {
  board: CanvasBoard;
  assets: Record<string, string>;
  viewport: CanvasViewport;
}

function Shape({ item }: { item: CanvasShapeItem }) {
  if (item.shape === "ellipse") {
    return <ellipse cx={item.width / 2} cy={item.height / 2} rx={item.width / 2} ry={item.height / 2} fill={item.fill} stroke={item.stroke} strokeWidth={item.strokeWidth} />;
  }
  if (item.shape === "diamond") {
    return <polygon points={`${item.width / 2},0 ${item.width},${item.height / 2} ${item.width / 2},${item.height} 0,${item.height / 2}`} fill={item.fill} stroke={item.stroke} strokeWidth={item.strokeWidth} />;
  }
  return <rect width={item.width} height={item.height} rx={item.shape === "rounded" ? 18 : 2} fill={item.fill} stroke={item.stroke} strokeWidth={item.strokeWidth} />;
}

function RichText({ item, centered = false }: { item: CanvasRichTextItem; centered?: boolean }) {
  return (
    <foreignObject x={centered ? 12 : 8} y={centered ? 10 : 6} width={Math.max(1, item.width - (centered ? 24 : 16))} height={Math.max(1, item.height - (centered ? 20 : 12))} pointerEvents="none">
      <div
        className={`canvas-rich-text-content h-full w-full overflow-hidden ${centered ? "canvas-rich-text-content--centered" : ""}`}
        style={{ color: item.color, fontFamily: item.fontFamily, fontSize: item.fontSize, lineHeight: 1.35 }}
        dangerouslySetInnerHTML={{ __html: getCanvasRichTextHtml(item) }}
      />
    </foreignObject>
  );
}

function RefCard({ item }: { item: CanvasRefItem }) {
  const title = item.title.length > 18 ? `${item.title.slice(0, 18)}…` : item.title;
  return (
    <>
      <rect width={item.width} height={item.height} rx={10} fill="var(--color-bg-secondary)" stroke="var(--color-border)" strokeWidth={1} />
      <rect width={3} height={Math.max(1, item.height - 8)} y={4} rx={1.5} fill="var(--color-accent)" opacity={item.ref.kind === "note" ? 0.35 : 1} />
      <text x={12} y={24} fill="var(--color-text-primary)" fontSize={13} fontWeight={600} fontFamily="var(--font-sans)">{title}</text>
    </>
  );
}

function renderItem(item: CanvasItem, items: CanvasItem[], assets: Record<string, string>) {
  if (item.type === "doodle") {
    return <CanvasDoodleStroke key={item.id} item={item} maskPrefix="canvas-preview-doodle-mask" />;
  }
  if (item.type === "connector") {
    const connector = resolveCanvasConnector(item, items);
    return <path key={item.id} d={connector.path} fill="none" stroke={item.stroke} strokeWidth={item.strokeWidth} markerEnd={item.endArrow ? `url(#canvas-preview-arrowhead-${item.id})` : undefined} />;
  }
  const transform = `translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width / 2} ${item.height / 2})`;
  if (item.type === "image") {
    return (
      <g key={item.id} transform={transform}>
        <rect width={item.width} height={item.height} fill="var(--color-bg-secondary)" />
        {assets[item.asset] && <image href={assets[item.asset]} width={item.width} height={item.height} preserveAspectRatio="none" />}
      </g>
    );
  }
  if (item.type === "ref") {
    return (
      <g key={item.id} transform={transform}>
        <RefCard item={item} />
      </g>
    );
  }
  return (
    <g key={item.id} transform={transform}>
      {item.type === "shape" && <Shape item={item} />}
      <RichText item={item} centered={item.type === "shape"} />
    </g>
  );
}

export default function CanvasBoardPreview({ board, assets, viewport }: CanvasBoardPreviewProps) {
  const items = visibleCanvasItems(board.items).sort((a, b) => a.zIndex - b.zIndex);
  return (
    <>
      <defs>
        <pattern id="canvas-preview-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="var(--color-border)" strokeWidth="0.7" opacity="0.42" />
        </pattern>
        {items.filter((item) => item.type === "connector" && item.endArrow).map((item) => (
          <marker key={item.id} id={`canvas-preview-arrowhead-${item.id}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={item.type === "connector" ? item.stroke : "var(--color-accent)"} />
          </marker>
        ))}
        <CanvasDoodleDefinitions
          items={items.filter((item): item is CanvasDoodleItem => item.type === "doodle")}
          maskPrefix="canvas-preview-doodle-mask"
        />
      </defs>
      <rect width="100%" height="100%" fill="var(--canvas-background, var(--color-bg-primary))" />
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        <rect x={-10000} y={-10000} width={20000} height={20000} fill="url(#canvas-preview-grid)" />
        {items.map((item) => renderItem(item, items, assets))}
      </g>
    </>
  );
}
