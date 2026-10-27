import type { ThemeType, CustomColors } from "@/stores/settingsStore";

const THEME_CLASSES = ["theme-dark", "theme-blue", "theme-yellow", "theme-green", "theme-custom"] as const;

const CUSTOM_PROPS = [
  "--color-bg-primary",
  "--color-bg-secondary",
  "--color-bg-sidebar",
  "--color-bg-shell",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-muted",
  "--color-border",
  "--color-accent",
  "--color-bg-hover",
  "--color-bg-active",
  "--color-accent-light",
  "--color-accent-hover",
  "--color-accent-text",
  "--color-danger",
  // Written inline for the custom theme only (the four presets declare theirs
  // in `index.css`), so they have to be cleared on the way back to a preset.
  "--color-on-accent",
  "--color-on-danger",
] as const;

/** Rough relative brightness of a #rrggbb color; enough to split light/dark. */
function luma(hex: string): number {
  const value = hex.trim().replace("#", "");
  const full = value.length === 3
    ? value.split("").map((char) => char + char).join("")
    : value;
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(full.slice(offset, offset + 2), 16);
    return Number.isFinite(channel) ? channel : 0;
  });
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** WCAG relative luminance of a #rrggbb colour. */
function channelLuminance(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function parseRgb(hex: string): [number, number, number] {
  const value = hex.trim().replace("#", "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Mirrors `color-mix(in srgb, base <weight>%, tint)`. */
function mixHex(base: string, tint: string, baseWeight: number): string {
  const a = parseRgb(base);
  const b = parseRgb(tint);
  const channels = [0, 1, 2].map((index) => Math.round(a[index] * baseWeight + b[index] * (1 - baseWeight)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

const ON_COLORS = { light: "#ffffff", dark: "#0f1114" } as const;

/**
 * The user picks their own accent, so the preset table in `index.css` cannot
 * cover this theme. Pick the foreground that actually wins on the block instead
 * of inheriting white and hoping: white wins ties, because a light foreground on
 * a coloured block is what every other surface in the app does.
 */
function onColorFor(background: string): string {
  return contrastRatio(background, ON_COLORS.light) >= contrastRatio(background, ON_COLORS.dark)
    ? ON_COLORS.light
    : ON_COLORS.dark;
}

/**
 * The surfaces user text actually sits on. The secondary and sidebar colours are
 * included alongside the primary: they are the darker pair in every preset, so
 * anything that clears them clears the main card too. Skipping them is what let
 * the sidebar keep unreadable secondary text while the audit looked green.
 */
function textGrounds(bgPrimary: string, bgSecondary: string, bgSidebar: string): [string, string, string] {
  return [bgPrimary, bgSecondary, bgSidebar];
}

/**
 * Walks `mixHex(textPrimary, bgPrimary, weight)` from the ground end towards the
 * body colour and returns the first value that clears `target` on every ground.
 * Starting at the ground end rather than at 1 is what keeps the tier *weak*: the
 * result is the lightest (dark themes: darkest) value that still passes, instead
 * of a second body colour.
 */
function tierFor(
  textPrimary: string,
  bgPrimary: string,
  grounds: readonly string[],
  target: number,
): string {
  for (let weight = 0.3; weight <= 0.98; weight += 0.01) {
    const candidate = mixHex(textPrimary, bgPrimary, weight);
    if (grounds.every((ground) => contrastRatio(candidate, ground) >= target)) return candidate;
  }
  return textPrimary;
}

/**
 * `--color-accent` is a fill; glyphs need their own value. Yellow's #c4a24a is a
 * fine block (6.44 against its foreground) and unreadable text (2.26 on paper),
 * so one token cannot serve both. Walk the fill towards the body colour until it
 * clears 4.5 - the four presets are solved the same way and pinned as literals
 * in `index.css`.
 */
function accentTextFor(accent: string, textPrimary: string, grounds: readonly string[]): string {
  for (let weight = 1; weight >= 0.15; weight -= 0.02) {
    const candidate = weight === 1 ? accent : mixHex(accent, textPrimary, weight);
    if (grounds.every((ground) => contrastRatio(candidate, ground) >= 4.5)) return candidate;
  }
  return mixHex(accent, textPrimary, 0.15);
}

/**
 * The value of `--color-bg-primary` as `#rrggbb`, for the native window surface.
 *
 * Custom properties are not resolved by the cascade, so the declared token comes
 * back verbatim — which is a hex literal for every theme that defines one. The
 * probe element is only there for the day a theme stops being a literal: painting
 * the value and reading `color` back lets the browser do the resolution.
 */
export function resolvedBackgroundHex(): string | null {
  const declared = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-primary").trim();
  if (/^#[0-9a-f]{6}$/i.test(declared)) return declared.toLowerCase();

  const probe = document.createElement("span");
  probe.style.color = "var(--color-bg-primary)";
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(resolved);
  if (!match) return null;
  return `#${match
    .slice(1, 4)
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function applyTheme(theme: ThemeType, customColors: CustomColors | null): void {
  const root = document.documentElement;

  // Remove all theme classes first
  root.classList.remove(...THEME_CLASSES);

  if (theme === "custom" && customColors) {
    root.classList.add("theme-custom");
    // The gutter has to stay one step away from the panel colors, otherwise the
    // translucent cards stop reading as lifted off the shell.
    const gutterDarken = luma(customColors.bgPrimary) > 0.5 ? 16 : 22;
    root.style.setProperty(
      "--color-bg-shell",
      `color-mix(in srgb, ${customColors.bgPrimary} ${100 - gutterDarken}%, #000)`,
    );
    root.style.setProperty("--color-bg-primary", customColors.bgPrimary);
    root.style.setProperty("--color-bg-secondary", customColors.bgSecondary);
    root.style.setProperty("--color-bg-sidebar", customColors.bgSidebar);
    root.style.setProperty("--color-text-primary", customColors.textPrimary);
    // Derived from the body colour *and measured* rather than mixed by a fixed
    // percentage: the old 76%/56% literals put the muted tier at 3.5:1 for a
    // mid-grey body, which is under the floor no matter what the user picked.
    const grounds = textGrounds(
      customColors.bgPrimary,
      customColors.bgSecondary,
      customColors.bgSidebar,
    );
    root.style.setProperty(
      "--color-text-secondary",
      tierFor(customColors.textPrimary, customColors.bgPrimary, grounds, 5.5),
    );
    root.style.setProperty(
      "--color-text-muted",
      tierFor(customColors.textPrimary, customColors.bgPrimary, grounds, 4.6),
    );
    root.style.setProperty("--color-border", `color-mix(in srgb, ${customColors.textPrimary} 18%, ${customColors.bgSecondary})`);
    root.style.setProperty("--color-accent", customColors.accent);
    // The user's own fill is unconstrained, so the text derivation is measured
    // here instead of inheriting the preset's literal.
    root.style.setProperty(
      "--color-accent-text",
      accentTextFor(customColors.accent, customColors.textPrimary, grounds),
    );
    root.style.setProperty("--color-bg-hover", customColors.bgSecondary);
    root.style.setProperty("--color-bg-active", customColors.bgSecondary);
    root.style.setProperty("--color-accent-light", customColors.bgSecondary);
    root.style.setProperty("--color-accent-hover", customColors.accent);
    root.style.setProperty("--color-danger", `color-mix(in srgb, #ef4444 72%, ${customColors.accent})`);
    // Same derivation as the line above, in JS, so the fore colour is measured
    // against the block that is actually painted rather than the preset red.
    root.style.setProperty("--color-on-accent", onColorFor(customColors.accent));
    root.style.setProperty("--color-on-danger", onColorFor(mixHex("#ef4444", customColors.accent, 0.72)));
  } else {
    // Clear inline custom properties
    for (const prop of CUSTOM_PROPS) {
      root.style.removeProperty(prop);
    }
    // blue is the default (no class needed)
    if (theme !== "blue") {
      root.classList.add(`theme-${theme}`);
    }
  }
}
