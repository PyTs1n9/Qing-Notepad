import { create } from "zustand";

export type ThemeType = "dark" | "blue" | "yellow" | "green" | "custom";
export type LangType = "zh" | "en";
export type AutoSaveInterval = 0 | 10000 | 30000 | 60000;

export const DEFAULT_STICKY_OPACITY = 85;
export const MIN_STICKY_OPACITY = 0;
export const MAX_STICKY_OPACITY = 100;

/** Recycle bin retention. 0 disables the recycle bin, -1 keeps notes forever. */
export const TRASH_RETENTION_DISABLED = 0;
export const TRASH_RETENTION_FOREVER = -1;
export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_OPTIONS = [
  TRASH_RETENTION_DISABLED,
  7,
  30,
  90,
  TRASH_RETENTION_FOREVER,
] as const;

export function normalizeTrashRetentionDays(value: unknown): number {
  if (value === TRASH_RETENTION_FOREVER) return TRASH_RETENTION_FOREVER;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TRASH_RETENTION_DAYS;
  }
  const days = Math.floor(value);
  if (days <= 0) return TRASH_RETENTION_DISABLED;
  return days;
}

export function normalizeStickyOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_STICKY_OPACITY;
  }
  return Math.min(MAX_STICKY_OPACITY, Math.max(MIN_STICKY_OPACITY, Math.round(value)));
}

// Frosted-glass (backdrop-blur) tuning for the panel shell. Two profiles are
// kept separately: the base profile applies whenever glass is enabled, while the
// background profile overrides it only while a custom background image is set
// (a busier backdrop needs more blur and a lower tint to stay readable).
export const DEFAULT_GLASS_ENABLED = true;
export const DEFAULT_GLASS_BLUR = 12;
export const DEFAULT_GLASS_TINT = 80;
export const DEFAULT_GLASS_SATURATE = 120;
export const DEFAULT_GLASS_BLUR_BG = 20;
/**
 * Rails are the depth anchor of the shell, so behind a wallpaper they sit a
 * notch more solid than the base profile (83 instead of 80) and their base
 * colour is pushed towards black by `GLASS_RAIL_DARKEN`.
 */
export const DEFAULT_GLASS_TINT_BG = 83;
export const DEFAULT_GLASS_SATURATE_BG = 140;

/**
 * The main card is deliberately *lighter* than the rails behind a wallpaper:
 * the wallpaper has to read through the middle of the window. It is derived
 * from the rail tint instead of being its own slider, so dragging the rail
 * keeps the "rails deep, middle light" relationship intact.
 *
 * The bounds were raised to [72,94] on 2026-10-27 to protect body text, then put
 * back the same day: at 72 only 28% of the wallpaper shows through, and the
 * blur slider stops producing a visible change - the frost is diluted to the
 * point of looking broken. Legibility is now handled by
 * `GLASS_READABILITY_FLOOR` + `data-contrast="boost"`, which lets the card go
 * transparent again without putting unreadable text on a photo.
 */
export const GLASS_EDITOR_TINT_DROP = 20;
export const MIN_GLASS_EDITOR_TINT = 40;
export const MAX_GLASS_EDITOR_TINT = 76;

/** How far the rail base colour moves towards black behind a wallpaper, in %. */
export const GLASS_RAIL_DARKEN = 15;

export const MIN_GLASS_BLUR = 0;
export const MAX_GLASS_BLUR = 40;
/**
 * Rail tint floor. The slider runs the full range - clamping it to a "safe"
 * minimum (an earlier fix pinned it at 75) left only a quarter of the track
 * usable and made the control feel broken. Readability is handled downstream
 * instead: below `GLASS_READABILITY_FLOOR` the app promotes `text-muted` to
 * `text-secondary` (`.app-root[data-contrast="boost"]`), so a transparent panel
 * loses a tier of hierarchy rather than becoming unreadable.
 */
export const MIN_GLASS_TINT = 0;

/**
 * The tint at which `text-muted` stops clearing 4.5:1 against the composited
 * panel. Below it the muted tier is promoted. Measured: the binding case is
 * blue, where 74 is the last compliant value.
 */
export const GLASS_READABILITY_FLOOR = 75;
export const MAX_GLASS_TINT = 100;
export const MIN_GLASS_SATURATE = 0;
export const MAX_GLASS_SATURATE = 200;

function normalizeGlassNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Wallpaper-mode tint for the editor / main card, derived from the rail tint.
 *
 * Two clamps, both load-bearing:
 * - the hard bounds keep the card from going opaque (76) or so transparent that
 *   the wallpaper swallows the text (40);
 * - the `side - 6` cap stops the middle card from reading more solid than the
 *   rails, which would invert the shell's depth.
 *
 * Readability below 40 is not this function's job: it is `GLASS_READABILITY_FLOOR`
 * that promotes the text tiers on a transparent panel.
 */
export function deriveGlassEditorTint(sideTint: number): number {
  const derived = Math.min(
    MAX_GLASS_EDITOR_TINT,
    Math.max(MIN_GLASS_EDITOR_TINT, sideTint - GLASS_EDITOR_TINT_DROP),
  );
  return Math.min(derived, Math.max(sideTint - 6, 0));
}

export interface CustomColors {
  bgPrimary: string;
  bgSecondary: string;
  bgSidebar: string;
  textPrimary: string;
  accent: string;
}

export interface SavedPreset {
  name: string;
  colors: CustomColors;
}

export interface AppShortcuts {
  toggleWindow: string;
}

export const DEFAULT_SHORTCUTS: AppShortcuts = {
  toggleWindow: "Ctrl+Space",
};

/**
 * Share of the sidebar column taken by the category panel, or `null` when the
 * user never dragged it (automatic default). Stored as a ratio instead of pixels
 * so the split keeps its proportion when the window is resized.
 */
export function normalizeSidebarCategoryRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value > 1) return null;
  return Math.round(value * 10000) / 10000;
}

/**
 * Folder ids expanded in the note tree. `null` means "never touched yet" and the
 * tree falls back to expanding every folder; an empty array means "all folded".
 */
export function normalizeExpandedFolderIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string")));
}

// Preset theme colors for syncing to custom palette
export const THEME_COLORS: Record<Exclude<ThemeType, "custom">, CustomColors> = {
  dark: { bgPrimary: "#1a1b1e", bgSecondary: "#25262b", bgSidebar: "#1e1f23", textPrimary: "#e9ecef", accent: "#5c7cfa" },
  blue: { bgPrimary: "#f0f4f8", bgSecondary: "#e2e8f0", bgSidebar: "#dbe4ef", textPrimary: "#1e293b", accent: "#2563eb" },
  yellow: { bgPrimary: "#faf6ec", bgSecondary: "#f2ecdc", bgSidebar: "#ebe5d2", textPrimary: "#4a4030", accent: "#c4a24a" },
  green: { bgPrimary: "#f4faf6", bgSecondary: "#e8f2ec", bgSidebar: "#deeadf", textPrimary: "#2a4a38", accent: "#4aaa6a" },
};

interface SettingsState {
  theme: ThemeType;
  lang: LangType;
  customColors: CustomColors | null;
  customBackground: string | null;
  savedPresets: SavedPreset[];
  shortcuts: AppShortcuts;
  autoSaveInterval: AutoSaveInterval;
  stickyOpacity: number;
  trashRetentionDays: number;
  showWorkspaceHighlights: boolean;
  alwaysOnTop: boolean;
  updateReminderDisabledForVersion: string | null;
  sidebarCategoryRatio: number | null;
  expandedFolderIds: string[] | null;
  glassEnabled: boolean;
  glassBlur: number;
  glassTint: number;
  glassSaturate: number;
  glassBlurBg: number;
  glassTintBg: number;
  glassSaturateBg: number;
  /** Temporary kill switch: every plugin is refused while this is true. */
  pluginsDisabled: boolean;
  /**
   * Announcement feed (D4/D7). When off, no request is made at all; the board
   * still renders the copy bundled with the build.
   */
  announcementsEnabled: boolean;
  setPluginsDisabled: (disabled: boolean) => void;
  setAnnouncementsEnabled: (enabled: boolean) => void;
  setTheme: (theme: ThemeType) => void;
  setLang: (lang: LangType) => void;
  setCustomColors: (colors: CustomColors) => void;
  setCustomBackground: (filename: string | null) => void;
  savePreset: (name: string) => void;
  loadPreset: (index: number) => void;
  deletePreset: (index: number) => void;
  setShortcuts: (shortcuts: AppShortcuts) => void;
  setAutoSaveInterval: (interval: AutoSaveInterval) => void;
  setStickyOpacity: (opacity: number) => void;
  setTrashRetentionDays: (days: number) => void;
  setShowWorkspaceHighlights: (show: boolean) => void;
  setAlwaysOnTop: (alwaysOnTop: boolean) => void;
  setUpdateReminderDisabledForVersion: (version: string | null) => void;
  setSidebarCategoryRatio: (ratio: number | null) => void;
  setExpandedFolderIds: (ids: string[] | null) => void;
  setGlassEnabled: (enabled: boolean) => void;
  setGlassBlur: (blur: number) => void;
  setGlassTint: (tint: number) => void;
  setGlassSaturate: (saturate: number) => void;
  setGlassBlurBg: (blur: number) => void;
  setGlassTintBg: (tint: number) => void;
  setGlassSaturateBg: (saturate: number) => void;
  loadSettings: (settings: {
    theme?: ThemeType;
    lang?: LangType;
    customColors?: CustomColors | null;
    customBackground?: string | null;
    savedPresets?: SavedPreset[];
    shortcuts?: AppShortcuts;
    autoSaveInterval?: AutoSaveInterval;
    stickyOpacity?: number;
    trashRetentionDays?: number;
    showWorkspaceHighlights?: boolean;
    alwaysOnTop?: boolean;
    updateReminderDisabledForVersion?: string | null;
    sidebarCategoryRatio?: number | null;
    expandedFolderIds?: string[] | null;
    glassEnabled?: boolean;
    glassBlur?: number;
    glassTint?: number;
    glassSaturate?: number;
    glassBlurBg?: number;
    glassTintBg?: number;
    glassSaturateBg?: number;
    pluginsDisabled?: boolean;
    announcementsEnabled?: boolean;
  }) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "blue",
  lang: "zh",
  customColors: null,
  customBackground: null,
  savedPresets: [],
  shortcuts: DEFAULT_SHORTCUTS,
  autoSaveInterval: 0,
  stickyOpacity: DEFAULT_STICKY_OPACITY,
  trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS,
  showWorkspaceHighlights: true,
  alwaysOnTop: false,
  updateReminderDisabledForVersion: null,
  sidebarCategoryRatio: null,
  expandedFolderIds: null,
  glassEnabled: DEFAULT_GLASS_ENABLED,
  glassBlur: DEFAULT_GLASS_BLUR,
  glassTint: DEFAULT_GLASS_TINT,
  glassSaturate: DEFAULT_GLASS_SATURATE,
  glassBlurBg: DEFAULT_GLASS_BLUR_BG,
  glassTintBg: DEFAULT_GLASS_TINT_BG,
  glassSaturateBg: DEFAULT_GLASS_SATURATE_BG,
  pluginsDisabled: false,
  announcementsEnabled: true,

  setTheme: (theme) => {
    // Sync custom palette when clicking a preset
    if (theme !== "custom") {
      set({ theme, customColors: { ...THEME_COLORS[theme] } });
    } else {
      set({ theme });
    }
  },

  setLang: (lang) => set({ lang }),

  setCustomColors: (colors) => set({ customColors: colors, theme: "custom" }),

  setCustomBackground: (customBackground) => set({ customBackground }),

  savePreset: (name) => {
    const { customColors, savedPresets } = get();
    if (!customColors || savedPresets.length >= 5) return;
    set({ savedPresets: [...savedPresets, { name, colors: { ...customColors } }] });
  },

  loadPreset: (index) => {
    const { savedPresets } = get();
    if (index < 0 || index >= savedPresets.length) return;
    set({ customColors: { ...savedPresets[index].colors }, theme: "custom" });
  },

  deletePreset: (index) => {
    const { savedPresets } = get();
    set({ savedPresets: savedPresets.filter((_, i) => i !== index) });
  },

  setShortcuts: (shortcuts) => set({ shortcuts }),

  setAutoSaveInterval: (autoSaveInterval) => set({ autoSaveInterval }),

  setStickyOpacity: (stickyOpacity) => set({ stickyOpacity: normalizeStickyOpacity(stickyOpacity) }),

  setTrashRetentionDays: (days) => set({ trashRetentionDays: normalizeTrashRetentionDays(days) }),

  setShowWorkspaceHighlights: (showWorkspaceHighlights) => set({ showWorkspaceHighlights }),

  setAlwaysOnTop: (alwaysOnTop) => set({ alwaysOnTop }),

  setPluginsDisabled: (pluginsDisabled) => set({ pluginsDisabled }),

  setAnnouncementsEnabled: (announcementsEnabled) => set({ announcementsEnabled }),

  setUpdateReminderDisabledForVersion: (updateReminderDisabledForVersion) => set({ updateReminderDisabledForVersion }),

  setSidebarCategoryRatio: (ratio) => set({ sidebarCategoryRatio: normalizeSidebarCategoryRatio(ratio) }),

  setExpandedFolderIds: (ids) => set({ expandedFolderIds: normalizeExpandedFolderIds(ids) }),

  setGlassEnabled: (glassEnabled) => set({ glassEnabled }),

  setGlassBlur: (glassBlur) =>
    set({ glassBlur: normalizeGlassNumber(glassBlur, MIN_GLASS_BLUR, MAX_GLASS_BLUR, DEFAULT_GLASS_BLUR) }),

  setGlassTint: (glassTint) =>
    set({ glassTint: normalizeGlassNumber(glassTint, MIN_GLASS_TINT, MAX_GLASS_TINT, DEFAULT_GLASS_TINT) }),

  setGlassSaturate: (glassSaturate) =>
    set({ glassSaturate: normalizeGlassNumber(glassSaturate, MIN_GLASS_SATURATE, MAX_GLASS_SATURATE, DEFAULT_GLASS_SATURATE) }),

  setGlassBlurBg: (glassBlurBg) =>
    set({ glassBlurBg: normalizeGlassNumber(glassBlurBg, MIN_GLASS_BLUR, MAX_GLASS_BLUR, DEFAULT_GLASS_BLUR_BG) }),

  setGlassTintBg: (glassTintBg) =>
    set({ glassTintBg: normalizeGlassNumber(glassTintBg, MIN_GLASS_TINT, MAX_GLASS_TINT, DEFAULT_GLASS_TINT_BG) }),

  setGlassSaturateBg: (glassSaturateBg) =>
    set({ glassSaturateBg: normalizeGlassNumber(glassSaturateBg, MIN_GLASS_SATURATE, MAX_GLASS_SATURATE, DEFAULT_GLASS_SATURATE_BG) }),

  loadSettings: (settings) =>
    set({
      theme: settings.theme || "blue",
      lang: settings.lang || "zh",
      customColors: settings.customColors || null,
      customBackground: settings.customBackground || null,
      savedPresets: settings.savedPresets || [],
      shortcuts: settings.shortcuts || DEFAULT_SHORTCUTS,
      autoSaveInterval: settings.autoSaveInterval || 0,
      stickyOpacity: normalizeStickyOpacity(settings.stickyOpacity),
      trashRetentionDays: normalizeTrashRetentionDays(settings.trashRetentionDays),
      showWorkspaceHighlights: settings.showWorkspaceHighlights ?? true,
      alwaysOnTop: settings.alwaysOnTop === true,
      updateReminderDisabledForVersion: typeof settings.updateReminderDisabledForVersion === "string"
        ? settings.updateReminderDisabledForVersion
        : null,
      sidebarCategoryRatio: normalizeSidebarCategoryRatio(settings.sidebarCategoryRatio),
      expandedFolderIds: normalizeExpandedFolderIds(settings.expandedFolderIds),
      glassEnabled: settings.glassEnabled !== false,
      glassBlur: normalizeGlassNumber(settings.glassBlur, MIN_GLASS_BLUR, MAX_GLASS_BLUR, DEFAULT_GLASS_BLUR),
      glassTint: normalizeGlassNumber(settings.glassTint, MIN_GLASS_TINT, MAX_GLASS_TINT, DEFAULT_GLASS_TINT),
      glassSaturate: normalizeGlassNumber(settings.glassSaturate, MIN_GLASS_SATURATE, MAX_GLASS_SATURATE, DEFAULT_GLASS_SATURATE),
      glassBlurBg: normalizeGlassNumber(settings.glassBlurBg, MIN_GLASS_BLUR, MAX_GLASS_BLUR, DEFAULT_GLASS_BLUR_BG),
      glassTintBg: normalizeGlassNumber(settings.glassTintBg, MIN_GLASS_TINT, MAX_GLASS_TINT, DEFAULT_GLASS_TINT_BG),
      glassSaturateBg: normalizeGlassNumber(settings.glassSaturateBg, MIN_GLASS_SATURATE, MAX_GLASS_SATURATE, DEFAULT_GLASS_SATURATE_BG),
      pluginsDisabled: settings.pluginsDisabled === true,
      // Opt-out flag: only an explicit `false` disables the feed.
      announcementsEnabled: settings.announcementsEnabled !== false,
    }),
}));
