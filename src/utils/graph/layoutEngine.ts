/**
 * Layout inputs: coordinate cache, deterministic cold layout, incremental
 * placement (§4.2.3 - §4.2.5).
 *
 * This module produces **coordinates only**. It does not know about d3-force,
 * Canvas, or React (§3.2.4 boundary 2: the layout engine must not depend on
 * `GraphNode` beyond `{id, degree}` and must not depend on the renderer at all).
 * What it does own is the two things the force simulation cannot do for us:
 *
 * 1. a starting position for every node, so the first frame is never a pile at
 *    the origin;
 * 2. a *stable* position for everything that already had one, so adding one note
 *    does not reshuffle a graph the user was looking at (§4.2.4).
 *
 * Everything here is deterministic — no `Math.random`, no `Date.now`. §4.2.5
 * requires the degraded grid layout to be reproducible for screenshots, and a
 * deterministic seed is also the only way to assert the result in a script.
 */
import type { GraphEdge, GraphNode } from "@/types/graph";
import { joinPath, type GraphFs } from "@/utils/graph/graphFs";
import { fnv1a64Hex, utf8Bytes } from "@/utils/graph/ids";

export interface GraphPoint {
  x: number;
  y: number;
}

export type PositionMap = Map<string, GraphPoint>;

/** 网格单元边长（世界坐标）。簇之间 240 留出标签与连线的空间。 */
const CLUSTER_CELL = 240;
/** 簇内小圆的基准半径与随数量增长的系数。 */
const CLUSTER_RADIUS_BASE = 14;
const CLUSTER_RADIUS_SCALE = 7;
const CLUSTER_RADIUS_MAX = 90;
/** 抖动幅度：足以打散完全重叠，又不至于看起来随机。 */
const JITTER = 10;

const POSITIONS_FILE = "positions.ndjson";

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG                                                         */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32: 32-bit, tiny, and — the only property that matters here —
 * completely reproducible from a seed.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 节点 id → 种子。取 FNV-1a 的低 32 位，同一 id 永远同一序列。 */
export function seedFromId(id: string): number {
  return Number.parseInt(fnv1a64Hex(id).slice(-8), 16) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Cluster key                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 簇 = vault 的顶层目录（原生笔记按 categoryId）。
 *
 * 用顶层目录而不是完整目录：完整的 `a/b/c/d` 会让簇数接近文件数，网格退化成一堆
 * 只放一个节点的格子，"按目录聚拢"这个意图就没了（§4.2.5）。
 */
export function clusterKeyOf(node: GraphNode): string {
  if (node.kind === "native") return `native:${node.categoryId ?? ""}`;
  if (node.kind === "dangling") return "dangling";
  const top = (node.dir ?? "").split("/").filter(Boolean)[0] ?? "";
  return `vault:${node.vaultKey ?? ""}/${top}`;
}

/* -------------------------------------------------------------------------- */
/* Cold layout                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 冷启动布局：簇按网格排布，簇内节点按小圆排布。
 *
 * O(n)，首帧即稳定，无动画 —— 这既是 §4.2.5 的降级布局，也是正常冷启动的初值
 * （比"全部堆在原点让力导向自己炸开"要好得多：力导向从一团开始收敛，前几十帧
 * 用户看到的是一团糊）。
 *
 * 顺序敏感的地方全都显式排序（簇键、节点 id），所以同一输入逐字节同结果。
 */
export function seedColdLayout(nodes: readonly GraphNode[]): PositionMap {
  const clusters = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = clusterKeyOf(node);
    const list = clusters.get(key);
    if (list) list.push(node);
    else clusters.set(key, [node]);
  }

  const clusterKeys = [...clusters.keys()].sort();
  const columns = Math.max(1, Math.ceil(Math.sqrt(clusterKeys.length)));
  const positions: PositionMap = new Map();

  clusterKeys.forEach((key, clusterIndex) => {
    const members = clusters.get(key) ?? [];
    members.sort((left, right) => left.id.localeCompare(right.id));
    const column = clusterIndex % columns;
    const row = Math.floor(clusterIndex / columns);
    const centerX = column * CLUSTER_CELL;
    const centerY = row * CLUSTER_CELL;
    const radius =
      members.length <= 1
        ? 0
        : Math.min(
            CLUSTER_RADIUS_MAX,
            CLUSTER_RADIUS_BASE + CLUSTER_RADIUS_SCALE * Math.sqrt(members.length),
          );
    members.forEach((node, index) => {
      const angle = (2 * Math.PI * index) / Math.max(1, members.length);
      const random = mulberry32(seedFromId(node.id));
      const jitterX = (random() - 0.5) * JITTER;
      const jitterY = (random() - 0.5) * JITTER;
      positions.set(node.id, {
        x: centerX + Math.cos(angle) * radius + jitterX,
        y: centerY + Math.sin(angle) * radius + jitterY,
      });
    });
  });

  return positions;
}

/* -------------------------------------------------------------------------- */
/* Adjacency                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 无向 1 跳邻接表。
 *
 * 无向是刻意的：布局里"邻居"意味着"应该靠在一起"，而这跟边的方向无关。反链面板
 * 用的是 `snapshot.incoming`（有向），两者不是一回事。
 */
export function buildAdjacency(edges: readonly GraphEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = adjacency.get(from);
    if (!list) {
      adjacency.set(from, [to]);
      return;
    }
    if (!list.includes(to)) list.push(to);
  };
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  return adjacency;
}

/* -------------------------------------------------------------------------- */
/* Incremental placement                                                      */
/* -------------------------------------------------------------------------- */

export interface IncrementalPlacement {
  positions: PositionMap;
  /** 需要重热的 id：新节点本身 + 它们的 1 跳邻居（已定位的那些）。 */
  reheatIds: string[];
}

/**
 * 新节点落到 1 跳邻居的质心（§4.2.4），没有已定位的邻居就落到同簇质心。
 *
 * 返回的 `positions` 是新 Map，不改入参：调用方通常还持有上一帧的坐标用于插值。
 */
export function placeIncremental(
  nodes: readonly GraphNode[],
  positions: ReadonlyMap<string, GraphPoint>,
  edges: readonly GraphEdge[],
): IncrementalPlacement {
  const next: PositionMap = new Map(positions);
  const adjacency = buildAdjacency(edges);
  const clusterCentroids = new Map<string, GraphPoint>();

  const accumulate = (key: string, point: GraphPoint) => {
    const current = clusterCentroids.get(key) ?? { x: 0, y: 0 };
    clusterCentroids.set(key, { x: current.x + point.x, y: current.y + point.y });
  };
  const clusterCounts = new Map<string, number>();

  for (const node of nodes) {
    const point = next.get(node.id);
    if (!point) continue;
    const key = clusterKeyOf(node);
    accumulate(key, point);
    clusterCounts.set(key, (clusterCounts.get(key) ?? 0) + 1);
  }

  const fresh = nodes.filter((node) => !next.has(node.id)).sort((left, right) => left.id.localeCompare(right.id));
  const reheat = new Set<string>();

  for (const node of fresh) {
    const neighbours = adjacency.get(node.id) ?? [];
    const placed = neighbours
      .map((id) => next.get(id))
      .filter((point): point is GraphPoint => point !== undefined);

    let point: GraphPoint;
    if (placed.length > 0) {
      const sum = placed.reduce(
        (total, item) => ({ x: total.x + item.x, y: total.y + item.y }),
        { x: 0, y: 0 },
      );
      point = { x: sum.x / placed.length, y: sum.y / placed.length };
    } else {
      const key = clusterKeyOf(node);
      const count = clusterCounts.get(key) ?? 0;
      const sum = clusterCentroids.get(key);
      point = count > 0 && sum ? { x: sum.x / count, y: sum.y / count } : { x: 0, y: 0 };
    }

    const random = mulberry32(seedFromId(node.id));
    next.set(node.id, {
      x: point.x + (random() - 0.5) * JITTER,
      y: point.y + (random() - 0.5) * JITTER,
    });
    reheat.add(node.id);
    for (const id of neighbours) if (positions.has(id)) reheat.add(id);
  }

  return { positions: next, reheatIds: [...reheat].sort() };
}

/* -------------------------------------------------------------------------- */
/* Coordinate cache (§4.2.3)                                                   */
/* -------------------------------------------------------------------------- */

export interface PositionStore {
  read(): Promise<PositionMap>;
  write(positions: ReadonlyMap<string, GraphPoint>): Promise<void>;
}

/**
 * `positions.ndjson`: one `{ id, x, y }` per line.
 *
 * 全图一份，不分片（§8.2 的磁盘布局）：坐标是全图性质，按 vault 切开反而让
 * "跨 vault 的边"每次都要对齐两套坐标。
 *
 * **写盘是幂等的**：实例内记住上一次真正写出去的正文，内容相同就直接返回，
 * 既不写临时文件也不 rename。`positions.ndjson` 可能就在被监听的 vault 里
 * （`<data>` 本身是 vault 时），一次多余的写入就是一次多余的目录事件。
 */
export function createPositionStore(fs: GraphFs, indexPath: string): PositionStore {
  const file = joinPath(indexPath, POSITIONS_FILE);
  /** 上一次真正落盘的正文；`null` = 还没写过。 */
  let lastBody: string | null = null;

  return {
    async read() {
      const positions: PositionMap = new Map();
      if (!(await fs.exists(file))) return positions;
      let text = "";
      try {
        text = await fs.readTextFile(file);
      } catch (error) {
        // 坐标只是缓存：读不出来就当没有，下一次收敛会重写。
        console.warn(`[graph-layout] cannot read ${file}:`, error);
        return positions;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { id?: unknown; x?: unknown; y?: unknown };
          if (typeof parsed.id !== "string") continue;
          if (typeof parsed.x !== "number" || typeof parsed.y !== "number") continue;
          if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) continue;
          positions.set(parsed.id, { x: parsed.x, y: parsed.y });
        } catch {
          // 半行/坏行跳过：缓存坏掉的代价是重新布局，不是崩溃。
        }
      }
      return positions;
    },

    async write(positions) {
      const body = [...positions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, point]) =>
          JSON.stringify({ id, x: Number(point.x.toFixed(3)), y: Number(point.y.toFixed(3)) }),
        )
        .join("\n");
      const payload = body.length > 0 ? `${body}\n` : "";
      // 收敛事件会重复触发（窗口 resize、钉住节点后的重绘），内容没变就不要再
      // 动盘：`writeTextFile` + `rename` 是两次目录事件，每一次都会让 watcher
      // 叫醒一轮同步。
      if (payload === lastBody) return;
      await fs.mkdir(indexPath, { recursive: true });
      const temporary = `${file}.tmp`;
      await fs.writeTextFile(temporary, payload);
      await fs.rename(temporary, file);
      lastBody = payload;
    },
  };
}

/** 坐标缓存与当前节点集合差多少（供 UI 判断"要不要补位"）。 */
export function missingPositionIds(
  nodes: readonly GraphNode[],
  positions: ReadonlyMap<string, GraphPoint>,
): string[] {
  return nodes.filter((node) => !positions.has(node.id)).map((node) => node.id);
}

/** 写坐标前的字节量估算，调用方据此节流（§4.2.3 收敛时才写）。 */
export function estimatePositionBytes(positions: ReadonlyMap<string, GraphPoint>): number {
  let total = 0;
  for (const [id, point] of positions) {
    total += utf8Bytes(`{"id":"${id}","x":${point.x.toFixed(3)},"y":${point.y.toFixed(3)}}\n`).length;
  }
  return total;
}
