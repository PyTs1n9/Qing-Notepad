import type { EditorView } from "@codemirror/view";
import { codeBlockLanguageSpec } from "./codeBlock";

/**
 * The code-block language picker: a hand-built popup, no React and no store.
 *
 * Why not `components/Layout/DropdownMenu.tsx` (the one dropdown in the app):
 * that component is a React control driven by state, and this menu is opened
 * from inside a CodeMirror widget — a DOM node with no React tree above it and
 * no way to hand one a `useState` setter. Rendering a portal per chip would
 * also mean one React root per code block.
 *
 * Why it must be appended to `document.body` rather than kept inside the widget:
 * the editor card carries `container-type: inline-size`, which implies
 * `contain: layout` and makes that card the containing block for `position:
 * fixed` descendants. Anchored inside the widget, the panel would be positioned
 * against the card *and* clipped by its `overflow: hidden` — the same trap
 * `DropdownMenu.tsx` documents at length.
 *
 * Closing is "close only, never follow": the panel is measured once against the
 * anchor and then left alone. Repositioning on every scroll frame would put a
 * DOM write inside the editor's scroll path, and the anchor chip is about to be
 * re-created by a decoration rebuild anyway.
 */

export interface CodeLanguageMenuOptions {
  /** The chip the panel attaches to. */
  anchor: HTMLElement;
  /** Dispatches the rewrite; also the source of the document state. */
  view: EditorView;
  /** `FencedCode.from` of the block being edited. */
  blockFrom: number;
  /** First word of the fence's info string, `""` when there is none. */
  current: string;
  /** Menu rows, in order (`CODE_LANGUAGES`). */
  languages: readonly string[];
  /** Label of the last row, which clears the language (`""`). */
  plainText: string;
  /**
   * Fired after a pick has been dispatched. The rewrite itself is owned by this
   * module — a caller that also dispatched would double-apply it — so this is a
   * notification hook, not the action.
   */
  onPick: (language: string | null) => void;
}

/** Gap between the chip and the panel, and the viewport inset it avoids. */
const GAP = 6;
const MARGIN = 8;

interface ActiveMenu {
  panel: HTMLDivElement;
  view: EditorView;
  blockFrom: number;
  onPick: (language: string | null) => void;
  detach: () => void;
}

/** Module-level singleton: the editor shows at most one of these. */
let active: ActiveMenu | null = null;

/**
 * Show the picker under (or above) `options.anchor`.
 *
 * Opening while another panel is open closes that one first — two panels would
 * both be pinned to a chip that only one of them belongs to.
 */
export function openCodeLanguageMenu(options: CodeLanguageMenuOptions): void {
  closeCodeLanguageMenu();

  const panel = buildPanel(options);
  // `visibility: hidden` for the measuring pass: `offsetWidth`/`offsetHeight`
  // are 0 for a `display: none` element, and the flip-above decision needs the
  // real height before the first paint — otherwise the panel is visible for one
  // frame at the wrong edge.
  panel.style.visibility = "hidden";
  document.body.appendChild(panel);
  placePanel(panel, options.anchor);

  const { view, blockFrom, onPick } = options;

  /**
   * Capture phase everywhere: the editor and its widgets handle `mousedown` and
   * `keydown` themselves, and a bubble-phase listener would only see the events
   * they declined.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    closeCodeLanguageMenu();
  };
  const onMouseDown = (event: MouseEvent): void => {
    // A click on a row is handled by the row; a click anywhere else is "dismiss".
    if (event.target instanceof Node && panel.contains(event.target)) return;
    closeCodeLanguageMenu();
  };
  const onScroll = (): void => closeCodeLanguageMenu();
  const onResize = (): void => closeCodeLanguageMenu();
  const onBlur = (): void => closeCodeLanguageMenu();

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("mousedown", onMouseDown, true);
  // `passive`: this listener never calls `preventDefault`, and saying so keeps it
  // off the scroll critical path. Capture so a nested scroller inside the editor
  // cannot swallow it.
  view.scrollDOM.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onBlur);

  active = {
    panel,
    view,
    blockFrom,
    onPick,
    detach: () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      view.scrollDOM.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
    },
  };

  for (const item of Array.from(panel.children)) {
    if (!(item instanceof HTMLElement) || item.dataset.lang === undefined) continue;
    item.addEventListener("mousedown", (event) => {
      // `mousedown`, not `click`: the editor would otherwise steal focus and move
      // the caret before the click lands, and a `Decoration.replace` widget
      // re-created in between would swallow the click entirely.
      event.preventDefault();
      event.stopPropagation();
      pick(item.dataset.lang ?? "");
    });
  }
}

/** Remove the panel and every listener it installed. Safe to call at any time. */
export function closeCodeLanguageMenu(): void {
  if (!active) return;
  const { panel, detach } = active;
  active = null;
  detach();
  panel.remove();
}

/** One row was chosen. `""` is the "plain text" row, which clears the fence. */
function pick(raw: string): void {
  if (!active) return;
  const { view, blockFrom, onPick } = active;
  closeCodeLanguageMenu();

  const language = raw === "" ? null : raw;
  // One transaction, one undo step. No `scrollIntoView`: the chip can be clicked
  // near the bottom edge, and yanking the viewport under the pointer after a
  // two-character edit reads as a glitch.
  const spec = codeBlockLanguageSpec(view.state, blockFrom, language);
  if (spec) view.dispatch(spec);
  onPick(language);
}

function buildPanel(options: CodeLanguageMenuOptions): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "cm-code-lang-menu";
  // Inline the two positioning properties the algorithm below depends on; every
  // other visual decision is CSS, keyed off `.cm-code-lang-menu`.
  panel.style.position = "fixed";
  panel.style.top = "0px";
  panel.style.left = "0px";

  for (const language of options.languages) {
    panel.appendChild(buildItem(language, language, language === options.current));
  }

  // Separates "a language" from "no language": the last row is a different kind
  // of answer, not one more language.
  const separator = document.createElement("div");
  separator.className = "cm-code-lang-sep";
  panel.appendChild(separator);

  // `data-lang=""` marks the clearing row. No `tabindex` anywhere: the panel is
  // pointer-only by design (the owner asked for no focus ring), and adding one
  // would put a focusable element inside a widget that CodeMirror's own
  // selection model does not know about.
  panel.appendChild(buildItem("", options.plainText, options.current === ""));
  return panel;
}

function buildItem(language: string, label: string, isActive: boolean): HTMLDivElement {
  const item = document.createElement("div");
  item.className = isActive ? "cm-code-lang-item is-active" : "cm-code-lang-item";
  item.dataset.lang = language;
  item.textContent = label;
  return item;
}

/**
 * Above the chip by default, flipped below when the space above is too small,
 * then clamped into the viewport.
 *
 * The panel's right edge is aligned to the chip's right edge before clamping:
 * the chip sits at the card's bottom-right corner, so a left-aligned panel would
 * hang past the card — and past the window, once clamped, which reads as the
 * menu jumping away from the thing it was opened from.
 */
function placePanel(panel: HTMLDivElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  // `clientWidth/Height` rather than `innerWidth/Height`: the latter includes the
  // scrollbar, and a panel placed there would sit under it.
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;

  let top = rect.top - height - GAP;
  if (top < MARGIN) top = rect.bottom + GAP;
  // `Math.max(MARGIN, …)` on the upper bound: a panel taller than the viewport
  // would otherwise get a negative bound and land off-screen at the top.
  top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, viewportHeight - height - MARGIN));

  let left = rect.right - width;
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, viewportWidth - width - MARGIN));

  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.visibility = "visible";
}
