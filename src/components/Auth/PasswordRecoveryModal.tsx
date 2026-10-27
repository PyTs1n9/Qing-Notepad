import { useEffect, useState, type FormEvent } from "react";
import { CircleCheckBig, Eye, EyeOff, KeyRound, Link2, MailCheck, Send, ShieldCheck, X } from "lucide-react";
import {
  PASSWORD_RECOVERY_LINK_INVALID_ERROR,
  useAuthStore,
} from "@/stores/authStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import LoadingText from "@/components/LoadingText";

export default function PasswordRecoveryModal() {
  const lang = useSettingsStore((state) => state.lang);
  const {
    user,
    loading,
    error,
    passwordRecoveryPending,
    passwordRecoveryStage,
    passwordRecoveryEmail,
    openPasswordRecovery,
    requestPasswordReset,
    handlePasswordRecoveryUrl,
    updatePassword,
    cancelPasswordRecovery,
    finishPasswordRecovery,
  } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [manualLink, setManualLink] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!passwordRecoveryPending) return;
    setEmail(passwordRecoveryEmail);
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setShowConfirmPassword(false);
    setManualLink("");
    setValidationError(null);
  }, [passwordRecoveryPending, passwordRecoveryStage, passwordRecoveryEmail]);

  const closeRecovery = () => {
    if (passwordRecoveryStage === "reset") {
      void cancelPasswordRecovery();
      return;
    }
    finishPasswordRecovery();
  };

  useEffect(() => {
    if (!passwordRecoveryPending) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) closeRecovery();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    passwordRecoveryPending,
    passwordRecoveryStage,
    loading,
    cancelPasswordRecovery,
    finishPasswordRecovery,
  ]);

  if (!passwordRecoveryPending || !passwordRecoveryStage) return null;

  const displayedError = error === PASSWORD_RECOVERY_LINK_INVALID_ERROR
    ? t(lang, "authRecoveryLinkInvalid")
    : error;
  const recoveryReady = Boolean(user);
  const isRequestStage = passwordRecoveryStage === "request";
  const isEmailSentStage = passwordRecoveryStage === "emailSent";
  const isResetStage = passwordRecoveryStage === "reset";
  const isSuccessStage = passwordRecoveryStage === "success";
  const title = isRequestStage || isEmailSentStage
    ? t(lang, "authForgotPasswordTitle")
    : t(lang, "authResetPasswordTitle");

  const handleEmailSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    setValidationError(null);
    if (!trimmedEmail) {
      setValidationError(t(lang, "authResetEmailRequired"));
      return;
    }
    await requestPasswordReset(trimmedEmail);
  };

  const handlePasswordSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setValidationError(null);
    if (password.length < 6) {
      setValidationError(t(lang, "authPasswordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      setValidationError(t(lang, "authPasswordMismatch"));
      return;
    }
    if (await updatePassword(password)) {
      setPassword("");
      setConfirmPassword("");
    }
  };

  const handleManualLinkSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedLink = manualLink.trim();
    setValidationError(null);
    if (!trimmedLink) {
      setValidationError(t(lang, "authRecoveryLinkRequired"));
      return;
    }
    if (!await handlePasswordRecoveryUrl(trimmedLink)) {
      setValidationError(t(lang, "authRecoveryLinkInvalid"));
    }
  };

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/45 px-4">
      <section
        className="w-full max-w-[390px] overflow-hidden rounded-xl border border-border bg-bg-primary shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-recovery-title"
      >
        <header className="flex items-center gap-2.5 border-b border-border bg-bg-sidebar/45 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
              {isRequestStage || isEmailSentStage ? <KeyRound size={16} /> : <ShieldCheck size={16} />}
            </div>
            <div className="min-w-0">
              <h1 id="password-recovery-title" className="text-sm font-semibold text-text-primary">
                {title}
              </h1>
              <p className="mt-0.5 truncate text-[11px] text-text-muted">
                {isResetStage && user?.email
                  ? user.email
                  : isEmailSentStage
                    ? passwordRecoveryEmail
                    : t(lang, isRequestStage ? "authForgotPasswordHint" : "authResetPasswordHint")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeRecovery}
            disabled={loading}
            aria-label={t(lang, "close")}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </header>

        <div className="p-5">
          {isSuccessStage ? (
            <div className="space-y-4 text-center">
              <CircleCheckBig size={34} className="mx-auto text-accent-text" />
              <p className="text-sm font-medium text-text-primary">
                {t(lang, "authPasswordResetSuccess")}
              </p>
              <button
                type="button"
                onClick={finishPasswordRecovery}
                className="h-8 w-full rounded-lg bg-accent text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
              >
                {t(lang, "authPasswordResetDone")}
              </button>
            </div>
          ) : isEmailSentStage ? (
            <div className="space-y-4 text-center">
              <MailCheck size={34} className="mx-auto text-accent-text" />
              <div>
                <p className="text-sm font-medium text-text-primary">{t(lang, "authResetEmailSent")}</p>
                <p className="mt-1 truncate text-xs text-text-muted">{passwordRecoveryEmail}</p>
              </div>
              {displayedError && <p className="text-xs text-danger">{displayedError}</p>}
              <form className="space-y-2 text-left" onSubmit={handleManualLinkSubmit}>
                <p className="text-xs leading-relaxed text-text-muted">
                  {t(lang, "authManualRecoveryHint")}
                </p>
                <textarea
                  value={manualLink}
                  onChange={(event) => setManualLink(event.target.value)}
                  autoFocus
                  rows={3}
                  placeholder={t(lang, "authRecoveryLinkPlaceholder")}
                  className="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs text-text-primary outline-none transition-colors placeholder:text-text-muted/60 focus:border-accent focus:bg-bg-primary"
                />
                {validationError && (
                  <p className="text-xs leading-relaxed text-danger">{validationError}</p>
                )}
                <button
                  type="submit"
                  disabled={loading || !manualLink.trim()}
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Link2 size={14} />
                  {loading
                    ? <LoadingText label={t(lang, "authVerifyRecoveryLink")} variant="bounce" />
                    : t(lang, "authVerifyRecoveryLink")}
                </button>
              </form>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => openPasswordRecovery(passwordRecoveryEmail)}
                  disabled={loading}
                  className="h-9 rounded-lg border border-border text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:opacity-60"
                >
                  {t(lang, "authChangeResetEmail")}
                </button>
                <button
                  type="button"
                  onClick={() => void requestPasswordReset(passwordRecoveryEmail)}
                  disabled={loading}
                  className="flex h-9 items-center justify-center rounded-lg bg-accent text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-60"
                >
                  {loading
                    ? <LoadingText label={t(lang, "authResendResetEmail")} variant="bounce" />
                    : t(lang, "authResendResetEmail")}
                </button>
              </div>
            </div>
          ) : isRequestStage ? (
            <form className="space-y-3" onSubmit={handleEmailSubmit}>
              <p className="text-xs leading-relaxed text-text-muted">
                {t(lang, "authForgotPasswordHint")}
              </p>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                  {t(lang, "authEmail")}
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                  autoFocus
                  placeholder="name@example.com"
                  className="h-9 w-full rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted/60 focus:border-accent focus:bg-bg-primary"
                />
              </label>
              {(validationError || displayedError) && (
                <p className="text-xs leading-relaxed text-danger">{validationError || displayedError}</p>
              )}
              <button
                type="submit"
                disabled={loading || !email.trim()}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send size={15} />
                {loading
                  ? <LoadingText label={t(lang, "authSendResetEmail")} variant="bounce" />
                  : t(lang, "authSendResetEmail")}
              </button>
            </form>
          ) : !recoveryReady ? (
            <div className="space-y-4">
              <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
                {displayedError || t(lang, "authRecoveryLinkInvalid")}
              </p>
              <button
                type="button"
                onClick={() => void cancelPasswordRecovery()}
                className="h-9 w-full rounded-lg border border-border text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover"
              >
                {t(lang, "close")}
              </button>
            </div>
          ) : (
            <form className="space-y-3" onSubmit={handlePasswordSubmit}>
              <p className="text-xs leading-relaxed text-text-muted">
                {t(lang, "authResetPasswordHint")}
              </p>
              <div>
                <label htmlFor="recovery-new-password" className="mb-1.5 block text-xs font-medium text-text-secondary">
                  {t(lang, "authNewPassword")}
                </label>
                <div className="relative">
                  <input
                    id="recovery-new-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    minLength={6}
                    required
                    autoFocus
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
              <div>
                <label htmlFor="recovery-confirm-password" className="mb-1.5 block text-xs font-medium text-text-secondary">
                  {t(lang, "authConfirmPassword")}
                </label>
                <div className="relative">
                  <input
                    id="recovery-confirm-password"
                    type={showConfirmPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    minLength={6}
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
              {(validationError || displayedError) && (
                <p className="text-xs leading-relaxed text-danger">{validationError || displayedError}</p>
              )}
              <button
                type="submit"
                disabled={loading || !password || !confirmPassword}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                <KeyRound size={15} />
                {loading
                  ? <LoadingText label={t(lang, "authWorking")} variant="bounce" />
                  : t(lang, "authSetNewPassword")}
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
