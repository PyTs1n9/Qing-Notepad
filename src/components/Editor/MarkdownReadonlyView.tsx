import { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeMirrorFontSizeTheme, themeAwareMarkdownHighlighting } from "@/utils/codeMirror";
import { livePreview } from "@/utils/livePreview";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import { linkUrlAt } from "@/utils/markdownLinks";

/**
 * Read-only Markdown rendering on a CodeMirror view, so note previews (the tile
 * window, and anything else that only has to *show* a note) go through the same
 * decoration layer as the editor instead of a second Markdown → HTML pipeline.
 *
 * Two deliberate differences from `MarkdownSourceEditor`:
 * - **no input rules**: nothing here can be typed into, so `markdownInputRules`
 *   is not installed at all — no keymap entries and no paste/drop handlers;
 * - **no caret fallback**: `livePreview({ revealActiveBlock: false })`. A
 *   read-only view still has a (collapsed) selection at offset 0; with the
 *   editable behaviour the first block would sit permanently in source form.
 *
 * Everything else — GFM base, the syntax highlight style, `em`-based heading
 * sizes scaling off the zoomed root size — is the editor's own configuration, so
 * the two surfaces cannot drift apart.
 */
const READONLY_PREVIEW = livePreview({ revealActiveBlock: false });

const readonlyTheme = EditorView.theme({
  // Auto height: the window owns scrolling, not the editor. A fixed-height
  // scroller inside a scroller is what makes small preview windows feel broken.
  "&": {
    height: "auto",
    color: "var(--color-text-primary)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    overflow: "visible",
    // Same stack as the editor so a preview and the editor agree on metrics.
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    lineHeight: "1.7",
  },
  ".cm-content": { padding: "0", caretColor: "transparent" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 30%, transparent) !important",
  },
});

interface MarkdownReadonlyViewProps {
  /** Markdown source, exactly as stored in the note file. */
  value: string;
  /** Root font size in px; heading sizes are `em`, so they scale with it. */
  fontSize?: number;
  className?: string;
}

export default function MarkdownReadonlyView({ value, fontSize = 14, className }: MarkdownReadonlyViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latestValueRef = useRef(value);
  const latestFontSizeRef = useRef(fontSize);
  const fontSizeCompartment = useMemo(() => new Compartment(), []);
  latestValueRef.current = value;
  latestFontSizeRef.current = fontSize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: latestValueRef.current,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          markdown({ base: markdownLanguage, addKeymap: false }),
          themeAwareMarkdownHighlighting,
          readonlyTheme,
          fontSizeCompartment.of(codeMirrorFontSizeTheme(latestFontSizeRef.current)),
          EditorView.lineWrapping,
          READONLY_PREVIEW,
          EditorView.domEventHandlers({
            click(event, view) {
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null) return false;
              const url = linkUrlAt(view.state, pos);
              if (!url) return false;
              // Same gate as the old tile: only http(s), opened in the browser.
              void openInDefaultBrowser(url);
              return true;
            },
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [fontSizeCompartment]);

  // The tile reloads a note; the editor must follow without a remount.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: fontSizeCompartment.reconfigure(codeMirrorFontSizeTheme(fontSize)),
    });
  }, [fontSize, fontSizeCompartment]);

  return <div ref={hostRef} className={className} />;
}
