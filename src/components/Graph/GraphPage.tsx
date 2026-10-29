/**
 * Knowledge graph page (T06/T07).
 *
 * Layout follows §8.4: the page fills the main card, there is no explorer column
 * and no sash — the vault list and the filters are overlays inside the canvas,
 * because the note tree cannot represent vault nodes without inventing ghost
 * notes (§2.1).
 *
 * Data flow, all of it one-directional:
 *
 *   graphStore.snapshot ──► positions (cache + cold layout + incremental)
 *                        ──► GraphRenderer (paint only, never a store)
 *   vaultStore.records   ──► overlay vault list
 *   selection            ──► right-hand read-only panel + backlinks
 *
 * The component owns three things the data layer deliberately does not: where
 * coordinates come from, when they are written back, and how a click turns into
 * a route change (§4.4.2).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, Loader2, PanelLeftClose, PanelLeftOpen, RefreshCw, Trash2, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useReducedMotion } from "motion/react";
import type { ViewType } from "@/types";
import type { GraphNode, VaultRecord } from "@/types/graph";
import PanelErrorBoundary from "@/components/PanelErrorBoundary";
import GraphRenderer, { type GraphRendererHandle } from "@/components/Graph/GraphRenderer";
import NodeListPanel from "@/components/Graph/NodeListPanel";
import { useGraphStore, createEmptyGraphFilter } from "@/stores/graphStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useNoteStore } from "@/stores/noteStore";
import { useTabStore } from "@/stores/tabStore";
import { confirmDialog } from "@/stores/dialogStore";
import { t, tWithParams } from "@/utils/i18n";
import { renderMarkdown } from "@/utils/markdown";
import { loadNoteContent } from "@/utils/storage";
import { createGraphFs } from "@/utils/graph/graphFs";
import {
  createPositionStore,
  missingPositionIds,
  placeIncremental,
  seedColdLayout,
  type PositionMap,
  type PositionStore,
} from "@/utils/graph/layoutEngine";
import {
  forgetVault,
  loadGraphIndex,
  refreshAllVaults,
  requestVaultSync,
  resolveIndexRoot,
  startVaultSync,
} from "@/utils/graph/graphSync";
import {
  listVaults,
  readVaultFiles,
  registerVault,
  removeVault,
} from "@/utils/graph/vaultService";

/** §4.3: the zoom readout is throttled to 100 ms instead of driving React per frame. */
const ZOOM_THROTTLE_MS = 100;
/**
 * Two clicks on the same node within this window open it in the editor. The
 * keyboard path (`NodeListPanel` + Enter, and the backlink rows) already had a
 * dedicated activate step; the canvas only had "select", so a double click was
 * the one gesture that did nothing at all.
 */
const NODE_DOUBLE_CLICK_MS = 320;
/**
 * Stagger between the letters of the loading headline. Long enough that the wave
 * reads as sequential, short enough that a 6-character title does not take a
 * full second to finish its first pass.
 */
const LOADING_CHAR_STAGGER_MS = 55;

/** Anchors `aria-controls` on the two toggle buttons to the panel itself. */
const GRAPH_PANEL_ID = "graph-overlay-panel";

/** `localStorage` key for the overlay panel's collapsed state. */
const GRAPH_PANEL_OPEN_KEY = "qing.graph.panelOpen";

/**
 * Below this width the canvas is too narrow for a 256px overlay *and* a 380px
 * dossier, so a first visit starts collapsed and the dossier becomes a bottom
 * sheet (the `max-md:` classes on the `<aside>` below carry the same number).
 */
const GRAPH_NARROW_VIEWPORT_PX = 768;

/**
 * Read the persisted collapse state.
 *
 * `null` means "no opinion" (never toggled, or storage unavailable), which lets
 * the caller apply the width-based default instead of silently pinning one.
 */
const readPanelOpenPreference = (): boolean | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GRAPH_PANEL_OPEN_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
};

const writePanelOpenPreference = (open: boolean): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GRAPH_PANEL_OPEN_KEY, open ? "true" : "false");
  } catch {
    // A locked-down WebView can refuse storage; the toggle still works for this
    // session, only the memory across restarts is lost.
  }
};

/** First-visit default: expanded on desktop, collapsed on a narrow window. */
const resolveInitialPanelOpen = (): boolean => {
  const stored = readPanelOpenPreference();
  if (stored !== null) return stored;
  if (typeof window === "undefined") return true;
  return window.innerWidth >= GRAPH_NARROW_VIEWPORT_PX;
};

interface GraphPageProps {
  /** Owned by `App`; the page never reaches into routing itself (see §4.4.2 note). */
  setCurrentView: (view: ViewType) => void;
}

interface DocumentState {
  nodeId: string;
  loading: boolean;
  html: string | null;
  error: string | null;
}

const formatScanTime = (value: string | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
};

interface OverlayGroupProps {
  /**
   * Stable, literal id for the `aria-labelledby` wiring — the heading takes
   * `${id}-label`. Passed in rather than generated: three static groups do not
   * justify a `useId` (which would also churn the id on every remount).
   */
  id: string;
  /** Already translated; the group never reaches for `t()` itself. */
  title: string;
  /** Optional right-aligned metadata in the heading row (counts). */
  aside?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * One group of the overlay panel.
 *
 * Borderless on purpose: the panel is the single surface, and the three groups
 * inside it are separated by a hairline instead of each drawing its own box.
 * Nested frames (card → card → inner list) made the 256px column read as three
 * stacked widgets; a heading, a rule and shared rhythm read as one list of
 * lists, which is what this actually is.
 *
 * `role="group"` rather than a named `<section>`: these are clusters of related
 * controls, not landmarks — three landmarks in a 256px panel would flood the
 * landmark list and make region navigation useless.
 *
 * The name here repeats the node list's own `aria-label` (both come from
 * `graphNodeList`), so a screen reader announces it twice: "节点列表, 分组" then
 * "节点列表, 列表, 500 项". That duplication is intentional — a listbox does not
 * inherit its name from an ancestor group, so removing the list's label to
 * "de-duplicate" would leave it nameless. Do not remove either one.
 *
 * `pointer-events-auto` because the panel above is `pointer-events-none`: the
 * group is the thing a user actually clicks, so it is the thing that must be
 * hit testable.
 *
 * The heading's `px-1` is 2px left of the rows' text axis (rows carry `px-1.5`
 * once their own padding is counted). That offset is deliberate — an 11px label
 * on the same axis as 12px body text reads as indented — but it is capped at
 * 2px: if the heading ever moves to 12px, the offset must go to zero.
 */
const OverlayGroup: React.FC<OverlayGroupProps> = ({ id, title, aside, children }) => (
  <section
    role="group"
    aria-labelledby={`${id}-label`}
    className="pointer-events-auto flex flex-shrink-0 flex-col"
  >
    <h4
      id={`${id}-label`}
      className="mb-1.5 flex items-center gap-2 px-1 text-[11px] font-medium leading-4 text-text-muted"
    >
      <span className="min-w-0 truncate">{title}</span>
      {aside}
    </h4>
    {children}
  </section>
);

const GraphPageInner: React.FC<GraphPageProps> = ({ setCurrentView }) => {
  const lang = useSettingsStore((state) => state.lang);
  const reduceMotion = useReducedMotion() === true;

  const snapshot = useGraphStore((state) => state.snapshot);
  const selection = useGraphStore((state) => state.selection);
  const hover = useGraphStore((state) => state.hover);
  const filter = useGraphStore((state) => state.filter);
  const status = useGraphStore((state) => state.status);
  const statusMessage = useGraphStore((state) => state.statusMessage);
  const setSelection = useGraphStore((state) => state.setSelection);
  const setHover = useGraphStore((state) => state.setHover);
  const patchFilter = useGraphStore((state) => state.patchFilter);

  const records = useVaultStore((state) => state.records);
  const setRecords = useVaultStore((state) => state.setRecords);
  const vaultError = useVaultStore((state) => state.error);
  const setVaultError = useVaultStore((state) => state.setError);

  const rendererRef = useRef<GraphRendererHandle | null>(null);
  const positionStoreRef = useRef<PositionStore | null>(null);
  const stopSyncRef = useRef<(() => void) | null>(null);
  const lastZoomAtRef = useRef(0);
  /**
   * Two clicks inside `NODE_DOUBLE_CLICK_MS` on the same node open it. Kept in a
   * ref rather than state: the window is 320 ms and a re-render per click would
   * fight the canvas for the main thread.
   */
  const lastNodeClickRef = useRef<{ id: string; at: number } | null>(null);
  /**
   * `activateNode` closes over `snapshot`, so listing it in the subscription
   * effect's deps would tear down and rebuild the subscription on every sync
   * push. The ref keeps the callback current without re-subscribing.
   */
  const activateNodeRef = useRef<(nodeId: string) => void>(() => {});
  /**
   * Mirror of `selection` for the window-level Escape listener below.
   *
   * The listener is mounted once for the lifetime of the page: re-subscribing on
   * every selection change would remove and add a `window` listener on each
   * click for no benefit, and reading the store inside the handler would make
   * the effect depend on `selection` again. The ref is written in an effect, so
   * it always holds the value of the last committed render.
   */
  const selectionRef = useRef<string | null>(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const [query, setQuery] = useState("");
  const [positions, setPositions] = useState<PositionMap>(() => new Map());
  const [hasCachedPositions, setHasCachedPositions] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [documentState, setDocumentState] = useState<DocumentState | null>(null);
  const [busy, setBusy] = useState(false);

  // DEV diagnostic: the canvas -> store -> panel chain has three hops (library
  // hit test, `onNodeClick`, store selection). A click that "does nothing" can
  // die in any of them, and only the first hop has no hook of its own, so this
  // log brackets the other two.
  useEffect(() => {
    if (import.meta.env.DEV) {
      console.info("[graph] selection", { id: selection });
    }
  }, [selection]);

  // Overlay collapse. Purely cosmetic: the panel is absolutely positioned in
  // both states, so the canvas never re-measures and no layout shift leaks into
  // the force layout (§8.4).
  const [panelOpen, setPanelOpen] = useState<boolean>(resolveInitialPanelOpen);
  const panelToggleRef = useRef<HTMLButtonElement | null>(null);
  const railButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocusRef = useRef<"panel" | "rail" | null>(null);
  /**
   * The first filter switch. "Clear filters" unmounts itself (it only renders
   * while something is filtered), so the click that uses it also destroys the
   * focused element and focus falls back to `<body>` — a keyboard user then has
   * to re-walk the whole tab path. Handing focus to the first switch keeps the
   * user where they were: still in the filter group, ready to filter again.
   */
  const filterFirstRef = useRef<HTMLButtonElement | null>(null);

  const setPanelOpenPersisted = useCallback((open: boolean, focusTarget: "panel" | "rail") => {
    pendingFocusRef.current = focusTarget;
    setPanelOpen(open);
    writePanelOpenPreference(open);
  }, []);

  // Toggling unmounts the button that had focus, which would silently drop the
  // caret to <body> and cost a keyboard user the whole Tab path back into the
  // page. Hand focus to the button that replaced it instead.
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) return;
    pendingFocusRef.current = null;
    if (target === "rail") railButtonRef.current?.focus();
    else panelToggleRef.current?.focus();
  }, [panelOpen]);

  /* ---------------------------------------------------------------- store */

  const ensurePositionStore = useCallback(async (): Promise<PositionStore> => {
    if (!positionStoreRef.current) {
      const fs = createGraphFs();
      positionStoreRef.current = createPositionStore(fs, await resolveIndexRoot());
    }
    return positionStoreRef.current;
  }, []);

  const reloadVaultRecords = useCallback(async () => {
    try {
      const next = await listVaults();
      setRecords(next);
      setVaultError(null);
    } catch (error) {
      setVaultError(error instanceof Error ? error.message : String(error));
    }
  }, [setRecords, setVaultError]);

  // Mount: load the index first (so the first frame has content instead of an
  // empty canvas), then subscribe and let the 3 s startup scan run.
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        await loadGraphIndex();
        await reloadVaultRecords();
      } catch (error) {
        console.error("[graph] cannot load the index:", error);
      }
      if (disposed) return;
      stopSyncRef.current = startVaultSync();
    })();
    return () => {
      disposed = true;
      stopSyncRef.current?.();
      stopSyncRef.current = null;
    };
  }, [reloadVaultRecords]);

  /* ------------------------------------------------------------ positions */

  useEffect(() => {
    if (!snapshot) {
      setPositions(new Map());
      setHasCachedPositions(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const store = await ensurePositionStore();
      const cached = await store.read();
      if (cancelled) return;

      let next: PositionMap;
      if (cached.size === 0) {
        // 冷启动（§4.2.5）：确定性的分簇网格，首帧就稳定，不是一团糊。
        next = seedColdLayout(snapshot.nodes);
      } else {
        // 增量（§4.2.4）：已有坐标一个都不动，新节点落邻居质心。
        next = placeIncremental(snapshot.nodes, cached, snapshot.edges).positions;
        const missing = missingPositionIds(snapshot.nodes, next);
        if (missing.length > 0) {
          const cold = seedColdLayout(snapshot.nodes);
          for (const id of missing) {
            const point = cold.get(id);
            if (point) next.set(id, point);
          }
        }
      }

      setPositions(next);
      // 缓存覆盖全图时收敛时间可以短很多（§8.3 ③）。
      setHasCachedPositions(missingPositionIds(snapshot.nodes, cached).length === 0);
      rendererRef.current?.setPositions(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, ensurePositionStore]);

  // 收敛时才写盘（§4.2.3）：每帧写 5000 个坐标是不可接受的。
  const persistPositions = useCallback(() => {
    const handle = rendererRef.current;
    if (!handle) return;
    const current = handle.readPositions();
    if (current.size === 0) return;
    void (async () => {
      try {
        const store = await ensurePositionStore();
        await store.write(current);
      } catch (error) {
        console.error("[graph] cannot cache positions:", error);
      }
    })();
  }, [ensurePositionStore]);

  /* --------------------------------------------------------- renderer I/O */

  /**
   * The canvas only exists once there is at least one node to draw, and
   * `subscribe()` is nothing but a ref write on the child. Subscribing while the
   * child is absent is therefore a silent no-op that never retries — the click
   * then dies at the second hop and the panel never opens. Every effect that
   * reaches into `rendererRef` depends on this flag so the subscription is
   * (re)made exactly when the canvas appears.
   */
  const rendererReady = snapshot !== null && snapshot.nodes.length > 0;

  useEffect(() => {
    const unsubscribe = rendererRef.current?.subscribe({
      onNodeClick: (nodeId) => {
        setSelection(nodeId);
        const now = Date.now();
        const last = lastNodeClickRef.current;
        lastNodeClickRef.current = { id: nodeId, at: now };
        if (last !== null && last.id === nodeId && now - last.at <= NODE_DOUBLE_CLICK_MS) {
          lastNodeClickRef.current = null;
          activateNodeRef.current(nodeId);
        }
      },
      onNodeHover: (nodeId) => setHover(nodeId),
      // 没有 `onBackgroundClick`：渲染层不传它，节点点击才不会被库的「画布拖拽
      // 检测」吞掉（见 `GraphRenderer` 里那一段注释）。取消选中改走 Esc ——
      // `handleCanvasKeyDown` 的分支，不依赖命中测试。
      onZoomChange: (nextZoom) => {
        const now = Date.now();
        if (now - lastZoomAtRef.current < ZOOM_THROTTLE_MS) return;
        lastZoomAtRef.current = now;
        setZoom(nextZoom);
      },
      onEngineStop: () => persistPositions(),
    });
    return () => unsubscribe?.();
  }, [rendererReady, persistPositions, setHover, setSelection]);

  /* -------------------------------------------------------------- filters */

  const filteredNodes = useMemo<GraphNode[]>(() => {
    if (!snapshot) return [];
    const needle = query.trim().toLowerCase();
    return snapshot.nodes.filter((node) => {
      if (filter.danglingOnly && node.kind !== "dangling") return false;
      if (filter.orphansOnly && node.degree !== 0) return false;
      if (filter.vaultKeys.length > 0 && node.kind !== "dangling") {
        if (node.vaultKey === null || !filter.vaultKeys.includes(node.vaultKey)) return false;
      }
      if (filter.tags.length > 0 && !node.tags.some((tag) => filter.tags.includes(tag))) {
        return false;
      }
      if (!needle) return true;
      return (
        node.title.toLowerCase().includes(needle) ||
        (node.path ?? "").toLowerCase().includes(needle)
      );
    });
  }, [snapshot, query, filter]);

  const availableTags = useMemo(() => {
    if (!snapshot) return [];
    const tags = new Set<string>();
    for (const node of snapshot.nodes) for (const tag of node.tags) tags.add(tag);
    return [...tags].sort();
  }, [snapshot]);

  const selectedNode = useMemo<GraphNode | null>(() => {
    if (!snapshot || !selection) return null;
    return snapshot.nodeById.get(selection) ?? null;
  }, [snapshot, selection]);

  const backlinks = useMemo(() => {
    if (!snapshot || !selectedNode) return [];
    const sources = snapshot.incoming.get(selectedNode.id) ?? [];
    return sources
      .map((id) => snapshot.nodeById.get(id))
      .filter((node): node is GraphNode => node !== undefined)
      .map((node) => ({
        node,
        references: (snapshot.outByNode.get(node.id) ?? [])
          .filter((edge) => edge.target === selectedNode.id)
          .map((edge) => ({ line: edge.line, raw: edge.raw })),
      }));
  }, [snapshot, selectedNode]);

  /* -------------------------------------------------------- document panel */

  useEffect(() => {
    if (!selectedNode) {
      setDocumentState(null);
      return;
    }
    const nodeId = selectedNode.id;
    let cancelled = false;

    /*
     * Native nodes are this app's own notes, and they used to be the one kind
     * the sheet refused to render: clicking one showed a title, a path and an
     * "open in editor" button, so the panel looked empty. They are read through
     * `storage.ts` rather than the vault bridge, which is why they cannot share
     * the branch below.
     */
    if (selectedNode.kind === "native") {
      const noteId = selectedNode.refId;
      // Same "keep what is already on screen" rule as the vault branch — the
      // effect re-runs on every snapshot push with a fresh node object.
      setDocumentState((current) =>
        current && current.nodeId === nodeId && current.html !== null
          ? current
          : { nodeId, loading: true, html: null, error: null },
      );
      void (async () => {
        try {
          // `loadNoteContent` yields "" for a note whose file was removed, so a
          // stale node renders as an empty sheet instead of an error.
          const text = await loadNoteContent(noteId);
          const html = await renderMarkdown(text);
          if (cancelled) return;
          setDocumentState({ nodeId, loading: false, html, error: null });
        } catch (error) {
          if (cancelled) return;
          if (import.meta.env.DEV) {
            console.warn("[graph] note fetch failed", error);
          }
          setDocumentState({
            nodeId,
            loading: false,
            html: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    if (selectedNode.kind !== "vault" || !selectedNode.path || !selectedNode.vaultKey) {
      setDocumentState(null);
      return;
    }
    const vaultKey = selectedNode.vaultKey;
    const relPath = selectedNode.path;
    if (import.meta.env.DEV) {
      console.info("[graph] doc fetch", { nodeId, vaultKey, relPath });
    }
    // Re-reading the *same* node keeps what is already on screen. The effect
    // re-runs on every snapshot push (its dependency is the node object, and
    // `deriveSnapshot` hands out fresh objects each time), so clearing here
    // would drop the panel back to "loading" on every push — which is what made
    // the sheet look like it never finished loading. Switching nodes still
    // clears, because the id differs.
    setDocumentState((current) =>
      current && current.nodeId === nodeId && current.html !== null
        ? current
        : { nodeId, loading: true, html: null, error: null },
    );
    void (async () => {
      try {
        const [content] = await readVaultFiles(vaultKey, [relPath]);
        if (cancelled) return;
        if (!content || content.text === null) {
          setDocumentState({
            nodeId,
            loading: false,
            html: null,
            error: content?.skipped ?? t(lang, "graphUnreadable"),
          });
          return;
        }
        const html = await renderMarkdown(content.text);
        if (cancelled) return;
        setDocumentState({ nodeId, loading: false, html, error: null });
      } catch (error) {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          console.warn("[graph] doc fetch failed", error);
        }
        setDocumentState({
          nodeId,
          loading: false,
          html: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedNode, lang]);

  /* --------------------------------------------------------------- actions */

  /**
   * §4.4.2 three branches. Native goes to the editor (the same three calls the
   * canvas ref-node path makes), vault stays read-only in this page, dangling
   * only tells you who points at it.
   */
  const activateNode = useCallback(
    (nodeId: string) => {
      const node = snapshot?.nodeById.get(nodeId);
      if (!node) return;
      if (node.kind === "native") {
        useNoteStore.getState().setActiveNoteId(node.refId);
        useTabStore.getState().openTab(node.refId, { preview: false });
        setCurrentView("note");
        return;
      }
      setSelection(nodeId);
      rendererRef.current?.focusNode(nodeId);
    },
    [snapshot, setCurrentView, setSelection],
  );

  // Publish the latest `activateNode` for the canvas double-click handler, which
  // is registered once and must not capture a stale `snapshot`.
  useEffect(() => {
    activateNodeRef.current = activateNode;
  }, [activateNode]);

  const handleSelect = useCallback(
    (nodeId: string) => {
      setSelection(nodeId);
      rendererRef.current?.setSelection(nodeId);
    },
    [setSelection],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setQuery(value);
      const needle = value.trim().toLowerCase();
      if (!needle || !snapshot) return;
      const hit = snapshot.nodes.find(
        (node) =>
          node.title.toLowerCase().includes(needle) ||
          (node.path ?? "").toLowerCase().includes(needle),
      );
      if (hit) handleSelect(hit.id);
    },
    [handleSelect, snapshot],
  );

  const handleAddFolder = useCallback(async () => {
    setBusy(true);
    try {
      const picked = await open({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return;
      const record = await registerVault(picked);
      await reloadVaultRecords();
      await requestVaultSync(record.key, { full: true });
    } catch (error) {
      setVaultError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [reloadVaultRecords, setVaultError]);

  const handleRemoveVault = useCallback(
    async (record: VaultRecord) => {
      const confirmed = await confirmDialog({
        title: t(lang, "graphRemoveVault"),
        body: tWithParams(lang, "graphRemoveVaultQuestion", { name: record.name }),
        confirmLabel: t(lang, "dialogConfirm"),
        cancelLabel: t(lang, "dialogCancel"),
        tone: "warning",
      });
      if (!confirmed) return;
      setBusy(true);
      try {
        await removeVault(record.key);
        await forgetVault(record.key);
        await reloadVaultRecords();
      } catch (error) {
        setVaultError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [lang, reloadVaultRecords, setVaultError],
  );

  const handleRefresh = useCallback(() => {
    void refreshAllVaults({ full: true });
  }, []);

  const handleCanvasKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        setSelection(null);
        rendererRef.current?.setSelection(null);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        rendererRef.current?.zoomBy(1.2);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        rendererRef.current?.zoomBy(1 / 1.2);
        return;
      }
      const step = 80;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        rendererRef.current?.panBy(step, 0);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        rendererRef.current?.panBy(-step, 0);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        rendererRef.current?.panBy(0, step);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        rendererRef.current?.panBy(0, -step);
      }
    },
    [setSelection],
  );

  /**
   * Page-level Escape: clear the selection from anywhere on the page.
   *
   * The canvas container has its own Escape branch (`handleCanvasKeyDown`
   * above), but it only fires while the canvas holds focus. The overlay panels
   * are DOM siblings of the canvas, so a key pressed on one of their buttons
   * never reaches it — and since `onBackgroundClick` is no longer wired (it
   * disables node clicks, see `GraphRenderer`), Escape is the only way to
   * deselect. Both paths do the same thing, so pressing Escape twice is
   * harmless.
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      // Never steal Escape from a field the user is typing in: the toolbar
      // search box lives on this page, and Escape there should clear the query
      // (the browser's own behaviour for `type="search"`), not the selection.
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target) {
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        if (target.isContentEditable) return;
      }
      if (selectionRef.current === null) return;
      setSelection(null);
      rendererRef.current?.setSelection(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSelection]);

  /* ---------------------------------------------------------------- render */

  const nodeCount = snapshot?.meta.nodeCount ?? 0;
  const edgeCount = snapshot?.meta.edgeCount ?? 0;
  const announcement = selectedNode
    ? tWithParams(lang, "graphSelectedAnnounce", {
        title: selectedNode.title,
        count: backlinks.length,
      })
    : "";

  const showEmptyState = records.length === 0;
  /*
   * Vaults are configured but the first snapshot has not landed: the scan is
   * still running. Before this, that window showed the bare "click a node"
   * hint on an empty canvas, which reads as "nothing here" rather than
   * "still loading".
   */
  const isGraphLoading = !rendererReady && !showEmptyState && status !== "error";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar: search, counts, status, refresh, add folder. */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <label className="sr-only" htmlFor="graph-search">
          {t(lang, "graphSearchPlaceholder")}
        </label>
        <input
          id="graph-search"
          type="search"
          value={query}
          onChange={(event) => handleSearchChange(event.target.value)}
          placeholder={t(lang, "graphSearchPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="w-56 rounded-md border border-border bg-bg-primary/50 px-2 py-1 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
        <span className="text-xs text-text-muted">
          {tWithParams(lang, "graphNodesCount", { count: nodeCount })}
          {" · "}
          {tWithParams(lang, "graphEdgesCount", { count: edgeCount })}
        </span>
        {status === "scanning" && (
          <span className="flex items-center gap-1 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {t(lang, "graphStatusScanning")}
          </span>
        )}
        {status === "error" && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-danger" role="alert">
            <span className="flex-shrink-0">{t(lang, "graphStatusError")}</span>
            {statusMessage ? <span className="truncate text-text-muted">· {statusMessage}</span> : null}
            <button
              type="button"
              onClick={handleRefresh}
              className="flex-shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-primary hover:bg-bg-hover"
            >
              {t(lang, "retry")}
            </button>
          </span>
        )}
        <span className="ml-auto flex-shrink-0 text-xs text-text-muted">
          {tWithParams(lang, "graphZoom", { value: Math.round(zoom * 100) })}
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          title={t(lang, "graphRefresh")}
          aria-label={t(lang, "graphRefresh")}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <RefreshCw size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={() => void handleAddFolder()}
          title={t(lang, "graphAddFolder")}
          disabled={busy}
          className="flex h-7 flex-shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-60"
        >
          <FolderPlus size={13} strokeWidth={1.8} />
          {t(lang, "graphAddFolder")}
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {rendererReady ? (
          <GraphRenderer
            ref={rendererRef}
            snapshot={snapshot}
            filter={filter}
            selection={selection}
            hover={hover}
            hasCachedPositions={hasCachedPositions}
            initialPositions={positions}
            reduceMotion={reduceMotion}
            ariaLabel={t(lang, "knowledgeBase")}
            onKeyDown={handleCanvasKeyDown}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            {showEmptyState ? (
              <div className="max-w-sm rounded-lg border border-border bg-bg-secondary/60 p-5 text-center">
                <h2 className="text-sm font-semibold text-text-primary">{t(lang, "graphEmptyTitle")}</h2>
                <p className="mt-2 text-xs leading-relaxed text-text-muted">{t(lang, "graphEmptyHint")}</p>
                <button
                  type="button"
                  onClick={() => void handleAddFolder()}
                  disabled={busy}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  <FolderPlus size={14} strokeWidth={1.8} />
                  {t(lang, "graphAddFolder")}
                </button>
              </div>
            ) : isGraphLoading ? (
              <div
                className="flex flex-col items-center gap-2 text-center"
                role="status"
                aria-live="polite"
              >
                {/*
                  Split into per-character spans for the wave. The whole title is
                  carried by `aria-label`, so a screen reader says the sentence
                  once instead of spelling it out; the spans themselves are
                  decoration and are hidden from the accessibility tree.
                */}
                <p
                  className="text-sm font-medium text-text-primary"
                  aria-label={t(lang, "graphLoadingTitle")}
                >
                  {[...t(lang, "graphLoadingTitle")].map((char, index) => (
                    <span
                      key={`${char}-${index}`}
                      aria-hidden="true"
                      className="graph-loading-char"
                      style={{ animationDelay: `${index * LOADING_CHAR_STAGGER_MS}ms` }}
                    >
                      {char === " " ? "\u00a0" : char}
                    </span>
                  ))}
                </p>
                <p className="max-w-xs text-xs leading-relaxed text-text-muted">
                  {t(lang, "graphLoadingHint")}
                </p>
              </div>
            ) : (
              <p className="text-xs text-text-muted">{t(lang, "graphNoSelection")}</p>
            )}
          </div>
        )}

        {/*
          Vault list + filters + node list, inside the canvas area.

          `pointer-events-none` on the panel and `pointer-events-auto` on the
          pieces that are actually interactive: the panel's own padding, its
          rounded corners and the gaps between cards are then transparent to the
          canvas underneath, instead of being a dead rectangle that swallows
          clicks meant for a node. Collapsing swaps the whole panel for a rail
          button in the same corner. Both states are absolutely positioned, so
          the canvas is never re-measured and the force layout never sees a
          resize.
        */}
        {panelOpen ? (
          <section
            id={GRAPH_PANEL_ID}
            aria-label={t(lang, "graphPanelTitle")}
            className={`graph-panel-in pointer-events-none absolute left-3 top-3 flex max-h-[calc(100%-1.5rem)] w-[min(16rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-bg-secondary/85 ${
              selectedNode ? "max-md:max-h-[calc(55%-2.25rem)]" : ""
            }`}
          >
            <header className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5">
              <h3 className="min-w-0 flex-1 truncate text-[11px] font-medium leading-4 text-text-muted">
                {t(lang, "graphPanelTitle")}
              </h3>
              <span
                // `auto` only because of its `title` tooltip: the panel around
                // it is `pointer-events-none`, and a hover-only affordance
                // still needs to be hit testable to work.
                className="pointer-events-auto flex-shrink-0 text-[11px] leading-4 tabular-nums text-text-muted"
                title={tWithParams(lang, "graphNodesCount", { count: filteredNodes.length })}
              >
                {filteredNodes.length}
              </span>
              <button
                ref={panelToggleRef}
                type="button"
                onClick={() => setPanelOpenPersisted(false, "rail")}
                aria-expanded={true}
                aria-controls={GRAPH_PANEL_ID}
                aria-label={t(lang, "graphPanelCollapse")}
                title={t(lang, "graphPanelCollapse")}
                className="pointer-events-auto flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <PanelLeftClose size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </header>

            {/*
              `min-h-0` + `overflow-y-auto`: on a short window the three groups
              scroll inside the panel instead of running off the canvas. No `gap`
              here — the hairline rules between groups are the only spacing, so
              the rhythm does not change when a group is empty. The thin 6px
              scrollbar comes from the global rules in index.css, so no
              per-panel scrollbar styling is needed here.

              `pointer-events-auto` is what puts this box back on the hit path:
              the wheel/touch scroll is delivered to the scrollable element, so
              it has to be hit-testable even though the panel around it is not.
            */}
            <div className="pointer-events-auto flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2 pt-1">
              <OverlayGroup id="graph-group-vaults" title={t(lang, "graphVaults")}>
                {records.length === 0 ? (
                  <>
                    <p className="px-1 text-[11px] leading-4 text-text-muted">
                      {t(lang, "graphEmptyTitle")}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleAddFolder()}
                      disabled={busy}
                      className="mt-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-accent-text hover:underline disabled:opacity-60"
                    >
                      <FolderPlus size={12} strokeWidth={1.8} aria-hidden="true" />
                      {t(lang, "graphAddFolder")}
                    </button>
                  </>
                ) : (
                  <ul className="flex flex-col">
                    {records.map((record) => {
                      const scanTime = formatScanTime(record.lastScanAt);
                      const filtered = filter.vaultKeys.includes(record.key);
                      return (
                        <li
                          key={record.key}
                          className="group flex items-start gap-1 rounded-md transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover"
                        >
                          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-1.5 py-1.5 has-[:focus-visible]:rounded-md has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-accent">
                            <input
                              type="checkbox"
                              checked={filtered}
                              onChange={() =>
                                patchFilter({
                                  vaultKeys: filtered
                                    ? filter.vaultKeys.filter((key) => key !== record.key)
                                    : [...filter.vaultKeys, record.key],
                                })
                              }
                              className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-[var(--color-accent)]"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-xs leading-4 text-text-primary">
                                {record.name}
                              </span>
                              <span
                                className="block truncate text-[11px] leading-4 text-text-muted"
                                title={scanTime ? tWithParams(lang, "graphLastScan", { time: scanTime }) : undefined}
                              >
                                {record.fileCount}
                                {" · "}
                                {scanTime ?? "-"}
                              </span>
                            </span>
                          </label>
                          <button
                            type="button"
                            onClick={() => void handleRemoveVault(record)}
                            title={t(lang, "graphRemoveVault")}
                            aria-label={`${t(lang, "graphRemoveVault")} ${record.name}`}
                            className="mr-1 mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-muted opacity-0 transition-[opacity,color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-active hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                          >
                            <Trash2 size={12} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {vaultError ? <p className="mt-1 px-1 text-[11px] text-danger">{vaultError}</p> : null}
              </OverlayGroup>

              {/* Full-bleed rule: `-mx-2.5` cancels the container's `px-2.5` so
                  the line reaches both panel edges. The negative value is bound
                  to that padding — change one, change the other, or the rule
                  turns into an indented card edge. The asymmetry is deliberate:
                  6px above (it belongs to the group that follows) and 12px
                  below (the next heading's `mb-1.5` closes the gap), so the line
                  reads as a divider above a heading, not below one. */}
              <div className="-mx-2.5 mb-3 mt-1.5 h-px flex-shrink-0 bg-border/60" aria-hidden="true" />

              <OverlayGroup id="graph-group-filters" title={t(lang, "graphFilters")}>
                <div className="flex flex-col">
                  <button
                    ref={filterFirstRef}
                    type="button"
                    role="switch"
                    aria-checked={filter.orphansOnly}
                    onClick={() => patchFilter({ orphansOnly: !filter.orphansOnly })}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-text-primary transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                  >
                    <span className="min-w-0 truncate">{t(lang, "graphFilterOrphans")}</span>
                    {/*
                      A switch instead of a checkbox: the whole row is the hit
                      target, so the 20x36 track is decoration. Geometry is
                      fixed — track 36px, knob 16px, 2px inset, so the checked
                      state travels translate-x-4 (16px) and lands 2px off the
                      right edge.
                    */}
                    <span
                      aria-hidden="true"
                      className={`relative ml-auto h-5 w-9 flex-shrink-0 rounded-full transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                        filter.orphansOnly ? "bg-accent" : "bg-bg-active"
                      }`}
                    >
                      <span
                        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                          filter.orphansOnly ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </span>
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={filter.danglingOnly}
                    onClick={() => patchFilter({ danglingOnly: !filter.danglingOnly })}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-text-primary transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                  >
                    <span className="min-w-0 truncate">{t(lang, "graphFilterDangling")}</span>
                    <span
                      aria-hidden="true"
                      className={`relative ml-auto h-5 w-9 flex-shrink-0 rounded-full transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                        filter.danglingOnly ? "bg-accent" : "bg-bg-active"
                      }`}
                    >
                      <span
                        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                          filter.danglingOnly ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </span>
                  </button>
                  <div
                    role="group"
                    aria-labelledby="graph-group-filters-tags-label"
                    className="mt-1"
                  >
                    <span
                      id="graph-group-filters-tags-label"
                      className="mb-1 block px-1 text-[11px] leading-4 text-text-muted"
                    >
                      {t(lang, "graphFilterTags")}
                    </span>
                    {availableTags.length === 0 ? (
                      <p className="px-1 text-[11px] leading-4 text-text-muted">{t(lang, "graphNoTags")}</p>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {availableTags.map((tag) => {
                          const active = filter.tags.includes(tag);
                          return (
                            <button
                              key={tag}
                              type="button"
                              aria-pressed={active}
                              onClick={() =>
                                patchFilter({
                                  tags: active
                                    ? filter.tags.filter((item) => item !== tag)
                                    : [...filter.tags, tag],
                                })
                              }
                              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                                active
                                  ? "border-transparent bg-accent-light text-accent-text"
                                  : "border-border text-text-muted hover:bg-bg-hover hover:text-text-primary"
                              }`}
                            >
                              {tag}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {/*
                    Only rendered when it can do something: a permanently
                    visible "clear" on an unfiltered list is a dead control, and
                    the panel is 256px wide — every dead row costs a node.
                  */}
                  {(filter.orphansOnly ||
                    filter.danglingOnly ||
                    filter.tags.length > 0 ||
                    filter.vaultKeys.length > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        useGraphStore.getState().setFilter(createEmptyGraphFilter());
                        // Focus before the re-render removes this button: the
                        // switch is always mounted, so it can take focus now and
                        // the subsequent unmount of an already-blurred button
                        // cannot pull focus back to `<body>`.
                        filterFirstRef.current?.focus();
                      }}
                      className="mt-1.5 flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-accent-text hover:underline"
                    >
                      <X size={12} strokeWidth={2} aria-hidden="true" />
                      {t(lang, "graphClearFilters")}
                    </button>
                  )}
                </div>
              </OverlayGroup>

              {/* Same full-bleed rule as above — see the note on the first one. */}
              <div className="-mx-2.5 mb-3 mt-1.5 h-px flex-shrink-0 bg-border/60" aria-hidden="true" />

              <OverlayGroup
                id="graph-group-nodes"
                title={t(lang, "graphNodeList")}
                aside={
                  <span className="ml-auto text-[11px] leading-4 tabular-nums text-text-muted">
                    {filteredNodes.length}
                  </span>
                }
              >
                <NodeListPanel
                  nodes={filteredNodes}
                  selectedId={selection}
                  query={query}
                  lang={lang}
                  showSearch={false}
                  onQueryChange={setQuery}
                  onSelect={handleSelect}
                  onActivate={activateNode}
                />
              </OverlayGroup>
            </div>
          </section>
        ) : (
          <button
            ref={railButtonRef}
            type="button"
            onClick={() => setPanelOpenPersisted(true, "panel")}
            aria-expanded={false}
            aria-controls={GRAPH_PANEL_ID}
            aria-label={tWithParams(lang, "graphPanelExpandCount", { count: filteredNodes.length })}
            title={t(lang, "graphPanelExpand")}
            className="graph-panel-in absolute left-3 top-3 flex h-8 items-center gap-1.5 rounded-lg border border-border bg-bg-secondary/85 px-2 text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <PanelLeftOpen size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="text-[11px] font-medium tabular-nums" aria-hidden="true">
              {filteredNodes.length}
            </span>
          </button>
        )}

        {/*
          Read-only document panel (§4.4.2 branch two). Wide windows keep the
          380px side sheet; under 768px it becomes a bottom sheet, otherwise it
          would sit on top of the overlay panel and both would clip their text.

          Same hit-path split as the overlay: the sheet itself is
          `pointer-events-none`, its three rows are `pointer-events-auto`. What
          stays click-through is the sheet's border and rounding, so a node that
          peeks out at the very edge is still clickable. The 380xN content area
          is deliberately not transparent — the text has to stay selectable and
          its links clickable.
        */}
        {selectedNode && (
          <aside
            className="pointer-events-none absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-[380px] flex-col overflow-hidden rounded-xl border border-border bg-bg-secondary/90 max-md:inset-x-3 max-md:bottom-3 max-md:top-auto max-md:max-h-[45%] max-md:w-auto"
            aria-label={selectedNode.title}
          >
            <header className="pointer-events-auto flex flex-shrink-0 items-start gap-2 border-b border-border/60 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold leading-5 text-text-primary">{selectedNode.title}</h2>
                <p className="truncate text-[11px] text-text-muted">
                  {selectedNode.kind === "dangling"
                    ? t(lang, "graphDanglingNode")
                    : selectedNode.kind === "native"
                      ? t(lang, "notepad")
                      : selectedNode.path ?? ""}
                </p>
              </div>
              {selectedNode.kind === "native" && (
                <button
                  type="button"
                  onClick={() => activateNode(selectedNode.id)}
                  /*
                   * The only way a touch user can open a native note from here
                   * (the row's double-click is not reachable on a finger), so:
                   * `flex-shrink-0` and a colour that stays readable on hover —
                   * accent-text on bg-hover is 4.47:1 in the dark theme, hence
                   * the hover override to text-primary.
                   */
                  className="flex-shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-accent-text transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary"
                >
                  {t(lang, "graphOpenInEditor")}
                </button>
              )}
              {/*
                Close, not "go back": the same two calls as the Escape branch in
                `handleCanvasKeyDown`, so a mouse user has the affordance the
                keyboard already had. Reuses the existing `close` key — a new
                i18n key would collide with the parallel session editing
                `i18n.ts`.
              */}
              <button
                type="button"
                onClick={() => {
                  setSelection(null);
                  rendererRef.current?.setSelection(null);
                }}
                aria-label={t(lang, "close")}
                title={t(lang, "close")}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </header>

            <div className="pointer-events-auto min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-2.5">
              {selectedNode.parseError ? (
                <p className="mb-2 border-l-2 border-warning bg-bg-primary/40 px-2 py-1 text-xs text-text-primary">
                  {t(lang, "graphParseError")}
                  {": "}
                  {selectedNode.parseError}
                </p>
              ) : null}

              {selectedNode.kind === "vault" || selectedNode.kind === "native" ? (
                documentState?.nodeId === selectedNode.id ? (
                  documentState.loading ? (
                    <p className="text-xs text-text-muted">{t(lang, "loading")}</p>
                  ) : documentState.html !== null ? (
                    <div
                      className="markdown-preview prose max-w-none text-sm"
                      dangerouslySetInnerHTML={{ __html: documentState.html }}
                    />
                  ) : (
                    <p className="text-xs text-text-muted">
                      {t(lang, "graphUnreadable")}
                      {documentState.error ? `: ${documentState.error}` : ""}
                    </p>
                  )
                ) : (
                  <p className="text-xs text-text-muted">{t(lang, "loading")}</p>
                )
              ) : selectedNode.kind === "dangling" ? (
                <p className="text-xs text-text-muted">
                  {(() => {
                    const ambiguous = snapshot?.dangling.find(
                      (item) => item.id === selectedNode.id && item.candidateCount > 1,
                    );
                    return ambiguous
                      ? tWithParams(lang, "graphDanglingAmbiguous", { count: ambiguous.candidateCount })
                      : t(lang, "graphDanglingNode");
                  })()}
                </p>
              ) : (
                <p className="text-xs text-text-muted">
                  {selectedNode.path ?? t(lang, "graphNoSelection")}
                </p>
              )}
            </div>

            <div className="pointer-events-auto flex-shrink-0 border-t border-border/60 px-2.5 py-2">
              <h3 className="mb-1 text-[11px] font-medium leading-4 text-text-muted">
                {t(lang, "graphBacklinks")}
                <span className="ml-1 tabular-nums">{backlinks.length}</span>
              </h3>
              {backlinks.length === 0 ? (
                <p className="text-[11px] text-text-muted">{t(lang, "graphNoBacklinks")}</p>
              ) : (
                <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain max-md:max-h-24">
                  {backlinks.map(({ node, references }) => (
                    <li key={node.id}>
                      <button
                        type="button"
                        onClick={() => handleSelect(node.id)}
                        onDoubleClick={() => activateNode(node.id)}
                        className="w-full rounded-md px-1.5 py-1 text-left text-[11px] text-text-primary hover:bg-bg-hover"
                      >
                        <span className="block truncate">{node.title}</span>
                        {references.map((reference) => (
                          <span
                            key={`${node.id}-${reference.line}`}
                            className="block truncate text-text-muted"
                          >
                            {"#"}
                            {reference.line} {reference.raw}
                          </span>
                        ))}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}

        {/* Screen-reader announcement for selection changes (§4.5.3). */}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
    </div>
  );
};

const GraphPage: React.FC<GraphPageProps> = (props) => {
  const lang = useSettingsStore((state) => state.lang);
  return (
    <PanelErrorBoundary lang={lang}>
      <GraphPageInner {...props} />
    </PanelErrorBoundary>
  );
};

export default GraphPage;
