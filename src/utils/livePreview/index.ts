import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { blockAtPosition } from "../editorBlocks";
import { tablePreview } from "./tableField";
import { codeFenceInfoAt } from "./codeBlock";
import { closeCodeLanguageMenu } from "./codeLanguageMenu";
import {
  DEFAULT_CODE_PLAIN_TEXT,
  buildLivePreviewDecorations,
  collectLivePreviewRanges,
  toDecorationRanges,
  type LivePreviewOptions,
  type VisibleRange,
} from "./decorations";

/**
 * Live preview (L1 + L3): hides Markdown markers and paints block-level visuals,
 * except in the block the caret sits in, which falls back to source.
 *
 * That fallback is not a preference: `Decoration.replace` makes its own range
 * unreachable for the caret, so a rendered block could not be edited unless the
 * caret's block shows raw text.
 *
 * The layer is a `ViewPlugin` rather than a state field on purpose:
 * - it needs the viewport (`view.visibleRanges`), a view concern;
 * - note switching re-keys `MarkdownSourceEditor` and destroys the view, so all
 *   of this state has to die with it. Nothing here is cached outside the
 *   instance, and `destroy()` unhooks the DOM listeners it installed.
 *
 * It coexists with `pluginDecorations` (a state field providing the same
 * `EditorView.decorations` facet): CodeMirror merges providers and sorts the
 * union, so neither the order in the extension list nor overlapping ranges can
 * throw.
 */
class LivePreviewView {
  decorations: DecorationSet;

  /** The block the caret is in; `null` when it sits between blocks. */
  private active: VisibleRange | null;

  /** True between `compositionstart` and `compositionend`. */
  private composing = false;

  /** Set on `compositionend`; the next update rebuilds, or one is forced. */
  private settlePending = false;

  /** Switching notes destroys the view; the deferred settle must not touch it. */
  private destroyed = false;

  /** See `LivePreviewConfig.revealActiveBlock`. */
  private readonly revealActiveBlock: boolean;

  /** Resolved chip configuration; `mode` also decides whether hover is wired. */
  private readonly codeLanguage: CodeLanguageOptions;

  /**
   * The code block whose chip currently carries `.is-visible`, or `null`.
   *
   * Hover is *state on the view*, never a decoration: rebuilding the decoration
   * set on every `mousemove` would re-create the chip DOM under the pointer,
   * which loses the hover, fires `mouseleave`, and produces a flicker loop. So
   * the chip is always in the set and CSS decides whether it shows.
   */
  private hoveredBlock: number | null = null;

  /** Last pointer position, so a rebuild can re-apply the class without an event. */
  private lastPointer: { x: number; y: number } | null = null;

  /** Pending `requestAnimationFrame` id for the hover pass; `0` = none. */
  private hoverFrame = 0;

  constructor(
    private readonly view: EditorView,
    revealActiveBlock: boolean,
    codeLanguage: CodeLanguageOptions,
  ) {
    this.revealActiveBlock = revealActiveBlock;
    this.codeLanguage = codeLanguage;
    this.active = this.computeActive(view.state);
    this.decorations = buildLivePreviewDecorations(
      view.state,
      view.visibleRanges,
      previewOptions(this.active, codeLanguage),
    );
    view.contentDOM.addEventListener("compositionstart", this.onCompositionStart);
    view.contentDOM.addEventListener("compositionend", this.onCompositionEnd);
    // Only the interactive surface gets hover: a `static` chip is a label, and a
    // label has nothing to reveal on hover.
    if (codeLanguage.mode === "menu") {
      view.contentDOM.addEventListener("mousemove", this.onMouseMove);
      view.contentDOM.addEventListener("mouseleave", this.onMouseLeave);
    }
  }

  update(update: ViewUpdate): void {
    if (this.composing) {
      // Frozen. Only positions move: recomputing here would swap decorations
      // under the IME candidate window, and every rebuild makes CodeMirror
      // re-measure the line the composition is anchored to.
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      return;
    }

    const settling = this.settlePending;
    this.settlePending = false;

    if (
      settling ||
      update.docChanged ||
      update.viewportChanged ||
      // The parser catches up asynchronously; without this the first screen
      // stays raw until something else changes.
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.rebuild(update.state, update.view);
      return;
    }

    if (update.selectionSet) this.syncActive(update.state);
  }

  destroy(): void {
    this.destroyed = true;
    this.view.contentDOM.removeEventListener("compositionstart", this.onCompositionStart);
    this.view.contentDOM.removeEventListener("compositionend", this.onCompositionEnd);
    this.view.contentDOM.removeEventListener("mousemove", this.onMouseMove);
    this.view.contentDOM.removeEventListener("mouseleave", this.onMouseLeave);
    if (this.hoverFrame) {
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = 0;
    }
    // The picker lives on `document.body`, anchored to a chip that is about to be
    // removed with the view — including the whole editor being torn down on a
    // note switch. Without this it would outlive its anchor and dispatch into a
    // dead view.
    closeCodeLanguageMenu();
  }

  private computeActive(state: EditorState): VisibleRange | null {
    return this.revealActiveBlock ? activeRange(state) : null;
  }

  private rebuild(state: EditorState, view: EditorView): void {
    const active = this.computeActive(state);
    this.active = active;
    this.decorations = buildLivePreviewDecorations(
      state,
      view.visibleRanges,
      previewOptions(active, this.codeLanguage),
    );
    // The chip DOM is new, so the hover class has to be re-applied by hand —
    // `classList` does not survive `Decoration` rebuilding.
    this.scheduleHoverSync();
  }

  /**
   * The caret crossed a block boundary: patch the two blocks involved instead of
   * rebuilding the viewport. One synchronous `RangeSet.update` produces one
   * paint, so the switch cannot flicker between "all rendered" and "this block
   * raw".
   *
   * Moving the caret *inside* the same block returns immediately — that is the
   * common case (every arrow key, every click in the same paragraph).
   */
  private syncActive(state: EditorState): void {
    const next = this.computeActive(state);
    if (sameRange(this.active, next)) return;

    const affected = spanOf(this.active, next);
    this.active = next;
    if (affected) {
      this.decorations = this.decorations.update({
        filterFrom: affected.from,
        filterTo: affected.to,
        // Keep what lies outside the two blocks; everything inside is recomputed.
        filter: (from, to) => from < affected.from || to > affected.to,
        add: toDecorationRanges(
          collectLivePreviewRanges(state, [affected], previewOptions(next, this.codeLanguage)),
          previewOptions(next, this.codeLanguage),
        ),
        sort: true,
      });
    }
    // The two blocks above were just patched, so their chips are new DOM and the
    // hover class has to be re-applied. The early return above skips this, which
    // is correct: nothing was rebuilt in that path.
    this.scheduleHoverSync();
  }

  /**
   * Re-apply the hover class once the new decoration DOM exists.
   *
   * Not called inline, because a view plugin's `update` runs *before* CodeMirror
   * patches the document view — `querySelectorAll` still finds the previous chips
   * — and while `updateState === Updating`, where `posAtCoords` throws
   * ("Reading the editor layout isn't allowed during an update"). The measure
   * phase is the first moment where both are true: new chips are in the DOM and
   * geometry may be read.
   *
   * The cost is one frame without the class after a rebuild while hovering; the
   * alternative is a crash on every keystroke inside a code block.
   */
  private scheduleHoverSync(): void {
    if (this.destroyed) return;
    this.view.requestMeasure({
      read: () => {
        if (this.destroyed || !this.lastPointer) return null;
        return this.blockAtPoint(this.lastPointer);
      },
      write: (block: number | null) => {
        if (this.destroyed) return;
        this.hoveredBlock = block;
        this.syncChipVisibility();
      },
    });
  }

  /**
   * Recompute which block the pointer is over and move the `.is-visible` class.
   *
   * Event-driven only (a `mousemove` frame), where reading geometry is allowed.
   * `from` unchanged → nothing to do, which is every frame the pointer moves
   * inside the same block.
   */
  private applyHoverClass(): void {
    if (this.destroyed) return;
    const pointer = this.lastPointer;
    const next = pointer ? this.blockAtPoint(pointer) : null;
    if (next === this.hoveredBlock) return;
    this.hoveredBlock = next;
    this.syncChipVisibility();
  }

  /** `FencedCode` only — an indented block has no chip to hover. */
  private blockAtPoint(pointer: { x: number; y: number }): number | null {
    const pos = this.view.posAtCoords(pointer);
    // Off the text (in the gutter, past the last line): keep whatever is showing
    // rather than blinking the chip off between two lines.
    if (pos === null) return this.hoveredBlock;
    const info = codeFenceInfoAt(this.view.state, pos);
    if (!info) return null;
    // A revealed block has no chip: its fence line is on screen with the language
    // in it, so there is nothing to float over the card.
    if (this.active && info.from >= this.active.from && info.to <= this.active.to) return null;
    return info.from;
  }

  /**
   * One class toggle per chip. Cheap enough to run on every frame a rebuild
   * happens, and it self-heals: a chip that appeared from a patch, or a stale
   * class left on a recycled element, ends up correct either way.
   */
  private syncChipVisibility(): void {
    const chips = this.view.dom.querySelectorAll<HTMLElement>(".cm-md-code-lang");
    for (const chip of Array.from(chips)) {
      const blockFrom = Number(chip.dataset.blockFrom);
      chip.classList.toggle("is-visible", this.hoveredBlock !== null && blockFrom === this.hoveredBlock);
    }
  }

  /**
   * `requestAnimationFrame` throttling, not a debounce: one pass per frame at
   * most, and the pass reads layout (`posAtCoords`), so it has to be off the
   * event itself.
   */
  private readonly onMouseMove = (event: MouseEvent): void => {
    // Mid-composition the layer is frozen; touching the DOM under the candidate
    // window is how IME input gets dropped.
    if (this.composing) return;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      this.applyHoverClass();
    });
  };

  private readonly onMouseLeave = (): void => {
    this.lastPointer = null;
    if (this.hoverFrame) {
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = 0;
    }
    if (this.hoveredBlock === null) return;
    this.hoveredBlock = null;
    this.syncChipVisibility();
  };

  private readonly onCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    this.settlePending = true;
    // The commit transaction lands right after `compositionend` and rebuilds on
    // its own. If the composition produced no change, nothing arrives, so one
    // empty transaction (no effects, no document change) settles the layer.
    requestAnimationFrame(() => {
      if (this.destroyed || this.composing || !this.settlePending) return;
      this.settlePending = false;
      this.view.dispatch({});
    });
  };
}

export interface LivePreviewConfig {
  /**
   * Fall the block under the caret back to source. On by default — that is the
   * editable experience. Read-only views turn it off: there is no caret to fall
   * back for, and a selection at offset 0 would otherwise leave the first block
   * permanently shown as source.
   */
  revealActiveBlock?: boolean;
  /**
   * Mount the table drag handles. Off by default: only the main editor writes
   * column widths into `.md`, and a read-only preview or the sticky window (a
   * second writer on the same file) must not offer that gesture.
   */
  resizable?: boolean;
  /**
   * 纯预览编辑: nothing falls back to source under the caret and tables take the
   * pointer themselves so a cell can be edited in place. The caret fallback is
   * off by construction — a rendered block that reveals its own Markdown is
   * exactly what this mode promises not to do.
   */
  interactive?: boolean;
  /**
   * The language chip on code cards. `plainText` is the label of a block that has
   * no language yet, and the picker's clearing row — it is UI text, so the caller
   * passes it translated (`MarkdownSourceEditor` reads it off its `lang` prop;
   * nothing down here may reach for the settings store).
   *
   * Omitted → defaults to "menu" with the built-in 纯文本 label; read-only surfaces pass { mode: "static" } explicitly.
   */
  codeLanguage?: { mode: "menu" | "static"; plainText?: string };
}

/** Resolved form of `LivePreviewConfig.codeLanguage`. */
export interface CodeLanguageOptions {
  mode: "menu" | "static";
  plainText: string;
}

/**
 * Extension for the 实时渲染 view; absent in 源码 view.
 *
 * A factory rather than a constant because read-only instances need the same
 * decorations without the caret behaviour. Each call creates its own plugin type,
 * so call it once per editor and keep the result.
 */
export function livePreview(config: LivePreviewConfig = {}): Extension {
  const interactive = config.interactive === true;
  // 纯预览编辑 wins over the caret fallback: the two cannot both be on.
  const revealActiveBlock = interactive ? false : config.revealActiveBlock !== false;
  const resizable = config.resizable === true;
  const codeLanguage: CodeLanguageOptions = {
    mode: config.codeLanguage?.mode ?? "menu",
    plainText: config.codeLanguage?.plainText ?? DEFAULT_CODE_PLAIN_TEXT,
  };
  return [
    ViewPlugin.fromClass(
      class extends LivePreviewView {
        constructor(view: EditorView) {
          super(view, revealActiveBlock, codeLanguage);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    // Tables are block replacements, which a view plugin may not provide; the
    // field is separate for that reason, not for organisation.
    tablePreview({ revealActiveBlock, resizable, interactive }),
  ];
}

/**
 * Block(s) the selection touches. A collapsed caret yields its block; a range
 * yields the span covering both ends, so nothing inside the selection stays
 * hidden from the user who is about to replace it.
 */
function activeRange(state: EditorState): VisibleRange | null {
  const { from, to } = state.selection.main;
  const start = blockAtPosition(state, from);
  const end = from === to ? start : blockAtPosition(state, to);
  if (!start) return end;
  if (!end) return start;
  return { from: Math.min(start.from, end.from), to: Math.max(start.to, end.to) };
}

/**
 * Decoration options for one build. Always an object now, not `undefined`: the
 * chip configuration has to travel with the reveal range, and an absent
 * `reveal` still means "nothing is falling back to source".
 */
function previewOptions(
  range: VisibleRange | null,
  codeLanguage: CodeLanguageOptions,
): LivePreviewOptions {
  return { reveal: range ?? undefined, codeLanguage };
}

function sameRange(a: VisibleRange | null, b: VisibleRange | null): boolean {
  if (!a || !b) return a === b;
  return a.from === b.from && a.to === b.to;
}

/** Smallest range covering both, or `null` when neither exists. */
function spanOf(a: VisibleRange | null, b: VisibleRange | null): VisibleRange | null {
  if (!a) return b;
  if (!b) return a;
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
}
