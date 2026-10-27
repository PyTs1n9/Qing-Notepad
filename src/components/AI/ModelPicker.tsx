/**
 * Model picker: one floating card for the model list, plus a second card that
 * unfolds to the right of a model row when that model can think.
 *
 * The list is *derived from the configured endpoints*: every ticked model of
 * every endpoint appears here, labelled with the endpoint it belongs to. Adding
 * or unticking a model therefore happens in 设置 → AI 接口, never here — this
 * card is a selector, not a manager (that is why it can only offer a jump link).
 *
 * Why a portal: the AI column lives inside a shell box with `overflow-hidden`,
 * so anything absolutely positioned inside it gets clipped at the column edge.
 * A 240px list plus a 160px reasoning card cannot fit in a 340px sidebar, so
 * both cards render into `document.body` with fixed coordinates instead.
 *
 * Why not inline expansion: expanding a row changes the list height, so the
 * rows shift under the pointer between mousedown and mouseup and the click is
 * lost (that was the "小青 can't be selected, the panel just disappears" bug).
 * A separate card never moves the list.
 *
 * Hover is a convenience, not the only path: hovering opens, clicking a model
 * pins the reasoning card so keyboard and touch users can reach it, and every
 * step has a keyboard path (focus behaves like hover).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Brain, Check, ChevronDown, Plus, Sparkles } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { LOCAL_MODEL_ID, useAiStore } from "@/stores/aiStore";
import { makeSelection, parseSelection } from "@/utils/ai/chat/endpoints";
import type { ThinkingLevel } from "@/utils/ai/chat";
import { resolveModelBrand } from "@/utils/ai/modelBrand";
import ModelBrandIcon from "@/components/AI/ModelBrandIcon";
import { t } from "@/utils/i18n";

const CARD_WIDTH = 240;
const FLYOUT_WIDTH = 160;
const GAP = 8;
const EDGE = 8;
/** Grace period so the pointer can travel between the three floating regions. */
const HOVER_RELEASE_MS = 140;
/** Estimated flyout height, used only to keep it inside the viewport. */
const FLYOUT_HEIGHT = 148;

const THINKING_LABEL: Record<ThinkingLevel, "aiThinkingOff" | "aiThinkingLow" | "aiThinkingHigh"> = {
  off: "aiThinkingOff",
  low: "aiThinkingLow",
  high: "aiThinkingHigh",
};
const THINKING_EFFECT: Record<
  ThinkingLevel,
  "aiThinkingEffectOff" | "aiThinkingEffectLow" | "aiThinkingEffectHigh"
> = {
  off: "aiThinkingEffectOff",
  low: "aiThinkingEffectLow",
  high: "aiThinkingEffectHigh",
};
const THINKING_ORDER: ThinkingLevel[] = ["off", "low", "high"];

/** One selectable entry: a ticked model of one endpoint. */
interface ModelRow {
  endpointId: string;
  endpointName: string;
  model: string;
  supportsThinking: boolean;
}

interface Anchor {
  left: number;
  bottom: number;
}

interface FlyoutState {
  row: ModelRow;
  /** Viewport y of the hovered row's top edge. */
  rowTop: number;
}

interface ModelPickerProps {
  /** Jump to the place where endpoints and their models get configured. */
  onManageModels?: () => void;
}

const ModelPicker: React.FC<ModelPickerProps> = ({ onManageModels }) => {
  const lang = useSettingsStore((s) => s.lang);
  const chatModel = useAiStore((s) => s.chatModel);
  const thinkingLevel = useAiStore((s) => s.thinkingLevel);
  const endpoints = useAiStore((s) => s.endpoints);
  const setChatModel = useAiStore((s) => s.setChatModel);
  const setThinkingLevel = useAiStore((s) => s.setThinkingLevel);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const releaseTimer = useRef<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [flyout, setFlyout] = useState<FlyoutState | null>(null);

  // Flattened once per config change: ticked models only, in endpoint order.
  const rows = useMemo<ModelRow[]>(
    () =>
      endpoints.flatMap((endpoint) =>
        endpoint.models
          .filter((model) => model.enabled)
          .map((model) => ({
            endpointId: endpoint.id,
            endpointName: endpoint.name,
            model: model.id,
            supportsThinking: model.supportsThinking,
          })),
      ),
    [endpoints],
  );

  const localSelected = chatModel === LOCAL_MODEL_ID;
  const selected = parseSelection(chatModel);
  const activeRow = selected
    ? rows.find(
        (row) => row.endpointId === selected.endpointId && row.model === selected.modelId,
      )
    : undefined;
  // The chip must name the model that will actually answer.
  const chipLabel = activeRow?.model ?? t(lang, "aiModelLocal");
  const open = pinned || hoverOpen;

  const endpointById = useMemo(
    () => new Map(endpoints.map((endpoint) => [endpoint.id, endpoint])),
    [endpoints],
  );
  const brandFor = (endpointId: string, modelId: string) => {
    const endpoint = endpointById.get(endpointId);
    return resolveModelBrand({
      modelId,
      baseUrl: endpoint?.baseUrl,
      endpointName: endpoint?.name,
    });
  };
  const chipBrand = activeRow ? brandFor(activeRow.endpointId, activeRow.model) : null;

  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - EDGE - CARD_WIDTH));
    const bottom = window.innerHeight - rect.top + GAP;
    // Every region re-measures on enter; keep the object stable when nothing
    // moved so hovering the panel does not re-render on every pass.
    setAnchor((prev) =>
      prev && prev.left === left && prev.bottom === bottom ? prev : { left, bottom },
    );
  }, []);

  const closeAll = useCallback(() => {
    setPinned(false);
    setHoverOpen(false);
    setFlyout(null);
  }, []);

  /** Clear the release timer — the pointer is back inside our regions. */
  const hold = () => {
    if (releaseTimer.current !== null) {
      window.clearTimeout(releaseTimer.current);
      releaseTimer.current = null;
    }
    setHoverOpen(true);
    measure();
  };

  /** Close after a short grace period, so crossing a gap does not close. */
  const release = () => {
    if (releaseTimer.current !== null) window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => {
      releaseTimer.current = null;
      setHoverOpen(false);
      if (!pinned) setFlyout(null);
    }, HOVER_RELEASE_MS);
  };

  useEffect(() => () => {
    if (releaseTimer.current !== null) window.clearTimeout(releaseTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, measure]);

  /**
   * Drop the second card. Every row that cannot think must call this on entry:
   * the card belongs to the row under the pointer, so leaving a reasoning model
   * for a plain one (小青, or a chat-only model) has to clear it. Hovering the
   * panel background clears it too, for the same reason.
   */
  const clearFlyout = () => setFlyout(null);

  const showFlyoutFor = (row: ModelRow, rowTop: number) => {
    if (!row.supportsThinking) {
      clearFlyout();
      return;
    }
    setFlyout({ row, rowTop });
  };

  const pickRow = (row: ModelRow, rowTop: number) => {
    setChatModel(makeSelection(row.endpointId, row.model));
    if (row.supportsThinking) {
      // Pin the second card: on touch there is no hover, and on keyboard the
      // next Tab must land on a level row that is already visible.
      setPinned(true);
      showFlyoutFor(row, rowTop);
    } else {
      closeAll();
    }
  };

  const pickLocal = () => {
    setChatModel(LOCAL_MODEL_ID);
    closeAll();
  };

  const pickLevel = (row: ModelRow, level: ThinkingLevel) => {
    setChatModel(makeSelection(row.endpointId, row.model));
    setThinkingLevel(level);
    closeAll();
  };

  const reduced = useReducedMotion();
  const enter = reduced ? { duration: 0 } : { duration: 0.16, ease: "easeOut" as const };

  const flyoutLeft = anchor
    ? anchor.left + CARD_WIDTH + GAP + FLYOUT_WIDTH + EDGE > window.innerWidth
      // No room on the right of the list: mirror it so it stays on screen.
      ? Math.max(EDGE, anchor.left - GAP - FLYOUT_WIDTH)
      : anchor.left + CARD_WIDTH + GAP
    : 0;

  const rowSelected = (row: ModelRow) =>
    chatModel === makeSelection(row.endpointId, row.model);

  return (
    <>
      <div className="relative min-w-0" onMouseEnter={hold} onMouseLeave={release}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            if (pinned) {
              closeAll();
            } else {
              measure();
              setPinned(true);
            }
          }}
          title={activeRow ? `${chipLabel} · ${t(lang, "aiModelLabel")}` : t(lang, "aiModelLabel")}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="ai-model-chip flex max-w-[160px] cursor-pointer items-center gap-1 rounded-full border border-border/60 bg-bg-secondary/50 px-2 py-1 text-[11px] text-text-muted transition-all hover:border-accent/40 hover:text-text-primary active:scale-95"
        >
          {chipBrand ? (
            <ModelBrandIcon brand={chipBrand} className="text-text-primary" />
          ) : (
            <Sparkles size={11} className="flex-shrink-0 text-accent-text" />
          )}
          <span className="ai-model-chip__label truncate">{chipLabel}</span>
          {!localSelected && activeRow?.supportsThinking && (
            <span className="ai-model-chip__level flex-shrink-0 rounded-full bg-bg-hover px-1 text-[10px] leading-4 text-text-muted">
              {t(lang, THINKING_LABEL[thinkingLevel])}
            </span>
          )}
          <ChevronDown
            size={11}
            className={`flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {createPortal(
        <AnimatePresence>
          {open && anchor && (
            <>
              {pinned && (
                <div
                  className="fixed inset-0 z-[70]"
                  onMouseDown={closeAll}
                  aria-hidden
                />
              )}
              <motion.div
                role="listbox"
                aria-label={t(lang, "aiModelSection")}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.98 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.98 }}
                transition={enter}
                onMouseEnter={hold}
                onMouseLeave={release}
                style={{ left: anchor.left, bottom: anchor.bottom, width: CARD_WIDTH }}
                className="fixed z-[71] max-h-[min(60vh,420px)] overflow-y-auto rounded-xl border border-border bg-bg-primary py-1 shadow-xl"
              >
                <div
                  onMouseEnter={clearFlyout}
                  className="px-3 pb-1 pt-0.5 text-[10px] font-medium text-text-muted"
                >
                  {t(lang, "aiModelSection")}
                </div>
                <button
                  type="button"
                  role="option"
                  aria-selected={localSelected}
                  onMouseEnter={clearFlyout}
                  onFocus={clearFlyout}
                  onClick={pickLocal}
                  className={`flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-hover ${
                    localSelected ? "text-accent-text" : "text-text-secondary"
                  }`}
                >
                  <Sparkles size={12} className="mt-0.5 flex-shrink-0 text-accent-text" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{t(lang, "aiModelLocal")}</span>
                    <span className="block truncate text-[10px] text-text-muted">
                      {t(lang, "aiModelLocalSub")}
                    </span>
                  </span>
                  {localSelected && <Check size={11} className="mt-0.5 flex-shrink-0" />}
                </button>

                {rows.length === 0 && (
                  <div className="px-3 py-2 text-[11px] leading-relaxed text-text-muted">
                    {t(lang, "aiModelNoEndpoint")}
                  </div>
                )}

                {rows.map((row) => {
                  const isSelected = rowSelected(row);
                  const rowBrand = brandFor(row.endpointId, row.model);
                  return (
                    <button
                      key={`${row.endpointId}:${row.model}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={(event) =>
                        showFlyoutFor(row, event.currentTarget.getBoundingClientRect().top)
                      }
                      onFocus={(event) =>
                        showFlyoutFor(row, event.currentTarget.getBoundingClientRect().top)
                      }
                      onClick={(event) =>
                        pickRow(row, event.currentTarget.getBoundingClientRect().top)
                      }
                      className={`flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-hover ${
                        isSelected ? "text-accent-text" : "text-text-secondary"
                      }`}
                    >
                      {rowBrand ? (
                        <ModelBrandIcon brand={rowBrand} className="mt-0.5 text-text-primary" />
                      ) : (
                        <Sparkles size={12} className="mt-0.5 flex-shrink-0 text-text-muted" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1 truncate text-xs">
                          <span className="truncate">{row.model}</span>
                          {row.supportsThinking && (
                            <Brain size={10} className="flex-shrink-0 text-text-muted" />
                          )}
                        </span>
                        <span className="block truncate text-[10px] text-text-muted">
                          {row.endpointName}
                        </span>
                      </span>
                      {isSelected && <Check size={11} className="mt-0.5 flex-shrink-0" />}
                    </button>
                  );
                })}

                {/* Footer action: leaves the picker for the endpoint settings.
                    Sticky so it stays reachable once the list scrolls. */}
                {onManageModels && (
                  <button
                    type="button"
                    onClick={() => {
                      closeAll();
                      onManageModels();
                    }}
                    className="sticky bottom-0 mt-1 flex w-full cursor-pointer items-center gap-1.5 border-t border-border/60 bg-bg-primary px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    <Plus size={12} className="flex-shrink-0" />
                    <span className="truncate">{t(lang, "aiModelAdd")}</span>
                  </button>
                )}
              </motion.div>

              {flyout && (
                <motion.div
                  role="group"
                  aria-label={t(lang, "aiThinkingTitle")}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, x: -4 }}
                  animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, x: -4 }}
                  transition={enter}
                  onMouseEnter={hold}
                  onMouseLeave={release}
                  style={{
                    left: flyoutLeft,
                    top: Math.max(
                      EDGE,
                      Math.min(flyout.rowTop, window.innerHeight - EDGE - FLYOUT_HEIGHT),
                    ),
                    width: FLYOUT_WIDTH,
                  }}
                  className="fixed z-[72] rounded-xl border border-border bg-bg-primary py-1 shadow-xl"
                >
                  <div className="px-3 pb-1 pt-0.5 text-[10px] font-medium text-text-muted">
                    {t(lang, "aiThinkingTitle")}
                  </div>
                  {THINKING_ORDER.map((level) => {
                    const levelSelected =
                      rowSelected(flyout.row) && thinkingLevel === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        role="option"
                        aria-selected={levelSelected}
                        onClick={() => pickLevel(flyout.row, level)}
                        className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-hover ${
                          levelSelected ? "text-accent-text" : "text-text-secondary"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs">
                            {t(lang, THINKING_LABEL[level])}
                          </span>
                          <span className="block truncate text-[10px] text-text-muted">
                            {t(lang, THINKING_EFFECT[level])}
                          </span>
                        </span>
                        {levelSelected && <Check size={11} className="flex-shrink-0" />}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
};

export default ModelPicker;
