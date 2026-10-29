/**
 * Ambient types for the `qing` surface this plugin uses.
 *
 * The host injects `qing` as a global inside the plugin worker, so there is no
 * package to import. This file declares only what `src/extension.ts` calls —
 * a type wider than the runtime would let the plugin compile and then fail at
 * runtime, which is the one thing typing is supposed to prevent.
 *
 * Not a module (no top-level `import`/`export`), so `qing` lands in the global
 * scope. That also matches the packaging constraint: the entry file must not
 * contain top-level `import`/`export`, because the host wraps the built file in
 * `self.__qing_main = async function () { ... }`.
 *
 * ---------------------------------------------------------------------------
 * The editor, in one paragraph
 *
 * Positions are **CodeMirror document offsets into the Markdown source**:
 * `0 … getText().length`, counted in UTF-16 code units (what
 * `String.prototype.length` counts). The text you read and write is **Markdown
 * source, not HTML**. Every call reads the live document, so a position saved
 * from an earlier call can be stale by the time it is used.
 */

/** A half-open range `[from, to)` inside `0 … getText().length`. */
interface QingRange {
  from: number;
  to: number;
}

interface QingSelection {
  /** Normalised: `from <= to`. */
  from: number;
  to: number;
  anchor: number;
  head: number;
  text: string;
}

/**
 * A caret placement. `{from, to}` is accepted as a shorthand, so the result of
 * `getSelection()` can be handed back.
 */
type QingSelectionSpec = { anchor: number; head: number } | QingRange;

/**
 * One row of a plugin-contributed sidebar tree.
 *
 * `command` may only name a command **this same plugin** contributes. A row may
 * carry both a `command` and children: clicking the label runs the command,
 * clicking the chevron expands — the mechanism `qing-outline` relies on.
 */
interface QingTreeItem {
  id: string;
  label: string;
  description?: string;
  command?: string;
  /** Omitted (or "none") means the row has no children, so no chevron. */
  collapsibleState?: "none" | "collapsed" | "expanded";
}

interface QingApi {
  readonly apiVersion: number;
  readonly hostVersion: string;
  readonly plugin: { id: string; version: string };
  /** The permissions the user actually granted, which may be a subset. */
  readonly permissions: string[];

  log(...args: unknown[]): void;

  /** Plugin-private JSON key/value store, 1 MB total. */
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };

  ui: {
    /** `message` is truncated at 500 characters by the host. */
    toast(message: string, tone?: "info" | "success" | "danger"): void;
  };

  commands: {
    /**
     * Register the handler for one `contributes.commands` entry.
     *
     * `itemId` is the id of the tree row the command was launched from, or
     * `undefined` when it came from the command palette.
     */
    register(id: string, handler: (itemId?: string) => void | Promise<void>): void;
  };

  editor: {
    /**
     * Needs `editor:read`. Rejects with `E_NO_EDITOR` when no note is open
     * (the todo page, settings, or a cloud note).
     */
    getText(range?: QingRange): Promise<string>;
    /** Needs `editor:read`. `from <= to` is guaranteed. */
    getSelection(): Promise<QingSelection>;
    /**
     * Needs `editor:write`. Replaces `[from, to)` with Markdown; an empty range
     * inserts. Goes through the editor's own pipeline, so autosave, dirty
     * tracking and undo treat it like the user typing.
     */
    replace(range: QingRange, text: string): Promise<void>;
    /**
     * Needs `editor:selection` — not `editor:write`. Moving the caret and
     * changing the text are separate kinds of trust.
     */
    setSelection(spec: QingSelectionSpec): Promise<void>;
  };

  /** Declarative sidebar panels (`contributes.views`, permission `views`). */
  views: {
    registerTreeDataProvider(
      viewId: string,
      provider: { getChildren(elementId?: string): Promise<QingTreeItem[]> },
    ): void;
    refresh(viewId: string): Promise<void>;
  };
}

declare const qing: QingApi;
