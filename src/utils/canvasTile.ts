import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "@/stores/settingsStore";
import { activateWindow } from "@/utils/windowActivation";

const CANVAS_TILE_WIDTH = 680;
const CANVAS_TILE_HEIGHT = 520;

export async function openCanvasTileWindow(canvasId: string): Promise<void> {
  const safeId = canvasId.replace(/[^A-Za-z0-9_-]/g, "");
  const label = `canvas-tile-${safeId}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await activateWindow(existing);
    return;
  }

  let x = 120;
  let y = 120;
  try {
    const main = getCurrentWindow();
    const position = await main.outerPosition();
    x = position.x + 36;
    y = position.y + 72;
  } catch {
    // Keep the fallback position.
  }

  const tile = new WebviewWindow(label, {
    url: `/?canvasTile=${encodeURIComponent(canvasId)}`,
    width: CANVAS_TILE_WIDTH,
    height: CANVAS_TILE_HEIGHT,
    x,
    y,
    decorations: false,
    alwaysOnTop: true,
    visible: true,
    resizable: true,
    title: "Canvas Tile",
  });

  tile.once("tauri://created", () => {
    // See `windowActivation`: a topmost window is raised without activation,
    // so the focus call is what brings it in front of the app.
    void activateWindow(tile);
    const { theme, customColors } = useSettingsStore.getState();
    void emit("tile-theme-sync", { theme, customColors });
  });
}
