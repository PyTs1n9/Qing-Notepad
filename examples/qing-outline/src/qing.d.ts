/**
 * Ambient types for the `qing` API — the subset this example uses, complete
 * enough to compile against the real contract.
 *
 * The host injects `qing` as a global inside the plugin worker, so there is no
 * package to import. This file is not a module (no top-level `import`/`export`),
 * which also matches the packaging constraint: the entry file must not contain
 * top-level `import`/`export`, because the host wraps the built file in
 * `self.__qing_main = async function () { ... }`.
 *
 * ---------------------------------------------------------------------------
 * The two paragraphs that matter
 *
 * **Positions are CodeMirror document offsets into the Markdown source**:
 * `0 … getText().length`, counted in UTF-16 code units (what
 * `String.prototype.length` counts). Not ProseMirror positions, not line/column.
 *
 * **The text is Markdown source, not HTML.** Whatever `getText()` returns is
 * exactly what gets saved; hand an HTML string to `replace()` and it is stored
 * as literal HTML-shaped Markdown. Let the editor own the conversion.
 * ---------------------------------------------------------------------------
 */

/** A half-open range `[from, to)` inside `0 … getText().length`. */
interface QingRange {
  from: number;
  to: number;
}

/** A caret placement; `anchor`/`head` may be in either order. */
type QingSelectionSpec = { anchor: number; head: number } | QingRange;

/**
 * The only decoration kinds the host accepts — semantic names, not CSS.
 * (Not used by this example; declared so the namespace is complete.)
 */
type QingDecorationKind = "error" | "warning" | "success" | "muted" | "highlight";

interface QingDecorationRange {
  from: number;
  to: number;
  kind: QingDecorationKind;
}

interface QingSelection {
  from: number;
  to: number;
  anchor: number;
  head: number;
  text: string;
}

/**
 * One row of a plugin-contributed sidebar tree.
 *
 * `command` may only name a command **this same plugin** contributes; the host
 * refuses anything else with `E_PERMISSION_DENIED`. When a row is clicked the
 * host calls that command with the row's `id` as the handler's first argument,
 * so one command can serve a whole tree.
 */
interface QingTreeItem {
  id: string;
  label: string;
  description?: string;
  command?: string;
  /** Omitted (or "none") means no children, so no chevron is drawn. */
  collapsibleState?: "none" | "collapsed" | "expanded";
}

interface QingApi {
  readonly apiVersion: number;
  readonly hostVersion: string;
  readonly plugin: { id: string; version: string };
  readonly permissions: string[];

  log(...args: unknown[]): void;

  notes: {
    list(): Promise<Array<{ id: string; title: string; tags: string[] }>>;
    get(id: string): Promise<{ id: string; title: string; tags: string[]; content: string } | null>;
    create(input: { title?: string; content?: string }): Promise<{ id: string }>;
    update(id: string, patch: { title?: string; content?: string }): Promise<void>;
  };

  ui: {
    toast(message: string, tone?: "info" | "success" | "danger"): void;
  };

  commands: {
    /**
     * Register the handler for one `contributes.commands` entry.
     *
     * The handler gets one optional argument: the tree item's id when the
     * command came from a row in a plugin panel, `undefined` when it came from
     * the command palette.
     */
    register(id: string, handler: (itemId?: string) => void | Promise<void>): void;
  };

  /** The note the user has open. See the header for position/text semantics. */
  editor: {
    /** Needs `editor:read`. Whole document, or `[from, to)` when given. */
    getText(range?: QingRange): Promise<string>;
    /** Needs `editor:read`. `from <= to` is guaranteed. */
    getSelection(): Promise<QingSelection>;
    /** Needs `editor:write`. Text is Markdown, never HTML. */
    replace(range: QingRange, text: string): Promise<void>;
    /** Needs `editor:decorate`. */
    setDecorations(key: string, ranges: QingDecorationRange[]): Promise<void>;
    /**
     * Needs `editor:selection` (not `editor:write`).
     * `E_RANGE_INVALID` when out of bounds, `E_NO_EDITOR` when no note is open.
     */
    setSelection(spec: QingSelectionSpec): Promise<void>;
  };

  /** `contributes.views` panels (permission `views`). */
  views: {
    registerTreeDataProvider(
      viewId: string,
      provider: { getChildren(elementId?: string): Promise<QingTreeItem[]> },
    ): void;
    /** "My data changed" — may only name a view this plugin contributes. */
    refresh(viewId: string): Promise<void>;
  };
}

declare const qing: QingApi;
