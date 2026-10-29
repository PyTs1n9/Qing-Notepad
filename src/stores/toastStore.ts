import { create } from "zustand";

/**
 * Transient notices.
 *
 * The app already has `dialogStore` for anything that needs a decision. A toast
 * is the other half: a one-line result the user should see but must not have to
 * dismiss. Plugins reach it through `ui.toast` (permission `notify`), and the
 * host uses it for permission denials so a refused call is never silent.
 */
export type ToastTone = "info" | "success" | "danger";

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

/** Three keeps a burst from covering the editor; older ones drop first. */
const MAX_VISIBLE = 3;
const LIFETIME_MS = 3200;

interface ToastState {
  items: ToastItem[];
  push: (message: string, tone?: ToastTone) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;
const timers = new Map<number, number>();

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],

  push: (message, tone = "info") => {
    const text = message.trim();
    if (!text) return 0;
    const id = nextId++;
    set((state) => {
      const items = [...state.items, { id, message: text, tone }];
      return { items: items.slice(Math.max(0, items.length - MAX_VISIBLE)) };
    });
    const timer = window.setTimeout(() => get().dismiss(id), LIFETIME_MS);
    timers.set(id, timer);
    return id;
  },

  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.delete(id);
    }
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },

  clear: () => {
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
    set({ items: [] });
  },
}));

/** Non-react entry point, for the plugin bridge and error paths. */
export function toast(message: string, tone: ToastTone = "info"): void {
  useToastStore.getState().push(message, tone);
}
