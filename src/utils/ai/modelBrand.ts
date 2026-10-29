/**
 * Vendor marks for the model picker.
 *
 * There are no provider presets at runtime: an endpoint is whatever base URL
 * the user typed and a model id is whatever that service returned. The vendor
 * behind a row is therefore *guessed*, in this order:
 *
 *   1. the model id   — the only reliable signal on an aggregator (OpenRouter,
 *                       SiliconFlow serve every vendor from one host)
 *   2. the host       — reliable on a dedicated endpoint (api.deepseek.com)
 *   3. the endpoint's display name — the user often types the vendor there
 *
 * An unrecognised row keeps the app's own book mark (`XiaoQingMark`, the icon's
 * open book). A wrong logo is worse than no logo: it tells the user they are
 * talking to a service they are not.
 *
 * Artwork: @lobehub/icons-static-svg v1.98.0, MIT licensed. Imported as raw
 * markup rather than through <img>, because the mono marks are authored with
 * `fill="currentColor"` and must inherit the theme colour — as an image they
 * would paint black and disappear on a dark theme. Each file is 0.5–6KB and
 * only the ones mapped below are bundled (~20KB total).
 *
 * The files are in `src/assets/logos/`. Re-fetch from
 * `https://unpkg.com/@lobehub/icons-static-svg@<version>/icons/<name>.svg`.
 */
import deepseekSvg from "@/assets/logos/deepseek.svg?raw";
import openaiSvg from "@/assets/logos/openai.svg?raw";
import claudeSvg from "@/assets/logos/claude.svg?raw";
import geminiSvg from "@/assets/logos/gemini.svg?raw";
import qwenSvg from "@/assets/logos/qwen.svg?raw";
import kimiSvg from "@/assets/logos/moonshot.svg?raw";
import glmSvg from "@/assets/logos/zhipu.svg?raw";
import doubaoSvg from "@/assets/logos/doubao.svg?raw";
import mimoSvg from "@/assets/logos/xiaomimimo.svg?raw";
import mistralSvg from "@/assets/logos/mistral.svg?raw";
import llamaSvg from "@/assets/logos/meta.svg?raw";
import ollamaSvg from "@/assets/logos/ollama.svg?raw";
import siliconCloudSvg from "@/assets/logos/siliconcloud.svg?raw";
import openRouterSvg from "@/assets/logos/openrouter.svg?raw";

export interface ModelBrand {
  key: string;
  /** Shown as the icon's accessible name and tooltip. */
  label: string;
  /** Raw `<svg>` markup of the brand mark. */
  mark: string;
}

interface BrandRule extends ModelBrand {
  /** Matched against the model id, case-insensitively. */
  model: RegExp;
  /** Matched against the endpoint host (no scheme, no path). */
  host: RegExp;
  /** Matched against the endpoint's user-visible name. */
  name: RegExp;
}

/**
 * Ordered rules. Model ids are checked for every rule before any host is, so
 * `anthropic/claude-*` on OpenRouter reports Claude rather than OpenRouter —
 * the aggregator is the plumbing, the vendor is the answer. Host fallbacks are
 * deliberately specific (`deepseek.com`, not `deepseek`) so a proxy host that
 * merely contains the word cannot claim a row.
 */
const BRAND_RULES: BrandRule[] = [
  {
    key: "deepseek",
    label: "DeepSeek",
    mark: deepseekSvg,
    model: /deepseek/i,
    host: /(^|\.)deepseek\.com$/i,
    name: /deepseek/i,
  },
  {
    key: "claude",
    label: "Claude",
    mark: claudeSvg,
    model: /claude|anthropic/i,
    host: /(^|\.)anthropic\.com$/i,
    name: /claude|anthropic/i,
  },
  {
    key: "gemini",
    label: "Gemini",
    mark: geminiSvg,
    model: /gemini|learnlm|palm-?2/i,
    host: /(^|\.)generativelanguage\.googleapis\.com$/i,
    name: /gemini|google/i,
  },
  {
    key: "qwen",
    label: "通义千问",
    mark: qwenSvg,
    model: /(^|[/_-])qwen|qwq|qvq/i,
    host: /dashscope|(^|\.)aliyuncs\.com$/i,
    name: /通义|qwen|dashscope/i,
  },
  {
    key: "kimi",
    label: "Kimi",
    mark: kimiSvg,
    model: /(^|[/_-])(kimi|moonshot)|moonshot-/i,
    host: /(^|\.)moonshot\.(cn|ai)$/i,
    name: /kimi|moonshot|月之暗面/i,
  },
  {
    key: "glm",
    label: "智谱 GLM",
    mark: glmSvg,
    model: /(^|[/_-])glm|charglm|codegeex/i,
    host: /(^|\.)bigmodel\.cn$|zhipu/i,
    name: /glm|智谱|zhipu/i,
  },
  {
    key: "doubao",
    label: "豆包",
    mark: doubaoSvg,
    model: /(^|[/_-])doubao|seed-|(^|[/_-])ep-/i,
    host: /(^|\.)volces\.com$|bytedance/i,
    name: /豆包|doubao|火山/i,
  },
  {
    key: "mimo",
    label: "小米 MiMo",
    mark: mimoSvg,
    model: /(^|[/_-])mimo/i,
    host: /(^|\.)xiaomimimo\.com$/i,
    name: /mimo|小米/i,
  },
  {
    key: "mistral",
    label: "Mistral",
    mark: mistralSvg,
    model: /mistral|codestral|pixtral|magistral/i,
    host: /(^|\.)mistral\.ai$/i,
    name: /mistral/i,
  },
  {
    key: "llama",
    label: "Llama",
    mark: llamaSvg,
    model: /llama/i,
    host: /(^|\.)meta\.com$/i,
    name: /llama|meta/i,
  },
  {
    key: "openai",
    label: "OpenAI",
    mark: openaiSvg,
    // `o1`…`o4` must end the token, otherwise `ollama3` would be claimed.
    model: /^(gpt|chatgpt|davinci|text-embedding|o[1-4]([-_.]|$))/i,
    host: /(^|\.)openai\.com$/i,
    name: /openai|gpt/i,
  },
  {
    key: "siliconcloud",
    label: "SiliconCloud",
    mark: siliconCloudSvg,
    model: /siliconflow/i,
    host: /(^|\.)siliconflow\.(cn|com)$/i,
    name: /siliconflow|siliconcloud|硅基/i,
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    mark: openRouterSvg,
    model: /openrouter/i,
    host: /(^|\.)openrouter\.ai$/i,
    name: /openrouter/i,
  },
  {
    key: "ollama",
    label: "Ollama",
    mark: ollamaSvg,
    model: /^ollama/i,
    host: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i,
    name: /ollama/i,
  },
];

/** Host without scheme/port noise; empty when the URL cannot be parsed. */
function hostOf(baseUrl: string): string {
  if (!baseUrl) return "";
  try {
    return new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).host
      .toLowerCase();
  } catch {
    return "";
  }
}

export interface BrandLookup {
  /** Wire model id, e.g. `deepseek-chat` or `anthropic/claude-3.5-sonnet`. */
  modelId: string;
  baseUrl?: string;
  endpointName?: string;
}

/**
 * Resolve the vendor mark for one model row. Returns `null` when nothing
 * matches — callers fall back to the app's book mark rather than guessing.
 */
export function resolveModelBrand({ modelId, baseUrl, endpointName }: BrandLookup): ModelBrand | null {
  const host = hostOf(baseUrl ?? "");
  for (const rule of BRAND_RULES) {
    if (rule.model.test(modelId)) return rule;
  }
  if (host) {
    for (const rule of BRAND_RULES) {
      if (rule.host.test(host)) return rule;
    }
  }
  if (endpointName) {
    for (const rule of BRAND_RULES) {
      if (rule.name.test(endpointName)) return rule;
    }
  }
  return null;
}

/**
 * Look a brand up by the key stored on a message. Returns `null` for unknown
 * keys (an old transcript, or a brand removed from the table) so callers fall
 * back to the app's own mark.
 */
export function brandByKey(key: string | undefined): ModelBrand | null {
  if (!key) return null;
  return BRAND_RULES.find((rule) => rule.key === key) ?? null;
}

/**
 * Drop the embedded `<title>`: the wrapper already carries the accessible
 * name, and a nested title makes screen readers announce it twice.
 */
export function brandMarkMarkup(brand: ModelBrand): string {
  return brand.mark.replace(/<title>[\s\S]*?<\/title>/i, "");
}
