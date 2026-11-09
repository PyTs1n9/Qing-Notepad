import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { JUMP_MARGIN, scrollEditorToPosition } from "@/utils/editorScrollJump";
import { isExternalScheme, schemeOf } from "@/utils/linkScheme";
import { extractOutline } from "@/utils/noteOutline";
import { animateScrollTop } from "@/utils/smoothScroll";

/**
 * URL of the Markdown link under `pos`, or `null`.
 *
 * The live preview hides the `[label](url)` markup, so what a reader sees is the
 * label alone — there is no `<a>` element left to click. Both the read-only
 * preview and the sticky window therefore resolve the link from the syntax tree
 * when the click lands on it.
 */
export function linkUrlAt(state: EditorState, pos: number): string | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name !== "Link" && node.name !== "Autolink") continue;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "URL") return state.sliceDoc(child.from, child.to);
    }
    return null;
  }
  return null;
}

/**
 * What a Markdown link destination resolved to.
 *
 * - `external`: a real URL (`http`, `https`, `mailto`, `tel`) — the OS handler
 *   opens it. Everything else with a scheme is refused, so `javascript:` never
 *   becomes a click target.
 * - `anchor`: a position inside the current note (`#小节`).
 * - `note`: another note in the notebook, matched by title.
 * - `none`: empty, malformed, or pointing at something the app cannot open.
 *   Callers must still swallow the click: letting the webview handle it would
 *   navigate away from the app.
 */
export type MarkdownLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; anchor: string }
  /**
   * `anchor` is deliberately absent: cross-note anchors (`other.md#小节`) are not
   * supported in this round. The hash is still split off the path so
   * `other.md#小节` switches notes instead of failing to match a title that ends
   * in `#小节`, but the type does not promise a scroll the app cannot perform.
   */
  | { kind: "note"; noteId: string }
  | { kind: "none" };

/** The slice of a note the resolver needs; keeps this module store-free. */
export interface LinkNote {
  id: string;
  title: string;
}

const NONE: MarkdownLinkTarget = { kind: "none" };

/** `C:\…` and `C:/…`: a drive letter, not a scheme. */
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const NOTE_EXTENSION = /\.(md|markdown|txt)$/i;
/** A trailing `.png` / `.pdf` names a file, not a note. */
const FILE_EXTENSION_TAIL = /\.([a-z0-9]{1,5})$/i;

function decodeSafe(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * Comparison key for heading text and note titles.
 *
 * Applied to both sides of every comparison so `#Hello-World`, `#hello world`
 * and `#Ｈｅｌｌｏ　Ｗｏｒｌｄ` land on the same section, mirroring the way the
 * graph resolver normalises targets. Punctuation is dropped as well: a heading
 * rendered as `快速开始：准备` is still reachable as `#快速开始准备`.
 */
export function looseLinkKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_]+/g, "")
    .replace(/[.,;:!?'"()[\]{}<>/\\|`~@#$%^&*+=]+/g, "");
}

function splitAnchor(raw: string): { path: string; anchor: string } {
  const hashIndex = raw.indexOf("#");
  if (hashIndex < 0) return { path: raw, anchor: "" };
  return {
    path: raw.slice(0, hashIndex),
    anchor: decodeSafe(raw.slice(hashIndex + 1)).trim(),
  };
}

/** Title-shaped name of a link destination, or `null` when it names a file. */
function noteNameOf(path: string): string | null {
  const name = basenameOfPath(decodeSafe(path)).trim();
  if (!name) return null;
  const withoutExtension = name.replace(NOTE_EXTENSION, "");
  const extension = FILE_EXTENSION_TAIL.exec(withoutExtension)?.[1] ?? "";
  // `report.pdf` is a file, `v1.2 计划` is a title that happens to contain a dot.
  if (extension && !NOTE_EXTENSION.test(`.${extension}`)) return null;
  return withoutExtension.trim() || null;
}

/**
 * Matching is by **title**, not by file name: the path segment is only a hint
 * for which note the author meant, and the note list is what decides. Two notes
 * sharing a title is a real possibility, and picking one would be a guess.
 */
function findNoteByTitle(name: string, notes: readonly LinkNote[]): string | null {
  const key = looseLinkKey(name);
  if (!key) return null;
  const matches = notes.filter((note) => looseLinkKey(note.title) === key);
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Classify a Markdown link destination.
 *
 * Order matters: a scheme is checked before `#` so `https://x/#frag` stays one
 * URL, while `#小节` and `other.md#小节` are split into path + anchor.
 */
export function resolveMarkdownLink(
  href: string,
  notes: readonly LinkNote[] = [],
): MarkdownLinkTarget {
  // `[x](<a b.md>)` — CommonMark allows angle brackets around a destination
  // containing spaces.
  const raw = href.trim().replace(/^<(.+)>$/, "$1").trim();
  if (!raw) return NONE;

  if (schemeOf(raw)) {
    // A Windows path looks exactly like a one-letter scheme. Checked before the
    // scheme allowlist so `C:\x\y.md` reads as a file, not as scheme `c:`.
    if (WINDOWS_DRIVE_PATH.test(raw)) return NONE;
    if (!isExternalScheme(raw)) return NONE;
    return { kind: "external", url: raw };
  }

  // Protocol-relative `//host/path` is http(s) transport, not a note path.
  if (raw.startsWith("//")) return { kind: "external", url: `https:${raw}` };

  const { path, anchor } = splitAnchor(raw);
  const querylessPath = path.split("?", 1)[0].trim();
  if (!querylessPath) return anchor ? { kind: "anchor", anchor } : NONE;

  const name = noteNameOf(querylessPath);
  if (!name) return NONE;
  const noteId = findNoteByTitle(name, notes);
  if (!noteId) return NONE;
  return { kind: "note", noteId };
}

/** Position of the heading matching `anchor`, or `null`. */
export function findHeadingPosition(state: EditorState, anchor: string): number | null {
  const key = looseLinkKey(anchor);
  if (!key) return null;
  const heading = extractOutline(state.doc.toString()).find(
    (entry) => looseLinkKey(entry.text) === key,
  );
  if (!heading) return null;
  const lineNumber = Math.min(heading.line + 1, state.doc.lines);
  return state.doc.line(lineNumber).from;
}

/**
 * Scroll the editor to `anchor` and leave the caret there. Returns false when
 * the note has no such heading, so the caller can report "nothing to do"
 * without moving anything.
 */
export function scrollToAnchorInView(view: EditorView, anchor: string): boolean {
  const position = findHeadingPosition(view.state, anchor);
  if (position === null) return false;
  view.dispatch({ selection: { anchor: position } });
  // Focusing a read-only preview would steal focus from the window that is
  // currently gliding to the heading and abort its own animation.
  if (!view.state.readOnly) view.focus();
  scrollEditorToPosition(view, position);
  return true;
}

function nearestScrollable(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * Same jump for rendered HTML (`.markdown-preview`), where headings are real
 * elements without ids. Matching by text keeps the two surfaces on one rule
 * instead of adding ids that a re-render would have to keep unique.
 */
export function scrollToAnchorInElement(container: HTMLElement, anchor: string): boolean {
  const key = looseLinkKey(anchor);
  if (!key) return false;
  const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  const heading = headings.find((node) => looseLinkKey(node.textContent ?? "") === key);
  if (!heading) return false;

  const scroller = nearestScrollable(container);
  if (!scroller) {
    heading.scrollIntoView({ block: "start" });
    return true;
  }
  const offset =
    heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  animateScrollTop(scroller, offset - JUMP_MARGIN);
  return true;
}
