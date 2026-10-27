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
import { clearPluginDecorations } from "@/utils/editorHandle";
import {
  clearPluginViews,
  ownCommandIds,
  sanitizeTreeItem,
} from "./views";
import { useSettingsStore } from "@/stores/settingsStore";
import { toast } from "@/stores/toastStore";
import { tWithParams } from "@/utils/i18n";
import bootSource from "./worker-boot.js?raw";
import { dispatchPluginCall } from "./bridge";
import {
  PLUGIN_API_VERSION,
  PluginError,
  activatesOnStartup,
  manifestViews,
  toPluginError,
  type InstalledPlugin,
  type PluginTreeItem,
} from "./types";
import { HOST_VERSION, isHostCompatible } from "./version";
import {
  EXT_HOST_ID,
  createInProcessTransport,
  type PluginTransport,
  type WorkerOutbound,
} from "./transport";

/** One command or one host call may not hang the palette for longer than this. */
const RPC_TIMEOUT_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: PluginError) => void;
  timer: number;
}

/**
 * A plugin that is running (or starting).
 *
 * Where its code physically runs is the transport's business: this struct holds
 * what the *host* needs — the manifest, the granted permissions, and the calls
 * that are waiting for an answer.
 */
interface Runner {
  plugin: InstalledPlugin;
  permissions: string[];
  pending: Map<number, PendingCall>;
  ready: Promise<void>;
  markReady: () => void;
  failReady: (error: PluginError) => void;
}

/** Messages a plugin sends: the same shape in both transports. */
type WorkerMessage = WorkerOutbound;

export interface CommandResult {
  ok: boolean;
  code?: string;
  message?: string;
}

const runners = new Map<string, Runner>();
/**
 * Runners whose transport has been started but which are not ready yet.
 *
 * Kept separate from `runners` so `ensureRunner` keeps its current meaning
 * ("a runner you may send to"), while messages that arrive during startup still
 * find their way to the right one.
 */
const starting = new Map<string, Runner>();

/**
 * The execution backend. In-process until P1b's process mode is switched on;
 * see `transport.ts` for why the two share one message contract.
 *
 * `let`, not `const`: a session whose extension host keeps restarting falls
 * back to the transport that does not need one (below). The fallback is a
 * *swap*, not a repair — every runner is rebuilt on demand by `ensureRunner`.
 */
let transport: PluginTransport = createInProcessTransport();

/** Restarts in one session before the transport gives up on the process mode. */
const MAX_HOST_RESTARTS = 3;

/** Extension-host restarts seen this session. */
let hostRestarts = 0;

function wireTransport(): void {
  transport.onMessage((pluginId, message) => {
    const runner = runners.get(pluginId) ?? starting.get(pluginId);
    if (runner) void handleMessage(runner, message);
  });

  transport.onError((pluginId, message) => {
    const error = toPluginError(message);
    if (error.code === "E_HOST_RESTARTED" && pluginId === EXT_HOST_ID) {
      countHostRestart();
      return;
    }
    if (error.code === "E_HOST_RESTARTED") {
      // The worker this runner was talking to is gone with the host. Fail its
      // calls with the same code and drop it, so the next command rebuilds.
      dropRunner(pluginId, error);
      return;
    }
    const runner = runners.get(pluginId) ?? starting.get(pluginId);
    if (runner) void recordCrash(runner.plugin, message);
  });
}

/**
 * The extension host came back as a new instance.
 *
 * Counted once per restart (the page announces itself once), and three of them
 * in one session is a host that cannot stay up — at which point the honest
 * answer is to stop trying to use it, not to keep asking the user to retry.
 */
function countHostRestart(): void {
  hostRestarts += 1;
  log(EXT_HOST_ID, "error", `extension host restart ${hostRestarts} of ${MAX_HOST_RESTARTS}`);
  if (hostRestarts < MAX_HOST_RESTARTS) return;
  hostRestarts = 0;
  for (const pluginId of [...runners.keys(), ...starting.keys()]) {
    dropRunner(pluginId, new PluginError("E_HOST_RESTARTED", "the extension host keeps restarting"));
  }
  transport.dispose(EXT_HOST_ID);
  transport = createInProcessTransport();
  wireTransport();
  const lang = useSettingsStore.getState().lang;
  toast(tWithParams(lang, "pluginHostFallback", {}), "danger");
}

/**
 * Forget a plugin's runner and fail whatever it was waiting on.
 *
 * The decorations and panels go with it for the same reason `deactivatePlugin`
 * drops them: rows and marks from code that is not running are not "its data",
 * they are a snapshot of a process that is gone.
 */
function dropRunner(pluginId: string, error: PluginError): void {
  const runner = runners.get(pluginId) ?? starting.get(pluginId);
  clearPluginDecorations(pluginId);
  clearPluginViews(pluginId);
  if (!runner) return;
  runners.delete(pluginId);
  starting.delete(pluginId);
  for (const call of runner.pending.values()) {
    window.clearTimeout(call.timer);
    call.reject(error);
  }
  runner.pending.clear();
  transport.dispose(pluginId);
}

wireTransport();
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
  const runner = runners.get(pluginId) ?? starting.get(pluginId);
  if (!runner) return;
  runners.delete(pluginId);
  starting.delete(pluginId);
  for (const call of runner.pending.values()) {
    window.clearTimeout(call.timer);
    call.reject(new PluginError("E_INTERNAL", "the plugin worker stopped"));
  }
  runner.pending.clear();
  transport.dispose(pluginId);
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
          {
            pluginId: runner.plugin.id,
            permissions: runner.permissions,
            viewIds: manifestViews(runner.plugin.manifest).map((view) => view.id),
          },
          message.ns,
          message.method,
          Array.isArray(message.args) ? message.args : [],
        );
        transport.send(runner.plugin.id, { t: "res", rid: message.rid, ok: true, value });
      } catch (error) {
        const pluginError = toPluginError(error);
        transport.send(runner.plugin.id, {
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
    transport.send(runner.plugin.id, { t: "call", rid, ns: namespace, method, args });
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
  const body = `${bootSource}\nself.__qing_main = async function () {\n${source}\n};\n`;

  const ready = deferred<void>();
  const runner: Runner = {
    plugin,
    permissions: [...plugin.grantedPermissions],
    pending: new Map(),
    ready: ready.promise,
    markReady: () => ready.resolve(),
    failReady: (error) => ready.reject(error),
  };
  // Registered before `start` so a `ready` that arrives in the same tick — or a
  // failure during startup — still finds its runner.
  starting.set(plugin.id, runner);

  try {
    transport.start(plugin.id, body);
  } catch (error) {
    starting.delete(plugin.id);
    throw new PluginError("E_INTERNAL", String(error));
  }

  transport.send(plugin.id, {
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
    // `teardown` reaches into `starting` as well, so this releases the
    // execution context the failed start may have created.
    teardown(plugin.id);
    throw toPluginError(error);
  }
  window.clearTimeout(timer);

  starting.delete(plugin.id);
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
 *
 * A command id is only runnable by the plugin that contributes it. A plugin
 * *worker* could not run another plugin's handler anyway (each keeps its own
 * handler map), but a plugin-contributed tree item names a command as a string,
 * and that string is the plugin's to choose — so a `command` pointing at
 * somebody else is refused here, once, for every path that ends up executing.
 *
 * `args` is what a tree item's click hands the handler — the item id, so one
 * command can serve a whole tree ("jump to *this* row") without the manifest
 * listing one command per row. The palette passes nothing and the handler
 * receives `undefined`, which is what a command with no arguments wants.
 */
export async function executePluginCommand(
  plugin: InstalledPlugin,
  commandId: string,
  args: readonly unknown[] = [],
): Promise<CommandResult> {
  try {
    if (!ownCommandIds(plugin).includes(commandId)) {
      throw new PluginError(
        "E_PERMISSION_DENIED",
        `command \`${commandId}\` is not contributed by plugin ${plugin.id}`,
      );
    }
    const runner = await ensureRunner(plugin);
    await sendCall(runner, "commands", "execute", [commandId, ...args]);
    return { ok: true };
  } catch (error) {
    const pluginError = toPluginError(error);
    log(plugin.id, "error", `${commandId}: ${pluginError.code} ${pluginError.message}`);
    return { ok: false, code: pluginError.code, message: pluginError.message };
  }
}

/**
 * Ask a plugin's tree provider for one level of children.
 *
 * `elementId` is omitted at the root. Results go through `sanitizeTreeItem`
 * because the worker is untrusted and the sidebar renders whatever comes back.
 */
export async function getPluginViewChildren(
  plugin: InstalledPlugin,
  viewId: string,
  elementId?: string,
): Promise<PluginTreeItem[]> {
  const runner = await ensureRunner(plugin);
  const args: unknown[] = elementId ? [viewId, elementId] : [viewId];
  const value = await sendCall(runner, "views", "getChildren", args);
  const allowed = ownCommandIds(plugin);
  const items: PluginTreeItem[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const item = sanitizeTreeItem(entry, allowed);
      if (item) items.push(item);
    }
  }
  return items;
}

/** Stop a plugin's worker, e.g. after it was disabled or uninstalled. */
export function deactivatePlugin(pluginId: string): void {
  // Marks a plugin painted belong to that plugin, not to the note: leaving them
  // behind after a disable, uninstall, update or rollback would show the user
  // annotations from code that no longer exists, with no way to remove them.
  clearPluginDecorations(pluginId);
  // Same for its sidebar panels: rows fetched from a worker that is being torn
  // down are not "the plugin's data", they are a snapshot of a process that is
  // going away.
  clearPluginViews(pluginId);
  const runner = runners.get(pluginId);
  if (runner) {
    try {
      transport.send(pluginId, { t: "event", name: "deactivate" });
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
