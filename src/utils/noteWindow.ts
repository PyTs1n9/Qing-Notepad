/**
 * The detached note window.
 *
 * This is not a sticky note: it is the full note surface (menu bar, editor,
 * outline, status bar) lifted into its own top-level window, so the label is
 * derived from the note id and exactly one window can exist per note. Opening
 * the same note twice focuses the existing window instead of creating a second
 * editor that would race the first one to disk.
 *
 * Event names live here as well: the two windows exchange saves through Tauri's
 * global event bus, and a typo in one of the three strings would look like a
 * sync bug rather than a compile error.
 */
import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Window, getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "@/stores/settingsStore";

/** Must match the `note-window-*` entry in `src-tauri/capabilities/default.json`. */
const NOTE_WINDOW_PREFIX = "note-window-";

/** Detached window → main editor: a write landed on disk. */
export const NOTE_WINDOW_SAVED_EVENT = "note-window:saved";
/** Main editor → detached window: its buffer was written to disk. */
export const NOTE_WINDOW_MAIN_SAVED_EVENT = "note-window:main-saved";
/** Theme / language changed in the main window. */
export const NOTE_WINDOW_APPEARANCE_EVENT = "note-window:appearance";

const WINDOW_WIDTH = 960;
const WINDOW_HEIGHT = 720;
/** A window narrower than this would fold the menu bar and the status bar. */
const WINDOW_MIN_WIDTH = 560;
const WINDOW_MIN_HEIGHT = 420;

function windowLabelFor(noteId: string): string {
  // Note ids are `[A-Za-z0-9_-]{1,64}` (storage.ts), so no escaping is needed;
  // the fallback only guards a caller that bypassed that contract.
  const safe = noteId.replace(/[^A-Za-z0-9_-]/g, "");
  return `${NOTE_WINDOW_PREFIX}${safe || "note"}`;
}

/**
 * Page colour of the calling window, handed to the new one so its first paint
 * is the theme's paper instead of the WebView's white. Read from the live
 * custom property rather than a hard-coded map: custom themes are user data.
 */
function currentPageColor(): [number, number, number] | undefined {
  try {
    const hex = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-bg-primary")
      .trim();
    const match = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!match) return undefined;
    const value = match[1];
    return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
      number,
      number,
      number,
    ];
  } catch {
    return undefined;
  }
}

/**
 * Open the note in its own window (or focus the one that already shows it).
 *
 * `decorations: false` is deliberate: the window draws a Typora-style header
 * with the app icon, the document title and the three window buttons, so the OS
 * chrome would be a second, differently styled title bar above it.
 */
export async function openNoteWindow(noteId: string, title: string): Promise<void> {
  const label = windowLabelFor(noteId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    // A window can be hidden (not just minimized) by the OS; `show` is the
    // difference between "bring it back" and "silently do nothing".
    await existing.show().catch(() => undefined);
    await existing.unminimize().catch(() => undefined);
    await existing.setFocus();
    return;
  }

  let x: number | undefined;
  let y: number | undefined;
  try {
    const current = getCurrentWindow();
    const position = await current.outerPosition();
    const size = await current.outerSize();
    // Cascade inside the parent instead of opening exactly on top of it: the
    // user just asked for a second view of the same document and should not
    // have to drag the new window out from under the old one.
    x = Math.round(position.x + Math.min(120, size.width * 0.12));
    y = Math.round(position.y + 48);
  } catch {
    // Position is cosmetic; fall back to the OS default.
  }

  const win = new WebviewWindow(label, {
    url: `/?noteWindow=${encodeURIComponent(noteId)}`,
    title: title || "Qing Notepad",
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    x,
    y,
    decorations: false,
    resizable: true,
    visible: false,
    backgroundColor: currentPageColor(),
  });

  win.once("tauri://created", () => {
    void win.show().catch(() => undefined);
    // The page reads the persisted settings on mount; this push only keeps a
    // freshly created window in step with an unsaved appearance change.
    const { theme, customColors, lang } = useSettingsStore.getState();
    void emitTo(label, NOTE_WINDOW_APPEARANCE_EVENT, { theme, customColors, lang })
      .catch(() => undefined);
  });

  win.once("tauri://error", (event) => {
    console.error("Failed to create the note window:", event);
  });
}

/**
 * Bring the main app back to the foreground.
 *
 * The main window is close-to-tray, so it may be hidden rather than merely
 * behind: `show` first, then un-minimize, then focus. `unminimize` rejects when
 * the window is not minimized, which is the normal case and not an error.
 */
export async function focusMainWindow(): Promise<void> {
  const main = await Window.getByLabel("main");
  if (!main) return;
  await main.show().catch(() => undefined);
  await main.unminimize().catch(() => undefined);
  await main.setFocus().catch(() => undefined);
}
