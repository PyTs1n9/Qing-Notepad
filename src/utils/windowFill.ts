/**
 * Vertical fill ("上下铺满") for the frameless windows.
 *
 * Double-clicking the very top edge of a title bar stretches the window to the
 * full working height of its monitor while leaving the width alone — the shape
 * Windows produces when you drag a window to the top or bottom screen edge.
 * Double-clicking again restores the exact geometry it had before, so the
 * gesture is a toggle rather than a one-way trip.
 *
 * Two details make this less trivial than `setSize`:
 *
 * 1. `decorations: false` does not mean "no frame". Windows still reports a
 *    resize frame, measured here as 22x13 physical px at 150% scaling. Tauri's
 *    `setSize` takes an inner (client) size while `setPosition` moves the outer
 *    rect, so aligning an outer rect to the work area would leave the client
 *    area short by the frame on every edge. Every coordinate below is therefore
 *    kept in the inner space and shifted by half the frame on the way out,
 *    which makes the client area — the part the user can see — land exactly on
 *    the work area, with the invisible frame hanging off-screen the same way
 *    Windows' own maximise does.
 * 2. A maximised window ignores `setSize`. Arriving from the maximise button
 *    means dropping out of that state first and waiting for the resize to land.
 *
 * The restore geometry is intentionally in module state, not in the store: it
 * belongs to one window's current session and must not survive a reload.
 */
import { PhysicalPosition, PhysicalSize, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import type { Window } from "@tauri-apps/api/window";

/** Client-area rectangle the window had before it was filled. */
interface FillRestore {
  width: number;
  height: number;
  x: number;
  y: number;
}

let restore: FillRestore | null = null;

/** A frame the OS draws but the user never sees. See note 1 in the header. */
interface FrameMetrics {
  innerWidth: number;
  innerHeight: number;
  /** Client-area top-left, i.e. outer position pushed in by the frame. */
  innerX: number;
  innerY: number;
  frameX: number;
  frameY: number;
}

async function readFrame(win: Window): Promise<FrameMetrics> {
  const [inner, outer, outerPosition] = await Promise.all([
    win.innerSize(),
    win.outerSize(),
    win.outerPosition(),
  ]);
  const frameX = Math.max(0, outer.width - inner.width);
  const frameY = Math.max(0, outer.height - inner.height);
  return {
    innerWidth: inner.width,
    innerHeight: inner.height,
    innerX: outerPosition.x + frameX / 2,
    innerY: outerPosition.y + frameY / 2,
    frameX,
    frameY,
  };
}

/**
 * Resolves on the first resize event or the timeout, whichever comes first.
 * `unmaximize` is asynchronous and there is no promise for "the OS has settled
 * the window", so a resize event is the closest observable proxy.
 */
function nextResize(win: Window, timeoutMs = 200): Promise<void> {
  return new Promise<void>((resolve) => {
    let unlisten: (() => void) | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    void win.onResized(finish).then((fn) => {
      unlisten = fn;
      if (settled) fn();
    });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * `setPosition` takes i32 and rejects a fractional value outright, while a
 * frame of 13 physical px halves into 6.5. Rounding each axis is also what
 * keeps the restore path bit-for-bit repeatable: the same frame produces the
 * same integers on the way in and out.
 */
async function applyGeometry(win: Window, frame: FrameMetrics, width: number, height: number, x: number, y: number) {
  await Promise.all([
    win.setSize(new PhysicalSize(Math.round(width), Math.round(height))),
    win.setPosition(
      new PhysicalPosition(
        Math.round(x - frame.frameX / 2),
        Math.round(y - frame.frameY / 2),
      ),
    ),
  ]);
}

/**
 * Toggle the calling window between its current geometry and a full-height
 * band on its monitor. Never throws for geometry reasons; window commands can
 * still reject and are surfaced to the caller.
 */
export async function toggleVerticalFill(): Promise<void> {
  const win = getCurrentWindow();

  if (await win.isMaximized()) {
    // Nothing meaningful to restore when the starting point was maximise.
    restore = null;
    await win.unmaximize();
    await nextResize(win);
  }

  const frame = await readFrame(win);

  if (restore) {
    const saved = restore;
    restore = null;
    await applyGeometry(win, frame, saved.width, saved.height, saved.x, saved.y);
    return;
  }

  const monitor = await currentMonitor();
  if (!monitor) return;

  const work = monitor.workArea;
  // Width is preserved, but a window wider than the monitor is pulled in so
  // the fill never leaves the screen it is measured against.
  const width = Math.min(frame.innerWidth, work.size.width);
  const x = clamp(frame.innerX, work.position.x, work.position.x + work.size.width - width);

  restore = {
    width: frame.innerWidth,
    height: frame.innerHeight,
    x: frame.innerX,
    y: frame.innerY,
  };

  await applyGeometry(win, frame, width, work.size.height, x, work.position.y);
}
