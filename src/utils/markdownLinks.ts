import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

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
