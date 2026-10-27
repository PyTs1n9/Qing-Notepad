/*
 * Worker-side boot prelude.
 *
 * This file is never imported as a module. `headless.ts` reads it with `?raw`
 * and concatenates it in front of the plugin body, so the whole thing becomes
 * one blob URL. That is the only way to get a `qing` object in front of the
 * plugin without asking plugin authors to import a runtime — and the spec
 * requires exactly one of the two boot strategies, not two.
 *
 * Plain JavaScript on purpose: it is inlined as text, so it must run verbatim
 * in the worker, with no transpile step of its own.
 *
 * Shape of the wrapper built by headless.ts:
 *
 *     <this file>
 *     self.__qing_main = async function () {
 *       <plugin main.js>
 *     };
 *
 * The plugin body therefore starts only after `init` arrives: `qing.plugin.id`,
 * `qing.permissions` and friends are already populated when module-level code
 * runs, and top-level `await` works because the wrapper is async.
 */
(function () {
  "use strict";

  var meta = {
    id: "",
    version: "",
    apiVersion: 1,
    hostVersion: "",
    permissions: [],
  };
  var nextRid = 1;
  var pending = new Map();
  var commandHandlers = new Map();
  var listeners = { activate: [], deactivate: [] };
  var started = false;

  function post(message) {
    self.postMessage(message);
  }

  /** Keep log payloads structured-cloneable and bounded. */
  function describe(value) {
    if (value instanceof Error) return value.stack || value.message || String(value);
    if (typeof value === "function") return "[function]";
    if (typeof value === "string") return value.length > 2000 ? value.slice(0, 2000) : value;
    try {
      var text = JSON.stringify(value);
      if (typeof text !== "string") return String(value);
      return text.length > 2000 ? text.slice(0, 2000) : text;
    } catch (error) {
      return String(value);
    }
  }

  function makeError(code) {
    var error = new Error(code);
    error.code = code;
    return error;
  }

  function rpc(namespace, method, args) {
    var rid = nextRid++;
    return new Promise(function (resolve, reject) {
      pending.set(rid, { resolve: resolve, reject: reject });
      post({ t: "rpc", rid: rid, ns: namespace, method: method, args: args || [] });
    });
  }

  function fireAndForget(namespace, method, args) {
    rpc(namespace, method, args).catch(function (error) {
      post({ t: "log", level: "warn", args: [describe(error)] });
    });
  }

  var qing = {
    get apiVersion() {
      return meta.apiVersion;
    },
    get hostVersion() {
      return meta.hostVersion;
    },
    get plugin() {
      return { id: meta.id, version: meta.version };
    },
    get permissions() {
      return meta.permissions.slice();
    },

    log: function () {
      var args = [];
      for (var index = 0; index < arguments.length; index += 1) {
        args.push(describe(arguments[index]));
      }
      post({ t: "log", level: "info", args: args });
    },

    storage: {
      get: function (key) {
        return rpc("storage", "get", [key]);
      },
      set: function (key, value) {
        return rpc("storage", "set", [key, value]);
      },
      delete: function (key) {
        return rpc("storage", "delete", [key]);
      },
      keys: function () {
        return rpc("storage", "keys", []);
      },
    },

    notes: {
      list: function () {
        return rpc("notes", "list", []);
      },
      get: function (id) {
        return rpc("notes", "get", [id]);
      },
      create: function (input) {
        return rpc("notes", "create", [input]);
      },
      update: function (id, patch) {
        return rpc("notes", "update", [id, patch]);
      },
    },

    todo: {
      list: function () {
        return rpc("todo", "list", []);
      },
      create: function (input) {
        return rpc("todo", "create", [input]);
      },
      update: function (id, patch) {
        return rpc("todo", "update", [id, patch]);
      },
    },

    clipboard: {
      read: function () {
        return rpc("clipboard", "read", []);
      },
      write: function (text) {
        return rpc("clipboard", "write", [text]);
      },
    },

    ui: {
      toast: function (message, tone) {
        fireAndForget("ui", "toast", [message, tone || "info"]);
      },
    },

    /**
     * Register the handler for one contributed command. `commands.execute` is
     * deliberately absent: plugins cannot call each other (decisions D6).
     */
    commands: {
      register: function (id, handler) {
        if (typeof id !== "string" || typeof handler !== "function") return;
        commandHandlers.set(id, handler);
      },
    },

    on: function (event, callback) {
      if (typeof callback !== "function" || !listeners[event]) return function () {};
      listeners[event].push(callback);
      return function () {
        var index = listeners[event].indexOf(callback);
        if (index >= 0) listeners[event].splice(index, 1);
      };
    },
  };

  Object.defineProperty(self, "qing", {
    value: qing,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  function callSafely(callback) {
    try {
      var result = callback();
      if (result && typeof result.catch === "function") {
        result.catch(function (error) {
          post({ t: "log", level: "error", args: [describe(error)] });
        });
      }
    } catch (error) {
      post({ t: "log", level: "error", args: [describe(error)] });
    }
  }

  async function start() {
    try {
      if (typeof self.__qing_main === "function") {
        await self.__qing_main();
      }
    } catch (error) {
      post({ t: "log", level: "error", args: [describe(error)] });
      return;
    }
    for (var index = 0; index < listeners.activate.length; index += 1) {
      callSafely(listeners.activate[index]);
    }
  }

  self.addEventListener("message", async function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.t === "init") {
      if (started) return;
      started = true;
      meta.id = data.id;
      meta.version = data.version;
      meta.apiVersion = data.apiVersion;
      meta.hostVersion = data.hostVersion;
      meta.permissions = data.permissions || [];
      // `ready` goes out before the plugin body runs: the host needs to know
      // the worker is alive even if the plugin then throws on line one.
      post({ t: "ready" });
      await start();
      return;
    }

    if (data.t === "call") {
      if (data.ns !== "commands" || data.method !== "execute") {
        post({ t: "res", rid: data.rid, ok: false, code: "E_INTERNAL" });
        return;
      }
      var commandId = Array.isArray(data.args) ? data.args[0] : undefined;
      var handler = commandHandlers.get(commandId);
      if (!handler) {
        post({ t: "res", rid: data.rid, ok: false, code: "E_NO_HANDLER" });
        return;
      }
      try {
        var value = await handler();
        var plain = value === undefined ? null : value;
        try {
          plain = JSON.parse(JSON.stringify(plain));
        } catch (error) {
          plain = null;
        }
        post({ t: "res", rid: data.rid, ok: true, value: plain });
      } catch (error) {
        post({ t: "log", level: "error", args: [describe(error)] });
        post({ t: "res", rid: data.rid, ok: false, code: "E_INTERNAL" });
      }
      return;
    }

    if (data.t === "res") {
      var entry = pending.get(data.rid);
      if (!entry) return;
      pending.delete(data.rid);
      if (data.ok) entry.resolve(data.value);
      else entry.reject(makeError(data.code || "E_INTERNAL"));
      return;
    }

    if (data.t === "event") {
      var list = listeners[data.name] || [];
      for (var index = 0; index < list.length; index += 1) {
        callSafely(list[index]);
      }
    }
  });
})();
