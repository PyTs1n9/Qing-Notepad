/**
 * Ambient types for the `qing` API, with the editor namespace complete.
 *
 * The host injects `qing` as a global inside the plugin worker, so there is no
 * package to import. This file declares the whole surface as the runtime
 * implements it — keeping it accurate matters more than keeping it short: a
 * type wider than the runtime lets a plugin compile and then fail at runtime,
 * which is the one thing typing is supposed to prevent.
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
 * `String.prototype.length` counts). They are not ProseMirror positions and they
 * are not line/column pairs.
 *
 * The text you read and write is **Markdown source, not HTML**. Whatever
 * `getText()` returns is exactly what gets saved; hand an HTML string to
 * `replace()` and it is stored as literal HTML-shaped Markdown. Let the editor
 * own the conversion.
 *
 * Every call reads the live document, so a position saved from an earlier call
 * can be stale by the time it is used.
 * ---------------------------------------------------------------------------
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

interface QingTodoSummary {
  id: string;
  title: string;
  completed: boolean;
  priority: string;
  dueDate: string | null;
}

/**
 * The only decoration kinds the host accepts.
 *
 * Semantic names, not CSS: a plugin that could pass a class name could restyle
 * the editor or read the result. The mapping to `.qing-dec-<kind>` is fixed by
 * the host and follows the theme.
 */
type QingDecorationKind = "error" | "warning" | "success" | "muted" | "highlight";

interface QingDecorationRange {
  from: number;
  to: number;
  kind: QingDecorationKind;
}

interface QingSelection {
  /** Normalised: `from <= to`. */
  from: number;
  to: number;
  /** CodeMirror's own fields: which end the caret is on (`head`). */
  anchor: number;
  head: number;
  /** `getText({ from, to })`. */
  text: string;
}

/** A half-open range `[from, to)` inside `0 … getText().length`. */
interface QingRange {
  from: number;
  to: number;
}

/**
 * A caret placement. `{anchor, head}` is the native shape and may be given in
 * either order (a backwards selection is a real thing); `{from, to}` is
 * accepted as a shorthand so `getSelection()` can be handed straight back.
 */
type QingSelectionSpec = { anchor: number; head: number } | QingRange;

/**
 * One row of a plugin-contributed sidebar tree.
 *
 * `command` may only name a command **this same plugin** contributes — a tree
 * item is not a way to invoke another plugin, and the host refuses one that
 * tries (`E_PERMISSION_DENIED`).
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
  /** The API contract the host implements. This build is `1`. */
  readonly apiVersion: number;
  /** The host application version, e.g. `0.7.3`. */
  readonly hostVersion: string;
  readonly plugin: { id: string; version: string };
  /** The permissions the user actually granted, which may be a subset. */
  readonly permissions: string[];

  log(...args: unknown[]): void;

  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };

  notes: {
    list(): Promise<QingNoteSummary[]>;
    get(id: string): Promise<QingNote | null>;
    create(input: { title?: string; content?: string }): Promise<{ id: string }>;
    update(id: string, patch: { title?: string; content?: string }): Promise<void>;
  };

  todo: {
    list(): Promise<QingTodoSummary[]>;
    create(input: { title: string }): Promise<{ id: string }>;
    update(id: string, patch: { title?: string; completed?: boolean }): Promise<void>;
  };

  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };

  ui: {
    toast(message: string, tone?: "info" | "success" | "danger"): void;
  };

  commands: {
    /** Register the handler for one `contributes.commands` entry. */
    register(id: string, handler: () => void | Promise<void>): void;
  };

  /**
   * The note the user has open. See the header for position and text semantics.
   *
   * `E_NO_EDITOR` means no note is open (the user is on the todo page, or
   * looking at a cloud note — cloud notes are a different editor and are not
   * exposed here). `E_RANGE_INVALID` means the range is not inside the document.
   */
  editor: {
    /**
     * Needs `editor:read`.
     *
     * The whole document as Markdown source, or just `[from, to)` when a range
     * is given. An empty range returns `""` — that is "nothing is selected",
     * not an error.
     */
    getText(range?: QingRange): Promise<string>;

    /**
     * Needs `editor:read`. `from <= to` is guaranteed; `anchor`/`head` tell you
     * which end the caret is on.
     */
    getSelection(): Promise<QingSelection>;

    /**
     * Needs `editor:write`.
     *
     * Replaces the half-open range `[from, to)` with Markdown `text`; an empty
     * range inserts, `from === to === getText().length` appends. The write goes
     * through the editor's own change pipeline, so autosave, dirty tracking and
     * undo treat it exactly like the user typing: it lands on disk and Ctrl+Z
     * reverses it.
     */
    replace(range: QingRange, text: string): Promise<void>;

    /**
     * Needs `editor:decorate`.
     *
     * Replaces the marks previously painted under `key` (one plugin may use
     * several keys); an empty array clears that key. Marks follow the text they
     * were attached to through later edits, and all of a plugin's marks are
     * dropped when it is disabled, uninstalled or updated.
     */
    setDecorations(key: string, ranges: QingDecorationRange[]): Promise<void>;

    /**
     * Needs `editor:selection` — **not** `editor:write`. Moving the caret and
     * changing the text are different kinds of trust, so they are granted
     * separately.
     *
     * Rejects with `E_RANGE_INVALID` when either position is not inside
     * `0 … getText().length`, and `E_NO_EDITOR` when no note is open. The scroll
     * position follows CodeMirror's own behaviour: the caret is scrolled into
     * view, nothing else moves.
     */
    setSelection(spec: QingSelectionSpec): Promise<void>;
  };

  /**
   * Declarative sidebar panels (`contributes.views`, permission `views`).
   *
   * `registerTreeDataProvider` supplies the rows for one panel; the host asks
   * when it needs them. `refresh(viewId)` says "my data changed" and the panel
   * re-fetches — it may only name a view this plugin contributes.
   */
  views: {
    registerTreeDataProvider(
      viewId: string,
      provider: { getChildren(elementId?: string): Promise<QingTreeItem[]> },
    ): void;
    refresh(viewId: string): Promise<void>;
  };

  /**
   * `onStartup` / `onCommand` style hooks. Returns an unsubscribe function.
   * Disposables from `activate(context)` are not consumed by the host: this
   * is the one that works.
   */
  on(event: "activate" | "deactivate", callback: () => void | Promise<void>): () => void;
}

declare const qing: QingApi;
