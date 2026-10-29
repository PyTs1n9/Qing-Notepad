/**
 * Knowledge-graph view state.
 *
 * Deliberately flat and small: `snapshot` already holds every derived structure
 * (node map, out-edge map, incoming index), so nothing here recomputes arrays.
 * A store field that mirrors a snapshot field is a second source of truth, and
 * every such field is a future "graph shows one thing, panel shows another" bug.
 *
 * Filter state lives here rather than in `GraphPage` because three surfaces read
 * it (canvas, node list, document panel) and they must never disagree about what
 * is being hidden.
 */
import { create } from "zustand";
import type { GraphNode, GraphSnapshot } from "@/types/graph";

export interface GraphFilter {
  /** 空数组 = 不按 vault 过滤。多选是并集。 */
  vaultKeys: string[];
  /** 空数组 = 不按标签过滤。多选是并集。 */
  tags: string[];
  /** 仅孤立节点（degree === 0）。 */
  orphansOnly: boolean;
  /** 仅悬空节点（kind === "dangling"）。 */
  danglingOnly: boolean;
}

export type GraphStatusPhase = "idle" | "scanning" | "error";

/** 每次返回新对象：调用方拿到的是自己的副本，改它不会污染 store。 */
export function createEmptyGraphFilter(): GraphFilter {
  return { vaultKeys: [], tags: [], orphansOnly: false, danglingOnly: false };
}

interface GraphState {
  snapshot: GraphSnapshot | null;
  selection: string | null;
  hover: string | null;
  filter: GraphFilter;
  status: GraphStatusPhase;
  statusMessage: string | null;
  setSnapshot: (snapshot: GraphSnapshot | null) => void;
  setSelection: (nodeId: string | null) => void;
  setHover: (nodeId: string | null) => void;
  setFilter: (filter: GraphFilter) => void;
  patchFilter: (patch: Partial<GraphFilter>) => void;
  resetFilter: () => void;
  setStatus: (status: GraphStatusPhase, message?: string | null) => void;
  reset: () => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  snapshot: null,
  selection: null,
  hover: null,
  filter: createEmptyGraphFilter(),
  status: "idle",
  statusMessage: null,

  // 换快照时清掉悬停，并在选中节点已经不存在时清掉选中：旧 id 留在 state 里
  // 会让面板显示一个不属于当前图的节点。
  setSnapshot: (snapshot) =>
    set((state) => ({
      snapshot,
      selection:
        snapshot && state.selection && snapshot.nodeById.has(state.selection)
          ? state.selection
          : null,
      hover: null,
    })),

  setSelection: (selection) => set({ selection }),
  setHover: (hover) => set({ hover }),
  setFilter: (filter) => set({ filter }),
  patchFilter: (patch) => set((state) => ({ filter: { ...state.filter, ...patch } })),
  resetFilter: () => set({ filter: createEmptyGraphFilter() }),
  setStatus: (status, message = null) => set({ status, statusMessage: message }),
  reset: () =>
    set({
      snapshot: null,
      selection: null,
      hover: null,
      filter: createEmptyGraphFilter(),
      status: "idle",
      statusMessage: null,
    }),
}));

/* -------------------------------------------------------------------------- */
/* Selectors — 每个都返回一个稳定引用或原始值，组件不要订阅整个 state。          */
/* -------------------------------------------------------------------------- */

export const selectGraphSnapshot = (state: GraphState): GraphSnapshot | null => state.snapshot;
export const selectSelectedNodeId = (state: GraphState): string | null => state.selection;
export const selectHoveredNodeId = (state: GraphState): string | null => state.hover;
export const selectGraphFilter = (state: GraphState): GraphFilter => state.filter;
export const selectGraphStatus = (state: GraphState): GraphStatusPhase => state.status;
export const selectGraphStatusMessage = (state: GraphState): string | null => state.statusMessage;

/** 选中的节点对象。命中不了就返回 null，而不是抛错 —— 快照替换和选中更新之间
 *  有一次渲染窗口，此时 id 可能已经失效。 */
export const selectSelectedNode = (state: GraphState): GraphNode | null => {
  if (!state.selection || !state.snapshot) return null;
  return state.snapshot.nodeById.get(state.selection) ?? null;
};

export const selectHoveredNode = (state: GraphState): GraphNode | null => {
  if (!state.hover || !state.snapshot) return null;
  return state.snapshot.nodeById.get(state.hover) ?? null;
};

/** Shared empty result: a fresh `[]` on every call would make a zustand
 *  selector return a new reference each render and loop forever. */
const NO_INCOMING: string[] = [];

/** 反链来源节点 id 列表（只读引用，不要就地排序修改）。 */
export const selectIncomingOf =
  (nodeId: string | null) =>
  (state: GraphState): string[] => {
    if (!nodeId || !state.snapshot) return NO_INCOMING;
    return state.snapshot.incoming.get(nodeId) ?? NO_INCOMING;
  };
