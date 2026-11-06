import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settingsStore";
import { activateWindow } from "@/utils/windowActivation";

const TILE_WIDTH = 400;
const TILE_HEIGHT = 500;
const OFFSET_X = 20;
const OFFSET_Y = 50;

export async function openTileWindow(noteId: string): Promise<void> {
  const label = `tile-${noteId}`;

  // Check if tile already exists — focus it instead of creating a new one
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await activateWindow(existing);
    return;
  }

  // Calculate position: offset to the right of the main window
  let x = 100;
  let y = 100;
  try {
    const mainWindow = getCurrentWindow();
    const pos = await mainWindow.outerPosition();
    const size = await mainWindow.outerSize();
    x = pos.x + size.width + OFFSET_X;
    y = pos.y + OFFSET_Y;
  } catch {
    // Fallback to default position if we can't get main window info
  }

  const tile = new WebviewWindow(label, {
    url: `/?tile=1&noteId=${encodeURIComponent(noteId)}`,
    width: TILE_WIDTH,
    height: TILE_HEIGHT,
    x,
    y,
    decorations: false,
    alwaysOnTop: true,
    visible: true,
    resizable: true,
    title: "Note Tile",
  });

  // Wait for the window to be created, then sync theme. `alwaysOnTop` raises
  // the window without activating it, so the focus call is what puts it in
  // front of the app instead of merely on top of it.
  tile.once("tauri://created", () => {
    void activateWindow(tile);
    const { theme, customColors } = useSettingsStore.getState();
    emit("tile-theme-sync", { theme, customColors });
  });
}
