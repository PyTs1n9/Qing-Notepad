import { isolateHistory } from "@codemirror/commands";
import { WidgetType, type EditorView } from "@codemirror/view";
import { taskToggleAt } from "./inputRules";

/**
 * The two widgets the list markers are replaced with.
 *
 * They exist because a `Decoration.replace` removes the source characters from
 * the DOM: showing `-` or `1.` verbatim is what the editor used to do (a dimmed
 * fixed-width column), and hiding them without putting something back would
 * leave the line without any marker at all. The replacement is ordinary DOM, so
 * the glyph can be a real bullet and the number can be the *rendered* ordinal
 * instead of the digits the author typed.
 *
 * Both are inline widgets: CodeMirror only lets state fields provide *block*
 * replacements (see `tableField.ts`), but an inline replacement is fine from the
 * view plugin that owns the rest of the decoration layer.
 */

/** `•` / `◦` / `▪`, or an ordinal like `3.` — a fixed-width marker cell. */
export class ListMarkerWidget extends WidgetType {
  constructor(
    readonly text: string,
    /** `cm-md-bullet` or `cm-md-ordered`. */
    readonly className: string,
  ) {
    super();
  }

  eq(other: ListMarkerWidget): boolean {
    return other.text === this.text && other.className === this.className;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = `cm-md-list-widget ${this.className}`;
    marker.textContent = this.text;
    // The glyph is decoration, not content: a screen reader should read the item
    // text, and copying a selection must yield the Markdown source.
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  /** Clicks belong to the editor (caret placement), not to the marker. */
  ignoreEvent(): boolean {
    return false;
  }
}

/** `[ ]` / `[x]` → a checkbox that toggles the source on click. */
export class TaskCheckboxWidget extends WidgetType {
  constructor(
    /** Offset of the `[`, captured when the decoration was built. */
    readonly from: number,
    readonly checked: boolean,
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.from === this.from && other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("span");
    box.className = "cm-md-task-checkbox";
    box.dataset.checked = this.checked ? "true" : "false";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));

    box.addEventListener("mousedown", (event) => {
      // Same contract as the source-level checkbox (`markdownInputRules` rule
      // 11): do not move the caret, do not let the editor also handle the press,
      // and make the flip one undo step.
      event.preventDefault();
      event.stopPropagation();
      // `this.from` may be stale if the document changed without a rebuild
      // (composition, or a mapped decoration); `taskToggleAt` re-reads the tree
      // and returns null when the bracket is no longer there, so a stale widget
      // is a no-op rather than an edit somewhere else.
      const spec = taskToggleAt(view.state, this.from);
      if (!spec) return;
      view.dispatch({ ...spec, annotations: [isolateHistory.of("full")] });
    });

    return box;
  }

  /** The checkbox owns its press; the editor must not also place a caret. */
  ignoreEvent(): boolean {
    return true;
  }
}
