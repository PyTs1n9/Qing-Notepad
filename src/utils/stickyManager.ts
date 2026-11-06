import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { activateWindow } from "@/utils/windowActivation";

// Track open sticky windows (key: noteId, value: window label)
const openStickies = new Map<string, string>();
// Counter for generating unique labels
let stickyCounter = 0;

// Listen for sticky-close events emitted by sticky windows themselves
listen<{ noteId: string }>("sticky:closed", (event) => {
  openStickies.delete(event.payload.noteId);
});

export async function createStickyNote(noteId: string): Promise<void> {
  // If already open, just focus it
  const existingLabel = openStickies.get(noteId);
  if (existingLabel) {
    try {
      const existing = new WebviewWindow(existingLabel);
      await activateWindow(existing);
      return;
    } catch {
      // Window no longer exists, remove from tracking
      openStickies.delete(noteId);
    }
  }

  // Generate unique label to avoid Tauri v2 label reuse issues
  const label = `sticky-${noteId}-${Date.now()}-${stickyCounter++}`;
  openStickies.set(noteId, label);

  // Create new sticky window
  const webview = new WebviewWindow(label, {
    url: `/?sticky=${noteId}`,
    title: "Sticky Note",
    width: 320,
    height: 400,
    minWidth: 200,
    minHeight: 200,
    decorations: false,
    alwaysOnTop: true,
    transparent: true,
    resizable: true,
    maximizable: false,
    skipTaskbar: true,
    visible: false, // Hidden initially to avoid flash
  });

  webview.once("tauri://created", () => {
    // `visible: false` was used to avoid the white flash, which also rules out
    // the activation tao would otherwise do at creation — see `windowActivation`.
    void activateWindow(webview);
  });

  webview.once("tauri://error", (e) => {
    console.error("Failed to create sticky note:", e);
    openStickies.delete(noteId);
  });

  // Clean up tracking when window is destroyed
  webview.once("tauri://destroyed", () => {
    openStickies.delete(noteId);
  });
}

export function isStickyOpen(noteId: string): boolean {
  return openStickies.has(noteId);
}

export async function closeStickyNote(noteId: string): Promise<void> {
  const label = openStickies.get(noteId);
  if (!label) return;
  try {
    // Let the sticky window flush any pending debounced edit before closing.
    await emitTo(label, "sticky:request-close", { noteId });
  } catch {
    // Window already doesn't exist
    openStickies.delete(noteId);
  }
}
