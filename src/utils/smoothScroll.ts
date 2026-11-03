/**
 * Animated scroll for a single scroll container.
 *
 * Why not `Element.scrollTo({ behavior: "smooth" })`: the browser picks the
 * duration (a long jump and a short one take the same ~400ms), the curve is not
 * ours, and there is no way to interrupt it when the user grabs the wheel. A
 * rAF loop gives all three: a duration that scales with the distance, the app's
 * own ease-out curve, and a handle the caller can cancel on the next input.
 */

/** Cubic ease-out — the shape of `--ease-out`, without the bezier solver. */
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Never so short that it reads as a jump, never so long that it feels stuck. */
const MIN_DURATION = 180;
const MAX_DURATION = 420;
/** Milliseconds per pixel travelled. */
const MS_PER_PX = 0.45;

export interface ScrollAnimation {
  /** Stop where the animation is right now; safe to call twice. */
  cancel: () => void;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Scroll `scroller` to `target` (a `scrollTop` value, clamped to the scrollable
 * range). Returns a handle so the caller can abort mid-flight — the animation
 * must never fight the user.
 */
export function animateScrollTop(scroller: HTMLElement, target: number): ScrollAnimation {
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const destination = Math.min(Math.max(target, 0), maxScroll);
  const start = scroller.scrollTop;
  const distance = destination - start;

  // Reduced motion, or a hop too small to see: land immediately. The caller
  // still gets a handle so the cancel plumbing stays uniform.
  if (prefersReducedMotion() || Math.abs(distance) < 1) {
    scroller.scrollTop = destination;
    return { cancel: () => {} };
  }

  const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.abs(distance) * MS_PER_PX));
  const startedAt = performance.now();
  let frame = 0;
  let cancelled = false;

  const step = (now: number) => {
    if (cancelled) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    scroller.scrollTop = start + distance * easeOutCubic(progress);
    if (progress < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);

  return {
    cancel: () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
