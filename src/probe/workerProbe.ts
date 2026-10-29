/**
 * Phase 0 probe for the plugin runtime (see `docs/analysis-extension-host.md` §5).
 *
 * Every assumption the Worker-based isolation rests on is checked here, in the
 * real webview with the real CSP — a browser tab cannot answer these, because
 * the Tauri CSP and the `__TAURI_INTERNALS__` injection only exist inside the
 * app. Open `?probe=1` in a dev build and read the table; production builds
 * drop this file entirely (`import.meta.env.DEV` is a literal `false` there).
 *
 * Four questions:
 *   1. can a module worker be created from a blob URL?
 *   2. does it see `window` / `document`?           (expected: undefined)
 *   3. does it see `__TAURI_INTERNALS__`?           (expected: undefined)
 *   4. can it `fetch("https://example.com")`?       (expected: blocked)
 */

export interface ProbeResult {
  id: number;
  title: string;
  expected: string;
  actual: string;
  pass: boolean;
}

const WORKER_SOURCE = `
  const report = (payload) => self.postMessage(payload);
  report({ kind: "isolation", window: typeof window, document: typeof document });
  report({ kind: "tauri", internals: typeof globalThis.__TAURI_INTERNALS__ });
  fetch("https://example.com")
    .then(() => report({ kind: "network", blocked: false, detail: "fetch resolved" }))
    .catch((error) => report({ kind: "network", blocked: true, detail: String(error && error.message || error) }));
  report({ kind: "ready" });
`;

export async function runProbe(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const seen = {
    window: "not reported",
    document: "not reported",
    internals: "not reported",
    network: "not reported",
  };

  const ready = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let worker: Worker | null = null;
    const url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: "text/javascript" }),
    );

    try {
      worker = new Worker(url, { type: "module" });
    } catch (error) {
      seen.window = `worker creation failed: ${String(error)}`;
      finish();
      return;
    }

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        kind?: string;
        window?: string;
        document?: string;
        internals?: string;
        blocked?: boolean;
        detail?: string;
      };
      if (data.kind === "isolation") {
        seen.window = data.window ?? "unknown";
        seen.document = data.document ?? "unknown";
      } else if (data.kind === "tauri") {
        seen.internals = data.internals ?? "unknown";
      } else if (data.kind === "network") {
        seen.network = data.blocked ? `blocked (${data.detail})` : "ALLOWED";
        finish();
      } else if (data.kind === "ready") {
        // The worker evaluated its body; the network answer follows.
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      seen.window = `worker error: ${event.message || "unknown"}`;
      finish();
    };

    // The network check needs a moment; the rest is already reported by then.
    window.setTimeout(finish, 4000);
    window.setTimeout(() => {
      worker?.terminate();
      URL.revokeObjectURL(url);
    }, 4500);
  });

  await ready;

  results.push({
    id: 1,
    title: "Blob module worker starts",
    expected: "worker reports back",
    actual: seen.window === "not reported" ? "no message" : "worker replied",
    pass: seen.window !== "not reported",
  });
  results.push({
    id: 2,
    title: "Worker sees no DOM",
    expected: "window/document = undefined",
    actual: `window=${seen.window}, document=${seen.document}`,
    pass: seen.window === "undefined" && seen.document === "undefined",
  });
  results.push({
    id: 3,
    title: "Worker sees no Tauri IPC",
    expected: "__TAURI_INTERNALS__ = undefined",
    actual: seen.internals,
    pass: seen.internals === "undefined",
  });
  results.push({
    id: 4,
    title: "Worker cannot reach the network",
    expected: "fetch throws (CSP connect-src)",
    actual: seen.network,
    pass: seen.network.startsWith("blocked"),
  });

  return results;
}

/** Renders the table straight into `#root`, so no React tree is involved. */
export async function mountProbe(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";

  const container = document.createElement("div");
  container.style.cssText =
    "padding:24px;font-family:Consolas,monospace;font-size:13px;line-height:1.7;color:#e6e6e6;background:#1b1b1b;min-height:100vh";

  const heading = document.createElement("h1");
  heading.textContent = "Worker isolation probe";
  heading.style.cssText = "font-size:16px;margin-bottom:12px";
  container.appendChild(heading);

  const list = document.createElement("div");
  container.appendChild(list);
  root.appendChild(container);

  const results = await runProbe();
  for (const result of results) {
    const row = document.createElement("div");
    row.style.cssText = `margin-bottom:8px;color:${result.pass ? "#7ee787" : "#ff7b72"}`;
    row.textContent = `${result.pass ? "PASS" : "FAIL"} · ${result.id}. ${result.title} — expected ${result.expected}, got ${result.actual}`;
    list.appendChild(row);
    console.info(`[probe ${result.id}]`, result);
  }

  const summary = document.createElement("p");
  summary.style.cssText = "margin-top:16px;color:#a5a5a5";
  summary.textContent = results.every((result) => result.pass)
    ? "All four assumptions hold: the Worker plan is viable."
    : "At least one assumption failed — stop before building the runtime.";
  container.appendChild(summary);
}
