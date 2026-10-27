import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Camera,
  Check,
  Clock,
  Droplets,
  Eye,
  FolderOpen,
  Globe,
  HardDrive,
  ImagePlus,
  KeyRound,
  Keyboard,
  LogIn,
  LogOut,
  Mail,
  Palette,
  Pencil,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAuthStore } from "@/stores/authStore";
import type {
  AppShortcuts,
  AutoSaveInterval,
  CustomColors,
  LangType,
  ThemeType,
} from "@/stores/settingsStore";
import {
  DEFAULT_SHORTCUTS,
  MAX_GLASS_BLUR,
  MAX_GLASS_SATURATE,
  MAX_GLASS_TINT,
  MAX_STICKY_OPACITY,
  MIN_GLASS_BLUR,
  MIN_GLASS_SATURATE,
  MIN_GLASS_TINT,
  MIN_STICKY_OPACITY,
  THEME_COLORS,
  TRASH_RETENTION_DISABLED,
  TRASH_RETENTION_FOREVER,
} from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { isSupabaseConfigured } from "@/utils/supabase";
import { pauseShortcuts, resumeShortcuts } from "@/utils/shortcutManager";
import {
  deleteAvatarCache,
  deleteCustomBackground,
  getImageTrashRootDirectory,
  getNotesDirectory,
  listAvatarHistory,
  listCustomBackgroundHistory,
  loadAvatarCacheDataUrl,
  saveAvatarCache,
  saveCustomBackground,
} from "@/utils/storage";
import type { StoredImageHistoryItem } from "@/utils/storage";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import AvatarCropper from "@/components/Settings/AvatarCropper";
import StorageSection from "@/components/Settings/StorageSection";
import AiSettingsPanel from "@/components/AI/AiSettingsPanel";
import PanelErrorBoundary from "@/components/PanelErrorBoundary";
import LoadingText from "@/components/LoadingText";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onOpenAuth: () => void;
  /** Section to land on when the modal opens; defaults to the first one. */
  initialSection?: SettingsSection;
  /**
   * Whether the shell is currently rendering a wallpaper. Owned by App.tsx
   * because that is where the asset URL is resolved - see the comment at the
   * `hasWallpaper` alias below.
   */
  hasWallpaper?: boolean;
}

export type SettingsSection = "basic" | "theme" | "language" | "ai" | "personal" | "storage";
type DisplayHistoryItem = StoredImageHistoryItem & { url: string };

function getUploadImageExtension(file: File): string | null {
  if (file.type === "image/jpeg") return "jpg";
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension && ["jpg", "jpeg", "png", "webp"].includes(extension) ? extension : null;
}

interface GlassSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: "px" | "%";
  disabled: boolean;
  /** Shown under the row when the knob cannot do anything yet. */
  hint?: string;
  onChange: (value: number) => void;
}

/** Labelled range row for the frosted-glass tuning knobs. */
const GlassSlider: React.FC<GlassSliderProps> = ({ label, value, min, max, unit, disabled, hint, onChange }) => (
  <label className={`block min-w-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
    <span className="mb-1 flex items-center justify-between gap-2">
      <span className="truncate text-xs text-text-secondary">{label}</span>
      <span className={`flex-shrink-0 text-xs font-medium tabular-nums ${disabled ? "text-text-muted" : "text-accent-text"}`}>
        {value}{unit}
      </span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={1}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      aria-label={label}
      className="block h-2 w-full cursor-pointer accent-accent disabled:cursor-not-allowed"
    />
    {hint ? <span className="mt-1 block text-[11px] leading-tight text-text-muted">{hint}</span> : null}
  </label>
);

const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  onOpenAuth,
  initialSection,
  hasWallpaper: hasWallpaperProp = false,
}) => {
  const {
    theme,
    lang,
    customColors,
    customBackground,
    savedPresets,
    shortcuts,
    autoSaveInterval,
    stickyOpacity,
    trashRetentionDays,
    glassEnabled,
    glassBlur,
    glassTint,
    glassSaturate,
    glassBlurBg,
    glassTintBg,
    glassSaturateBg,
    setTheme,
    setLang,
    setCustomColors,
    setCustomBackground,
    savePreset,
    loadPreset,
    deletePreset,
    setShortcuts,
    setAutoSaveInterval,
    setStickyOpacity,
    setTrashRetentionDays,
    setGlassEnabled,
    setGlassBlur,
    setGlassTint,
    setGlassSaturate,
    setGlassBlurBg,
    setGlassTintBg,
    setGlassSaturateBg,
  } = useSettingsStore();
  const { user, loading: authLoading, error: authError, signOut, updateProfile, updatePassword, clearError } = useAuthStore();
  const activeAvatarCache = typeof user?.user_metadata?.avatar_cache === "string"
    ? user.user_metadata.avatar_cache
    : null;

  const [activeSection, setActiveSection] = useState<SettingsSection>("basic");
  // The two profiles are chosen by whichever one App.tsx can actually apply, so
  // this is passed in rather than re-derived from the stored filename: the
  // settings file can name a background whose asset URL failed to resolve, and
  // reading the filename here made the panel enable the wallpaper group while
  // the shell was still writing the base profile. Both sliders then moved
  // nothing, which is indistinguishable from a broken control.
  const hasWallpaper = hasWallpaperProp;
  // `@media (prefers-reduced-transparency: reduce)` in index.css drops every
  // backdrop-filter, which is how Windows reports "transparency effects: off".
  // Without this note the whole glass section looks broken for no visible reason.
  // The six sliders are disabled on the same signal: leaving them live would
  // offer controls that provably cannot change a pixel.
  const [reducedTransparency, setReducedTransparency] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const sync = () => setReducedTransparency(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  // A caller can request a section (the model picker's「添加模型」jumps to AI
  // settings). Re-applied on every open so it wins over last time's manual pick.
  useEffect(() => {
    if (open && initialSection) setActiveSection(initialSection);
  }, [open, initialSection]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [autoSaveDropdownOpen, setAutoSaveDropdownOpen] = useState(false);
  const [trashDropdownOpen, setTrashDropdownOpen] = useState(false);
  const [recordingField, setRecordingField] = useState<keyof AppShortcuts | null>(null);
  const [dataDirectory, setDataDirectory] = useState<string | null>(null);
  const [imageCacheDirectory, setImageCacheDirectory] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [nicknameEditing, setNicknameEditing] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [personalNotice, setPersonalNotice] = useState<string | null>(null);
  const [personalValidation, setPersonalValidation] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);
  const [avatarHistory, setAvatarHistory] = useState<DisplayHistoryItem[]>([]);
  const [backgroundHistory, setBackgroundHistory] = useState<DisplayHistoryItem[]>([]);
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [personalAction, setPersonalAction] = useState<"nickname" | "password" | "signOut" | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const autoSaveDropdownRef = useRef<HTMLDivElement>(null);
  const trashDropdownRef = useRef<HTMLDivElement>(null);

  const refreshAvatarHistory = useCallback(async () => {
    if (!user) {
      setAvatarHistory([]);
      return;
    }
    const items = await listAvatarHistory(user.id);
    setAvatarHistory(items.map((item) => ({ ...item, url: convertFileSrc(item.path) })));
  }, [user?.id]);

  const refreshBackgroundHistory = useCallback(async () => {
    const items = await listCustomBackgroundHistory();
    setBackgroundHistory(items.map((item) => ({ ...item, url: convertFileSrc(item.path) })));
  }, []);

  useEffect(() => {
    const metadata = user?.user_metadata as Record<string, unknown> | undefined;
    const displayName = typeof metadata?.display_name === "string" ? metadata.display_name : "";
    setNicknameDraft(displayName);
    setNicknameEditing(false);
    setPasswordOpen(false);
    setNewPassword("");
    setConfirmNewPassword("");
    setPersonalNotice(null);
    setPersonalValidation(null);
    setAvatarCropFile(null);
  }, [open, user?.id]);

  useEffect(() => {
    if (!open) return;
    void refreshAvatarHistory().catch((error) => {
      console.error("Failed to load avatar history:", error);
    });
  }, [open, activeAvatarCache, refreshAvatarHistory]);

  useEffect(() => {
    if (!open) return;
    void refreshBackgroundHistory().catch((error) => {
      console.error("Failed to load background history:", error);
    });
  }, [open, customBackground, refreshBackgroundHistory]);

  useEffect(() => {
    if (recordingField) {
      pauseShortcuts();
    } else {
      resumeShortcuts();
    }
  }, [recordingField]);

  useEffect(() => {
    if (!open) return;

    let active = true;
    getNotesDirectory()
      .then((path) => {
        if (active) setDataDirectory(path);
      })
      .catch((error) => {
        console.error("Failed to resolve data directory:", error);
      });
    getImageTrashRootDirectory()
      .then((path) => {
        if (active) setImageCacheDirectory(path);
      })
      .catch((error) => {
        console.error("Failed to resolve image cache directory:", error);
      });

    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (avatarCropFile) {
        if (!avatarBusy) setAvatarCropFile(null);
        return;
      }
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, avatarBusy, avatarCropFile]);

  useEffect(() => {
    if (!dropdownOpen) return;

    const handler = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!autoSaveDropdownOpen) return;

    const handler = (event: MouseEvent) => {
      if (autoSaveDropdownRef.current && !autoSaveDropdownRef.current.contains(event.target as Node)) {
        setAutoSaveDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [autoSaveDropdownOpen]);

  useEffect(() => {
    if (!trashDropdownOpen) return;

    const handler = (event: MouseEvent) => {
      if (trashDropdownRef.current && !trashDropdownRef.current.contains(event.target as Node)) {
        setTrashDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [trashDropdownOpen]);

  const handleShortcutKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLInputElement>,
    field: keyof AppShortcuts,
  ) => {
    event.preventDefault();
    const parts: string[] = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");

    const key = event.key;
    if (!["Control", "Alt", "Shift", "Meta"].includes(key)) {
      parts.push(key.length === 1 ? key.toUpperCase() : key);
      setShortcuts({ ...shortcuts, [field]: parts.join("+") });
      setRecordingField(null);
    }
  }, [shortcuts, setShortcuts]);

  const handleSaveNickname = async () => {
    const nickname = nicknameDraft.trim();
    if (!nickname) {
      setPersonalValidation(t(lang, "personalNicknamePlaceholder"));
      return;
    }
    setPersonalValidation(null);
    setPersonalNotice(null);
    clearError();
    setPersonalAction("nickname");
    try {
      if (await updateProfile({ displayName: nickname })) {
        setNicknameDraft(nickname);
        setNicknameEditing(false);
        setPersonalNotice(t(lang, "personalProfileUpdated"));
      }
    } finally {
      setPersonalAction(null);
    }
  };

  const handleAvatarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!getUploadImageExtension(file)) {
      setPersonalValidation(t(lang, "avatarCropLoadFailed"));
      return;
    }
    setPersonalNotice(null);
    setPersonalValidation(null);
    setAvatarCropFile(file);
  };

  const handleAvatarCropConfirm = async (avatarUrl: string) => {
    setAvatarBusy(true);
    setPersonalNotice(null);
    setPersonalValidation(null);
    clearError();
    try {
      const avatarCache = user ? await saveAvatarCache(user.id, avatarUrl) : null;
      if (await updateProfile({ avatarUrl, avatarCache })) {
        setPersonalNotice(t(lang, "personalAvatarUpdated"));
        setAvatarCropFile(null);
      }
      await refreshAvatarHistory();
    } catch (error) {
      console.error("Failed to update avatar:", error);
      setPersonalValidation(t(lang, "personalChooseImage"));
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleUpdatePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword.length < 6) {
      setPersonalValidation(t(lang, "authPasswordTooShort"));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPersonalValidation(t(lang, "personalPasswordMismatch"));
      return;
    }
    setPersonalValidation(null);
    setPersonalNotice(null);
    clearError();
    setPersonalAction("password");
    try {
      if (await updatePassword(newPassword)) {
        setNewPassword("");
        setConfirmNewPassword("");
        setPasswordOpen(false);
        setPersonalNotice(t(lang, "personalPasswordUpdated"));
      }
    } finally {
      setPersonalAction(null);
    }
  };

  const handleSignOut = async () => {
    clearError();
    setPersonalAction("signOut");
    try {
      await signOut();
    } finally {
      setPersonalAction(null);
    }
  };

  if (!open) return null;

  const metadata = user?.user_metadata as Record<string, unknown> | undefined;
  const avatarUrl = typeof metadata?.avatar_url === "string" ? metadata.avatar_url : null;
  const displayName = typeof metadata?.display_name === "string" && metadata.display_name.trim()
    ? metadata.display_name.trim()
    : user?.email?.split("@")[0] || t(lang, "personal");
  const initials = displayName.slice(0, 2).toUpperCase();

  const themes: {
    value: ThemeType;
    labelKey: "darkTheme" | "blueTheme" | "yellowTheme" | "greenTheme";
    preview: string;
    accent: string;
  }[] = [
    { value: "dark", labelKey: "darkTheme", preview: "#1a1b1e", accent: "#5c7cfa" },
    { value: "blue", labelKey: "blueTheme", preview: "#f0f4f8", accent: "#2563eb" },
    { value: "yellow", labelKey: "yellowTheme", preview: THEME_COLORS.yellow.bgPrimary, accent: THEME_COLORS.yellow.accent },
    { value: "green", labelKey: "greenTheme", preview: THEME_COLORS.green.bgPrimary, accent: THEME_COLORS.green.accent },
  ];

  const langs: { value: LangType; labelKey: "chinese" | "english" }[] = [
    { value: "zh", labelKey: "chinese" },
    { value: "en", labelKey: "english" },
  ];

  const autoSaveOptions: {
    value: AutoSaveInterval;
    labelKey: "autoSaveOff" | "autoSave10s" | "autoSave30s" | "autoSave1m";
  }[] = [
    { value: 0, labelKey: "autoSaveOff" },
    { value: 10000, labelKey: "autoSave10s" },
    { value: 30000, labelKey: "autoSave30s" },
    { value: 60000, labelKey: "autoSave1m" },
  ];

  const selectedAutoSaveOption = autoSaveOptions.find(
    (option) => option.value === autoSaveInterval,
  ) ?? autoSaveOptions[0];

  const trashRetentionOptions: {
    value: number;
    labelKey:
      | "trashRetentionDisabled"
      | "trashRetention7Days"
      | "trashRetention30Days"
      | "trashRetention90Days"
      | "trashRetentionForever";
  }[] = [
    { value: TRASH_RETENTION_DISABLED, labelKey: "trashRetentionDisabled" },
    { value: 7, labelKey: "trashRetention7Days" },
    { value: 30, labelKey: "trashRetention30Days" },
    { value: 90, labelKey: "trashRetention90Days" },
    { value: TRASH_RETENTION_FOREVER, labelKey: "trashRetentionForever" },
  ];

  const selectedTrashRetentionOption = trashRetentionOptions.find(
    (option) => option.value === trashRetentionDays,
  ) ?? trashRetentionOptions[2];
  const cc: CustomColors = customColors || THEME_COLORS.blue;

  const colorFields: {
    key: keyof CustomColors;
    labelKey: "bgPrimary" | "bgSecondary" | "bgSidebar" | "textPrimary" | "accentColor";
  }[] = [
    { key: "bgPrimary", labelKey: "bgPrimary" },
    { key: "bgSecondary", labelKey: "bgSecondary" },
    { key: "bgSidebar", labelKey: "bgSidebar" },
    { key: "textPrimary", labelKey: "textPrimary" },
    { key: "accent", labelKey: "accentColor" },
  ];

  const sections = [
    { id: "basic" as const, label: t(lang, "settingsBasic"), icon: SlidersHorizontal },
    { id: "theme" as const, label: t(lang, "settingsTheme"), icon: Palette },
    { id: "language" as const, label: t(lang, "language"), icon: Globe },
    { id: "storage" as const, label: t(lang, "settingsStorage"), icon: HardDrive },
    { id: "ai" as const, label: t(lang, "aiSettings"), icon: Sparkles },
    { id: "personal" as const, label: t(lang, "personal"), icon: UserRound },
  ];

  const sectionTitle = sections.find((section) => section.id === activeSection)?.label;

  const handleSectionChange = (section: SettingsSection) => {
    setActiveSection(section);
    setDropdownOpen(false);
    setAutoSaveDropdownOpen(false);
    setTrashDropdownOpen(false);
    setRecordingField(null);
  };

  const handleCustomChange = (key: keyof CustomColors, value: string) => {
    setCustomColors({ ...cc, [key]: value });
  };

  const handleBackgroundChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const extension = getUploadImageExtension(file);
    if (!extension) {
      setBackgroundError(t(lang, "backgroundUploadFailed"));
      return;
    }

    setBackgroundBusy(true);
    setBackgroundError(null);
    try {
      const filename = await saveCustomBackground(
        new Uint8Array(await file.arrayBuffer()),
        extension,
      );
      setCustomBackground(filename);
      await refreshBackgroundHistory();
    } catch (error) {
      console.error("Failed to upload custom background:", error);
      setBackgroundError(t(lang, "backgroundUploadFailed"));
    } finally {
      setBackgroundBusy(false);
    }
  };

  const handleUseAvatarHistory = async (filename: string) => {
    if (!user || filename === activeAvatarCache) return;
    setAvatarBusy(true);
    setPersonalNotice(null);
    setPersonalValidation(null);
    clearError();
    try {
      const avatarUrl = await loadAvatarCacheDataUrl(filename, user.id);
      if (await updateProfile({ avatarUrl, avatarCache: filename })) {
        setPersonalNotice(t(lang, "personalAvatarUpdated"));
      }
    } catch (error) {
      console.error("Failed to use avatar history:", error);
      setPersonalValidation(t(lang, "personalChooseImage"));
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleDeleteAvatarHistory = async (filename: string) => {
    if (!user || filename === activeAvatarCache) return;
    try {
      await deleteAvatarCache(filename, user.id);
      setAvatarHistory((items) => items.filter((item) => item.filename !== filename));
    } catch (error) {
      console.error("Failed to delete avatar history:", error);
    }
  };

  const handleDeleteBackgroundHistory = async (filename: string) => {
    if (filename === customBackground) return;
    try {
      await deleteCustomBackground(filename);
      setBackgroundHistory((items) => items.filter((item) => item.filename !== filename));
    } catch (error) {
      console.error("Failed to delete background history:", error);
    }
  };

  // Both buttons go through the backend: the opener permission list can only
  // name build-time paths, while the data directory can be moved anywhere.
  // `open_data_path` verifies the folder really is inside that directory.
  const handleOpenDataDirectory = async () => {
    try {
      const path = dataDirectory ?? await getNotesDirectory();
      setDataDirectory(path);
      await invoke("open_data_path", { path });
    } catch (error) {
      console.error("Failed to open data directory:", error);
    }
  };

  const handleOpenImageCacheDirectory = async () => {
    try {
      const path = imageCacheDirectory ?? await getImageTrashRootDirectory();
      setImageCacheDirectory(path);
      await invoke("open_data_path", { path });
    } catch (error) {
      console.error("Failed to open image cache directory:", error);
    }
  };

  const handleSavePreset = () => {
    if (savedPresets.length >= 5) return;
    const name = prompt(
      t(lang, "presetName"),
      `${t(lang, "customTheme")} ${savedPresets.length + 1}`,
    );
    if (name) savePreset(name);
  };

  const handleLoadPreset = (index: number) => {
    loadPreset(index);
    setDropdownOpen(false);
  };

  const backgroundPreviewUrl = customBackground
    ? backgroundHistory.find((item) => item.filename === customBackground)?.url ?? null
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="app-modal-backdrop absolute inset-0" onClick={onClose} />

      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="isolate surface-glass surface-glass--dialog relative flex h-[min(680px,calc(100vh-32px))] w-[min(900px,calc(100vw-32px))] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-bg-primary shadow-2xl"
      >
        <header className="flex flex-shrink-0 items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
            <Settings size={16} />
          </span>
          <h1 id="settings-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
            {t(lang, "settingsTitle")}
          </h1>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(lang, "close")}
            title={t(lang, "close")}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={15} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-36 flex-shrink-0 border-r border-border bg-bg-sidebar/55 p-3 sm:w-48">
            <nav aria-label={t(lang, "settingsTitle")} className="space-y-1">
              {sections.map(({ id, label, icon: Icon }) => {
                const selected = activeSection === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handleSectionChange(id)}
                    aria-current={selected ? "page" : undefined}
                    className={`group relative flex w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-accent
                      ${selected
                        ? "flat-active-row font-medium text-text-primary"
                        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
                  >
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-r-full bg-accent"
                      />
                    )}
                    <Icon
                      size={14}
                      className={`flex-shrink-0 transition-colors ${selected ? "text-accent-text" : "text-text-muted group-hover:text-accent-text"}`}
                    />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl p-5 sm:p-7">
              <h2 className="mb-4 text-[15px] font-semibold text-text-primary">{sectionTitle}</h2>

              {activeSection === "ai" && (
                <PanelErrorBoundary lang={lang}>
                  <AiSettingsPanel />
                </PanelErrorBoundary>
              )}

              {activeSection === "basic" && (
                <div className="overflow-visible rounded-xl border border-border bg-bg-secondary/40">
                  <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
                        <Clock size={16} />
                      </div>
                      <span className="truncate text-sm font-medium text-text-primary">
                        {t(lang, "autoSaveSection")}
                      </span>
                    </div>

                    <div className="relative" ref={autoSaveDropdownRef}>
                      <button
                        type="button"
                        onClick={() => setAutoSaveDropdownOpen(!autoSaveDropdownOpen)}
                        aria-expanded={autoSaveDropdownOpen}
                        className="flex w-full items-center justify-between gap-2 h-8 rounded-lg border border-border bg-bg-primary px-2.5 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-hover"
                      >
                        <span className="truncate">{t(lang, selectedAutoSaveOption.labelKey)}</span>
                        <ChevronDown
                          size={14}
                          className={`flex-shrink-0 transition-transform ${autoSaveDropdownOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      {autoSaveDropdownOpen && (
                        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-bg-primary shadow-lg">
                          {autoSaveOptions.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                setAutoSaveInterval(option.value);
                                setAutoSaveDropdownOpen(false);
                              }}
                              className={`w-full px-2.5 py-1.5 text-left text-[13px] transition-colors
                                ${autoSaveInterval === option.value
                                  ? "bg-accent-light text-accent-text"
                                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
                            >
                              {t(lang, option.labelKey)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
                        <Trash2 size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-text-primary">
                          {t(lang, "trashRetention")}
                        </div>
                        <div className="truncate text-xs text-text-muted">
                          {t(lang, "trashHint")}
                        </div>
                      </div>
                    </div>

                    <div className="relative" ref={trashDropdownRef}>
                      <button
                        type="button"
                        onClick={() => setTrashDropdownOpen(!trashDropdownOpen)}
                        aria-expanded={trashDropdownOpen}
                        className="flex w-full items-center justify-between gap-2 h-8 rounded-lg border border-border bg-bg-primary px-2.5 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-hover"
                      >
                        <span className="truncate">{t(lang, selectedTrashRetentionOption.labelKey)}</span>
                        <ChevronDown
                          size={14}
                          className={`flex-shrink-0 transition-transform ${trashDropdownOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      {trashDropdownOpen && (
                        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-bg-primary shadow-lg">
                          {trashRetentionOptions.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                setTrashRetentionDays(option.value);
                                setTrashDropdownOpen(false);
                              }}
                              className={`w-full px-2.5 py-1.5 text-left text-[13px] transition-colors
                                ${trashRetentionDays === option.value
                                  ? "bg-accent-light text-accent-text"
                                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
                            >
                              {t(lang, option.labelKey)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
                        <Keyboard size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-text-primary">
                          {t(lang, "shortcutsSection")}
                        </div>
                        <div className="truncate text-xs text-text-muted">
                          {t(lang, "shortcutToggleWindow")}
                        </div>
                      </div>
                    </div>

                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={recordingField === "toggleWindow" ? t(lang, "pressShortcut") : shortcuts.toggleWindow}
                        onFocus={() => setRecordingField("toggleWindow")}
                        onBlur={() => setRecordingField(null)}
                        onKeyDown={(event) => handleShortcutKeyDown(event, "toggleWindow")}
                        className={`min-w-0 flex-1 rounded-lg border bg-bg-primary px-3 py-2 text-center font-mono text-xs outline-none transition-colors cursor-pointer
                          ${recordingField === "toggleWindow"
                            ? "border-accent bg-accent-light text-accent-text"
                            : "border-border text-text-primary hover:border-text-muted"}`}
                      />
                      <button
                        type="button"
                        onClick={() => setShortcuts(DEFAULT_SHORTCUTS)}
                        aria-label={t(lang, "resetShortcuts")}
                        title={t(lang, "resetShortcuts")}
                        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-bg-primary text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
                        <Eye size={16} />
                      </div>
                      <span className="truncate text-sm font-medium text-text-primary">
                        {t(lang, "stickyOpacity")}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <div className="mb-1 flex justify-end text-xs font-medium tabular-nums text-accent-text">
                        {stickyOpacity}%
                      </div>
                      <input
                        type="range"
                        min={MIN_STICKY_OPACITY}
                        max={MAX_STICKY_OPACITY}
                        step={1}
                        value={stickyOpacity}
                        onChange={(event) => setStickyOpacity(Number(event.target.value))}
                        aria-label={t(lang, "stickyOpacity")}
                        className="block h-2 w-full cursor-pointer accent-accent"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
                        <FolderOpen size={16} />
                      </div>
                      <span className="truncate text-sm font-medium text-text-primary">
                        {t(lang, "dataLocation")}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={handleOpenDataDirectory}
                      title={dataDirectory ?? undefined}
                      className="flex w-full items-center justify-center gap-2 h-8 rounded-lg border border-border bg-bg-primary px-2.5 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-hover"
                    >
                      <span className="truncate">{t(lang, "openDataFolder")}</span>
                      <FolderOpen size={14} className="flex-shrink-0 text-accent-text" />
                    </button>
                  </div>

                  <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] sm:items-center">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
                        <Trash2 size={16} />
                      </div>
                      <span className="truncate text-sm font-medium text-text-primary">
                        {t(lang, "imageCache")}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={handleOpenImageCacheDirectory}
                      title={imageCacheDirectory ?? undefined}
                      className="flex w-full items-center justify-center gap-2 h-8 rounded-lg border border-border bg-bg-primary px-2.5 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-hover"
                    >
                      <span className="truncate">{t(lang, "openImageCache")}</span>
                      <FolderOpen size={14} className="flex-shrink-0 text-accent-text" />
                    </button>
                  </div>
                </div>
              )}

              {activeSection === "theme" && (
                <div className="space-y-5">
                  <section>
                    <div className="mb-3 flex items-center gap-2">
                      <Palette size={16} className="text-accent-text" />
                      <h3 className="text-sm font-medium text-text-primary">{t(lang, "themeColor")}</h3>
                    </div>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      {themes.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setTheme(item.value)}
                          className={`flex min-w-0 items-center gap-3 rounded-xl border-2 p-3 text-left transition-all cursor-pointer
                            ${theme === item.value
                              ? "border-accent bg-accent-light"
                              : "border-border bg-bg-secondary/40 hover:border-text-muted hover:bg-bg-hover"}`}
                        >
                          <div className="relative h-9 w-9 flex-shrink-0 overflow-hidden rounded-lg border border-border shadow-sm">
                            <div className="absolute inset-0" style={{ backgroundColor: item.preview }} />
                            <div className="absolute inset-x-0 bottom-0 h-2" style={{ backgroundColor: item.accent }} />
                          </div>
                          <span className="min-w-0 truncate text-xs font-medium text-text-secondary">
                            {t(lang, item.labelKey)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-xl border border-border bg-bg-secondary/40 p-4">
                    <div className="mb-4 flex items-center gap-2">
                      <Droplets size={16} className="text-accent-text" />
                      <h3 className="text-sm font-medium text-text-primary">{t(lang, "customPalette")}</h3>
                      {theme === "custom" && (
                        <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-on-accent">
                          {t(lang, "customTheme")}
                        </span>
                      )}
                    </div>

                    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                      {colorFields.map(({ key, labelKey }) => (
                        <label
                          key={key}
                          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-transparent p-2 transition-colors hover:border-border hover:bg-bg-hover"
                        >
                          <div className="relative flex-shrink-0">
                            <div
                              className="h-9 w-9 rounded-lg border border-border shadow-sm"
                              style={{ backgroundColor: cc[key] }}
                            />
                            <input
                              type="color"
                              value={cc[key]}
                              onChange={(event) => handleCustomChange(key, event.target.value)}
                              aria-label={t(lang, labelKey)}
                              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                            />
                          </div>
                          <span className="min-w-0 truncate text-[11px] text-text-muted">
                            {t(lang, labelKey)}
                          </span>
                        </label>
                      ))}
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={handleSavePreset}
                        disabled={savedPresets.length >= 5}
                        className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                      >
                        <Save size={13} className="flex-shrink-0" />
                        <span className="truncate">
                          {savedPresets.length >= 5 ? t(lang, "presetFull") : t(lang, "savePreset")}
                        </span>
                      </button>

                      <div className="relative min-w-0 flex-1" ref={dropdownRef}>
                        <button
                          type="button"
                          onClick={() => setDropdownOpen(!dropdownOpen)}
                          aria-expanded={dropdownOpen}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
                        >
                          <span className="truncate">{t(lang, "selectPreset")}</span>
                          {savedPresets.length > 0 && (
                            <span className="rounded-full bg-accent-light px-1.5 py-0.5 text-[11px] font-semibold text-accent-text">
                              {savedPresets.length}
                            </span>
                          )}
                          <ChevronDown
                            size={13}
                            className={`flex-shrink-0 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
                          />
                        </button>

                        {dropdownOpen && (
                          <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-bg-primary shadow-lg">
                            {savedPresets.length === 0 ? (
                              <div className="px-3 py-4 text-center text-xs text-text-muted">
                                {t(lang, "noPresets")}
                              </div>
                            ) : (
                              savedPresets.map((preset, index) => (
                                <div
                                  key={`${preset.name}-${index}`}
                                  className="flex items-center gap-2 border-b border-border px-3 py-2 transition-colors last:border-b-0 hover:bg-bg-hover"
                                >
                                  <div className="flex flex-shrink-0 gap-0.5">
                                    {[preset.colors.bgPrimary, preset.colors.bgSecondary, preset.colors.accent].map((color, colorIndex) => (
                                      <div
                                        key={`${color}-${colorIndex}`}
                                        className="h-3.5 w-3.5 rounded-full border border-border"
                                        style={{ backgroundColor: color }}
                                      />
                                    ))}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleLoadPreset(index)}
                                    className="min-w-0 flex-1 truncate text-left text-xs text-text-primary transition-colors hover:text-accent-text cursor-pointer"
                                  >
                                    {preset.name}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => deletePreset(index)}
                                    aria-label={`${t(lang, "deletePreset")} ${preset.name}`}
                                    className="flex-shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-danger cursor-pointer"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-border bg-bg-secondary/40 p-4">
                    <div className="mb-4 flex items-start gap-2">
                      <ImagePlus size={16} className="mt-0.5 flex-shrink-0 text-accent-text" />
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium text-text-primary">{t(lang, "customBackground")}</h3>
                        <p className="mt-1 text-xs leading-relaxed text-text-muted">{t(lang, "customBackgroundHint")}</p>
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-[minmax(180px,1fr)_minmax(190px,0.75fr)] sm:items-stretch">
                      <div className="relative h-28 overflow-hidden rounded-xl border border-border bg-bg-primary">
                        {backgroundPreviewUrl ? (
                          <img src={backgroundPreviewUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-text-muted">
                            <ImagePlus size={28} strokeWidth={1.4} />
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col justify-center gap-2">
                        <label className={`flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover ${backgroundBusy ? "cursor-wait opacity-60" : "cursor-pointer"}`}>
                          <ImagePlus size={14} />
                          {backgroundBusy
                            ? <LoadingText label={t(lang, "personalSaving")} variant="bounce" />
                            : <span>{t(lang, customBackground ? "replaceBackground" : "chooseBackground")}</span>}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            onChange={handleBackgroundChange}
                            disabled={backgroundBusy}
                            className="sr-only"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => setCustomBackground(null)}
                          disabled={!customBackground || backgroundBusy}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                        >
                          <X size={14} />
                          {t(lang, "removeBackground")}
                        </button>
                        {backgroundError && (
                          <p className="text-xs text-danger">{backgroundError}</p>
                        )}
                      </div>
                    </div>

                    {backgroundHistory.length > 0 && (
                      <div className="mt-4 border-t border-border pt-4">
                        <p className="mb-2 text-xs font-medium text-text-secondary">{t(lang, "backgroundHistory")}</p>
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                          {backgroundHistory.map((item) => {
                            const active = item.filename === customBackground;
                            return (
                              <div key={item.filename} className="group relative min-w-0">
                                <button
                                  type="button"
                                  onClick={() => setCustomBackground(item.filename)}
                                  title={t(lang, "useHistoryBackground")}
                                  className={`aspect-[4/3] w-full overflow-hidden rounded-lg border-2 transition-colors cursor-pointer ${active ? "border-accent" : "border-border hover:border-accent/55"}`}
                                >
                                  <img src={item.url} alt="" className="h-full w-full object-cover" />
                                </button>
                                {!active && (
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteBackgroundHistory(item.filename)}
                                    title={t(lang, "deleteHistoryImage")}
                                    aria-label={t(lang, "deleteHistoryImage")}
                                    className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-bg-primary text-text-muted opacity-0 shadow-sm transition-opacity hover:text-danger group-hover:opacity-100 cursor-pointer"
                                  >
                                    <X size={11} />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </section>

                  <section className="rounded-xl border border-border bg-bg-secondary/40 p-4">
                    <div className="mb-4 flex items-start gap-2">
                      <SlidersHorizontal size={16} className="mt-0.5 flex-shrink-0 text-accent-text" />
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium text-text-primary">{t(lang, "glassGroup")}</h3>
                        <p className="mt-1 text-xs leading-relaxed text-text-muted">{t(lang, "glassGroupHint")}</p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-primary px-3 py-2.5">
                      <span className="truncate text-xs font-medium text-text-primary">
                        {t(lang, "glassEnable")}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={glassEnabled}
                        aria-label={t(lang, "glassEnable")}
                        onClick={() => setGlassEnabled(!glassEnabled)}
                        className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors cursor-pointer ${
                          glassEnabled ? "bg-accent" : "bg-bg-active"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-[left] duration-150 ${
                            glassEnabled ? "left-[1.125rem]" : "left-0.5"
                          }`}
                        />
                      </button>
                    </div>

                    {reducedTransparency ? (
                      <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-text-primary">
                        {t(lang, "glassReducedTransparency")}
                      </p>
                    ) : null}

                    <div className={`mt-4 space-y-3 transition-opacity ${glassEnabled ? "" : "opacity-50"}`}>
                      <p className="text-xs font-semibold text-text-secondary">{t(lang, "glassBaseGroup")}</p>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <GlassSlider
                          label={t(lang, "glassBlur")}
                          value={glassBlur}
                          min={MIN_GLASS_BLUR}
                          max={MAX_GLASS_BLUR}
                          unit="px"
                          disabled={!glassEnabled || reducedTransparency || hasWallpaper}
                          hint={
                            hasWallpaper
                              ? t(lang, "glassBaseOverridden")
                              : glassTint > 60
                                ? t(lang, "glassBlurNeedsLowerTint")
                                : undefined
                          }
                          onChange={setGlassBlur}
                        />
                        <GlassSlider
                          label={t(lang, "glassTint")}
                          value={glassTint}
                          min={MIN_GLASS_TINT}
                          max={MAX_GLASS_TINT}
                          unit="%"
                          disabled={!glassEnabled || reducedTransparency || hasWallpaper}
                          hint={hasWallpaper ? t(lang, "glassBaseOverridden") : undefined}
                          onChange={setGlassTint}
                        />
                        <GlassSlider
                          label={t(lang, "glassSaturate")}
                          value={glassSaturate}
                          min={MIN_GLASS_SATURATE}
                          max={MAX_GLASS_SATURATE}
                          unit="%"
                          disabled={!glassEnabled || reducedTransparency || hasWallpaper}
                          hint={hasWallpaper ? t(lang, "glassBaseOverridden") : undefined}
                          onChange={setGlassSaturate}
                        />
                      </div>
                    </div>

                    <div className={`mt-4 space-y-3 border-t border-border pt-4 transition-opacity ${glassEnabled ? "" : "opacity-50"}`}>
                      <p className="text-xs font-semibold text-text-secondary">{t(lang, "glassBgGroup")}</p>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <GlassSlider
                          label={t(lang, "glassBlur")}
                          value={glassBlurBg}
                          min={MIN_GLASS_BLUR}
                          max={MAX_GLASS_BLUR}
                          unit="px"
                          disabled={!glassEnabled || reducedTransparency || !hasWallpaper}
                          hint={
                            !hasWallpaper
                              ? t(lang, "glassNeedsBackground")
                              : glassTintBg > 60
                                ? t(lang, "glassBlurNeedsLowerTint")
                                : undefined
                          }
                          onChange={setGlassBlurBg}
                        />
                        <GlassSlider
                          label={t(lang, "glassTint")}
                          value={glassTintBg}
                          min={MIN_GLASS_TINT}
                          max={MAX_GLASS_TINT}
                          unit="%"
                          disabled={!glassEnabled || reducedTransparency || !hasWallpaper}
                          hint={!hasWallpaper ? t(lang, "glassNeedsBackground") : undefined}
                          onChange={setGlassTintBg}
                        />
                        <GlassSlider
                          label={t(lang, "glassSaturate")}
                          value={glassSaturateBg}
                          min={MIN_GLASS_SATURATE}
                          max={MAX_GLASS_SATURATE}
                          unit="%"
                          disabled={!glassEnabled || reducedTransparency || !hasWallpaper}
                          hint={!hasWallpaper ? t(lang, "glassNeedsBackground") : undefined}
                          onChange={setGlassSaturateBg}
                        />
                      </div>
                    </div>
                  </section>
                </div>
              )}

              {activeSection === "language" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {langs.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setLang(item.value)}
                      className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all cursor-pointer
                        ${lang === item.value
                          ? "border-accent bg-accent-light text-accent-text"
                          : "border-border bg-bg-secondary/40 text-text-secondary hover:border-text-muted hover:bg-bg-hover"}`}
                    >
                      <Globe size={17} className="flex-shrink-0" />
                      <span className="truncate text-sm font-medium">{t(lang, item.labelKey)}</span>
                    </button>
                  ))}
                </div>
              )}

              {activeSection === "storage" && (
                <PanelErrorBoundary lang={lang}>
                  <StorageSection lang={lang} />
                </PanelErrorBoundary>
              )}

              {activeSection === "personal" && (
                <div className="space-y-4">
                  {!user ? (
                    <>
                      <section className="rounded-xl border border-border bg-bg-secondary/40 p-5">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-accent-light text-accent-text">
                              <UserRound size={21} />
                            </div>
                            <div className="min-w-0">
                              <h3 className="text-sm font-semibold text-text-primary">
                                {t(lang, "personalSignInTitle")}
                              </h3>
                              <p className="mt-1 max-w-xl text-xs leading-relaxed text-text-muted">
                                {t(lang, "personalSignInHint")}
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={onOpenAuth}
                            className="flex flex-shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover cursor-pointer"
                          >
                            <LogIn size={15} />
                            {t(lang, "personalOpenSignIn")}
                          </button>
                        </div>
                        {!isSupabaseConfigured && (
                          <p className="mt-4 rounded-lg bg-bg-primary/70 px-3 py-2 text-xs leading-relaxed text-text-muted">
                            {t(lang, "personalNotConfigured")}
                          </p>
                        )}
                      </section>

                      <section className="rounded-xl border border-border bg-bg-secondary/20 p-4">
                        <div className="flex items-start gap-3">
                          <ShieldCheck size={17} className="mt-0.5 flex-shrink-0 text-accent-text" />
                          <div>
                            <h3 className="text-sm font-medium text-text-primary">{t(lang, "personalSecurity")}</h3>
                            <p className="mt-1 text-xs leading-relaxed text-text-muted">
                              {t(lang, "personalDataHint")}
                            </p>
                          </div>
                        </div>
                      </section>
                    </>
                  ) : (
                    <>
                      <section className="rounded-xl border border-border bg-bg-secondary/40 p-5">
                        <div className="flex items-center gap-4">
                          <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-full bg-accent-light text-accent-text">
                            {avatarUrl ? (
                              <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-lg font-semibold">
                                {initials}
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="truncate text-base font-semibold text-text-primary">{displayName}</h3>
                              <span className="rounded-full bg-accent-light px-2 py-0.5 text-[11px] font-semibold text-accent-text">
                                {t(lang, "personalSignedIn")}
                              </span>
                            </div>
                            <p className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs text-text-muted">
                              <Mail size={13} className="flex-shrink-0" />
                              <span className="truncate">{user.email}</span>
                            </p>
                          </div>
                        </div>
                      </section>

                      <section className="overflow-hidden rounded-xl border border-border bg-bg-secondary/40">
                        <div className="flex items-center gap-2 p-4">
                          <UserRound size={16} className="text-accent-text" />
                          <h3 className="text-sm font-medium text-text-primary">{t(lang, "personalProfile")}</h3>
                        </div>

                        <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(200px,240px)] sm:items-center">
                          <div>
                            <p className="text-sm font-medium text-text-primary">{t(lang, "personalNickname")}</p>
                            <p className="mt-1 text-xs text-text-muted">{t(lang, "personalDataHint")}</p>
                          </div>
                          {nicknameEditing ? (
                            <div className="flex min-w-0 items-center gap-2">
                              <input
                                type="text"
                                value={nicknameDraft}
                                onChange={(event) => setNicknameDraft(event.target.value)}
                                autoFocus
                                maxLength={32}
                                placeholder={t(lang, "personalNicknamePlaceholder")}
                                className="min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                              />
                              <button
                                type="button"
                                onClick={handleSaveNickname}
                                disabled={authLoading || personalAction !== null}
                                aria-busy={personalAction === "nickname"}
                                aria-label={t(lang, "personalSaveNickname")}
                                title={t(lang, "personalSaveNickname")}
                                className="flex h-9 min-w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent px-2 text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                              >
                                {personalAction === "nickname"
                                  ? <LoadingText label={t(lang, "personalSaving")} className="text-[10px]" variant="bounce" />
                                  : <Check size={15} />}
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setNicknameDraft(displayName);
                                setNicknameEditing(true);
                                setPersonalNotice(null);
                              }}
                              className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-bg-hover cursor-pointer"
                            >
                              <span className="truncate">{displayName}</span>
                              <Pencil size={14} className="flex-shrink-0 text-accent-text" />
                            </button>
                          )}
                        </div>

                        <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(200px,240px)] sm:items-center">
                          <div>
                            <p className="text-sm font-medium text-text-primary">{t(lang, "personalChangeAvatar")}</p>
                            <p className="mt-1 text-xs text-text-muted">{t(lang, "personalAvatarHint")}</p>
                          </div>
                          <label className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover">
                            <Camera size={14} className="text-accent-text" />
                            {avatarBusy
                              ? <LoadingText label={t(lang, "personalSaving")} variant="bounce" />
                              : <span>{t(lang, "personalChooseImage")}</span>}
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              onChange={handleAvatarChange}
                              disabled={avatarBusy || authLoading}
                              className="sr-only"
                            />
                          </label>
                        </div>

                        {avatarHistory.length > 0 && (
                          <div className="border-t border-border p-4">
                            <p className="mb-3 text-xs font-medium text-text-secondary">{t(lang, "avatarHistory")}</p>
                            <div className="flex flex-wrap gap-3">
                              {avatarHistory.map((item) => {
                                const active = item.filename === activeAvatarCache;
                                return (
                                  <div key={item.filename} className="group relative">
                                    <button
                                      type="button"
                                      onClick={() => void handleUseAvatarHistory(item.filename)}
                                      disabled={active || avatarBusy || authLoading}
                                      title={t(lang, "useHistoryAvatar")}
                                      className={`h-12 w-12 overflow-hidden rounded-full border-2 transition-colors ${active ? "border-accent" : "border-border hover:border-accent/55 cursor-pointer"}`}
                                    >
                                      <img src={item.url} alt="" className="h-full w-full object-cover" />
                                    </button>
                                    {!active && (
                                      <button
                                        type="button"
                                        onClick={() => void handleDeleteAvatarHistory(item.filename)}
                                        title={t(lang, "deleteHistoryImage")}
                                        aria-label={t(lang, "deleteHistoryImage")}
                                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-bg-primary text-text-muted opacity-0 shadow-sm transition-opacity hover:text-danger group-hover:opacity-100 cursor-pointer"
                                      >
                                        <X size={11} />
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </section>

                      <section className="overflow-hidden rounded-xl border border-border bg-bg-secondary/40">
                        {!passwordOpen ? (
                          <button
                            type="button"
                            onClick={() => {
                              setPasswordOpen(true);
                              setPersonalNotice(null);
                              setPersonalValidation(null);
                            }}
                            className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover cursor-pointer"
                          >
                            <span className="flex items-center gap-2">
                              <KeyRound size={16} className="text-accent-text" />
                              <span>{t(lang, "personalChangePassword")}</span>
                            </span>
                            <Pencil size={14} className="text-accent-text" />
                          </button>
                        ) : (
                          <div className="p-4">
                            <div className="mb-3 flex items-center gap-2">
                              <KeyRound size={16} className="text-accent-text" />
                              <h3 className="text-sm font-medium text-text-primary">{t(lang, "personalSecurity")}</h3>
                            </div>
                            <form className="space-y-3" onSubmit={handleUpdatePassword}>
                              <label className="block">
                                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                                  {t(lang, "personalNewPassword")}
                                </span>
                                <input
                                  type="password"
                                  value={newPassword}
                                  onChange={(event) => setNewPassword(event.target.value)}
                                  autoComplete="new-password"
                                  minLength={6}
                                  required
                                  placeholder={t(lang, "authPasswordPlaceholder")}
                                  className="h-9 w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent"
                                />
                              </label>
                              <label className="block">
                                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                                  {t(lang, "personalConfirmPassword")}
                                </span>
                                <input
                                  type="password"
                                  value={confirmNewPassword}
                                  onChange={(event) => setConfirmNewPassword(event.target.value)}
                                  autoComplete="new-password"
                                  minLength={6}
                                  required
                                  placeholder={t(lang, "authPasswordPlaceholder")}
                                  className="h-9 w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent"
                                />
                              </label>
                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setPasswordOpen(false)}
                                  className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover cursor-pointer"
                                >
                                  {t(lang, "confirmNo")}
                                </button>
                                <button
                                  type="submit"
                                  disabled={authLoading || personalAction !== null}
                                  aria-busy={personalAction === "password"}
                                  className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                                >
                                  {personalAction === "password"
                                    ? <LoadingText label={t(lang, "personalSaving")} variant="bounce" />
                                    : t(lang, "save")}
                                </button>
                              </div>
                            </form>
                          </div>
                        )}
                      </section>

                      {(personalNotice || personalValidation || authError) && (
                        <p className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${personalValidation || authError ? "bg-danger/10 text-danger" : "bg-accent-light text-accent-text"}`}>
                          {personalValidation || authError || personalNotice}
                        </p>
                      )}

                      <section className="rounded-xl border border-border bg-bg-secondary/20 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 items-start gap-3">
                            <LogOut size={17} className="mt-0.5 flex-shrink-0 text-text-muted" />
                            <p className="text-xs leading-relaxed text-text-muted">{t(lang, "personalSignOutHint")}</p>
                          </div>
                          <button
                            type="button"
                            onClick={handleSignOut}
                            disabled={authLoading || personalAction !== null}
                            aria-busy={personalAction === "signOut"}
                            className="flex flex-shrink-0 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-danger disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                          >
                            <LogOut size={14} />
                            {personalAction === "signOut"
                              ? <LoadingText label={t(lang, "personalSaving")} variant="bounce" />
                              : t(lang, "authSignOut")}
                          </button>
                        </div>
                      </section>
                    </>
                  )}
                </div>
              )}
            </div>
          </main>
        </div>
      </section>

      {avatarCropFile && (
        <AvatarCropper
          file={avatarCropFile}
          lang={lang}
          saving={avatarBusy}
          onCancel={() => setAvatarCropFile(null)}
          onConfirm={handleAvatarCropConfirm}
        />
      )}
    </div>
  );
};

export default SettingsModal;
