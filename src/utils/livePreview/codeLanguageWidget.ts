import { WidgetType, type EditorView } from "@codemirror/view";
import { CODE_LANGUAGES } from "../highlight";
import { codeFenceInfoAt } from "./codeBlock";
import { openCodeLanguageMenu } from "./codeLanguageMenu";

/**
 * The language chip at the bottom-right of a code card — Typora's affordance:
 * the fence's language, floating over the card while the pointer is near it.
 *
 * A widget, not a styled run of text: the chip sits at the *end of the last
 * visible line*, which is not where the info string is. It therefore has to be a
 * zero-width insertion point (see the `codeLang` spec in `decorations.ts`) and
 * carry its own DOM.
 */
export class CodeLanguageWidget extends WidgetType {
  constructor(
    /** What the chip shows: the fence's word, or the "plain text" label. */
    readonly label: string,
    /** `menu` opens the picker; `static` is a read-only窗 label that cannot. */
    readonly mode: "menu" | "static",
    /** `FencedCode.from`, so the picker can find the block again. */
    readonly blockFrom: number,
    /** Label of the picker's clearing row; carries the UI language. */
    readonly plainText: string,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "cm-md-code-lang";
    chip.dataset.blockFrom = String(this.blockFrom);
    chip.dataset.mode = this.mode;
    // `title`, not a tooltip library: the label is the whole information and the
    // browser already shows it on hover with the right placement.
    chip.title = this.label;

    const label = document.createElement("span");
    label.className = "cm-md-code-lang-label";
    label.textContent = this.label;
    chip.appendChild(label);

    // `static` gets no listener at all, not a disabled one. A read-only view is
    // only *usually* read-only: `EditorState.readOnly` blocks the input handlers,
    // it does not block `view.dispatch`, so a listener that only "checked" would
    // be one refactor away from writing into a preview window's note.
    if (this.mode === "static") return chip;

    chip.addEventListener("mousedown", (event) => {
      // A plain `mousedown` inside the editor moves the caret and would reveal
      // the block (dropping this very widget mid-gesture); `stopPropagation`
      // keeps the click from reaching CodeMirror's own handler.
      event.preventDefault();
      event.stopPropagation();
      // The current language is read from the live document rather than baked
      // into the widget: a decoration can be reused across an edit, and a stale
      // "current" would highlight the wrong row in a menu that is about to write
      // the fence.
      const info = codeFenceInfoAt(view.state, this.blockFrom);
      const current = info ? view.state.sliceDoc(info.wordFrom, info.wordTo) : "";
      openCodeLanguageMenu({
        anchor: chip,
        view,
        blockFrom: this.blockFrom,
        current,
        languages: CODE_LANGUAGES,
        plainText: this.plainText,
        // Nothing to do here: the rewrite is dispatched by the menu, and the
        // resulting transaction rebuilds this chip with the new label.
        onPick: () => {},
      });
    });

    return chip;
  }

  /**
   * Only what the DOM shows. `plainText` is deliberately excluded: it changes
   * when the UI language changes, which reconfigures the whole preview extension
   * — the decoration set is rebuilt anyway, so comparing it here would only
   * force needless DOM churn.
   */
  eq(other: CodeLanguageWidget): boolean {
    return this.label === other.label && this.mode === other.mode && this.blockFrom === other.blockFrom;
  }

  /** The chip handles its own pointer events; see `toDOM`. */
  ignoreEvent(): boolean {
    return true;
  }
}
