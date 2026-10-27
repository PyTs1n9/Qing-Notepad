/**
 * How a plugin's code is executed.
 *
 * Everything above this line (`headless.ts`, `bridge.ts`) talks about plugins in
 * terms of *messages*: an `init` to start one, a `call` to ask it something, an
 * `event` to tell it something, and the `ready`/`rpc`/`res`/`log` that come
 * back. Everything below this line decides where those messages physically go.
 *
 * Two implementations share that contract:
 *
 * - **In-process** (`createInProcessTransport`): a blob `Worker` inside the main
 *   window's renderer. This is where the plugin system started, and it stays
 *   the default — a plugin that hangs or leaks can still take the window with
 *   it, but nothing about the plugin *contract* depends on that.
 * - **Process** (`createProtocolTransport`, P1b): the same messages, but the
 *   worker lives in a separate hidden webview and the messages travel over the
 *   `qing-plugin-rpc` custom protocol.
 *
 * **What the second one buys is measured, not assumed.** Team-lead's
 *   process-model probe (P1b step −1) counted the `msedgewebview2` processes:
 *   one window = 12, a second webview = 19 (+7), split 3 browser / 5 renderer /
 *   6 utility / 3 gpu — so **each webview gets its own renderer**. Killing the
 *   second webview's renderer (90 MB) left the main window alive, and a
 *   `while(true){}` in that webview's *page* left the main window responsive.
 *   Note what that last line is evidence for: it is the page's main thread, not
 *   a plugin Worker. A hung Worker blocks its own thread in *either* mode and
 *   kills nothing — the 5 s RPC timeout is what notices, and it is shared.
 *
 * Performance envelope (the known cost of the second mode): one RPC is
 *   ~5–15 ms across the protocol versus ~0.1 ms in-process. Interactive use
 *   cannot tell — a command, an expanded tree row. A plugin that loops a
 *   thousand calls can, and is two orders of magnitude slower. That is the
 *   cost of the isolation, not a defect in it.
 *
 * The split exists so the second one is a *deployment* change, not a redesign:
 * the permission table (`bridge.ts`), the message shapes and the worker prelude
 * (`worker-boot.js`) are all shared, so a plugin cannot tell the difference and
 * there is no second implementation of "what a call is allowed to do" to keep
 * in sync.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The answer to a request, travelling in **both** directions:
 * the host sends one to answer a plugin's `rpc`, and the plugin sends one to
 * answer the host's `call`. It is the same shape either way because the two
 * directions are the same conversation seen from opposite ends.
 */
export type WorkerResMessage = {
  t: "res";
  rid: number;
  ok: boolean;
  value?: unknown;
  code?: string;
};

/** Host → plugin. */
export type WorkerInbound =
  | {
      t: "init";
      id: string;
      version: string;
      apiVersion: number;
      permissions: readonly string[];
      hostVersion: string;
    }
  | { t: "call"; rid: number; ns: string; method: string; args: unknown[] }
  | { t: "event"; name: string }
  | WorkerResMessage;

/** Plugin → host. */
export type WorkerOutbound =
  | { t: "ready" }
  | { t: "rpc"; rid: number; ns: string; method: string; args: unknown[] }
  | { t: "log"; level: string; args: string[] }
  | WorkerResMessage;

/**
 * Host → extension host, on the wire.
 *
 * `load` / `unload` are for the extension-host page itself (it owns a pool of
 * workers); anything else is a `WorkerInbound` the page forwards verbatim to
 * the named worker. Keeping it flat rather than nesting an envelope is
 * deliberate: the Rust whitelist checks one `t` field, and one shape per
 * direction is one less thing to get wrong.
 */
export type HostToExtMessage =
  | { t: "load"; body: string }
  | { t: "unload" }
  | WorkerInbound;

/**
 * Extension host → host, on the wire.
 *
 * `gone` is the extension host saying a worker it hosted will not answer again
 * — its context died. The host turns that into `onError`, which is the same
 * signal an in-process worker gives when it crashes.
 */
export type ExtToHostMessage = WorkerOutbound | { t: "gone"; reason: string };

export type TransportMessageHandler = (pluginId: string, message: WorkerOutbound) => void;
export type TransportErrorHandler = (pluginId: string, message: string) => void;

export interface PluginTransport {
  /**
   * Which backend this is. The plugin never sees it; the mode switch in
   * settings (P1b step 7) reads it to decide whether a session that keeps
   * crashing the host should fall back to the other one.
   */
  readonly kind: "inprocess" | "protocol";

  /**
   * Load `body` (the prelude plus the plugin's main, one file) and start
   * delivering messages. Throws if the execution context cannot be created —
   * that is a startup failure, not a crash.
   */
  start(pluginId: string, body: string): void;

  /** Deliver one host → plugin message. Unknown plugin ids are ignored. */
  send(pluginId: string, message: WorkerInbound): void;

  /** Exactly one handler; replacing it is how a transport is handed over. */
  onMessage(handler: TransportMessageHandler): void;

  /**
   * The plugin's execution context is gone and will not answer again: a crash,
   * an unserialisable message, or a backend whose process went away. Not called
   * for a body that simply never starts — `start` covers that.
   */
  onError(handler: TransportErrorHandler): void;

  /** Stop the execution context and release what it held. Idempotent. */
  dispose(pluginId: string): void;
}

interface LiveWorker {
  worker: Worker;
  objectUrl: string;
}

/**
 * The default transport: one blob `Worker` per plugin, in this renderer.
 *
 * Behaviour is exactly what `headless.ts` did before the interface existed —
 * `Worker` construction failures throw out of `start`, runtime failures arrive
 * at `onError`, `dispose` terminates and revokes the object URL.
 */
export function createInProcessTransport(): PluginTransport {
  const live = new Map<string, LiveWorker>();
  let messageHandler: TransportMessageHandler = () => undefined;
  let errorHandler: TransportErrorHandler = () => undefined;

  return {
    kind: "inprocess",

    start(pluginId: string, body: string): void {
      const blob = new Blob([body], { type: "text/javascript" });
      const objectUrl = URL.createObjectURL(blob);
      let worker: Worker;
      try {
        worker = new Worker(objectUrl, { type: "module" });
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw new Error(`the plugin worker could not start: ${String(error)}`);
      }
      live.set(pluginId, { worker, objectUrl });
      worker.onmessage = (event: MessageEvent) => {
        messageHandler(pluginId, event.data as WorkerOutbound);
      };
      worker.onerror = (event: ErrorEvent) => {
        errorHandler(pluginId, event.message || "the plugin worker crashed");
      };
      worker.onmessageerror = () => {
        errorHandler(pluginId, "the plugin sent a message that could not be deserialised");
      };
    },

    send(pluginId: string, message: WorkerInbound): void {
      live.get(pluginId)?.worker.postMessage(message);
    },

    onMessage(handler: TransportMessageHandler): void {
      messageHandler = handler;
    },

    onError(handler: TransportErrorHandler): void {
      errorHandler = handler;
    },

    dispose(pluginId: string): void {
      const entry = live.get(pluginId);
      if (!entry) return;
      live.delete(pluginId);
      entry.worker.onmessage = null;
      entry.worker.onerror = null;
      entry.worker.onmessageerror = null;
      entry.worker.terminate();
      URL.revokeObjectURL(entry.objectUrl);
    },
  };
}

/** The event the Rust bridge emits for every plugin → host message. */
const UP_EVENT = "plugin-ext-host-up";

/**
 * The cross-process transport: same messages, but the workers live in the
 * hidden extension-host webview and the messages ride `qing-plugin-rpc`.
 *
 * What this side owns is *routing* and nothing else: every `send` becomes a
 * protocol message, every protocol message is matched back to a plugin by its
 * `pluginId`, and a `gone` is reported exactly the way an in-process crash is —
 * `headless.ts` above cannot tell the difference, which is the point of the
 * interface. Permissions still live in `bridge.ts`; the plugin API shape is
 * still the worker's.
 */
export function createProtocolTransport(): PluginTransport {
  const live = new Set<string>();
  let messageHandler: TransportMessageHandler = () => undefined;
  let errorHandler: TransportErrorHandler = () => undefined;
  let listening = false;

  const push = (pluginId: string, message: HostToExtMessage): void => {
    void invoke("plugin_ext_host_send", { pluginId, message }).catch((error) => {
      // A message that cannot even be queued is a transport failure, not a
      // plugin one — reported against the plugin that was being talked to,
      // because that is whose calls are now hanging.
      errorHandler(pluginId, `the extension host did not accept a message: ${String(error)}`);
    });
  };

  return {
    kind: "protocol",

    start(pluginId: string, body: string): void {
      live.add(pluginId);
      // Subscribed lazily but only once: `listen` is the only async part of
      // this transport, and doing it in the constructor would make construction
      // async for every caller.
      if (!listening) {
        listening = true;
        void listen<{ pluginId: string; message: ExtToHostMessage }>(UP_EVENT, (event) => {
          const payload = event.payload as { pluginId?: unknown; message?: ExtToHostMessage };
          const id = payload?.pluginId;
          const message = payload?.message;
          if (typeof id !== "string" || !message || typeof message !== "object") return;
          if (message.t === "gone") {
            // The worker's context is not coming back. Same signal an
            // in-process crash gives, so the recovery path is shared.
            live.delete(id);
            errorHandler(id, message.reason || "the extension host went away");
            return;
          }
          messageHandler(id, message);
        }).catch((error) => {
          listening = false;
          for (const id of live) {
            errorHandler(id, `the extension host feed is unavailable: ${String(error)}`);
          }
        });
      }
      push(pluginId, { t: "load", body });
    },

    send(pluginId: string, message: WorkerInbound): void {
      push(pluginId, message);
    },

    onMessage(handler: TransportMessageHandler): void {
      messageHandler = handler;
    },

    onError(handler: TransportErrorHandler): void {
      errorHandler = handler;
    },

    dispose(pluginId: string): void {
      if (!live.delete(pluginId)) return;
      push(pluginId, { t: "unload" });
    },
  };
}
