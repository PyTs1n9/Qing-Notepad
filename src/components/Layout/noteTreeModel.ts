import { UNCATEGORIZED_CATEGORY_ID } from "@/stores/noteStore";
import type { Note, NoteCategory } from "@/types";

/**
 * Indentation for one nesting level. Steps shrink with depth so an endlessly
 * nested tree inside a 240–320px sidebar never eats the whole row width.
 */
export const TREE_INDENT_STEPS = [14, 10, 7] as const;
export const TREE_INDENT_MIN_STEP = 6;

export function getTreeIndent(depth: number): number {
  let total = 0;
  for (let level = 0; level < depth; level += 1) {
    total += TREE_INDENT_STEPS[level] ?? TREE_INDENT_MIN_STEP;
  }
  return total;
}

const ROOT_PARENT_KEY = "__tree-root__";

export interface NoteTreeFilter {
  searchQuery: string;
  filterTag: string | null;
}

export interface NoteTreeFolder {
  id: string;
  name: string;
  parentId: string | null;
  pinned: boolean;
  /** Virtual folders (uncategorized) reject rename, delete and pin. */
  virtual: boolean;
  /** True when the folder is kept by the active filter because its name matched. */
  matchedByName: boolean;
  folders: NoteTreeFolder[];
  notes: Note[];
  /** Notes in this folder plus every descendant folder. */
  descendantNoteCount: number;
}

export interface TreeFolderRow {
  kind: "folder";
  folder: NoteTreeFolder;
  depth: number;
  noteCount: number;
  folderCount: number;
  expanded: boolean;
}

export interface TreeNoteRow {
  kind: "note";
  note: Note;
  /** Folder the note is rendered under; null means the uncategorized folder. */
  folderId: string | null;
  depth: number;
}

export type TreeRow = TreeFolderRow | TreeNoteRow;

function compareNotes(a: Note, b: Note): number {
  if ((a.pinned ?? false) !== (b.pinned ?? false)) return a.pinned ? -1 : 1;
  return (a.order ?? 0) - (b.order ?? 0);
}

function compareCategories(a: NoteCategory, b: NoteCategory): number {
  if ((a.pinned ?? false) !== (b.pinned ?? false)) return a.pinned ? -1 : 1;
  return (a.order ?? 0) - (b.order ?? 0);
}

interface BuildContext {
  query: string;
  hasFilter: boolean;
  matches: (note: Note) => boolean;
  notesByFolder: Map<string, Note[]>;
  childrenByParent: Map<string, NoteCategory[]>;
}

function isFolderVisible(folder: NoteTreeFolder, hasFilter: boolean): boolean {
  if (!hasFilter) return true;
  return folder.matchedByName || folder.notes.length > 0 || folder.folders.length > 0;
}

function buildFolder(
  category: NoteCategory,
  parentId: string | null,
  includeAllDescendants: boolean,
  ctx: BuildContext,
  visited: Set<string>,
): NoteTreeFolder {
  visited.add(category.id);

  const matchedByName = Boolean(ctx.query) && category.name.toLowerCase().includes(ctx.query);
  const includeAll = includeAllDescendants || matchedByName;
  const ownNotes = ctx.notesByFolder.get(category.id) ?? [];
  const notes = (includeAll ? ownNotes : ownNotes.filter(ctx.matches))
    .slice()
    .sort(compareNotes);
  const folders = (ctx.childrenByParent.get(category.id) ?? [])
    .filter((child) => !visited.has(child.id))
    .sort(compareCategories)
    .map((child) => buildFolder(child, category.id, includeAll, ctx, visited))
    .filter((child) => isFolderVisible(child, ctx.hasFilter));

  const descendantNoteCount = notes.length
    + folders.reduce((total, child) => total + child.descendantNoteCount, 0);

  return {
    id: category.id,
    name: category.name,
    parentId,
    pinned: category.pinned === true,
    virtual: false,
    matchedByName,
    folders,
    notes,
    descendantNoteCount,
  };
}

/**
 * Builds the folder/note tree used by the sidebar.
 *
 * Notes pointing at a missing category fall into the uncategorized folder, and
 * folders whose `parentId` dangles (or loops) are re-parented to the root so
 * corrupt indexes never hide data.
 */
export function buildNoteTree(
  notes: Note[],
  categories: NoteCategory[],
  filter: NoteTreeFilter,
  uncategorizedLabel: string,
): NoteTreeFolder[] {
  const query = filter.searchQuery.trim().toLowerCase();
  const hasFilter = Boolean(query) || Boolean(filter.filterTag);
  const knownCategoryIds = new Set(categories.map((category) => category.id));

  const matches = (note: Note): boolean => {
    if (filter.filterTag && !note.tags.includes(filter.filterTag)) return false;
    if (!query) return true;
    return (
      note.title.toLowerCase().includes(query) ||
      note.content.toLowerCase().includes(query)
    );
  };

  const notesByFolder = new Map<string, Note[]>();
  for (const note of notes) {
    const folderId =
      note.categoryId && knownCategoryIds.has(note.categoryId)
        ? note.categoryId
        : UNCATEGORIZED_CATEGORY_ID;
    const bucket = notesByFolder.get(folderId) ?? [];
    bucket.push(note);
    notesByFolder.set(folderId, bucket);
  }

  const childrenByParent = new Map<string, NoteCategory[]>();
  for (const category of categories) {
    const parentKey =
      category.parentId && knownCategoryIds.has(category.parentId)
        ? category.parentId
        : ROOT_PARENT_KEY;
    const bucket = childrenByParent.get(parentKey) ?? [];
    bucket.push(category);
    childrenByParent.set(parentKey, bucket);
  }

  const ctx: BuildContext = { query, hasFilter, matches, notesByFolder, childrenByParent };
  const visited = new Set<string>();

  const folders = (childrenByParent.get(ROOT_PARENT_KEY) ?? [])
    .sort(compareCategories)
    .map((category) => buildFolder(category, null, false, ctx, visited))
    // Categories trapped in a parentId loop are never reached from the root.
    .filter((folder) => isFolderVisible(folder, hasFilter));

  const looseNotes = (notesByFolder.get(UNCATEGORIZED_CATEGORY_ID) ?? [])
    .filter(matches)
    .slice()
    .sort(compareNotes);

  const uncategorized: NoteTreeFolder = {
    id: UNCATEGORIZED_CATEGORY_ID,
    name: uncategorizedLabel,
    parentId: null,
    pinned: false,
    virtual: true,
    matchedByName: false,
    folders: [],
    notes: looseNotes,
    descendantNoteCount: looseNotes.length,
  };

  if (isFolderVisible(uncategorized, hasFilter)) folders.push(uncategorized);

  return folders;
}

export function collectFolderIds(folders: NoteTreeFolder[], into: string[] = []): string[] {
  for (const folder of folders) {
    into.push(folder.id);
    collectFolderIds(folder.folders, into);
  }
  return into;
}

/**
 * Every folder row the explorer can fold while no filter is active: all real
 * categories plus the virtual uncategorized bucket, which the tree renders even
 * when it holds no notes.
 *
 * Folder-level bulk actions ("expand all" / "collapse all") cover the whole
 * explorer, so this list deliberately ignores the active search / tag filter:
 * a filter only hides rows, it never creates or removes a folder.
 */
export function collectExplorerFolderIds(categories: NoteCategory[]): string[] {
  return [...categories.map((category) => category.id), UNCATEGORIZED_CATEGORY_ID];
}

export function isFolderExpanded(expandedIds: string[] | null, id: string): boolean {
  // `null` means the user never collapsed anything, so everything starts open.
  if (expandedIds === null) return true;
  return expandedIds.includes(id);
}

export function flattenNoteTree(
  folders: NoteTreeFolder[],
  isExpanded: (id: string) => boolean,
  depth = 0,
  into: TreeRow[] = [],
): TreeRow[] {
  for (const folder of folders) {
    const expanded = isExpanded(folder.id);
    into.push({
      kind: "folder",
      folder,
      depth,
      noteCount: folder.descendantNoteCount,
      folderCount: folder.folders.length,
      expanded,
    });
    if (!expanded) continue;
    flattenNoteTree(folder.folders, isExpanded, depth + 1, into);
    for (const note of folder.notes) {
      into.push({
        kind: "note",
        note,
        folderId: folder.virtual ? null : folder.id,
        depth: depth + 1,
      });
    }
  }
  return into;
}
