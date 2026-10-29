/**
 * Right-growing tidy layout.
 *
 * With fixed node size the classic tidy-tree problem collapses to arithmetic:
 * a leaf occupies one slot, a folder occupies the stack of its children, and a
 * node is centred on that stack. No dependency, no separation heuristics, and
 * no overlap — the only case that needs care is measuring each subtree once
 * (an O(n²) walk over a few hundred nodes is still fast, but the memo costs
 * three lines).
 *
 * Numbers are layout geometry, not theme: they are the same in every theme, so
 * they live here rather than in a CSS token.
 */

import type { TreeNode } from "./tree";

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 92;
/** Horizontal distance between layers: node width plus a readable gap. */
export const LAYER_GAP = 320;
/** Vertical gap between siblings. */
export const SIBLING_GAP = 24;

export interface PlacedNode {
  node: TreeNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreeLayout {
  nodes: PlacedNode[];
  /** `[parentKey, childKey]` pairs, in draw order. */
  edges: Array<[string, string]>;
  width: number;
  height: number;
}

function measure(node: TreeNode, memo: Map<string, number>): number {
  const cached = memo.get(node.key);
  if (cached !== undefined) return cached;
  const height = node.children.length === 0
    ? NODE_HEIGHT
    : node.children.reduce((sum, child) => sum + measure(child, memo), 0)
      + SIBLING_GAP * (node.children.length - 1);
  memo.set(node.key, height);
  return height;
}

export function layoutTree(root: TreeNode): TreeLayout {
  const memo = new Map<string, number>();
  const nodes: PlacedNode[] = [];
  const edges: Array<[string, string]> = [];

  const place = (node: TreeNode, depth: number, top: number) => {
    const span = measure(node, memo);
    nodes.push({
      node,
      x: depth * LAYER_GAP,
      y: top + span / 2 - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
    let cursor = top;
    for (const child of node.children) {
      const childSpan = measure(child, memo);
      edges.push([node.key, child.key]);
      place(child, depth + 1, cursor);
      cursor += childSpan + SIBLING_GAP;
    }
  };

  place(root, 0, 0);
  const width = nodes.reduce((max, node) => Math.max(max, node.x + node.width), NODE_WIDTH);
  const height = nodes.reduce((max, node) => Math.max(max, node.y + node.height), NODE_HEIGHT);
  return { nodes, edges, width, height };
}

/** Exposed for the verification script: the same numbers, without a canvas. */
export function layoutBounds(layout: TreeLayout): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: layout.nodes.reduce((min, node) => Math.min(min, node.x), Number.POSITIVE_INFINITY),
    minY: layout.nodes.reduce((min, node) => Math.min(min, node.y), Number.POSITIVE_INFINITY),
    maxX: layout.nodes.reduce((max, node) => Math.max(max, node.x + node.width), 0),
    maxY: layout.nodes.reduce((max, node) => Math.max(max, node.y + node.height), 0),
  };
}
