import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { MouseEvent, PointerEvent } from "react";
import { animate, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, FileText, Pin, X } from "lucide-react";
import { useNoteStore } from "@/stores/noteStore";
import { useTabStore } from "@/stores/tabStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

interface TabContextMenuState {
  noteId: string;
  x: number;
  y: number;
}

interface NoteTabBarProps {
  /**
   * Export a specific note. The tab menu passes the right-clicked tab's id, so
   * exporting never silently falls back to whichever tab happens to be active.
   */
  onExportNote?: (noteId: string) => void;
}

const TAB_MIN_WIDTH = 96;
const TAB_MAX_WIDTH = 208;

/** Neighbours slide into the slot the pointer just left — softer than a snap. */
const FLOW_SPRING = { type: "spring", stiffness: 380, damping: 36, mass: 0.9 } as const;
/** The dragged tab settles into its final slot on release. */
const SETTLE_SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 } as const;

/**
 * Current horizontal offset of an element's transform, in px.
 *
 * Read from the computed matrix rather than `style.transform` because motion
 * writes whatever form it likes; the layout position of an element is then
 * `rect.left - readTranslateX(element)`, which stays correct even while a
 * previous FLIP spring is still in flight.
 */
const readTranslateX = (element: HTMLElement) => {
  const value = getComputedStyle(element).transform;
  if (!value || value === "none") return 0;
  try {
    return new DOMMatrixReadOnly(value).m41;
  } catch {
    return 0;
  }
};

/**
 * Browser-style tab strip for open notes.
 *
 * Interaction contract (see docs/decisions-note-tabs.md):
 * - single click in the sidebar opens a preview tab that the next single click replaces
 * - double click, or the context menu, pins it
 * - the close affordance turns into an unsaved dot while the note is dirty
 *
 * Dragging re-orders live: the moment the pointer carries a tab past the midpoint
 * of its neighbour, the two swap places in the rendered order and the neighbours
 * spring into the vacated slot. The strip therefore never shows an empty gap —
 * the dragged tab always occupies the slot it would land in.
 */
const NoteTabBar = ({ onExportNote }: NoteTabBarProps) => {
  const lang = useSettingsStore((s) => s.lang);
  const notes = useNoteStore((s) => s.notes);
  const activeNoteId = useNoteStore((s) => s.activeNoteId);
  const setActiveNoteId = useNoteStore((s) => s.setActiveNoteId);
  const tabs = useTabStore((s) => s.tabs);
  const dirtyIds = useTabStore((s) => s.dirtyIds);
  const pinTab = useTabStore((s) => s.pinTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const closeOtherTabs = useTabStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useTabStore((s) => s.closeTabsToRight);
  const closeAllTabs = useTabStore((s) => s.closeAllTabs);
  const moveTabToIndex = useTabStore((s) => s.moveTabToIndex);

  const stripRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabContextMenuState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  /**
   * Tab order *while dragging*. The store is only written on release, so an
   * aborted drag needs nothing but dropping this override.
   */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });
  const reduceMotion = useReducedMotion();

  /** Live pointer drag bookkeeping; `moved` gates the 4px click/drag split. */
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  /** Pointer x minus the dragged tab's layout left, fixed for the whole drag. */
  const grabOffsetRef = useRef(0);
  /**
   * Slot geometry sampled once at drag start: every tab in the strip has the
   * same flex basis and the same min/max width, so slot i sits at
   * `slotLeft + i * pitch`. Modelling the row lets the pointer be resolved
   * against the *final* layout instead of reading DOM rects that are currently
   * mid-spring (which would make the index oscillate).
   */
  const slotGeometryRef = useRef<{ slotLeft: number; pitch: number; scrollLeft: number } | null>(
    null,
  );
  const dragOffsetRef = useRef(0);
  const lastPointerXRef = useRef<number | null>(null);
  /** Set once the resolve/slide pipeline exists; the autoscroll loop reads it. */
  const syncDragToRef = useRef<(pointerX: number) => void>(() => {});
  /** Window-level pointer plumbing, live only while a press is in flight. */
  const dragListenersRef = useRef<{
    move: (event: globalThis.PointerEvent) => void;
    up: (event: globalThis.PointerEvent) => void;
    cancel: (event: globalThis.PointerEvent) => void;
  } | null>(null);
  const onDragMoveRef = useRef<(event: globalThis.PointerEvent) => void>(() => {});
  const onDragEndRef = useRef<(event: globalThis.PointerEvent, cancelled: boolean) => void>(
    () => {},
  );
  const flipControlsRef = useRef(new Map<string, { stop: () => void }>());
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  // A completed drag still emits a click on whatever the pointer ends over,
  // which would activate an unrelated tab. Clicks are swallowed for a short
  // window after each real drag instead of a single bool, so a later unrelated
  // click is never eaten.
  const suppressClickUntilRef = useRef(0);
  const autoScrollRef = useRef<number | null>(null);
  const autoScrollDirRef = useRef(0);

  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => noteById.has(tab.id)),
    [tabs, noteById],
  );

  /** Render order: the live drag override when present, the store order otherwise. */
  const orderedTabs = useMemo(() => {
    if (!dragOrder) return visibleTabs;
    const pending = new Map(visibleTabs.map((tab) => [tab.id, tab]));
    const ordered: typeof visibleTabs = [];
    for (const id of dragOrder) {
      const tab = pending.get(id);
      if (!tab) continue;
      ordered.push(tab);
      pending.delete(id);
    }
    // A tab opened mid-drag still has to render, just at the end.
    for (const tab of pending.values()) ordered.push(tab);
    return ordered.length === visibleTabs.length ? ordered : visibleTabs;
  }, [dragOrder, visibleTabs]);

  const getTitle = (noteId: string) => {
    const title = noteById.get(noteId)?.title.trim();
    return title || t(lang, "untitled");
  };

  // Keep the active tab inside the visible part of the strip without moving
  // the whole window: only the strip scrolls.
  useEffect(() => {
    if (!activeNoteId) return;
    const element = stripRef.current?.querySelector<HTMLElement>(
      `[data-note-tab="${CSS.escape(activeNoteId)}"]`,
    );
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeNoteId, visibleTabs.length]);

  // A plain wheel over the strip would do nothing: Chromium never maps vertical
  // wheel deltas onto a horizontally scrolling container, and the scrollbar is
  // hidden to keep the 36px bar clean. Map the wheel manually so the usual
  // gesture works, and let the chevrons cover trackpads and mice without one.
  useEffect(() => {
    const element = stripRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      event.preventDefault();
      element.scrollLeft += delta;
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  const syncScrollEdges = useCallback(() => {
    const element = stripRef.current;
    if (!element) return;
    const max = element.scrollWidth - element.clientWidth;
    const next = { left: element.scrollLeft > 1, right: element.scrollLeft < max - 1 };
    setCanScroll((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);

  // Re-measure on resize, on scroll and whenever the tab count changes.
  useEffect(() => {
    const element = stripRef.current;
    if (!element) return;
    syncScrollEdges();
    const observer = new ResizeObserver(syncScrollEdges);
    observer.observe(element);
    element.addEventListener("scroll", syncScrollEdges, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", syncScrollEdges);
    };
  }, [syncScrollEdges, visibleTabs.length]);

  const nudgeStrip = (direction: -1 | 1) => {
    const element = stripRef.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(160, element.clientWidth * 0.6),
      behavior: "smooth",
    });
  };

  // Dismiss the context menu on any outside interaction, scroll, Escape or the
  // close shortcut. Ctrl+W while the menu is open only dismisses it: the menu is
  // marked as a shortcut blocker, so the tab survives one keystroke.
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCloseShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key.toLowerCase() === "w" || event.code === "KeyW");
      if (event.key === "Escape" || isCloseShortcut) setMenu(null);
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu]);

  const handleContextMenu = useCallback((event: MouseEvent, noteId: string) => {
    event.preventDefault();
    event.stopPropagation();
    // Keep the menu inside the viewport when the tab strip is scrolled far right.
    const menuWidth = 176;
    const menuHeight = 252;
    setMenu({
      noteId,
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
    });
  }, []);

  const stopAutoScroll = useCallback(() => {
    autoScrollDirRef.current = 0;
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);

  const startAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) return;
    const step = () => {
      const element = stripRef.current;
      const direction = autoScrollDirRef.current;
      if (!element || direction === 0) {
        autoScrollRef.current = null;
        return;
      }
      element.scrollLeft += direction * 8;
      // The row moved under a stationary pointer, so the slot under the cursor
      // has changed: re-resolve before the next frame paints.
      const pointerX = lastPointerXRef.current;
      if (pointerX !== null) syncDragToRef.current(pointerX);
      autoScrollRef.current = requestAnimationFrame(step);
    };
    autoScrollRef.current = requestAnimationFrame(step);
  }, []);

  /** Layout left of every tab except the dragged one (its own transform is live). */
  const collectTabLefts = useCallback((draggedId: string) => {
    const map = new Map<string, number>();
    stripRef.current?.querySelectorAll<HTMLElement>("[data-note-tab]").forEach((element) => {
      const id = element.dataset.noteTab;
      if (!id || id === draggedId) return;
      map.set(id, element.getBoundingClientRect().left - readTranslateX(element));
    });
    return map;
  }, []);

  /**
   * FLIP for the tabs that stay put: put each one back on the spot it occupied
   * before the swap, then let it spring home. Measuring `rect - transform`
   * keeps the deltas exact when a previous spring is still running, so rapid
   * crossings never produce a jump.
   */
  const slideTabs = useCallback((previous: Map<string, number>, draggedId: string) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.querySelectorAll<HTMLElement>("[data-note-tab]").forEach((element) => {
      const id = element.dataset.noteTab;
      if (!id || id === draggedId) return;
      const before = previous.get(id);
      if (typeof before !== "number") return;
      const delta = before - (element.getBoundingClientRect().left - readTranslateX(element));
      if (Math.abs(delta) < 0.5) return;

      flipControlsRef.current.get(id)?.stop();
      flipControlsRef.current.delete(id);

      if (reduceMotionRef.current) {
        element.style.transform = "";
        return;
      }
      // The 150ms tailwind transform transition would smooth every spring frame
      // into mush; own the property while the spring runs, then hand it back.
      element.style.transition = "none";
      const controls = animate(element, { x: [delta, 0] }, FLOW_SPRING);
      flipControlsRef.current.set(id, controls);
      // Hand the element back to CSS once the spring settles, so hover
      // transforms and theme transitions keep working.
      void Promise.resolve(controls)
        .then(() => {
          if (flipControlsRef.current.get(id) !== controls) return;
          flipControlsRef.current.delete(id);
          element.style.transform = "";
          element.style.transition = "";
        })
        .catch(() => {});
    });
  }, []);

  /**
   * Slot index for the dragged tab's left edge. Solved against the sampled row
   * model rather than live rects, so the answer does not depend on how far the
   * neighbours' springs have travelled.
   */
  const resolveSlotIndex = useCallback((desiredLeft: number) => {
    const geometry = slotGeometryRef.current;
    const order = dragOrderRef.current;
    if (!geometry || !order || order.length === 0) return 0;
    const scrolled = stripRef.current
      ? stripRef.current.scrollLeft - geometry.scrollLeft
      : 0;
    const slot = Math.round((desiredLeft - (geometry.slotLeft - scrolled)) / geometry.pitch);
    return Math.max(0, Math.min(order.length - 1, slot));
  }, []);

  /** Swap the dragged tab into `index` without touching the store. */
  const reorderLive = useCallback(
    (index: number) => {
      const order = dragOrderRef.current;
      const draggedId = dragRef.current?.id;
      if (!order || !draggedId) return;
      const current = order.indexOf(draggedId);
      if (current < 0 || current === index) return;
      const next = [...order];
      next.splice(current, 1);
      next.splice(index, 0, draggedId);
      dragOrderRef.current = next;
      const previous = collectTabLefts(draggedId);
      // The neighbours must be measured against the pre-swap layout, so the
      // order change has to land before they are animated.
      flushSync(() => setDragOrder(next));
      slideTabs(previous, draggedId);
    },
    [collectTabLefts, slideTabs],
  );

  /**
   * One frame of pointer tracking: re-order if the pointer crossed a midpoint,
   * then pin the dragged tab to the pointer. Its transform is expressed against
   * its own (moving) slot, which is what keeps the row gapless.
   *
   * The visual left edge is clamped to the first/last slot: the tab may lag
   * behind the pointer once the pointer leaves the row, but it can never drift
   * out of the strip and leave its own slot looking empty.
   */
  const syncDragTo = useCallback(
    (pointerX: number) => {
      const geometry = slotGeometryRef.current;
      const order = dragOrderRef.current;
      if (!geometry || !order) return;
      const desiredLeft = pointerX - grabOffsetRef.current;
      const index = resolveSlotIndex(desiredLeft);
      reorderLive(index);
      const scrolled = stripRef.current
        ? stripRef.current.scrollLeft - geometry.scrollLeft
        : 0;
      const base = geometry.slotLeft - scrolled;
      const minLeft = base;
      const maxLeft = base + Math.max(0, order.length - 1) * geometry.pitch;
      const visualLeft = Math.min(Math.max(desiredLeft, minLeft), maxLeft);
      const offset = visualLeft - (base + index * geometry.pitch);
      dragOffsetRef.current = offset;
      setDragOffset(offset);
    },
    [reorderLive, resolveSlotIndex],
  );
  syncDragToRef.current = syncDragTo;

  /** Sample the row once: where slot 0 sits, and how far apart slots are. */
  const beginDrag = useCallback((draggedId: string, startPointerX: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    const elements = Array.from(strip.querySelectorAll<HTMLElement>("[data-note-tab]"));
    const order = elements
      .map((element) => element.dataset.noteTab)
      .filter((id): id is string => Boolean(id));
    if (elements.length === 0 || order.length === 0) return;

    const layoutLeft = (element: HTMLElement) =>
      element.getBoundingClientRect().left - readTranslateX(element);
    const slotLeft = layoutLeft(elements[0]);
    const pitch = elements[1]
      ? layoutLeft(elements[1]) - slotLeft
      : elements[0].getBoundingClientRect().width + 4;
    const draggedElement = elements.find((element) => element.dataset.noteTab === draggedId);
    if (!draggedElement) return;

    slotGeometryRef.current = {
      slotLeft,
      pitch: pitch > 1 ? pitch : elements[0].getBoundingClientRect().width + 4,
      scrollLeft: strip.scrollLeft,
    };
    // Anchored to the press position, never to the first move: a fast flick can
    // deliver its first pointermove tens of pixels away, and anchoring there
    // would shift the tab off the pointer for the whole drag.
    grabOffsetRef.current = startPointerX - layoutLeft(draggedElement);
    dragOrderRef.current = order;
    dragOffsetRef.current = 0;
    // The pointer sweeps across the editor while the button is held; without
    // this a drag would text-select whatever it passes over.
    document.body.style.userSelect = "none";
    flushSync(() => {
      setDragId(draggedId);
      setDragOrder(order);
      setDragOffset(0);
    });
  }, []);

  const clearDragState = useCallback(() => {
    dragOrderRef.current = null;
    slotGeometryRef.current = null;
    lastPointerXRef.current = null;
    dragOffsetRef.current = 0;
    document.body.style.userSelect = "";
    flushSync(() => {
      setDragOrder(null);
      setDragId(null);
      setDragOffset(0);
    });
  }, []);

  const detachDragListeners = useCallback(() => {
    const listeners = dragListenersRef.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    window.removeEventListener("pointercancel", listeners.cancel);
    dragListenersRef.current = null;
  }, []);

  const attachDragListeners = useCallback(() => {
    detachDragListeners();
    const listeners = {
      move: (event: globalThis.PointerEvent) => onDragMoveRef.current(event),
      up: (event: globalThis.PointerEvent) => onDragEndRef.current(event, false),
      cancel: (event: globalThis.PointerEvent) => onDragEndRef.current(event, true),
    };
    dragListenersRef.current = listeners;
    window.addEventListener("pointermove", listeners.move);
    window.addEventListener("pointerup", listeners.up);
    window.addEventListener("pointercancel", listeners.cancel);
  }, [detachDragListeners]);

  const finishDrag = useCallback(
    (event: { clientX: number; clientY: number; pointerId: number }, cancelled: boolean) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      stopAutoScroll();
      detachDragListeners();
      // A press that never crossed the threshold is a click, not a drag.
      if (!drag.moved) {
        if (dragOrderRef.current) clearDragState();
        return;
      }
      suppressClickUntilRef.current = performance.now() + 350;

      const element = stripRef.current?.querySelector<HTMLElement>(
        `[data-note-tab="${CSS.escape(drag.id)}"]`,
      );
      const settleFrom = dragOffsetRef.current;
      const index = dragOrderRef.current?.indexOf(drag.id) ?? -1;
      // Released clear of the strip (e.g. over the editor) — treat it as a
      // cancel and let the row fall back into its original order.
      const bounds = stripRef.current?.getBoundingClientRect();
      const leftStrip = cancelled
        || !bounds
        || event.clientY < bounds.top - 28
        || event.clientY > bounds.bottom + 28;

      // The store write and the drop of the visual override must land in the
      // same paint, otherwise the strip would flicker back to the old order.
      if (!leftStrip && index >= 0) {
        flushSync(() => moveTabToIndex(drag.id, index));
      }
      clearDragState();

      // Release the tab from the pointer with a spring instead of a snap.
      if (!element) return;
      if (leftStrip || reduceMotionRef.current || Math.abs(settleFrom) < 0.5) {
        element.style.transform = "";
        element.style.transition = "";
        return;
      }
      element.style.transition = "none";
      const controls = animate(element, { x: [settleFrom, 0] }, SETTLE_SPRING);
      void Promise.resolve(controls)
        .then(() => {
          element.style.transform = "";
          element.style.transition = "";
        })
        .catch(() => {});
    },
    [clearDragState, detachDragListeners, moveTabToIndex, stopAutoScroll],
  );

  /**
   * Move handler. Bound to `window`, not to the tab: re-ordering moves the
   * dragged node in the DOM, which makes Chromium drop its pointer capture, so
   * a tab-bound drag would go dead as soon as the row shifted under it.
   */
  const handleDragMove = useCallback((event: globalThis.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      // Below the threshold this is still a click, not a drag.
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (moved < 4) return;
      drag.moved = true;
      beginDrag(drag.id, drag.startX);
    }
    lastPointerXRef.current = event.clientX;
    syncDragTo(event.clientX);

    const strip = stripRef.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth) {
      stopAutoScroll();
      return;
    }
    const bounds = strip.getBoundingClientRect();
    const direction = event.clientX < bounds.left + 24
      ? -1
      : event.clientX > bounds.right - 24
        ? 1
        : 0;
    autoScrollDirRef.current = direction;
    if (direction === 0) stopAutoScroll();
    else startAutoScroll();
  }, [beginDrag, startAutoScroll, stopAutoScroll, syncDragTo]);

  onDragMoveRef.current = handleDragMove;
  onDragEndRef.current = finishDrag;

  const handleTabPointerDown = useCallback((event: PointerEvent<HTMLDivElement>, tabId: string) => {
    if (event.button !== 0) return;
    suppressClickUntilRef.current = 0;
    dragRef.current = {
      id: tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    attachDragListeners();
  }, [attachDragListeners]);

  // Escape aborts an in-flight drag and leaves the strip untouched.
  useEffect(() => {
    if (!dragId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dragRef.current = null;
      stopAutoScroll();
      detachDragListeners();
      suppressClickUntilRef.current = performance.now() + 350;
      stripRef.current?.querySelectorAll<HTMLElement>("[data-note-tab]").forEach((element) => {
        element.style.transform = "";
      });
      flipControlsRef.current.forEach((controls) => controls.stop());
      flipControlsRef.current.clear();
      // The store was never written, so dropping the override restores the
      // original order with no undo step.
      clearDragState();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dragId, clearDragState, detachDragListeners, stopAutoScroll]);

  useEffect(() => () => {
    if (autoScrollRef.current !== null) cancelAnimationFrame(autoScrollRef.current);
    detachDragListeners();
    document.body.style.userSelect = "";
  }, [detachDragListeners]);

  // The dragged tab always sits in the slot it would land in, so the row itself
  // is the drop indicator — there is no separate insertion line any more.
  if (visibleTabs.length === 0) return null;

  const menuIndex = menu ? visibleTabs.findIndex((tab) => tab.id === menu.noteId) : -1;
  const menuTab = menuIndex >= 0 ? visibleTabs[menuIndex] : null;

  const menuItemClass =
    "flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div
      className="note-tab-bar relative flex h-9 flex-shrink-0 items-stretch border-b border-border"
      role="tablist"
      aria-label={t(lang, "noteTabs")}
    >
      <div
        ref={stripRef}
        className={`note-tab-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden px-1.5 ${
          dragId ? "is-dragging" : ""
        }`}
      >
        {orderedTabs.map((tab) => {
          const active = tab.id === activeNoteId;
          const dirty = dirtyIds.includes(tab.id);
          const dragging = dragId === tab.id;
          return (
            <div
              key={tab.id}
              data-note-tab={tab.id}
              role="tab"
              aria-selected={active}
              onClick={(event) => {
                if (performance.now() < suppressClickUntilRef.current) {
                  suppressClickUntilRef.current = 0;
                  event.preventDefault();
                  return;
                }
                setActiveNoteId(tab.id);
              }}
              onDoubleClick={() => pinTab(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeTab(tab.id);
                }
              }}
              onContextMenu={(event) => handleContextMenu(event, tab.id)}
              onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
              title={tab.preview ? t(lang, "previewTabHint") : getTitle(tab.id)}
              style={{
                flex: `1 1 ${TAB_MAX_WIDTH}px`,
                minWidth: TAB_MIN_WIDTH,
                maxWidth: TAB_MAX_WIDTH,
                ...(dragging
                  ? {
                    transform: `translateX(${dragOffset}px) scale(1.02)`,
                    transition: "none",
                    zIndex: 20,
                    boxShadow: "0 6px 16px rgb(0 0 0 / 22%)",
                  }
                  : null),
              }}
              className={`group relative flex h-7 select-none items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-[background-color,color,box-shadow,transform] duration-150 ease-out ${
                dragging ? "cursor-grabbing" : "cursor-pointer"
              } ${
                active
                  ? "bg-bg-primary text-text-primary shadow-sm ring-1 ring-border/70"
                  : "text-text-muted hover:-translate-y-px hover:bg-bg-hover hover:text-text-secondary hover:shadow-sm hover:ring-1 hover:ring-border/50"
              }`}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1/2 top-0 h-[2px] w-6 -translate-x-1/2 rounded-full bg-accent"
                />
              )}
              <span
                className={`flex-shrink-0 transition-opacity duration-150 ${
                  active ? "text-accent-text opacity-100" : "opacity-60 group-hover:opacity-100"
                }`}
              >
                {tab.preview ? <FileText size={13} strokeWidth={1.8} /> : <Pin size={12} strokeWidth={1.8} />}
              </span>
              <span className={`min-w-0 flex-1 truncate ${tab.preview ? "italic" : ""}`}>
                {getTitle(tab.id)}
              </span>
              <button
                type="button"
                aria-label={`${dirty ? t(lang, "unsaved") : t(lang, "closeTab")} (Ctrl+W)`}
                title={`${dirty ? t(lang, "unsaved") : t(lang, "closeTab")} (Ctrl+W)`}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-bg-active hover:text-text-primary"
              >
                {dirty ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-amber-500 group-hover:hidden" aria-hidden="true" />
                    <X size={13} className="hidden group-hover:block" />
                  </>
                ) : (
                  <X
                    size={13}
                    className={active ? "opacity-80" : "opacity-0 group-hover:opacity-80"}
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {canScroll.left && (
        <button
          type="button"
          aria-label={t(lang, "scrollTabsLeft")}
          title={t(lang, "scrollTabsLeft")}
          onClick={() => nudgeStrip(-1)}
          className="absolute inset-y-0 left-0 z-10 flex w-6 items-center justify-center bg-gradient-to-r from-bg-primary/80 via-bg-primary/60 to-transparent text-text-muted transition-colors hover:text-text-primary"
        >
          <ChevronLeft size={14} strokeWidth={2.2} />
        </button>
      )}
      {canScroll.right && (
        <button
          type="button"
          aria-label={t(lang, "scrollTabsRight")}
          title={t(lang, "scrollTabsRight")}
          onClick={() => nudgeStrip(1)}
          className="absolute inset-y-0 right-0 z-10 flex w-6 items-center justify-center bg-gradient-to-l from-bg-primary/80 via-bg-primary/60 to-transparent text-text-muted transition-colors hover:text-text-primary"
        >
          <ChevronRight size={14} strokeWidth={2.2} />
        </button>
      )}

      {menu && menuTab && (
        <div
          className="fixed z-50 w-44 rounded-lg border border-border bg-bg-secondary p-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          data-shortcut-blocker="note-tab-menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {onExportNote && (
            <>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  onExportNote(menuTab.id);
                  setMenu(null);
                }}
              >
                {t(lang, "exportFile")}
              </button>
              <div className="my-1 h-px bg-border" aria-hidden="true" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              closeTab(menuTab.id);
              setMenu(null);
            }}
          >
            {t(lang, "closeTab")}
            <kbd className="text-[10px] font-normal text-text-muted">Ctrl+W</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              closeOtherTabs(menuTab.id);
              setMenu(null);
            }}
          >
            {t(lang, "closeOtherTabs")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={menuIndex === visibleTabs.length - 1}
            className={menuItemClass}
            onClick={() => {
              closeTabsToRight(menuTab.id);
              setMenu(null);
            }}
          >
            {t(lang, "closeTabsToRight")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              closeAllTabs();
              setMenu(null);
            }}
          >
            {t(lang, "closeAllTabs")}
          </button>
          {menuTab.preview && (
            <>
              <div className="my-1 h-px bg-border" aria-hidden="true" />
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  pinTab(menuTab.id);
                  setMenu(null);
                }}
              >
                {t(lang, "pinTab")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default NoteTabBar;
