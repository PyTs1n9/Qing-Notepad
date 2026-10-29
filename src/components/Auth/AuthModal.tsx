import { useEffect, useState, type FormEvent } from "react";
import {
  Eye,
  EyeOff,
  LogIn,
  LogOut,
  Mail,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { isSupabaseConfigured } from "@/utils/supabase";
import {
  loadLoginPreferences,
  loadSavedLoginCredentials,
  saveLoginCredentials,
  saveLoginPreferenceSelection,
} from "@/utils/authPreferences";
import { t } from "@/utils/i18n";
import LoadingText from "@/components/LoadingText";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
}

type AuthMode = "signIn" | "signUp";

export default function AuthModal({ open, onClose }: AuthModalProps) {
  const lang = useSettingsStore((state) => state.lang);
  const {
    user,
    loading,
    error,
    signIn,
    signUp,
    openPasswordRecovery,
    signOut,
    clearError,
  } = useAuthStore();
  const [mode, setMode] = useState<AuthMode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    clearError();
    setMode("signIn");
    setValidationError(null);
    setNotice(null);
    setShowPassword(false);
    setShowConfirmPassword(false);
    setConfirmPassword("");

    const preferences = loadLoginPreferences();
    setRememberPassword(preferences.rememberPassword);
    setAutoLogin(preferences.autoLogin);
    let cancelled = false;
    if (preferences.rememberPassword) {
      void loadSavedLoginCredentials().then((credentials) => {
        if (cancelled || !credentials) return;
        setEmail(credentials.email);
        setPassword(credentials.password);
      });
    } else {
      setEmail("");
      setPassword("");
    }
    return () => {
      cancelled = true;
    };
  }, [open, clearError]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, loading, onClose]);

  if (!open) return null;

  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setShowConfirmPassword(false);
    setValidationError(null);
    setNotice(null);
    clearError();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setValidationError(null);
    setNotice(null);

    if (password.length < 6) {
      setValidationError(t(lang, "authPasswordTooShort"));
      return;
    }
    if (mode === "signUp" && password !== confirmPassword) {
      setValidationError(t(lang, "authPasswordMismatch"));
      return;
    }

    const result = mode === "signIn"
      ? await signIn(email.trim(), password)
      : await signUp(email.trim(), password);

    if (!result.ok) return;
    if (mode === "signIn") {
      if (rememberPassword) {
        const saved = await saveLoginCredentials(email.trim(), password, autoLogin);
        if (!saved) saveLoginPreferenceSelection(false, false);
      } else {
        saveLoginPreferenceSelection(false, false);
      }
    }
    if (result.needsEmailConfirmation) {
      setNotice(t(lang, "authCheckEmail"));
      setPassword("");
      setConfirmPassword("");
      setShowPassword(false);
      setShowConfirmPassword(false);
      return;
    }
    onClose();
  };

  const handleRememberPasswordChange = (checked: boolean) => {
    setRememberPassword(checked);
    const nextAutoLogin = checked ? autoLogin : false;
    setAutoLogin(nextAutoLogin);
    if (!checked) saveLoginPreferenceSelection(false, false);
  };

  const handleAutoLoginChange = (checked: boolean) => {
    const nextRememberPassword = checked || rememberPassword;
    setRememberPassword(nextRememberPassword);
    setAutoLogin(checked);
    if (!checked) saveLoginPreferenceSelection(nextRememberPassword, false);
  };

  const handleForgotPassword = () => {
    clearError();
    setValidationError(null);
    setNotice(null);
    openPasswordRecovery(email.trim());
    onClose();
  };

  const handleSignOut = async () => {
    if (await signOut()) onClose();
  };

  return (
    <div className="app-modal-backdrop fixed inset-0 z-[10000] flex items-center justify-center px-3 py-4 sm:px-4">
      <section
        className="app-modal-panel isolate surface-glass surface-glass--dialog w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-bg-primary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
      >
        <header className="flex items-center gap-2.5 border-b border-border bg-bg-sidebar/45 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
              {user ? <ShieldCheck size={16} /> : <LogIn size={16} />}
            </div>
            <div className="min-w-0">
              <h1 id="auth-title" className="truncate text-sm font-semibold text-text-primary">
                {user ? t(lang, "authAccount") : t(lang, "authWelcome")}
              </h1>
              <p className="mt-0.5 truncate text-[11px] leading-4 text-text-muted">
                {user ? t(lang, "authSignedIn") : t(lang, "authSubtitle")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            aria-label={t(lang, "close")}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </header>

        <div className="p-5">
          {!isSupabaseConfigured ? (
            <div className="rounded-lg border border-border bg-bg-secondary/60 p-4">
              <p className="text-sm font-medium text-text-primary">{t(lang, "authNotConfigured")}</p>
              <p className="mt-2 text-xs leading-relaxed text-text-muted">
                {t(lang, "authNotConfiguredHint")}
              </p>
            </div>
          ) : user ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-secondary/45 p-3">
                <Mail size={16} className="flex-shrink-0 text-accent-text" />
                <div className="min-w-0">
                  <p className="text-xs text-text-muted">{t(lang, "authEmail")}</p>
                  <p className="truncate text-sm text-text-primary">{user.email}</p>
                </div>
              </div>
              {error && <p className="text-xs text-danger">{error}</p>}
              <button
                type="button"
                onClick={handleSignOut}
                disabled={loading}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-border bg-bg-primary text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-danger disabled:cursor-not-allowed disabled:opacity-60"
              >
                <LogOut size={15} />
                {loading ? <LoadingText label={t(lang, "authWorking")} variant="bounce" /> : t(lang, "authSignOut")}
              </button>
            </div>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 rounded-lg bg-bg-secondary p-1">
                {(["signIn", "signUp"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => changeMode(item)}
                    className={`h-8 rounded-md text-xs font-medium transition-colors ${
                      mode === item
                        ? "bg-bg-primary text-accent-text shadow-sm"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {t(lang, item === "signIn" ? "authSignIn" : "authSignUp")}
                  </button>
                ))}
              </div>

              <form className="space-y-3" onSubmit={handleSubmit}>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                    {t(lang, "authEmail")}
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    autoFocus
                    required
                    placeholder="name@example.com"
                    className="h-9 w-full rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted/60 focus:border-accent focus:bg-bg-primary"
                  />
                </label>
                <div>
                  <label htmlFor="auth-password" className="mb-1.5 block text-xs font-medium text-text-secondary">
                    {t(lang, "authPassword")}
                  </label>
                  <div className="relative">
                    <input
                      id="auth-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={mode === "signIn" ? "current-password" : "new-password"}
                      required
                      placeholder={t(lang, "authPasswordPlaceholder")}
                      className="auth-password-input h-9 w-full rounded-lg border border-border bg-bg-secondary px-3 pr-10 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted/60 focus:border-accent focus:bg-bg-primary"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      aria-label={t(lang, showPassword ? "authHidePassword" : "authShowPassword")}
                      aria-pressed={showPassword}
                      title={t(lang, showPassword ? "authHidePassword" : "authShowPassword")}
                      className="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center text-accent-text opacity-100 transition-colors hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                {mode === "signUp" && (
                  <div>
                    <label htmlFor="auth-confirm-password" className="mb-1.5 block text-xs font-medium text-text-secondary">
                      {t(lang, "authConfirmPassword")}
                    </label>
                    <div className="relative">
                      <input
                        id="auth-confirm-password"
                        type={showConfirmPassword ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        autoComplete="new-password"
                        required
                        placeholder={t(lang, "authPasswordPlaceholder")}
                        className="auth-password-input h-9 w-full rounded-lg border border-border bg-bg-secondary px-3 pr-10 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted/60 focus:border-accent focus:bg-bg-primary"
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword((visible) => !visible)}
                        aria-label={t(lang, showConfirmPassword ? "authHidePassword" : "authShowPassword")}
                        aria-pressed={showConfirmPassword}
                        title={t(lang, showConfirmPassword ? "authHidePassword" : "authShowPassword")}
                        className="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center text-accent-text opacity-100 transition-colors hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                      >
                        {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                )}

                {mode === "signIn" && (
                  <div className="flex items-center justify-between gap-3 pt-0.5 text-xs">
                    <div className="flex min-w-0 items-center gap-3 text-text-secondary">
                      <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={rememberPassword}
                          onChange={(event) => handleRememberPasswordChange(event.target.checked)}
                          disabled={loading}
                          className="h-3.5 w-3.5 cursor-pointer accent-accent disabled:cursor-not-allowed"
                        />
                        <span>{t(lang, "authRememberPassword")}</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={autoLogin}
                          onChange={(event) => handleAutoLoginChange(event.target.checked)}
                          disabled={loading}
                          className="h-3.5 w-3.5 cursor-pointer accent-accent disabled:cursor-not-allowed"
                        />
                        <span>{t(lang, "authAutoLogin")}</span>
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={handleForgotPassword}
                      disabled={loading}
                      className="flex-shrink-0 text-accent-text transition-colors hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {t(lang, "authForgotPassword")}
                    </button>
                  </div>
                )}

                {(validationError || error) && (
                  <p className="text-xs leading-relaxed text-danger">{validationError || error}</p>
                )}
                {notice && (
                  <p className="rounded-lg bg-accent-light px-3 py-2 text-xs leading-relaxed text-accent-text">
                    {notice}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || !email.trim() || !password}
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {mode === "signUp" && !loading ? <UserPlus size={15} /> : <LogIn size={15} />}
                  {loading
                    ? <LoadingText label={t(lang, "authWorking")} variant="bounce" />
                    : t(lang, mode === "signIn" ? "authSignIn" : "authSignUp")}
                </button>
              </form>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
