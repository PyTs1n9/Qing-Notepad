/**
 * Fingerprint of everything `notes/index.json` stores.
 *
 * The note store keeps each note body in the same object as its metadata, so
 * every keystroke produces a new `notes` array and re-runs the auto-save effect.
 * Comparing this fingerprint first is what keeps the index write at "metadata
 * changed" instead of "a key was pressed".
 *
 * `updatedAt` is deliberately **not** part of it: `updateNote` bumps it on every
 * keystroke, so including it would make the fingerprint differ every time and the
 * check would do nothing. The stored timestamp therefore lags until the next real
 * metadata edit, and no reader depends on it.
 */
export interface IndexedNoteMetadata {
  id: string;
  title: string;
  tags: string[];
  categoryId?: string | null;
  /** Present once a note is linked to a file outside the notebook. */
  sourcePath?: string | null;
  pinned?: boolean;
  order: number;
}

export interface IndexedCategoryMetadata {
  id: string;
  name: string;
  order: number;
  parentId?: string | null;
  pinned?: boolean;
}

const FIELD = "\u0001";
const NOTE = "\u0002";
const SECTION = "\u0003";

export function noteIndexFingerprint(
  notes: readonly IndexedNoteMetadata[],
  categories: readonly IndexedCategoryMetadata[],
): string {
  const notePart = notes
    .map((note) =>
      [
        note.id,
        note.title,
        note.tags.join(","),
        note.categoryId ?? "",
        note.sourcePath ?? "",
        note.pinned ? 1 : 0,
        note.order,
      ].join(FIELD))
    .join(NOTE);
  const categoryPart = categories
    .map((category) =>
      [category.id, category.name, category.order, category.parentId ?? "", category.pinned ? 1 : 0]
        .join(FIELD))
    .join(NOTE);
  return `${notePart}${SECTION}${categoryPart}`;
}
