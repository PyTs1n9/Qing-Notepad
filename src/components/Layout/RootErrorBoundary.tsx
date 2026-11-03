import { Component, type ErrorInfo, type ReactNode } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  error: Error | null;
  copied: boolean;
}

/**
 * The app's only error boundary.
 *
 * Without it an uncaught render error unmounts the whole tree and the window
 * keeps whatever background the webview had — which reads as a black screen with
 * no information. `PanelErrorBoundary` covers a single card; this one covers the
 * app, and deliberately shows the message and stack instead of a friendly
 * apology: the people who hit it are running a local build and can act on it.
 *
 * Kept free of app state on purpose (no stores in `componentDidCatch`, no
 * router): it has to stay renderable while the rest of the app is broken.
 */
export default class RootErrorBoundary extends Component<
  RootErrorBoundaryProps,
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<RootErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack in the console; the UI shows the message only.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  private copyDetails = () => {
    const { error } = this.state;
    const text = error ? `${error.name}: ${error.message}\n\n${error.stack ?? ""}` : "";
    void navigator.clipboard
      .writeText(text)
      .then(() => this.setState({ copied: true }))
      .catch(() => this.setState({ copied: false }));
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    // Read the language directly: a hook here would re-subscribe this boundary to
    // the very store that may have caused the failure.
    const lang = useSettingsStore.getState().lang;

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-primary p-6">
        <div className="w-full max-w-[560px] rounded-xl border border-border bg-bg-secondary p-5 shadow-xl">
          <h1 className="text-sm font-semibold text-text-primary">{t(lang, "appCrashedTitle")}</h1>
          <p className="mt-1.5 text-xs leading-5 text-text-muted">{t(lang, "appCrashedBody")}</p>

          <pre className="mt-3 max-h-[220px] overflow-auto rounded-lg border border-border bg-bg-primary p-3 text-[11px] leading-4 text-danger">
{error.name}: {error.message}
          </pre>

          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-text-muted">
              {t(lang, "appCrashedDetails")}
            </summary>
            <pre className="mt-1 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-primary p-3 text-[10px] leading-4 text-text-muted">
{error.stack ?? "—"}
            </pre>
          </details>

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
            >
              {t(lang, "appCrashedReload")}
            </button>
            <button
              type="button"
              onClick={this.copyDetails}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              {t(lang, copied ? "appCrashedCopied" : "appCrashedCopy")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
