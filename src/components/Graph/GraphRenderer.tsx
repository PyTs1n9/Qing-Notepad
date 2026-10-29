/**
 * Thin adapter over `react-force-graph-2d` (§8.3).
 *
 * The library owns the render loop, zoom/pan, node dragging, curve drawing and
 * hover plumbing. What is left on our side is exactly the five custom callbacks
 * §8.3 lists, plus the seam that keeps the data layer out of the renderer:
 *
 * - this component never reads a store; it takes a `GraphSnapshot` and paints it;
 * - it never mutates the snapshot; `graphData` is a rebuilt array of plain
 *   objects, and the palette is read from CSS variables once per theme change.
 *
 * Two consequences of the library-driven loop are worth stating, because the
 * design document assumed a hand-written renderer:
 *
 * 1. **No colour bucketing.** §4.3 wanted one `beginPath` per fill colour, but the
 *    per-node `nodeCanvasObject` callback paints one node at a time and the
 *    library repaints the whole canvas each frame. The compensation is the same
 *    budget in other places: nodes outside the filter are skipped before any
 *    canvas state is touched, labels are off below 0.8x, and `measureText` is
 *    cached.
 * 2. **DPR is the library's.** It sizes the backing store itself; there is no
 *    prop to cap `devicePixelRatio` at 2. See the delivery report.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import type { GraphPalette, GraphSnapshot } from "@/types/graph";
import type { GraphFilter } from "@/stores/graphStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { PositionMap } from "@/utils/graph/layoutEngine";
import {
  buildGraphData,
  type GraphDataCache,
  type RenderLink,
  type RenderNode,
} from "@/utils/graph/graphData";

/* -------------------------------------------------------------------------- */
/* Palette (§4.5.1)                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every canvas colour comes from a CSS variable — the canvas has **zero**
 * hardcoded colour values. The rule that goes with it: canvas *fills* may use
 * `--color-accent`, DOM *text* must use `text-accent-text`, because
 * `--color-accent` only promises 4.5:1 against `--color-on-accent` and drops to
 * ~3.06:1 as a text colour in the dark theme.
 */
const PALETTE_VARIABLES: Record<keyof GraphPalette, string> = {
  bg: "--color-bg-primary",
  nodeNative: "--color-accent",
  nodeVault: "--color-text-secondary",
  nodeIsolatedFill: "--color-bg-secondary",
  nodeDanglingStroke: "--color-warning",
  edge: "--color-border",
  edgeActive: "--color-accent",
  label: "--color-text-primary",
  labelMuted: "--color-text-muted",
  selection: "--color-accent-hover",
};

/** CSS keyword fallbacks: no hex, so a missing variable can never bake a colour in. */
const PALETTE_FALLBACKS: Record<keyof GraphPalette, string> = {
  bg: "Canvas",
  nodeNative: "Highlight",
  nodeVault: "GrayText",
  nodeIsolatedFill: "Canvas",
  nodeDanglingStroke: "GrayText",
  edge: "GrayText",
  edgeActive: "Highlight",
  label: "CanvasText",
  labelMuted: "GrayText",
  selection: "Highlight",
};

export function readGraphPalette(): GraphPalette {
  const style = getComputedStyle(document.documentElement);
  const read = (key: keyof GraphPalette): string => {
    const value = style.getPropertyValue(PALETTE_VARIABLES[key]).trim();
    return value || PALETTE_FALLBACKS[key];
  };
  return {
    bg: read("bg"),
    nodeNative: read("nodeNative"),
    nodeVault: read("nodeVault"),
    nodeIsolatedFill: read("nodeIsolatedFill"),
    nodeDanglingStroke: read("nodeDanglingStroke"),
    edge: read("edge"),
    edgeActive: read("edgeActive"),
    label: read("label"),
    labelMuted: read("labelMuted"),
    selection: read("selection"),
  };
}

/* -------------------------------------------------------------------------- */
/* Graph data shapes handed to the library                                    */
/* -------------------------------------------------------------------------- */

/**
 * Imperative surface this file is allowed to touch.
 *
 * It is now a *pick* from the library's own `ForceGraphMethods`, so a member
 * that does not exist there cannot be named here — `tsc` rejects it instead of
 * the runtime throwing inside an effect. That is exactly how the previous
 * version broke: it declared `refresh()`, which `force-graph` never had (the
 * string only appears in `refreshShadowCanvas`, an internal throttle), so every
 * call threw `graphRef.current?.refresh is not a function` and the error
 * boundary swallowed the page. **Do not widen this type by hand.**
 *
 * | method | force-graph.d.ts |
 * | --- | --- |
 * | `centerAt(x, y, durationMs)` | 134 |
 * | `zoom(scale, durationMs)` | 136 |
 * | `zoomToFit(durationMs, padding)` | 137 |
 * | `screen2GraphCoords(x, y)` | 200 |
 *
 * Deliberately **not** here even though the library has it:
 * `d3ReheatSimulation` (162) restarts the simulation and would make theme or
 * filter changes reshuffle the graph, which §4.5.2 forbids. It is *reachable*
 * through the type, so the prohibition is a review rule, not a compile error.
 *
 * Two members of this file's history were *phantom API* and are gone:
 * `refresh()` (never existed — the redraw is prop-identity driven, see the
 * `redrawTick` comment) and the `showNavInfo` prop (a 3D-only option that
 * `force-graph.mjs` does not read at all).
 */
type ForceGraphNode = NodeObject<RenderNode>;
type ForceGraphLink = LinkObject<ForceGraphNode, RenderLink>;
type ForceGraphHandle = Pick<
  ForceGraphMethods<ForceGraphNode, ForceGraphLink>,
  "centerAt" | "zoom" | "zoomToFit" | "screen2GraphCoords"
>;

/* -------------------------------------------------------------------------- */
/* Callbacks out of the renderer                                              */
/* -------------------------------------------------------------------------- */

export interface GraphRendererCallbacks {
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onNodeDragEnd?: (nodeId: string) => void;
  onZoomChange?: (zoom: number) => void;
  /** The simulation cooled down — the moment to persist coordinates (§4.2.3). */
  onEngineStop?: () => void;
}

export interface GraphRendererHandle {
  /** Seed coordinates (from `positions.ndjson`, the cold layout, or the last frame). */
  setPositions(positions: PositionMap): void;
  /** Current coordinates, read back from the simulation for `positions.ndjson`. */
  readPositions(): PositionMap;
  setViewport(viewport: { zoom: number }): void;
  setSelection(nodeId: string | null): void;
  setFilter(filter: GraphFilter): void;
  /** Centre the camera on a node and select it (search result, list Enter). */
  focusNode(nodeId: string): void;
  zoomBy(factor: number): void;
  panBy(dx: number, dy: number): void;
  zoomToFit(): void;
  subscribe(callbacks: GraphRendererCallbacks): () => void;
  dispose(): void;
}

export interface GraphRendererProps {
  snapshot: GraphSnapshot;
  filter: GraphFilter;
  selection: string | null;
  hover: string | null;
  /** True when `positions.ndjson` already covers the whole graph (§8.3 ③). */
  hasCachedPositions: boolean;
  /** `prefers-reduced-motion`: camera moves jump instead of easing (§4.5.3). */
  reduceMotion?: boolean;
  ariaLabel: string;
  /** Keyboard entry point for the canvas (§4.5.3). */
  tabIndex?: number;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Re-created whenever the node list changes, so the camera seeds from it. */
  initialPositions: PositionMap;
}

/* -------------------------------------------------------------------------- */
/* Label measuring (LRU, 2000 entries)                                        */
/* -------------------------------------------------------------------------- */

const LABEL_CACHE_LIMIT = 2000;
const labelWidths = new Map<string, number>();

function measureLabel(ctx: CanvasRenderingContext2D, text: string, font: string): number {
  const key = `${font}\u0000${text}`;
  const cached = labelWidths.get(key);
  if (cached !== undefined) return cached;
  const width = ctx.measureText(text).width;
  if (labelWidths.size >= LABEL_CACHE_LIMIT) {
    // Map keeps insertion order, so the first key is the oldest.
    const oldest = labelWidths.keys().next().value;
    if (oldest !== undefined) labelWidths.delete(oldest);
  }
  labelWidths.set(key, width);
  return width;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

const NODE_REL_SIZE = 4;
/** §4.3 LOD thresholds. */
const LOD_DOT = 0.35;
const LOD_LABEL = 0.8;
/** Above this, labels are worth drawing for every node, not just the hub ones. */
const LOD_ALL_LABELS = 1.9;

function nodeRadius(node: RenderNode): number {
  if (node.kind === "dangling") return NODE_REL_SIZE * 0.9;
  const base = NODE_REL_SIZE + Math.min(9, Math.sqrt(node.degree) * 1.7);
  // 孤立节点更小 —— 除了颜色之外的第二重编码（§4.5.3）。
  if (node.degree === 0) return Math.max(2.4, base - 1.6);
  return base;
}

function idOf(value: string | RenderNode): string {
  return typeof value === "string" ? value : value.id;
}

/** 度数 top 10% 的阈值；小图直接全部标，避免"只有 3 个标签"的怪相。 */
function labelDegreeThreshold(snapshot: GraphSnapshot): number {
  const degrees = snapshot.nodes.map((node) => node.degree).sort((left, right) => right - left);
  if (degrees.length <= 120) return 0;
  const index = Math.min(degrees.length - 1, Math.floor(degrees.length * 0.1));
  return degrees[index];
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

const GraphRenderer = forwardRef<GraphRendererHandle, GraphRendererProps>((props, ref) => {
  const { snapshot, filter, selection, hover, hasCachedPositions, ariaLabel, initialPositions } = props;
  const reduceMotion = props.reduceMotion ?? false;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<ForceGraphNode, ForceGraphLink> | undefined>(undefined);
  const callbacksRef = useRef<GraphRendererCallbacks>({});
  const positionsRef = useRef<PositionMap>(new Map(initialPositions));
  const selectionRef = useRef<string | null>(selection);
  const hoverRef = useRef<string | null>(hover);
  const filterRef = useRef<GraphFilter>(filter);
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  /** The camera is fitted once, when the first real coordinates arrive. */
  const didFitRef = useRef(false);

  const [size, setSize] = React.useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [palette, setPalette] = React.useState<GraphPalette>(() => ({
    bg: PALETTE_FALLBACKS.bg,
    nodeNative: PALETTE_FALLBACKS.nodeNative,
    nodeVault: PALETTE_FALLBACKS.nodeVault,
    nodeIsolatedFill: PALETTE_FALLBACKS.nodeIsolatedFill,
    nodeDanglingStroke: PALETTE_FALLBACKS.nodeDanglingStroke,
    edge: PALETTE_FALLBACKS.edge,
    edgeActive: PALETTE_FALLBACKS.edgeActive,
    label: PALETTE_FALLBACKS.label,
    labelMuted: PALETTE_FALLBACKS.labelMuted,
    selection: PALETTE_FALLBACKS.selection,
  }));

  /**
   * The only redraw channel this library offers besides new data.
   *
   * `force-graph` exposes **no** imperative `refresh()` — its documented redraw
   * path is prop identity: every style accessor is registered with
   * `onChange: notifyRedraw` (`force-graph.mjs:120`, accessors at 163-251), and
   * `notifyRedraw` sets `state.needsRedraw`, which the frame loop turns into
   * exactly one repaint (`force-graph.mjs:1391`).
   *
   * So an imperative style change bumps this counter, the paint callbacks below
   * are re-created, React hands the library new prop identities, and one frame
   * is painted. That keeps `autoPauseRedraw` on (a 5000-node graph must not
   * repaint at 60 fps forever) and never touches the simulation, so selection or
   * filter changes cannot reshuffle a layout the user is looking at (§4.5.2).
   */
  const [redrawTick, setRedrawTick] = React.useState(0);
  const markDirty = useCallback(() => setRedrawTick((tick) => tick + 1), []);

  // §4.5.2: theme changes repaint, they never rebuild the layout. Reading the
  // variables is a `getComputedStyle` on the root, so it happens here and never
  // inside a paint callback.
  const theme = useSettingsStore((state) => state.theme);
  const customColors = useSettingsStore((state) => state.customColors);
  const glassEnabled = useSettingsStore((state) => state.glassEnabled);
  useEffect(() => {
    setPalette(readGraphPalette());
  }, [theme, customColors, glassEnabled]);

  // Size from observation, never from a hardcoded constant.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const apply = (width: number, height: number) => {
      const rounded = { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) };
      sizeRef.current = rounded;
      setSize((current) =>
        current.width === rounded.width && current.height === rounded.height ? current : rounded,
      );
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      apply(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    apply(element.clientWidth, element.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    selectionRef.current = selection;
    markDirty();
  }, [markDirty, selection]);

  useEffect(() => {
    hoverRef.current = hover;
    markDirty();
  }, [hover, markDirty]);

  useEffect(() => {
    filterRef.current = filter;
    markDirty();
  }, [filter, markDirty]);

  useEffect(() => {
    markDirty();
  }, [markDirty, palette]);

  const labelThreshold = useMemo(() => labelDegreeThreshold(snapshot), [snapshot]);

  /** 可见性：筛掉的节点仍参与布局，只是不画（§4.4.1 硬要求）。 */
  const visibility = useMemo(() => {
    const map = new Map<string, boolean>();
    const vaultKeys = new Set(filter.vaultKeys);
    const tags = new Set(filter.tags);
    for (const node of snapshot.nodes) {
      let visible = true;
      if (filter.danglingOnly && node.kind !== "dangling") visible = false;
      if (visible && filter.orphansOnly && node.degree !== 0) visible = false;
      if (visible && tags.size > 0 && !node.tags.some((tag) => tags.has(tag))) visible = false;
      if (visible && vaultKeys.size > 0 && node.kind !== "dangling") {
        visible = node.vaultKey !== null && vaultKeys.has(node.vaultKey);
      }
      if (visible && vaultKeys.size > 0 && node.kind === "dangling") {
        // 悬空节点不属于任何 vault：只要引用它的来源里有一个可见，它就跟着可见。
        const sources = snapshot.incoming.get(node.id) ?? [];
        visible = sources.some((source) => {
          const owner = snapshot.nodeById.get(source);
          return owner !== undefined && owner.vaultKey !== null && vaultKeys.has(owner.vaultKey);
        });
      }
      map.set(node.id, visible);
    }
    return map;
  }, [snapshot, filter]);

  // graphData is rebuilt only when the *structure* changes. Positions are seeded
  // from `positionsRef`, which GraphPage keeps up to date, so a rebuild does not
  // make the graph jump.
  //
  // The signature cache is what makes a new snapshot cheap: `force-graph` resets
  // its 15 s cooldown whenever `graphData` changes identity
  // (`force-graph.mjs:362-367` `resetCountdown()`), so handing it a fresh array
  // for an unchanged graph means it re-cooks a layout that was already settled.
  // Same signature -> the previous arrays are returned by identity.
  const builtRef = useRef<GraphDataCache | null>(null);
  const buildSeqRef = useRef(0);

  const graphData = useMemo(() => {
    const result = buildGraphData(
      builtRef.current,
      snapshot.nodes,
      snapshot.edges,
      positionsRef.current,
    );
    builtRef.current = result.cache;
    if (!result.reused) buildSeqRef.current += 1;
    if (import.meta.env.DEV) {
      console.info(
        `[graph] graphData ${result.reused ? "reuse" : "rebuild"} #${buildSeqRef.current}`,
        {
          nodes: result.cache.data.nodes.length,
          links: result.cache.data.links.length,
          signature: result.cache.signature,
        },
      );
    }
    return result.cache.data;
  }, [snapshot]);

  // A reused `graphData` keeps its identity, so the library sees no prop change:
  // ask for exactly one repaint (`autoPauseRedraw` is on) to show the labels that
  // were patched in place by `buildGraphData`.
  useEffect(() => {
    markDirty();
  }, [markDirty, snapshot]);

  const paintNode = useCallback(
    (node: RenderNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!visibility.get(node.id)) return;
      const current = palette;
      const isSelected = selectionRef.current === node.id;
      const isHovered = hoverRef.current === node.id;
      const radius = nodeRadius(node);

      if (globalScale < LOD_DOT) {
        // 全图视角：2x2 方块，一次 fill 就够，标签全关。
        ctx.fillStyle = node.kind === "dangling" ? current.nodeDanglingStroke : current.nodeVault;
        ctx.fillRect((node.x ?? 0) - 1, (node.y ?? 0) - 1, 2, 2);
        return;
      }

      const dangling = node.kind === "dangling";
      const failed = node.parseError !== null;
      const isolated = node.degree === 0 && !dangling;

      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, Math.PI * 2);
      if (dangling) {
        ctx.fillStyle = current.bg;
        ctx.fill();
      } else if (failed) {
        ctx.fillStyle = current.labelMuted;
        ctx.fill();
      } else if (isolated) {
        ctx.fillStyle = current.nodeIsolatedFill;
        ctx.fill();
      } else {
        ctx.fillStyle = node.kind === "native" ? current.nodeNative : current.nodeVault;
        ctx.fill();
      }

      // 描边：悬空用虚线（颜色之外的第二重编码，色觉障碍用户也能分辨）。
      if (dangling) {
        ctx.setLineDash([3 / globalScale, 3 / globalScale]);
        ctx.strokeStyle = current.nodeDanglingStroke;
        ctx.lineWidth = 1.2 / globalScale;
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (isolated || failed) {
        ctx.strokeStyle = failed ? current.nodeDanglingStroke : current.labelMuted;
        ctx.lineWidth = 1 / globalScale;
        ctx.stroke();
      }

      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(node.x ?? 0, node.y ?? 0, radius + 2 / globalScale, 0, Math.PI * 2);
        ctx.strokeStyle = current.selection;
        ctx.lineWidth = 1.6 / globalScale;
        ctx.stroke();
      }

      const wantsLabel =
        isSelected ||
        isHovered ||
        globalScale >= LOD_ALL_LABELS ||
        node.degree >= labelThreshold;
      if (globalScale < LOD_LABEL || !wantsLabel) {
        // 解析失败的节点给一个警示标记 —— 灰点本身在缩小时看不出区别。
        if (failed && globalScale >= LOD_LABEL) {
          ctx.font = `${9 / globalScale}px sans-serif`;
          ctx.fillStyle = current.nodeDanglingStroke;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("!", node.x ?? 0, (node.y ?? 0) - radius - 5 / globalScale);
        }
        return;
      }

      const font = `${10 / globalScale}px sans-serif`;
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const text = node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title;
      const width = measureLabel(ctx, text, font);
      const x = node.x ?? 0;
      const y = (node.y ?? 0) + radius + 2 / globalScale;
      ctx.fillStyle = current.label;
      ctx.fillText(text, x, y);
      // 宽度只为把 measureText 的缓存真正用上（也是将来避让标签的输入）。
      void width;
    },
    // `redrawTick` is a dependency on purpose and is not read in the body: the
    // point is to hand the library a new callback identity so its accessor
    // `onChange` fires `notifyRedraw` (see the counter's comment above).
    [labelThreshold, palette, redrawTick, visibility],
  );

  const paintPointerArea = useCallback((node: RenderNode, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, nodeRadius(node) + 2, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  const linkColor = useCallback(
    (link: RenderLink) => {
      const source = idOf(link.source);
      const target = idOf(link.target);
      const selected = selectionRef.current;
      const hovered = hoverRef.current;
      const active =
        (selected !== null && (source === selected || target === selected)) ||
        (hovered !== null && (source === hovered || target === hovered));
      return active ? palette.edgeActive : palette.edge;
    },
    [palette, redrawTick],
  );

  const linkWidth = useCallback(
    (link: RenderLink) => {
      const source = idOf(link.source);
      const target = idOf(link.target);
      const selected = selectionRef.current;
      const hovered = hoverRef.current;
      const active =
        (selected !== null && (source === selected || target === selected)) ||
        (hovered !== null && (source === hovered || target === hovered));
      return active ? 1.6 : 0.5;
    },
    [redrawTick],
  );

  const linkVisibility = useCallback(
    (link: RenderLink) => {
      // 两端至少一端可见才画：两端都被筛掉时这条边没有任何意义。
      const source = idOf(link.source);
      const target = idOf(link.target);
      return visibility.get(source) === true || visibility.get(target) === true;
    },
    [visibility],
  );

  useImperativeHandle(
    ref,
    (): GraphRendererHandle => ({
      setPositions(positions) {
        positionsRef.current = positions;
        // Narrow to the four methods this file is allowed to call (see
        // `ForceGraphHandle`): everything else the library exposes is off limits
        // here, `d3ReheatSimulation` above all.
        const graph: ForceGraphHandle | undefined = graphRef.current;
        const data = graphData;
        if (!graph || data.nodes.length === 0) return;
        for (const node of data.nodes) {
          const point = positions.get(node.id);
          if (!point) continue;
          node.x = point.x;
          node.y = point.y;
        }
        // 第一次拿到坐标才是"布局真的有意义"的时刻，在这之前 zoomToFit 拟合的是
        // 库自己随机的初始位置，镜头会落在空处。
        if (!didFitRef.current) {
          didFitRef.current = true;
          graph.zoomToFit(0, 60);
        }
        // 坐标变了下一次绘制才有意义；置脏而不重热，避免已有布局被打散。
        markDirty();
      },
      readPositions() {
        const positions: PositionMap = new Map();
        for (const node of graphData.nodes) {
          if (typeof node.x !== "number" || typeof node.y !== "number") continue;
          if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
          positions.set(node.id, { x: node.x, y: node.y });
        }
        return positions;
      },
      setViewport(viewport) {

        graphRef.current?.zoom(viewport.zoom, 0);
      },
      setSelection(nodeId) {
        selectionRef.current = nodeId;
        markDirty();
      },
      setFilter(next) {
        filterRef.current = next;
        markDirty();
      },
      focusNode(nodeId) {
        const data = graphData;
        const node = data.nodes.find((item) => item.id === nodeId);
        if (!node) return;
        const graph = graphRef.current;
        if (!graph) return;
        selectionRef.current = nodeId;
        const duration = reduceMotion ? 0 : 600;
        // centerAt/zoom 自己会置脏（force-graph.mjs 1053/1088），这里再置一次是
        // 为了选中高亮也跟着重画。
        graph.centerAt(node.x ?? 0, node.y ?? 0, duration);
        const current = sizeRef.current;
        const target = current.width > 900 ? 1.8 : 1.2;
        graph.zoom(target, duration);
        markDirty();
      },
      zoomBy(factor) {
        graphRef.current?.zoom(factor, reduceMotion ? 0 : 200);
      },
      panBy(dx, dy) {
        // 键盘平移。库没有暴露"按像素平移"，但暴露了屏幕→图坐标换算，用
        // "把画布中心挪到 dx/dy 之后的那个点"等价实现，结果与拖拽一致。
        const graph = graphRef.current;
        if (!graph) return;
        const current = sizeRef.current;
        const next = graph.screen2GraphCoords(current.width / 2 + dx, current.height / 2 + dy);
        graph.centerAt(next.x, next.y, reduceMotion ? 0 : 150);
      },
      zoomToFit() {
        graphRef.current?.zoomToFit(reduceMotion ? 0 : 400, 60);
      },
      subscribe(callbacks) {
        callbacksRef.current = { ...callbacks };
        return () => {
          callbacksRef.current = {};
        };
      },
      dispose() {
        callbacksRef.current = {};
        graphRef.current = undefined;
      },
    }),
    [graphData, markDirty, reduceMotion],
  );

  /*
   * Three props below are deliberately *absent*, and all three absences are
   * load bearing:
   *
   * 1. **No `onNodeDrag`.** The library already fixes the dragged node itself:
   *    `force-graph.mjs:1202-1204` sets `fx`/`fy` on drag start, `:1219` moves
   *    both with the pointer on every drag event, and `:1225` re-arms the
   *    engine (`d3AlphaTarget(0.3).resetCountdown()`) to keep the frame loop
   *    awake. Clearing `fx`/`fy` in this callback — which an earlier revision
   *    did — hands the node back to d3 mid-gesture. The spring pulls it home,
   *    the next drag event snaps it back out to the pointer: the rubber-band
   *    judder the user reported, once per frame.
   *
   * 2. **`onEngineStop` only reports; it does not pin anything.** An earlier
   *    revision pinned every node here (`fx = x; fy = y` for all of
   *    `graphData.nodes`). That made the graph stiff: dragging one node left
   *    its neighbours unable to make room, a newly added note could not push
   *    anything aside (it looked like a local twitch), and it mutated the very
   *    objects the shadow canvas — the library's hit-test surface — had been
   *    painted from. Settling is the engine's job: d3's alpha decay, with
   *    `cooldownTicks` left at `Infinity` so nothing cuts it off mid-flight.
   *    The only pinning left in this file is the node the user actually
   *    dragged, in `onNodeDragEnd`.
   *
   * 3. **No `onBackgroundClick`.** Passing it disables node clicks. The
   *    library's canvas drag detector is gated on it —
   *    `force-graph.mjs:1305-1309`:
   *
   *        !state.isPointerDragging && ev.type === 'pointermove' && state.onBackgroundClick
   *        && (ev.pressure > 0 || state.isPointerPressed)
   *        && (ev.pointerType === 'mouse' || ...movement check...)
   *        && (state.isPointerDragging = true)
   *
   *    For a mouse the `pointerType` clause is always true, so the first
   *    `pointermove` after `pointerdown` — a 1 px hand tremor is enough — marks
   *    the gesture as a pan. `pointerup` then gives up before dispatching
   *    (`:1336-1339`: `if (state.isPointerDragging) { ...; return; }`), and
   *    `:1395` has already nulled `state.hoverObj`, so the click lands on the
   *    background instead of the node. Without the prop the whole branch is
   *    dead and node clicks are reliable.
   *
   *    The cost is "click empty space to clear the selection". `GraphPage`
   *    covers that with Escape on the canvas (`handleCanvasKeyDown`), which
   *    works without a hit test, on touch, and after a drag.
   */

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-bg-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      // 可访问性（§4.5.3）：canvas 自己不可聚焦，容器承担焦点与角色。
      // `aria-label` 由调用方传入；「点空白取消选中」已经没有了（见上面对
      // `onBackgroundClick` 的说明），取消选中走这里冒泡出去的 Esc —— 由
      // `GraphPage.handleCanvasKeyDown` 处理，所以容器必须保持可聚焦。
      role="application"
      aria-label={ariaLabel}
      tabIndex={props.tabIndex ?? 0}
      onKeyDown={props.onKeyDown}
    >
      {size.width > 0 && size.height > 0 && (
        <ForceGraph2D<RenderNode, RenderLink>
          ref={graphRef}
          graphData={graphData}
          width={size.width}
          height={size.height}
          backgroundColor={palette.bg}
          nodeRelSize={NODE_REL_SIZE}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointerArea}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkVisibility={linkVisibility}
          // §8.3 ③: warmup blocks the main thread, so it is 0; with cached
          // coordinates the simulation has nothing to do and converges fast.
          warmupTicks={0}
          // No external tick budget. d3's own alpha decay is the stopping rule,
          // not a tick count we pick: with `cooldownTicks` finite the engine is
          // cut off mid-flight, the canvas stops repainting (`autoPauseRedraw`)
          // and then the visual and the hit surface drift apart — points stop
          // responding, panning looks stuck. `Infinity` does **not** mean "runs
          // forever": only a graph whose data keeps being swapped for a new
          // array never settles, and that is cut off at the source (`graphSync`
          // zero-diff guard, `graphData` signature reuse, idempotent position
          // writes) rather than by a timer here.
          cooldownTicks={Number.POSITIVE_INFINITY}
          cooldownTime={hasCachedPositions ? 3000 : 15000}
          autoPauseRedraw
          enableNodeDrag
          onNodeClick={(node) => {
            if (import.meta.env.DEV) {
              console.info("[graph] click", { id: node.id, kind: node.kind, title: node.title });
            }
            callbacksRef.current.onNodeClick?.(node.id);
          }}
          onNodeHover={(node) => callbacksRef.current.onNodeHover?.(node ? node.id : null)}
          onNodeDragEnd={(node) => {
            // 拖完固定住，否则松手立刻被力导向弹回去，像是没拖到（§4.4.1）。
            // 库在 `end` 里会先把 fx/fy 清掉（`force-graph.mjs:1233-1238`），
            // 这个回调在它之后执行，所以这里的钉住是最终结果。
            node.fx = node.x;
            node.fy = node.y;
            callbacksRef.current.onNodeDragEnd?.(node.id);
          }}
          onZoom={(transform) => callbacksRef.current.onZoomChange?.(transform.k)}
          onEngineStop={() => callbacksRef.current.onEngineStop?.()}
        />
      )}
    </div>
  );
});

GraphRenderer.displayName = "GraphRenderer";

export default GraphRenderer;
