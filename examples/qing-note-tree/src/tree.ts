/**
 * Folder tree + note placement → one tree the layout can walk.
 *
 * The note store already encodes containment (`note.categoryId`,
 * `folder.parentId`), so this is pure assembly. Two inputs are hostile and have
 * to be handled rather than trusted:
 *
 * - **A dangling `parentId`** (the folder was deleted between the read and the
 *   render). The child is adopted by the root instead of disappearing.
 * - **A cycle** (`A.parent = B`, `B.parent = A`, which older imports produced).
 *   A node whose parent chain never terminates is also adopted by the root, so
 *   the layout cannot recurse forever.
 */

interface QingNoteTreeData {
  folders: QingFolderSummary[];
  notes: QingNoteSummary[];
}

export interface TreeNode {
  /** `note:<id>` / `folder:<id>` / `root` — the key the canvas upserts by. */
  key: string;
  ref: QingRefTarget;
  title: string;
  order: number;
  children: TreeNode[];
}

function folderKey(id: string): string {
  return `folder:${id}`;
}

function noteKey(id: string): string {
  return `note:${id}`;
}

/** True when the folder's parent chain terminates; false means it is a cycle. */
function reachesTop(id: string, byId: Map<string, QingFolderSummary>): boolean {
  let cursor = byId.get(id)?.parentId ?? null;
  let guard = 0;
  while (cursor) {
    if (guard > byId.size) return false;
    const parent = byId.get(cursor);
    if (!parent) return true;
    cursor = parent.parentId ?? null;
    guard += 1;
  }
  return true;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    const rankA = a.ref.kind === "note" ? 1 : 0;
    const rankB = b.ref.kind === "note" ? 1 : 0;
    if (rankA !== rankB) return rankA - rankB;
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title);
  });
  for (const child of node.children) sortTree(child);
}

export function buildTree(data: QingNoteTreeData, rootLabel: string): TreeNode {
  const root: TreeNode = {
    key: "root",
    ref: { kind: "root", label: rootLabel },
    title: rootLabel,
    order: 0,
    children: [],
  };

  const byId = new Map(data.folders.map((folder) => [folder.id, folder]));
  const folderNodes = new Map<string, TreeNode>();
  for (const folder of data.folders) {
    folderNodes.set(folder.id, {
      key: folderKey(folder.id),
      ref: { kind: "folder", id: folder.id },
      title: folder.name,
      order: folder.order,
      children: [],
    });
  }

  for (const folder of data.folders) {
    const node = folderNodes.get(folder.id);
    if (!node) continue;
    const parent = folder.parentId ? folderNodes.get(folder.parentId) : undefined;
    // A missing parent and a cyclic chain are the same outcome for the user:
    // the folder still has to appear somewhere, so it lands at the top level.
    if (parent && reachesTop(folder.id, byId)) parent.children.push(node);
    else root.children.push(node);
  }

  for (const note of data.notes) {
    const node: TreeNode = {
      key: noteKey(note.id),
      ref: { kind: "note", id: note.id },
      title: note.title,
      order: note.order,
      children: [],
    };
    const parent = note.categoryId ? folderNodes.get(note.categoryId) : undefined;
    (parent ?? root).children.push(node);
  }

  sortTree(root);
  return root;
}

/** Depth-first walk in draw order: parent before its children. */
export function flattenTree(root: TreeNode): Array<{ node: TreeNode; parent: TreeNode | null; depth: number }> {
  const out: Array<{ node: TreeNode; parent: TreeNode | null; depth: number }> = [];
  const visit = (node: TreeNode, parent: TreeNode | null, depth: number) => {
    out.push({ node, parent, depth });
    for (const child of node.children) visit(child, node, depth + 1);
  };
  visit(root, null, 0);
  return out;
}
