import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAuthStore } from "@/stores/authStore";
import { t } from "@/utils/i18n";
import HelpMenu from "@/components/Help/HelpMenu";
import UserAvatar from "@/components/UserAvatar";
import LoadingText from "@/components/LoadingText";
import {
  LogIn,
  LogOut,
  Mail,
  Maximize2,
  Minus,
  Power,
  Square,
  X,
} from "lucide-react";

interface TitleBarProps {
  onOpenAuth: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  /** Owned by App: it flushes the active note before invoking `quit_app`. */
  onQuit: () => void | Promise<void>;
}

/**
 * Custom title bar.
 *
 * Deliberately holds no menus except Help: view switching belongs to the
 * activity bar, document actions to the view strips, and session actions to the
 * profile popover. Keeping `currentView` out of here is what removes the
 * duplicated entries the old 工具 / 传送门 menus carried.
 */
export default function TitleBar({
  onOpenAuth,
  onOpenSettings,
  onOpenAbout,
  onQuit,
}: TitleBarProps) {
  const lang = useSettingsStore((s) => s.lang);
  const authUser = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.loading);
  const signOut = useAuthStore((s) => s.signOut);
  const authMetadata = authUser?.user_metadata as Record<string, unknown> | undefined;
  const authAvatarUrl = typeof authMetadata?.avatar_url === "string" ? authMetadata.avatar_url : null;
  const authDisplayName = typeof authMetadata?.display_name === "string" && authMetadata.display_name.trim()
    ? authMetadata.display_name.trim()
    : authUser?.email?.split("@")[0] ?? "";
  const [isMaximized, setIsMaximized] = useState(false);
  const [isProfilePreviewOpen, setIsProfilePreviewOpen] = useState(false);
  const [isQuitConfirmOpen, setIsQuitConfirmOpen] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    const checkMaximized = async () => {
      try {
        setIsMaximized(await appWindow.isMaximized());
      } catch (error) {
        console.warn("Failed to read maximized state:", error);
      }
    };
    void checkMaximized();
    const unlisten = appWindow.onResized(() => void checkMaximized());
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (!isProfilePreviewOpen && !isQuitConfirmOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isQuitConfirmOpen) setIsQuitConfirmOpen(false);
      else setIsProfilePreviewOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isProfilePreviewOpen, isQuitConfirmOpen]);

  /** Window commands must never fail silently: a swallowed rejection looks like a dead button. */
  const runWindowCommand = async (label: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      console.error(`${label} failed:`, error);
    }
  };

  /**
   * The avatar is the single profile entry: it opens the popover for everyone.
   * `quitApp` lives inside that popover, so it must be reachable when signed out
   * too — otherwise a local-only user has no way out of the app from the UI.
   */
  const handleProfileClick = () => {
    setIsProfilePreviewOpen(true);
  };

  const handleSignInFromProfile = () => {
    setIsProfilePreviewOpen(false);
    onOpenAuth();
  };

  const handleSignOut = async () => {
    if (await signOut()) setIsProfilePreviewOpen(false);
  };

  const handleConfirmQuit = async () => {
    setIsQuitConfirmOpen(false);
    setIsProfilePreviewOpen(false);
    try {
      await onQuit();
    } catch (error) {
      console.error("Quit failed:", error);
    }
  };

  return (
    <>
      {/* The title bar hugs the window edges so the self-drawn window buttons
          keep their corner hit areas: no shell margin, no rounding, and no
          `overflow: hidden` either — it would clip the help dropdown. */}
      <div
        className="surface-glass surface-glass--light relative flex h-9 flex-shrink-0 items-center text-text-primary select-none"
        onDoubleClick={() => void runWindowCommand("maximize", () => appWindow.toggleMaximize())}
      >
        <div className="flex h-full w-12 flex-shrink-0 items-center justify-center" aria-hidden="true">
          <img src="/default-icon.png" alt="" className="h-6 w-6 rounded-md object-cover" />
        </div>

        {/* The only menu left: help content, update check, issue tracker, settings, about. */}
        <div className="flex h-full items-center pr-1" onDoubleClick={(e) => e.stopPropagation()}>
          <HelpMenu onOpenSettings={onOpenSettings} onOpenAbout={onOpenAbout} />
        </div>

        {/* Drag region */}
        <div data-tauri-drag-region className="flex h-full flex-1 items-center justify-center text-sm font-semibold text-text-primary">
          <span data-tauri-drag-region className="brand-face flex whitespace-nowrap" aria-label="Qing Notepad">
            {Array.from("Qing Notepad").map((char, index) => (
              <span
                key={`${char}-${index}`}
                data-tauri-drag-region
                aria-hidden="true"
                // The delay is what turns eleven simultaneous jitters into one
                // wave; the movement itself lives in `.title-brand-letter` so
                // reduced motion can cancel it without losing the colour.
                style={{ transitionDelay: `${index * 12}ms` }}
                className="title-brand-letter"
              >
                {char === " " ? "\u00a0" : char}
              </span>
            ))}
          </span>
        </div>

        {/* Profile & Window Controls */}
        <div className="flex h-full items-center gap-0.5 pr-1.5" onDoubleClick={(e) => e.stopPropagation()}>
          <button
            className="group mr-1 flex h-7 min-w-0 max-w-[164px] items-center gap-2 rounded-full border border-border/80 bg-bg-primary/55 px-1.5 pr-2.5 shadow-sm transition-all duration-150 hover:border-accent/45 hover:bg-bg-primary"
            onClick={handleProfileClick}
            title={authUser?.email ?? t(lang, "authSignIn")}
            aria-label={authUser?.email ?? t(lang, "authSignIn")}
          >
            {authUser ? (
              <>
                <span className="relative flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-accent/20 bg-accent-light text-[11px] font-semibold uppercase text-accent-text ring-1 ring-bg-secondary">
                  {authAvatarUrl ? (
                    <img
                      src={authAvatarUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    authDisplayName.slice(0, 1)
                  )}
                </span>
                <span className="truncate text-xs font-medium text-text-primary">
                  {authDisplayName}
                </span>
              </>
            ) : (
              <>
                <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-accent-light text-accent-text">
                  <LogIn size={12} strokeWidth={2.2} />
                </span>
                <span className="whitespace-nowrap text-xs font-medium text-text-secondary transition-colors group-hover:text-text-primary">
                  {t(lang, "authSignIn")}
                </span>
              </>
            )}
          </button>
          <button
            className="group flex h-8 w-8 items-center justify-center rounded-md hover:bg-bg-hover transition-all duration-150"
            onClick={() => void runWindowCommand("minimize", () => appWindow.minimize())}
            title={t(lang, "minimize")}
          >
            <Minus size={14} strokeWidth={2.5} className="text-text-muted group-hover:text-text-primary transition-colors" />
          </button>
          <button
            className="group flex h-8 w-8 items-center justify-center rounded-md hover:bg-bg-hover transition-all duration-150"
            onClick={() => void runWindowCommand("toggle maximize", () => appWindow.toggleMaximize())}
            title={isMaximized ? t(lang, "restore") : t(lang, "maximize")}
          >
            {isMaximized
              ? <Square size={11} strokeWidth={2.5} className="text-text-muted group-hover:text-text-primary transition-colors" />
              : <Maximize2 size={13} strokeWidth={2} className="text-text-muted group-hover:text-text-primary transition-colors" />}
          </button>
          <button
            className="group flex h-8 w-8 items-center justify-center rounded-md hover:bg-danger transition-all duration-150"
            onClick={() => void runWindowCommand("close", () => appWindow.close())}
            title={t(lang, "close")}
          >
            <X size={14} strokeWidth={2.5} className="text-text-muted group-hover:text-on-danger transition-colors" />
          </button>
        </div>
      </div>

      {/* Rendered for signed-out users too: `quitApp` lives here (D8), so the
          popover must not disappear when there is no account to show. */}
      {isProfilePreviewOpen && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsProfilePreviewOpen(false);
          }}
        >
          <section
            className="relative flex w-full max-w-[320px] flex-col items-center rounded-2xl border border-border bg-bg-primary px-8 py-9 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={authUser ? authDisplayName : t(lang, "authSignedOut")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsProfilePreviewOpen(false)}
              aria-label={t(lang, "close")}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <X size={16} />
            </button>
            {authUser ? (
              <>
                <UserAvatar
                  name={authDisplayName}
                  avatarUrl={authAvatarUrl}
                  className="h-36 w-36 border-4 border-accent/20 bg-accent-light text-4xl font-semibold text-accent-text shadow-lg ring-8 ring-accent-light/50 transition-all duration-300 ease-out hover:scale-[1.03] hover:ring-accent/35 hover:shadow-[0_0_36px] hover:shadow-accent/60"
                />
                <p className="mt-5 max-w-full truncate text-base font-semibold text-text-primary">
                  {authDisplayName}
                </p>
              </>
            ) : (
              <>
                <div className="flex h-36 w-36 items-center justify-center rounded-full border-4 border-border bg-bg-secondary text-text-muted ring-8 ring-bg-secondary/40">
                  <LogIn size={48} strokeWidth={1.6} />
                </div>
                <p className="mt-5 text-base font-semibold text-text-primary">
                  {t(lang, "authSignedOut")}
                </p>
              </>
            )}
            <div className="mt-5 w-full space-y-2.5">
              {authUser ? (
                <>
                  <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-secondary/45 px-3 py-2.5 text-left">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
                      <Mail size={15} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] text-text-muted">{t(lang, "authEmail")}</p>
                      <p className="truncate text-sm text-text-primary">{authUser.email ?? "—"}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-accent-light/45 px-3 py-2.5 text-left">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-accent-text">{t(lang, "authSignedIn")}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSignOut()}
                      disabled={authLoading}
                      className="flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-danger/35 bg-danger/10 px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-on-danger disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <LogOut size={13} />
                      {authLoading
                        ? <LoadingText label={t(lang, "authWorking")} variant="bounce" />
                        : t(lang, "authSignOut")}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleSignInFromProfile}
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent-light/45 text-xs font-medium text-accent-text transition-colors hover:bg-accent hover:text-on-accent"
                >
                  <LogIn size={13} />
                  {t(lang, "authSignIn")}
                </button>
              )}

              {/* Session-level action, next to the account controls instead of at the
                  bottom of a help menu where it used to sit without any confirmation.
                  Closing the popover first keeps exactly one `aria-modal` in the tree. */}
              <button
                type="button"
                onClick={() => {
                  setIsProfilePreviewOpen(false);
                  setIsQuitConfirmOpen(true);
                }}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary/45 text-xs font-medium text-text-secondary transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
              >
                <Power size={13} />
                {t(lang, "quitApp")}
              </button>
            </div>
          </section>
        </div>
      )}

      {isQuitConfirmOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 px-4">
          <div
            className="w-full max-w-[320px] overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quit-confirm-title"
          >
            <div className="px-4 pt-4 pb-3">
              <div className="flex items-center gap-2 text-text-primary">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
                  <Power size={16} />
                </div>
                <div className="min-w-0">
                  <div id="quit-confirm-title" className="text-sm font-semibold">
                    {t(lang, "quitConfirmTitle")}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-text-secondary">
                {t(lang, "quitConfirmMessage")}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setIsQuitConfirmOpen(false)}
                className="h-8 rounded-lg border border-border px-3 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {t(lang, "confirmNo")}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmQuit()}
                className="h-8 rounded-lg bg-danger px-3 text-sm text-on-danger transition-colors hover:bg-danger/90"
              >
                {t(lang, "quitApp")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
