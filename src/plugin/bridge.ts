/**
 * The single exit from a plugin worker to the host.
 *
 * Every call a plugin makes arrives here as `(namespace, method, args)` and is
 * checked against the permission set recorded at install time *before* any host
 * code runs. That ordering is the whole security model: the worker has no
 * `__TAURI_INTERNALS__`, no `window` and no `document`, so `postMessage` is its
 * only outbound channel — and this is the function that receives it.
 *
 * Errors are always thrown as `PluginError` with a code; callers turn them into
 * `{ t: "res", ok: false, code }` and never let them escape as uncaught
 * exceptions.
 */
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { EditorView } from "@codemirror/view";
import { useNoteStore } from "@/stores/noteStore";
import { useTodoStore } from "@/stores/todoStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useAiStore, resolveAiSelection } from "@/stores/aiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { toast } from "@/stores/toastStore";
import { loadNoteContent, saveNoteContent } from "@/utils/storage";
import { loadCanvasBoard, loadCanvasList, saveCanvasBoard } from "@/utils/canvasStorage";
import { storedContentToMarkdown } from "@/utils/htmlToMarkdown";
import { generateSummaryCard } from "@/utils/ai/structured";
import { NOTE_EXTERNAL_SAVE_EVENT } from "@/utils/ai/noteWrite";
import {
  DECORATION_KINDS,
  MAX_DECORATION_RANGES,
  getActiveEditor,
  isDecorationKind,
  setPluginDecorations,
  type DecorationRange,
} from "@/utils/editorHandle";
import type { CanvasAnchor, CanvasBoard, CanvasConnectorStyle, CanvasItem, CanvasRefItem, CanvasRefTarget, Note, Todo } from "@/types";
import { createEmptyCanvasBoard } from "@/types/canvas";
import { hasPermission, PluginError, toPluginError, type PluginPermission } from "./types";
import { notifyViewRefresh } from "./views";

export interface PluginBridgeContext {
  pluginId: string;
  permissions: readonly string[];
  /**
   * The view ids this plugin contributes. `views.refresh` may only name one of
   * these: "my data changed" is a plugin's own business, poking someone else's
   * panel is not. Supplied by the host from the install record rather than read
   * from the store here, so this module stays free of store imports.
   */
  viewIds: readonly string[];
}

type Tone = "info" | "success" | "danger";

/** Which permission each host method needs. `null` means "no permission". */
const REQUIREMENTS: Record<string, Record<string, PluginPermission | null>> = {
  storage: { get: "storage", set: "storage", delete: "storage", keys: "storage" },
  notes: {
    list: "notes:read",
    tree: "notes:read",
    get: "notes:read",
    create: "notes:write",
    update: "notes:write",
  },
  todo: { list: "todo:read", create: "todo:write", update: "todo:write" },
  clipboard: { read: "clipboard:read", write: "clipboard:write" },
  ui: { toast: "notify" },
  // P1a / P1a-2. One code per kind of trust, and no implication between them:
  // being allowed to rewrite the document does not hand a plugin the text,
  // being allowed to move the caret does not hand it the right to rewrite.
  editor: {
    getText: "editor:read",
    getSelection: "editor:read",
    replace: "editor:write",
    setSelection: "editor:selection",
    setDecorations: "editor:decorate",
  },
  views: { refresh: "views" },
  // Canvas access is scoped to one board at a time. `read` returns reference
  // node keys only — enough to tell "the user deleted this node" from "this note
  // is new" — never the rest of the board. `write` adds and refreshes the nodes
  // a plugin describes, and nothing else.
  canvas: {
    listRefKeys: "canvas:read",
    upsertRefNodes: "canvas:write",
    upsertRefConnectors: "canvas:write",
    setNodesHidden: "canvas:write",
    removeRefNodes: "canvas:write",
  },
  // Summarising spends the user's API credit, so it is its own permission
  // rather than a side effect of `notes:read`.
  ai: { summarize: "ai:summarize" },
};

/** One `replace()` may insert this many characters before `E_TOO_LARGE`. */
const MAX_EDITOR_INSERT = 1_000_000;
/** Decoration keys are a bucket name, not a document. */
const MAX_DECORATION_KEY_LENGTH = 64;

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new PluginError("E_INTERNAL", `${name} must be a string`);
  }
  return value;
}

/** One canvas write may name this many nodes; a tree larger than this is a bug. */
const MAX_REF_NODE_BATCH = 2000;
const MAX_REF_TITLE = 300;
const MAX_REF_TEXT = 4000;
const MAX_REF_KEY = 400;
/** A summary is one API call; cap the wait so a stuck request cannot hang the worker. */
const SUMMARY_TIMEOUT_MS = 45_000;

function asFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PluginError("E_INVALID_ARGUMENT", `${name} must be a finite number`);
  }
  return value;
}

function asBoundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") {
    throw new PluginError("E_INVALID_ARGUMENT", `${name} must be a string`);
  }
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * A reference target is a discriminated union, not a loose `{kind, id}`: the
 * host refuses anything it cannot render, so a plugin cannot smuggle a new kind
 * into a board the user will later open.
 */
function asRefTarget(value: unknown): CanvasRefTarget {
  if (!value || typeof value !== "object") {
    throw new PluginError("E_INVALID_ARGUMENT", "ref must be an object");
  }
  const candidate = value as { kind?: unknown; id?: unknown; label?: unknown };
  if (candidate.kind === "root") {
    return { kind: "root", label: asBoundedText(candidate.label ?? "", "ref.label", MAX_REF_TITLE) };
  }
  if (candidate.kind === "note" || candidate.kind === "folder") {
    const id = asBoundedText(candidate.id, "ref.id", MAX_REF_KEY);
    if (!id) throw new PluginError("E_INVALID_ARGUMENT", "ref.id must not be empty");
    return { kind: candidate.kind, id };
  }
  throw new PluginError("E_INVALID_ARGUMENT", "ref.kind must be note, folder or root");
}

/** Stable identity of a reference node across syncs. */
function refKeyOf(target: CanvasRefTarget): string {
  return target.kind === "root" ? "root" : `${target.kind}:${target.id}`;
}

function asCanvasAnchor(value: unknown, fallback: CanvasAnchor): CanvasAnchor {
  return value === "top" || value === "right" || value === "bottom" || value === "left"
    ? value
    : fallback;
}

interface RefNodeInput {
  key: string;
  ref: CanvasRefTarget;
  title: string;
  excerpt?: string;
  summary?: string;
  summaryHash?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function asRefNodeInput(value: unknown): RefNodeInput {
  if (!value || typeof value !== "object") {
    throw new PluginError("E_INVALID_ARGUMENT", "each node must be an object");
  }
  const raw = value as Record<string, unknown>;
  const ref = asRefTarget(raw.ref);
  const width = asFiniteNumber(raw.width, "node.width");
  const height = asFiniteNumber(raw.height, "node.height");
  if (width < 40 || width > 4000 || height < 24 || height > 4000) {
    throw new PluginError("E_INVALID_ARGUMENT", "node size must be within 40..4000 by 24..4000");
  }
  const optionalText = (field: "excerpt" | "summary" | "summaryHash") => (
    raw[field] === undefined || raw[field] === null
      ? undefined
      : asBoundedText(raw[field], `node.${field}`, MAX_REF_TEXT)
  );
  return {
    key: refKeyOf(ref),
    ref,
    title: asBoundedText(raw.title ?? "", "node.title", MAX_REF_TITLE),
    excerpt: optionalText("excerpt"),
    summary: optionalText("summary"),
    summaryHash: optionalText("summaryHash"),
    x: asFiniteNumber(raw.x, "node.x"),
    y: asFiniteNumber(raw.y, "node.y"),
    width,
    height,
  };
}

function nextZIndex(items: CanvasItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.zIndex), 0) + 1;
}

/**
 * Run `mutate` against the board the user asked for.
 *
 * When that board is the one on screen the store is authoritative — writing the
 * file underneath a live view would be undone by the view's own autosave. When
 * it is not loaded, the file is the only truth and the result is written back
 * immediately.
 */
async function withCanvasBoard<T>(
  boardId: string,
  mutate: (board: CanvasBoard) => { board: CanvasBoard; result: T },
): Promise<T> {
  const store = useCanvasStore.getState();
  if (store.loaded && store.activeCanvasId === boardId) {
    const outcome = mutate(store.board);
    store.replaceBoard(outcome.board);
    // Persist as well: the canvas view may already be unmounted (a command can
    // be run from any view), and its autosave only fires while it is alive.
    await saveCanvasBoard(useCanvasStore.getState().board, boardId);
    return outcome.result;
  }
  const list = await loadCanvasList();
  if (!list.some((canvas) => canvas.id === boardId)) {
    throw new PluginError("E_INVALID_ARGUMENT", `unknown canvas ${boardId}`);
  }
  const current = (await loadCanvasBoard(boardId)) ?? createEmptyCanvasBoard();
  const outcome = mutate(current);
  await saveCanvasBoard(outcome.board, boardId);
  return outcome.result;
}

function indexRefItems(board: CanvasBoard): Map<string, CanvasRefItem> {
  const index = new Map<string, CanvasRefItem>();
  for (const item of board.items) {
    if (item.type !== "ref") continue;
    index.set(refKeyOf(item.ref), item);
  }
  return index;
}

/**
 * Canvas methods take an optional board id. Omitting it means "the board the
 * user is looking at", which is how a command run from the canvas toolbar gets
 * a target without any picker UI. Outside the canvas view there is no such
 * board and the caller has to name one.
 */
function resolveBoardId(value: unknown): string {
  if (typeof value === "string" && value) return value;
  const active = useCanvasStore.getState().activeCanvasId;
  if (!active) {
    throw new PluginError("E_NO_CANVAS", "no canvas is open; pass an explicit boardId");
  }
  return active;
}

/**
 * A note body as **Markdown**, whatever it is stored as.
 *
 * `data/notes/*.md` is a mix: editor HTML from before the Markdown rewrite,
 * Markdown afterwards. Plugins are promised Markdown, so the body goes through
 * the same converter the editor uses — `textContent` would hand back plain
 * text, and a read-modify-write round trip would then quietly delete every
 * heading, list and link. `notes.get` is a read of a *document*, not a search
 * index snippet.
 */
async function readNoteBody(note: Note): Promise<string> {
  const state = useNoteStore.getState();
  const raw = note.id === state.activeNoteId ? note.content : await loadNoteContent(note.id);
  return storedContentToMarkdown(raw);
}

// ---------------------------------------------------------------------------
// Editor (P1a)
//
// Positions are CodeMirror document offsets — `0 … view.state.doc.length`, UTF-16
// code units against the Markdown source that gets written to disk. See
// `editorHandle.ts` for why this editor and not ProseMirror.
//
// The text a plugin reads and writes is **Markdown source**, never HTML. The
// storage layer holds either editor HTML (older notes) or Markdown, and the
// converter in `@/utils/htmlToMarkdown` normalises the former — the same one
// the editor's load path and the file-export path use, so there is exactly one
// set of turndown rules to keep honest. A plugin that went around the editor
// and wrote HTML would skip that normalisation, which is how format drift
// accumulates. Writing through `dispatch` is always on the Markdown side.
// ---------------------------------------------------------------------------

/**
 * The note editor, or `E_NO_EDITOR`.
 *
 * Two behaviours worth knowing because they get asked about:
 *
 * - **preview / split mode still has an editor.** `NoteEditor.tsx:807` hides the
 *   source pane with CSS (`hidden`), it does not unmount it, so `getText()` and
 *   `replace()` keep working while the user is looking at the rendered view.
 *   Only "no note open at all" (todo page, settings, empty tab) returns
 *   `E_NO_EDITOR`.
 * - **cloud notes are not the active editor.** `Workspace/CloudNoteEditor.tsx`
 *   is a second CodeMirror instance backed by Yjs; it never calls
 *   `setActiveEditor`, so a plugin running while the workspace is open gets
 *   `E_NO_EDITOR` rather than silently writing into a collaborative document.
 *   Wiring that surface up is a separate decision (remote transaction merge is
 *   unverified).
 */
function requireEditor(): EditorView {
  const view = getActiveEditor();
  if (!view) {
    throw new PluginError("E_NO_EDITOR", "no note is open, so there is no document to act on");
  }
  return view;
}

/**
 * A half-open `[from, to)` range inside the document.
 *
 * Integers only, because `from: 1.5` is not a position — CodeMirror would round
 * it, and a plugin that ships a fraction is telling us its own maths is wrong.
 */
function asDocumentRange(value: unknown, docLength: number): { from: number; to: number } {
  const candidate = (value ?? {}) as { from?: unknown; to?: unknown };
  const { from, to } = candidate;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isInteger(from) ||
    !Number.isInteger(to)
  ) {
    throw new PluginError("E_RANGE_INVALID", "`from` and `to` must be integers");
  }
  if (from < 0 || from > to || to > docLength) {
    throw new PluginError(
      "E_RANGE_INVALID",
      `range ${from}..${to} is outside the document (0..${docLength})`,
    );
  }
  return { from, to };
}

/**
 * Decorations are `{from, to, kind}` with a semantic `kind`. An empty range is
 * dropped rather than refused: "I found no matches" is a normal result, and it
 * has to be able to clear the marks of the previous run.
 */
function asDecorationRanges(value: unknown, docLength: number): DecorationRange[] {
  if (!Array.isArray(value)) {
    throw new PluginError("E_RANGE_INVALID", "decorations must be an array of { from, to, kind }");
  }
  if (value.length > MAX_DECORATION_RANGES) {
    throw new PluginError(
      "E_TOO_LARGE",
      `more than ${MAX_DECORATION_RANGES} decoration ranges`,
    );
  }
  const ranges: DecorationRange[] = [];
  for (const entry of value) {
    const { from, to } = asDocumentRange(entry, docLength);
    const kind = (entry as { kind?: unknown }).kind;
    if (!isDecorationKind(kind)) {
      throw new PluginError(
        "E_RANGE_INVALID",
        `unknown decoration kind, expected one of ${DECORATION_KINDS.join(", ")}`,
      );
    }
    if (from === to) continue;
    ranges.push({ from, to, kind });
  }
  return ranges;
}

/**
 * A caret position: two integer offsets in either order.
 *
 * Unlike `asDocumentRange` there is no `from <= to` rule — a backwards
 * selection (head before anchor) is what shift+arrow produces, and a plugin
 * that cannot make one cannot match what the user can. `{from, to}` is accepted
 * as a shorthand so the output of `getSelection()` can be handed straight back.
 */
function asDocumentSelection(
  value: unknown,
  docLength: number,
): { anchor: number; head: number } {
  const candidate = (value ?? {}) as {
    anchor?: unknown;
    head?: unknown;
    from?: unknown;
    to?: unknown;
  };
  const anchorRaw = candidate.anchor ?? candidate.from;
  const headRaw = candidate.head ?? candidate.to;
  if (
    typeof anchorRaw !== "number" ||
    typeof headRaw !== "number" ||
    !Number.isInteger(anchorRaw) ||
    !Number.isInteger(headRaw)
  ) {
    throw new PluginError("E_RANGE_INVALID", "`anchor` and `head` must be integers");
  }
  if (anchorRaw < 0 || anchorRaw > docLength || headRaw < 0 || headRaw > docLength) {
    throw new PluginError(
      "E_RANGE_INVALID",
      `selection ${anchorRaw}/${headRaw} is outside the document (0..${docLength})`,
    );
  }
  return { anchor: anchorRaw, head: headRaw };
}

export async function dispatchPluginCall(
  context: PluginBridgeContext,
  namespace: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const requirements = REQUIREMENTS[namespace];
  if (!requirements || !(method in requirements)) {
    throw new PluginError("E_INTERNAL", `unknown host call ${namespace}.${method}`);
  }
  const required = requirements[method];
  if (required && !hasPermission(context.permissions, required)) {
    throw new PluginError(
      "E_PERMISSION_DENIED",
      `${namespace}.${method} needs \`${required}\`, which this plugin was not granted`,
    );
  }

  try {
    switch (`${namespace}.${method}`) {
      case "storage.get": {
        const value = await invoke<unknown>("plugin_storage_get", {
          id: context.pluginId,
          key: asString(args[0], "key"),
        });
        return value ?? undefined;
      }
      case "storage.set": {
        await invoke("plugin_storage_set", {
          id: context.pluginId,
          key: asString(args[0], "key"),
          value: args[1] ?? null,
        });
        return null;
      }
      case "storage.delete": {
        await invoke("plugin_storage_delete", {
          id: context.pluginId,
          key: asString(args[0], "key"),
        });
        return null;
      }
      case "storage.keys":
        return invoke<string[]>("plugin_storage_keys", { id: context.pluginId });

      case "notes.list":
        return useNoteStore.getState().notes.map((note) => ({
          id: note.id,
          title: note.title,
          tags: note.tags ?? [],
        }));

      // The tree only needs metadata, so it stays under `notes:read`. `list`
      // deliberately omits `categoryId`; a structure view cannot be built from
      // titles alone.
      case "notes.tree": {
        const state = useNoteStore.getState();
        return {
          folders: state.categories.map((folder) => ({
            id: folder.id,
            name: folder.name,
            parentId: folder.parentId ?? null,
            order: folder.order,
          })),
          notes: state.notes.map((note) => ({
            id: note.id,
            title: note.title,
            categoryId: note.categoryId ?? null,
            order: note.order,
          })),
        };
      }

      case "notes.get": {
        const id = asString(args[0], "id");
        const note = useNoteStore.getState().notes.find((item) => item.id === id);
        if (!note) return null;
        return {
          id: note.id,
          title: note.title,
          tags: note.tags ?? [],
          content: await readNoteBody(note),
        };
      }

      case "notes.create": {
        const input = (args[0] ?? {}) as { title?: unknown; content?: unknown };
        const title = typeof input.title === "string" ? input.title : "";
        const content = typeof input.content === "string" ? input.content : "";
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const store = useNoteStore.getState();
        const previousActive = store.activeNoteId;
        store.addNote({
          id,
          title,
          content,
          tags: [],
          categoryId: null,
          pinned: false,
          order: 0,
          createdAt: now,
          updatedAt: now,
        });
        // A background write must not move the user's cursor to another note.
        store.setActiveNoteId(previousActive);
        await saveNoteContent(id, content);
        return { id };
      }

      case "notes.update": {
        const id = asString(args[0], "id");
        const patch = (args[1] ?? {}) as { title?: unknown; content?: unknown };
        const store = useNoteStore.getState();
        const note = store.notes.find((item) => item.id === id);
        if (!note) throw new PluginError("E_NOT_INSTALLED", `no note with id ${id}`);
        const updates: Partial<Note> = {};
        if (typeof patch.title === "string") updates.title = patch.title;
        if (typeof patch.content === "string") updates.content = patch.content;
        if (Object.keys(updates).length === 0) return null;
        store.updateNote(id, updates);
        if (typeof updates.content === "string") {
          await saveNoteContent(id, updates.content);
          // Same fan-out the AI note writer uses: sticky windows and the open
          // editor have to hear about a write they did not make themselves.
          await emit("sticky:note-updated", { noteId: id, content: updates.content });
          await emit(NOTE_EXTERNAL_SAVE_EVENT, { noteId: id, content: updates.content });
        }
        return null;
      }

      case "editor.getText": {
        const view = requireEditor();
        const doc = view.state.doc;
        // No argument: the whole document. With a range: the same slice a
        // `replace` would touch, so a plugin can count the selection or a
        // heading without copying the whole note into the worker. An empty range
        // is a valid answer (""), not an error — it is what "nothing is
        // selected" means.
        const range = args[0];
        if (range === undefined || range === null) return doc.toString();
        const { from, to } = asDocumentRange(range, doc.length);
        return doc.sliceString(from, to);
      }

      case "editor.getSelection": {
        const view = requireEditor();
        const selection = view.state.selection.main;
        return {
          // `from`/`to` are normalised (`from <= to`); `anchor`/`head` are
          // CodeMirror's own fields, so a plugin can tell which end the caret is
          // on. `text` is always `sliceDoc(from, to)`.
          from: selection.from,
          to: selection.to,
          anchor: selection.anchor,
          head: selection.head,
          text: view.state.sliceDoc(selection.from, selection.to),
        };
      }

      case "editor.replace": {
        const view = requireEditor();
        const { from, to } = asDocumentRange(args[0], view.state.doc.length);
        const text = asString(args[1], "text");
        if (text.length > MAX_EDITOR_INSERT) {
          throw new PluginError(
            "E_TOO_LARGE",
            `replace() was given ${text.length} characters (limit ${MAX_EDITOR_INSERT})`,
          );
        }
        // Deliberately *not* annotated as an external document update, and this
        // is the one line of this feature that must not be "tidied up later".
        // The editor's own update listener has to treat this as a user edit,
        // because that is the single chain that keeps the app consistent:
        // MarkdownSourceEditor's updateListener → handleMdChange
        // (NoteEditor.tsx:365) → updateNote (NoteEditor.tsx:376) + markDirty →
        // autosave/`doSave` (NoteEditor.tsx:196 → saveNoteContent).
        //
        // The annotation exists for the *opposite* direction:
        // MarkdownSourceEditor.tsx:144-156 pushes a value that came from disk
        // into the document and tags it `externalDocumentUpdate` so the
        // listener does not report it back as an edit. Copying that tag here
        // would give us "the text changes on screen and is never saved" — a bug
        // that only shows up after a restart, which is why the discipline is
        // asserted in `scripts/verify-plugin-runtime/run.mjs`.
        //
        // Staying in the normal transaction also keeps the edit in the undo
        // history: the user can Ctrl+Z a plugin's write.
        view.dispatch({ changes: { from, to, insert: text } });
        return null;
      }

      case "editor.setDecorations": {
        const view = requireEditor();
        const key = asString(args[0], "key").slice(0, MAX_DECORATION_KEY_LENGTH);
        const ranges = asDecorationRanges(args[1], view.state.doc.length);
        setPluginDecorations(view, context.pluginId, key, ranges);
        return null;
      }

      case "editor.setSelection": {
        const view = requireEditor();
        const { anchor, head } = asDocumentSelection(args[0], view.state.doc.length);
        // Same discipline as `replace`: a plain change spec, no annotation. The
        // caret move is a real, undoable selection change, and CodeMirror's own
        // scroll-into-view handles the rest — the host does not add a scrolling
        // API on top of it.
        view.dispatch({ selection: { anchor, head } });
        return null;
      }

      case "views.refresh": {
        const viewId = asString(args[0], "viewId");
        if (!context.viewIds.includes(viewId)) {
          // Refreshing someone else's panel would let one plugin redraw another
          // plugin's data; the view ids are the plugin's own, so anything else
          // is a permission failure rather than a typo.
          throw new PluginError(
            "E_PERMISSION_DENIED",
            `views.refresh(${viewId}) is not a view this plugin contributes`,
          );
        }
        notifyViewRefresh(context.pluginId, viewId);
        return null;
      }

      case "canvas.listRefKeys": {
        const input = (args[0] ?? {}) as Record<string, unknown>;
        const boardId = resolveBoardId(input.boardId);
        const store = useCanvasStore.getState();
        const board = store.loaded && store.activeCanvasId === boardId
          ? store.board
          : await loadCanvasBoard(boardId);
        return {
          boardId,
          refKeys: board
            ? board.items.filter((item) => item.type === "ref").map((item) => refKeyOf((item as CanvasRefItem).ref))
            : [],
        };
      }

      case "canvas.upsertRefNodes": {
        const input = (args[0] ?? {}) as Record<string, unknown>;
        const boardId = resolveBoardId(input.boardId);
        const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
        if (rawNodes.length > MAX_REF_NODE_BATCH) {
          throw new PluginError("E_TOO_LARGE", `more than ${MAX_REF_NODE_BATCH} nodes in one call`);
        }
        const nodes = rawNodes.map(asRefNodeInput);
        return withCanvasBoard(boardId, (board) => {
          const existing = indexRefItems(board);
          const items = [...board.items];
          const idByRefKey: Record<string, string> = {};
          let created = 0;
          let updated = 0;
          for (const node of nodes) {
            const hit = existing.get(node.key);
            if (hit) {
              // Position belongs to the user: a re-sync refreshes what the note
              // says, never where the user dragged it.
              updated += 1;
              idByRefKey[node.key] = hit.id;
              const index = items.findIndex((item) => item.id === hit.id);
              items[index] = {
                ...hit,
                title: node.title,
                excerpt: node.excerpt,
                summary: node.summary,
                summaryHash: node.summaryHash,
              };
              continue;
            }
            created += 1;
            const item: CanvasRefItem = {
              id: crypto.randomUUID(),
              type: "ref",
              ref: node.ref,
              title: node.title,
              excerpt: node.excerpt,
              summary: node.summary,
              summaryHash: node.summaryHash,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              rotation: 0,
              zIndex: nextZIndex(items),
            };
            items.push(item);
            idByRefKey[node.key] = item.id;
          }
          return { board: { ...board, items }, result: { idByRefKey, created, updated } };
        });
      }

      case "canvas.upsertRefConnectors": {
        const input = (args[0] ?? {}) as Record<string, unknown>;
        const boardId = resolveBoardId(input.boardId);
        const rawEdges = Array.isArray(input.edges) ? input.edges : [];
        if (rawEdges.length > MAX_REF_NODE_BATCH) {
          throw new PluginError("E_TOO_LARGE", `more than ${MAX_REF_NODE_BATCH} edges in one call`);
        }
        const edges = rawEdges.map((value) => {
          const raw = (value ?? {}) as Record<string, unknown>;
          const style: CanvasConnectorStyle = raw.style === "curve" || raw.style === "orthogonal"
            ? raw.style
            : "straight";
          return {
            from: asBoundedText(raw.from, "edge.from", MAX_REF_KEY),
            to: asBoundedText(raw.to, "edge.to", MAX_REF_KEY),
            style,
            startAnchor: asCanvasAnchor(raw.startAnchor, "right"),
            endAnchor: asCanvasAnchor(raw.endAnchor, "left"),
          };
        });
        return withCanvasBoard(boardId, (board) => {
          const index = indexRefItems(board);
          const items = [...board.items];
          const existingEdges = new Set<string>();
          for (const item of board.items) {
            if (item.type !== "connector" || !item.startBinding || !item.endBinding) continue;
            existingEdges.add(`${item.startBinding.itemId}->${item.endBinding.itemId}`);
          }
          let created = 0;
          for (const edge of edges) {
            const from = index.get(edge.from);
            const to = index.get(edge.to);
            if (!from || !to) continue;
            const key = `${from.id}->${to.id}`;
            if (existingEdges.has(key)) continue;
            existingEdges.add(key);
            items.push({
              id: crypto.randomUUID(),
              type: "connector",
              style: edge.style,
              stroke: "var(--color-border)",
              strokeWidth: 1.5,
              endArrow: false,
              startBinding: { itemId: from.id, anchor: edge.startAnchor },
              endBinding: { itemId: to.id, anchor: edge.endAnchor },
              x: from.x,
              y: from.y,
              width: Math.max(0, to.x - from.x),
              height: Math.max(0, to.y - from.y),
              rotation: 0,
              zIndex: nextZIndex(items),
            });
            created += 1;
          }
          return { board: { ...board, items }, result: { created } };
        });
      }

      case "canvas.setNodesHidden": {
        const input = (args[0] ?? {}) as Record<string, unknown>;
        const boardId = resolveBoardId(input.boardId);
        const keys = new Set(
          (Array.isArray(input.refKeys) ? input.refKeys : [])
            .map((value) => asBoundedText(value, "refKey", MAX_REF_KEY)),
        );
        const hidden = input.hidden === true;
        return withCanvasBoard(boardId, (board) => {
          let changed = 0;
          const items = board.items.map((item) => {
            if (item.type !== "ref" || !keys.has(refKeyOf(item.ref))) return item;
            if ((item.hidden ?? false) === hidden) return item;
            changed += 1;
            return { ...item, hidden };
          });
          return { board: { ...board, items }, result: { changed } };
        });
      }

      case "canvas.removeRefNodes": {
        const input = (args[0] ?? {}) as Record<string, unknown>;
        const boardId = resolveBoardId(input.boardId);
        const keys = new Set(
          (Array.isArray(input.refKeys) ? input.refKeys : [])
            .map((value) => asBoundedText(value, "refKey", MAX_REF_KEY)),
        );
        return withCanvasBoard(boardId, (board) => {
          const index = indexRefItems(board);
          const doomed = new Set<string>();
          let removed = 0;
          for (const key of keys) {
            const hit = index.get(key);
            if (!hit) continue;
            doomed.add(hit.id);
            removed += 1;
          }
          const items = board.items.filter((item) => {
            if (doomed.has(item.id)) return false;
            if (item.type !== "connector") return true;
            if (item.startBinding && doomed.has(item.startBinding.itemId)) return false;
            if (item.endBinding && doomed.has(item.endBinding.itemId)) return false;
            return true;
          });
          return { board: { ...board, items }, result: { removed } };
        });
      }

      case "ai.summarize": {
        const noteId = asString(args[0], "noteId");
        const note = useNoteStore.getState().notes.find((item) => item.id === noteId);
        if (!note) throw new PluginError("E_INVALID_ARGUMENT", `no note ${noteId}`);
        const markdown = storedContentToMarkdown(await readNoteBody(note)).trim();
        if (!markdown) return null;
        const resolved = resolveAiSelection(useAiStore.getState().polishModel);
        if (!resolved) {
          throw new PluginError("E_NO_PROVIDER", "no AI endpoint and model are configured");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
        try {
          const card = await generateSummaryCard({
            apiKey: resolved.apiKey,
            provider: resolved.provider,
            model: resolved.model,
            text: markdown,
            lang: useSettingsStore.getState().lang,
            thinkingLevel: "low",
            signal: controller.signal,
          });
          return { summary: card.summary.trim(), title: card.title };
        } finally {
          clearTimeout(timer);
        }
      }

      case "todo.list":
        return useTodoStore.getState().todos.map((todo) => ({
          id: todo.id,
          title: todo.title,
          completed: todo.completed,
          priority: todo.priority,
          dueDate: todo.dueDate,
        }));

      case "todo.create": {
        const input = (args[0] ?? {}) as { title?: unknown };
        const title = typeof input.title === "string" ? input.title.trim() : "";
        if (!title) throw new PluginError("E_INTERNAL", "a todo needs a title");
        const store = useTodoStore.getState();
        if (!store.activeListId) {
          throw new PluginError("E_INTERNAL", "there is no active todo list");
        }
        const before = new Set(store.todos.map((todo) => todo.id));
        store.addTodo(title);
        const created = useTodoStore.getState().todos.find((todo) => !before.has(todo.id));
        if (!created) throw new PluginError("E_INTERNAL", "the todo could not be created");
        return { id: created.id };
      }

      case "todo.update": {
        const id = asString(args[0], "id");
        const patch = (args[1] ?? {}) as { title?: unknown; completed?: unknown };
        const store = useTodoStore.getState();
        if (!store.todos.some((todo) => todo.id === id)) {
          throw new PluginError("E_INTERNAL", `no todo with id ${id}`);
        }
        const updates: Partial<Todo> = {};
        if (typeof patch.title === "string") updates.title = patch.title;
        if (typeof patch.completed === "boolean") updates.completed = patch.completed;
        if (Object.keys(updates).length === 0) return null;
        store.updateTodo(id, updates);
        return null;
      }

      case "clipboard.read":
        return invoke<string>("clipboard_read");

      case "clipboard.write": {
        await invoke("clipboard_write", { text: asString(args[0], "text") });
        return null;
      }

      case "ui.toast": {
        const message = asString(args[0], "message").slice(0, 500);
        const tone = args[1];
        const resolved: Tone =
          tone === "success" || tone === "danger" || tone === "info" ? tone : "info";
        toast(message, resolved);
        return null;
      }

      default:
        throw new PluginError("E_INTERNAL", `unknown host call ${namespace}.${method}`);
    }
  } catch (error) {
    throw toPluginError(error);
  }
}
