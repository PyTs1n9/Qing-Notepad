import { create } from "zustand";
import type { CanvasBoard, CanvasItem, CanvasViewport } from "@/types";
import { createEmptyCanvasBoard } from "@/types/canvas";

const MAX_HISTORY = 60;

function cloneBoard(board: CanvasBoard): CanvasBoard {
  return JSON.parse(JSON.stringify(board)) as CanvasBoard;
}

interface CanvasState {
  board: CanvasBoard;
  /**
   * Which document `board` is a view of. Lives here rather than in `CanvasView`
   * so host APIs (the plugin bridge) can tell "the user is looking at this
   * board" from "this board only exists on disk".
   */
  activeCanvasId: string | null;
  selectedId: string | null;
  selectedIds: string[];
  loaded: boolean;
  history: CanvasBoard[];
  future: CanvasBoard[];
  loadBoard: (board: CanvasBoard) => void;
  setActiveCanvasId: (id: string | null) => void;
  /**
   * Replace the whole board while keeping undo history. Used by host APIs that
   * compute a batch of changes at once (plugin writes); the user can still
   * Ctrl+Z the result.
   */
  replaceBoard: (board: CanvasBoard) => void;
  setSelectedId: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
  toggleSelectedId: (id: string) => void;
  setViewport: (viewport: CanvasViewport) => void;
  addItem: (item: CanvasItem) => void;
  addItems: (items: CanvasItem[]) => void;
  updateItem: (id: string, updates: Partial<CanvasItem>) => void;
  updateItems: (updates: Record<string, Partial<CanvasItem>>) => void;
  moveLayer: (id: string, direction: "up" | "down") => void;
  removeItem: (id: string) => void;
  removeItems: (ids: string[]) => void;
  clearBoard: () => void;
  undo: () => void;
  redo: () => void;
}

function commit(state: CanvasState, board: CanvasBoard) {
  return {
    board: { ...board, updatedAt: new Date().toISOString() },
    history: [...state.history, cloneBoard(state.board)].slice(-MAX_HISTORY),
    future: [],
  };
}

export const useCanvasStore = create<CanvasState>((set) => ({
  board: createEmptyCanvasBoard(),
  activeCanvasId: null,
  selectedId: null,
  selectedIds: [],
  loaded: false,
  history: [],
  future: [],

  loadBoard: (board) => set({ board: cloneBoard(board), selectedId: null, selectedIds: [], loaded: true, history: [], future: [] }),
  setActiveCanvasId: (id) => set({ activeCanvasId: id }),
  replaceBoard: (board) => set((state) => commit(state, cloneBoard(board))),
  setSelectedId: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),
  setSelectedIds: (ids) => set({ selectedIds: [...new Set(ids)], selectedId: ids[ids.length - 1] ?? null }),
  toggleSelectedId: (id) => set((state) => {
    const selectedIds = state.selectedIds.includes(id)
      ? state.selectedIds.filter((candidate) => candidate !== id)
      : [...state.selectedIds, id];
    return { selectedIds, selectedId: selectedIds[selectedIds.length - 1] ?? null };
  }),
  setViewport: (viewport) => set((state) => ({
    board: {
      ...state.board,
      viewport: {
        x: viewport.x,
        y: viewport.y,
        zoom: Math.min(4, Math.max(0.2, viewport.zoom)),
      },
    },
  })),
  addItem: (item) => set((state) => commit(state, {
    ...state.board,
    items: [...state.board.items, item],
  })),
  addItems: (items) => set((state) => {
    if (items.length === 0) return state;
    return commit(state, { ...state.board, items: [...state.board.items, ...items] });
  }),
  updateItem: (id, updates) => set((state) => {
    const item = state.board.items.find((candidate) => candidate.id === id);
    if (!item) return state;
    return commit(state, {
      ...state.board,
      items: state.board.items.map((candidate) => (
        candidate.id === id ? { ...candidate, ...updates } as CanvasItem : candidate
      )),
    });
  }),
  updateItems: (updates) => set((state) => {
    if (!state.board.items.some((item) => updates[item.id])) return state;
    return commit(state, {
      ...state.board,
      items: state.board.items.map((item) => (
        updates[item.id] ? { ...item, ...updates[item.id] } as CanvasItem : item
      )),
    });
  }),
  moveLayer: (id, direction) => set((state) => {
    const ordered = [...state.board.items].sort((a, b) => a.zIndex - b.zIndex);
    const index = ordered.findIndex((item) => item.id === id);
    if (index < 0) return state;
    const targetIndex = direction === "up" ? index + 1 : index - 1;
    if (targetIndex < 0 || targetIndex >= ordered.length) return state;

    [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
    const items = ordered.map((item, zIndex) => ({ ...item, zIndex }));
    return commit(state, { ...state.board, items });
  }),
  removeItem: (id) => set((state) => {
    if (!state.board.items.some((item) => item.id === id)) return state;
    const removedIds = new Set([id]);
    state.board.items.forEach((item) => {
      if (item.type === "connector" && (item.startBinding?.itemId === id || item.endBinding?.itemId === id)) removedIds.add(item.id);
    });
    const selectedIds = state.selectedIds.filter((candidate) => !removedIds.has(candidate));
    return {
      ...commit(state, { ...state.board, items: state.board.items.filter((item) => !removedIds.has(item.id)) }),
      selectedIds,
      selectedId: selectedIds[selectedIds.length - 1] ?? null,
    };
  }),
  removeItems: (ids) => set((state) => {
    const idSet = new Set(ids);
    if (!state.board.items.some((item) => idSet.has(item.id))) return state;
    state.board.items.forEach((item) => {
      if (item.type === "connector" && (
        (item.startBinding && idSet.has(item.startBinding.itemId))
        || (item.endBinding && idSet.has(item.endBinding.itemId))
      )) idSet.add(item.id);
    });
    const selectedIds = state.selectedIds.filter((candidate) => !idSet.has(candidate));
    return {
      ...commit(state, { ...state.board, items: state.board.items.filter((item) => !idSet.has(item.id)) }),
      selectedIds,
      selectedId: selectedIds[selectedIds.length - 1] ?? null,
    };
  }),
  clearBoard: () => set((state) => {
    if (state.board.items.length === 0) return state;
    return { ...commit(state, { ...state.board, items: [] }), selectedId: null, selectedIds: [] };
  }),
  undo: () => set((state) => {
    const previous = state.history[state.history.length - 1];
    if (!previous) return state;
    return {
      board: previous,
      history: state.history.slice(0, -1),
      future: [cloneBoard(state.board), ...state.future].slice(0, MAX_HISTORY),
      selectedId: null,
      selectedIds: [],
    };
  }),
  redo: () => set((state) => {
    const next = state.future[0];
    if (!next) return state;
    return {
      board: next,
      history: [...state.history, cloneBoard(state.board)].slice(-MAX_HISTORY),
      future: state.future.slice(1),
      selectedId: null,
      selectedIds: [],
    };
  }),
}));
