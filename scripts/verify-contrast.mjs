/**
 * WCAG contrast audit for every pair of colours the app actually paints text on.
 *
 * The palette is parsed out of `src/index.css` instead of being copied here:
 * a hard-coded copy would pass while the sheet drifted away from it, which is
 * exactly the failure this script exists to catch.
 *
 * Three groups, because the app has three distinct failure modes:
 *
 * 1. **Blocks** - `--color-on-*` on the saturated fills. `/90` style Tailwind
 *    opacity utilities are modelled as alpha compositing over the surface they
 *    are drawn on: a 90% danger block over a light background is *lighter* than
 *    the solid block, so the solid value passing does not mean the hover does.
 *
 * 2. **Text tiers** - `text-primary` / `text-secondary` / `text-muted` /
 *    `text-accent-text` on the three surfaces they land on. This group was
 *    missing until 2026-10-27, which is why the audit reported 0 failures while
 *    75 of 120 text pairs were under 4.5:1 - it only ever measured the fills.
 *    `text-accent-text` is separate from `--color-accent` on purpose: a fill and
 *    a glyph colour have opposite luminance requirements.
 *
 * 3. **Composited** - the frosted card is a `tint%` panel over the shell, not
 *    `--color-bg-primary`, so the static ratios above are best-case. The tint is
 *    read from `:root` and applied with source-over before measuring.
 *
 * `bg-hover` / `bg-active` are deliberately absent: they are transient states
 * whose text is `text-primary`. The one exception already handled above is the
 * danger hover block.
 *
 * Run: node scripts/verify-contrast.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src", "index.css"), "utf8");

/** Extracts `--name: #hex;` declarations from the body of one selector block. */
function readBlock(selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out = {};
  for (const [, name, value] of body.matchAll(/--(color-[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[name] = value;
  }
  return out;
}

/** Reads a bare `--name: <number>;` from the sheet, e.g. the frosted tint. */
function readNumber(name) {
  const match = new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)\\s*;`).exec(css);
  if (!match) throw new Error(`numeric token not found: --${name}`);
  return Number(match[1]);
}

const base = readBlock("@theme {");
const themes = {
  blue: { ...base, ...readBlock(".theme-blue {") },
  dark: { ...base, ...readBlock(".theme-dark {") },
  yellow: { ...base, ...readBlock(".theme-yellow {") },
  green: { ...base, ...readBlock(".theme-green {") },
};

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance([r, g, b]) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg, bg) {
  const a = luminance(channels(fg));
  const b = luminance(channels(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Source-over compositing of `fg` at `alpha` onto opaque `bg`. */
function over(fg, alpha, bg) {
  const f = channels(fg);
  const b = channels(bg);
  return `#${f
    .map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0"))
    .join("")}`;
}

const FLOOR = 4.5;
const rows = [];
const fail = [];
const notes = [];

// ---------------------------------------------------------------- 1. blocks
for (const [theme, palette] of Object.entries(themes)) {
  // `warning` joined the audit when the yellow blocks stopped painting white
  // text: it is a light ground in all four themes, so its foreground has to be
  // measured like the other three. Only the solid block carries text - the
  // `/10` variants are hover washes with no glyphs on them.
  for (const kind of ["accent", "success", "danger", "warning"]) {
    const on = palette[`color-on-${kind}`];
    if (!on) {
      fail.push({ theme, label: `missing --color-on-${kind}`, fg: "", bg: "", ratio: 0 });
      continue;
    }
    // Solid block, plus the translucent variants the app actually paints text
    // on. `/90` and `/80` are modelled as alpha compositing over the surface
    // the block sits on: a 90% danger block over a light background is
    // *lighter* than the solid one. Accent and success are never used
    // translucent under text (their translucent uses are guide lines).
    const variants = [{ label: `bg-${kind}`, block: palette[`color-${kind}`], alpha: 1, gating: true }];
    if (kind === "danger") {
      variants.push({ label: "bg-danger/90", block: palette["color-danger"], alpha: 0.9, gating: true });
      // `disabled:bg-danger/80` is the only 80% site. WCAG 1.4.3 exempts
      // inactive controls, so it is reported but does not gate the batch.
      variants.push({
        label: "bg-danger/80 (disabled)",
        block: palette["color-danger"],
        alpha: 0.8,
        gating: false,
      });
    }
    if (kind === "accent") {
      variants.push({ label: "bg-accent-hover", block: palette["color-accent-hover"], alpha: 1 });
    }

    for (const variant of variants) {
      for (const ground of ["color-bg-primary", "color-bg-secondary"]) {
        const block =
          variant.alpha === 1 ? variant.block : over(variant.block, variant.alpha, palette[ground]);
        const ratio = contrast(on, block);
        const entry = {
          group: "block",
          theme,
          label: `${variant.label} over ${ground.replace("color-", "")}`,
          fg: block,
          bg: on,
          ratio,
          gating: variant.gating,
        };
        rows.push(entry);
        if (ratio < FLOOR && variant.gating) fail.push(entry);
      }
    }
  }
}

// ------------------------------------------------------------- 2. text tiers
// The three surfaces body text sits on. `bg-hover` is excluded on purpose: it
// is a transient state and the row that shows it switches to `text-primary`.
const GROUNDS = ["color-bg-primary", "color-bg-secondary", "color-bg-sidebar"];
const TIERS = ["color-text-primary", "color-text-secondary", "color-text-muted", "color-accent-text"];

for (const [theme, palette] of Object.entries(themes)) {
  for (const tier of TIERS) {
    const fg = palette[tier];
    if (!fg) {
      fail.push({ theme, label: `missing --${tier}`, fg: "", bg: "", ratio: 0 });
      continue;
    }
    for (const ground of GROUNDS) {
      const bg = palette[ground];
      const ratio = contrast(fg, bg);
      const entry = {
        group: "text",
        theme,
        label: `${tier.replace("color-", "")} on ${ground.replace("color-", "")}`,
        fg,
        bg,
        ratio,
        gating: true,
      };
      rows.push(entry);
      if (ratio < FLOOR) fail.push(entry);
    }
  }

  // The tier order is what makes secondary and muted distinguishable. Without
  // this check a fix could pass every ratio and still flatten the hierarchy
  // into one grey - the old yellow palette failed from the other direction.
  const order = ["color-text-primary", "color-text-secondary", "color-text-muted"].map((tier) =>
    contrast(palette[tier], palette["color-bg-primary"]),
  );
  if (!(order[0] > order[1] && order[1] > order[2])) {
    fail.push({
      theme,
      group: "text",
      label: "tier order (primary > secondary > muted)",
      fg: order.map((r) => r.toFixed(2)).join(" > "),
      bg: "",
      ratio: Math.min(...order),
      gating: true,
    });
  }

  // `text-accent-text` also lands on the tinted selection background. Reported
  // but not gated: that wash is a highlight and its text is usually primary.
  const onLight = contrast(palette["color-accent-text"], palette["color-accent-light"]);
  rows.push({
    group: "text",
    theme,
    label: "text-accent-text on accent-light (reported)",
    fg: palette["color-accent-text"],
    bg: palette["color-accent-light"],
    ratio: onLight,
    gating: false,
  });
  if (onLight < FLOOR) {
    notes.push(`${theme}: text-accent-text on accent-light is ${onLight.toFixed(2)}`);
  }
}

// ------------------------------------------------------------ 3. composited
// `tint%` of the panel colour over the shell, matching `.surface-glass::before`.
// Two layers: the rails (sidebar tint over the shell) and the main card.
const tintSide = readNumber("glass-tint-side");
const tintEditor = readNumber("glass-tint-editor");

for (const [theme, palette] of Object.entries(themes)) {
  const layers = [
    { label: `sidebar tint ${tintSide}`, panel: palette["color-bg-sidebar"], tint: tintSide / 100 },
    { label: `editor tint ${tintEditor}`, panel: palette["color-bg-primary"], tint: tintEditor / 100 },
  ];
  for (const layer of layers) {
    const surface = over(layer.panel, layer.tint, palette["color-bg-shell"]);
    for (const tier of TIERS) {
      const ratio = contrast(palette[tier], surface);
      const entry = {
        group: "composited",
        theme,
        label: `${tier.replace("color-", "")} on ${layer.label}`,
        fg: palette[tier],
        bg: surface,
        ratio,
        gating: true,
      };
      rows.push(entry);
      if (ratio < FLOOR) fail.push(entry);
    }
  }
}

// ------------------------------------------------------------ 4. accent wash
// Selection rows paint `bg-accent/15` under `text-accent-text`. The wash is a
// tint of the fill, so it is composited as a surface rather than a block. Blue
// clears this by 0.01, which is exactly the kind of margin a gate should hold.
const WASH_ALPHA = 0.15;

for (const [theme, palette] of Object.entries(themes)) {
  const surface = over(palette["color-accent"], WASH_ALPHA, palette["color-bg-primary"]);
  const ratio = contrast(palette["color-accent-text"], surface);
  const entry = {
    group: "wash",
    theme,
    label: `text-accent-text on bg-accent/${WASH_ALPHA * 100}`,
    fg: palette["color-accent-text"],
    bg: surface,
    ratio,
    gating: true,
  };
  rows.push(entry);
  if (ratio < FLOOR) fail.push(entry);
}

// ------------------------------------------------------------- 5. tint floor
// The slider runs 0-100 on purpose: clamping it to a "safe" minimum left only a
// quarter of the track usable. Readability is handled by `.app-root[data-
// contrast="boost"]`, which promotes the two weak tiers once the tint drops
// under GLASS_READABILITY_FLOOR. Both constants live in the store, so they are
// read from there - this gate exists so neither can silently regress.
const storeSrc = readFileSync(join(root, "src", "stores", "settingsStore.ts"), "utf8");
const num = (name) => {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(storeSrc);
  if (!match) throw new Error(`${name} not found in settingsStore.ts`);
  return Number(match[1]);
};
const minRailTint = num("MIN_GLASS_TINT");
const readabilityFloor = num("GLASS_READABILITY_FLOOR");
const boosted = minRailTint < readabilityFloor;

for (const [theme, palette] of Object.entries(themes)) {
  const surface = over(palette["color-bg-sidebar"], minRailTint / 100, palette["color-bg-shell"]);
  // Mirrors the CSS: muted is promoted wholesale, accent-text keeps a quarter of
  // the fill mixed into the body colour.
  const tiers = [
    ["text-muted", boosted ? palette["color-text-secondary"] : palette["color-text-muted"]],
    [
      "accent-text",
      boosted
        ? over(palette["color-accent"], 0.25, palette["color-text-primary"])
        : palette["color-accent-text"],
    ],
  ];
  for (const [label, fg] of tiers) {
    const ratio = contrast(fg, surface);
    const entry = {
      group: "floor",
      theme,
      label: `${label} at rail floor ${minRailTint}${boosted ? " (boosted)" : ""}`,
      fg,
      bg: surface,
      ratio,
      gating: true,
    };
    rows.push(entry);
    if (ratio < FLOOR) fail.push(entry);
  }
}

// -------------------------------------------------------------------- output
const pad = (v, n) => String(v).padEnd(n);
const groups = {
  block: "colour blocks (text on a saturated fill)",
  text: "text tiers (body text on a surface)",
  composited: "composited (frosted card over the shell)",
  wash: "accent wash (selection rows)",
  floor: "tint floor (most transparent the sliders allow)",
};

for (const [key, title] of Object.entries(groups)) {
  const set = rows.filter((r) => r.group === key);
  console.log(`\n=== ${title} ===`);
  console.log(`${pad("theme", 8)}${pad("pair", 52)}${pad("fg", 10)}${pad("bg", 10)}${pad("ratio", 8)}verdict`);
  for (const r of set) {
    console.log(
      `${pad(r.theme, 8)}${pad(r.label, 52)}${pad(r.fg, 10)}${pad(r.bg, 10)}${pad(
        r.ratio.toFixed(2),
        8,
      )}${r.ratio >= FLOOR ? "pass" : r.gating ? "FAIL" : "exempt"}`,
    );
  }
}

if (notes.length) {
  console.log(`\n${notes.length} non-gating note(s):`);
  for (const note of notes) console.log(`  ${note}`);
}

const passing = rows.filter((r) => r.ratio >= FLOOR).length;
console.log(`\n${rows.length} combinations, ${passing} at or above ${FLOOR}:1`);
if (fail.length) {
  console.log(`${fail.length} below ${FLOOR}:1`);
  for (const f of fail) console.log(`  ${f.theme} ${f.label} ${f.ratio.toFixed(2)}`);
  process.exit(1);
}
console.log("no failures");
