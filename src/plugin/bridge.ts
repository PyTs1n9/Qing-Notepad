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
import { toast } from "@/stores/toastStore";
import { loadNoteContent, saveNoteContent } from "@/utils/storage";
import { NOTE_EXTERNAL_SAVE_EVENT } from "@/utils/ai/noteWrite";
import {
  DECORATION_KINDS,
  MAX_DECORATION_RANGES,
  getActiveEditor,
  isDecorationKind,
  setPluginDecorations,
  type DecorationRange,
} from "@/utils/editorHandle";
import type { Note, Todo } from "@/types";
import { hasPermission, PluginError, toPluginError, type PluginPermission } from "./types";

export interface PluginBridgeContext {
  pluginId: string;
  permissions: readonly string[];
}

type Tone = "info" | "success" | "danger";

/** Which permission each host method needs. `null` means "no permission". */
const REQUIREMENTS: Record<string, Record<string, PluginPermission | null>> = {
  storage: { get: "storage", set: "storage", delete: "storage", keys: "storage" },
  notes: { list: "notes:read", get: "notes:read", create: "notes:write", update: "notes:write" },
  todo: { list: "todo:read", create: "todo:write", update: "todo:write" },
  clipboard: { read: "clipboard:read", write: "clipboard:write" },
  ui: { toast: "notify" },
  // P1a. Three codes for one namespace, and no implication between them: being
  // allowed to rewrite the document does not hand a plugin the text.
  editor: {
    getText: "editor:read",
    getSelection: "editor:read",
    replace: "editor:write",
    setDecorations: "editor:decorate",
  },
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

/** Note bodies are stored as editor HTML; plugins get readable text. */
function toPlainText(content: string): string {
  if (!/<\/?[a-z][\s\S]*>/i.test(content)) return content;
  try {
    const parsed = new DOMParser().parseFromString(content, "text/html");
    // `parseFromString` never executes scripts, and the result is text only.
    return (parsed.body.textContent ?? "").trim();
  } catch {
    return content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

async function readNoteBody(note: Note): Promise<string> {
  const state = useNoteStore.getState();
  const raw = note.id === state.activeNoteId ? note.content : await loadNoteContent(note.id);
  return toPlainText(raw);
}

// ---------------------------------------------------------------------------
// Editor (P1a)
//
// Positions are CodeMirror document offsets — `0 … view.state.doc.length`, UTF-16
// code units against the Markdown source that gets written to disk. See
// `editorHandle.ts` for why this editor and not ProseMirror.
//
// The text a plugin reads and writes is **Markdown source**, never HTML. The
// storage layer holds editor HTML, and `NoteEditor.tsx:291` converts it on load
// (`isStoredEditorHtml(content) ? htmlToMarkdown(content) : content`); a plugin
// that went around the editor and produced HTML would skip that normalisation
// — and turndown's rules at `NoteEditor.tsx:60` / `:69` — which is how format
// drift accumulates. Writing through `dispatch` is always on the Markdown side.
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
