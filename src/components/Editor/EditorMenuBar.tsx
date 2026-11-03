import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { EditorView } from "@codemirror/view";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import { moveLineDown, moveLineUp, redo, selectAll, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import DropdownMenu, { type DropdownEntry } from "@/components/Layout/DropdownMenu";
import type { LangType } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import {
  inlineWrap,
  insertCodeBlock,
  insertHorizontalRule,
  insertLink,
  insertParagraph,
  setHeading,
  toggleList,
  toggleQuote,
  type ListKind,
} from "@/utils/markdownCommands";

export type EditorViewMode = "live" | "source";

interface EditorMenuBarProps {
  lang: LangType;
  /**
   * Menu actions run through a getter, not a prop: the CodeMirror view is a ref,
   * so a prop would be stale for the whole life of the component. `null` means
   * "no note open", which is what disables the document actions.
   */
  getView: () => EditorView | null;
  /**
   * Whether a note is open. Deliberately *not* derived from `getView()`: that ref
   * is null on the first render (the editor mounts in an effect), so a menu built
   * from it would paint every document action disabled and only fix itself on the
   * next unrelated re-render.
   */
  hasEditor: boolean;
  canUndo: boolean;
  canRedo: boolean;
  isDirty: boolean;
  isSaving: boolean;
  viewMode: EditorViewMode;
  onViewModeChange: (mode: EditorViewMode) => void;
  onSave: () => void;
  onExport?: () => void;
  onCloseTab: () => void;
  /** Overrides the file menu's close entry. The detached window has no tab strip. */
  closeEntryLabel?: string;
  /** Opens the note in its own window; omitted where there is no main editor. */
  onOpenInWindow?: () => void;
  onInsertTable: () => void;
  onInsertImage: () => void;
  /**
   * AI polish needs the main app's assistant sidebar. Omitted in the detached
   * note window, where the entry is shown disabled instead of vanishing —
   * a menu that silently loses an item is harder to trust than a greyed one.
   */
  onAiPolish?: () => void;
  onZoom: (action: "in" | "out" | "reset") => void;
  /**
   * Menu opened on mount. Only the local render bench uses it: a screenshot
   * cannot click, and opening a panel by timer races the first paint.
   */
  initialOpenMenu?: "file" | "edit" | "paragraph" | "format" | "view";
}

/** Menu ids, in bar order. Arrow navigation walks this list. */
const MENU_IDS = ["file", "edit", "paragraph", "format", "view"] as const;
type MenuId = (typeof MENU_IDS)[number];

/**
 * Panel cap. 500px is what the longest menu (段落, 15 items + 3 separators)
 * needs to show in one go; anything taller scrolls, which is the fallback for a
 * short window rather than the normal case. The panel flips above the trigger
 * when the viewport cannot hold it below.
 */
const PANEL_MAX_HEIGHT = 500;

const ACCEL = {
  save: "Ctrl+S",
  closeTab: "Ctrl+W",
  undo: "Ctrl+Z",
  redo: "Ctrl+Y",
  selectAll: "Ctrl+A",
  find: "Ctrl+F",
  moveUp: "Alt+↑",
  moveDown: "Alt+↓",
  paragraph: "Ctrl+0",
  quote: "Ctrl+Shift+Q",
  bullet: "Ctrl+Shift+[",
  ordered: "Ctrl+Shift+]",
  task: "Ctrl+Shift+X",
  codeBlock: "Ctrl+Shift+K",
  table: "Ctrl+Alt+T",
  paragraphAbove: "Ctrl+Shift+Enter",
  paragraphBelow: "Ctrl+Enter",
  bold: "Ctrl+B",
  italic: "Ctrl+I",
  strikethrough: "Alt+Shift+5",
  inlineCode: "Ctrl+Shift+`",
  link: "Ctrl+K",
  viewToggle: "Ctrl+/",
  zoomIn: "Ctrl+=",
  zoomOut: "Ctrl+-",
  zoomReset: "Ctrl+Shift+0",
} as const;

/**
 * The editor's menu bar: 文件 / 编辑 / 段落 / 格式 / 视图.
 *
 * It replaces the icon toolbar on purpose (docs/decisions-editor-menubar.md):
 * the row of nine icons had no room left for the structural Markdown commands,
 * and a menu is the only container that stays honest as that list grows. The
 * three state-bearing controls (save / pin / export) stay outside, because a
 * menu cannot show "unsaved" at a glance.
 */
export default function EditorMenuBar({
  lang,
  getView,
  hasEditor,
  canUndo,
  canRedo,
  isDirty,
  isSaving,
  viewMode,
  onViewModeChange,
  onSave,
  onExport,
  onCloseTab,
  closeEntryLabel,
  onOpenInWindow,
  onInsertTable,
  onInsertImage,
  onAiPolish,
  onZoom,
  initialOpenMenu,
}: EditorMenuBarProps) {
  const [openMenu, setOpenMenu] = useState<MenuId | null>(initialOpenMenu ?? null);
  const barRef = useRef<HTMLDivElement>(null);

  const runCommand = (build: (state: EditorState) => TransactionSpec | null) => {
    const view = getView();
    if (!view) return;
    const spec = build(view.state);
    if (!spec) return;
    view.dispatch(spec);
    view.focus();
  };

  const runViewCommand = (command: (view: EditorView) => boolean) => {
    const view = getView();
    if (!view) return;
    command(view);
    view.focus();
  };

  const noEditor = t(lang, "disabledNoEditor");
  const noAi = t(lang, "disabledNoAi");

  const openInWindowEntry: DropdownEntry[] = onOpenInWindow
    ? [
        {
          id: "open-in-window",
          label: t(lang, "openInNewWindow"),
          disabled: !hasEditor,
          disabledReason: noEditor,
          onSelect: onOpenInWindow,
        },
      ]
    : [];

  const fileEntries: DropdownEntry[] = [
    {
      id: "save",
      label: t(lang, "save"),
      shortcut: ACCEL.save,
      disabled: !isDirty || isSaving,
      disabledReason: isSaving ? t(lang, "savingInProgress") : t(lang, "disabledNoChanges"),
      onSelect: onSave,
    },
    {
      id: "export",
      label: t(lang, "exportFile"),
      disabled: !onExport,
      disabledReason: t(lang, "disabledNoExport"),
      onSelect: () => onExport?.(),
    },
    ...openInWindowEntry,
    { separator: true },
    {
      id: "close-tab",
      // The detached window has no tab strip, so it passes its own wording;
      // the command (close this document) is the same one under the same key.
      label: closeEntryLabel ?? t(lang, "closeTabNote"),
      shortcut: ACCEL.closeTab,
      onSelect: onCloseTab,
    },
  ];

  const editEntries: DropdownEntry[] = [
    {
      id: "undo",
      label: t(lang, "undo"),
      shortcut: ACCEL.undo,
      disabled: !canUndo,
      disabledReason: t(lang, "disabledNoUndo"),
      onSelect: () => runViewCommand(undo),
    },
    {
      id: "redo",
      label: t(lang, "redo"),
      shortcut: ACCEL.redo,
      disabled: !canRedo,
      disabledReason: t(lang, "disabledNoRedo"),
      onSelect: () => runViewCommand(redo),
    },
    { separator: true },
    {
      id: "select-all",
      label: t(lang, "selectAll"),
      shortcut: ACCEL.selectAll,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runViewCommand(selectAll),
    },
    {
      id: "find",
      label: t(lang, "findReplace"),
      shortcut: ACCEL.find,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runViewCommand(openSearchPanel),
    },
    { separator: true },
    {
      id: "move-line-up",
      label: t(lang, "moveLineUp"),
      shortcut: ACCEL.moveUp,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runViewCommand(moveLineUp),
    },
    {
      id: "move-line-down",
      label: t(lang, "moveLineDown"),
      shortcut: ACCEL.moveDown,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runViewCommand(moveLineDown),
    },
  ];

  const headingEntry = (level: number): DropdownEntry => ({
    id: `heading-${level}`,
    label:
      level === 0
        ? t(lang, "headingParagraph")
        : tWithParams(lang, "headingLevel", { level: String(level) }),
    shortcut: level === 0 ? ACCEL.paragraph : `Ctrl+${level}`,
    disabled: !hasEditor,
    disabledReason: noEditor,
    onSelect: () => runCommand((state) => setHeading(state, level)),
  });

  const listEntry = (kind: ListKind, labelKey: "bulletList" | "orderedList" | "taskList", shortcut: string): DropdownEntry => ({
    id: `list-${kind}`,
    label: t(lang, labelKey),
    shortcut,
    disabled: !hasEditor,
    disabledReason: noEditor,
    onSelect: () => runCommand((state) => toggleList(state, kind)),
  });

  const paragraphEntries: DropdownEntry[] = [
    headingEntry(0),
    headingEntry(1),
    headingEntry(2),
    headingEntry(3),
    headingEntry(4),
    headingEntry(5),
    headingEntry(6),
    { separator: true },
    {
      id: "quote",
      label: t(lang, "blockquote"),
      shortcut: ACCEL.quote,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand(toggleQuote),
    },
    listEntry("bullet", "bulletList", ACCEL.bullet),
    listEntry("ordered", "orderedList", ACCEL.ordered),
    listEntry("task", "taskList", ACCEL.task),
    { separator: true },
    {
      id: "code-block",
      label: t(lang, "codeBlock"),
      shortcut: ACCEL.codeBlock,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand(insertCodeBlock),
    },
    {
      id: "table",
      label: t(lang, "tableBlock"),
      shortcut: ACCEL.table,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: onInsertTable,
    },
    {
      id: "horizontal-rule",
      label: t(lang, "horizontalRule"),
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand(insertHorizontalRule),
    },
    { separator: true },
    {
      id: "paragraph-above",
      label: t(lang, "insertParagraphAbove"),
      shortcut: ACCEL.paragraphAbove,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand((state) => insertParagraph(state, "above")),
    },
    {
      id: "paragraph-below",
      label: t(lang, "insertParagraphBelow"),
      shortcut: ACCEL.paragraphBelow,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand((state) => insertParagraph(state, "below")),
    },
  ];

  const formatEntries: DropdownEntry[] = [
    {
      id: "bold",
      label: t(lang, "bold"),
      shortcut: ACCEL.bold,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand((state) => inlineWrap(state, "**")),
    },
    {
      id: "italic",
      label: t(lang, "italic"),
      shortcut: ACCEL.italic,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand((state) => inlineWrap(state, "*")),
    },
    {
      id: "strikethrough",
      label: t(lang, "strikethrough"),
      shortcut: ACCEL.strikethrough,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand((state) => inlineWrap(state, "~~")),
    },
    {
      id: "inline-code",
      label: t(lang, "inlineCode"),
      shortcut: ACCEL.inlineCode,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand((state) => inlineWrap(state, "`")),
    },
    { separator: true },
    {
      id: "link",
      label: t(lang, "link"),
      shortcut: ACCEL.link,
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: () => runCommand(insertLink),
    },
    {
      id: "image",
      label: t(lang, "insertImage"),
      disabled: !hasEditor,
      disabledReason: noEditor,
      onSelect: onInsertImage,
    },
    { separator: true },
    {
      id: "ai-polish",
      label: t(lang, "aiPolishEntry"),
      hint: t(lang, "aiPolishMenuHint"),
      disabled: !hasEditor || !onAiPolish,
      disabledReason: onAiPolish ? noEditor : noAi,
      onSelect: () => onAiPolish?.(),
    },
  ];

  const viewEntries: DropdownEntry[] = [
    {
      id: "view-live",
      label: t(lang, "mdViewLive"),
      shortcut: ACCEL.viewToggle,
      checked: viewMode === "live",
      onSelect: () => onViewModeChange("live"),
    },
    {
      id: "view-source",
      label: t(lang, "mdViewSource"),
      shortcut: ACCEL.viewToggle,
      checked: viewMode === "source",
      onSelect: () => onViewModeChange("source"),
    },
    { separator: true },
    {
      id: "zoom-in",
      label: t(lang, "zoomIn"),
      shortcut: ACCEL.zoomIn,
      onSelect: () => onZoom("in"),
    },
    {
      id: "zoom-out",
      label: t(lang, "zoomOut"),
      shortcut: ACCEL.zoomOut,
      onSelect: () => onZoom("out"),
    },
    {
      id: "zoom-reset",
      label: t(lang, "zoomReset"),
      shortcut: ACCEL.zoomReset,
      onSelect: () => onZoom("reset"),
    },
  ];

  /**
   * Give the caret back to the document after an action.
   *
   * Closing a menu unmounts the focused item, which drops focus to `<body>`; the
   * next keystroke would then go nowhere. Actions that answer by opening a native
   * dialog are unaffected — the dialog takes focus first and the editor gets it
   * back when the dialog closes.
   */
  const withEditorFocus = (entries: DropdownEntry[]): DropdownEntry[] =>
    entries.map((entry) => {
      if ("separator" in entry) return entry;
      return {
        ...entry,
        onSelect: () => {
          entry.onSelect();
          requestAnimationFrame(() => getView()?.focus());
        },
      };
    });

  /** Left / right on the bar itself, matching the in-panel arrow keys. */
  const handleBarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const triggers = Array.from(
      barRef.current?.querySelectorAll<HTMLButtonElement>('[aria-haspopup="menu"]') ?? [],
    );
    const index = triggers.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + step + triggers.length) % triggers.length;
    triggers[next].focus();
    // Only follow with the panel when a panel is already open: arrowing across a
    // closed menu bar must not pop menus open.
    if (openMenu !== null) setOpenMenu(MENU_IDS[next]);
  };

  const menus: Record<MenuId, { label: string; entries: DropdownEntry[] }> = {
    file: { label: t(lang, "menuFile"), entries: withEditorFocus(fileEntries) },
    edit: { label: t(lang, "menuEdit"), entries: withEditorFocus(editEntries) },
    paragraph: { label: t(lang, "menuParagraph"), entries: withEditorFocus(paragraphEntries) },
    format: { label: t(lang, "menuFormat"), entries: withEditorFocus(formatEntries) },
    view: { label: t(lang, "menuView"), entries: withEditorFocus(viewEntries) },
  };

  const navigate = (from: MenuId, direction: -1 | 1) => {
    const index = MENU_IDS.indexOf(from);
    const next = MENU_IDS[(index + direction + MENU_IDS.length) % MENU_IDS.length];
    setOpenMenu(next);
  };

  return (
    <div
      ref={barRef}
      className="flex items-center gap-0.5"
      role="menubar"
      aria-label={t(lang, "menuBarLabel")}
      onKeyDown={handleBarKeyDown}
    >
      {MENU_IDS.map((id) => (
        <DropdownMenu
          key={id}
          label={menus[id].label}
          triggerLabel={menus[id].label}
          entries={menus[id].entries}
          align="start"
          maxHeight={PANEL_MAX_HEIGHT}
          open={openMenu === id}
          onOpenChange={(open) => setOpenMenu(open ? id : null)}
          onTriggerHover={() => {
            // A menu bar follows the pointer once one panel is open; that is the
            // native behaviour and the old title-bar menus failed exactly here.
            if (openMenu !== null && openMenu !== id) setOpenMenu(id);
          }}
          onNavigate={(direction) => navigate(id, direction)}
        />
      ))}
    </div>
  );
}
