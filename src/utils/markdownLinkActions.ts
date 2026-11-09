import { openUrl } from "@tauri-apps/plugin-opener";
import type { EditorView } from "@codemirror/view";
import { useNoteStore } from "@/stores/noteStore";
import { useTabStore } from "@/stores/tabStore";
import {
  resolveMarkdownLink,
  scrollToAnchorInElement,
  scrollToAnchorInView,
  type LinkNote,
  type MarkdownLinkTarget,
} from "@/utils/markdownLinks";

/**
 * Click routing for rendered Markdown links.
 *
 * Two surfaces render links differently but must behave identically:
 * - the WYSIWYG editor collapses `[label](url)` into styled text, so the link is
 *   resolved from the syntax tree (`linkUrlAt`) and this module only receives
 *   the destination;
 * - `dangerouslySetInnerHTML` previews emit real `<a href>`, so the anchor is
 *   read from the DOM.
 *
 * Every path ends in `preventDefault`: a webview that handles `<a href="x.md">`
 * itself would navigate away from the app and leave a blank shell with no way
 * back. An unresolvable target therefore still swallows the click.
 */

function linkNotes(): LinkNote[] {
  return useNoteStore.getState().notes.map((note) => ({ id: note.id, title: note.title }));
}

/**
 * Whether this click asks for navigation rather than a caret.
 *
 * macOS puts ⌘ on link clicks (Ctrl+click there is a secondary click, i.e. the
 * context menu), every other platform uses Ctrl. Testing both at once — what the
 * first draft did — makes a Windows Ctrl+click a no-op whenever the user also
 * happens to hold ⌘, and makes a mac Ctrl+click navigate when it should open a
 * menu.
 */
export function isLinkClickModifier(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
  return isMac ? event.metaKey : event.ctrlKey;
}

export interface MarkdownLinkContext {
  /** Live CodeMirror view; anchors scroll inside it when present. */
  view?: EditorView | null;
  /** Rendered HTML container; used for anchors when there is no view. */
  container?: HTMLElement | null;
  /**
   * Whether a relative `other.md` may switch notes. Off for surfaces whose
   * content is not the local notebook (a cloud document, a graph node preview),
   * where matching a title against the local note list would jump somewhere the
   * reader never pointed at.
   */
  allowNoteLinks?: boolean;
}

/**
 * Perform whatever a resolved target asks for.
 *
 * The return value is "did something actually happen" — not "the destination was
 * recognised". Callers use it to decide whether the click was used up: an
 * editable editor that gets `false` leaves the click to CodeMirror so the caret
 * still lands where the user clicked, instead of a dead zone that looks broken.
 */
export function runMarkdownLinkTarget(
  target: MarkdownLinkTarget,
  context: MarkdownLinkContext = {},
): boolean {
  switch (target.kind) {
    case "external":
      // Handing the URL to the OS is as far as this app can verify, so it counts
      // as done: a browser that fails to launch is not a reason to also drop the
      // caret somewhere.
      void openUrl(target.url).catch((error) => {
        console.error("Failed to open link:", error);
      });
      return true;

    case "anchor":
      if (context.view && scrollToAnchorInView(context.view, target.anchor)) return true;
      if (context.container && scrollToAnchorInElement(context.container, target.anchor)) return true;
      return false;

    case "note": {
      if (context.allowNoteLinks === false) return false;
      // No special case for a link naming the note it sits in: cross-note anchors
      // are not supported this round, so activating the already-active tab is the
      // whole of that jump — and it needs no knowledge of which note was clicked.
      // The id came from the note list, but the list can have changed between the
      // render and the click (a note deleted in another window).
      if (!useNoteStore.getState().notes.some((note) => note.id === target.noteId)) return false;
      useTabStore.getState().openTab(target.noteId);
      return true;
    }

    case "none":
      return false;
  }
}

/** Resolve and run a raw Markdown destination. */
export function openMarkdownLink(
  href: string,
  context: MarkdownLinkContext = {},
): boolean {
  return runMarkdownLinkTarget(resolveMarkdownLink(href, linkNotes()), context);
}

/**
 * Click handler for a rendered-HTML container.
 *
 * Without `requireModifier` a plain click follows the link, which is what a
 * read-only preview should do. The editable editor passes `true`, so clicking
 * inside link text still places the caret and only Ctrl/Cmd+click navigates.
 *
 * `stopPropagation` is deliberately absent. `preventDefault` is what stops the
 * webview from navigating, and it is unaffected by propagation; stopping the
 * bubble as well only keeps every ancestor from hearing a click it may need
 * (selection sync, closing an overlay, a surface's own click-away logic), and it
 * does so invisibly.
 */
export function handleMarkdownLinkClick(
  event: MouseEvent | React.MouseEvent<HTMLElement>,
  context: MarkdownLinkContext & { requireModifier?: boolean } = {},
): boolean {
  if (event.button !== 0) return false;
  if (context.requireModifier && !isLinkClickModifier(event)) return false;

  const target = event.target as Element | null;
  const anchor = (target?.closest("a[href]") ?? null) as HTMLAnchorElement | null;
  if (!anchor) return false;
  if (context.container && !context.container.contains(anchor)) return false;

  // A non-collapsed selection means the user is selecting text (a double-click
  // selects the word under the pointer), not following a link. Navigating here
  // would scroll the page away from the text being selected.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return false;

  const href = anchor.getAttribute("href") ?? "";
  // Swallow the navigation even when nothing below resolves: an `<a href>` that
  // reaches the webview replaces the whole app with a blank shell.
  event.preventDefault();

  return openMarkdownLink(href, context);
}
