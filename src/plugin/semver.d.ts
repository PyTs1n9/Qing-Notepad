/**
 * Minimal type surface for the `semver` package.
 *
 * It ships without types and `@types/semver` is not a dependency, so this
 * declares exactly the four functions the plugin system uses. Keeping the
 * import isolated to `version.ts` means the rest of the codebase never sees
 * `semver` at all — the choice of parser stays a single-file decision.
 */
declare module "semver" {
  export function valid(version: string): string | null;
  export function satisfies(version: string, range: string): boolean;
  export function gt(left: string, right: string): boolean;
  export function compare(left: string, right: string): number;
}
