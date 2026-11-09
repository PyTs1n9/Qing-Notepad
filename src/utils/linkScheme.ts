/**
 * The single source of truth for "which URL scheme may this app act on".
 *
 * Two surfaces used to answer that question separately: the preview renderer
 * (`markdown.ts`) decided whether a destination is safe enough to become a real
 * `<a href>`, and the link resolver (`markdownLinks.ts`) decided whether to hand
 * it to the OS. One list allowing `tel:` while the other refuses it produces a
 * dead link, and the reverse — a resolver that trusts something the renderer
 * refused — is how `javascript:` would reach the webview. Keeping the list in
 * one place is what makes "rendered as a link" and "clickable as a link" the
 * same statement.
 *
 * Image sources are deliberately *not* here: `data:`/`blob:`/`attachment:` are
 * inert as `<img src>` but must never be clickable link destinations, so
 * `markdown.ts` keeps `IMAGE_SCHEME_ALLOWLIST` private.
 */

/** Schemes the OS opener may be asked to handle. */
export const LINK_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

/** Lowercased scheme of `value`, or `""` when it carries none (`#a`, `/x`, `a.md`). */
export function schemeOf(value: string): string {
  return SCHEME_PATTERN.exec(value)?.[1]?.toLowerCase() ?? "";
}

/** Whether `value` is an absolute URL on a scheme this app will act on. */
export function isExternalScheme(value: string): boolean {
  return LINK_SCHEMES.has(schemeOf(value.trim()));
}

/**
 * Whether a Markdown link destination may be emitted as a real `<a href>`.
 *
 * Both note bodies and AI answers reach the renderer, and `marked` copies the
 * destination straight into `href`: `[点我](javascript:…)` becomes a live
 * anchor, and clicking it would run script in the app origin — where the Tauri
 * IPC bridge is reachable. Relative targets stay allowed: they are handled by
 * the click resolver, which never lets the webview navigate.
 */
export function isSafeLinkHref(href: string): boolean {
  const value = href.trim();
  if (!value) return false;
  // `//host` is protocol-relative http(s), not a scheme we must vouch for.
  if (value.startsWith("//")) return true;
  const scheme = schemeOf(value);
  if (!scheme) return true;
  return LINK_SCHEMES.has(scheme);
}
