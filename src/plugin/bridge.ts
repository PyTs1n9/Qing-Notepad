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
import { useNoteStore } from "@/stores/noteStore";
import { useTodoStore } from "@/stores/todoStore";
import { toast } from "@/stores/toastStore";
import { loadNoteContent, saveNoteContent } from "@/utils/storage";
import { NOTE_EXTERNAL_SAVE_EVENT } from "@/utils/ai/noteWrite";
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
};

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
