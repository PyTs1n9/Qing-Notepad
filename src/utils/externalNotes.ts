/**
 * Files opened from Explorer ("打开方式 → Qing Notepad").
 *
 * The association itself is written by the installer
 * (`src-tauri/windows/installer-hooks.nsh`); this module is the renderer half:
 *
 *   argv → Rust queue → main window drains → detached window
 *        → autosave writes the source file through `external_note_write`
 *        → "返回主软件" adds an index entry that keeps pointing at that file
 *
 * Three rules keep that honest:
 *
 * 1. Before the note is in the notebook, the window edits the user's file
 *    directly. There is no draft copy in between, so closing the window cannot
 *    leave an edit stranded in `<data>/external-drafts`.
 * 2. After it is in the notebook, the source stays the authority and
 *    `notes/<id>.md` is a mirror rewritten on every save. Losing the app data
 *    directory therefore loses the index, not the text.
 * 3. The note id is derived from the canonical path by Rust (`ext-<fnv1a64>`),
 *    so the same file always addresses the same note. A file that was imported
 *    by an older build has a copy but no `sourcePath`; opening it again adopts
 *    the source instead of leaving two divergent copies behind.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useNoteStore } from "@/stores/noteStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { toast } from "@/stores/toastStore";
import { openNoteWindow } from "@/utils/noteWindow";
import { loadNoteContent, registerLinkedNoteSource, writeNoteMirror } from "@/utils/storage";
import { t } from "@/utils/i18n";

/** A file path arrived; drain `takeLaunchFiles`. */
export const EXTERNAL_OPEN_EVENT = "external-note:open";
/** The detached window asked to add its file to the notebook. */
export const EXTERNAL_ADD_EVENT = "external-note:add";

export interface ExternalNoteInfo {
  id: string;
  path: string;
  title: string;
  content: string;
}

export interface ExternalImportResult {
  id: string;
  outcome: "imported" | "existing";
}

const EMPTY: string[] = [];

/** Paths Explorer passed on the command line, or to a second instance. */
export async function takeLaunchFiles(): Promise<string[]> {
  if (!isTauri()) return EMPTY;
  try {
    return await invoke<string[]>("external_take_launch");
  } catch (error) {
    console.error("Failed to take the external launch queue:", error);
    return EMPTY;
  }
}

/** Window → main window: "put this file in the notebook". */
export async function requestAddToNotebook(note: ExternalNoteInfo): Promise<void> {
  await emit(EXTERNAL_ADD_EVENT, note);
}

function currentLang() {
  return useSettingsStore.getState().lang === "en" ? "en" : "zh";
}

/**
 * Older builds imported a copy under `ext-<hash>` and never stored the path, so
 * the copy cannot be traced back automatically. The user opening the same file
 * again is the only reliable signal; at that point the source becomes the
 * authority and an edited copy is preserved as its own note rather than
 * silently overwritten.
 */
async function adoptLegacyCopy(noteId: string, info: ExternalNoteInfo): Promise<void> {
  const store = useNoteStore.getState();
  const existing = store.notes.find((note) => note.id === noteId);
  if (!existing) return;

  const legacy = await loadNoteContent(noteId);
  const same =
    legacy.replace(/\r\n/g, "\n").trim() === info.content.replace(/\r\n/g, "\n").trim();

  if (!same && legacy.trim()) {
    const copyId = crypto.randomUUID();
    await writeNoteMirror(copyId, legacy);
    const now = new Date().toISOString();
    const suffix = currentLang() === "en" ? " (old copy)" : "（旧副本）";
    store.addNote({
      id: copyId,
      title: `${existing.title || info.title}${suffix}`,
      content: legacy,
      tags: [],
      categoryId: existing.categoryId ?? null,
      pinned: false,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    // `addNote` selects the new note; the file the user just double-clicked is
    // the one that should be active.
    useNoteStore.setState({ activeNoteId: noteId });
  }

  store.updateNote(noteId, { sourcePath: info.path, content: info.content });
  registerLinkedNoteSource(noteId, info.path, { mirror: true });
  await writeNoteMirror(noteId, info.content);

  if (!same && legacy.trim()) {
    toast(t(currentLang(), "externalLegacyCopyKept"), "info");
  }
}

/**
 * Open one path. A note that already exists in the notebook is shown from there
 * (its body still comes from the source file); anything else is shown as a
 * file-backed window that does not appear in the tree until the user asks.
 */
export async function openExternalPath(path: string): Promise<void> {
  if (!isTauri()) return;
  let info: ExternalNoteInfo;
  try {
    info = await invoke<ExternalNoteInfo>("external_open_path", { path });
  } catch (error) {
    console.error("Failed to open the external markdown file:", path, error);
    return;
  }

  const existing = useNoteStore.getState().notes.find((note) => note.id === info.id);
  if (existing && !existing.sourcePath) {
    await adoptLegacyCopy(info.id, info);
  }

  try {
    await openNoteWindow(info.id, info.title, {
      external: !existing,
      // The index may not have the freshly adopted `sourcePath` yet; hand it
      // over directly so the window writes to the file, not to the mirror.
      sourcePath: existing ? info.path : undefined,
    });
  } catch (error) {
    console.error("Failed to create the note window:", error);
  }
}

/**
 * Turn a queued file into a linked note under 未分类笔记.
 *
 * The body is already on disk (the window flushed before asking), so this only
 * writes the mirror and the index entry. Content first, metadata second: a
 * crash in between leaves a `.md` that `loadNoteList()` recovers, whereas the
 * reverse order would leave an index entry pointing at nothing.
 */
export async function addToNotebook(note: ExternalNoteInfo): Promise<ExternalImportResult> {
  const store = useNoteStore.getState();
  const existing = store.notes.some((item) => item.id === note.id);

  if (existing) {
    store.updateNote(note.id, { sourcePath: note.path });
    registerLinkedNoteSource(note.id, note.path, { mirror: true });
    await writeNoteMirror(note.id, note.content);
    return { id: note.id, outcome: "existing" };
  }

  registerLinkedNoteSource(note.id, note.path, { mirror: true });
  await writeNoteMirror(note.id, note.content);
  const now = new Date().toISOString();
  store.addNote({
    id: note.id,
    title: note.title,
    content: note.content,
    tags: [],
    // Explicit null, not `undefined`: `addNote` would otherwise inherit the
    // folder the user happens to have selected.
    categoryId: null,
    sourcePath: note.path,
    pinned: false,
    order: 0,
    createdAt: now,
    updatedAt: now,
  });
  return { id: note.id, outcome: "imported" };
}
