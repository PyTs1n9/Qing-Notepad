/**
 * Remote announcement feed: snapshot -> disk cache -> network, with a
 * hand-written schema guard in between (decision log D3/D4/D5/D7).
 *
 * Everything in this module is defensive by design. The payload comes from a
 * git repository over the network, so it is treated as hostile input: unknown
 * fields are ignored, invalid rows are dropped one by one, images are stripped,
 * and links are host-allowlisted. Rendering happens elsewhere, through
 * `utils/markdown.ts` only.
 *
 * No function here throws, and no function here blocks a render: the login
 * dialog must open instantly even when Gitee is unreachable.
 */
import feedSnapshotRaw from "../../announcements.json?raw";
import type { LangType } from "@/stores/settingsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  loadAnnouncementCache,
  loadSeenAnnouncements as readSeenAnnouncements,
  saveAnnouncementCache,
  saveSeenAnnouncements,
} from "@/utils/storage";
import {
  APP_VERSION,
  compareAppVersions,
  isPrereleaseVersion,
  remoteFetch,
} from "@/utils/updateChecker";

export type AnnouncementKind = "update" | "notice" | "maintenance" | "critical";

export interface AnnouncementLink {
  url: string;
  label: LocalizedText | null;
}

/** `{zh,en}` objects, never the typed i18n table: remote copy cannot be typed. */
export interface LocalizedText {
  zh?: string;
  en?: string;
}

/** A feed item that survived validation; every field has a settled type. */
export interface AnnouncementItem {
  id: string;
  kind: AnnouncementKind;
  publishedAt: string;
  /**
   * Copy only. D4: a window is text, not a visibility gate - hiding an item the
   * user should read is worse than showing one whose window just closed.
   */
  startsAt: string | null;
  endsAt: string | null;
  minAppVersion: string | null;
  maxAppVersionExclusive: string | null;
  showOnPrerelease: boolean;
  title: LocalizedText;
  body: LocalizedText | null;
  dismissible: boolean;
  pinned: boolean;
  link: AnnouncementLink | null;
}

/** One item as the UI needs it: locale resolved, body sanitised. */
export interface AnnouncementViewItem {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  publishedAt: string;
  startsAt: string | null;
  endsAt: string | null;
  dismissible: boolean;
  pinned: boolean;
  link: { url: string; label: string } | null;
}

export interface AnnouncementFeed {
  schemaVersion: 1;
  generatedAt: string | null;
  items: AnnouncementItem[];
}

/**
 * Single source for now (D1): raw file reads on Gitee do not consume the
 * `/api/v5/` quota, and two sources in a client usually degrade into "neither
 * was tested". The array exists so a second source - a GitHub `contents` API
 * call - can be appended without touching `runRefresh`; the loop below already
 * falls through to the next entry when one is unavailable.
 */
const FEED_SOURCES: readonly string[] = [
  "https://gitee.com/PyTs1n9/Qing-Notepad/raw/main/announcements.json",
];

/** Hard timeout for one attempt. The dialog must never wait on this. */
const REQUEST_TIMEOUT_MS = 4_000;
/** Soft TTL: the source's edge cache is 60s, an hour is fresh enough (D4). */
const SOFT_TTL_MS = 60 * 60 * 1000;
/** Hard cooldown: minimum gap between two network attempts, any trigger. */
const HARD_COOLDOWN_MS = 60 * 60 * 1000;
/** Never trust a `fetchedAt` further in the future than this (clock skew). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Server-driven backoff ceiling: a year-long Retry-After must not lock us out. */
const MAX_SERVER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const MAX_RESPONSE_CHARS = 65_536;
const MAX_ITEMS = 20;
const MAX_BODY_CHARS = 8_192;
const MAX_TITLE_CHARS = 120;

const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = [
  "update",
  "notice",
  "maintenance",
  "critical",
];

/** Ids double as the key in `seen.json`, so the grammar stays narrow. */
const ANNOUNCEMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Link hosts we are willing to hand to the OS browser. `openInDefaultBrowser`
 * only checks the scheme, so the host check has to live here (D7). Subdomains
 * are matched by suffix, never by `includes`, so `github.com.evil.tld` fails.
 */
const LINK_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "gitee.com",
  "www.gitee.com",
  "raw.giteeusercontent.com",
]);
const LINK_HOST_SUFFIXES = [".github.com", ".gitee.com"];

/**
 * One image reference in Markdown. The destination allows one level of balanced
 * parentheses because `![a](https://x/a_(1).png)` is legal and the naive
 * `[^()\s]*` leaves it untouched.
 */
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*(?:<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HTML_IMAGE_PATTERN = /<img\b[^>]*>/gi;

// --- Module state ----------------------------------------------------------
//
// In-memory copies only. Cooldowns deliberately live here and not on disk: the
// worst case of losing them is one extra request after a restart, while a
// persisted "blocked until" would survive a clock change and look like a
// permanently broken feature on the machine next to it.

interface MemoryFeed {
  fetchedAt: number;
  items: AnnouncementItem[];
}

let memoryFeed: MemoryFeed | null = null;
/** Set when a request is in flight so both triggers share one request. */
let inFlight: Promise<AnnouncementItem[] | null> | null = null;
/** Epoch ms of the last network attempt (successful or not). */
let lastAttemptAt = 0;
/** Epoch ms before which no attempt may be made, pushed by 403/429 headers. */
let serverCooldownUntil = 0;
/** Sources that answered 404 - not retried for the rest of this session. */
const deadSources = new Set<string>();
/** One warn per session, so an offline user does not flood the console (D7). */
let warned = false;

function warnOnce(message: string, error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(message, error);
}

// --- Schema guard ----------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Drops image references from the *source* markdown (best effort).
 *
 * The webview CSP allows `img-src https:`, so an `<img>` in remote copy would
 * be fetched straight from the webview: it reveals the user's IP and the exact
 * moment the dialog opened, and an announcement board needs no pictures. Alt
 * text is kept so the sentence still reads.
 *
 * This pass is not the gate - it only keeps the cached text clean. The renderer
 * resolves reference-style images and bracketed destinations that no string
 * rewrite can see, so `stripAnnouncementImages` runs on the produced HTML too.
 */
function stripImages(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE_PATTERN, (_match, alt: string) => alt.trim())
    .replace(HTML_IMAGE_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `{zh,en}` with at least one non-empty side, each side length-capped.
 * Returns null when the value is not usable at all - the caller decides whether
 * that drops the field or the whole item.
 */
function readLocalized(value: unknown, maxLength: number): LocalizedText | null {
  const record = asRecord(value);
  if (!record) return null;
  const zh = asText(record.zh);
  const en = asText(record.en);
  if (!zh && !en) return null;
  if (zh.length > maxLength || en.length > maxLength) return null;
  const text: LocalizedText = {};
  if (zh) text.zh = stripImages(zh);
  if (en) text.en = stripImages(en);
  return text.zh || text.en ? text : null;
}

function isAllowedLinkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LINK_HOSTS.has(host) || LINK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Whether a URL found in announcement *body copy* may be opened at all.
 *
 * The item-level `link` goes through `readLink` below, but body Markdown reaches
 * the renderer as plain text and `renderMarkdown` only enforces the scheme
 * allowlist - so `[下载更新](https://evil.tld/x.exe)` would be a working anchor
 * onto any host. D7 leans on the host allowlist for that reason, and this is the
 * second half of it: the board refuses to open anything that fails here.
 *
 * Relative targets (`#anchor`, `/path`) are refused too; `handleExternalLinkClick`
 * would otherwise leave them to the webview's own navigation.
 */
export function isAllowedAnnouncementUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && isAllowedLinkHost(url.hostname);
}

/**
 * Strips `<img>` from *rendered* announcement HTML.
 *
 * The pre-render pass in `stripImages` cannot see reference-style images
 * (`![alt][1]` plus a `[1]: https://…` definition) and only guesses at link
 * destinations, while `marked` resolves both into real `<img src>`. Since the
 * webview CSP allows `img-src https:`, a surviving tag would load a remote image
 * and leak the user's IP plus the moment the board opened - exactly what D7
 * wants to prevent. Sanitising the output is the only airtight place, so the
 * alt text is carried over as plain text and the tag is dropped.
 */
export function stripAnnouncementImages(html: string): string {
  return html.replace(HTML_IMAGE_PATTERN, (tag) => {
    // `marked` already HTML-escaped the alt attribute, so re-emitting it verbatim
    // cannot reintroduce markup.
    return /\balt\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? "";
  });
}

/**
 * A rejected link costs the item its button, nothing else: the body text is
 * still an announcement the user should see.
 */
function readLink(value: unknown): AnnouncementLink | null {
  const record = asRecord(value);
  if (!record) return null;
  const raw = asText(record.url);
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!isAllowedLinkHost(url.hostname)) return null;
  return { url: url.href, label: readLocalized(record.label, MAX_TITLE_CHARS) };
}

/**
 * Version bounds are optional. An unparsable one is dropped instead of hiding
 * the item: a typo in the feed must not make an announcement invisible, and
 * `compareAppVersions` would otherwise throw on it at render time.
 */
function readVersionBound(value: unknown): string | null {
  const raw = asText(value);
  if (!raw) return null;
  const version = raw.replace(/^v/i, "");
  try {
    compareAppVersions(version, version);
  } catch {
    return null;
  }
  return version;
}

function readIsoTimestamp(value: unknown): string | null {
  const raw = asText(value);
  if (!raw || Number.isNaN(Date.parse(raw))) return null;
  return raw;
}

function parseItem(value: unknown): AnnouncementItem | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = asText(record.id);
  if (!ANNOUNCEMENT_ID_PATTERN.test(id)) return null;

  // `publishedAt` is the sort key and `id` is the read key: both are required.
  const publishedAt = readIsoTimestamp(record.publishedAt);
  if (!publishedAt) return null;

  const rawKind = record.kind;
  const kind = ANNOUNCEMENT_KINDS.find((candidate) => candidate === rawKind);
  if (!kind) return null;

  const title = readLocalized(record.title, MAX_TITLE_CHARS);
  if (!title) return null;

  // An absent body is fine; a body that exists but is unusable is not.
  let body: LocalizedText | null = null;
  if (record.body !== undefined && record.body !== null) {
    body = readLocalized(record.body, MAX_BODY_CHARS);
    if (!body) return null;
  }

  return {
    id,
    kind,
    publishedAt,
    startsAt: readIsoTimestamp(record.startsAt),
    endsAt: readIsoTimestamp(record.endsAt),
    minAppVersion: readVersionBound(record.minAppVersion),
    maxAppVersionExclusive: readVersionBound(record.maxAppVersionExclusive),
    // Only `false` opts out; a missing field means "show it" (D6).
    showOnPrerelease: record.showOnPrerelease !== false,
    title,
    body,
    dismissible: record.dismissible !== false,
    pinned: record.pinned === true,
    link: readLink(record.link),
  };
}

/**
 * Whole-payload guard. Returns null when the envelope is unusable (drop the
 * entire cache and fall back to the snapshot); individual invalid rows are
 * dropped one by one.
 */
function parseFeed(value: unknown): AnnouncementFeed | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.schemaVersion !== 1) return null;
  if (!Array.isArray(record.items)) return null;

  const items: AnnouncementItem[] = [];
  // Past the cap the tail is simply dropped: the sort key is `publishedAt`, so a
  // 21st item is by definition not the newest thing the author wanted to say.
  for (const raw of record.items.slice(0, MAX_ITEMS)) {
    const item = parseItem(raw);
    if (item) items.push(item);
  }

  return {
    schemaVersion: 1,
    generatedAt: readIsoTimestamp(record.generatedAt),
    items,
  };
}

function parseFeedText(text: string): AnnouncementFeed | null {
  try {
    return parseFeed(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

// --- Bundled snapshot ------------------------------------------------------
//
// `?raw` + `JSON.parse` instead of a `resolveJsonModule` import: the raw string
// yields a genuine `unknown`, so the guard above is the only thing that gives it
// a shape. A typed JSON import would hand back a pre-shaped literal that lies
// about data the same file serves as a *remote* feed - the two readers must go
// through the same door. It also matches the existing `docs/*.md?raw` imports in
// `HelpCenterModal`.
let snapshotFeed: AnnouncementFeed | null = null;
let snapshotParsed = false;

function getSnapshotFeed(): AnnouncementFeed | null {
  if (!snapshotParsed) {
    snapshotParsed = true;
    snapshotFeed = parseFeedText(feedSnapshotRaw);
  }
  return snapshotFeed;
}

// --- View conversion -------------------------------------------------------

/** `en` falls back to `zh`; the guard guarantees at least one side exists. */
function pickText(text: LocalizedText, lang: LangType): string {
  if (lang === "en") return text.en ?? text.zh ?? "";
  return text.zh ?? text.en ?? "";
}

function isVersionInRange(item: AnnouncementItem): boolean {
  try {
    if (item.minAppVersion && compareAppVersions(APP_VERSION, item.minAppVersion) < 0) return false;
    if (
      item.maxAppVersionExclusive
      && compareAppVersions(APP_VERSION, item.maxAppVersionExclusive) >= 0
    ) {
      return false;
    }
  } catch {
    // Bounds are validated at parse time, so this is unreachable in practice;
    // showing the item is the safe direction if it ever happens.
    return true;
  }
  return true;
}

function isVisibleOnThisBuild(item: AnnouncementItem): boolean {
  if (item.showOnPrerelease === false && isPrereleaseVersion(APP_VERSION)) return false;
  return isVersionInRange(item);
}

/** Pinned first, then newest first. Ties keep feed order (sort is stable). */
function sortItems(items: AnnouncementItem[]): AnnouncementItem[] {
  return [...items].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  });
}

function toViewItems(items: AnnouncementItem[], lang: LangType): AnnouncementViewItem[] {
  const result: AnnouncementViewItem[] = [];
  for (const item of sortItems(items)) {
    if (!isVisibleOnThisBuild(item)) continue;
    const title = pickText(item.title, lang);
    // Both locales missing was already rejected; this covers "en missing, zh
    // present" after stripping, which can leave an empty string.
    if (!title) continue;
    result.push({
      id: item.id,
      kind: item.kind,
      title,
      body: item.body ? pickText(item.body, lang) : "",
      publishedAt: item.publishedAt,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      dismissible: item.dismissible,
      pinned: item.pinned,
      link: item.link
        ? { url: item.link.url, label: item.link.label ? pickText(item.link.label, lang) : "" }
        : null,
    });
  }
  return result;
}

// --- Public: snapshot ------------------------------------------------------

/**
 * Items bundled with this build. Synchronous and I/O-free on purpose: the
 * login dialog paints from it on the first frame (D5's last-resort layer).
 */
export function getSnapshotAnnouncements(lang: LangType): AnnouncementViewItem[] {
  const feed = getSnapshotFeed();
  return feed ? toViewItems(feed.items, lang) : [];
}

// --- Public: disk cache ----------------------------------------------------

/**
 * Cross-launch cache. Served even when it is older than the soft TTL - a stale
 * announcement is still more useful than the snapshot from install time (D5).
 */
export async function getCachedAnnouncements(lang: LangType): Promise<AnnouncementViewItem[]> {
  if (memoryFeed) return toViewItems(memoryFeed.items, lang);
  const cache = await loadAnnouncementCache();
  if (!cache) return [];

  const items: AnnouncementItem[] = [];
  for (const raw of cache.items.slice(0, MAX_ITEMS)) {
    const item = parseItem(raw);
    if (item) items.push(item);
  }
  if (items.length === 0) return [];

  // A `fetchedAt` from the future means the clock moved; treat it as stale so
  // the next trigger refreshes instead of trusting it for an hour.
  const fetchedAt = cache.fetchedAt > Date.now() + CLOCK_SKEW_MS ? 0 : cache.fetchedAt;
  memoryFeed = { fetchedAt, items };
  return toViewItems(items, lang);
}

// --- Public: network refresh ----------------------------------------------

interface FeedResponse {
  text: string;
  etag: string | null;
}

/**
 * One attempt against one source. Throws on anything that is not a usable 200;
 * `runRefresh` turns that into "try the next source" and finally "keep the
 * fallback", which is why no error escapes this module.
 */
async function requestFeed(source: string): Promise<FeedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await remoteFetch(source, {
      // Nothing identifying is sent: no user agent, no app version (D7).
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        deadSources.add(source);
      } else if (response.status === 403 || response.status === 429) {
        // Per the rate-limit docs, do not retry before the reset moment; the
        // header is the server telling us when that is.
        pushServerCooldown(response);
      }
      throw new Error(`Announcement feed returned ${response.status}`);
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new Error(`Announcement feed is larger than ${MAX_RESPONSE_CHARS} characters`);
    }
    return { text, etag: response.headers.get("etag") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pushes the cooldown to whatever the server asked for. `retry-after` is either
 * a number of seconds or an HTTP date; `x-ratelimit-reset` is epoch seconds.
 */
function pushServerCooldown(response: Response): void {
  const now = Date.now();
  const target = Math.min(now + MAX_SERVER_COOLDOWN_MS, Math.max(now, readServerResetTime(response, now)));
  serverCooldownUntil = Math.max(serverCooldownUntil, target);
}

function readServerResetTime(response: Response, now: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return date;
  }

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  return now;
}

async function runRefresh(): Promise<AnnouncementItem[] | null> {
  for (const source of FEED_SOURCES) {
    if (deadSources.has(source)) continue;
    try {
      const { text, etag } = await requestFeed(source);
      const feed = parseFeedText(text);
      // A 200 whose body is not our JSON must never be shown: no Markdown
      // fallback, no partial parse (D5).
      if (!feed) throw new Error("Announcement feed payload was rejected by the schema guard");

      const fetchedAt = Date.now();
      memoryFeed = { fetchedAt, items: feed.items };
      await saveAnnouncementCache({ schemaVersion: 1, fetchedAt, etag, items: feed.items });
      return feed.items;
    } catch (error) {
      warnOnce("Failed to refresh announcements:", error);
    }
  }
  return null;
}

/**
 * Whether a trigger would be dropped by the soft TTL / hard cooldown.
 *
 * Shared by `refreshAnnouncements` and by the manual "refresh" button, so the
 * button's disabled state and the real gate can never drift apart. An in-flight
 * request counts as blocked: there is nothing for a second click to start.
 */
export function isAnnouncementRefreshThrottled(): boolean {
  if (inFlight) return true;

  const now = Date.now();
  if (now < serverCooldownUntil) return true;
  if (memoryFeed && Math.abs(now - memoryFeed.fetchedAt) < SOFT_TTL_MS) return true;
  if (lastAttemptAt !== 0 && now - lastAttemptAt < HARD_COOLDOWN_MS) return true;
  return false;
}

/**
 * Network refresh, or null when the caller should keep what it already shows.
 *
 * Null covers every "nothing to do" case: the feature is switched off, a soft
 * TTL is still fresh, the hard cooldown has not elapsed, and every failure.
 * Callers must treat it as "no change", never as an error - which is why the
 * changelog button asks `isAnnouncementRefreshThrottled()` first instead of
 * reading a null as a failure.
 */
export async function refreshAnnouncements(lang: LangType): Promise<AnnouncementViewItem[] | null> {
  if (!useSettingsStore.getState().announcementsEnabled) return null;

  if (!inFlight) {
    if (isAnnouncementRefreshThrottled()) return null;
    // Claim the attempt before awaiting: two triggers firing in the same tick
    // must not both pass the gate.
    lastAttemptAt = Date.now();
    inFlight = runRefresh().finally(() => {
      inFlight = null;
    });
  }

  // A caller that arrives while a request is running joins it instead of being
  // told "nothing new": opening the login dialog and the changelog at the same
  // moment costs one request, and both surfaces get its result.
  const items = await inFlight;
  // Localised per caller, so a joined request still answers in its own language.
  return items ? toViewItems(items, lang) : null;
}

// --- Public: read marks (D8) ----------------------------------------------
//
// Two mounts can be alive at once (the login dialog's side board and the
// changelog), and both mark what they render. Neither the load nor the mark may
// blind-write `seenCache` after an `await`: the other mount may have filled or
// extended it while the file read was in flight, and overwriting that snapshot
// would silently drop one of the two marks.

let seenCache: Record<string, string> | null = null;
/** Serialises writes so two marks in the same tick cannot lose each other. */
let seenWriteChain: Promise<void> = Promise.resolve();

export async function loadSeenAnnouncements(): Promise<Record<string, string>> {
  if (!seenCache) {
    const loaded = await readSeenAnnouncements();
    // Re-check after the await: whoever won the race keeps their map.
    if (!seenCache) seenCache = loaded;
  }
  return { ...seenCache };
}

export async function markAnnouncementSeen(id: string): Promise<void> {
  if (!ANNOUNCEMENT_ID_PATTERN.test(id)) return;
  if (!seenCache) {
    const loaded = await readSeenAnnouncements();
    if (!seenCache) seenCache = loaded;
  }
  // Re-read the shared map rather than the local copy taken before the await.
  const current = seenCache;
  if (current[id]) return;

  seenCache = { ...current, [id]: new Date().toISOString() };
  const snapshot = seenCache;
  seenWriteChain = seenWriteChain
    .then(() => saveSeenAnnouncements(snapshot))
    .catch(() => undefined);
  await seenWriteChain;
}
