/**
 * Image attachment insertion, shared by the in-app editor and the detached
 * note window.
 *
 * A note stores only the generated file name (`attachment://<name>`), never an
 * absolute path, so moving the data directory cannot break a document. Both the
 * "insert image" menu command and a pasted/dropped file funnel through here;
 * a second copy of the `attachment://` literal is exactly the kind of thing
 * that drifts when one surface learns a new scheme.
 */
import type { EditorView } from "@codemirror/view";

/** Extension for an image selected in the dialog or pasted from the clipboard. */
export function imageExtensionOf(nameOrMime: string): string {
  if (nameOrMime.includes("/")) return nameOrMime.split("/")[1] || "png";
  const extension = nameOrMime.split(".").pop();
  return extension && extension.length <= 5 ? extension : "png";
}

/**
 * Put an attachment reference where the caret is and leave the caret on the
 * line after it, so the next keystroke starts a new paragraph instead of
 * continuing the image line.
 */
export function insertImageMarkdown(view: EditorView, filename: string): void {
  const snippet = `![](attachment://${filename})`;
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc.toString();
  // An image has to start on its own line, otherwise the paragraph above
  // swallows it and nothing renders as an image.
  const prefix = from > 0 && doc[from - 1] !== "\n" ? "\n" : "";
  view.dispatch({
    changes: { from, to, insert: `${prefix}${snippet}\n` },
    selection: { anchor: from + prefix.length + snippet.length + 1 },
    scrollIntoView: true,
  });
  view.focus();
}
