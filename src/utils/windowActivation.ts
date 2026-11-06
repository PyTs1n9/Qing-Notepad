/**
 * Getting a window in front of the user, on Windows.
 *
 * `show()` alone is not enough. Every detached surface in this app is built
 * either with `visible: false` (note window, sticky note) or with
 * `alwaysOnTop: true` (tile, canvas tile).
 *
 * - A hidden window never takes the activation path at creation: tao's
 *   `Window::new` calls `set_visible(false)`, which skips `ShowWindow`
 *   altogether, so the later `show()` is the only attempt — and the
 *   `ShowWindow(SW_SHOW)` inside it loses to the OS foreground lock whenever
 *   another window already sits in front (another note, the main shell, or
 *   Explorer, when the file was opened from there).
 * - A topmost window is raised with `SetWindowPos(..., SWP_NOACTIVATE)`, so it
 *   lands above its siblings without ever getting the keyboard.
 *
 * Either way the window appears in the right place and the user still has to
 * find it in the taskbar. `setFocus()` is the one call that reaches tao's
 * `force_window_active` — `SetForegroundWindow` plus the synthetic-key fallback
 * that defeats the foreground lock — so it is what actually claims the front.
 *
 * This module exists because four window types need the same three calls: note
 * window, tile, canvas tile and sticky note. A fifth one that copies only
 * `show()` reintroduces "the window opened somewhere behind everything".
 */
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Window } from "@tauri-apps/api/window";

/**
 * Show a window and give it the keyboard, in that order.
 *
 * The order is not negotiable: tao skips `set_focus` while the window is not
 * visible yet, and skips it again while it is minimized. The three commands are
 * awaited in sequence so each one lands on the event loop before the next reads
 * the window's flags.
 */
export async function activateWindow(win: Window | WebviewWindow): Promise<void> {
  await win.show().catch(() => undefined);
  // Rejects (or no-ops) when the window is not minimized; that is the normal
  // case, not an error worth surfacing.
  await win.unminimize().catch(() => undefined);
  await win.setFocus().catch(() => undefined);
}
