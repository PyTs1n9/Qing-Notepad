import React, { useMemo, useState } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FileUp,
  FolderPlus,
  PanelLeftOpen,
  Plus,
  Tag,
  Trash2,
} from "lucide-react";
import NoteTree from "@/components/Layout/NoteTree";
import PluginViewSections from "@/components/Layout/PluginViewSections";
import ModalShell from "@/components/Layout/ModalShell";
import { collectExplorerFolderIds } from "@/components/Layout/noteTreeModel";
import { UNCATEGORIZED_CATEGORY_ID, useNoteStore } from "@/stores/noteStore";
import { TRASH_RETENTION_FOREVER, useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import { deleteNoteToTrash } from "@/utils/noteDeletion";
import TrashModal from "@/components/Trash/TrashModal";
import type { Note, NoteCategory, ViewType } from "@/types";

interface SidebarProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  onNewNote: (categoryId?: string | null) => void;
  /** Lives here now that the title-bar portal is gone: importing creates notes. */
  onImportTextNotes: () => void;
  /** Exports one note by id; the tree row is the third entry point (tabs, toolbar). */
  onExportNote: (noteId: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenSettings?: () => void;
}

const TRASH_RETENTION_LABEL_KEYS: Record<number, string> = {
  0: "trashRetentionDisabled",
  7: "trashRetention7Days",
  30: "trashRetention30Days",
  90: "trashRetention90Days",
  [TRASH_RETENTION_FOREVER]: "trashRetentionForever",
};

const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onViewChange,
  onNewNote,
  onImportTextNotes,
  onExportNote,
  collapsed,
  onToggleCollapse,
  onOpenSettings,
}) => {
  const {
    notes,
    categories,
    searchQuery,
    filterTag,
    setFilterTag,
    addCategory,
    deleteCategory,
  } = useNoteStore();
  const activeCategoryId = useNoteStore((s) => s.activeCategoryId);
  const lang = useSettingsStore((s) => s.lang);
  const expandedFolderIds = useSettingsStore((s) => s.expandedFolderIds);
  const setExpandedFolderIds = useSettingsStore((s) => s.setExpandedFolderIds);
  const trashRetentionDays = useSettingsStore((s) => s.trashRetentionDays);
  const trashEnabled = trashRetentionDays !== 0;
  const trashRetentionLabel = t(
    lang,
    (TRASH_RETENTION_LABEL_KEYS[trashRetentionDays] ?? "trashRetention30Days") as Parameters<typeof t>[1],
  );

  // Id of a folder that was just created and still needs a name typed inline.
  const [pendingRenameCategoryId, setPendingRenameCategoryId] = useState<string | null>(null);
  const [deleteConfirmNote, setDeleteConfirmNote] = useState<Note | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  const allTags = Array.from(new Set(notes.flatMap((note) => note.tags)));

  // Bulk fold actions cover the whole explorer, so they are judged against every
  // folder row - filter-independent. `expandedFolderIds === null` still means
  // "nothing collapsed yet", i.e. everything is already open.
  const explorerFolderIds = useMemo(() => collectExplorerFolderIds(categories), [categories]);
  const treeFilterActive = searchQuery.trim().length > 0 || Boolean(filterTag);
  const everyFolderExpanded =
    expandedFolderIds === null
    || explorerFolderIds.every((folderId) => expandedFolderIds.includes(folderId));
  const everyFolderCollapsed =
    expandedFolderIds !== null
    && explorerFolderIds.every((folderId) => !expandedFolderIds.includes(folderId));

  const expandAllFolders = () => setExpandedFolderIds(explorerFolderIds);
  const collapseAllFolders = () => setExpandedFolderIds([]);

  const actionBase = "flex items-center justify-center rounded-lg transition-colors cursor-pointer";
  const actionCollapsed = "w-10 h-10 shrink-0";
  // Explorer header icons: 24px targets inside the 36px title row, quiet until
  // hovered. The fold pair greys out instead of acting when it would be a no-op.
  const headerActionButton =
    "flex h-6 w-6 items-center justify-center rounded text-text-muted/70 transition-colors cursor-pointer enabled:hover:bg-bg-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";
  const actionSecondary =
    "border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary";
  const renderRailDivider = () => <div className="my-1 h-px w-8 bg-border" aria-hidden="true" />;

  const getNoteTitle = (note: Note) => note.title.trim() || t(lang, "untitled");

  // Creating a folder mirrors note creation: it appears immediately with an
  // empty name and the tree starts an inline rename. An empty name on blur
  // discards the folder again, so no dialog is involved at any point.
  const handleCreateCategory = (parentId: string | null = null) => {
    const created = addCategory("", parentId);
    setPendingRenameCategoryId(created.id);
    onViewChange("note");
  };

  // The header button nests into the selected folder. The uncategorized bucket
  // is a virtual folder, so it can never act as a parent.
  const newFolderParentId =
    activeCategoryId === UNCATEGORIZED_CATEGORY_ID ? null : activeCategoryId ?? null;

  const handleDeleteCategory = (category: NoteCategory) => {
    if (confirm(`${t(lang, "confirmDeleteCategory")}${category.name}"?`)) {
      deleteCategory(category.id);
    }
  };

  const handleOpenNote = () => {
    if (currentView !== "note") onViewChange("note");
  };

  const confirmDeleteNote = async () => {
    if (!deleteConfirmNote) return;
    const latestNote = notes.find((note) => note.id === deleteConfirmNote.id);
    const noteToDelete = latestNote ?? deleteConfirmNote;
    setDeleteConfirmNote(null);
    if (noteToDelete.pinned) return;
    await deleteNoteToTrash(noteToDelete);
  };

  return (
    <aside className="app-interactive-surface w-full h-full flex flex-col">
      {!collapsed && (
        // h-9 matches the note tab bar and the AI sidebar header, so this
        // border lands on the same line across all three cards.
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            {t(lang, "explorer")}
          </h2>
          <div className="flex items-center gap-0.5">
            {/* A filter forces every branch open in NoteTree, so neither fold
                action can change what is on screen - both stay disabled. */}
            <button
              onClick={expandAllFolders}
              disabled={treeFilterActive || everyFolderExpanded}
              className={headerActionButton}
              title={treeFilterActive ? t(lang, "bulkFoldDisabledByFilter") : t(lang, "expandAllFolders")}
              aria-label={t(lang, "expandAllFolders")}
            >
              <ChevronsUpDown size={14} />
            </button>
            <button
              onClick={collapseAllFolders}
              disabled={treeFilterActive || everyFolderCollapsed}
              className={headerActionButton}
              title={treeFilterActive ? t(lang, "bulkFoldDisabledByFilter") : t(lang, "collapseAllFolders")}
              aria-label={t(lang, "collapseAllFolders")}
            >
              <ChevronsDownUp size={14} />
            </button>
            <button
              onClick={() => {
                onNewNote();
                onViewChange("note");
              }}
              className={headerActionButton}
              title={t(lang, "newNote")}
              aria-label={t(lang, "newNote")}
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => handleCreateCategory(newFolderParentId)}
              className={headerActionButton}
              title={t(lang, "newCategory")}
              aria-label={t(lang, "newCategory")}
            >
              <FolderPlus size={14} />
            </button>
            <button
              onClick={onImportTextNotes}
              className={headerActionButton}
              title={t(lang, "importNote")}
              aria-label={t(lang, "importNote")}
            >
              <FileUp size={14} />
            </button>
          </div>
        </div>
      )}

      {collapsed && (
        <div className="flex flex-col items-center px-2 py-2">
          <button
            onClick={onToggleCollapse}
            className={`${actionBase} ${actionSecondary} ${actionCollapsed}`}
            title={t(lang, "expandSidebar")}
          >
            <PanelLeftOpen size={16} />
          </button>
          {renderRailDivider()}
          {renderRailDivider()}
          <button
            onClick={() => {
              onNewNote();
              onViewChange("note");
            }}
            className={`${actionBase} ${actionSecondary} ${actionCollapsed} mt-1`}
            title={t(lang, "newNote")}
          >
            <Plus size={16} />
          </button>
          <button
            onClick={() => handleCreateCategory(newFolderParentId)}
            className={`${actionBase} ${actionSecondary} ${actionCollapsed} mt-2`}
            title={t(lang, "newCategory")}
          >
            <FolderPlus size={16} />
          </button>
          <button
            onClick={() => setTrashOpen(true)}
            className={`${actionBase} ${actionSecondary} ${actionCollapsed} mt-2`}
            title={t(lang, "trash")}
            aria-label={t(lang, "trash")}
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}

      {!collapsed && (
        <NoteTree
          lang={lang}
          onOpenNote={handleOpenNote}
          onRequestDeleteNote={setDeleteConfirmNote}
          onRequestDeleteCategory={handleDeleteCategory}
          onRequestNewNote={(folderId) => {
            onNewNote(folderId);
            onViewChange("note");
          }}
          onRequestNewCategory={handleCreateCategory}
          onExportNote={(note) => onExportNote(note.id)}
          autoRenameCategoryId={pendingRenameCategoryId}
          onAutoRenameHandled={() => setPendingRenameCategoryId(null)}
        />
      )}

      {!collapsed && allTags.length > 0 && (
        <div className="px-2 mb-3">
          <div className="text-xs text-text-muted px-3 py-1 uppercase tracking-wide flex items-center gap-1">
            <Tag size={10} />
            <span>{t(lang, "tags")}</span>
          </div>
          <div className="flex flex-wrap gap-1 px-3 py-1">
            <button
              onClick={() => setFilterTag(null)}
              className={`px-2 py-0.5 rounded-full text-xs cursor-pointer
                ${!filterTag ? "bg-accent text-on-accent" : "bg-bg-hover text-text-secondary hover:bg-bg-active"}`}
            >
              {t(lang, "all")}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setFilterTag(tag === filterTag ? null : tag)}
                className={`px-2 py-0.5 rounded-full text-xs cursor-pointer
                  ${tag === filterTag ? "bg-accent text-on-accent" : "bg-bg-hover text-text-secondary hover:bg-bg-active"}`}
              >
                #{tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Plugin-contributed panels (`contributes.views`) sit at the bottom of
          this column. The component renders nothing at all when no plugin
          contributes one, so the column looks exactly as it did before P1a-2. */}
      {!collapsed && <PluginViewSections lang={lang} />}

      {!collapsed && (
        <div className="border-t border-border px-2 py-2">
          <button
            onClick={() => setTrashOpen(true)}
            data-flat-row-button
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-transparent px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
            title={t(lang, "trash")}
          >
            <Trash2 size={13} />
            <span className="flex-1 truncate text-left">{t(lang, "trash")}</span>
          </button>
        </div>
      )}

      {deleteConfirmNote && (
        <ModalShell
          onClose={() => setDeleteConfirmNote(null)}
          title={t(lang, trashEnabled ? "moveNoteToTrash" : "deleteNote")}
          description={getNoteTitle(deleteConfirmNote)}
          icon={<Trash2 size={16} />}
          tone="danger"
          size="sm"
          footer={(
            <>
              <button
                type="button"
                onClick={() => setDeleteConfirmNote(null)}
                className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {t(lang, "confirmNo")}
              </button>
              <button
                type="button"
                onClick={confirmDeleteNote}
                className="h-8 rounded-lg bg-danger px-3 text-xs text-on-danger transition-colors hover:bg-danger/90"
              >
                {t(lang, "confirmYes")}
              </button>
            </>
          )}
        >
          <p className="text-sm leading-relaxed text-text-secondary">
            {trashEnabled
              ? tWithParams(lang, "confirmMoveToTrashMessage", {
                note: getNoteTitle(deleteConfirmNote),
                days: trashRetentionLabel,
              })
              : t(lang, "confirmDeleteNoteMessage").replace("{note}", getNoteTitle(deleteConfirmNote))}
          </p>
        </ModalShell>
      )}
      <TrashModal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onOpenSettings={() => onOpenSettings?.()}
        onRestored={() => onViewChange("note")}
      />
    </aside>
  );
};

export default Sidebar;
