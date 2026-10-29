import React, { useId } from "react";

interface XiaoQingMarkProps {
  /** Pixel size. Omit inside `.ai-panel`, where `--ai-avatar-size` already scales it. */
  size?: number;
  className?: string;
}

/**
 * 小青's mark: the app icon's book, redrawn for a 20px rail.
 *
 * Taken from `src-tauri/icons/icon.png` - a circular haze-blue ground with a warm
 * paper book fanned open on it - but two things were changed on purpose:
 *
 * 1. **Value inverted.** The icon's own 32x32 build is the proof: pale ground,
 *    pale paper, one grey blob, no book. At 20px it would read as a smudge, so
 *    the ground goes dark (#2c4a57, the same hue pressed down) and the paper
 *    stays lit. That is what holds the silhouette at rail size.
 * 2. **Laptop base dropped.** It is the first thing to vanish at 32px and would
 *    only add noise here. The book is the part worth keeping.
 *
 * Still not theme-scoped: a yellow theme must not repaint 小青 yellow. See
 * `docs/decisions-ai-mark.md`.
 */
const XiaoQingMark: React.FC<XiaoQingMarkProps> = ({ size, className = "" }) => {
  // React's generated ids contain `:` (or guillemets in v19), which is not a
  // valid fragment selector inside `url(#...)`; strip everything else so two
  // marks on the same screen cannot collide either.
  const groundId = `xq-ground-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      // Inline style so an explicit size outranks the `.xq-mark` class, which
      // falls back to the panel's container-query variable.
      style={size ? { width: size, height: size } : undefined}
      className={`xq-mark ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={groundId} x1="9" y1="3" x2="24" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-qing-mark-bg)" />
          <stop offset="1" stopColor="var(--color-qing-mark-fold)" />
        </linearGradient>
      </defs>

      {/* Circular, like the icon - and the rail's other entries are square-ish
          hover targets, so a disc reads as "a mark", not "another page". */}
      <circle cx="16" cy="16" r="15.2" fill={`url(#${groundId})`} />
      {/* A light rim instead of a theme colour: on the light themes it is barely
          there (ground already clears 7.35), on the night sidebar it is the only
          thing separating a #2c4a57 disc from #1e1f23. */}
      <circle cx="16" cy="16" r="15.2" fill="none" stroke="#ffffff" strokeOpacity="0.32" />

      {/* Two pages meeting at a spine. The page tops slope **upward toward the
          outside** (outer edge y=8.8 vs spine y=10.6): that is what makes it one
          open book. A symmetric arc on each page gives a pair of bumps and reads
          as two separate books side by side - tried and discarded. */}
      <path
        d="M15.9 10.6C13.1 10.2 9.6 9.4 6 8.8V20.8C9.6 21 13.1 21.7 15.9 22.3Z"
        fill="var(--color-qing-mark-page)"
      />
      <path
        d="M16.1 10.6C18.9 10.2 22.4 9.4 26 8.8V20.8C22.4 21 18.9 21.7 16.1 22.3Z"
        fill="var(--color-qing-mark-page)"
      />
      {/* The spine. Half-opacity rather than a solid dark line, and heavy enough
          to survive 20px: at 1.1 units it was 0.7px there and the two pages
          welded into one bright blob. A deep V at the bottom was tried too and
          read as a bowtie; 22.3 keeps it shallow. */}
      <path
        d="M16 10.9V22.2"
        stroke="var(--color-qing-mark-fold)"
        strokeOpacity="0.72"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default XiaoQingMark;
