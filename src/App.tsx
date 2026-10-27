import { lazy, Suspense, useState, useEffect, useCallback, useRef, type CSSProperties } from "react";
import Sidebar from "@/components/Layout/Sidebar";
import ActivityBar from "@/components/Layout/ActivityBar";
import SidebarResizeHandle from "@/components/Layout/SidebarResizeHandle";
import {
  AI_SIDEBAR_WIDTH,
  SIDEBAR_MIN_WIDTH,
  isBelowRightSidebarCollapseThreshold,
  isBelowSidebarCollapseThreshold,
  resolveRightSidebarWidth,
  resolveSidebarWidth,
} from "@/components/Layout/sidebarLayout";
import {
  ACTIVITY_BAR_WIDTH,
  getShellMetrics,
  leftSidebarOffset,
  rightSidebarLimit,
} from "@/components/Layout/shellLayout";
import TitleBar from "@/components/Layout/TitleBar";
import NoteTabBar from "@/components/Layout/NoteTabBar";
import TodoView from "@/components/Todo/TodoView";
import TodoSidebar from "@/components/Todo/TodoSidebar";
import NoteEditor from "@/components/Editor/NoteEditor";
import CanvasView from "@/components/Canvas/CanvasView";
import AiSidebar from "@/components/AI/AiSidebar";
import PluginSidebar from "@/components/Plugin/PluginSidebar";
import PluginDetail from "@/components/Plugin/PluginDetail";
import CommandPalette from "@/components/Layout/CommandPalette";
import ToastHost from "@/components/ToastHost";
import PanelErrorBoundary from "@/components/PanelErrorBoundary";
import { usePluginStore } from "@/plugin/store";
import { activateStartupPlugins, deactivateAllPlugins } from "@/plugin/headless";
import { useAiStore } from "@/stores/aiStore";
import SettingsModal, { type SettingsSection } from "@/components/Settings/SettingsModal";
import AboutModal from "@/components/Settings/AboutModal";
import UpdateModal from "@/components/Settings/UpdateModal";
import AuthModal from "@/components/Auth/AuthModal";
import PasswordRecoveryModal from "@/components/Auth/PasswordRecoveryModal";
import WorkspaceRemovalNotifier from "@/components/Workspace/WorkspaceRemovalNotifier";
import LoadingText from "@/components/LoadingText";
import { useTodoStore } from "@/stores/todoStore";
import { useNoteStore } from "@/stores/noteStore";
import { useTabStore } from "@/stores/tabStore";
import { useFontStore } from "@/stores/fontStore";
import { useSettingsStore, deriveGlassEditorTint, GLASS_RAIL_DARKEN, GLASS_READABILITY_FLOOR } from "@/stores/settingsStore";
import { useAuthStore } from "@/stores/authStore";
import type { CustomColors, AppShortcuts, AutoSaveInterval } from "@/stores/settingsStore";
import {
  loadTodos,
  saveTodos,
  loadTodoLists,
  saveTodoLists,
  loadNoteList,
  saveNoteIndex,
  loadSavedFonts,
  saveFontList,
  saveNoteContent,
  loadNoteContent,
  loadSettings,
  saveSettings,
  loadIconData,
  getImageNeedDirectory,
  resolveCustomBackground,
  purgeExpiredNoteTrash,
  loadUiState,
  saveUiState,
  getStorageLocation,
  cleanupUnusedImageAttachments,
} from "@/utils/storage";
import { applyTheme, resolvedBackgroundHex } from "@/utils/theme";
import { noteIndexFingerprint } from "@/utils/noteIndexFingerprint";
import AppDialog from "@/components/AppDialog";
import { alertDialog } from "@/stores/dialogStore";
import { openTileWindow } from "@/utils/tile";
import { applyShortcuts } from "@/utils/shortcutManager";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import { APP_VERSION, fetchLatestRelease, isVersionNewer } from "@/utils/updateChecker";
import type { LatestRelease } from "@/utils/updateChecker";
import { renderStoredNoteContentForExport } from "@/utils/markdown";
import { PASSWORD_RECOVERY_REDIRECT_URL } from "@/utils/supabase";
import { t, tWithParams } from "@/utils/i18n";
import { flushActiveNote } from "@/utils/noteFlush";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import type { Todo, Note, ViewType } from "@/types";
import TurndownService from "turndown";

const COLLAPSED_WIDTH = 0;
const loadWorkspaceView = () => import("@/components/Workspace/WorkspaceView");
const loadWorkspaceSidebar = () => import("@/components/Workspace/WorkspaceSidebar");
const WorkspaceView = lazy(loadWorkspaceView);
const WorkspaceSidebar = lazy(loadWorkspaceSidebar);
type ResizableSidebar = "notebook" | "ai";
const handledPasswordRecoveryUrls = new Set<string>();

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isStoredEditorHtml(content: string): boolean {
  return /<\/?(p|h[1-6]|ul|ol|li|blockquote|pre|div|img|hr|br)\b[\s\S]*>/i.test(content);
}

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  bulletListMarker: "-",
  hr: "---",
});

turndownService.addRule("img", {
  filter: "img",
  replacement: (_content, node) => {
    const el = node as HTMLImageElement;
    const source = el.dataset.attachmentSrc || el.src;
    return `![${el.alt || "image"}](${source})`;
  },
});

function htmlToMarkdown(html: string): string {
  return turndownService
    .turndown(html)
    .replace(/\\([\\`*{}[\]()#+\-.!_>])/g, "$1");
}

/**
 * Off-screen sheet handed to WebView2's print engine. It lives outside `#root`
 * so the print stylesheet can hide the whole app and leave only the note.
 */
function mountPrintSheet(title: string, html: string): HTMLElement {
  const sheet = document.createElement("article");
  sheet.className = "print-sheet";

  const heading = document.createElement("h1");
  heading.className = "print-sheet-title";
  heading.textContent = title;
  sheet.appendChild(heading);

  const body = document.createElement("div");
  body.className = "print-sheet-body";
  body.innerHTML = html;
  sheet.appendChild(body);

  document.body.appendChild(sheet);
  document.body.classList.add("exporting-pdf");
  return sheet;
}

function unmountPrintSheet(sheet: HTMLElement): void {
  document.body.classList.remove("exporting-pdf");
  sheet.remove();
}

/** PrintToPdf captures the layout as it is now, so wait for paint and images. */
async function waitForPrintLayout(sheet: HTMLElement): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  try {
    await document.fonts.ready;
  } catch {
    // Font loading is best-effort; printing can proceed with fallbacks.
  }
  await Promise.all(
    Array.from(sheet.querySelectorAll("img")).map((image) =>
      image.decode ? image.decode().catch(() => undefined) : Promise.resolve(),
    ),
  );
}

export default function App() {
  const [currentView, setCurrentView] = useState<ViewType>("note");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Section the settings modal should land on; `openSettings` sets it. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("basic");
  const openSettings = (section: SettingsSection = "basic") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };
  const [aboutOpen, setAboutOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<LatestRelease | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_MIN_WIDTH);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(AI_SIDEBAR_WIDTH);
  // Mirrors resizingSidebar as state so the resize handle stays mounted while a
  // drag crosses the collapse threshold (see SIDEBAR_COLLAPSE_THRESHOLD).
  const [resizingSidebarState, setResizingSidebarState] = useState<ResizableSidebar | null>(null);
  // Collapsing must not snap the sidebar away in a single frame. The class is
  // raised in the same commit as the width flip, then dropped once the CSS
  // transition has finished so ordinary dragging stays instant.
  const [collapseAnimating, setCollapseAnimating] = useState(false);
  const [customBackgroundUrl, setCustomBackgroundUrl] = useState<string | null>(null);
  // Shell margin and gutter flip at a single breakpoint; keeping them in state
  // lets the inline CSS variables follow the window without a CSS-only path.
  const [shell, setShell] = useState(() => getShellMetrics(
    typeof document === "undefined" ? 1200 : document.documentElement.clientWidth,
  ));
  const appRootRef = useRef<HTMLDivElement>(null);
  const resizingSidebar = useRef<ResizableSidebar | null>(null);
  const collapseAnimTimer = useRef<number | null>(null);

  const todos = useTodoStore((s) => s.todos);
  const todoLists = useTodoStore((s) => s.lists);
  const activeTodoListId = useTodoStore((s) => s.activeListId);
  const loadTodoData = useTodoStore((s) => s.loadTodoData);

  const notes = useNoteStore((s) => s.notes);
  const categories = useNoteStore((s) => s.categories);
  const activeNoteId = useNoteStore((s) => s.activeNoteId);
  const activeCategoryId = useNoteStore((s) => s.activeCategoryId);
  const addNote = useNoteStore((s) => s.addNote);
  const loadNotesState = useNoteStore((s) => s.loadNotes);

  const tabs = useTabStore((s) => s.tabs);
  const tabsHydrated = useTabStore((s) => s.hydrated);
  const pruneMissingTabs = useTabStore((s) => s.pruneMissing);
  const restoreTabs = useTabStore((s) => s.restoreTabs);

  const fonts = useFontStore((s) => s.fonts);
  const loadFontsState = useFontStore((s) => s.loadFonts);

  const theme = useSettingsStore((s) => s.theme);
  const lang = useSettingsStore((s) => s.lang);
  const customColors = useSettingsStore((s) => s.customColors);
  const customBackground = useSettingsStore((s) => s.customBackground);
  const savedPresets = useSettingsStore((s) => s.savedPresets);
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const autoSaveInterval = useSettingsStore((s) => s.autoSaveInterval);
  const stickyOpacity = useSettingsStore((s) => s.stickyOpacity);
  const trashRetentionDays = useSettingsStore((s) => s.trashRetentionDays);
  const showWorkspaceHighlights = useSettingsStore((s) => s.showWorkspaceHighlights);
  const alwaysOnTop = useSettingsStore((s) => s.alwaysOnTop);
  const pluginsDisabled = useSettingsStore((s) => s.pluginsDisabled);
  const updateReminderDisabledForVersion = useSettingsStore((s) => s.updateReminderDisabledForVersion);
  const sidebarCategoryRatio = useSettingsStore((s) => s.sidebarCategoryRatio);
  const aiSidebarOpen = useAiStore((s) => s.sidebarOpen);
  const expandedFolderIds = useSettingsStore((s) => s.expandedFolderIds);
  const glassEnabled = useSettingsStore((s) => s.glassEnabled);
  const glassBlur = useSettingsStore((s) => s.glassBlur);
  const glassTint = useSettingsStore((s) => s.glassTint);
  const glassSaturate = useSettingsStore((s) => s.glassSaturate);
  const glassBlurBg = useSettingsStore((s) => s.glassBlurBg);
  const glassTintBg = useSettingsStore((s) => s.glassTintBg);
  const glassSaturateBg = useSettingsStore((s) => s.glassSaturateBg);
  const setUpdateReminderDisabledForVersion = useSettingsStore((s) => s.setUpdateReminderDisabledForVersion);
  const loadSettingsState = useSettingsStore((s) => s.loadSettings);
  const initializeAuth = useAuthStore((s) => s.initialize);
  const autoLoginLoading = useAuthStore((s) => s.autoLoginLoading);
  const authUser = useAuthStore((s) => s.user);
  const handlePasswordRecoveryUrl = useAuthStore((s) => s.handlePasswordRecoveryUrl);

  useEffect(() => {
    void initializeAuth();
  }, [initializeAuth]);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    const handleUrls = (urls: string[]) => {
      for (const url of urls) {
        if (!url.toLowerCase().startsWith(PASSWORD_RECOVERY_REDIRECT_URL)) continue;
        if (handledPasswordRecoveryUrls.has(url)) continue;
        handledPasswordRecoveryUrls.add(url);
        setAuthOpen(false);
        void handlePasswordRecoveryUrl(url);
      }
    };

    const initializeDeepLinks = async () => {
      const stopListening = await onOpenUrl(handleUrls);
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
      const urls = await getCurrent();
      if (!disposed && urls) handleUrls(urls);
    };

    void initializeDeepLinks()
      .catch((error) => {
        console.error("Failed to initialize password recovery deep links:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handlePasswordRecoveryUrl]);

  // Warm the lightweight workspace shell after the first render. The heavy
  // collaborative editor is loaded separately only when a document is opened.
  useEffect(() => {
    void loadWorkspaceView();
    void loadWorkspaceSidebar();
  }, []);

  // Load data on mount
  useEffect(() => {
    const init = async () => {
      try {
        // A relocated data directory can be missing (unplugged drive). Say so
        // instead of showing a convincing empty notebook.
        const storage = await getStorageLocation();
        if (!storage.available) {
          const uiLang = useSettingsStore.getState().lang;
          void alertDialog({
            title: t(uiLang, "settingsStorage"),
            body: tWithParams(uiLang, "storageUnavailable", { path: storage.path }),
            confirmLabel: t(uiLang, "dialogConfirm"),
            tone: "danger",
          });
        }
        await getImageNeedDirectory().catch((error) => {
          console.warn("Failed to prepare img-need directory:", error);
          return null;
        });
        const [savedTodos, savedTodoLists, savedNotes, savedFonts, savedSettings, savedUiState] =
          await Promise.all([
            loadTodos<Todo>(),
            loadTodoLists(),
            loadNoteList(),
            loadSavedFonts(),
            loadSettings(),
            loadUiState(),
          ]);
        const savedLang = (savedSettings as { lang?: string }).lang === "en" ? "en" : "zh";
        loadTodoData(savedTodos, savedTodoLists, t(savedLang, "defaultTodoList"));
        if (savedNotes.notes.length > 0 || savedNotes.categories.length > 0) {
          loadNotesState(savedNotes.notes as Note[], savedNotes.categories);
        }
        // Restore the tab strip only from notes that still exist on disk. Preview
        // tabs were never persisted, so every restored tab is a pinned one.
        restoreTabs(
          savedUiState.tabs.map((tab) => tab.id),
          savedUiState.activeId,
          savedNotes.notes.map((note) => note.id),
        );
        if (savedFonts.length > 0) loadFontsState(savedFonts);
        loadSettingsState(savedSettings as {
          theme?: "dark" | "blue" | "yellow" | "green" | "custom";
          lang?: "zh" | "en";
          customColors?: CustomColors | null;
          customBackground?: string | null;
          savedPresets?: { name: string; colors: CustomColors }[];
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
        });

        // Drop recycle-bin entries that outlived the configured retention window.
        await purgeExpiredNoteTrash();

        // Load custom app icon, fallback to default icon
        const iconData = await loadIconData();
        const iconToSet = iconData ?? await (async () => {
          try {
            const res = await fetch('/default-icon.png');
            if (res.ok) return new Uint8Array(await res.arrayBuffer());
          } catch { /* ignore */ }
          return null;
        })();
        if (iconToSet) {
          try {
            await getCurrentWindow().setIcon(iconToSet);
          } catch { /* ignore setIcon errors on unsupported platforms */ }
        }

        savedFonts.forEach((f) => {
          if (f.path) {
            const style = document.createElement("style");
            style.textContent = `@font-face { font-family: '${f.family}'; src: url('${f.path}'); }`;
            document.head.appendChild(style);
          }
        });
        setInitialized(true);
      } catch (e) {
        console.error("Init failed:", e);
      }
    };
    init();
  }, []); // eslint-disable-line

  // Check the latest GitHub release once after persisted settings are loaded.
  useEffect(() => {
    if (!initialized) return;

    let cancelled = false;
    const disabledForVersion = useSettingsStore.getState().updateReminderDisabledForVersion;
    if (disabledForVersion && disabledForVersion !== APP_VERSION) {
      useSettingsStore.getState().setUpdateReminderDisabledForVersion(null);
    }

    fetchLatestRelease()
      .then((release) => {
        if (
          !cancelled
          && disabledForVersion !== APP_VERSION
          && isVersionNewer(release.version, APP_VERSION)
        ) {
          setAvailableUpdate(release);
        }
      })
      .catch((error) => {
        console.warn("Automatic update check failed:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [initialized]);

  // Plugin runtime. Reading the install list is cheap; starting a worker is
  // not, so only plugins that declared `onStartup` are activated here. Five
  // installed plugins without that event cost zero at launch.
  useEffect(() => {
    if (!initialized) return;
    let cancelled = false;
    void usePluginStore
      .getState()
      .hydrate()
      .then(() => {
        if (!cancelled) void activateStartupPlugins(usePluginStore.getState().installed);
      })
      .catch((error) => {
        // A wedged store must not leave the page silently empty.
        console.error("Failed to initialise the plugin store:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [initialized]);

  // The settings kill switch has to stop live workers, not just refuse new
  // calls: a disabled plugin must not keep a channel into the host.
  useEffect(() => {
    if (pluginsDisabled) deactivateAllPlugins();
  }, [pluginsDisabled]);

  // Keep the tab strip in step with the note list: a deleted note drops its tab,  // and any note opened through a non-tab entry point (new note button, tray,
  // global shortcut) joins the strip instead of opening invisibly.
  useEffect(() => {
    if (!tabsHydrated) return;
    pruneMissingTabs(notes.map((note) => note.id));
    if (!activeNoteId) return;
    if (!notes.some((note) => note.id === activeNoteId)) return;
    if (tabs.some((tab) => tab.id === activeNoteId)) return;
    useTabStore.getState().openTab(activeNoteId, { preview: false });
  }, [notes, activeNoteId, tabs, tabsHydrated, pruneMissingTabs]);

  // Persist the session. Preview tabs are deliberately excluded: they represent
  // a note the user merely glanced at, not one they committed to.
  useEffect(() => {
    if (!tabsHydrated) return;
    const timer = window.setTimeout(() => {
      const pinnedIds = tabs.filter((tab) => !tab.preview).map((tab) => tab.id);
      void saveUiState({
        tabs: pinnedIds.map((id) => ({ id })),
        activeId: activeNoteId && pinnedIds.includes(activeNoteId) ? activeNoteId : null,
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [tabs, activeNoteId, tabsHydrated]);

  // Last colour handed to the native window. A ref, not state: it has to survive
  // re-renders without ever scheduling one.
  const windowBgRef = useRef<string | null>(null);

  // Apply theme class to document
  useEffect(() => {
    applyTheme(theme, customColors);

    // The undecorated window is painted by Tauri itself before any CSS runs, so
    // it needs this theme's background in order to stop flashing white on the
    // *next* launch. One IPC per committed change; the ref is what keeps an
    // ordinary re-render, or a drag of the same palette, from repeating it.
    if (!isTauri()) return;
    const hex = resolvedBackgroundHex();
    if (!hex || hex === windowBgRef.current) return;
    windowBgRef.current = hex;
    void invoke("set_window_background", { hex }).catch((error) => {
      console.error("Failed to persist window background:", error);
    });
  }, [theme, customColors]);

  // Track the shell breakpoint. One frame per resize burst is enough: the only
  // outputs are the margin, the gutter and the variables derived from them.
  useEffect(() => {
    let frame: number | null = null;
    const syncShell = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const next = getShellMetrics(document.documentElement.clientWidth);
        setShell((prev) => (prev.pad === next.pad && prev.gutter === next.gutter ? prev : next));
      });
    };
    syncShell();
    window.addEventListener("resize", syncShell);
    return () => {
      window.removeEventListener("resize", syncShell);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    void getCurrentWindow().setAlwaysOnTop(alwaysOnTop).catch((error) => {
      console.error("Failed to update always-on-top state:", error);
    });
  }, [alwaysOnTop, initialized]);

  useEffect(() => {
    let cancelled = false;
    if (!customBackground) {
      setCustomBackgroundUrl(null);
      return;
    }
    resolveCustomBackground(customBackground)
      .then((path) => {
        if (!cancelled) setCustomBackgroundUrl(path ? convertFileSrc(path) : null);
      })
      .catch((error) => {
        console.error("Failed to resolve custom background:", error);
        if (!cancelled) setCustomBackgroundUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [customBackground]);

  // Auto-save settings
  useEffect(() => {
    if (initialized) {
      saveSettings({
        theme,
        lang,
        customColors,
        customBackground,
        savedPresets,
        shortcuts,
        autoSaveInterval,
        stickyOpacity,
        trashRetentionDays,
        showWorkspaceHighlights,
        alwaysOnTop,
        updateReminderDisabledForVersion,
        sidebarCategoryRatio,
        expandedFolderIds,
        glassEnabled,
        glassBlur,
        glassTint,
        glassSaturate,
        glassBlurBg,
        glassTintBg,
        glassSaturateBg,
        pluginsDisabled,
      });
    }
  }, [
    theme,
    lang,
    customColors,
    customBackground,
    savedPresets,
    shortcuts,
    autoSaveInterval,
    stickyOpacity,
    trashRetentionDays,
    showWorkspaceHighlights,
    alwaysOnTop,
    updateReminderDisabledForVersion,
    sidebarCategoryRatio,
    expandedFolderIds,
    glassEnabled,
    glassBlur,
    glassTint,
    glassSaturate,
    glassBlurBg,
    glassTintBg,
    glassSaturateBg,
    pluginsDisabled,
    initialized,
  ]);

  // Purging on change keeps a shortened retention window immediately effective.
  useEffect(() => {
    if (initialized) void purgeExpiredNoteTrash();
  }, [trashRetentionDays, initialized]);

  // Orphaned image attachments are collected once, when the app is idle.
  //
  // This used to run after every autosave, which meant reading every note body
  // and stat-ing every image on an autosave timer (cost grew with the library).
  // Startup-only is enough: an image that becomes unused mid-session is collected
  // on the next launch, and the delete paths (`deleteNoteFile`, `moveNoteToTrash`)
  // still clean up their own note's images immediately.
  useEffect(() => {
    if (!initialized) return;
    const cleanup = () => {
      void cleanupUnusedImageAttachments();
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(cleanup, { timeout: 20_000 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(cleanup, 5_000);
    return () => window.clearTimeout(timer);
  }, [initialized]);

  // Auto-save todos
  useEffect(() => {
    if (initialized) saveTodos(todos);
  }, [todos, initialized]);

  useEffect(() => {
    if (initialized) saveTodoLists({ lists: todoLists, activeListId: activeTodoListId });
  }, [todoLists, activeTodoListId, initialized]);

  // Auto-save note index — metadata only.
  //
  // The editor writes `content` into the note store on every keystroke, so this
  // effect runs per character. Saving each time meant ~7 file operations per
  // key. The fingerprint covers exactly what the index stores, minus `updatedAt`
  // (updateNote bumps it on every keystroke, so including it would disable the
  // check entirely). The timestamp therefore lags until the next metadata edit,
  // which no reader depends on.
  const noteIndexFingerprintRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized) return;
    const fingerprint = noteIndexFingerprint(notes, categories);
    if (noteIndexFingerprintRef.current === fingerprint) return;
    noteIndexFingerprintRef.current = fingerprint;

    const index = notes.map(({ id, title, tags, categoryId, pinned, order, createdAt, updatedAt }) => ({
      id, title, tags, categoryId, pinned, order, createdAt, updatedAt,
    }));
    // Was a bare call: a rejected write turned into an unhandled rejection.
    void saveNoteIndex(index, categories).catch((error) => {
      console.warn("Failed to save the note index:", error);
    });
  }, [notes, categories, initialized]);

  // Auto-save fonts
  useEffect(() => {
    if (initialized) {
      const customFonts = fonts.filter((f) => f.path !== "");
      saveFontList(customFonts);
    }
  }, [fonts, initialized]);

  // Listen for pin-current-note shortcut from Rust backend
  useEffect(() => {
    const unlisten = listen("pin-current-note", () => {
      const currentNoteId = useNoteStore.getState().activeNoteId;
      if (currentNoteId) {
        openTileWindow(currentNoteId);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Apply global shortcuts (re-register when shortcuts change)
  useEffect(() => {
    if (initialized) {
      applyShortcuts(shortcuts);
    }
  }, [shortcuts, initialized]);

  // Ctrl+W closes the active note tab.
  //
  // This is a window-scoped keydown listener on purpose. `shortcutManager`
  // registers through @tauri-apps/plugin-global-shortcut, which is system-wide:
  // routing Ctrl+W there would take the combination away from every other
  // application on the machine.
  useEffect(() => {
    // The tab strip only exists in the note view; closing a note tab while the
    // user is looking at the todo list or the canvas would be an invisible edit.
    if (currentView !== "note") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isCloseShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key.toLowerCase() === "w" || event.code === "KeyW");
      if (!isCloseShortcut) return;

      // Browsers ignore auto-repeat for tab closing; honouring it here would
      // walk the strip and close every tab while the key is held down.
      if (event.repeat) return;
      // Never interrupt an active IME composition.
      if (event.isComposing) return;

      event.preventDefault();

      // A dialog or an open tab menu owns the keystroke. Closing the note
      // behind it would leave the popup pointing at a tab that is gone.
      if (document.querySelector('[aria-modal="true"], [data-shortcut-blocker]')) return;

      // One rule, no last-tab exception: closing the final tab leaves the
      // documented empty state instead of hiding the window.
      const { activeNoteId } = useNoteStore.getState();
      if (activeNoteId) useTabStore.getState().closeTab(activeNoteId);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [currentView]);

  // Sync theme to tile windows when it changes
  useEffect(() => {
    if (initialized) {
      emit("tile-theme-sync", { theme, customColors });
      emit("sticky:appearance-updated", { theme, customColors, stickyOpacity });
    }
  }, [theme, customColors, stickyOpacity, initialized]);

  // Keep the native tray menu wording in step with the UI language. Runs on
  // startup (lang is restored from settings) and on every language change, so
  // the tray never keeps labels from a previous language.
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_tray_language", { lang }).catch(() => {
      // A missing tray (e.g. a stripped build) must never break the UI.
    });
  }, [lang]);

  // Keep every sidebar above the shared minimum without overriding a wider user-set width.
  useEffect(() => {
    if (!initialized) return;
    setSidebarWidth((currentWidth) => Math.max(currentWidth, SIDEBAR_MIN_WIDTH));
  }, [lang, initialized]);

  // Sidebar resize drag
  const rafId = useRef<number | null>(null);
  const latestSidebarWidth = useRef(SIDEBAR_MIN_WIDTH);
  const latestSidebarCollapsed = useRef(false);

  const setSidebarCollapsedState = useCallback((sidebar: ResizableSidebar, collapsed: boolean) => {
    if (sidebar === "ai") {
      // The AI store tracks the panel as open, so collapse maps to closed.
      useAiStore.getState().setSidebarOpen(!collapsed);
    } else {
      setSidebarCollapsed(collapsed);
    }
  }, []);

  // Enable the width transition for one collapse/expand cycle, then turn it off
  // again so the next ordinary drag tracks the pointer without easing.
  const pulseCollapseAnim = useCallback(() => {
    setCollapseAnimating(true);
    if (collapseAnimTimer.current !== null) {
      window.clearTimeout(collapseAnimTimer.current);
    }
    collapseAnimTimer.current = window.setTimeout(() => {
      collapseAnimTimer.current = null;
      setCollapseAnimating(false);
    }, 240);
  }, []);

  useEffect(() => () => {
    if (collapseAnimTimer.current !== null) window.clearTimeout(collapseAnimTimer.current);
  }, []);

  const handleSidebarPointerDown = useCallback((sidebar: ResizableSidebar) => {
    resizingSidebar.current = sidebar;
    setResizingSidebarState(sidebar);
    if (sidebar === "ai") {
      latestSidebarCollapsed.current = !aiSidebarOpen;
      latestSidebarWidth.current = aiSidebarWidth;
    } else {
      latestSidebarCollapsed.current = sidebarCollapsed;
      latestSidebarWidth.current = sidebarWidth;
    }
    appRootRef.current?.classList.add("sidebar-resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [aiSidebarOpen, aiSidebarWidth, sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    const sidebarProperty = (sidebar: ResizableSidebar) =>
      sidebar === "ai" ? "--ai-sidebar-width" : "--left-sidebar-width";

    const applyWidth = () => {
      rafId.current = null;
      const sidebar = resizingSidebar.current;
      if (!sidebar) return;
      appRootRef.current?.style.setProperty(
        sidebarProperty(sidebar),
        `${latestSidebarWidth.current}px`,
      );
    };

    const syncCollapsed = (sidebar: ResizableSidebar, collapsed: boolean) => {
      latestSidebarCollapsed.current = collapsed;
      pulseCollapseAnim();
      setSidebarCollapsedState(sidebar, collapsed);
      // The shell width is state-driven, so expanding mid-drag would first paint
      // the previous width. Pin the preview width before that render lands.
      if (!collapsed) {
        appRootRef.current?.style.setProperty(
          sidebarProperty(sidebar),
          `${latestSidebarWidth.current}px`,
        );
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const sidebar = resizingSidebar.current;
      if (!sidebar) return;
      // Sashes measure from different anchors: the AI one from the window's
      // right edge, the left ones from the sidebar's own start (which now sits
      // one shell margin — and half a gutter — away from the activity bar).
      const viewportWidth = document.documentElement.clientWidth;
      const metrics = getShellMetrics(viewportWidth);
      const collapsing = sidebar === "ai"
        ? isBelowRightSidebarCollapseThreshold(event.clientX, viewportWidth - metrics.pad)
        : isBelowSidebarCollapseThreshold(event.clientX, metrics.pad + ACTIVITY_BAR_WIDTH);
      if (collapsing) {
        // Collapse as soon as the drag crosses the threshold. The stored width is
        // left untouched so expanding returns to the last usable width.
        if (!latestSidebarCollapsed.current) syncCollapsed(sidebar, true);
        return;
      }
      latestSidebarWidth.current = sidebar === "ai"
        ? resolveRightSidebarWidth(event.clientX, rightSidebarLimit(viewportWidth, metrics))
        : resolveSidebarWidth(event.clientX, leftSidebarOffset(metrics));
      if (latestSidebarCollapsed.current) syncCollapsed(sidebar, false);
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(applyWidth);
      }
    };

    const finishResize = (pointerX?: number) => {
      const sidebar = resizingSidebar.current;
      if (!sidebar) return;
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      const viewportWidth = document.documentElement.clientWidth;
      const metrics = getShellMetrics(viewportWidth);
      const collapsed = pointerX === undefined
        ? latestSidebarCollapsed.current
        : sidebar === "ai"
          ? isBelowRightSidebarCollapseThreshold(pointerX, viewportWidth - metrics.pad)
          : isBelowSidebarCollapseThreshold(pointerX, metrics.pad + ACTIVITY_BAR_WIDTH);
      if (pointerX !== undefined && !collapsed) {
        latestSidebarWidth.current = sidebar === "ai"
          ? resolveRightSidebarWidth(pointerX, rightSidebarLimit(viewportWidth, metrics))
          : resolveSidebarWidth(pointerX, leftSidebarOffset(metrics));
      }
      const width = latestSidebarWidth.current;
      appRootRef.current?.style.setProperty(sidebarProperty(sidebar), `${width}px`);
      resizingSidebar.current = null;
      setResizingSidebarState(null);
      // A quick flick can flip the state on release instead of during the drag.
      if (collapsed !== latestSidebarCollapsed.current) pulseCollapseAnim();
      setSidebarCollapsedState(sidebar, collapsed);
      // A collapsed release must not lower the stored width, otherwise expanding
      // would snap back to the minimum instead of the width the user had chosen.
      if (!collapsed) {
        if (sidebar === "ai") {
          setAiSidebarWidth(width);
        } else {
          setSidebarWidth(width);
        }
      }
      latestSidebarCollapsed.current = collapsed;
      appRootRef.current?.classList.remove("sidebar-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const handlePointerUp = (event: PointerEvent) => {
      finishResize(event.clientX);
    };
    const cancelResize = () => finishResize();
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", cancelResize);
    window.addEventListener("blur", cancelResize);
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", cancelResize);
      window.removeEventListener("blur", cancelResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [pulseCollapseAnim, setSidebarCollapsedState]);

  const handleNewNote = (categoryId?: string | null) => {
    const now = new Date().toISOString();
    const note: Note = {
      id: crypto.randomUUID(),
      title: "",
      content: "",
      tags: [],
      // An explicit folder (from the tree context menu) wins over the selection.
      categoryId: categoryId === undefined ? activeCategoryId : categoryId,
      pinned: false,
      order: 0,
      createdAt: now,
      updatedAt: now,
    };
    addNote(note);
    saveNoteContent(note.id, "");
  };

  const createImportedNote = useCallback(async (filePath: string, content: string, savedContent: string) => {
    const fileName = filePath.split(/[\\/]/).pop() || "imported";
    const title = fileName.replace(/\.(md|markdown|txt)$/i, "");
    const now = new Date().toISOString();
    const note: Note = {
      id: crypto.randomUUID(),
      title,
      content: savedContent,
      tags: [],
      categoryId: activeCategoryId,
      pinned: false,
      order: 0,
      createdAt: now,
      updatedAt: now,
    };
    await saveNoteContent(note.id, savedContent);
    console.log("[import] saved", fileName, "raw length:", content.length, "id:", note.id);
    addNote(note);
  }, [activeCategoryId, addNote]);

  // Import Markdown and Text files in one picker
  const handleImportTextNotes = useCallback(async () => {
    try {
      const selected = await open({
        filters: [{ name: "Markdown / Text", extensions: ["md", "markdown", "txt"] }],
        multiple: true,
      });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      let imported = 0;
      for (const filePath of files) {
        const content = await readTextFile(filePath);
        const isTextFile = /\.txt$/i.test(filePath);
        const savedContent = isTextFile
          ? content
            .split(/\n/)
            .map((line) => line ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>")
            .join("\n")
          : content;
        await createImportedNote(filePath, content, savedContent);
        imported += 1;
      }
      // Only follow the files that actually landed: an empty switch to the note
      // view looks like the import silently failed.
      if (imported > 0) setCurrentView("note");
    } catch (e) {
      console.error("Failed to import text notes:", e);
      const detail = e instanceof Error ? e.message : String(e);
      void alertDialog({
        title: t(lang, "importNote"),
        body: tWithParams(lang, "importFailed", { message: detail }),
        confirmLabel: t(lang, "dialogConfirm"),
        tone: "danger",
      });
    }
  }, [createImportedNote, lang]);

  /**
   * Export a note as a file. `noteId` lets a caller export a specific note — the
   * tab strip's context menu can target a tab that is not the active one — and
   * falls back to the active note for the editor toolbar button.
   */
  const handleExportNote = useCallback(async (noteId?: string) => {
    const targetNoteId = noteId ?? activeNoteId;
    if (!targetNoteId) return;
    const targetNote = notes.find((note) => note.id === targetNoteId);
    if (!targetNote) return;

    try {
      const defaultPath = `${targetNote.title || t(lang, "untitled")}.md`;
      const savePath = await save({
        filters: [
          { name: t(lang, "exportFilterMarkdown"), extensions: ["md"] },
          { name: t(lang, "exportFilterText"), extensions: ["txt"] },
          { name: t(lang, "exportFilterWord"), extensions: ["docx"] },
          { name: t(lang, "exportFilterPdf"), extensions: ["pdf"] },
        ],
        defaultPath,
      });
      if (!savePath) return;

      // Windows only appends the first filter's extension, so a name typed
      // without one after picking Word or PDF would otherwise land on `.md`.
      const hasExtension = /\.[^./\\]+$/.test(savePath);
      const exportPath = hasExtension ? savePath : `${savePath}.md`;

      // Exporting the note that is open right now must export what is on screen,
      // not the last autosaved revision: flush first, then read back from disk.
      // Other notes are already persisted (switching tabs saves the outgoing one),
      // so their in-memory copy is safe to use.
      const isActiveNote = targetNoteId === activeNoteId;
      if (isActiveNote) await flushActiveNote(targetNoteId);

      let storedContent: string;
      if (isActiveNote) {
        storedContent = await loadNoteContent(targetNoteId);
      } else {
        storedContent = Object.prototype.hasOwnProperty.call(targetNote, "content")
          ? targetNote.content
          : await loadNoteContent(targetNoteId);
      }
      const target = exportPath.toLowerCase();

      // Word and PDF both need the rendered form: images inlined as data URLs
      // (both loaders drop asset URLs), code blocks highlighted, Markdown parsed.
      if (target.endsWith(".docx") || target.endsWith(".pdf")) {
        const html = await renderStoredNoteContentForExport(storedContent);

        if (target.endsWith(".docx")) {
          // The DOCX writer is only pulled in when someone actually exports
          // Word, which keeps it out of the startup bundle.
          const { buildNoteDocx } = await import("@/utils/exportDocx");
          const { data, droppedImages } = await buildNoteDocx({
            title: targetNote.title,
            html,
          });
          await writeFile(exportPath, data);
          if (droppedImages > 0) {
            await alertDialog({
              title: t(lang, "exportFile"),
              body: tWithParams(lang, "exportImagesDropped", { count: droppedImages }),
              confirmLabel: t(lang, "dialogConfirm"),
              tone: "warning",
            });
          }
          return;
        }

        const sheet = mountPrintSheet(targetNote.title || t(lang, "untitled"), html);
        try {
          await waitForPrintLayout(sheet);
          await invoke("export_pdf", { path: exportPath });
        } finally {
          unmountPrintSheet(sheet);
        }
        return;
      }

      const exportContent = isStoredEditorHtml(storedContent)
        ? htmlToMarkdown(storedContent)
        : storedContent;
      await writeTextFile(exportPath, exportContent);
    } catch (e) {
      console.error("Export file failed:", e);
      const detail = e instanceof Error ? e.message : String(e);
      void alertDialog({
        title: t(lang, "exportFile"),
        body: tWithParams(lang, "exportFailed", { message: detail }),
        confirmLabel: t(lang, "dialogConfirm"),
        tone: "danger",
      });
    }
  }, [activeNoteId, lang, notes]);

  /**
   * Quit path. Flushes the active note first — the confirmation dialog promises
   * that pending edits reach disk, so the promise has to be real, not aspirational.
   */
  const handleQuit = useCallback(async () => {
    const noteId = useNoteStore.getState().activeNoteId;
    if (noteId) await flushActiveNote(noteId);
    try {
      await invoke("quit_app");
    } catch (error) {
      console.error("Failed to quit the app:", error);
      const detail = error instanceof Error ? error.message : String(error);
      void alertDialog({
        title: t(lang, "quitApp"),
        body: detail,
        confirmLabel: t(lang, "dialogConfirm"),
        tone: "danger",
      });
    }
  }, [lang]);

  // One left column for every view: the same width and the same collapsed flag
  // follow you from notes to todos to the workspace. Only the canvas has no
  // explorer, and a signed-out workspace keeps the rail alone because there is
  // nothing to list.
  const leftSidebarListVisible = currentView !== "canvas"
    && (currentView !== "workspace" || Boolean(authUser));
  const toggleActiveSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };

  const handleUpdateNow = useCallback(async () => {
    if (!availableUpdate) return;
    try {
      const opened = await openInDefaultBrowser(availableUpdate.url);
      if (opened) setAvailableUpdate(null);
    } catch (error) {
      console.error("Failed to open update page:", error);
    }
  }, [availableUpdate]);

  const handleNeverRemindUpdate = useCallback(() => {
    setUpdateReminderDisabledForVersion(APP_VERSION);
    setAvailableUpdate(null);
  }, [setUpdateReminderDisabledForVersion]);

  // Only the values currently in force are written, so the stylesheet never has
  // to branch on "is there a wallpaper?" — that keeps every glass rule at one
  // specificity level.
  const hasBackground = Boolean(customBackgroundUrl);
  // The shell is two depths everywhere, not just behind a wallpaper: the rails
  // are the solid notch, the main card sits one step lighter so the backdrop
  // reads through the middle. Everything is derived from the rail tint, so the
  // split survives a slider drag instead of living in two separate settings.
  //
  // The editor used to be pinned at >= 92 without a wallpaper ("nothing to see
  // through"), and that is exactly what made the blur and saturation sliders
  // look broken: a backdrop-filter only shows as much of the blurred backdrop as
  // (1 - tint) allows, so at 92 the effect was 8% of a nearly flat wash -
  // measured indistinguishable from blur 0. Deriving it here instead puts the
  // big card at 60 by default, which is where the two sliders become visible.
  const sideTint = hasBackground ? glassTintBg : glassTint;
  const editorTint = deriveGlassEditorTint(sideTint);
  const dialogTint = Math.max(hasBackground ? glassTintBg : glassTint, 88);
  // Below the floor the composited panel is too transparent for the muted tier
  // to clear 4.5:1. Promote the tier rather than clamping the slider: the user
  // keeps the full range, and only the weakest text level collapses into
  // secondary. Keyed on the *most transparent* surface in play - behind a
  // wallpaper the main card sits ~20 points under the rails, and that card is
  // where the body text lives. See `.app-root[data-contrast="boost"]`.
  const contrastBoost = Math.min(sideTint, editorTint) < GLASS_READABILITY_FLOOR;
  const appStyle = {
    "--left-sidebar-width": `${sidebarWidth}px`,
    "--ai-sidebar-width": `${aiSidebarWidth}px`,
    "--glass-blur": String(hasBackground ? glassBlurBg : glassBlur),
    "--glass-saturate": String(hasBackground ? glassSaturateBg : glassSaturate),
    "--glass-tint-side": String(sideTint),
    "--glass-tint-editor": String(editorTint),
    // Dialogs keep their near-opaque floor regardless of the rail tint: they are
    // transient surfaces stacked over the app, not part of the depth ladder.
    "--glass-tint-dialog": String(dialogTint),
    "--glass-panel-side": hasBackground
      ? `color-mix(in srgb, var(--color-bg-sidebar) ${100 - GLASS_RAIL_DARKEN}%, #000)`
      : "var(--color-bg-sidebar)",
    "--glass-tint-light": "60",
    "--shell-pad": `${shell.pad}px`,
    "--shell-gutter": `${shell.gutter}px`,
    "--shell-top-gap": `${shell.topGap}px`,
    backgroundColor: "var(--color-bg-shell)",
    ...(customBackgroundUrl ? {
      backgroundImage: `linear-gradient(color-mix(in srgb, var(--color-bg-primary) 15%, transparent), color-mix(in srgb, var(--color-bg-primary) 15%, transparent)), url(${JSON.stringify(customBackgroundUrl)})`,
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundSize: "cover",
    } : {}),
  } as CSSProperties;

  return (
    <div
      ref={appRootRef}
      className={`app-root flex flex-col h-screen w-screen overflow-hidden ${customBackgroundUrl ? "app-has-custom-background" : ""}`}
      style={appStyle}
      data-glass={glassEnabled ? "on" : "off"}
      data-contrast={contrastBoost ? "boost" : undefined}
    >
      {/* Custom Title Bar — one help menu only; views live in the activity bar. */}
      <TitleBar
        onOpenAuth={() => setAuthOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
        onQuit={handleQuit}
      />

      {/* Main Content — three floating cards over the shell gutter. The sashes
          between them *are* the gutters, so a card that closes takes its own
          gutter with it. The top edge uses its own `--shell-top-gap` (equal to
          `--shell-pad`) rather than the gutter, so the cards float with the
          same margin on all four sides while the sash width stays untouched. */}
      <div className="flex min-h-0 flex-1 overflow-hidden px-[var(--shell-pad)] pb-[var(--shell-pad)] pt-[var(--shell-top-gap)]">
        {/* ① Left card: the icon rail, plus the explorer column of whichever
            view is open. One surface, no divider - the rail is distinguished by
            hover and selection only. Only the canvas has no explorer yet; the
            signed-out workspace keeps the rail alone because there is nothing
            to list. */}
        <div className="shell-box surface-glass flex h-full flex-shrink-0 overflow-hidden">
          <ActivityBar
            currentView={currentView}
            onViewChange={setCurrentView}
            onOpenSettings={() => setSettingsOpen(true)}
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleActiveSidebar}
          />
          {leftSidebarListVisible && (
            <>
              {/* Hairline between the rail and the explorer. It is a sibling of
                  the collapsing column, not a border on it, so it can fade out
                  as the column closes instead of lingering at the card edge as a
                  1px stub. */}
              <span
                aria-hidden="true"
                className={`h-full w-px flex-shrink-0 bg-border transition-opacity duration-150 ${
                  sidebarCollapsed && resizingSidebarState !== "notebook" ? "opacity-0" : "opacity-100"
                }`}
              />
              <div
                style={{ width: sidebarCollapsed ? COLLAPSED_WIDTH : "var(--left-sidebar-width)" }}
                className={`sidebar-width-shell h-full flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out${collapseAnimating ? " sidebar-collapse-anim" : ""}`}
              >
                {currentView === "todo" ? (
                  <TodoSidebar  />
                ) : currentView === "workspace" ? (
                  <Suspense fallback={null}>
                    <WorkspaceSidebar />
                  </Suspense>
                ) : currentView === "plugins" ? (
                  <PanelErrorBoundary lang={lang}>
                    <PluginSidebar />
                  </PanelErrorBoundary>
                ) : (
                  <Sidebar
                    currentView={currentView}
                    onViewChange={setCurrentView}
                    onNewNote={handleNewNote}
                    onImportTextNotes={handleImportTextNotes}
                    onExportNote={(noteId) => void handleExportNote(noteId)}
                    collapsed={sidebarCollapsed}
                    onToggleCollapse={toggleActiveSidebar}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* ② Left sash / gutter. The sash stays mounted while dragging so the
            collapse that happens mid-drag does not remove the element holding
            the pointer. When there is no explorer, or it is collapsed, the gap
            is kept by a plain spacer: the cards must never touch, whatever
            their state. */}
        {leftSidebarListVisible && (!sidebarCollapsed || resizingSidebarState === "notebook") ? (
          <SidebarResizeHandle variant="gutter" onPointerDown={() => handleSidebarPointerDown("notebook")} />
        ) : (
          <div className="w-[var(--shell-gutter)] flex-shrink-0" aria-hidden="true" />
        )}

        {/* ③ Editor card: all four views live here. Only the note view puts the
            tab strip on top of it. */}
        <main className="shell-box surface-glass surface-glass--editor flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {currentView === "todo"
            ? <TodoView />
            : currentView === "workspace"
              ? (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-text-muted"><LoadingText label={t(lang, "authWorking")} /></div>}>
                  <WorkspaceView onOpenAuth={() => setAuthOpen(true)} />
                </Suspense>
              )
              : currentView === "plugins"
                ? (
                  <PanelErrorBoundary lang={lang}>
                    <PluginDetail />
                  </PanelErrorBoundary>
                )
                : currentView === "canvas"
                ? <CanvasView />
                : (
                  <>
                    <NoteTabBar onExportNote={(noteId) => void handleExportNote(noteId)} />
                    {/* The editor keeps a `h-full` root, so it needs a sized
                        parent once the tab strip shares the column with it. */}
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                      <NoteEditor onExportNote={() => void handleExportNote()} />
                    </div>
                  </>
                )}
        </main>
        {/* ④ Right gutter. It exists only while the AI card does, so closing the
            assistant leaves the editor flush against the right margin. Kept
            mounted while dragging so the collapse that happens mid-drag does
            not remove the element holding the pointer. */}
        {(aiSidebarOpen || resizingSidebarState === "ai") && (
          <SidebarResizeHandle variant="gutter" onPointerDown={() => handleSidebarPointerDown("ai")} />
        )}
        {/* ⑤ AI card. The collapse shell only animates the width and clips; the
            card styling sits on the inner panel, which keeps its natural width
            — otherwise the border line would linger at the window edge once the
            shell reached 0, and the chat would reflow during the slide. While
            collapsed the shell is inert so the hidden panel keeps no keyboard
            focus stops. */}
        <div
          inert={aiSidebarOpen ? undefined : true}
          style={{ width: aiSidebarOpen ? "var(--ai-sidebar-width)" : COLLAPSED_WIDTH }}
          className={`sidebar-width-shell h-full flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out${collapseAnimating ? " sidebar-collapse-anim" : ""}`}
        >
          <div className="shell-box surface-glass h-full w-[var(--ai-sidebar-width)]">
            <AiSidebar onOpenSettings={() => openSettings("ai")} />
          </div>
        </div>
      </div>

      <CommandPalette
        onViewChange={setCurrentView}
        onNewNote={handleNewNote}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleAi={() => useAiStore.getState().setSidebarOpen(!useAiStore.getState().sidebarOpen)}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenAuth={() => setAuthOpen(true)}
        onOpenPlugins={() => {
          setSettingsOpen(false);
          setCurrentView("plugins");
        }}
        initialSection={settingsSection}
        hasWallpaper={hasBackground}
      />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
      {availableUpdate && (
        <UpdateModal
          currentVersion={APP_VERSION}
          latestVersion={availableUpdate.version}
          onUpdateNow={handleUpdateNow}
          onUpdateLater={() => setAvailableUpdate(null)}
          onNeverRemind={handleNeverRemindUpdate}
        />
      )}
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
      <PasswordRecoveryModal />
      <AppDialog />
      <ToastHost />
      <WorkspaceRemovalNotifier />
      {autoLoginLoading && (
        <div className="pointer-events-none fixed inset-x-0 top-12 z-[100] flex justify-center px-4">
          <div
            className="rounded-lg border border-border bg-bg-secondary/95 px-4 py-2 text-sm font-medium text-text-primary shadow-lg backdrop-blur-sm"
            role="status"
          >
            <LoadingText label={t(lang, "authAutoSigningIn")} variant="bounce" />
          </div>
        </div>
      )}
    </div>
  );
}
