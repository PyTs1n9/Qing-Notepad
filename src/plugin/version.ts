/**
 * The only module that imports `semver`.
 *
 * Version ranges are the one place where hand-rolled parsing fails quietly:
 * `>=0.8.0 <1.0.0`, `^0.8`, `~0.8.2`, `0.8.x` and `||` all have edge cases, and
 * getting one wrong shows up as "this plugin will not install for no reason".
 * 15 KB buys the real parser; every caller goes through the wrappers below so
 * the dependency stays swappable.
 */
import { compare, gt, satisfies as semverSatisfies, valid } from "semver";
import { APP_VERSION } from "@/utils/updateChecker";

/** The running host version, as the manifest range is matched against. */
export const HOST_VERSION = APP_VERSION;

function normalize(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function isValidVersion(version: string): boolean {
  return valid(normalize(version)) !== null;
}

/** `satisfies`, but a malformed range is `false` instead of a thrown error. */
export function satisfiesRange(version: string, range: string): boolean {
  const normalized = normalize(version);
  const cleaned = range.trim();
  if (!cleaned || valid(normalized) === null) return false;
  try {
    return semverSatisfies(normalized, cleaned);
  } catch {
    return false;
  }
}

/** Whether a plugin's `engines.host` accepts the host that is running now. */
export function isHostCompatible(range: string | null | undefined): boolean {
  if (!range) return false;
  return satisfiesRange(HOST_VERSION, range);
}

/** Negative when `left` is older, positive when newer, `0` when unusable. */
export function compareVersions(left: string, right: string): number {
  const a = normalize(left);
  const b = normalize(right);
  if (valid(a) === null || valid(b) === null) return 0;
  return compare(a, b);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = normalize(candidate);
  const b = normalize(current);
  if (valid(a) === null || valid(b) === null) return false;
  return gt(a, b);
}
