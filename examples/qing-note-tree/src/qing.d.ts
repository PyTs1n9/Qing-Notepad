/**
 * Ambient types for the subset of the `qing` API this example uses.
 *
 * The host injects `qing` as a global in the plugin worker; there is nothing to
 * import. Declaring only what is called keeps the file honest — a type that is
 * wider than the runtime would let the plugin compile and then fail live.
 *
 * Positions and ids are opaque strings here: the plugin never learns a canvas
 * item id, only the reference key it used when it wrote the node.
 */

interface QingNoteSummary {
  id: string;
  title: string;
  categoryId: string | null;
  order: number;
}

interface QingFolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
}

type QingRefTarget =
  | { kind: "note"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "root"; label: string };

interface QingRefNodeInput {
  ref: QingRefTarget;
  title: string;
  excerpt?: string;
  summary?: string;
  summaryHash?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface QingRefEdgeInput {
  from: string;
  to: string;
  style?: "straight" | "orthogonal" | "curve";
  startAnchor?: "top" | "right" | "bottom" | "left";
  endAnchor?: "top" | "right" | "bottom" | "left";
}

interface QingApi {
  readonly apiVersion: number;
  readonly hostVersion: string;
  readonly plugin: { id: string; version: string };
  readonly permissions: string[];

  log(...args: unknown[]): void;

  notes: {
    /**
     * Needs `notes:read`. Folder tree plus note placement — `notes.list()` has
     * no `categoryId`, so it cannot describe a structure.
     */
    tree(): Promise<{ folders: QingFolderSummary[]; notes: QingNoteSummary[] }>;
    /** Needs `notes:read`. `content` is Markdown, never HTML. */
    get(id: string): Promise<{ id: string; title: string; tags: string[]; content: string } | null>;
  };

  canvas: {
    /**
     * Needs `canvas:read`. Reference keys already on the board, in the form
     * `note:<id>` / `folder:<id>` / `root`. Nothing else about the board is
     * exposed.
     */
    listRefKeys(input?: { boardId?: string }): Promise<{ boardId: string; refKeys: string[] }>;

    /**
     * Needs `canvas:write`. Upserts by reference key: an existing node keeps its
     * position and only has its text fields refreshed, so a re-sync never
     * undoes a drag. `boardId` omitted means the canvas currently on screen.
     */
    upsertRefNodes(input: {
      boardId?: string;
      nodes: QingRefNodeInput[];
    }): Promise<{ idByRefKey: Record<string, string>; created: number; updated: number }>;

    /** Needs `canvas:write`. An edge whose endpoints are missing is skipped. */
    upsertRefConnectors(input: {
      boardId?: string;
      edges: QingRefEdgeInput[];
    }): Promise<{ created: number }>;

    /** Needs `canvas:write`. Folding is hiding: descendants are named by the caller. */
    setNodesHidden(input: {
      boardId?: string;
      refKeys: string[];
      hidden: boolean;
    }): Promise<{ changed: number }>;

    /** Needs `canvas:write`. Removes the nodes and any connector bound to them. */
    removeRefNodes(input: {
      boardId?: string;
      refKeys: string[];
    }): Promise<{ removed: number }>;
  };

  ai: {
    /**
     * Needs `ai:summarize`. Runs on the user's own endpoint, returns null for a
     * note with no body. This spends the user's credit — call it only on an
     * explicit command.
     */
    summarize(noteId: string): Promise<{ summary: string; title: string } | null>;
  };

  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };

  ui: {
    toast(message: string, tone?: "info" | "success" | "danger"): void;
  };

  commands: {
    register(id: string, handler: () => void | Promise<void>): void;
  };
}

declare const qing: QingApi;
