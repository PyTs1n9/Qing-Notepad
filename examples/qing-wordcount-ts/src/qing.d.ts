/**
 * Minimal ambient types for the `qing` API surface this example uses.
 *
 * The host injects `qing` as a global inside the plugin worker, so there is no
 * package to import and no `.d.ts` to install. This file declares exactly the
 * calls the example makes — keeping it small is deliberate: a type that is
 * wider than the runtime API would let a plugin compile and then fail at
 * runtime, which is the one thing typing is supposed to prevent.
 *
 * This file is not a module (no top-level `import`/`export`), so `qing` lands in
 * the global scope and `src/extension.ts` sees it without importing anything.
 * That also matches the packaging constraint: the entry file must not contain
 * top-level `import`/`export`, because the host wraps the built file in
 * `self.__qing_main = async function () { ... }`.
 */

/** What `qing.notes.list()` returns: metadata only, never note bodies. */
interface QingNoteSummary {
  id: string;
  title: string;
  tags: string[];
}

/** A single note, with its body already converted to plain text. */
interface QingNote {
  id: string;
  title: string;
  tags: string[];
  content: string;
}

interface QingApi {
  /** The API contract the host implements. This build is `1`. */
  readonly apiVersion: number;
  /** The host application version, e.g. `0.7.3`. */
  readonly hostVersion: string;
  readonly plugin: { id: string; version: string };
  /** The permissions the user actually granted, which may be a subset. */
  readonly permissions: string[];

  log(...args: unknown[]): void;

  notes: {
    list(): Promise<QingNoteSummary[]>;
    get(id: string): Promise<QingNote | null>;
  };

  ui: {
    toast(message: string, tone?: "info" | "success" | "danger"): void;
  };

  commands: {
    /** Register the handler for one `contributes.commands` entry. */
    register(id: string, handler: () => void | Promise<void>): void;
  };
}

declare const qing: QingApi;
