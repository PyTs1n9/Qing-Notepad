/**
 * Keyboard-reachable node list (§4.5.3).
 *
 * A page that is only a canvas is unusable for keyboard and screen-reader users,
 * and this is the cheap fix: the data is already in `GraphSnapshot`, so the list
 * costs one `.map` and a virtual window. It also doubles as the search result
 * surface: typing narrows the list, Enter jumps.
 *
 * 5000 rows are never mounted. The window is derived from `scrollTop` and a
 * fixed row height, which is why the row must stay on one line (`truncate`).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode } from "@/types/graph";
import type { LangType } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

/**
 * Fixed, so `scrollTop` maps to an index without measuring anything.
 *
 * `ROW_HEIGHT` is the *slot*, not the row: the row itself is
 * `ROW_HEIGHT - ROW_GAP` (28px) and is inset by half the gap, so consecutive
 * pills have air between them and a hover block never touches its neighbour.
 * The slot height is the one number the virtual window depends on — it, the
 * inline `top`/`height`, and the container's `maxHeight` (8 slots) move
 * together. Do not raise the row back to the slot height: the pills would fuse.
 */
const ROW_HEIGHT = 32;
const ROW_GAP = 4;
const OVERSCAN = 6;

export interface NodeListPanelProps {
  nodes: readonly GraphNode[];
  selectedId: string | null;
  query: string;
  lang: LangType;
  onQueryChange: (value: string) => void;
  onSelect: (nodeId: string) => void;
  onActivate: (nodeId: string) => void;
  /**
   * `false` when the toolbar above already owns the search box: two inputs bound
   * to one query state would be one input too many (and two tab stops for the
   * same control).
   */
  showSearch?: boolean;
}

const NodeListPanel: React.FC<NodeListPanelProps> = ({
  nodes,
  selectedId,
  query,
  lang,
  onQueryChange,
  onSelect,
  onActivate,
  showSearch = true,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(220);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const selectedIndex = useMemo(
    () => (selectedId === null ? -1 : nodes.findIndex((node) => node.id === selectedId)),
    [nodes, selectedId],
  );

  // Keep the selected row inside the window when selection changes from outside
  // (click on the canvas, search jump).
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
    setScrollTop(element.scrollTop);
  }, [selectedIndex]);

  /*
   * Hand focus back when the list empties itself.
   *
   * The container drops `role="listbox"` and `tabIndex` at zero results (an
   * empty listbox is a trap: Tab lands on it, the screen reader announces
   * "list, 0 items" and there is no way out). But removing `tabIndex` does not
   * blur, it only strands focus on what is now a plain div — invisible to the
   * keyboard and silent to the reader. So the migration is explicit.
   *
   * Deliberately conditional on `document.activeElement`: the common way to
   * reach zero results is to keep clicking the filter switches, and grabbing
   * focus on every one of those clicks would be worse than the trap. On first
   * mount focus is never inside the list, so this is a no-op there.
   *
   * The destination is the component's own search input when it has one, else
   * the toolbar's: this page passes `showSearch={false}`, so `#graph-node-search`
   * does not exist here and the chain falls through to `#graph-search`. Written
   * as a chain rather than a single id so the component does not bake one page's
   * assumption into a reusable panel.
   *
   * Both guards are load-bearing, and the order matters.
   * `nodes.length > 0` is not redundant with the `activeElement` check: the
   * snapshot on this page is push-based, so a background vault sync can change
   * the node count while the user is sitting in the list. Without it, that push
   * re-runs this effect and yanks focus to the search box with no user action —
   * the kind of bug that is nearly impossible to reproduce. Only when the list
   * is genuinely empty is there no valid focus target inside it.
   */
  useEffect(() => {
    if (nodes.length > 0) return;
    if (scrollRef.current !== document.activeElement) return;
    (document.getElementById("graph-node-search") ?? document.getElementById("graph-search"))?.focus();
  }, [nodes.length]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(nodes.length, first + visibleCount);
  const slice = nodes.slice(first, last);

  const move = useCallback(
    (delta: number) => {
      if (nodes.length === 0) return;
      const current = selectedIndex < 0 ? (delta > 0 ? -1 : nodes.length) : selectedIndex;
      const next = Math.min(nodes.length - 1, Math.max(0, current + delta));
      onSelect(nodes[next].id);
    },
    [nodes, onSelect, selectedIndex],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (nodes.length > 0) onSelect(nodes[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      if (nodes.length > 0) onSelect(nodes[nodes.length - 1].id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedId !== null) onActivate(selectedId);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showSearch && (
        <>
          <label className="sr-only" htmlFor="graph-node-search">
            {t(lang, "graphSearchPlaceholder")}
          </label>
          <input
            id="graph-node-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t(lang, "graphSearchPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="mb-1 w-full rounded-md bg-bg-primary/50 px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </>
      )}
      {/*
        Sibling of the scroll container, not a child — three reasons: the scroll
        area keeps `option`-only children at any count, the block can never be
        clipped or scrolled by `overflow-y-auto`, and the container stays mounted
        so the effect above can still read `scrollRef.current`. ARIA validity is
        *not* a reason: `role` is conditional, so a `role="status"` child was
        legal anyway.
        `min-h-32` + a centred shell, not padding: 128px of empty state reads as
        "the list is empty", not "one line with no siblings".
      */}
      {nodes.length === 0 && (
        <div className="flex min-h-32 items-center justify-center px-3">
          <p role="status" className="py-6 text-center text-[11px] leading-4 text-text-muted">
            {t(lang, "graphSearchNoResult")}
          </p>
        </div>
      )}
      {/*
        The container stays mounted even when empty — the focus-migration effect
        above compares `scrollRef.current` with `document.activeElement`, and
        unmounting it would make that comparison permanently false.

        `role` / `tabIndex` / `aria-activedescendant` are conditional: at zero
        results this is not a listbox, and pretending it is produces a tab stop
        that announces "list, 0 items" with nothing inside and no way forward.
        Three ternaries rather than a spread because `role` is a literal union in
        TS and a spread object widens it to `string`.
      */}
      <div
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={handleKeyDown}
        tabIndex={nodes.length > 0 ? 0 : undefined}
        role={nodes.length > 0 ? "listbox" : undefined}
        aria-label={t(lang, "graphNodeList")}
        aria-activedescendant={
          nodes.length > 0 && selectedId ? `graph-node-${selectedId}` : undefined
        }
        className="-mx-1 min-h-0 flex-1 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        style={{ maxHeight: 256 }}
      >
        {nodes.length > 0 && (
          <div className="relative" style={{ height: nodes.length * ROW_HEIGHT }}>
            {slice.map((node, offset) => {
              const index = first + offset;
              const selected = node.id === selectedId;
              /*
               * One element per row: `role="option"` and the click handlers sit
               * on the element whose geometry is the row, so the hit area and
               * the a11y node can never drift apart. The pill look comes from
               * `inset-x-1` + the slot height minus the gap — not from a nested
               * box, and not from `px-1` on a full-bleed wrapper.
               */
              return (
                <div
                  key={node.id}
                  id={`graph-node-${node.id}`}
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  onClick={() => onSelect(node.id)}
                  onDoubleClick={() => onActivate(node.id)}
                  style={{ top: index * ROW_HEIGHT + ROW_GAP / 2, height: ROW_HEIGHT - ROW_GAP }}
                  className={`absolute inset-x-1 flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 text-xs transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
                    selected
                      ? "bg-bg-active text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                      node.kind === "dangling"
                        ? "border border-warning bg-transparent"
                        : node.kind === "native"
                          ? "bg-accent"
                          : "bg-text-secondary"
                    }`}
                  />
                  <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : ""}`}>
                    {node.title}
                  </span>
                  {node.path && node.path !== node.title ? (
                    <span className="ml-auto max-w-[45%] flex-shrink-0 truncate text-right text-[11px] text-text-muted">
                      {node.path}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default NodeListPanel;
