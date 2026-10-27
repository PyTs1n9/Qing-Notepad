/**
 * User-owned chat endpoints (设置 → AI 接口).
 *
 * The app ships **no** provider preset any more: every API the assistant can
 * talk to is a row the user added — a base URL, a key, and a subset of the
 * models the endpoint reported. That is why nothing here is a per-vendor
 * constant except the quick-pick table, which only pre-fills a form.
 *
 * One endpoint ≈ one OpenAI-compatible service:
 *   POST {baseUrl}/chat/completions
 *   GET  {baseUrl}/models
 */

/** One model the endpoint reported, plus the two switches the user owns. */
export interface EndpointModel {
  /** Wire model id, exactly as the service returned it. */
  id: string;
  /** Ticked by the user: only enabled models appear in the chat bar. */
  enabled: boolean;
  /**
   * Whether this model accepts the reasoning fields (`thinking` /
   * `reasoning_effort`). The OpenAI-compatible `/models` payload carries no
   * capability metadata, so this starts from a name heuristic and is then the
   * user's call; `false` means nothing reasoning-related is ever sent.
   */
  supportsThinking: boolean;
}

export interface AiEndpoint {
  id: string;
  /** User-visible name shown in the chat bar under every model. */
  name: string;
  /** Normalized base URL: no trailing slash, no `/chat/completions` suffix. */
  baseUrl: string;
  models: EndpointModel[];
  createdAt: number;
}

/** `小青`: local retrieval, no endpoint, always selectable. */
export const LOCAL_SELECTION = "local";

/**
 * Channel that owns a conversation for a given selection: the endpoint id, or
 * `null` for 小青. Conversations are scoped to a channel, models are not —
 * switching models inside one endpoint must not start a new session.
 */
export function channelOf(selection: string): string | null {
  return parseSelection(selection)?.endpointId ?? null;
}

/** Separator for the persisted `endpointId::modelId` selection string. */
const SELECTION_SEP = "::";

export function makeSelection(endpointId: string, modelId: string): string {
  return `${endpointId}${SELECTION_SEP}${modelId}`;
}

export function parseSelection(
  value: string,
): { endpointId: string; modelId: string } | null {
  if (!value || value === LOCAL_SELECTION) return null;
  const at = value.indexOf(SELECTION_SEP);
  if (at <= 0) return null;
  const endpointId = value.slice(0, at);
  const modelId = value.slice(at + SELECTION_SEP.length);
  return modelId ? { endpointId, modelId } : null;
}

/**
 * Accept what users actually paste: with or without a scheme, with a trailing
 * slash, or with the full completion path copied out of a vendor's curl sample.
 * Everything downstream appends `/chat/completions` or `/models`, so those two
 * suffixes must be stripped here or every request ends up doubled.
 */
export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/models$/i, "")
    .replace(/\/+$/, "");
}

/** `POST {baseUrl}/chat/completions`. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

/** `GET {baseUrl}/models`. */
export function modelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

/**
 * Best-effort guess at whether a model can think, since `/models` reports only
 * `id / object / created / owned_by`. The pattern covers the naming families
 * that actually expose a reasoning stream; the settings row lets the user flip
 * the switch either way, so a wrong guess costs one click, not a broken model.
 */
const THINKING_HINTS =
  /(^|[-_/.])(reasoner|reasoning|thinking|think|r1|o1|o3|o4|qwq|qvq|deepseek-r1|gpt-5)([-_.\d]|$)/i;

export function guessSupportsThinking(modelId: string): boolean {
  return THINKING_HINTS.test(modelId);
}

export interface EndpointPreset {
  /** Stable preset key (not persisted — the endpoint gets its own uuid). */
  key: string;
  name: string;
  baseUrl: string;
  /**
   * Shown as the button's tooltip after the URL, for the one thing the preset
   * cannot know: a base URL that the provider personalises per account.
   */
  note?: string;
}

/**
 * Quick picks. These only pre-fill the form; nothing about them is trusted at
 * request time, and the user can edit every field afterwards.
 *
 * MiMo is listed twice on purpose — Xiaomi bills two ways and each has its own
 * host (verified on mimo.mi.com, 2026-10-23):
 *   按量付费  https://api.xiaomimimo.com/v1              key `sk-…`
 *   Token Plan https://token-plan-cn.xiaomimimo.com/v1    key `tp-…` / `ttp-…`
 */
export const ENDPOINT_PRESETS: EndpointPreset[] = [
  { key: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { key: "moonshot", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1" },
  { key: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  {
    key: "dashscope",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  { key: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1" },
  { key: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { key: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { key: "mimo", name: "小米 MiMo", baseUrl: "https://api.xiaomimimo.com/v1" },
  {
    key: "mimo-token-plan",
    name: "小米 MiMo Token Plan",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    note: "订阅后在 Token Plan 页可看到自己的专属地址，这里可改；Key 形如 tp-… / ttp-…",
  },
  { key: "ollama", name: "Ollama（本机）", baseUrl: "http://localhost:11434/v1" },
];

/** Structural guards for the persisted JSON — a hand-edited file must not crash boot. */
export function isEndpointModel(value: unknown): value is EndpointModel {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.id.length > 0;
}

export function isAiEndpoint(value: unknown): value is AiEndpoint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.name === "string" &&
    typeof v.baseUrl === "string" &&
    Array.isArray(v.models) &&
    v.models.every(isEndpointModel)
  );
}

/** Coerce one stored endpoint into shape, filling the flags an old file lacks. */
export function normalizeEndpoint(value: AiEndpoint): AiEndpoint {
  return {
    id: value.id,
    name: value.name.trim() || value.baseUrl,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    models: value.models.map((model) => ({
      id: model.id,
      enabled: model.enabled !== false,
      supportsThinking:
        typeof model.supportsThinking === "boolean"
          ? model.supportsThinking
          : guessSupportsThinking(model.id),
    })),
  };
}
