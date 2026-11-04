import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentLess, insertTab } from "@codemirror/commands";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const themeAwareMarkdownHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.processingInstruction, tags.punctuation, tags.bracket],
    color: "var(--color-text-secondary)",
  },
  {
    tag: [tags.heading, tags.strong],
    color: "var(--color-text-primary)",
    fontWeight: "700",
  },
  {
    tag: tags.emphasis,
    color: "var(--color-text-primary)",
    fontStyle: "italic",
  },
  {
    tag: [tags.link, tags.url, tags.labelName, tags.keyword, tags.atom, tags.bool],
    color: "color-mix(in srgb, var(--color-accent) 45%, var(--color-text-primary))",
    fontWeight: "600",
  },
  {
    tag: [tags.string, tags.character, tags.typeName, tags.className],
    color: "color-mix(in srgb, var(--color-success) 45%, var(--color-text-primary))",
  },
  {
    tag: [tags.number, tags.annotation, tags.changed],
    color: "color-mix(in srgb, var(--color-warning) 38%, var(--color-text-primary))",
  },
  {
    tag: [tags.regexp, tags.escape, tags.invalid, tags.deleted],
    color: "color-mix(in srgb, var(--color-danger) 50%, var(--color-text-primary))",
  },
  {
    tag: [tags.comment, tags.quote],
    color: "color-mix(in srgb, var(--color-text-secondary) 78%, var(--color-text-primary))",
    fontStyle: "italic",
  },
  {
    tag: [tags.operator, tags.propertyName, tags.attributeName],
    color: "var(--color-text-secondary)",
  },
  {
    tag: [tags.monospace, tags.content, tags.variableName, tags.name],
    color: "var(--color-text-primary)",
  },
]);

export const themeAwareMarkdownHighlighting = syntaxHighlighting(themeAwareMarkdownHighlightStyle);

/**
 * Body face when the user has not picked one.
 *
 * This is deliberately the UI sans stack and not a monospace one: a CJK glyph
 * has no monospace face on Windows, so a monospace body falls back per glyph to
 * a bitmap-era serif — which is exactly what made small sizes look pixelated.
 * Code keeps its own mono stack through `--editor-font-mono` in CSS.
 *
 * The CJK entries are ordered by *what Windows actually ships*: `PingFang SC`
 * only exists on macOS and used to sit in front of `Microsoft YaHei`, which made
 * every Chinese line fall through to the last family in the stack. `Microsoft
 * YaHei UI` comes first because it is the hinting-tuned UI cut of the same face
 * (sharper stems at 16px than plain YaHei), and `system-ui` keeps the Latin run
 * on whatever the OS considers its UI face.
 */
export const DEFAULT_BODY_FONT =
  'system-ui, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

/**
 * `family` as a CSS `font-family` value, with the system stack behind it.
 *
 * The user types a family name (`LXGW WenKai`), not a full stack, so it gets
 * quoted when needed and always keeps a fallback — a name that is not installed
 * must degrade to the system UI font, never to the browser default serif.
 */
export function bodyFontStack(family: string | null | undefined): string {
  const trimmed = (family ?? "").trim();
  if (!trimmed) return DEFAULT_BODY_FONT;
  const quoted = /^['"].*['"]$/.test(trimmed) ? trimmed : `"${trimmed}"`;
  return `${quoted}, ${DEFAULT_BODY_FONT}`;
}

/**
 * Font size and family in one extension, because both live in the same
 * `Compartment` in every editor instance and a separate one for the family
 * would just be another thing to keep in sync.
 */
export function codeMirrorTypographyTheme(
  fontSize: number,
  fontFamily?: string | null,
): Extension {
  // `undefined` means "leave the family alone": the cloud editor shares this
  // helper for its font size only, and handing it the local body stack would
  // silently restyle a surface that was never part of this change. An empty
  // string *is* a choice — the system stack.
  const family = fontFamily === undefined || fontFamily === null ? null : bodyFontStack(fontFamily);
  return EditorView.theme({
    "&": {
      fontSize: `${fontSize}px`,
      ...(family ? { fontFamily: family } : {}),
    },
    // The family has to be repeated here, and this is not belt-and-braces:
    // CodeMirror's base theme declares `font-family: monospace` on
    // `.cm-scroller` itself, which beats the value inherited from `.cm-editor`.
    // Until this rule existed the body stack never reached a single glyph — CJK
    // fell through `monospace` to SimSun, the bitmap-era serif that reads as
    // "fuzzy" at 16px. `font-size` stays on `&` alone; the scroller inherits it.
    ...(family ? { ".cm-scroller": { fontFamily: family } } : {}),
  });
}

export const literalTabIndentation: Extension = [
  EditorState.tabSize.of(4),
  indentUnit.of("\t"),
  Prec.highest(keymap.of([{ key: "Tab", run: insertTab, shift: indentLess }])),
];
