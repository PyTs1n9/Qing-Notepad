import packageJson from "../../package.json";
import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export const APP_VERSION = packageJson.version;
export const GITHUB_URL = "https://github.com/PyTs1n9/Qing-Notepad";
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;

const GITHUB_API_LATEST = "https://api.github.com/repos/PyTs1n9/Qing-Notepad/releases/latest";

interface ParsedVersion {
  numbers: [number, number, number];
  prerelease: string[];
}

export interface LatestRelease {
  version: string;
  url: string;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i);
  if (!match) return null;

  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const candidateVersion = parseVersion(candidate);
  const currentVersion = parseVersion(current);
  if (!candidateVersion || !currentVersion) return false;

  for (let index = 0; index < candidateVersion.numbers.length; index += 1) {
    const difference = candidateVersion.numbers[index] - currentVersion.numbers[index];
    if (difference !== 0) return difference > 0;
  }

  return comparePrerelease(candidateVersion.prerelease, currentVersion.prerelease) > 0;
}

/**
 * Compares two versions by their three numeric parts **only**, ignoring any
 * prerelease suffix.
 *
 * This is the primitive the announcement feed needs for its version windows
 * (`minAppVersion` inclusive, `maxAppVersionExclusive` exclusive). It exists
 * because range syntax is the wrong tool here: `semver.satisfies("0.8.0-beta.1",
 * ">=0.7.0")` is `false` by default, which would hide every notice from beta
 * users. A triple comparison sidesteps that rule entirely.
 *
 * Unparsable input throws instead of collapsing to a value: a silent `0` would
 * make a typo'd `maxAppVersionExclusive` hide *every* item (0 means "equal",
 * and equal fails the exclusive bound), and any invented `-1`/`1` would be a
 * lie. Callers that want "no constraint" semantics must decide it themselves.
 */
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(`Unparsable app version: ${!left ? a : b}`);
  }

  for (let index = 0; index < left.numbers.length; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  // Prerelease is deliberately not consulted - see the doc comment.
  return 0;
}

/**
 * `1.2.3-beta.1` is a prerelease, `1.2.3` is not. Reuses `parseVersion` so the
 * accepted grammar stays in one place.
 */
export function isPrereleaseVersion(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.prerelease.length > 0;
}

/**
 * Shared remote fetch for every outbound request in the renderer.
 *
 * Update checks (and the announcement feed) run through the http plugin in the
 * desktop app. A webview `fetch` would force the host into the CSP
 * `connect-src` for requests that are not part of the page's own traffic. The
 * plugin performs them in Rust (outside the CSP) and its own allowlist already
 * covers `https://**`. `cache` is not part of the plugin's RequestInit subset,
 * and it never caches.
 */
export const remoteFetch: typeof fetch = isTauri() ? (tauriFetch as unknown as typeof fetch) : fetch;

export async function fetchLatestRelease(): Promise<LatestRelease> {
  const response = await remoteFetch(GITHUB_API_LATEST, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);

  const data = await response.json() as { tag_name?: unknown; html_url?: unknown };
  const version = typeof data.tag_name === "string" ? data.tag_name.trim().replace(/^v/i, "") : "";
  if (!parseVersion(version)) throw new Error("GitHub release has an invalid version tag");

  return {
    version,
    url: typeof data.html_url === "string" && data.html_url ? data.html_url : GITHUB_RELEASES_URL,
  };
}
