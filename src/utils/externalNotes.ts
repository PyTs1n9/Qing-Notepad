/**
 * Files opened from Explorer ("打开方式 → Qing Notepad").
 *
 * The association itself is written by the installer
 * (`src-tauri/windows/installer-hooks.nsh`); this module is the renderer half:
 *
 *   argv → Rust queue → main window drains → detached window (draft)
 *        → "返回主软件" → Rust pending queue → main window imports
 *
 * Two rules keep that from turning into duplicates:
 *
 * 1. The note id is derived from the canonical file path by Rust
 *    (`ext-<fnv1a64>`), so the same file always addresses the same note.
 * 2. The import checks `notes` before writing. The check reads the Zustand
 *    store through `getState()`, not a value captured in a render, because two
 *    drains can land in the same tick.
 *
 * The index itself is written only by `App.tsx`'s autosave effect: the note
 * window never touches `notes/index.json`, because a second writer would let two
 * concurrent saves overwrite each other's entry.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useNoteStore } from "@/stores/noteStore";
import { openNoteWindow } from "@/utils/noteWindow";
import { deleteExternalDraft, saveNoteContent } from "@/utils/storage";

/** A file path arrived; drain `takeLaunchFiles`. */
export const EXTERNAL_OPEN_EVENT = "external-note:open";
/** A draft was committed; drain `takePendingExternalNotes`. */
export const EXTERNAL_PENDING_EVENT = "external-note:pending";

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

/** Committed drafts waiting for the notebook. */
export async function takePendingExternalNotes(): Promise<ExternalNoteInfo[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<ExternalNoteInfo[]>("external_take_pending");
  } catch (error) {
    console.error("Failed to take the external import queue:", error);
    return [];
  }
}

/**
 * Open one path. A note that already exists in the store is shown from the
 * notebook; anything else is shown in draft mode, which does not write into
 * `notes/` until the user asks for it.
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

  const exists = useNoteStore.getState().notes.some((note) => note.id === info.id);
  try {
    await openNoteWindow(info.id, info.title, { external: !exists });
  } catch (error) {
    console.error("Failed to create the note window:", error);
  }
}

/** Hand the buffer to the main window; called by "返回主软件". */
export async function commitExternalNote(id: string, content: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("external_note_commit", { id, content });
}

/**
 * Turn one queued draft into a note under 未分类笔记.
 *
 * Content first, metadata second: a crash in between leaves an unindexed `.md`
 * that `loadNoteList()` recovers as an uncategorized note, whereas the reverse
 * order would leave an index entry pointing at a file that does not exist.
 */
export async function importExternalNote(note: ExternalNoteInfo): Promise<ExternalImportResult> {
  const store = useNoteStore.getState();
  if (store.notes.some((existing) => existing.id === note.id)) {
    // Reopened after an import (or a second window beat us to it). The draft is
    // stale by definition; the note on disk is the one the user is editing.
    await deleteExternalDraft(note.id);
    return { id: note.id, outcome: "existing" };
  }

  await saveNoteContent(note.id, note.content);
  const now = new Date().toISOString();
  store.addNote({
    id: note.id,
    title: note.title,
    content: note.content,
    tags: [],
    // Explicit null, not `undefined`: `addNote` would otherwise inherit the
    // folder the user happens to have selected.
    categoryId: null,
    pinned: false,
    order: 0,
    createdAt: now,
    updatedAt: now,
  });
  await deleteExternalDraft(note.id);
  return { id: note.id, outcome: "imported" };
}

/**
 * Import everything queued. The last imported note becomes active because
 * `addNote` sets `activeNoteId`; the caller only has to switch views.
 */
export async function importPendingExternalNotes(): Promise<{ imported: number; existing: number }> {
  const pending = await takePendingExternalNotes();
  let imported = 0;
  let existing = 0;
  for (const note of pending) {
    const result = await importExternalNote(note);
    if (result.outcome === "imported") imported += 1;
    else existing += 1;
  }
  return { imported, existing };
}
