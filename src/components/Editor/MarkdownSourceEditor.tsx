import { useEffect, useMemo, useRef } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder as codeMirrorPlaceholder } from "@codemirror/view";
import { redoDepth, undoDepth } from "@codemirror/commands";
import { deleteMarkupBackward, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { basicSetup } from "codemirror";
import {
  codeMirrorFontSizeTheme,
  literalTabIndentation,
  themeAwareMarkdownHighlighting,
} from "@/utils/codeMirror";
// Plugin marks are part of the editor's state, so they are an extension here
// rather than something a plugin reaches into the view to toggle. `pluginDecorations`
// is a no-op until a plugin calls `qing.editor.setDecorations`.
import { pluginDecorations } from "@/utils/editorHandle";
import { livePreview } from "@/utils/livePreview";
import { markdownInputRules } from "@/utils/livePreview/inputRules";

interface MarkdownSourceEditorProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  onScroll: (view: EditorView) => void;
  onViewChange: (view: EditorView | null) => void;
  /** Mod-Alt-t handler; the note editor owns what gets inserted. */
  onInsertTable?: () => void;
  fontSize: number;
  /**
   * Mount the live preview decoration layer. Off in 源码 view, where the point
   * is to see the file exactly as it is on disk.
   */
  livePreview?: boolean;
  /**
   * Receives an image file pasted or dropped onto the editor. The note editor
   * owns where attachments live, so the input rule only decides *that* this
   * paste/drop is an image and hands the file over.
   */
  onPasteImage?: (file: File) => void;
}

const externalDocumentUpdate = Annotation.define<boolean>();

/** Editable instance: the caret's block falls back to source. */
const livePreviewExtension = livePreview();

const noteEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "0",
    color: "var(--color-text-primary)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "16px 20px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg-secondary)",
    color: "var(--color-text-muted)",
    borderRight: "1px solid var(--color-border)",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 34%, transparent) !important",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--color-accent)",
    borderLeftWidth: "2px",
  },
  ".cm-placeholder": {
    color: "color-mix(in srgb, var(--color-text-muted) 40%, transparent)",
  },
  "&.cm-focused": { outline: "none" },
});

export default function MarkdownSourceEditor({
  value,
  placeholder,
  onChange,
  onHistoryChange,
  onScroll,
  onViewChange,
  onInsertTable,
  fontSize,
  livePreview = false,
  onPasteImage,
}: MarkdownSourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latestValueRef = useRef(value);
  const latestFontSizeRef = useRef(fontSize);
  const latestLivePreviewRef = useRef(livePreview);
  const latestPasteImageRef = useRef(onPasteImage);
  latestPasteImageRef.current = onPasteImage;
  // The editor is created once; route the shortcut through a ref so a new
  // callback identity never tears the whole CodeMirror instance down.
  const insertTableRef = useRef(onInsertTable);
  insertTableRef.current = onInsertTable;
  const fontSizeCompartment = useMemo(() => new Compartment(), []);
  // Switching view is a reconfigure, not a remount: the undo history and the
  // scroll position have to survive the 实时渲染 / 源码 toggle.
  const livePreviewCompartment = useMemo(() => new Compartment(), []);
  latestValueRef.current = value;
  latestFontSizeRef.current = fontSize;
  latestLivePreviewRef.current = livePreview;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: latestValueRef.current,
      extensions: [
        basicSetup,
        // GFM base, not the CommonMark default: `~~del~~` only becomes a
        // Strikethrough node (and tables a Table node) with GFM enabled, and
        // `utils/editorBlocks.ts` parses with the same base. Two different
        // bases would give one document two block boundaries.
        //
        // `addKeymap: false`: Enter is owned by `markdownInputRules` now, and the
        // language's own continuation would both duplicate rule 2/3 and make a
        // single rule impossible to switch off. Backspace keeps its markup
        // deletion explicitly (cross-block deletion is M5's).
        markdown({ base: markdownLanguage, addKeymap: false }),
        keymap.of([{ key: "Backspace", run: deleteMarkupBackward }]),
        themeAwareMarkdownHighlighting,
        noteEditorTheme,
        pluginDecorations,
        livePreviewCompartment.of(latestLivePreviewRef.current ? livePreviewExtension : []),
        markdownInputRules({ insertImage: (file) => latestPasteImageRef.current?.(file) }),
        fontSizeCompartment.of(codeMirrorFontSizeTheme(latestFontSizeRef.current)),
        EditorView.lineWrapping,
        literalTabIndentation,
        keymap.of([
          {
            key: "Mod-Alt-t",
            run: () => {
              if (!insertTableRef.current) return false;
              insertTableRef.current();
              return true;
            },
          },
        ]),
        EditorView.contentAttributes.of({ spellcheck: "false" }),
        codeMirrorPlaceholder(placeholder),
        EditorView.updateListener.of((update) => {
          const isExternalUpdate = update.transactions.some(
            (transaction) => transaction.annotation(externalDocumentUpdate),
          );
          if (update.docChanged && !isExternalUpdate) {
            onChange(update.state.doc.toString());
          }
          onHistoryChange(undoDepth(update.state) > 0, redoDepth(update.state) > 0);
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    const handleScroll = () => onScroll(view);
    view.scrollDOM.addEventListener("scroll", handleScroll);
    viewRef.current = view;
    onViewChange(view);
    onHistoryChange(false, false);

    return () => {
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      if (viewRef.current === view) {
        viewRef.current = null;
        onViewChange(null);
      }
      view.destroy();
    };
  }, [onChange, onHistoryChange, onScroll, onViewChange, placeholder]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    const cursor = Math.min(view.state.selection.main.head, value.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: cursor },
      annotations: [externalDocumentUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: fontSizeCompartment.reconfigure(codeMirrorFontSizeTheme(fontSize)),
    });
  }, [fontSize, fontSizeCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: livePreviewCompartment.reconfigure(livePreview ? livePreviewExtension : []),
    });
  }, [livePreview, livePreviewCompartment]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />;
}
