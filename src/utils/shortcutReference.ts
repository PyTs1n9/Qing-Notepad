import type { TranslationKeys } from "@/utils/i18n";

export interface ShortcutReferenceItem {
  keys: string;
  labelKey: keyof TranslationKeys;
}

export interface ShortcutReferenceGroup {
  titleKey: keyof TranslationKeys;
  items: ShortcutReferenceItem[];
}

/**
 * Single source for the in-app accelerator list.
 *
 * Only shortcuts that are actually handled somewhere in the codebase belong here —
 * every entry below is verifiable in source (`shortcutManager.ts` for the global
 * one, `NoteEditor` for save/table, `NoteTabBar` and `App` for Ctrl+W, `CanvasView`
 * for undo/redo). Anything not yet implemented must stay out: a help page that
 * advertises dead keys is worse than no help page.
 */
export const SHORTCUT_REFERENCE: ShortcutReferenceGroup[] = [
  {
    titleKey: "shortcutGroupGlobal",
    items: [{ keys: "Ctrl+Space", labelKey: "shortcutToggleWindow" }],
  },
  {
    titleKey: "shortcutGroupNote",
    items: [
      { keys: "Ctrl+S", labelKey: "shortcutSaveNote" },
      { keys: "Ctrl+1 … 6", labelKey: "shortcutHeadingLevels" },
      { keys: "Ctrl+Shift+K", labelKey: "codeBlock" },
      { keys: "Ctrl+K", labelKey: "link" },
      { keys: "Ctrl+F", labelKey: "shortcutFindReplace" },
      { keys: "Ctrl+/", labelKey: "shortcutSourceMode" },
      { keys: "Ctrl+Alt+T", labelKey: "shortcutInsertTable" },
    ],
  },
  {
    titleKey: "shortcutGroupTabs",
    items: [{ keys: "Ctrl+W", labelKey: "shortcutCloseTab" }],
  },
  {
    titleKey: "shortcutGroupCanvas",
    items: [{ keys: "Ctrl+Z / Ctrl+Y", labelKey: "shortcutUndoRedo" }],
  },
];
