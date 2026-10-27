/**
 * Headless plugin runtime: one blob-URL module worker per plugin.
 *
 * A blob worker is the isolation boundary (see `decisions-plugin-system.md` D1):
 * no `window`, no `document`, no `__TAURI_INTERNALS__`, and the only way out is
 * `postMessage` into `bridge.ts`. Nothing in this file gives a plugin a direct
 * object reference to host state.
 *
 * Two failure modes get different treatment, on purpose:
 * - a **timeout** means the plugin is stuck, so the worker is killed and the
 *   call returns `E_TIMEOUT`; it is not counted as a crash, because a slow
 *   command is not necessarily a broken plugin;
 * - an **error event** means the worker itself died, which is counted, and
 *   three in a row disable the plugin so a broken package cannot burn CPU on
 *   every command.
 */
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { getDataDirectory } from "@/utils/storage";
import { useSettingsStore } from "@/stores/settingsStore";
import { toast } from "@/stores/toastStore";
import { tWithParams } from "@/utils/i18n";
import bootSource from "./worker-boot.js?raw";
import { dispatchPluginCall } from "./bridge";
import {
  PLUGIN_API_VERSION,
  PluginError,
  activatesOnStartup,
  toPluginError,
  type InstalledPlugin,
} from "./types";
import { HOST_VERSION, isHostCompatible } from "./version";

/** One command or one host call may not hang the palette for longer than this. */
const RPC_TIMEOUT_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: PluginError) => void;
  timer: number;
}

interface Runner {
  plugin: InstalledPlugin;
  worker: Worker;
  objectUrl: string;
  permissions: string[];
  pending: Map<number, PendingCall>;
  ready: Promise<void>;
  markReady: () => void;
  failReady: (error: PluginError) => void;
}

type WorkerMessage =
  | { t: "ready" }
  | { t: "rpc"; rid: number; ns: string; method: string; args: unknown[] }
  | { t: "res"; rid: number; ok: boolean; value?: unknown; code?: string }
  | { t: "log"; level: string; args: string[] };

export interface CommandResult {
  ok: boolean;
  code?: string;
  message?: string;
}

const runners = new Map<string, Runner>();
/** Consecutive crashes per plugin, reset by a successful start. */
const failureCounts = new Map<string, number>();
let nextRid = 1;

type AutoDisableListener = (pluginId: string) => void;
const autoDisableListeners = new Set<AutoDisableListener>();

/** The store subscribes so its list stops showing a plugin as enabled. */
export function onPluginAutoDisabled(listener: AutoDisableListener): () => void {
  autoDisableListeners.add(listener);
  return () => autoDisableListeners.delete(listener);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: PluginError) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejected readiness promise is always awaited by `startRunner`; this keeps
  // an early rejection from surfacing as an unhandled rejection in the console.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function log(pluginId: string, level: string, message: string): void {
  const line = message.slice(0, 500);
  if (level === "error") console.warn(`[plugin:${pluginId}]`, line);
  void invoke("plugin_append_log", { id: pluginId, level, message: line }).catch(() => undefined);
}

function crashDisabledToast(name: string): void {
  const lang = useSettingsStore.getState().lang;
  toast(tWithParams(lang, "pluginCrashedDisabled", { name }), "danger");
}

async function readMainSource(plugin: InstalledPlugin): Promise<string> {
  const manifest = plugin.manifest;
  if (!manifest) throw new PluginError("E_INTERNAL", "the plugin manifest is missing");
  const segments = manifest.main.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new PluginError("E_INTERNAL", `refusing to read entry \`${manifest.main}\``);
  }
  const dataDirectory = await getDataDirectory();
  const path = await join(dataDirectory, "plugins", plugin.id, plugin.version, ...segments);
  try {
    return await readTextFile(path);
  } catch (error) {
    throw new PluginError("E_INTERNAL", `cannot read ${manifest.main}: ${String(error)}`);
  }
}

function teardown(pluginId: string): void {
  const runner = runners.get(pluginId);
  if (!runner) return;
  runners.delete(pluginId);
  for (const call of runner.pending.values()) {
    window.clearTimeout(call.timer);
    call.reject(new PluginError("E_INTERNAL", "the plugin worker stopped"));
  }
  runner.pending.clear();
  runner.worker.onmessage = null;
  runner.worker.onerror = null;
  runner.worker.onmessageerror = null;
  runner.worker.terminate();
  URL.revokeObjectURL(runner.objectUrl);
}

async function recordCrash(plugin: InstalledPlugin, message: string): Promise<void> {
  log(plugin.id, "error", message);
  teardown(plugin.id);
  const failures = (failureCounts.get(plugin.id) ?? 0) + 1;
  failureCounts.set(plugin.id, failures);
  if (failures < MAX_CONSECUTIVE_FAILURES) return;

  failureCounts.delete(plugin.id);
  try {
    await invoke("plugin_set_enabled", { id: plugin.id, enabled: false });
  } catch (error) {
    console.warn("Failed to disable a crashing plugin:", error);
  }
  crashDisabledToast(plugin.manifest?.name ?? plugin.id);
  for (const listener of autoDisableListeners) listener(plugin.id);
}

async function handleMessage(runner: Runner, message: WorkerMessage): Promise<void> {
  switch (message.t) {
    case "ready":
      runner.markReady();
      return;

    case "rpc": {
      try {
        const value = await dispatchPluginCall(
          { pluginId: runner.plugin.id, permissions: runner.permissions },
          message.ns,
          message.method,
          Array.isArray(message.args) ? message.args : [],
        );
        runner.worker.postMessage({ t: "res", rid: message.rid, ok: true, value });
      } catch (error) {
        const pluginError = toPluginError(error);
        runner.worker.postMessage({
          t: "res",
          rid: message.rid,
          ok: false,
          code: pluginError.code,
        });
      }
      return;
    }

    case "res": {
      const call = runner.pending.get(message.rid);
      if (!call) return;
      runner.pending.delete(message.rid);
      window.clearTimeout(call.timer);
      if (message.ok) call.resolve(message.value);
      else call.reject(new PluginError(message.code ?? "E_INTERNAL", message.code ?? "E_INTERNAL"));
      return;
    }

    case "log":
      log(runner.plugin.id, message.level === "error" ? "error" : "info", (message.args ?? []).join(" "));
      return;
  }
}

function sendCall(runner: Runner, namespace: string, method: string, args: unknown[]): Promise<unknown> {
  const rid = nextRid++;
  return new Promise<unknown>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      runner.pending.delete(rid);
      // A worker that ignores a deadline is unusable from here on: keeping it
      // alive would make every later command wait out the same five seconds.
      teardown(runner.plugin.id);
      reject(new PluginError("E_TIMEOUT", `the plugin did not answer within ${RPC_TIMEOUT_MS} ms`));
    }, RPC_TIMEOUT_MS);
    runner.pending.set(rid, { resolve, reject, timer });
    runner.worker.postMessage({ t: "call", rid, ns: namespace, method, args });
  });
}

async function startRunner(plugin: InstalledPlugin): Promise<Runner> {
  const manifest = plugin.manifest;
  if (!manifest) throw new PluginError("E_INTERNAL", "the plugin manifest is missing");
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginError(
      "E_API_VERSION",
      `apiVersion ${manifest.apiVersion} is not supported by this build`,
    );
  }
  if (!isHostCompatible(manifest.engines.host)) {
    throw new PluginError(
      "E_HOST_VERSION",
      `the plugin needs host ${manifest.engines.host}, this build is ${HOST_VERSION}`,
    );
  }

  const source = await readMainSource(plugin);
  // Wrapping the body in an async function is what lets the prelude populate
  // `qing` before module-level plugin code touches it. Single-file ESM output
  // has no imports to hoist, which is why the wrapper is safe (and required:
  // relative imports cannot resolve from a blob URL anyway).
  const blob = new Blob(
    [`${bootSource}\nself.__qing_main = async function () {\n${source}\n};\n`],
    { type: "text/javascript" },
  );
  const objectUrl = URL.createObjectURL(blob);

  let worker: Worker;
  try {
    worker = new Worker(objectUrl, { type: "module" });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw new PluginError("E_INTERNAL", `the plugin worker could not start: ${String(error)}`);
  }

  const ready = deferred<void>();
  const runner: Runner = {
    plugin,
    worker,
    objectUrl,
    permissions: [...plugin.grantedPermissions],
    pending: new Map(),
    ready: ready.promise,
    markReady: () => ready.resolve(),
    failReady: (error) => ready.reject(error),
  };

  worker.onmessage = (event: MessageEvent) => {
    void handleMessage(runner, event.data as WorkerMessage);
  };
  worker.onerror = (event: ErrorEvent) => {
    void recordCrash(plugin, event.message || "the plugin worker crashed");
  };
  worker.onmessageerror = () => {
    void recordCrash(plugin, "the plugin sent a message that could not be deserialised");
  };

  runner.worker.postMessage({
    t: "init",
    id: plugin.id,
    version: plugin.version,
    apiVersion: manifest.apiVersion,
    permissions: plugin.grantedPermissions,
    hostVersion: HOST_VERSION,
  });

  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new PluginError("E_TIMEOUT", "the plugin worker did not become ready"));
    }, RPC_TIMEOUT_MS);
  });
  try {
    await Promise.race([runner.ready, timeout]);
  } catch (error) {
    window.clearTimeout(timer);
    worker.terminate();
    URL.revokeObjectURL(objectUrl);
    throw toPluginError(error);
  }
  window.clearTimeout(timer);

  runners.set(plugin.id, runner);
  failureCounts.delete(plugin.id);
  return runner;
}

async function ensureRunner(plugin: InstalledPlugin): Promise<Runner> {
  const existing = runners.get(plugin.id);
  if (existing) return existing;
  if (useSettingsStore.getState().pluginsDisabled) {
    throw new PluginError("E_DISABLED", "all plugins are disabled in settings");
  }
  if (!plugin.enabled) throw new PluginError("E_DISABLED", "this plugin is disabled");
  return startRunner(plugin);
}

/**
 * Run one contributed command. Never throws: the palette has to be able to show
 * a failure without turning it into an unhandled rejection.
 */
export async function executePluginCommand(
  plugin: InstalledPlugin,
  commandId: string,
): Promise<CommandResult> {
  try {
    const runner = await ensureRunner(plugin);
    await sendCall(runner, "commands", "execute", [commandId]);
    return { ok: true };
  } catch (error) {
    const pluginError = toPluginError(error);
    log(plugin.id, "error", `${commandId}: ${pluginError.code} ${pluginError.message}`);
    return { ok: false, code: pluginError.code, message: pluginError.message };
  }
}

/** Stop a plugin's worker, e.g. after it was disabled or uninstalled. */
export function deactivatePlugin(pluginId: string): void {  const runner = runners.get(pluginId);
  if (runner) {
    try {
      runner.worker.postMessage({ t: "event", name: "deactivate" });
    } catch {
      // The worker may already be gone; terminating below is what matters.
    }
  }
  teardown(pluginId);
}

export function deactivateAllPlugins(): void {
  for (const pluginId of [...runners.keys()]) deactivatePlugin(pluginId);
}

export function isPluginRunning(pluginId: string): boolean {
  return runners.has(pluginId);
}

/**
 * Replace the grant a live worker is checked against.
 *
 * The permission check reads the runner's copy, not the install record: a worker
 * is started once and then answers many calls, so revoking a permission has to
 * reach the running instance immediately rather than at its next restart.
 */
export function setRunnerPermissions(pluginId: string, permissions: string[]): void {
  const runner = runners.get(pluginId);
  if (runner) runner.permissions = [...permissions];
}

/**
 * Start only the plugins that asked to run at startup.
 *
 * This is the whole reason `onStartup` is a separate activation event: five
 * installed plugins with no startup event must cost exactly nothing at launch,
 * because nothing reads their `main.js` until a command is invoked.
 */
export async function activateStartupPlugins(plugins: InstalledPlugin[]): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.manifest) continue;
    if (!activatesOnStartup(plugin.manifest)) continue;
    try {
      await ensureRunner(plugin);
    } catch (error) {
      const pluginError = toPluginError(error);
      log(plugin.id, "error", `startup: ${pluginError.code} ${pluginError.message}`);
    }
  }
}
