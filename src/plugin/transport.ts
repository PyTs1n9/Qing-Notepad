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
 *   `qing-plugin-rpc` custom protocol. A plugin that `while(true){}`s then takes
 *   only that renderer down.
 *
 * The split exists so the second one is a *deployment* change, not a redesign:
 * the permission table (`bridge.ts`), the message shapes and the worker prelude
 * (`worker-boot.js`) are all shared, so a plugin cannot tell the difference and
 * there is no second implementation of "what a call is allowed to do" to keep
 * in sync.
 */

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

export type TransportMessageHandler = (pluginId: string, message: WorkerOutbound) => void;
export type TransportErrorHandler = (pluginId: string, message: string) => void;

export interface PluginTransport {
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
   * The plugin's execution context died: a crash, an unserialisable message, a
   * renderer process gone. Not called for a body that simply never starts —
   * `start` covers that.
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
