import { create } from "zustand";
import {
  loadAiCredentialCipher,
  loadAiEndpointKeyCiphers,
  loadAiEndpoints,
  loadAiPreferences,
  saveAiEndpointKeyCiphers,
  saveAiEndpoints,
  saveAiPreferences,
  loadAiConversations,
  deleteAiConversation,
  saveAiConversation,
  type StoredAiChatMessage,
  type StoredAiConversation,
  type StoredAiPreferences,
} from "@/utils/storage";
import {
  AiError,
  decryptSecret,
  encryptSecret,
  type AiErrorCode,
  type ChatMessage,
  type ChatProvider,
  type ThinkingLevel,
} from "@/utils/ai/provider";
import { getChatProvider, syncChatProviders } from "@/utils/ai/chat";
import {
  guessSupportsThinking,
  LOCAL_SELECTION,
  channelOf,
  makeSelection,
  normalizeBaseUrl,
  parseSelection,
  type AiEndpoint,
  type EndpointModel,
} from "@/utils/ai/chat/endpoints";
import { fetchRemoteModels } from "@/utils/ai/chat/modelsApi";
import { resolveModelBrand } from "@/utils/ai/modelBrand";
import { searchKnowledge, type ManualHit } from "@/utils/ai/knowledgeRetrieval";
import { latestSessionIn, adoptChannel } from "@/utils/ai/conversationScope";
import { composeLocalAnswerFromHit } from "@/utils/ai/answerComposer";
import { detectSmallTalk } from "@/utils/ai/smallTalk";
import { t } from "@/utils/i18n";
import {
  buildNoteDirectory,
  executeNoteTool,
  NOTE_WRITE_TOOLS,
  undoNoteEdit,
  type AiNoteEdit,
} from "@/utils/ai/noteWrite";
import type { ChatToolCall } from "@/utils/ai/chat/types";
import { withTimeout } from "@/utils/ai/http";
import { warmUpVectorIndex } from "@/utils/ai/vectorIndex";
import { useSettingsStore, type LangType } from "@/stores/settingsStore";

/** Chat routing: "local" = 小青 knowledge-base mode, else "<endpointId>::<modelId>". */
export const LOCAL_MODEL_ID = LOCAL_SELECTION;
/** Deadline for one "模型搜索" round trip in 设置 → AI 接口. */
const KEY_TEST_TIMEOUT_MS = 15_000;
/**
 * Seed model for the one-time migration off the old built-in DeepSeek preset:
 * before endpoints existed, the app hard-coded this id, so an existing install
 * keeps answering after the upgrade without re-searching its model list.
 */
const LEGACY_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const LEGACY_DEEPSEEK_MODEL = "deepseek-flash";
/**
 * Output budget per turn. 2048 was routinely eaten by reasoning tokens on
 * thinking models, truncating the visible answer without any signal; 4096
 * leaves room for thinking plus a full reply. Truncation is still possible and
 * is now reported (`truncated`), never silent.
 */
const MAX_ANSWER_TOKENS = 4_096;

/** Coarse stage of a turn, shown while the answer text is still empty. */
export type AiTurnPhase = "retrieving" | "thinking" | "writing";

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Thinking/reasoning stream from the model (thinking models only). */
  reasoning?: string;
  /** Manual chunks retrieved for this turn; rendered as source cards. */
  hits: ManualHit[];
  streaming?: boolean;
  /** Set when the turn failed; `content` may hold partial output. */
  errorCode?: AiErrorCode;
  /** Note writes this turn performed (full-permission mode); undo targets. */
  edits?: AiNoteEdit[];
  /** The turn hit `max_tokens`: the answer shown is cut off. */
  truncated?: boolean;
  /** Current stage of a streaming turn; cleared once text starts arriving. */
  phase?: AiTurnPhase;
  /**
   * Vendor mark of the model that produced this answer, snapshotted when the
   * turn starts. Stored rather than re-derived on render: the user can switch
   * models mid-conversation, and an old answer must keep the logo of the model
   * that actually wrote it.
   */
  brandKey?: string;
  /** Creation time (ms since epoch), shown on hover in the sidebar. */
  createdAt: number;
}

/** Note-write permission mode for the chat assistant. */
export type NoteWriteMode = "readonly" | "full";

export interface AiConversation {
  id: string;
  title: string;
  /**
   * Channel that owns this session: the endpoint id, or `null` for 小青.
   * Sessions are scoped to a channel, selections are not — switching models
   * inside one endpoint keeps the session, switching endpoints leaves it.
   */
  endpointId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: StoredAiChatMessage[];
}

export interface PolishSession {
  id: string;
  noteId: string;
  /** The passage captured from the editor selection at entry time. */
  originalText: string;
  /**
   * Write the rewrite back through the editor's own change path. Returns
   * false when the underlying text changed since the selection was captured,
   * in which case nothing was written.
   */
  apply: (newText: string) => boolean;
  /** Reverse the last apply. */
  undo: () => void;
}

export type AiKeyStatus = "idle" | "saving" | "fetching";

/** A failed "模型搜索" (or key save) for one endpoint, shown inline in settings. */
export interface AiEndpointError {
  code: AiErrorCode;
  detail: string | null;
}

let abortController: AbortController | null = null;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Vendor mark behind the current selection, snapshotted onto a new assistant
 * message. Resolved once when the turn starts, never on render — switching
 * models mid-conversation must not repaint older answers with the new logo.
 */
function brandKeyForSelection(
  chatModel: string,
  endpoints: AiEndpoint[],
): string | undefined {
  const selected = parseSelection(chatModel);
  if (!selected) return undefined;
  const endpoint = endpoints.find((item) => item.id === selected.endpointId);
  return resolveModelBrand({
    modelId: selected.modelId,
    baseUrl: endpoint?.baseUrl,
    endpointName: endpoint?.name,
  })?.key;
}

interface AiState {
  /**
   * User-owned chat endpoints (设置 → AI 接口). Empty on a fresh install: the
   * app ships no vendor preset, so nothing can answer until one is added.
   */
  endpoints: AiEndpoint[];
  /**
   * endpointId → plain key. Memory only, never persisted as-is; each key is
   * encrypted into `data/ai/endpoint-keys.json` separately.
   */
  endpointKeys: Record<string, string>;
  endpointStatus: Record<string, AiKeyStatus>;
  endpointError: Record<string, AiEndpointError | undefined>;
  loaded: boolean;
  sidebarOpen: boolean;
  lastErrorCode: AiErrorCode | null;
  lastErrorDetail: string | null;
  messages: AiChatMessage[];
  sending: boolean;
  polish: PolishSession | null;
  polishApplied: boolean;
  /** Selected chat target: `LOCAL_MODEL_ID` or `"<endpointId>::<modelId>"`. */
  chatModel: string;
  /** Selected 润色 target, same shape as `chatModel` (never local). */
  polishModel: string;
  /** Saved conversations (snapshot copies; the live view is `messages`). */
  conversations: AiConversation[];
  /** Conversation the live `messages` belong to; null = unsaved fresh chat. */
  activeConversationId: string | null;
  /** Note-write permission: "readonly" (assistant only) or "full" (may edit). */
  noteWriteMode: NoteWriteMode;
  /** Reasoning depth sent with every generative request (default "low"). */
  thinkingLevel: ThinkingLevel;

  hydrate: () => Promise<void>;
  /** Add an endpoint (optionally seeded from a preset) and return its id. */
  addEndpoint: (preset?: { name: string; baseUrl: string }) => string;
  updateEndpoint: (id: string, patch: { name?: string; baseUrl?: string }) => void;
  removeEndpoint: (id: string) => Promise<void>;
  saveEndpointKey: (id: string, plain: string) => Promise<boolean>;
  clearEndpointKey: (id: string) => Promise<void>;
  /**
   * Fetch `GET {baseUrl}/models` and merge the result into the endpoint's model
   * list. Newly discovered models arrive **unticked** — the user decides what
   * shows up in the chat bar (that is the whole point of 允许使用).
   */
  fetchEndpointModels: (id: string) => Promise<boolean>;
  toggleEndpointModel: (id: string, modelId: string) => void;
  setEndpointModelThinking: (id: string, modelId: string, value: boolean) => void;
  setNoteWriteMode: (mode: NoteWriteMode) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  /** Roll back the note writes recorded on an assistant message (reverse order). */
  undoMessageEdits: (messageId: string) => Promise<void>;
  recordError: (error: unknown) => void;
  clearError: () => void;
  setSidebarOpen: (open: boolean) => void;
  setChatModel: (modelId: string) => void;
  setPolishModel: (modelId: string) => void;
  sendMessage: (text: string) => Promise<void>;
  stopGenerating: () => void;
  clearChat: () => void;
  /** Start a fresh chat; the current one is saved (or dropped when empty). */
  newConversation: () => void;
  /** Switch to a saved conversation; the current one is saved first. */
  switchConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  /** Delete a message together with its paired counterpart (question + answer). */
  deleteMessage: (id: string) => void;
  /**
   * Re-ask the question that produced the given assistant message. The new
   * reply is appended right after the old one so both stay comparable.
   */
  regenerate: (assistantId: string) => Promise<void>;
  startPolish: (session: Omit<PolishSession, "id">) => void;
  setPolishApplied: (applied: boolean) => void;
  cancelPolish: () => void;
}

function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof Error) return new AiError("network", error.message);
  return new AiError("network", String(error));
}

/** A selection that resolved to a live provider, endpoint, model and key. */
export interface ResolvedSelection {
  provider: ChatProvider;
  endpoint: AiEndpoint;
  model: string;
  apiKey: string;
  supportsThinking: boolean;
}

/**
 * Turn a stored `"<endpointId>::<modelId>"` into everything a request needs.
 * Returns null for 小青 (`"local"`) and for a selection whose endpoint or model
 * disappeared, so callers never hand a phantom model to the API.
 */
function resolveSelection(
  state: Pick<AiState, "endpoints" | "endpointKeys">,
  selection: string,
): ResolvedSelection | null {
  const parsed = parseSelection(selection);
  if (!parsed) return null;
  const endpoint = state.endpoints.find((item) => item.id === parsed.endpointId);
  if (!endpoint) return null;
  const model = endpoint.models.find(
    (item) => item.id === parsed.modelId && item.enabled,
  );
  if (!model) return null;
  const provider = getChatProvider(parsed.endpointId);
  if (!provider) return null;
  return {
    provider,
    endpoint,
    model: model.id,
    apiKey: state.endpointKeys[endpoint.id] ?? "",
    supportsThinking: model.supportsThinking,
  };
}

/** First enabled model of the first endpoint that has one (null when none). */
function firstEnabledModel(endpoints: AiEndpoint[]): string | null {
  for (const endpoint of endpoints) {
    const model = endpoint.models.find((item) => item.enabled);
    if (model) return makeSelection(endpoint.id, model.id);
  }
  return null;
}

/**
 * Validate a persisted selection against the configured endpoints.
 *
 * Pre-endpoint builds stored a bare provider id (`"deepseek"`) or `"local"`;
 * the former is remapped to that endpoint's first enabled model so an upgrade
 * does not silently drop the user back to 小青. A selection whose model was
 * later unticked falls back to the same endpoint's first enabled model rather
 * than a different service entirely.
 */
function normalizeChatModel(value: unknown, endpoints: AiEndpoint[]): string {
  if (value === LOCAL_MODEL_ID) return LOCAL_MODEL_ID;
  if (typeof value === "string" && value) {
    const parsed = parseSelection(value);
    if (parsed) {
      const endpoint = endpoints.find((item) => item.id === parsed.endpointId);
      if (endpoint) {
        const model = endpoint.models.find(
          (item) => item.id === parsed.modelId && item.enabled,
        );
        if (model) return value;
        const fallback = endpoint.models.find((item) => item.enabled);
        if (fallback) return makeSelection(endpoint.id, fallback.id);
      }
    } else {
      // Legacy provider id or an endpoint name.
      const legacy = endpoints.find(
        (item) => item.id === value || item.name === value,
      );
      const model = legacy?.models.find((item) => item.enabled);
      if (legacy && model) return makeSelection(legacy.id, model.id);
    }
  }
  return firstEnabledModel(endpoints) ?? LOCAL_MODEL_ID;
}

/** Same validation for 润色, which has no local option: "" means "not chosen". */
function normalizePolishModel(value: unknown, endpoints: AiEndpoint[]): string {
  const resolved = normalizeChatModel(value, endpoints);
  return resolved === LOCAL_MODEL_ID ? (firstEnabledModel(endpoints) ?? "") : resolved;
}

/** Snapshot of the AI preference bag; kept whole so partial sets never drop fields. */
function persistPreferences(state: AiState): Promise<void> {
  return saveAiPreferences({
    chatModel: state.chatModel,
    polishModel: state.polishModel,
    noteWriteMode: state.noteWriteMode,
    thinkingLevel: state.thinkingLevel,
  } satisfies StoredAiPreferences);
}

/** Persist endpoints and rebuild the provider registry from them. */
function commitEndpoints(
  set: StoreSet,
  endpoints: AiEndpoint[],
  extra: Partial<AiState> = {},
): void {
  syncChatProviders(endpoints);
  set({ endpoints, ...extra } as Partial<AiState>);
  void saveAiEndpoints(endpoints);
}

/** Persisted mode is validated; anything unknown falls back to read-only. */
function normalizeNoteWriteMode(value: unknown): NoteWriteMode {
  return value === "full" ? "full" : "readonly";
}

/**
 * Reasoning depth defaults to "low": the API's own default is enabled/high,
 * which spent most of the 4096-token budget on CoT and truncated answers.
 * An unknown persisted value falls back to that same safe default.
 */
function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return value === "off" || value === "high" ? value : "low";
}

/**
 * "小青" local answer: the best hit only, with its section heading as a
 * lead-in line. One question, one streamed answer — never a pile of excerpt
 * cards.
 *
 * The hit is assembled by `answerComposer`, which reshapes the same excerpt
 * according to what was asked (steps / location / verdict / definition) so two
 * different questions about one section no longer produce identical text.
 *
 * 寒暄与身份询问没有可检索的对象，先由 `detectSmallTalk` 接走，用固定话术说明
 * 「离线检索、不会闲聊」，而不是把某段手册正文当成自我介绍。
 */
function composeLocalAnswer(hits: ManualHit[], question: string, lang: LangType): string {
  const smallTalk = detectSmallTalk(question);
  if (smallTalk) {
    return t(lang, smallTalk === "identity" ? "aiSmallTalkIdentity" : "aiSmallTalkGreeting");
  }
  return composeLocalAnswerFromHit(hits, question);
}

/** Retarget a streaming turn's stage label (retrieval → search → thinking → write). */
function setPhase(
  set: StoreSet,
  assistantId: string,
  phase: AiTurnPhase | undefined,
): void {
  set((state) => ({
    messages: state.messages.map((m) => (m.id === assistantId ? { ...m, phase } : m)),
  }));
}

/**
 * Reveal `text` in paced deltas so the local answer types out through the
 * same streaming pipeline as a model reply instead of snapping in. Honors
 * the shared abort signal so 停止 cuts it like a generation.
 */
const LOCAL_STREAM_MS_PER_CHAR = 8;
const LOCAL_STREAM_MIN_MS = 600;
const LOCAL_STREAM_MAX_MS = 2400;
const LOCAL_STREAM_TICK_MS = 24;

function pacedStreamText(
  text: string,
  signal: AbortSignal,
  onDelta: (delta: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (!text || signal.aborted) {
      resolve();
      return;
    }
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      onDelta(text);
      resolve();
      return;
    }
    const duration = Math.min(
      Math.max(text.length * LOCAL_STREAM_MS_PER_CHAR, LOCAL_STREAM_MIN_MS),
      LOCAL_STREAM_MAX_MS,
    );
    const totalTicks = Math.max(1, Math.round(duration / LOCAL_STREAM_TICK_MS));
    let tick = 0;
    let offset = 0;
    const timer = setInterval(() => {
      if (signal.aborted) {
        clearInterval(timer);
        resolve();
        return;
      }
      tick += 1;
      const end = Math.min(
        text.length,
        Math.ceil((tick / totalTicks) * text.length),
      );
      if (end > offset) {
        onDelta(text.slice(offset, end));
        offset = end;
      }
      if (tick >= totalTicks || offset >= text.length) {
        clearInterval(timer);
        resolve();
      }
    }, LOCAL_STREAM_TICK_MS);
  });
}

const CONVERSATION_TITLE_MAX = 30;

/** One-line first-question title, truncated for the history list. */
function conversationTitleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > CONVERSATION_TITLE_MAX
    ? `${oneLine.slice(0, CONVERSATION_TITLE_MAX)}…`
    : oneLine;
}

/**
 * Upsert the active conversation from the live `messages` and persist it.
 * Streaming flags are stripped so a restored session never renders a stale
 * "streaming" bubble. Only this conversation's shard is written — the history
 * list is not rewritten on every turn.
 */
function syncConversations(set: StoreSet, get: StoreGet): void {
  const { conversations, activeConversationId, messages } = get();
  if (!activeConversationId) return;
  const snapshot = messages.map(
    (m) => ({ ...m, streaming: false, phase: undefined }) as unknown as StoredAiChatMessage,
  );
  const now = Date.now();
  const existing = conversations.find((c) => c.id === activeConversationId);
  const active: AiConversation = existing
    ? { ...existing, messages: snapshot, updatedAt: now }
    : {
        id: activeConversationId,
        title: "",
        // A session is born in the channel that is answering: that id is what
        // decides who may see it later.
        endpointId: channelOf(get().chatModel),
        createdAt: now,
        updatedAt: now,
        messages: snapshot,
      };
  const next = existing
    ? conversations.map((c) => (c.id === activeConversationId ? active : c))
    : [...conversations, active];
  set({ conversations: next });
  void saveAiConversation(active);
}

/** Persist-or-drop the current conversation when leaving it. */
function stashActiveConversation(set: StoreSet, get: StoreGet): void {
  const { activeConversationId, messages } = get();
  if (!activeConversationId) return;
  if (messages.length > 0) {
    syncConversations(set, get);
    return;
  }
  // Empty chat: dropped, never listed.
  const next = get().conversations.filter((c) => c.id !== activeConversationId);
  set({ conversations: next });
  void deleteAiConversation(activeConversationId);
}

/** Most recently updated session of one channel (null = 小青). */
function latestConversationIn(
  conversations: AiConversation[],
  channel: string | null,
): AiConversation | null {
  return latestSessionIn(conversations, channel);
}

/** Stored messages → live messages; a restored session never renders streaming. */
function restoreMessages(conversation: AiConversation): AiChatMessage[] {
  return conversation.messages.map((m) => ({ ...m, streaming: false }) as AiChatMessage);
}

/**
 * Selection that can answer in `channel`, reusing the current model when it
 * already belongs to that endpoint. Used when a session dictates the channel
 * (opening a 小青 session from an endpoint channel must switch back to 小青).
 */
function modelForChannel(
  state: Pick<AiState, "chatModel" | "endpoints">,
  channel: string | null,
): string {
  if (channel === null) return LOCAL_MODEL_ID;
  if (channelOf(state.chatModel) === channel) return state.chatModel;
  const endpoint = state.endpoints.find((item) => item.id === channel);
  const model = endpoint?.models.find((item) => item.enabled);
  return model ? makeSelection(channel, model.id) : LOCAL_MODEL_ID;
}

/**
 * Move to another channel: persist-or-drop the session being left, then land in
 * the target channel's most recent session (blank when it has none). Models move
 * inside a channel without touching the session, which is why only a channel
 * change routes through here.
 */
function enterChannel(set: StoreSet, get: StoreGet, chatModel: string): void {
  if (get().sending) get().stopGenerating();
  stashActiveConversation(set, get);
  const target = latestConversationIn(get().conversations, channelOf(chatModel));
  set({
    chatModel,
    activeConversationId: target?.id ?? null,
    messages: target ? restoreMessages(target) : [],
  });
  void persistPreferences(get());
}

/**
 * Fold the pre-channel files into the current model.
 *
 * A file without `endpointId` predates channels and is *not* a 小青 session
 * (`null` is): it belonged to whatever channel the user was on, and assigning it
 * to 小青 would make an API user's whole history disappear from their channel.
 * Only the missing field is written, so the rewrite happens exactly once.
 */
async function adoptStoredConversations(
  stored: StoredAiConversation[],
  channel: string | null,
): Promise<AiConversation[]> {
  const adopted: AiConversation[] = [];
  for (const raw of stored) {
    const { endpointId, needsWrite } = adoptChannel(raw, channel);
    const conversation: AiConversation = {
      id: raw.id,
      title: raw.title ?? "",
      endpointId,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      messages: raw.messages,
    };
    if (needsWrite) void saveAiConversation(conversation);
    adopted.push(conversation);
  }
  return adopted;
}

type StoreSet = (
  partial: Partial<AiState> | ((state: AiState) => Partial<AiState>),
) => void;
type StoreGet = () => AiState;

/**
 * Run one assistant turn into the message `assistantId` (already appended as
 * a streaming placeholder). Shared by sendMessage and regenerate.
 *
 * History is everything *before* this turn's question (`questionIndex`): the
 * question is re-sent below together with the retrieved context, so keeping it
 * in the history slice would put the same text in the prompt twice — and on
 * regenerate it would also replay the answer being replaced.
 */
async function runGeneration(
  assistantId: string,
  question: string,
  hits: ManualHit[],
  questionIndex: number,
  controller: AbortController,
  set: StoreSet,
  get: StoreGet,
): Promise<void> {
  const all = get().messages;
  const placeholderIndex = all.findIndex((m) => m.id === assistantId);
  const cut = placeholderIndex >= 0 ? Math.min(questionIndex, placeholderIndex) : questionIndex;
  const history: ChatMessage[] = all
    .slice(0, Math.max(cut, 0))
    .filter(
      (m) =>
        !m.errorCode &&
        (m.role === "user" || (m.role === "assistant" && m.content.trim())),
    )
    .slice(-6)
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
      // Replayed because DeepSeek requires every earlier turn's CoT once the
      // request carries `tools`; harmless when it does not.
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    }));

  abortController = controller;
  const lang = useSettingsStore.getState().lang;

  // Route by the chat-bar picker. The selection names both the endpoint and the
  // model, so an endpoint that was deleted (or a model that was unticked) falls
  // back to 小青 instead of dead-ending a request against a phantom model.
  const selected = get().chatModel;
  const resolved = selected === LOCAL_MODEL_ID ? null : resolveSelection(get(), selected);
  const provider = resolved?.provider ?? null;

  // "小青" local mode. Stream the best retrieval hit as typed text
  // through the same message pipeline a model reply uses — no cards.
  if (!provider || !resolved) {
    const answer = composeLocalAnswer(hits, question, lang);
    try {
      await pacedStreamText(answer, controller.signal, (delta) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + delta } : m,
          ),
        })),
      );
    } finally {
      if (abortController === controller) abortController = null;
      set((state) => ({
        sending: false,
        messages: state.messages.map((m) =>
          m.id === assistantId ? { ...m, streaming: false, phase: undefined } : m,
        ),
      }));
      syncConversations(set, get);
    }
    return;
  }

  const { apiKey } = resolved;

  // API model selected but this endpoint has no key yet: fail the turn with the
  // missing-key code so the UI can point at 设置.
  if (!apiKey) {
    set((state) => ({
      sending: false,
      messages: state.messages.map((m) =>
        m.id === assistantId
          ? { ...m, streaming: false, errorCode: "missing-key" as AiErrorCode }
          : m,
      ),
    }));
    if (abortController === controller) abortController = null;
    return;
  }

  // Note-write permission: `noteWriteMode` is the **only** gate. There is no
  // per-endpoint tool switch on purpose — the permission layer owns this
  // decision (docs/decisions-ai-note-write.md), and an endpoint that cannot
  // honour `tools` will say so in its own error instead of being pre-judged.
  const writeMode = get().noteWriteMode === "full";

  const systemContent =
    lang === "zh"
      ? "你是「小青」，桌面应用「青记」的内置助手。回答软件使用问题时优先依据【知识库】参考片段，不要编造界面中不存在的功能；片段未覆盖时如实说明。知识库片段包含用户笔记、待办与画布内容，可据此回答「我记过什么」这类问题。回答用中文，简洁、分步骤。" +
        (writeMode
          ? `\n\n用户已开启「完全开放」笔记权限：你可以用工具直接读取并修改笔记正文与标题，修改立即生效、用户可撤销。修改前必须先用 read_note 读取原文，在原文基础上改动后用 update_note_content 输出完整正文，绝不丢失原有内容；用 rename_note 改标题。不要删除笔记，也不要新建笔记。\n\n笔记目录（id：标题）附在本轮问题之后。`
          : "\n\n你不能修改用户笔记。当用户要求修改时，说明需要在编辑器中手动改，并把建议的文本用代码块给出方便复制。")
      : "You are XiaoQing, the built-in assistant of the Qing Notepad desktop app. For usage questions, answer from the 【知识库】 excerpts (they include the user's notes, todos and canvas text) and never invent UI that does not exist. Be concise and step-by-step." +
        (writeMode
          ? `\n\nThe user has granted full note permission: you may read and edit note bodies and titles through tools; edits take effect immediately and can be undone by the user. Always call read_note first and rewrite the complete body with update_note_content so nothing is lost; use rename_note for titles. Never delete or create notes.\n\nThe note directory (id: title) follows this turn's question.`
          : "\n\nYou cannot modify the user's notes. When asked to edit one, say the change has to be made in the editor and give the suggested text in a code block for copying.");
  const system: ChatMessage = {
    role: "system",
    content: systemContent,
  };
  const kbBlock = hits
    .map((hit) => `【${hit.chunk.heading || "概述"}】\n${hit.chunk.text}`)
    .join("\n\n");
  const references = kbBlock ? `知识库片段：\n${kbBlock}` : "";
  // Volatile data goes last on purpose. The note directory changes whenever a
  // title changes, and the retrieved block changes every turn; keeping both out
  // of the system prompt leaves that prefix byte-stable so the disk cache can
  // hit it (deepseek caches prefixes, not arbitrary spans).
  const directoryBlock = writeMode
    ? `\n\n【笔记目录】\n${buildNoteDirectory()}`
    : "";
  const user: ChatMessage = {
    role: "user",
    content:
      (references ? `${references}\n\n问题：${question}` : `问题：${question}`) +
      directoryBlock,
  };

  // Agent loop: at most MAX_TOOL_ROUNDS tool round trips, then the turn ends
  // whatever the model asks for — a runaway tool loop can never spin forever.
  const MAX_TOOL_ROUNDS = 3;
  const turnMessages: ChatMessage[] = [system, ...history, user];
  const tools = writeMode ? NOTE_WRITE_TOOLS : undefined;
  // One control decides this turn: the level resolves to the selected model plus
  // its reasoning wire fields (none at all for a model that cannot think).
  const target = provider.resolveTarget(get().thinkingLevel, resolved.model);
  const edits: AiNoteEdit[] = [];
  let truncated = false;

  try {
    for (let round = 0; ; round++) {
      let turnCalls: ChatToolCall[] = [];
      // Kept per round: the assistant message for *this* sub-request must carry
      // exactly the CoT it produced, not the accumulated message text.
      let roundReasoning = "";
      setPhase(set, assistantId, "thinking");
      const turnText = await provider.stream({
        apiKey,
        messages: turnMessages,
        // The model streams reasoning before content; a tight cap lets thinking
        // eat the budget and leaves the answer empty.
        maxTokens: MAX_ANSWER_TOKENS,
        signal: controller.signal,
        tools,
        model: target.model,
        thinking: target.thinking,
        reasoningEffort: target.reasoningEffort,
        onFinish: (reason) => {
          if (reason === "length") truncated = true;
        },
        onToolCalls: (calls) => {
          turnCalls = calls;
        },
        onDelta: (delta) =>
          set((state) => ({
            messages: state.messages.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + delta } : m,
            ),
          })),
        onReasoning: (delta) => {
          roundReasoning += delta;
          set((state) => ({
            messages: state.messages.map((m) =>
              m.id === assistantId
                ? { ...m, reasoning: (m.reasoning ?? "") + delta }
                : m,
            ),
          }));
        },
      });
      if (!turnCalls.length || !tools || round >= MAX_TOOL_ROUNDS) break;
      turnMessages.push({
        role: "assistant",
        content: turnText,
        toolCalls: turnCalls,
        ...(roundReasoning ? { reasoning: roundReasoning } : {}),
      });
      setPhase(set, assistantId, "writing");
      for (const call of turnCalls) {
        if (controller.signal.aborted) break;
        const result = await executeNoteTool(call);
        if (result.edit) edits.push(result.edit);
        turnMessages.push({
          role: "tool",
          content: result.output,
          toolCallId: call.id,
        });
      }
      if (controller.signal.aborted) break;
    }
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              streaming: false,
              phase: undefined,
              edits: edits.length ? edits : undefined,
              truncated: truncated || undefined,
            }
          : m,
      ),
    }));
  } catch (error) {
    const aiError = toAiError(error);
    set((state) => ({
      lastErrorCode: aiError.code,
      lastErrorDetail: aiError.detail ?? null,
      messages: state.messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              streaming: false,
              phase: undefined,
              errorCode: aiError.code,
            }
          : m,
      ),
    }));
  } finally {
    if (abortController === controller) abortController = null;
    set({ sending: false });
    syncConversations(set, get);
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  endpoints: [],
  endpointKeys: {},
  endpointStatus: {},
  endpointError: {},
  loaded: false,
  // Mirrors the left sidebar's default: the panel starts expanded. Only the
  // toggle hides it; a fresh launch always shows it again.
  sidebarOpen: true,
  lastErrorCode: null,
  lastErrorDetail: null,
  messages: [],
  sending: false,
  polish: null,
  polishApplied: false,
  chatModel: LOCAL_MODEL_ID,
  polishModel: "",
  noteWriteMode: "readonly",
  thinkingLevel: "low",
  conversations: [],
  activeConversationId: null,

  hydrate: async () => {
    if (get().loaded) return;
    // Start loading the embedding model in the background so the first
    // question already benefits from the semantic channel (progressive).
    // Never let it take the panel down with it: a missing/blocked model only
    // costs the semantic channel, which already falls back to BM25.
    try {
      warmUpVectorIndex();
    } catch (error) {
      console.warn("ai: vector warm-up failed", error);
    }
    // A failed read must not leave the store half-initialised — the guard above
    // would then refuse every later attempt and the settings panel would look
    // like it never loaded. Degrade to defaults instead, so the form stays
    // usable.
    let endpoints: AiEndpoint[] = [];
    let keyCiphers: Record<string, string> = {};
    let prefs: StoredAiPreferences = {};
    let savedConversations: StoredAiConversation[] = [];
    try {
      [endpoints, keyCiphers, prefs, savedConversations] = await Promise.all([
        loadAiEndpoints(),
        loadAiEndpointKeyCiphers(),
        loadAiPreferences(),
        loadAiConversations(),
      ]);
    } catch (error) {
      console.warn("ai: preferences load failed, using defaults", error);
    }

    // One-time migration off the old single-key builds: the app used to hard-code
    // the DeepSeek endpoint, so an existing install becomes one endpoint instead
    // of an empty settings page. The legacy blob is left on disk untouched —
    // deleting it would break a downgrade for no benefit.
    if (!endpoints.length) {
      const legacyCipher = await loadAiCredentialCipher();
      if (legacyCipher) {
        const id = newId();
        endpoints = [
          {
            id,
            name: "DeepSeek",
            baseUrl: LEGACY_DEEPSEEK_BASE_URL,
            createdAt: Date.now(),
            models: [
              {
                id: LEGACY_DEEPSEEK_MODEL,
                enabled: true,
                supportsThinking: guessSupportsThinking(LEGACY_DEEPSEEK_MODEL),
              },
            ],
          },
        ];
        keyCiphers = { [id]: legacyCipher };
        await saveAiEndpoints(endpoints);
        await saveAiEndpointKeyCiphers(keyCiphers);
      }
    }

    // Decrypt per endpoint: one unreadable blob (user or machine change) must
    // cost exactly that endpoint's key, not the whole configuration.
    const keys: Record<string, string> = {};
    for (const [id, cipher] of Object.entries(keyCiphers)) {
      try {
        keys[id] = await decryptSecret(cipher);
      } catch (error) {
        console.warn("ai: endpoint key unreadable, dropped", id, error);
      }
    }

    syncChatProviders(endpoints);

    const chatModel = normalizeChatModel(prefs.chatModel, endpoints);
    const conversations = await adoptStoredConversations(
      savedConversations,
      channelOf(chatModel),
    );

    // Re-open the most recently active session *of this channel* so a relaunch
    // continues where the user left off. Another channel's session must never be
    // restored: it would keep answering with the wrong service.
    const last = latestConversationIn(conversations, channelOf(chatModel));
    const restoredConv = last
      ? { activeConversationId: last.id, messages: restoreMessages(last) }
      : { activeConversationId: null, messages: [] as AiChatMessage[] };

    set({
      endpoints,
      endpointKeys: keys,
      loaded: true,
      chatModel,
      polishModel: normalizePolishModel(prefs.polishModel, endpoints),
      noteWriteMode: normalizeNoteWriteMode(prefs.noteWriteMode),
      thinkingLevel: normalizeThinkingLevel(prefs.thinkingLevel),
      conversations,
      ...restoredConv,
    });
  },

  addEndpoint: (preset) => {
    const id = newId();
    const endpoint: AiEndpoint = {
      id,
      name: preset?.name?.trim() || "新接口",
      baseUrl: normalizeBaseUrl(preset?.baseUrl ?? ""),
      createdAt: Date.now(),
      models: [],
    };
    commitEndpoints(set, [...get().endpoints, endpoint]);
    return id;
  },

  updateEndpoint: (id, patch) => {
    const endpoints = get().endpoints.map((endpoint) => {
      if (endpoint.id !== id) return endpoint;
      const next: AiEndpoint = { ...endpoint };
      if (patch.name !== undefined) next.name = patch.name.trim() || endpoint.name;
      if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl);
      return next;
    });
    commitEndpoints(set, endpoints);
  },

  removeEndpoint: async (id) => {
    const endpoints = get().endpoints.filter((endpoint) => endpoint.id !== id);
    const keys = { ...get().endpointKeys };
    delete keys[id];
    // Persist the trimmed key map *before* the store reflects it: a crash in
    // between must not leave an orphaned secret on disk for a row that is gone.
    await saveAiEndpointKeyCiphers(
      Object.fromEntries(
        await Promise.all(
          Object.entries(get().endpointKeys)
            .filter(([key]) => key !== id)
            .map(async ([key, plain]) => [key, await encryptSecret(plain)] as const),
        ),
      ),
    );
    // Sessions belong to their channel: removing the channel removes them, and
    // the confirmation in 设置 spells the cost out before this runs. Read after
    // the await above so a session started meanwhile is included.
    const doomed = get().conversations.filter((c) => c.endpointId === id);
    const remaining = get().conversations.filter((c) => c.endpointId !== id);
    const chatModel = normalizeChatModel(get().chatModel, endpoints);
    const activeDoomed = doomed.some((c) => c.id === get().activeConversationId);
    // Losing the channel the user was reading means landing somewhere valid: the
    // target channel's latest session, the same place a manual switch goes.
    let session: Partial<AiState> = {};
    if (activeDoomed || channelOf(chatModel) !== channelOf(get().chatModel)) {
      const target = latestConversationIn(remaining, channelOf(chatModel));
      session = {
        activeConversationId: target?.id ?? null,
        messages: target ? restoreMessages(target) : [],
      };
    }
    commitEndpoints(set, endpoints, {
      endpointKeys: keys,
      // A selection pointing at the deleted endpoint must not survive: it would
      // render a chip for a model that can never answer.
      chatModel,
      polishModel: normalizePolishModel(get().polishModel, endpoints),
      conversations: remaining,
      ...session,
    });
    for (const conversation of doomed) void deleteAiConversation(conversation.id);
    void persistPreferences(get());
  },

  saveEndpointKey: async (id, plain) => {
    const trimmed = plain.trim();
    if (!trimmed) {
      set((state) => ({
        endpointError: { ...state.endpointError, [id]: { code: "missing-key", detail: null } },
      }));
      return false;
    }
    set((state) => ({
      endpointStatus: { ...state.endpointStatus, [id]: "saving" },
      endpointError: { ...state.endpointError, [id]: undefined },
    }));
    try {
      const cipher = await encryptSecret(trimmed);
      const ciphers: Record<string, string> = {};
      for (const [key, value] of Object.entries(get().endpointKeys)) {
        ciphers[key] = key === id ? cipher : await encryptSecret(value);
      }
      ciphers[id] = cipher;
      await saveAiEndpointKeyCiphers(ciphers);
      const keys = { ...get().endpointKeys, [id]: trimmed };
      set((state) => ({
        endpointKeys: keys,
        endpointStatus: { ...state.endpointStatus, [id]: "idle" },
        loaded: true,
      }));
      return true;
    } catch (error) {
      const aiError = toAiError(error);
      set((state) => ({
        endpointStatus: { ...state.endpointStatus, [id]: "idle" },
        endpointError: {
          ...state.endpointError,
          [id]: { code: aiError.code, detail: aiError.detail ?? null },
        },
      }));
      return false;
    }
  },

  clearEndpointKey: async (id) => {
    const keys = { ...get().endpointKeys };
    delete keys[id];
    set({ endpointKeys: keys });
    const ciphers: Record<string, string> = {};
    for (const [key, value] of Object.entries(keys)) {
      ciphers[key] = await encryptSecret(value);
    }
    await saveAiEndpointKeyCiphers(ciphers);
  },

  fetchEndpointModels: async (id) => {
    const endpoint = get().endpoints.find((item) => item.id === id);
    if (!endpoint) return false;
    const key = get().endpointKeys[id] ?? "";
    set((state) => ({
      endpointStatus: { ...state.endpointStatus, [id]: "fetching" },
      endpointError: { ...state.endpointError, [id]: undefined },
    }));
    try {
      const ids = await withTimeout(
        (signal) => fetchRemoteModels(endpoint.baseUrl, key, signal),
        KEY_TEST_TIMEOUT_MS,
      );
      const previous = new Map(endpoint.models.map((model) => [model.id, model]));
      const models: EndpointModel[] = ids.map(
        (modelId) =>
          previous.get(modelId) ?? {
            id: modelId,
            // Discovered models start unticked: the chat bar must reflect the
            // user's choices, never whatever the endpoint happens to serve.
            enabled: false,
            supportsThinking: guessSupportsThinking(modelId),
          },
      );
      const endpoints = get().endpoints.map((item) =>
        item.id === id ? { ...item, models } : item,
      );
      set((state) => ({
        endpointStatus: { ...state.endpointStatus, [id]: "idle" },
      }));
      commitEndpoints(set, endpoints, {
        chatModel: normalizeChatModel(get().chatModel, endpoints),
        polishModel: normalizePolishModel(get().polishModel, endpoints),
      });
      void persistPreferences(get());
      return true;
    } catch (error) {
      const aiError = toAiError(error);
      set((state) => ({
        endpointStatus: { ...state.endpointStatus, [id]: "idle" },
        endpointError: {
          ...state.endpointError,
          [id]: { code: aiError.code, detail: aiError.detail ?? null },
        },
      }));
      return false;
    }
  },

  toggleEndpointModel: (id, modelId) => {
    const endpoints = get().endpoints.map((endpoint) =>
      endpoint.id === id
        ? {
            ...endpoint,
            models: endpoint.models.map((model) =>
              model.id === modelId ? { ...model, enabled: !model.enabled } : model,
            ),
          }
        : endpoint,
    );
    commitEndpoints(set, endpoints, {
      chatModel: normalizeChatModel(get().chatModel, endpoints),
      polishModel: normalizePolishModel(get().polishModel, endpoints),
    });
    void persistPreferences(get());
  },

  setEndpointModelThinking: (id, modelId, value) => {
    const endpoints = get().endpoints.map((endpoint) =>
      endpoint.id === id
        ? {
            ...endpoint,
            models: endpoint.models.map((model) =>
              model.id === modelId ? { ...model, supportsThinking: value } : model,
            ),
          }
        : endpoint,
    );
    commitEndpoints(set, endpoints);
  },

  recordError: (error) => {
    const aiError = toAiError(error);
    set({ lastErrorCode: aiError.code, lastErrorDetail: aiError.detail ?? null });
  },

  clearError: () => set({ lastErrorCode: null, lastErrorDetail: null }),

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  setChatModel: (modelId) => {
    const chatModel = normalizeChatModel(modelId, get().endpoints);
    // Another model of the same endpoint keeps the session; another endpoint is
    // another channel and therefore another transcript.
    if (channelOf(chatModel) !== channelOf(get().chatModel)) {
      enterChannel(set, get, chatModel);
      return;
    }
    set({ chatModel });
    void persistPreferences(get());
  },

  setPolishModel: (modelId) => {
    const polishModel = normalizePolishModel(modelId, get().endpoints);
    set({ polishModel });
    void persistPreferences(get());
  },

  setNoteWriteMode: (mode) => {
    set({ noteWriteMode: normalizeNoteWriteMode(mode) });
    void persistPreferences(get());
  },

  setThinkingLevel: (level) => {
    set({ thinkingLevel: normalizeThinkingLevel(level) });
    void persistPreferences(get());
  },

  undoMessageEdits: async (messageId) => {
    const message = get().messages.find((m) => m.id === messageId);
    if (!message?.edits?.length) return;
    // Reverse order so stacked edits of the same note unwind correctly.
    const pending = [...message.edits].reverse().filter((edit) => !edit.undone);
    // Only a successful restore flips the flag; a lost snapshot keeps the
    // button visible instead of claiming an undo that never happened.
    const restored = new Set<AiNoteEdit>();
    for (const edit of pending) {
      if (await undoNoteEdit(edit)) restored.add(edit);
    }
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              edits: m.edits?.map((edit) =>
                edit.undone || restored.has(edit) ? { ...edit, undone: true } : edit,
              ),
            }
          : m,
      ),
    }));
    syncConversations(set, get);
  },

  sendMessage: async (text) => {
    const trimmed = text.trim();
    // The re-entry guard has to flip before the first await: retrieval takes a
    // while, and a second Enter during it would start a turn the shared abort
    // controller can no longer stop.
    if (!trimmed || get().sending) return;

    const assistantId = newId();
    const now = Date.now();
    const activeId = get().activeConversationId;
    // A transcript may only be continued by the channel that owns it. A stale
    // active id (channel swapped without going through `enterChannel`) starts a
    // new session rather than appending to someone else's context.
    const channel = channelOf(get().chatModel);
    const continueId = activeId
      ? get().conversations.find(
          (c) => c.id === activeId && c.endpointId === channel,
        )?.id ?? null
      : null;
    const conversationId = continueId ?? newId();
    const questionIndex = get().messages.length;
    const controller = new AbortController();
    abortController = controller;
    set((state) => ({
      messages: [
        ...state.messages,
        { id: newId(), role: "user", content: trimmed, hits: [], createdAt: now },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          hits: [],
          streaming: true,
          phase: "retrieving" as AiTurnPhase,
          createdAt: now,
          brandKey: brandKeyForSelection(state.chatModel, state.endpoints),
        },
      ],
      sending: true,
      activeConversationId: conversationId,
      // First message of a fresh chat names the conversation.
      conversations: continueId
        ? state.conversations
        : [
            ...state.conversations,
            {
              id: conversationId,
              title: conversationTitleFrom(trimmed),
              endpointId: channel,
              createdAt: now,
              updatedAt: now,
              messages: [],
            },
          ],
    }));

    // Retrieval runs after both bubbles are on screen: the composer clears the
    // draft on submit, so a slow or failing index must never make the question
    // vanish without a trace. Failure degrades to "no context", not to a lost
    // turn.
    //
    // 寒暄/身份询问没有可检索的对象：小青模式下整轮跳过索引（固定话术已足够，
    // 冷启动时还省掉一次向量等待），API 模型照常检索，多一段上下文没有坏处。
    let hits: ManualHit[] = [];
    if (!(get().chatModel === LOCAL_MODEL_ID && detectSmallTalk(trimmed))) {
      try {
        hits = await searchKnowledge(trimmed, 4);
      } catch (error) {
        console.warn("ai: knowledge retrieval failed", error);
      }
    }
    set((state) => ({
      messages: state.messages.map((m) => (m.id === assistantId ? { ...m, hits } : m)),
    }));
    // Stopped while the index was rebuilding: keep the question, end the turn.
    if (controller.signal.aborted) {
      if (abortController === controller) abortController = null;
      set((state) => ({
        sending: false,
        messages: state.messages.map((m) =>
          m.id === assistantId ? { ...m, streaming: false, phase: undefined } : m,
        ),
      }));
      syncConversations(set, get);
      return;
    }

    await runGeneration(assistantId, trimmed, hits, questionIndex, controller, set, get);
  },

  regenerate: async (assistantId) => {
    if (get().sending) return;
    const { messages } = get();
    const index = messages.findIndex((m) => m.id === assistantId);
    if (index < 0 || messages[index].role !== "assistant") return;
    // The question that produced this answer: nearest user message above it.
    let questionIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        questionIndex = i;
        break;
      }
    }
    if (questionIndex < 0) return;
    const question = messages[questionIndex];

    const newAssistantId = newId();
    const controller = new AbortController();
    abortController = controller;
    // Insert the fresh reply right after the old one so both stay comparable.
    set((state) => {
      const at = state.messages.findIndex((m) => m.id === assistantId);
      if (at < 0) return { messages: state.messages };
      const next = [...state.messages];
      next.splice(at + 1, 0, {
        id: newAssistantId,
        role: "assistant",
        content: "",
        hits: [],
        streaming: true,
        phase: "retrieving",
        createdAt: Date.now(),
        brandKey: brandKeyForSelection(state.chatModel, state.endpoints),
      });
      return { messages: next, sending: true };
    });

    let hits: ManualHit[] = [];
    if (!(get().chatModel === LOCAL_MODEL_ID && detectSmallTalk(question.content))) {
      try {
        hits = await searchKnowledge(question.content, 4);
      } catch (error) {
        console.warn("ai: knowledge retrieval failed", error);
      }
    }
    set((state) => ({
      messages: state.messages.map((m) => (m.id === newAssistantId ? { ...m, hits } : m)),
    }));
    if (controller.signal.aborted) {
      if (abortController === controller) abortController = null;
      set((state) => ({
        sending: false,
        messages: state.messages.map((m) =>
          m.id === newAssistantId ? { ...m, streaming: false, phase: undefined } : m,
        ),
      }));
      syncConversations(set, get);
      return;
    }

    await runGeneration(
      newAssistantId,
      question.content,
      hits,
      questionIndex,
      controller,
      set,
      get,
    );
  },

  deleteMessage: (id) => {
    set((state) => {
      const index = state.messages.findIndex((m) => m.id === id);
      if (index < 0) return { messages: state.messages };
      const target = state.messages[index];
      const remove = new Set<string>([id]);
      // Pair deletion: a question takes its answer, an answer takes its question.
      if (target.role === "user") {
        const answer = state.messages[index + 1];
        if (answer && answer.role === "assistant") remove.add(answer.id);
      } else {
        const question = state.messages[index - 1];
        if (question && question.role === "user") remove.add(question.id);
      }
      return { messages: state.messages.filter((m) => !remove.has(m.id)) };
    });
    syncConversations(set, get);
  },

  stopGenerating: () => {
    abortController?.abort();
    abortController = null;
    set({ sending: false });
  },

  clearChat: () => {
    // Clearing removes the conversation itself, not just its messages: an
    // empty entry would otherwise stay in the history list (which is exactly
    // what `stashActiveConversation` drops). The next question starts fresh.
    const { activeConversationId } = get();
    set((state) => ({
      messages: [],
      activeConversationId: null,
      conversations: activeConversationId
        ? state.conversations.filter((c) => c.id !== activeConversationId)
        : state.conversations,
    }));
    if (activeConversationId) void deleteAiConversation(activeConversationId);
  },

  newConversation: () => {
    if (get().sending) get().stopGenerating();
    stashActiveConversation(set, get);
    set({ activeConversationId: null, messages: [] });
  },

  switchConversation: (id) => {
    if (id === get().activeConversationId) return;
    if (get().sending) get().stopGenerating();
    stashActiveConversation(set, get);
    const target = get().conversations.find((c) => c.id === id);
    if (!target) return;
    // The session dictates the channel: 小青 sessions are listed inside endpoint
    // channels, and the next question must not go to that endpoint carrying 小青's
    // context (the mirror image of the bug this change fixes).
    const chatModel = modelForChannel(get(), target.endpointId);
    const modelChanged = chatModel !== get().chatModel;
    set({
      chatModel,
      activeConversationId: id,
      messages: restoreMessages(target),
    });
    if (modelChanged) void persistPreferences(get());
  },

  renameConversation: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const next = get().conversations.map((c) =>
      c.id === id ? { ...c, title: trimmed } : c,
    );
    set({ conversations: next });
    const renamed = next.find((c) => c.id === id);
    if (renamed) void saveAiConversation(renamed);
  },

  deleteConversation: (id) => {
    set({ conversations: get().conversations.filter((c) => c.id !== id) });
    void deleteAiConversation(id);
    if (get().activeConversationId === id) {
      set({ activeConversationId: null, messages: [] });
    }
  },

  startPolish: (session) =>
    set({ polish: { ...session, id: newId() }, polishApplied: false }),

  setPolishApplied: (applied) => set({ polishApplied: applied }),

  cancelPolish: () => set({ polish: null, polishApplied: false }),
}));

/**
 * Resolve a persisted `"<endpointId>::<modelId>"` against the **current** store,
 * for callers outside the store (润色 panel, selection actions). Reading through
 * the store keeps one definition of "which endpoint, which key, which model".
 */
export function resolveAiSelection(selection: string): ResolvedSelection | null {
  return resolveSelection(useAiStore.getState(), selection);
}
