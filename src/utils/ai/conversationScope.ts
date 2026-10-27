/**
 * Which chat sessions a channel may see.
 *
 * A session belongs to exactly one channel: an endpoint id, or `null` for 小青.
 * The rules encoded here are the whole isolation story, so they live in one
 * pure module instead of being repeated in the store and the sidebar:
 *
 *   - an endpoint channel sees its own sessions plus 小青's (the app's built-in
 *     assistant is shared, not owned by an endpoint);
 *   - 小青 sees only its own — it is a channel, not a "show everything" view;
 *   - no endpoint ever sees another endpoint's sessions.
 *
 * Structural typing keeps this free of store imports: callers pass whatever has
 * a channel id and an `updatedAt`.
 */

/** The slice of a chat session needed to scope and order it. */
export interface ChannelScopedSession {
  endpointId: string | null;
  updatedAt: number;
}

/** Sessions the history panel may list for `channel`. */
export function sessionsForChannel<T extends ChannelScopedSession>(
  sessions: T[],
  channel: string | null,
): T[] {
  if (channel === null) return sessions.filter((session) => session.endpointId === null);
  return sessions.filter(
    (session) => session.endpointId === channel || session.endpointId === null,
  );
}

/**
 * Most recently updated session of `channel` — where a channel switch lands.
 * 小青 sessions are deliberately excluded from endpoint channels here: they are
 * *listed* there but must not be resumed, or the panel would flip back to 小青
 * every time the user switched endpoints.
 */
export function latestSessionIn<T extends ChannelScopedSession>(
  sessions: T[],
  channel: string | null,
): T | null {
  return sessions.reduce<T | null>(
    (best, session) =>
      session.endpointId === channel && (!best || session.updatedAt > best.updatedAt)
        ? session
        : best,
    null,
  );
}

/** Which channel an on-disk session belongs to, and whether to rewrite it. */
export interface AdoptedChannel {
  endpointId: string | null;
  /** True when the file predates channels and gets its channel written once. */
  needsWrite: boolean;
}

/**
 * Decide the channel of a stored session.
 *
 * `null` is a settled 小青 session and `"<id>"` a settled endpoint session — both
 * are left alone. A **missing** field predates channels and is backfilled with
 * the channel the user is on: these sessions came from their own usage, and
 * filing them under 小青 would hide an API user's whole history from the channel
 * they actually use. Anything else (a hand-edited number, say) counts as missing
 * rather than being trusted.
 */
export function adoptChannel(
  stored: { endpointId?: string | null },
  currentChannel: string | null,
): AdoptedChannel {
  if (stored.endpointId === null) return { endpointId: null, needsWrite: false };
  if (typeof stored.endpointId === "string") {
    return { endpointId: stored.endpointId, needsWrite: false };
  }
  return { endpointId: currentChannel, needsWrite: true };
}
