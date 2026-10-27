/*
 * Extension host CSP probe — and, since the run below, the answer.
 *
 * **Verdict (measured, WebView2 / Edg/155, dev build):**
 *   A. `qing-plugin-rpc://host/up`                → blocked:TypeError
 *   B. `http://qing-plugin-rpc.localhost/host/up` → ok-200
 *
 * So the custom scheme *is* reachable, but only in Tauri's **rewritten** form
 * on Windows (`http://<scheme>.localhost/<path>`); the bare scheme form never
 * appears as a URL the page can fetch. The app CSP carries both forms for that
 * reason — `qing-plugin-rpc:` is what a POSIX build would match,
 * `http://qing-plugin-rpc.localhost` is what a Windows build actually uses.
 * The `postMessage` fallback is therefore **not** needed; the protocol path is
 * usable.
 *
 * Why the probe reports over a same-origin navigation: the channel under test
 * cannot report its own failure. `eprintln!` is invisible from a GUI-subsystem
 * binary, and navigating to the custom scheme produced nothing when the scheme
 * was the thing being tested. A same-origin navigation always works, so the
 * verdict survives even a total failure of the thing it measures.
 *
 * Two earlier findings are baked into the shape of this file:
 *   - it is an external file, not an inline script — the app CSP is
 *     `script-src 'self'` with no `'unsafe-inline'`, so inline never runs;
 *   - the report carries both attempts, because one run then answers "which
 *     form, if any" instead of needing two.
 */
(async function probe() {
  async function attempt(url) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "probe",
          message: { t: "log", level: "info", args: ["csp-probe ping"] },
        }),
      });
      return "ok-" + response.status;
    } catch (error) {
      return "blocked:" + (error && error.name ? error.name : "unknown");
    }
  }

  const a = await attempt("qing-plugin-rpc://host/up");
  const b = await attempt("http://qing-plugin-rpc.localhost/host/up");

  try {
    location.href =
      location.origin + "/__probe?a=" + encodeURIComponent(a) + "&b=" + encodeURIComponent(b);
  } catch (error) {
    // Nothing else to try.
  }
})();
