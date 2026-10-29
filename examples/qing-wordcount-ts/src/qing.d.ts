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

/** A single note, with its body as Markdown (HTML-era notes are converted). */
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

  /**
   * The note the user has open.
   *
   * Positions are **CodeMirror document offsets into the Markdown source**:
   * `0 … getText().length`, counted in UTF-16 code units — the same units
   * `String.prototype.length` uses. The text is Markdown, not HTML; hand HTML to
   * `replace()` and it is stored as literal text.
   *
   * Every call reads the live document, so a position saved earlier can be
   * stale by the time it is used.
   */
  editor: {
    /**
     * Needs `editor:read`. The whole document as Markdown source, or just
     * `[from, to)` when a range is given. An empty range returns `""`.
     * Rejects with `E_NO_EDITOR` when no note is open.
     */
    getText(range?: { from: number; to: number }): Promise<string>;
    /** Needs `editor:read`. `from <= to` is guaranteed. */
    getSelection(): Promise<QingSelection>;
    /**
     * Needs `editor:write`. Replaces the half-open range `[from, to)` with
     * Markdown `text`; an empty range inserts. Rejects with `E_RANGE_INVALID`
     * when the range is not inside `0 … getText().length`, and `E_NO_EDITOR`
     * when no note is open.
     */
    replace(range: { from: number; to: number }, text: string): Promise<void>;
    /**
     * Needs `editor:decorate`. Replaces the marks previously painted under
     * `key`; an empty array clears them. `kind` is one of the five semantic
     * names — a CSS class name is rejected.
     */
    setDecorations(key: string, ranges: QingDecorationRange[]): Promise<void>;

    /**
     * Needs `editor:selection` (not `editor:write`). `{anchor, head}` in either
     * order, or `{from, to}` as a shorthand. `E_RANGE_INVALID` when out of
     * bounds, `E_NO_EDITOR` when no note is open.
     */
    setSelection(
      spec: { anchor: number; head: number } | { from: number; to: number },
    ): Promise<void>;
  };

  /** `contributes.views` panels (permission `views`). */
  views: {
    registerTreeDataProvider(
      viewId: string,
      provider: {
        getChildren(elementId?: string): Promise<
          Array<{
            id: string;
            label: string;
            description?: string;
            command?: string;
            collapsibleState?: "none" | "collapsed" | "expanded";
          }>
        >;
      },
    ): void;
    refresh(viewId: string): Promise<void>;
  };

  ui: {
    toast(message: string, tone?: "info" | "success" | "danger"): void;
  };

  commands: {
    /** Register the handler for one `contributes.commands` entry. */
    register(id: string, handler: () => void | Promise<void>): void;
  };
}

interface QingSelection {
  /** Normalised: `from <= to`. */
  from: number;
  to: number;
  /** CodeMirror's own fields: which end the caret is on (`head`). */
  anchor: number;
  head: number;
  /** `getText().slice(from, to)`. */
  text: string;
}

interface QingDecorationRange {
  from: number;
  to: number;
  kind: "error" | "warning" | "success" | "muted" | "highlight";
}

declare const qing: QingApi;
