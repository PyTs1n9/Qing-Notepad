import React, { useEffect, useMemo, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAiStore, type AiEndpointError } from "@/stores/aiStore";
import { t, tWithParams } from "@/utils/i18n";
import type { AiErrorCode } from "@/utils/ai/provider";
import { ENDPOINT_PRESETS } from "@/utils/ai/chat/endpoints";

function errorText(code: AiErrorCode | null | undefined, lang: "zh" | "en"): string {
  switch (code) {
    case "missing-key":
      return t(lang, "aiErrorMissingKey");
    case "unauthorized":
      return t(lang, "aiErrorUnauthorized");
    case "insufficient-balance":
      return t(lang, "aiErrorBalance");
    case "rate-limited":
      return t(lang, "aiErrorRateLimit");
    case "server":
      return t(lang, "aiErrorServer");
    case "bad-response":
      return t(lang, "aiErrorBadResponse");
    case "aborted":
      return t(lang, "aiErrorAborted");
    case "network":
      return t(lang, "aiErrorNetwork");
    default:
      return t(lang, "aiErrorNetwork");
  }
}

/** Small rounded status dot used by the endpoint rows. */
const Dot: React.FC<{ on: boolean }> = ({ on }) => (
  <span
    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${on ? "bg-accent" : "bg-text-muted/40"}`}
  />
);

interface DraftState {
  name: string;
  baseUrl: string;
  key: string;
}

const AiSettingsPanel: React.FC = () => {
  const { lang } = useSettingsStore();
  const {
    endpoints,
    endpointKeys,
    endpointStatus,
    endpointError,
    conversations,
    loaded,
    hydrate,
    addEndpoint,
    updateEndpoint,
    removeEndpoint,
    saveEndpointKey,
    clearEndpointKey,
    fetchEndpointModels,
    toggleEndpointModel,
    setEndpointModelThinking,
  } = useAiStore();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [presetOpen, setPresetOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const draftFor = (id: string): DraftState => {
    const endpoint = endpoints.find((item) => item.id === id);
    return (
      drafts[id] ?? {
        name: endpoint?.name ?? "",
        baseUrl: endpoint?.baseUrl ?? "",
        key: "",
      }
    );
  };

  const patchDraft = (id: string, patch: Partial<DraftState>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...draftFor(id), ...patch } }));
  };

  const toggleExpanded = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
    setConfirmDelete(null);
  };

  const handleAdd = (preset?: { name: string; baseUrl: string }) => {
    const id = addEndpoint(preset);
    setPresetOpen(false);
    setExpandedId(id);
    setDrafts((prev) => ({
      ...prev,
      [id]: { name: preset?.name ?? "", baseUrl: preset?.baseUrl ?? "", key: "" },
    }));
  };

  /** Commit the text fields when focus leaves them — no explicit save button. */
  const commitText = (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    updateEndpoint(id, { name: draft.name, baseUrl: draft.baseUrl });
  };

  const errorFor = (id: string): AiEndpointError | undefined => endpointError[id];

  const summary = useMemo(
    () =>
      endpoints.map((endpoint) => ({
        id: endpoint.id,
        enabled: endpoint.models.filter((model) => model.enabled).length,
        total: endpoint.models.length,
        hasKey: Boolean(endpointKeys[endpoint.id]),
      })),
    [endpoints, endpointKeys],
  );

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/60 bg-bg-secondary/35 p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-accent-light text-accent-text ring-1 ring-accent/20">
            <Server size={16} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-text-primary">
              {t(lang, "aiEndpointTitle")}
            </h3>
            <p className="truncate text-xs text-text-muted">{t(lang, "aiEndpointHint")}</p>
          </div>
        </div>

        {loaded && endpoints.length === 0 && (
          <p className="mb-3 rounded-xl border border-dashed border-border/70 px-3 py-4 text-center text-xs leading-relaxed text-text-muted">
            {t(lang, "aiEndpointEmpty")}
          </p>
        )}

        <div className="space-y-2">
          {endpoints.map((endpoint) => {
            const info = summary.find((item) => item.id === endpoint.id);
            const expanded = expandedId === endpoint.id;
            const draft = draftFor(endpoint.id);
            const status = endpointStatus[endpoint.id] ?? "idle";
            const busy = status !== "idle";
            const error = errorFor(endpoint.id);
            return (
              <div
                key={endpoint.id}
                className="overflow-hidden rounded-xl border border-border/60 bg-bg-primary/60"
              >
                <button
                  type="button"
                  onClick={() => toggleExpanded(endpoint.id)}
                  aria-expanded={expanded}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg-hover/60"
                >
                  <Dot on={Boolean(info?.hasKey)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text-primary">
                      {endpoint.name || t(lang, "aiEndpointUntitled")}
                    </span>
                    <span className="block truncate text-[11px] text-text-muted">
                      {endpoint.baseUrl || t(lang, "aiEndpointNoUrl")}
                    </span>
                  </span>
                  <span className="flex-shrink-0 rounded-full bg-bg-hover px-2 py-0.5 text-[10px] text-text-muted">
                    {t(lang, "aiEndpointModelCount")
                      .replace("{on}", String(info?.enabled ?? 0))
                      .replace("{total}", String(info?.total ?? 0))}
                  </span>
                  <ChevronDown
                    size={13}
                    className={`flex-shrink-0 text-text-muted transition-transform ${
                      expanded ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {expanded && (
                  <div className="space-y-3 border-t border-border/60 px-3 py-3">
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-text-muted">
                        {t(lang, "aiEndpointName")}
                      </span>
                      <input
                        value={draft.name}
                        onChange={(event) =>
                          patchDraft(endpoint.id, { name: event.target.value })
                        }
                        onBlur={() => commitText(endpoint.id)}
                        placeholder={t(lang, "aiEndpointNamePlaceholder")}
                        spellCheck={false}
                        className="w-full rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors focus:border-accent"
                      />
                    </label>

                    <label className="block">
                      <span className="mb-1 block text-[11px] text-text-muted">
                        {t(lang, "aiEndpointBaseUrl")}
                      </span>
                      <input
                        value={draft.baseUrl}
                        onChange={(event) =>
                          patchDraft(endpoint.id, { baseUrl: event.target.value })
                        }
                        onBlur={() => commitText(endpoint.id)}
                        placeholder="https://api.example.com/v1"
                        spellCheck={false}
                        autoComplete="off"
                        className="w-full rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none transition-colors focus:border-accent"
                      />
                    </label>

                    <div>
                      <span className="mb-1 block text-[11px] text-text-muted">
                        {t(lang, "aiEndpointKey")}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="relative min-w-0 flex-1">
                          <input
                            type={reveal[endpoint.id] ? "text" : "password"}
                            value={draft.key}
                            onChange={(event) =>
                              patchDraft(endpoint.id, { key: event.target.value })
                            }
                            placeholder={
                              info?.hasKey
                                ? t(lang, "aiEndpointKeySet")
                                : t(lang, "aiEndpointKeyPlaceholder")
                            }
                            spellCheck={false}
                            autoComplete="off"
                            className="w-full rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 pr-8 text-sm text-text-primary outline-none transition-colors focus:border-accent"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setReveal((prev) => ({
                                ...prev,
                                [endpoint.id]: !prev[endpoint.id],
                              }))
                            }
                            aria-label={reveal[endpoint.id] ? "hide" : "show"}
                            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-text-muted transition-colors hover:text-text-primary"
                          >
                            {reveal[endpoint.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                        <button
                          type="button"
                          disabled={busy || !draft.key.trim()}
                          onClick={async () => {
                            const ok = await saveEndpointKey(endpoint.id, draft.key);
                            if (ok) patchDraft(endpoint.id, { key: "" });
                          }}
                          className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg-primary transition-all hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {status === "saving" ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            t(lang, "aiSaveKey")
                          )}
                        </button>
                        {info?.hasKey && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void clearEndpointKey(endpoint.id)}
                            title={t(lang, "aiClearKey")}
                            className="flex-shrink-0 cursor-pointer rounded-lg border border-border p-1.5 text-text-muted transition-colors hover:text-danger disabled:opacity-40"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-text-muted">
                          {t(lang, "aiEndpointModels")}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void fetchEndpointModels(endpoint.id)}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-2.5 py-1 text-[11px] font-medium text-text-primary transition-all hover:bg-bg-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {status === "fetching" ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <RefreshCw size={12} />
                          )}
                          {status === "fetching"
                            ? t(lang, "aiEndpointSearching")
                            : t(lang, "aiEndpointSearch")}
                        </button>
                      </div>

                      {error && (
                        <p className="mb-1.5 break-words text-[11px] leading-relaxed text-danger">
                          {errorText(error.code, lang)}
                          {error.detail ? ` · ${error.detail}` : ""}
                        </p>
                      )}

                      {endpoint.models.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-3 text-center text-[11px] text-text-muted">
                          {t(lang, "aiEndpointNoModels")}
                        </p>
                      ) : (
                        <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
                          {endpoint.models.map((model) => (
                            <li
                              key={model.id}
                              className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-bg-hover/60"
                            >
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={model.enabled}
                                  onChange={() => toggleEndpointModel(endpoint.id, model.id)}
                                  className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent,#4f8cff)]"
                                />
                                <span className="truncate font-mono text-xs text-text-primary">
                                  {model.id}
                                </span>
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  setEndpointModelThinking(
                                    endpoint.id,
                                    model.id,
                                    !model.supportsThinking,
                                  )
                                }
                                title={t(lang, "aiEndpointThinkingHint")}
                                className={`inline-flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors ${
                                  model.supportsThinking
                                    ? "border-accent/40 bg-accent-light text-accent-text"
                                    : "border-border text-text-muted hover:text-text-primary"
                                }`}
                              >
                                <Brain size={10} />
                                {model.supportsThinking && <Check size={9} />}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2">
                      {confirmDelete === endpoint.id &&
                      conversations.some((c) => c.endpointId === endpoint.id) ? (
                        // Deleting a channel deletes the sessions it owns; say so
                        // before the click, not after.
                        <span className="text-[10px] leading-relaxed text-danger">
                          {tWithParams(lang, "aiEndpointDeleteSessions", {
                            count: conversations.filter(
                              (c) => c.endpointId === endpoint.id,
                            ).length,
                          })}
                        </span>
                      ) : (
                        <span className="text-[10px] leading-relaxed text-text-muted">
                          {t(lang, "aiEndpointModelsHint")}
                        </span>
                      )}
                      {confirmDelete === endpoint.id ? (
                        <span className="flex flex-shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              void removeEndpoint(endpoint.id);
                              setConfirmDelete(null);
                              setExpandedId(null);
                            }}
                            className="cursor-pointer rounded-lg bg-danger/90 px-2 py-1 text-[11px] font-medium text-on-danger transition-all active:scale-95"
                          >
                            {t(lang, "aiEndpointDeleteConfirm")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(null)}
                            className="cursor-pointer rounded-lg border border-border px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary"
                          >
                            {t(lang, "aiEndpointCancel")}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(endpoint.id)}
                          className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-danger/50 hover:text-danger"
                        >
                          <Trash2 size={11} />
                          {t(lang, "aiEndpointDelete")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3">
          <button
            type="button"
            onClick={() => setPresetOpen((open) => !open)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary transition-all hover:bg-bg-hover active:scale-95"
          >
            <Plus size={13} />
            {t(lang, "aiEndpointAdd")}
          </button>
          {presetOpen && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ENDPOINT_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => handleAdd({ name: preset.name, baseUrl: preset.baseUrl })}
                  title={preset.note ? `${preset.baseUrl}\n${preset.note}` : preset.baseUrl}
                  className="cursor-pointer rounded-full border border-border bg-bg-primary px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary"
                >
                  {preset.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => handleAdd()}
                className="cursor-pointer rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:border-accent/40 hover:text-text-primary"
              >
                {t(lang, "aiEndpointCustom")}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* 思考档位 deliberately lives in the chat input bar, not here: which
          model answers and how hard it thinks belong next to the model picker. */}
      <section className="rounded-2xl border border-border/60 bg-bg-secondary/20 p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-bg-hover text-text-muted">
            <ShieldCheck size={14} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary">
              {t(lang, "aiPrivacyNoticeTitle")}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              {t(lang, "aiPrivacyNoticeBody")}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default AiSettingsPanel;
