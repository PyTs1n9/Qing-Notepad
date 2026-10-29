/**
 * The arrays handed to `force-graph`, and the rule that keeps their identity
 * stable.
 *
 * This module exists for one reason: `force-graph` calls `resetCountdown()`
 * every time its `graphData` prop changes identity
 * (`node_modules/force-graph/dist/force-graph.mjs:362-367`), which restarts the
 * 15 s cooldown and makes a graph that had already settled shake itself apart
 * again. Pushing a new snapshot every time the vault watcher fires is therefore
 * not free — and the watcher fires on the app's *own* coordinate writes, so an
 * unconditional rebuild is a loop that never converges.
 *
 * The fix is a structural signature: rebuild only when the node set or the edge
 * set actually changed, and patch the display-only fields (`title`, `degree`,
 * `parseError`) onto the existing objects otherwise.
 *
 * Deliberately free of React and of `react-force-graph`, so
 * `scripts/verify-graph-sync.mjs` can assert the identity rule under plain
 * `node` — a React component is not the place to test reference equality.
 */
import type { GraphEdge, GraphNode } from "@/types/graph";

/** The library mutates these in place (it writes `x`/`y` and `vx`/`vy`). */
export interface RenderNode {
  id: string;
  kind: GraphNode["kind"];
  title: string;
  degree: number;
  path: string | null;
  parseError: string | null;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

/** `source`/`target` start as ids and the library replaces them with nodes. */
export interface RenderLink {
  id: string;
  source: string | RenderNode;
  target: string | RenderNode;
  kind: string;
  line: number;
  highlighted?: boolean;
}

export interface GraphData {
  nodes: RenderNode[];
  links: RenderLink[];
}

/**
 * Structural digest of what `force-graph` actually reacts to: the node id
 * sequence and each edge's `source`/`target`/`kind`.
 *
 * Why not `JSON.stringify` the arrays: the library **mutates** them in place
 * (it writes `x`/`y`/`vx`/`vy` and replaces each link's `source`/`target`
 * string with the node object), so a stringify of the live arrays changes on
 * every frame and would report "changed" forever. The digest is computed from
 * the snapshot instead, which is immutable.
 *
 * FNV-1a/32 over a delimited stream: order-sensitive, allocation-light and
 * stable across runs. A collision costs one missed rebuild, and the length
 * prefixes make accidental collisions implausible for real vault sizes.
 */
export function graphSignature(
  nodes: readonly { id: string }[],
  edges: readonly { source: string; target: string; kind: string }[],
): string {
  let hash = 0x811c9dc5;
  const mix = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  mix(`n${nodes.length}\u0002`);
  for (const node of nodes) {
    mix(node.id);
    mix("\u0000");
  }
  mix(`e${edges.length}\u0002`);
  for (const edge of edges) {
    mix(edge.source);
    mix("\u0001");
    mix(edge.target);
    mix("\u0001");
    mix(edge.kind);
    mix("\u0000");
  }
  return `${nodes.length}:${edges.length}:${hash.toString(16).padStart(8, "0")}`;
}

/** What `buildGraphData` hands back and what the component keeps in a ref. */
export interface GraphDataCache {
  signature: string;
  data: GraphData;
  /** Fast `id -> object` lookup for the in-place label patch. */
  byId: Map<string, RenderNode>;
}

export interface GraphDataResult {
  cache: GraphDataCache;
  /** `true` = `cache` is the previous object, kept apart from display fields. */
  reused: boolean;
}

/**
 * Build — or *reuse* — the arrays handed to `force-graph`.
 *
 * The contract that matters: when the structure is unchanged this returns the
 * previous `cache`, so `cache.data` keeps its identity and the library sees no
 * prop change. Coordinates are not part of the identity: the renderer writes
 * them onto the same node objects (`setPositions`) and repaints via its own
 * dirty counter, which never touches the simulation.
 */
export function buildGraphData(
  cached: GraphDataCache | null,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  seeded: ReadonlyMap<string, { x: number; y: number }>,
): GraphDataResult {
  const signature = graphSignature(nodes, edges);

  if (cached && cached.signature === signature) {
    // Titles, degrees and parse errors change without touching the structure
    // (an edited note keeps its id, a neighbour disappearing changes `degree`).
    // Writing them onto the cached objects is safe: they are the very objects
    // the library reads every frame, and the caller asks for one repaint.
    for (const node of nodes) {
      const target = cached.byId.get(node.id);
      if (!target) continue;
      target.kind = node.kind;
      target.title = node.title;
      target.degree = node.degree;
      target.path = node.path;
      target.parseError = node.parseError;
    }
    return { cache: cached, reused: true };
  }

  const renderNodes: RenderNode[] = nodes.map((node) => {
    const point = seeded.get(node.id);
    return {
      id: node.id,
      kind: node.kind,
      title: node.title,
      degree: node.degree,
      path: node.path,
      parseError: node.parseError,
      x: point?.x,
      y: point?.y,
    };
  });
  const links: RenderLink[] = edges.map((edge, index) => ({
    id: `${edge.source}->${edge.target}-${index}`,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
  }));
  const byId = new Map<string, RenderNode>();
  for (const node of renderNodes) byId.set(node.id, node);
  return {
    cache: { signature, data: { nodes: renderNodes, links }, byId },
    reused: false,
  };
}
