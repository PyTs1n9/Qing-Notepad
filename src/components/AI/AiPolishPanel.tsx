import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  RotateCcw,
  Sparkles,
  Square,
  Undo2,
  Wand2,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { resolveAiSelection, useAiStore } from "@/stores/aiStore";
import { t } from "@/utils/i18n";
import {
  SELECTION_ACTIONS,
  generateSelectionAction,
  getSelectionAction,
  type SelectionActionId,
} from "@/utils/ai/polish";
import { generateSummaryCard, type SummaryCard } from "@/utils/ai/structured";
import { makeSelection } from "@/utils/ai/chat/endpoints";
import { computeLineDiff } from "@/utils/ai/diff";
import { aiErrorText } from "@/utils/ai/errorText";
import type { AiErrorCode } from "@/utils/ai/provider";
import { useStreamScroll } from "@/hooks/useStreamScroll";

interface AiPolishPanelProps {
  onBack: () => void;
  onOpenSettings: () => void;
}

const EXCERPT_LIMIT = 220;

function excerpt(text: string): string {
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text;
}

/** i18n keys per action, kept explicit so the typed table stays checkable. */
const ACTION_LABEL = {
  polish: "aiActPolish",
  rewrite: "aiActRewrite",
  continue: "aiActContinue",
  summarize: "aiActSummarize",
  translate: "aiActTranslate",
  checklist: "aiActChecklist",
} as const;

/** Card text for the copy button: headings + bullets, or the raw body. */
function cardToText(card: SummaryCard): string {
  const lines: string[] = [];
  if (card.title) lines.push(`## ${card.title}`);
  if (card.summary) lines.push(card.summary);
  if (card.points.length) lines.push("", ...card.points.map((point) => `- ${point}`));
  if (card.tags.length) lines.push("", card.tags.map((tag) => `#${tag}`).join(" "));
  return lines.join("\n").trim();
}

const AiPolishPanel: React.FC<AiPolishPanelProps> = ({ onBack, onOpenSettings }) => {
  const lang = useSettingsStore((s) => s.lang);
  const {
    polish,
    polishApplied,
    setPolishApplied,
    endpoints,
    polishModel,
    setPolishModel,
    thinkingLevel,
  } = useAiStore();
  const [action, setAction] = useState<SelectionActionId>("polish");
  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState("");
  const [card, setCard] = useState<SummaryCard | null>(null);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<AiErrorCode | null>(null);
  const [stale, setStale] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Generating scrolls the panel down to the stream and keeps it following the
  // produced content (and the diff once it lands) instead of staying put.
  const { containerRef, contentRef } = useStreamScroll({ enabled: generating });

  // A new session always starts from a clean slate.
  useEffect(() => {
    setAction("polish");
    setDraft("");
    setCard(null);
    setCopied(false);
    setInstruction("");
    setError(null);
    setStale(false);
    setGenerating(false);
  }, [polish?.id]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!polish) return null;

  const spec = getSelectionAction(action);
  const hasSelection = polish.originalText.trim().length > 0;

  /** Pick another action: the previous result belongs to the previous action. */
  const selectAction = (next: SelectionActionId) => {
    if (next === action) return;
    abortRef.current?.abort();
    setAction(next);
    setDraft("");
    setCard(null);
    setCopied(false);
    setError(null);
    setStale(false);
    setPolishApplied(false);
  };

  const handleGenerate = async () => {
    const resolved = resolveAiSelection(useAiStore.getState().polishModel);
    if (!resolved || !hasSelection || generating) return;
    const { provider, apiKey, model } = resolved;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setDraft("");
    setCard(null);
    setCopied(false);
    setError(null);
    setPolishApplied(false);
    try {
      if (action === "summarize") {
        const summary = await generateSummaryCard({
          apiKey,
          provider,
          model,
          text: polish.originalText,
          lang,
          thinkingLevel,
          signal: controller.signal,
        });
        if (!summary.summary.trim()) setError("bad-response");
        else setCard(summary);
      } else if (spec.output === "card") {
        // 转待办: plain text, shown as a card so the selection stays intact.
        const text = await generateSelectionAction({
          apiKey,
          action,
          originalText: polish.originalText,
          instruction,
          lang,
          provider,
          model,
          thinkingLevel,
          signal: controller.signal,
        });
        if (!text.trim()) setError("bad-response");
        else setCard({ title: "", summary: text, points: [], tags: [] });
      } else {
        const text = await generateSelectionAction({
          apiKey,
          action,
          originalText: polish.originalText,
          instruction,
          lang,
          provider,
          model,
          thinkingLevel,
          signal: controller.signal,
          onDelta: (delta) => setDraft((prev) => prev + delta),
        });
        if (!text.trim()) setError("bad-response");
      }
    } catch (err) {
      const code: AiErrorCode =
        typeof err === "object" && err !== null && "code" in err
          ? ((err as { code: AiErrorCode }).code ?? "network")
          : "network";
      if (code !== "aborted") setError(code);
    } finally {
      abortRef.current = null;
      setGenerating(false);
    }
  };

  /**
   * What actually gets written back. 续写 returns only the new text, so the
   * original is prepended here rather than by the model (asking a model to echo
   * the original invites silent truncation of it).
   */
  const resultText = spec.append ? `${polish.originalText}\n\n${draft}` : draft;

  const handleApply = () => {
    const ok = polish.apply(resultText);
    if (!ok) {
      setStale(true);
      return;
    }
    setStale(false);
    setPolishApplied(true);
  };

  const handleUndo = () => {
    polish.undo();
    setPolishApplied(false);
  };

  const handleCopy = () => {
    if (!card) return;
    void navigator.clipboard.writeText(cardToText(card)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  const styles = [
    { label: t(lang, "aiPolishStylePolish"), value: "" },
    { label: t(lang, "aiPolishStyleConcise"), value: lang === "zh" ? "让表达更简洁" : "Make it more concise" },
    { label: t(lang, "aiPolishStyleFormal"), value: lang === "zh" ? "改成更正式的语气" : "Use a more formal tone" },
    { label: t(lang, "aiPolishStyleCasual"), value: lang === "zh" ? "改成更口语化的表达" : "Use a more casual tone" },
  ];

  const diffLines =
    spec.output === "replace" && draft && !generating
      ? computeLineDiff(polish.originalText, resultText)
      : [];

  // 润色 model picker: every ticked model of every configured endpoint (小青 does
  // not generate, so it is not an option here). The value is the persisted
  // `endpointId::modelId` selection — one decision covers provider and model.
  const polishModelOptions = endpoints.flatMap((endpoint) =>
    endpoint.models
      .filter((model) => model.enabled)
      .map((model) => ({
        id: makeSelection(endpoint.id, model.id),
        label: model.id,
        sub: endpoint.name,
      })),
  );
  const activePolishOption =
    polishModelOptions.find((o) => o.id === polishModel) ?? polishModelOptions[0];
  // 润色 needs a resolvable endpoint + key: another endpoint having a key does
  // not make the selected one usable, so ask the store for the real answer.
  const polishReady = Boolean(resolveAiSelection(polishModel)?.apiKey);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sub-header */}
      <div className="ai-pane flex flex-shrink-0 items-center gap-2 border-b border-border py-2">
        <button
          type="button"
          onClick={onBack}
          title={t(lang, "aiPolishBack")}
          aria-label={t(lang, "aiPolishBack")}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-all hover:bg-bg-hover hover:text-text-primary active:scale-95"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
          <Wand2 size={15} className="text-accent-text" />
          {t(lang, "aiPolishTitle")}
        </div>
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setModelMenuOpen((open) => !open)}
            title={t(lang, "aiPolishModelLabel")}
            className="flex cursor-pointer items-center gap-1 rounded-md border border-border bg-bg-secondary/30 px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <span className="max-w-[8rem] truncate">{activePolishOption?.label}</span>
            <ChevronDown
              size={11}
              className={`flex-shrink-0 transition-transform ${modelMenuOpen ? "rotate-180" : ""}`}
            />
          </button>
          {modelMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setModelMenuOpen(false)} />
              <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-border bg-bg-primary py-1 shadow-lg">
                {polishModelOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setPolishModel(option.id);
                      setModelMenuOpen(false);
                    }}
                    className={`flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-bg-hover ${
                      option.id === polishModel ? "bg-accent-light/50" : ""
                    }`}
                  >
                    <span className="w-full truncate text-xs font-medium text-text-primary">
                      {option.label}
                    </span>
                    <span className="w-full truncate text-[10px] text-text-muted">
                      {option.sub}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div ref={containerRef} className="ai-pane min-h-0 flex-1 overflow-y-auto py-3">
        {!hasSelection ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Sparkles size={22} className="text-text-muted" />
            <p className="text-xs leading-relaxed text-text-muted">
              {t(lang, "aiPolishNoSelection")}
            </p>
          </div>
        ) : !polishReady ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-xs leading-relaxed text-text-muted">{t(lang, "aiNoKeyHint")}</p>
            <button
              type="button"
              onClick={onOpenSettings}
              className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg-primary shadow-sm transition-all hover:brightness-110 active:scale-95"
            >
              {t(lang, "aiSettings")}
            </button>
          </div>
        ) : (
          <div ref={contentRef} className="space-y-3">
            {/* Action picker: one row, wraps on narrow panels. */}
            <div className="flex flex-wrap gap-1.5">
              {SELECTION_ACTIONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectAction(item.id)}
                  className={`cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition-all active:scale-95 ${
                    item.id === action
                      ? "border-accent bg-accent-light font-medium text-accent-text"
                      : "border-border bg-bg-secondary/30 text-text-muted hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  {t(lang, ACTION_LABEL[item.id])}
                </button>
              ))}
            </div>

            {/* Original passage */}
            <div className="rounded-xl border border-border/60 bg-bg-secondary/40 px-3 py-2 shadow-sm">
              <div className="mb-1 text-[11px] font-medium text-text-muted">
                {t(lang, "aiDiffBefore")}
              </div>
              <div className="whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">
                {excerpt(polish.originalText)}
              </div>
            </div>

            {/* Style chips only where a style is meaningful (润色). */}
            {action === "polish" && (
              <div className="flex flex-wrap gap-1.5">
                {styles.map((style) => (
                  <button
                    key={style.label}
                    type="button"
                    onClick={() => setInstruction(style.value)}
                    className={`cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition-all active:scale-95 ${
                      instruction === style.value
                        ? "border-accent bg-accent-light text-accent-text"
                        : "border-border bg-bg-secondary/30 text-text-muted hover:bg-bg-hover hover:text-text-primary"
                    }`}
                  >
                    {style.label}
                  </button>
                ))}
              </div>
            )}

            {spec.usesInstruction && (
              <textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder={t(lang, "aiPolishPlaceholder")}
                rows={2}
                className="w-full resize-y rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs leading-relaxed text-text-primary outline-none transition-colors focus:border-accent"
              />
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (generating) {
                    abortRef.current?.abort();
                  } else {
                    void handleGenerate();
                  }
                }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg-primary shadow-sm transition-all hover:brightness-110 active:scale-95"
              >
                {generating ? (
                  <>
                    <Square size={12} />
                    {t(lang, "aiStop")}
                  </>
                ) : (
                  <>
                    <Sparkles size={12} />
                    {t(lang, "aiPolishGenerate")}
                  </>
                )}
              </button>
              {error && (
                <span className="text-xs text-danger">{aiErrorText(error, lang)}</span>
              )}
            </div>

            {/* Streaming / result */}
            {generating && (
              <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-bg-secondary/40 px-3 py-2 text-xs text-text-muted shadow-sm">
                <Loader2 size={13} className="animate-spin" />
                {t(lang, "aiThinking")}
              </div>
            )}

            {/* Card result (摘要 / 转待办): informational, never written to the note. */}
            {card && !generating && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="overflow-hidden rounded-xl border border-border/60 shadow-sm"
              >
                <div className="flex items-center gap-2 border-b border-border/60 bg-bg-secondary px-3 py-1.5">
                  <span className="text-[11px] font-medium text-text-muted">
                    {t(lang, "aiCardTitle")}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    <Copy size={11} />
                    {copied ? t(lang, "aiCardCopied") : t(lang, "aiCardCopy")}
                  </button>
                </div>
                <div className="space-y-2 px-3 py-2">
                  {card.title && (
                    <div className="text-xs font-medium text-text-primary">{card.title}</div>
                  )}
                  {card.summary && (
                    <div className="whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">
                      {card.summary}
                    </div>
                  )}
                  {card.points.length > 0 && (
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-text-muted">
                        {t(lang, "aiCardPoints")}
                      </div>
                      <ul className="list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-text-secondary">
                        {card.points.map((point, index) => (
                          <li key={index}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {card.tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[11px] font-medium text-text-muted">
                        {t(lang, "aiCardTags")}
                      </span>
                      {card.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-muted"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="border-t border-border/60 px-3 py-1.5 text-[11px] leading-relaxed text-text-muted">
                  {t(lang, "aiActCardHint")}
                </div>
              </motion.div>
            )}

            {/* Diff preview (replace actions only) */}
            {diffLines.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="overflow-hidden rounded-xl border border-border/60 shadow-sm">
                <div className="border-b border-border/60 bg-bg-secondary px-3 py-1.5 text-[11px] font-medium text-text-muted">
                  {t(lang, "aiDiffAfter")}
                </div>
                <div className="divide-y divide-transparent px-2 py-1.5">
                  {diffLines.map((line, index) => (
                    <div
                      key={`${line.type}-${index}`}
                      className={`whitespace-pre-wrap rounded px-2 py-0.5 text-xs leading-relaxed ${
                        line.type === "add"
                          ? "bg-green-500/12 text-green-400"
                          : line.type === "del"
                            ? "bg-red-500/12 text-red-400 line-through decoration-red-400/50"
                            : "text-text-secondary"
                      }`}
                    >
                      <span className="mr-1 select-none opacity-50">
                        {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                      </span>
                      {line.text}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Actions */}
            {spec.output === "replace" && draft && !generating && (
              <div className="flex flex-wrap items-center gap-2">
                {!polishApplied ? (
                  <button
                    type="button"
                    onClick={handleApply}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg-primary shadow-sm transition-all hover:brightness-110 active:scale-95"
                  >
                    <Check size={12} />
                    {t(lang, "aiPolishApply")}
                  </button>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1 text-xs text-accent-text">
                      <Check size={12} />
                      {t(lang, "aiPolishApplied")}
                    </span>
                    <button
                      type="button"
                      onClick={handleUndo}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-muted transition-all hover:bg-bg-hover hover:text-text-primary active:scale-95"
                    >
                      <Undo2 size={12} />
                      {t(lang, "aiPolishUndo")}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-muted transition-all hover:bg-bg-hover hover:text-text-primary active:scale-95"
                >
                  <RotateCcw size={12} />
                  {t(lang, "aiPolishGenerate")}
                </button>
              </div>
            )}

            {stale && (
              <div className="text-xs text-danger">{t(lang, "aiPolishStale")}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default AiPolishPanel;
