import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileDown,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  SearchX,
  Trash2,
} from "lucide-react";
import {
  buildNoteTree,
  collectFolderIds,
  flattenNoteTree,
  getTreeIndent,
  isFolderExpanded,
  type NoteTreeFolder,
  type TreeRow,
} from "@/components/Layout/noteTreeModel";
import TreeContextMenu, { type TreeMenuItem } from "@/components/Layout/TreeContextMenu";
import MoveToFolderDialog, { type MoveTarget } from "@/components/Layout/MoveToFolderDialog";
import EmptyState from "@/components/Layout/EmptyState";
import { UNCATEGORIZED_CATEGORY_ID, useNoteStore } from "@/stores/noteStore";
import { useTabStore } from "@/stores/tabStore";
import { useSettingsStore, type LangType } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { deleteNoteToTrash } from "@/utils/noteDeletion";
import type { Note, NoteCategory } from "@/types";

interface NoteTreeProps {
  lang: LangType;
  onOpenNote: (noteId: string) => void;
  onRequestDeleteNote: (note: Note) => void;
  onRequestDeleteCategory: (category: NoteCategory) => void;
  /** Creates a note inside `folderId` (uncategorized uses the sentinel id). */
  onRequestNewNote: (folderId: string | null) => void;
  /** Creates an unnamed folder immediately; `parentId` nests it. */
  onRequestNewCategory: (parentId: string | null) => void;
  /** Exports this note as a file — the same handler the tab strip and editor toolbar use. */
  onExportNote: (note: Note) => void;
  /** Folder created from outside the tree that still needs an inline rename. */
  autoRenameCategoryId?: string | null;
  onAutoRenameHandled?: () => void;
}

type DropTarget =
  | { kind: "folder"; id: string }
  | { kind: "folder-insert"; id: string; position: "before" | "after" }
  | { kind: "note"; id: string; position: "before" | "after" };

const folderAssignableId = (folderId: string | null) =>
  folderId === UNCATEGORIZED_CATEGORY_ID ? null : folderId;

const NoteTree: React.FC<NoteTreeProps> = ({
  lang,
  onOpenNote,
  onRequestDeleteNote,
  onRequestDeleteCategory,
  onRequestNewNote,
  onRequestNewCategory,
  onExportNote,
  autoRenameCategoryId = null,
  onAutoRenameHandled,
}) => {
  const {
    notes,
    categories,
    searchQuery,
    filterTag,
    activeNoteId,
    activeCategoryId,
    setActiveCategoryId,
    updateCategory,
    updateNote,
    reorderNotes,
    togglePinned,
    toggleCategoryPinned,
    moveCategory,
    moveCategoryBeside,
    deleteCategory,
  } = useNoteStore();
  const expandedIds = useSettingsStore((s) => s.expandedFolderIds);
  const setExpandedFolderIds = useSettingsStore((s) => s.setExpandedFolderIds);

  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteTitle, setEditingNoteTitle] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; row: TreeRow | null } | null>(null);
  const [moveDialogNote, setMoveDialogNote] = useState<Note | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const dragCloneRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Remembers whether the last row picked was a note; Delete only acts on that.
  const lastSelectionRef = useRef<"note" | "folder" | null>(null);
  // A drag also emits a click when it ends on the row it started from; that
  // click must not select (or collapse) the row.
  const suppressClickRef = useRef(false);
  // Roving tabindex: exactly one row sits in the tab order, so Tab does not walk
  // through the entire tree.
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);

  const rowTabIndex = (kind: "folder" | "note", id: string, index: number) => {
    const key = `${kind}:${id}`;
    if (focusedRowKey) return focusedRowKey === key ? 0 : -1;
    return index === 0 ? 0 : -1;
  };

  const tree = useMemo(
    () =>
      buildNoteTree(notes, categories, { searchQuery, filterTag }, t(lang, "uncategorizedNotes")),
    [notes, categories, searchQuery, filterTag, lang],
  );
  const allFolderIds = useMemo(() => collectFolderIds(tree), [tree]);
  // While filtering, every surviving branch is opened so hits are never hidden
  // behind a collapsed folder.
  const forceExpand = searchQuery.trim().length > 0 || Boolean(filterTag);

  const isExpanded = (id: string) => forceExpand || isFolderExpanded(expandedIds, id);

  // Every folder nested under the selected one, so its rows can be tinted.
  const activeSubtreeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!activeCategoryId || activeCategoryId === UNCATEGORIZED_CATEGORY_ID) return ids;
    const stack: string[] = [activeCategoryId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const category of categories) {
        if ((category.parentId ?? null) === current && !ids.has(category.id)) {
          ids.add(category.id);
          stack.push(category.id);
        }
      }
    }
    return ids;
  }, [activeCategoryId, categories]);

  /** True when the row belongs to the selected folder, itself included. */
  const isInsideActiveFolder = (folderId: string | null) => {
    if (!activeCategoryId) return false;
    if (activeCategoryId === UNCATEGORIZED_CATEGORY_ID) return folderId === null;
    if (!folderId) return false;
    return folderId === activeCategoryId || activeSubtreeIds.has(folderId);
  };

  const rows = useMemo(
    () => flattenNoteTree(tree, isExpanded),
    // isExpanded derives from forceExpand + expandedIds, both listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, expandedIds, forceExpand],
  );

  /**
   * Keeps the tree in sync with whatever the editor is showing. Switching to a
   * tab whose note sits inside a collapsed folder used to leave the row hidden,
   * so the note looked unselected. Reveal means: open every ancestor folder
   * (never close anything) and scroll the row into view.
   */
  const revealedNoteIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeNoteId || revealedNoteIdRef.current === activeNoteId) return;
    const noteState = useNoteStore.getState();
    const note = noteState.notes.find((item) => item.id === activeNoteId);
    if (!note) return;
    revealedNoteIdRef.current = activeNoteId;

    // A filter already opens every matching branch, and its visible set is not
    // governed by expandedFolderIds - expanding there would fight the filter.
    if (!forceExpand) {
      const expanded = useSettingsStore.getState().expandedFolderIds;
      if (expanded !== null) {
        const byId = new Map(noteState.categories.map((category) => [category.id, category]));
        // Notes without a live category are rendered under the virtual bucket,
        // which is a collapsible row like any other.
        const chain: string[] = [];
        const seen = new Set<string>();
        let cursor: string | null =
          note.categoryId && byId.has(note.categoryId) ? note.categoryId : UNCATEGORIZED_CATEGORY_ID;
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          chain.push(cursor);
          cursor = cursor === UNCATEGORIZED_CATEGORY_ID
            ? null
            : byId.get(cursor)?.parentId ?? null;
        }
        const missing = chain.filter((id) => !expanded.includes(id));
        if (missing.length > 0) {
          useSettingsStore.getState().setExpandedFolderIds([...expanded, ...missing]);
        }
      }
    }

    requestAnimationFrame(() => {
      document
        .querySelector(`[data-tree-note-id="${CSS.escape(activeNoteId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, [activeNoteId, forceExpand, categories, notes.length]);

  const setDropTargetSafe = (target: DropTarget | null) => {
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  // Hovering the middle of a folder only opens it after a real pause, so
  // "drop inside" stays a deliberate gesture instead of a drive-by side effect.
  const hoverExpandRef = useRef<{ id: string | null; timer: number | null }>({ id: null, timer: null });

  const clearHoverExpand = () => {
    if (hoverExpandRef.current.timer !== null) window.clearTimeout(hoverExpandRef.current.timer);
    hoverExpandRef.current = { id: null, timer: null };
  };

  const scheduleAutoExpand = (target: DropTarget | null) => {
    const id = target?.kind === "folder" ? target.id : null;
    if (hoverExpandRef.current.id === id) return;
    clearHoverExpand();
    if (!id || id === UNCATEGORIZED_CATEGORY_ID) return;
    hoverExpandRef.current.id = id;
    hoverExpandRef.current.timer = window.setTimeout(() => {
      hoverExpandRef.current = { id, timer: null };
      const current = useSettingsStore.getState().expandedFolderIds;
      if (current === null || current.includes(id)) return;
      useSettingsStore.getState().setExpandedFolderIds([...current, id]);
    }, 600);
  };

  useEffect(() => () => {
    dragCloneRef.current?.remove();
    dragCloneRef.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    clearHoverExpand();
  }, []);

  const toggleFolder = (id: string) => {
    if (expandedIds === null) {
      // First interaction materializes the implicit "all expanded" default.
      setExpandedFolderIds(allFolderIds.filter((folderId) => folderId !== id));
      return;
    }
    setExpandedFolderIds(
      expandedIds.includes(id)
        ? expandedIds.filter((folderId) => folderId !== id)
        : [...expandedIds, id],
    );
  };

  const handleSelectFolder = (row: TreeRow & { kind: "folder" }) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    lastSelectionRef.current = "folder";
    const folderId = row.folder.id;
    const activeId = row.folder.virtual ? UNCATEGORIZED_CATEGORY_ID : folderId;
    // Clicking the folder that is already selected folds it again, keeping the
    // selection. A filter forces every branch open, so collapsing there would
    // desync the state from what the rows show - selection only.
    if (activeCategoryId === activeId) {
      if (!forceExpand) toggleFolder(folderId);
      return;
    }
    setActiveCategoryId(folderId);
    // Picking a new folder always reveals it, so one click never lands on a
    // row whose contents stay hidden.
    ensureExpanded(folderId);
  };

  // A single click opens a replaceable preview tab; a double click pins it.
  const handleSelectNote = (note: Note) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    lastSelectionRef.current = "note";
    useTabStore.getState().openTab(note.id, { preview: true });
    onOpenNote(note.id);
  };

  const handlePinNote = (note: Note) => {
    useTabStore.getState().pinTab(note.id);
    onOpenNote(note.id);
  };

  const startRename = (category: NoteCategory) => {
    setEditingFolderId(category.id);
    setEditingName(category.name);
  };

  const finishRename = () => {
    const targetId = editingFolderId;
    const nextName = editingName.trim();
    setEditingFolderId(null);
    setEditingName("");
    if (!targetId) return;
    if (nextName) {
      updateCategory(targetId, nextName);
      return;
    }
    // A folder that never got a name is thrown away instead of leaving a blank row.
    const category = categories.find((item) => item.id === targetId);
    if (category && !category.name.trim()) deleteCategory(targetId);
  };

  const ensureExpanded = (id: string) => {
    if (expandedIds === null || expandedIds.includes(id)) return;
    setExpandedFolderIds([...expandedIds, id]);
  };

  // Tree keyboard model: Enter/Space behave like a click, Left/Right fold and
  // unfold, Up/Down move focus between visible rows.
  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const rowElement = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tree-row]");
    if (!rowElement) return;
    const index = Number(rowElement.dataset.treeRowIndex ?? "-1");
    const row = Number.isInteger(index) && index >= 0 ? rows[index] : undefined;
    if (!row) return;

    const focusRow = (nextIndex: number) => {
      const target = event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]")[nextIndex];
      if (!target) return;
      target.focus();
    };

    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        if (row.kind === "folder") handleSelectFolder(row);
        else handleSelectNote(row.note);
        break;
      case "ArrowDown":
        event.preventDefault();
        focusRow(Math.min(rows.length - 1, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRow(Math.max(0, index - 1));
        break;
      case "ArrowRight":
        if (row.kind === "folder") {
          event.preventDefault();
          ensureExpanded(row.folder.id);
        }
        break;
      case "ArrowLeft":
        if (row.kind === "folder" && isExpanded(row.folder.id)) {
          event.preventDefault();
          toggleFolder(row.folder.id);
        }
        break;
      default:
        break;
    }
  };

  // A folder created from the header / context menu arrives with an empty name;
  // open its inline rename so the user can type it straight away.
  useEffect(() => {
    if (!autoRenameCategoryId) return;
    const category = categories.find((item) => item.id === autoRenameCategoryId);
    if (category) {
      if (category.parentId) ensureExpanded(category.parentId);
      setEditingFolderId(category.id);
      setEditingName(category.name);
      // A deep folder created from the header can land outside the viewport.
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-tree-folder-id="${category.id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    }
    onAutoRenameHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRenameCategoryId]);

  // Delete removes the selected note right away; it still lands in the recycle
  // bin, so the action stays reversible. Text fields, open menus and dialogs keep
  // the key for themselves.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        if (target.isContentEditable) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      }
      if (menu || moveDialogNote || editingNoteId || editingFolderId) return;
      if (document.querySelector(".app-modal-backdrop")) return;
      if (lastSelectionRef.current !== "note" || !activeNoteId) return;
      const note = notes.find((item) => item.id === activeNoteId);
      if (!note || note.pinned) return;
      event.preventDefault();
      void deleteNoteToTrash(note);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menu, moveDialogNote, editingNoteId, editingFolderId, activeNoteId, notes]);

  const startNoteRename = (note: Note) => {
    setEditingNoteId(note.id);
    setEditingNoteTitle(note.title);
  };

  const finishNoteRename = () => {
    if (editingNoteId && editingNoteTitle.trim()) {
      updateNote(editingNoteId, { title: editingNoteTitle.trim() });
    }
    setEditingNoteId(null);
    setEditingNoteTitle("");
  };

  const openContextMenu = (event: React.MouseEvent, row: TreeRow) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, row });
  };

  const moveTargets = useMemo<MoveTarget[]>(() => {
    const out: MoveTarget[] = [];
    const walk = (folders: NoteTreeFolder[], depth: number) => {
      for (const folder of folders) {
        if (folder.virtual) continue;
        out.push({ id: folder.id, label: folder.name, depth });
        walk(folder.folders, depth + 1);
      }
    };
    walk(tree, 0);
    out.push({ id: null, label: t(lang, "uncategorizedNotes"), depth: 0 });
    return out;
  }, [tree, lang]);

  const buildMenuItems = (row: TreeRow | null): TreeMenuItem[] => {
    if (!row) {
      return [
        {
          key: "new-note",
          label: t(lang, "newNote"),
          icon: <FilePlus2 size={12} />,
          onSelect: () => onRequestNewNote(null),
        },
        {
          key: "new-folder",
          label: t(lang, "newCategory"),
          icon: <FolderPlus size={12} />,
          onSelect: () => onRequestNewCategory(null),
        },
      ];
    }
    if (row.kind === "folder") {
      const folder = row.folder;
      const category = folder.virtual
        ? null
        : categories.find((item) => item.id === folder.id) ?? null;
      const items: TreeMenuItem[] = [
        {
          key: "new-note",
          label: t(lang, "newNote"),
          icon: <FilePlus2 size={12} />,
          onSelect: () => onRequestNewNote(folder.virtual ? UNCATEGORIZED_CATEGORY_ID : folder.id),
        },
      ];
      if (category) {
        items.push({
          key: "new-subfolder",
          label: t(lang, "newSubfolder"),
          icon: <FolderPlus size={12} />,
          onSelect: () => {
            ensureExpanded(category.id);
            onRequestNewCategory(category.id);
          },
        });
        items.push({
          key: "rename",
          label: t(lang, "renameCategory"),
          icon: <Pencil size={12} />,
          onSelect: () => startRename(category),
        });
        items.push({
          key: "pin",
          label: t(lang, category.pinned ? "unpinCategory" : "pinCategory"),
          icon: category.pinned ? <PinOff size={12} /> : <Pin size={12} />,
          onSelect: () => toggleCategoryPinned(category.id),
        });
        items.push({
          key: "delete",
          label: t(lang, "deleteCategory"),
          icon: <Trash2 size={12} />,
          danger: true,
          separatorBefore: true,
          onSelect: () => onRequestDeleteCategory(category),
        });
      }
      return items;
    }

    const note = row.note;
    return [
      {
        key: "rename",
        label: t(lang, "renameNote"),
        icon: <Pencil size={12} />,
        onSelect: () => startNoteRename(note),
      },
      {
        key: "pin",
        label: t(lang, note.pinned ? "unpinNote" : "pinNote"),
        icon: note.pinned ? <PinOff size={12} /> : <Pin size={12} />,
        onSelect: () => togglePinned(note.id),
      },
      {
        key: "move",
        label: t(lang, "moveToFolder"),
        icon: <FolderInput size={12} />,
        onSelect: () => setMoveDialogNote(note),
      },
      {
        key: "export",
        label: t(lang, "exportFile"),
        icon: <FileDown size={12} />,
        onSelect: () => onExportNote(note),
      },
      {
        key: "delete",
        label: t(lang, "deleteNote"),
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        disabled: note.pinned,
        onSelect: () => onRequestDeleteNote(note),
      },
    ];
  };

  const getNoteTitle = (note: Note) => note.title.trim() || t(lang, "untitled");

  /** Resolves the folder row / note row currently under the pointer. */
  const findDropTarget = (
    clientX: number,
    clientY: number,
    mode: "folder" | "note",
  ): DropTarget | null => {
    const element = document.elementFromPoint(clientX, clientY);
    const folderEl = element?.closest<HTMLElement>("[data-tree-folder-id]");
    const folderId = folderEl?.dataset.treeFolderId;
    if (folderEl && folderId) {
      // Only a dragged folder can land between siblings: a note has no position
      // relative to folders, so it always just moves into the target folder.
      if (mode === "note") return { kind: "folder", id: folderId };
      const rect = folderEl.getBoundingClientRect();
      const ratio = (clientY - rect.top) / Math.max(1, rect.height);
      // Top and bottom quarters insert as a sibling; the middle nests.
      if (ratio < 0.25) return { kind: "folder-insert", id: folderId, position: "before" };
      if (ratio > 0.75) return { kind: "folder-insert", id: folderId, position: "after" };
      return { kind: "folder", id: folderId };
    }
    const noteEl = element?.closest<HTMLElement>("[data-tree-note-id]");
    const noteId = noteEl?.dataset.treeNoteId;
    if (noteEl && noteId) {
      const rect = noteEl.getBoundingClientRect();
      return {
        kind: "note",
        id: noteId,
        position: clientY >= rect.top + rect.height / 2 ? "after" : "before",
      };
    }
    return null;
  };

  const beginDrag = (event: React.MouseEvent, rowElement: HTMLElement | null) => {
    if (!rowElement || event.button !== 0) return;

    const startRect = rowElement.getBoundingClientRect();
    const offsetY = event.clientY - startRect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    const mode: "folder" | "note" = rowElement.dataset.treeNoteId ? "note" : "folder";
    let clone: HTMLElement | null = null;
    let moved = false;

    // Text selection is only suppressed once a drag really starts, so a plain
    // click inside an inline rename input keeps working normally.
    const blockSelection = (nativeEvent: Event) => nativeEvent.preventDefault();

    const startGhost = () => {
      clone = rowElement.cloneNode(true) as HTMLElement;
      clone.removeAttribute("data-tree-row");
      clone.removeAttribute("data-tree-folder-id");
      clone.removeAttribute("data-tree-note-id");
      clone.style.position = "fixed";
      clone.style.left = `${startRect.left}px`;
      clone.style.top = `${startRect.top}px`;
      clone.style.width = `${startRect.width}px`;
      clone.style.zIndex = "9999";
      clone.style.pointerEvents = "none";
      clone.style.opacity = "0.85";
      clone.style.boxShadow = "0 4px 16px rgba(0,0,0,0.15)";
      document.body.appendChild(clone);
      dragCloneRef.current = clone;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      document.addEventListener("selectstart", blockSelection);
    };

    const onMove = (moveEvent: MouseEvent) => {
      if (!moved) {
        if (
          Math.abs(moveEvent.clientX - startX) <= 3
          && Math.abs(moveEvent.clientY - startY) <= 3
        ) {
          return;
        }
        moved = true;
        suppressClickRef.current = true;
        startGhost();
      }
      if (clone) clone.style.top = `${moveEvent.clientY - offsetY}px`;
      const target = findDropTarget(moveEvent.clientX, moveEvent.clientY, mode);
      setDropTargetSafe(target);
      scheduleAutoExpand(target);
    };

    const onUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectstart", blockSelection);
      clearHoverExpand();
      dragCloneRef.current?.remove();
      dragCloneRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (!moved) return;
      const target = findDropTarget(upEvent.clientX, upEvent.clientY, mode);
      setDropTargetSafe(null);
      if (target) {
        resolveDrop(rowElement, target);
        return;
      }
      // Dropping into empty space below the rows sends the item back to the root.
      const bounds = scrollRef.current?.getBoundingClientRect();
      const inside = bounds
        && upEvent.clientX >= bounds.left
        && upEvent.clientX <= bounds.right
        && upEvent.clientY >= bounds.top
        && upEvent.clientY <= bounds.bottom;
      if (inside) resolveDropToRoot(rowElement);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const resolveDrop = (rowElement: HTMLElement, target: DropTarget) => {
    const noteId = rowElement.dataset.treeNoteId;
    const folderId = rowElement.dataset.treeFolderId;

    if (noteId) {
      const dragged = notes.find((note) => note.id === noteId);
      if (!dragged) return;
      if (target.kind === "folder") {
        const nextCategoryId = folderAssignableId(target.id);
        if ((dragged.categoryId ?? null) === nextCategoryId) return;
        updateNote(dragged.id, { categoryId: nextCategoryId });
        ensureExpanded(target.id);
        return;
      }
      const targetNote = notes.find((note) => note.id === target.id);
      if (!targetNote || targetNote.pinned || targetNote.id === dragged.id) return;
      if ((targetNote.categoryId ?? null) !== (dragged.categoryId ?? null)) {
        updateNote(dragged.id, { categoryId: targetNote.categoryId ?? null });
        return;
      }
      reorderNotes(dragged.id, targetNote.id, target.position);
      return;
    }

    if (folderId) {
      if (target.kind === "folder") {
        // Dropping a folder onto another folder nests it; dropping onto the
        // uncategorized bucket lifts it back to the root.
        const nextParent = target.id === UNCATEGORIZED_CATEGORY_ID ? null : target.id;
        moveCategory(folderId, nextParent);
        if (nextParent) ensureExpanded(nextParent);
        return;
      }
      if (target.kind === "folder-insert" && target.id !== folderId) {
        // Beside the virtual bucket means "root level", not "child of nothing".
        if (target.id === UNCATEGORIZED_CATEGORY_ID) {
          moveCategory(folderId, null);
          return;
        }
        moveCategoryBeside(folderId, target.id, target.position);
      }
    }
  };

  const resolveDropToRoot = (rowElement: HTMLElement) => {
    const noteId = rowElement.dataset.treeNoteId;
    const folderId = rowElement.dataset.treeFolderId;
    if (noteId) {
      updateNote(noteId, { categoryId: null });
      return;
    }
    if (folderId && folderId !== UNCATEGORIZED_CATEGORY_ID) {
      moveCategory(folderId, null);
    }
  };

  const renderFolderRow = (row: TreeRow & { kind: "folder" }, index: number) => {
    const { folder, depth, noteCount, folderCount, expanded } = row;
    const isActive = activeCategoryId === (folder.virtual ? UNCATEGORIZED_CATEGORY_ID : folder.id);
    const isDropInside = dropTarget?.kind === "folder" && dropTarget.id === folder.id;
    const isDropBefore = dropTarget?.kind === "folder-insert"
      && dropTarget.id === folder.id && dropTarget.position === "before";
    const isDropAfter = dropTarget?.kind === "folder-insert"
      && dropTarget.id === folder.id && dropTarget.position === "after";
    const category = folder.virtual
      ? null
      : categories.find((item) => item.id === folder.id) ?? null;
    const indent = getTreeIndent(depth);
    const insideActive = isInsideActiveFolder(folder.id);

    return (
      <div
        key={`folder:${folder.id}`}
        data-tree-row
        data-tree-folder-id={folder.id}
        data-tree-row-index={index}
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={isActive}
        tabIndex={rowTabIndex("folder", folder.id, index)}
        onClick={() => handleSelectFolder(row)}
        onMouseDown={category ? (event) => beginDrag(event, event.currentTarget) : undefined}
        onContextMenu={(event) => openContextMenu(event, row)}
        onFocus={() => setFocusedRowKey(`folder:${folder.id}`)}
        title={folder.name || t(lang, "unnamedFolder")}
        className={`group relative mb-0.5 rounded-lg pr-2 text-xs transition-colors cursor-pointer
          ${isActive
            ? "flat-active-row text-text-primary"
            : `text-text-secondary ${insideActive ? "tree-subtree-tint" : "hover:bg-bg-hover"}`}
          ${isDropInside ? "drag-target-inside" : ""}`}
      >
        {isDropBefore && <span aria-hidden="true" className="drag-insertion-line drag-insertion-line--before" />}
        {isDropAfter && <span aria-hidden="true" className="drag-insertion-line drag-insertion-line--after" />}
        <div
          className="flex h-8 w-full items-center gap-1.5"
          style={{ paddingLeft: indent + 4 }}
        >
          <span
            aria-hidden="true"
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-text-muted"
          >
            {expanded ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
          </span>
          <span className="flex-shrink-0 text-text-muted">
            {expanded
              ? <FolderOpen size={14} strokeWidth={1.8} />
              : <Folder size={14} strokeWidth={1.8} />}
          </span>
          {category && editingFolderId === category.id ? (
            <input
              value={editingName}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => setEditingName(event.target.value)}
              onBlur={finishRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") finishRename();
                if (event.key === "Escape") {
                  setEditingFolderId(null);
                  setEditingName("");
                }
              }}
              autoFocus
              className="min-w-0 flex-1 rounded border border-border bg-bg-primary px-1 py-0.5 text-xs text-text-primary outline-none"
            />
          ) : (
            <span className={`min-w-0 flex-1 truncate font-medium ${folder.name ? "" : "italic text-text-muted"}`}>
              {folder.name || t(lang, "unnamedFolder")}
            </span>
          )}
          {folder.pinned && <Pin size={10} className="flex-shrink-0 text-accent-text" />}
          <span
            className={`inline-flex h-[17px] min-w-[17px] flex-shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none tabular-nums
              ${isActive
                ? "bg-accent text-on-accent"
                : "border border-border/70 bg-bg-primary/70 text-text-muted"}`}
          >
            {noteCount}
          </span>
          {folderCount > 0 && !category && (
            <span className="flex-shrink-0 text-[10px] text-text-muted">{folderCount}</span>
          )}
        </div>
      </div>
    );
  };

  const renderNoteRow = (row: TreeRow & { kind: "note" }, index: number) => {
    const { note, depth } = row;
    const isActive = activeNoteId === note.id;
    const isDropBefore = dropTarget?.kind === "note" && dropTarget.id === note.id && dropTarget.position === "before";
    const isDropAfter = dropTarget?.kind === "note" && dropTarget.id === note.id && dropTarget.position === "after";
    const indent = getTreeIndent(depth);
    const insideActive = isInsideActiveFolder(row.folderId);

    return (
      <div
        key={`note:${note.id}`}
        data-tree-row
        data-tree-note-id={note.id}
        data-tree-row-index={index}
        role="treeitem"
        aria-selected={isActive}
        tabIndex={rowTabIndex("note", note.id, index)}
        onClick={() => handleSelectNote(note)}
        onDoubleClick={() => handlePinNote(note)}
        onMouseDown={note.pinned ? undefined : (event) => beginDrag(event, event.currentTarget)}
        onContextMenu={(event) => openContextMenu(event, row)}
        onFocus={() => setFocusedRowKey(`note:${note.id}`)}
        className={`group relative mb-0.5 rounded-lg pr-2 transition-colors cursor-pointer
          ${isActive
            ? "flat-active-row text-text-primary"
            : `text-text-secondary ${insideActive ? "tree-subtree-tint" : "hover:bg-bg-hover"}`}`}
      >
        {isDropBefore && <span aria-hidden="true" className="drag-insertion-line drag-insertion-line--before" />}
        {isDropAfter && <span aria-hidden="true" className="drag-insertion-line drag-insertion-line--after" />}
        <div
          className="flex h-8 w-full items-center gap-1.5"
          style={{ paddingLeft: indent + 4 }}
        >
          {/* Same width as the folder chevron, so file icons line up with the
              folder icon above them instead of with the disclosure arrow. */}
          <span aria-hidden="true" className="h-4 w-4 flex-shrink-0" />
          <span
            className={`flex flex-shrink-0 items-center justify-center
              ${isActive ? "text-accent-text" : "text-text-muted"}`}
          >
            {note.pinned
              ? <Pin size={13} strokeWidth={1.8} />
              : <FileText size={13} strokeWidth={1.8} />}
          </span>
          {editingNoteId === note.id ? (
            <input
              value={editingNoteTitle}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onChange={(event) => setEditingNoteTitle(event.target.value)}
              onBlur={finishNoteRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") finishNoteRename();
                if (event.key === "Escape") {
                  setEditingNoteId(null);
                  setEditingNoteTitle("");
                }
              }}
              autoFocus
              className="min-w-0 flex-1 rounded border border-border bg-bg-primary px-1 py-0.5 text-[13px] text-text-primary outline-none"
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-left text-[13px] font-medium"
              title={getNoteTitle(note)}
            >
              {getNoteTitle(note)}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div
        ref={scrollRef}
        role="tree"
        aria-label={t(lang, "explorer")}
        onKeyDown={handleTreeKeyDown}
        onMouseDownCapture={() => {
          suppressClickRef.current = false;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-1"
        onContextMenu={(event) => {
          // Right-clicking empty space offers root-level creation.
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, row: null });
        }}
      >
        {rows.map((row, index) => (row.kind === "folder" ? renderFolderRow(row, index) : renderNoteRow(row, index)))}
        {/* An empty tree means two different things, and only one of them wants
            a "create something" button: a filtered tree wants the query gone. */}
        {rows.length === 0 &&
          (searchQuery.trim() ? (
            <EmptyState
              icon={<SearchX size={17} />}
              title={t(lang, "searchNoResults")}
              description={t(lang, "searchNoResultsHint")}
            />
          ) : (
            <EmptyState
              icon={<FilePlus2 size={17} />}
              title={t(lang, "noNotes")}
              action={{ label: t(lang, "newNote"), onClick: () => onRequestNewNote(null) }}
            />
          ))}
      </div>
      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.row)}
          onClose={() => setMenu(null)}
        />
      )}
      {moveDialogNote && (
        <MoveToFolderDialog
          lang={lang}
          targets={moveTargets}
          currentId={moveDialogNote.categoryId ?? null}
          onSelect={(id) => {
            updateNote(moveDialogNote.id, { categoryId: id });
            setMoveDialogNote(null);
          }}
          onClose={() => setMoveDialogNote(null)}
        />
      )}
    </>
  );
};

export default NoteTree;
