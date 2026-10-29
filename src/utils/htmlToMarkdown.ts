/**
 * HTML → Markdown, shared by every surface that has to read a note body.
 *
 * Three call sites depend on these exact rules, so they live here instead of
 * being copy-pasted per component:
 *
 * - `components/Editor/NoteEditor.tsx` — converts a stored note into the
 *   Markdown the editor edits (`isStoredEditorHtml(content) ? htmlToMarkdown(...)
 *   : content`).
 * - `App.tsx` — the file-export path writes Markdown, so an HTML-era note has
 *   to be converted on the way out.
 * - `plugin/bridge.ts` — `qing.notes.get()` promises Markdown to plugin
 *   authors; handing back tag-stripped text would silently destroy formatting
 *   on a read-modify-write round trip.
 *
 * The rules below are not cosmetic. `contentEditableLine` keeps one Enter
 * press as one newline (turndown's default would double it); `gfm` keeps
 * pasted tables and task lists as Markdown instead of flattening them; `img`
 * prefers the attachment source so a re-saved note does not lose its picture
 * after the app moves the file.
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * Does this string carry stored-editor HTML rather than Markdown?
 *
 * TipTap used to persist HTML; Markdown mode stores source. Both live in the
 * same `data/notes/<uuid>.md`, so every reader has to ask which one it is.
 * User-authored HTML inside Markdown mode is deliberately treated as text —
 * only the tags the old editor actually emitted count.
 */
export function isStoredEditorHtml(content: string): boolean {
  return /<\/?(p|h[1-6]|ul|ol|li|blockquote|pre|div|img|hr|br)\b[\s\S]*>/i.test(content);
}

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  bulletListMarker: "-",
  hr: "---",
});

// GFM plugin: turns pasted <table> markup back into a Markdown table instead
// of flattening it to plain lines. It only filters table/strikethrough/
// task-list nodes, so the two rules below keep their behaviour.
turndownService.use(gfm);

// contentEditable creates a <div> for a normal Enter press. Turndown treats
// block elements as paragraphs by default, which turns one Enter into two
// Markdown newlines. Keep normal div lines single-spaced while preserving an
// intentionally empty div as a blank line.
turndownService.addRule("contentEditableLine", {
  filter: "div",
  replacement: (content, node) => {
    const element = node as HTMLElement;
    const isEmptyLine = !element.textContent && element.querySelector("br");
    return isEmptyLine ? "\n\n" : `\n${content}\n`;
  },
});

// Keep images as markdown
turndownService.addRule("img", {
  filter: "img",
  replacement: (_content, node) => {
    const el = node as HTMLImageElement;
    const source = el.dataset.attachmentSrc || el.src;
    return `![${el.alt || "image"}](${source})`;
  },
});

/** Stored editor HTML → Markdown source. Idempotent input is not assumed. */
export function htmlToMarkdown(html: string): string {
  return turndownService
    .turndown(html)
    .replace(/\\([\\`*{}[\]()#+\-.!_>])/g, "$1");
}

/**
 * A note body as Markdown, whatever it happens to be stored as.
 *
 * `data/notes/*.md` holds editor HTML from before the Markdown rewrite and
 * Markdown afterwards, so "already Markdown" has to pass through untouched.
 */
export function storedContentToMarkdown(content: string): string {
  return isStoredEditorHtml(content) ? htmlToMarkdown(content) : content;
}
