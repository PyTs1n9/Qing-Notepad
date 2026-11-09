import { useEffect, useMemo, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  Transaction,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap, placeholder as codeMirrorPlaceholder } from "@codemirror/view";
import { redoDepth, undoDepth } from "@codemirror/commands";
import { deleteMarkupBackward, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { basicSetup } from "codemirror";
import {
  codeMirrorTypographyTheme,
  literalTabIndentation,
  themeAwareMarkdownHighlighting,
} from "@/utils/codeMirror";
// Plugin marks are part of the editor's state, so they are an extension here
// rather than something a plugin reaches into the view to toggle. `pluginDecorations`
// is a no-op until a plugin calls `qing.editor.setDecorations`.
import { pluginDecorations } from "@/utils/editorHandle";
import { livePreview } from "@/utils/livePreview";
import { flushTableEdit } from "@/utils/livePreview/tableEditing";
import { codeBlockInteractions } from "@/utils/livePreview/codeBlock";
import { markdownInputRules } from "@/utils/livePreview/inputRules";
import { isLinkClickModifier, openMarkdownLink } from "@/utils/markdownLinkActions";
import { linkUrlAt } from "@/utils/markdownLinks";
import {
  inlineWrap,
  insertCodeBlock,
  insertLink,
  insertParagraph,
  setHeading,
  toggleList,
  toggleQuote,
} from "@/utils/markdownCommands";

interface MarkdownSourceEditorProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
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
   * 纯预览编辑 mode: the live preview layer stays mounted with nothing falling
   * back to source under the caret, and rendered tables accept in-place cell
   * edits. Only meaningful together with `livePreview`.
   */
  previewEditing?: boolean;
  /**
   * Receives an image file pasted or dropped onto the editor. The note editor
   * owns where attachments live, so the input rule only decides *that* this
   * paste/drop is an image and hands the file over.
   */
  onPasteImage?: (file: File) => void;
  /**
   * Body typeface family name from settings (`""` = system stack). Code is not
   * affected: fenced blocks and inline code pin `--font-mono` in CSS.
   */
  fontFamily?: string;
}

const externalDocumentUpdate = Annotation.define<boolean>();

/**
 * Editable instance: the caret's block falls back to source, and tables get drag
 * handles — this is the only surface that may write column widths into the note.
 */
const livePreviewExtension = livePreview({ resizable: true });

/**
 * 纯预览编辑 (the status bar's third button).
 *
 * Same surface as above, with two deliberate differences: nothing is revealed
 * under the caret (the whole point is that `**` and `#` never appear), and the
 * tables are `interactive`, i.e. they keep the pointer and edit a cell in place.
 * Drag handles stay on — the column-edge gesture is frozen behaviour and this
 * mode is still the same editor writing the same file.
 */
const previewEditingExtension = livePreview({
  revealActiveBlock: false,
  resizable: true,
  interactive: true,
});

/** Which preview layer this pair of props asks for. */
function previewLayer(live: boolean, editing: boolean): Extension {
  if (!live) return [];
  return editing ? previewEditingExtension : livePreviewExtension;
}

/** One command, one transaction; `false` lets the next binding try. */
function runMarkdownCommand(
  view: EditorView,
  build: (state: EditorState) => TransactionSpec | null,
): boolean {
  const spec = build(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

/**
 * Structural Markdown shortcuts.
 *
 * `Prec.high` because `basicSetup` already binds several of these keys
 * (`Mod-/`, `Mod-Enter`) and the editor's menu advertises the accelerators shown
 * here — a displayed shortcut that loses to a default would be a lie.
 *
 * Ctrl+/ and the zoom keys are *not* here: they must work while a menu item owns
 * the focus, so `NoteEditor` owns them at window level.
 */
const markdownCommandKeymap = Prec.high(
  keymap.of([
    ...[0, 1, 2, 3, 4, 5, 6].map((level) => ({
      key: `Mod-${level}`,
      run: (view: EditorView) => runMarkdownCommand(view, (state) => setHeading(state, level)),
    })),
    { key: "Mod-Shift-q", run: (view: EditorView) => runMarkdownCommand(view, toggleQuote) },
    {
      key: "Mod-Shift-[",
      run: (view: EditorView) => runMarkdownCommand(view, (state) => toggleList(state, "bullet")),
    },
    {
      key: "Mod-Shift-]",
      run: (view: EditorView) => runMarkdownCommand(view, (state) => toggleList(state, "ordered")),
    },
    {
      key: "Mod-Shift-x",
      run: (view: EditorView) => runMarkdownCommand(view, (state) => toggleList(state, "task")),
    },
    { key: "Mod-Shift-k", run: (view: EditorView) => runMarkdownCommand(view, insertCodeBlock) },
    { key: "Mod-k", run: (view: EditorView) => runMarkdownCommand(view, insertLink) },
    {
      key: "Mod-Shift-`",
      run: (view: EditorView) => runMarkdownCommand(view, (state) => inlineWrap(state, "`")),
    },
    {
      key: "Alt-Shift-5",
      run: (view: EditorView) => runMarkdownCommand(view, (state) => inlineWrap(state, "~~")),
    },
    {
      key: "Mod-Enter",
      run: (view: EditorView) => runMarkdownCommand(view, (state) => insertParagraph(state, "below")),
    },
    {
      key: "Mod-Shift-Enter",
      run: (view: EditorView) => runMarkdownCommand(view, (state) => insertParagraph(state, "above")),
    },
  ]),
);

const noteEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "0",
    color: "var(--color-text-primary)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
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
    // The gutter must not track the body size 1:1: at 16px body the numbers are
    // as tall as the prose, which reads as a slab and costs ~36px of a card that
    // is already narrow. 0.78em keeps them legible (12.5px at the default body)
    // and scales with the user's font-size setting because it is relative.
    // Width is content-driven (CodeMirror measures a hidden spacer holding the
    // digits of the last line), so shrinking the type is the only lever that
    // does not clip a four-digit document.
    fontSize: "0.78em",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 2px 0 4px",
    minWidth: "18px",
    // Line-height must stay at the *body* line height (1.7 × body), not
    // 1.7 × 0.78em: CodeMirror gives every gutter row the line's full height,
    // and a shorter internal line box leaves the digits stranded at the top of
    // it. 1.7 / 0.78 — keep in sync with `.cm-scroller` lineHeight and the
    // `.cm-gutters` font-size above.
    lineHeight: "2.18",
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
  onViewChange,
  onInsertTable,
  fontSize,
  livePreview = false,
  previewEditing = false,
  onPasteImage,
  fontFamily = "",
}: MarkdownSourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latestValueRef = useRef(value);
  const latestFontSizeRef = useRef(fontSize);
  const latestFontFamilyRef = useRef(fontFamily);
  const latestLivePreviewRef = useRef(livePreview);
  const latestPreviewEditingRef = useRef(previewEditing);
  /** The value the reconfigure effect saw last time, so a leave can be spotted. */
  const previousPreviewEditingRef = useRef(previewEditing);
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
  latestFontFamilyRef.current = fontFamily;
  latestLivePreviewRef.current = livePreview;
  latestPreviewEditingRef.current = previewEditing;

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
        markdownCommandKeymap,
        themeAwareMarkdownHighlighting,
        noteEditorTheme,
        pluginDecorations,
        livePreviewCompartment.of(previewLayer(latestLivePreviewRef.current, latestPreviewEditingRef.current)),
        markdownInputRules({ insertImage: (file) => latestPasteImageRef.current?.(file) }),
        // Not part of the preview layer: Ctrl+A scoping and "paste code as a
        // block" have to work in 源码 view too, where `livePreview` is unmounted.
        codeBlockInteractions(),
        fontSizeCompartment.of(
          codeMirrorTypographyTheme(latestFontSizeRef.current, latestFontFamilyRef.current),
        ),
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
        /**
         * Ctrl/Cmd+click follows a link; a plain click still places the caret,
         * which is the only way to edit link text once the live preview has
         * hidden the `[label](url)` markup. `linkUrlAt` resolves the
         * destination from the syntax tree because no `<a>` element exists on
         * this surface.
         */
        EditorView.domEventHandlers({
          mousedown(event, view) {
            // `mousedown`, not `click`: the caret has not moved yet, so refusing
            // the click lets CodeMirror do its own placement rather than undoing
            // it afterwards. Only the primary button navigates — Ctrl+middle
            // click is a scroll gesture.
            if (event.button !== 0 || !isLinkClickModifier(event)) return false;
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position === null) return false;
            const url = linkUrlAt(view.state, position);
            if (!url) return false;
            // A destination this app cannot carry out (a dead anchor, a note that
            // no longer exists) must leave the click alone, so the caret lands
            // where the user clicked instead of nothing at all happening.
            const executed = openMarkdownLink(url, { view });
            if (!executed) return false;
            event.preventDefault();
            return true;
          },
        }),
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
    viewRef.current = view;
    onViewChange(view);
    onHistoryChange(false, false);

    return () => {
      if (viewRef.current === view) {
        viewRef.current = null;
        onViewChange(null);
      }
      view.destroy();
    };
  }, [onChange, onHistoryChange, onViewChange, placeholder]);

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
      effects: fontSizeCompartment.reconfigure(codeMirrorTypographyTheme(fontSize, fontFamily)),
    });
  }, [fontSize, fontFamily, fontSizeCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const wasEditing = previousPreviewEditingRef.current;
    previousPreviewEditingRef.current = previewEditing;
    // Leaving the interactive layer while a cell is open must not drop what the
    // user typed: the widget is about to be replaced by the ordinary one, and
    // its DOM — including the open cell — goes with it.
    if (wasEditing && !previewEditing) flushTableEdit(view);
    view.dispatch({
      effects: livePreviewCompartment.reconfigure(previewLayer(livePreview, previewEditing)),
    });
  }, [livePreview, previewEditing, livePreviewCompartment]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />;
}
