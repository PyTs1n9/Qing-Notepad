/**
 * Empty-transcript copy for the AI sidebar.
 *
 * The panel used to greet every channel with the same line ("你好，我是小青…").
 * That is only true for the local retrieval model: with an API model selected it
 * named an assistant that is not the one answering, and it hid which service the
 * question and the retrieved note snippets are about to be sent to. The copy is
 * therefore resolved from the current selection:
 *
 *   local                      → the fixed 小青 line, unchanged
 *   endpoint model + key       → names the channel and the model that answers
 *   endpoint model without key → says what is missing, instead of pretending
 *                                the channel is ready
 *
 * Pure on purpose: the caller passes the selection plus the endpoint facts it
 * already renders in the header, so the rule lives in one readable place and
 * needs no store access.
 */
import { t, tWithParams } from "@/utils/i18n";
import type { LangType } from "@/stores/settingsStore";
import { LOCAL_SELECTION, parseSelection } from "@/utils/ai/chat/endpoints";

export interface AiEmptyGreetingInput {
  lang: LangType;
  /** Persisted selection: `local`, or `<endpointId>::<modelId>`. */
  chatModel: string;
  /** User-visible endpoint name, when the selection still resolves. */
  endpointName?: string;
  /** Vendor label resolved from the model id / host / endpoint name. */
  brandLabel?: string | null;
  /** Whether the selected endpoint has an API key on this machine. */
  hasKey: boolean;
}

/**
 * A blank endpoint name is normalized to its base URL on load (`normalizeEndpoint`),
 * so "no name" arrives here as `https://api.deepseek.com`. Printing that inside a
 * sentence is a display bug, not a channel name - it is treated as missing.
 */
const URL_LIKE = /^(https?:\/\/|[\w-]+(\.[\w-]+)+(:\d+)?(\/|$))/i;

/**
 * What the sentence calls the channel. Never the endpoint id (a uuid) and never
 * a bare URL: endpoint name → vendor label → a neutral "untitled endpoint".
 */
function channelLabelOf(
  endpointName: string | undefined,
  brandLabel: string | null | undefined,
  lang: LangType,
): string {
  const name = endpointName?.trim();
  if (name && !URL_LIKE.test(name)) return name;
  const brand = brandLabel?.trim();
  if (brand) return brand;
  return t(lang, "aiEndpointUntitled");
}

/**
 * What the sentence calls the model. Aggregators address models by vendor path
 * (`Pro/deepseek-ai/DeepSeek-V3`), which is a wire identifier rather than a name;
 * the last segment is the part a person recognises.
 */
function modelLabelOf(modelId: string): string {
  const id = modelId.trim();
  const segments = id.split("/").filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 1] : id;
}

export function aiEmptyGreeting({
  lang,
  chatModel,
  endpointName,
  brandLabel,
  hasKey,
}: AiEmptyGreetingInput): string {
  if (chatModel === LOCAL_SELECTION) return t(lang, "aiGreeting");

  const selected = parseSelection(chatModel);
  // `chatModel` is normalized on load and whenever endpoints change, so an
  // unparsable value should not exist — if it somehow does, point at the place
  // that fixes it rather than naming a phantom channel.
  if (!selected) return t(lang, "aiModelNoEndpoint");

  // A deleted endpoint leaves a dangling selection for one render: name the
  // best thing still known (its old name, the vendor label) instead of printing
  // a uuid or the raw model id twice.
  const channel = channelLabelOf(endpointName, brandLabel, lang);
  const model = modelLabelOf(selected.modelId);

  if (!hasKey) return tWithParams(lang, "aiEmptyGreetingNoKey", { channel });

  // The two-slot sentence needs two different names. When the channel resolves
  // to the model id itself (an endpoint the user never named), it would read
  // "当前由 glm-4 的 glm-4 作答" — say it once instead.
  if (channel.toLowerCase() === model.toLowerCase()) {
    return tWithParams(lang, "aiEmptyGreetingModel", { model });
  }

  return tWithParams(lang, "aiEmptyGreetingApi", {
    channel,
    model,
  });
}
