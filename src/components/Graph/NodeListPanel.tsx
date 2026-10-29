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

/** Fixed, so `scrollTop` maps to an index without measuring anything. */
const ROW_HEIGHT = 28;
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
    <div className="flex min-h-0 flex-col">
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
            className="mb-1 w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </>
      )}
      <div
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="listbox"
        aria-label={t(lang, "graphNodeList")}
        aria-activedescendant={selectedId ? `graph-node-${selectedId}` : undefined}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-bg-primary/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        style={{ maxHeight: 240 }}
      >
        {nodes.length === 0 ? (
          <p className="px-2 py-3 text-xs text-text-muted">{t(lang, "graphSearchNoResult")}</p>
        ) : (
          <div className="relative" style={{ height: nodes.length * ROW_HEIGHT }}>
            {slice.map((node, offset) => {
              const index = first + offset;
              const selected = node.id === selectedId;
              return (
                <div
                  key={node.id}
                  id={`graph-node-${node.id}`}
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  onClick={() => onSelect(node.id)}
                  onDoubleClick={() => onActivate(node.id)}
                  style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                  className={`absolute inset-x-0 flex cursor-pointer items-center gap-1.5 truncate px-2 text-xs ${
                    selected
                      ? "bg-bg-hover text-accent-text"
                      : "text-text-primary hover:bg-bg-hover"
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
                  <span className="truncate">{node.title}</span>
                  {node.path && node.path !== node.title ? (
                    <span className="truncate text-text-muted">{node.path}</span>
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
