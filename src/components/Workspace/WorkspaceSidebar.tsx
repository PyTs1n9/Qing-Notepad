import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CalendarClock,
  FileCheck2,
  FileClock,
  FilePlus2,
  FileText,
  Filter,
  Info,
  LayoutDashboard,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useWorkspaceUiStore } from "@/stores/workspaceUi";
import { t } from "@/utils/i18n";
import type { WorkspaceDocumentPublicationStatus } from "@/types/workspace";
import EmptyState from "@/components/Layout/EmptyState";
import WorkspaceDropdown from "@/components/Workspace/WorkspaceDropdown";
import {
  accessLevelLabel,
  formatDocumentDate,
  publicationStatusLabel,
  roleLabel,
} from "@/components/Workspace/workspaceLabels";

interface FloatingPanelPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

type PublicationFilter = "all" | WorkspaceDocumentPublicationStatus;

const ACTION_MENU_WIDTH = 168;
/** Four rows plus the separator and the panel padding. */
const ACTION_MENU_ESTIMATED_HEIGHT = 176;

/** Pins a pointer-anchored menu inside the viewport, flipping at the edges. */
function clampFloatingMenu(x: number, y: number): FloatingPanelPosition {
  const padding = 8;
  return {
    left: Math.max(padding, Math.min(x, window.innerWidth - padding - ACTION_MENU_WIDTH)),
    top: Math.max(padding, Math.min(y, window.innerHeight - padding - ACTION_MENU_ESTIMATED_HEIGHT)),
    width: ACTION_MENU_WIDTH,
    maxHeight: Math.max(80, window.innerHeight - padding * 2),
  };
}

/**
 * Explorer column of the workspace view: which workspace, which documents, and
 * everything you can do to one document.
 *
 * It deliberately knows nothing about the shell. The card, the hairline, the
 * width and the resize sash belong to `App.tsx`, exactly as they do for the
 * note and todo explorers - this component only fills the column it is given.
 *
 * Note for future edits: the menus and the details popover are `position:
 * fixed` and portalled to `document.body` because the shell's frosting rule
 * keeps cards free of stacking contexts. Do not add `transform`, `filter`,
 * `backdrop-filter` or `isolation` to this component's root, or those overlays
 * will be painted under the next card.
 */
const WorkspaceSidebar: React.FC = () => {
  const lang = useSettingsStore((state) => state.lang);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const documents = useWorkspaceStore((state) => state.documents);
  const members = useWorkspaceStore((state) => state.members);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const activeDocumentId = useWorkspaceStore((state) => state.activeDocumentId);
  const reorderingDocument = useWorkspaceStore((state) => state.reorderingDocument);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const selectDocument = useWorkspaceStore((state) => state.selectDocument);
  const reorderDocument = useWorkspaceStore((state) => state.reorderDocument);

  const openDialog = useWorkspaceUiStore((state) => state.openDialog);
  const openRenameDialog = useWorkspaceUiStore((state) => state.openRenameDialog);
  const requestDelete = useWorkspaceUiStore((state) => state.requestDelete);
  const requestPublicationDialog = useWorkspaceUiStore((state) => state.requestPublicationDialog);
  const openManage = useWorkspaceUiStore((state) => state.openManage);

  const [publicationFilter, setPublicationFilter] = useState<PublicationFilter>("all");
  // Pointer-anchored: the menu is opened by right-clicking a row (or pressing
  // the context-menu key on it), so there is no trigger button to measure.
  const [documentActionMenu, setDocumentActionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [documentActionMenuPosition, setDocumentActionMenuPosition] = useState<FloatingPanelPosition | null>(null);
  const [documentDetailsId, setDocumentDetailsId] = useState<string | null>(null);
  const [documentDetailsPosition, setDocumentDetailsPosition] = useState<FloatingPanelPosition | null>(null);
  const [draggedDocumentId, setDraggedDocumentId] = useState<string | null>(null);
  const [dragOverDocumentId, setDragOverDocumentId] = useState<string | null>(null);
  const [dragOverDocumentPosition, setDragOverDocumentPosition] = useState<"before" | "after" | null>(null);
  const documentDetailsAnchorRef = useRef<HTMLElement | null>(null);
  const documentListRef = useRef<HTMLDivElement | null>(null);
  const documentDragPreviewRef = useRef<HTMLElement | null>(null);

  const activeWorkspace = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "editor";

  const filteredDocuments = useMemo(
    () => publicationFilter === "all"
      ? documents
      : documents.filter((document) => document.publicationStatus === publicationFilter),
    [documents, publicationFilter],
  );
  const actionDocument = documents.find((item) => item.id === documentActionMenu?.id) ?? null;
  const detailedDocument = documents.find((item) => item.id === documentDetailsId) ?? null;
  // The creator's display name lives on the member row, not on the document.
  const detailedDocumentCreator = detailedDocument
    ? members.find((member) => member.userId === detailedDocument.createdBy)?.displayName
      ?? detailedDocument.createdBy
    : null;

  // Switching workspaces must not leave a stale filter hiding every document.
  useEffect(() => {
    setPublicationFilter("all");
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!documentActionMenu) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-document-action-menu]")) setDocumentActionMenu(null);
    };
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDocumentActionMenu(null);
    };
    // A pointer-anchored menu has nothing to follow: once the list scrolls or the
    // window changes shape, the spot it was opened at no longer points at that
    // row, so it closes instead of hovering over the wrong document.
    const closeOnViewportChange = (event?: Event) => {
      const target = event?.target;
      if (target instanceof HTMLElement && target.closest("[data-document-action-menu]")) return;
      setDocumentActionMenu(null);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeMenuOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeMenuOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [documentActionMenu]);

  useEffect(() => {
    if (!documentDetailsId) return;
    const closeDetails = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-document-details]")) setDocumentDetailsId(null);
    };
    const closeDetailsOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDocumentDetailsId(null);
    };
    document.addEventListener("mousedown", closeDetails);
    document.addEventListener("keydown", closeDetailsOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeDetails);
      document.removeEventListener("keydown", closeDetailsOnEscape);
    };
  }, [documentDetailsId]);

  useLayoutEffect(() => {
    if (!documentDetailsId) {
      setDocumentDetailsPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = documentDetailsAnchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 6;
      const width = Math.min(340, window.innerWidth - viewportPadding * 2);
      const estimatedHeight = 420;
      if (rect.bottom < viewportPadding || rect.top > window.innerHeight - viewportPadding) {
        setDocumentDetailsId(null);
        return;
      }
      const availableBelow = window.innerHeight - viewportPadding - rect.bottom - gap;
      const availableAbove = rect.top - viewportPadding - gap;
      const openBelow = availableBelow >= estimatedHeight || availableBelow >= availableAbove;
      const maxHeight = Math.max(140, Math.min(estimatedHeight, openBelow ? availableBelow : availableAbove));
      const top = openBelow
        ? Math.min(rect.bottom + gap, window.innerHeight - viewportPadding - maxHeight)
        : Math.max(viewportPadding, rect.top - gap - maxHeight);
      const left = Math.max(
        viewportPadding,
        Math.min(rect.left, window.innerWidth - viewportPadding - width),
      );
      setDocumentDetailsPosition({ left, top, width, maxHeight });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [documentDetailsId]);

  const resetDocumentDrag = () => {
    documentDragPreviewRef.current?.remove();
    documentDragPreviewRef.current = null;
    setDraggedDocumentId(null);
    setDragOverDocumentId(null);
    setDragOverDocumentPosition(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  const getDocumentDropTarget = (clientX: number, clientY: number, documentId: string) => {
    const viewport = documentListRef.current?.getBoundingClientRect();
    if (!viewport || clientX < viewport.left || clientX > viewport.right) {
      return { id: null, position: null as "before" | "after" | null };
    }

    const rows = Array.from(
      documentListRef.current?.querySelectorAll<HTMLElement>("[data-document-id]") ?? [],
    ).filter((row) => row.dataset.documentId !== documentId);
    const target = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    }) ?? rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    }) ?? rows[rows.length - 1];
    if (!target) return { id: null, position: null as "before" | "after" | null };

    const rect = target.getBoundingClientRect();
    return {
      id: target.dataset.documentId ?? null,
      position: clientY >= rect.top + rect.height / 2 ? "after" : "before",
    } as const;
  };

  const startDocumentDrag = (
    event: React.MouseEvent<HTMLSpanElement>,
    documentId: string,
  ) => {
    if (!canEdit || reorderingDocument) return;
    event.preventDefault();
    event.stopPropagation();

    const row = event.currentTarget.closest<HTMLElement>("[data-document-row]");
    if (!row) return;

    const startRect = row.getBoundingClientRect();
    const offsetY = event.clientY - startRect.top;
    const preview = row.cloneNode(true) as HTMLElement;
    preview.style.position = "fixed";
    preview.style.left = `${startRect.left}px`;
    preview.style.top = `${startRect.top}px`;
    preview.style.width = `${startRect.width}px`;
    preview.style.zIndex = "9999";
    preview.style.pointerEvents = "none";
    preview.style.opacity = "0.86";
    preview.style.boxShadow = "0 4px 16px rgba(0,0,0,0.18)";
    preview.style.borderRadius = "12px";
    preview.style.transition = "none";
    document.body.appendChild(preview);
    documentDragPreviewRef.current = preview;

    setDraggedDocumentId(documentId);
    setDragOverDocumentId(null);
    setDragOverDocumentPosition(null);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";

    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;

    const onMove = (moveEvent: MouseEvent) => {
      preview.style.top = `${moveEvent.clientY - offsetY}px`;
      if (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3) {
        moved = true;
      }

      const target = getDocumentDropTarget(moveEvent.clientX, moveEvent.clientY, documentId);
      setDragOverDocumentId(target.id);
      setDragOverDocumentPosition(target.position);
    };

    const onUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (moved) {
        const target = getDocumentDropTarget(upEvent.clientX, upEvent.clientY, documentId);
        if (target.id && target.position) {
          void reorderDocument(documentId, target.id, target.position);
        }
      }
      resetDocumentDrag();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const openDocumentPublication = (documentId: string) => {
    setDocumentActionMenu(null);
    setDocumentDetailsId(null);
    selectDocument(documentId);
    requestPublicationDialog(documentId);
  };

  const openDocumentDetails = (documentId: string) => {
    // The anchor was captured when the menu opened; without it the details card
    // would have nothing to hang from and would be parked in a corner.
    if (!documentDetailsAnchorRef.current) return;
    setDocumentActionMenu(null);
    setDocumentDetailsId(documentId);
  };

  // Label + value only. The chip paints its own states now, exactly like the
  // note explorer's tag chips, so per-status classes are gone with the old
  // segmented control this replaced.
  const publicationFilterOptions: Array<{ value: PublicationFilter; label: string }> = [
    { value: "all", label: t(lang, "all") },
    { value: "draft", label: t(lang, "cloudDocumentUnpublished") },
    { value: "scheduled", label: t(lang, "cloudDocumentScheduled") },
    { value: "published", label: t(lang, "cloudDocumentPublished") },
  ];

  /**
   * Opens the row menu at a point in the viewport.
   *
   * The row itself is the anchor for the details popover that one of these menu
   * items launches, so it is captured here - the menu no longer has a trigger
   * button whose rect could be measured later.
   */
  const openDocumentActionMenu = (documentId: string, x: number, y: number) => {
    setDocumentDetailsId(null);
    setDocumentActionMenu({ id: documentId, x, y });
    setDocumentActionMenuPosition(clampFloatingMenu(x, y));
  };

  return (
    <>
      <aside className="app-interactive-surface flex h-full w-full min-w-0 flex-col">
        {/* Same 36px bar as the note explorer and the todo list panel, so the
            hairline lands on one line across all three cards. The workspace
            name, role and counters used to sit in a ~120px gradient hero with a
            bordered switcher card inside it - that hero is the single reason
            this column did not look like the other two. */}
        <div className="flex h-9 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <h2 className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            {t(lang, "workspaceTitle")}
          </h2>
          <div className="flex flex-shrink-0 items-center gap-0.5">
            <span
              className="mr-1 text-[11px] font-semibold leading-none tabular-nums text-text-muted"
              title={t(lang, "workspaceDocuments")}
            >
              {documents.length}
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => openDialog("newDocument")}
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-accent-text"
                title={t(lang, "newCloudDocument")}
                aria-label={t(lang, "newCloudDocument")}
              >
                <Plus size={14} />
              </button>
            )}
            {activeWorkspace && (
              <button
                type="button"
                onClick={() => openManage("permissions")}
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-accent-text"
                title={t(lang, "permissionManagement")}
                aria-label={t(lang, "permissionManagement")}
              >
                <ShieldCheck size={14} />
              </button>
            )}
          </div>
        </div>

        {/* The switcher is a flat 32px row: the same height and rhythm as the
            document rows below it, with the role kept as an annotation at the
            end of the row instead of a badge in a card header. */}
        <div className="flex flex-shrink-0 items-center gap-1 px-2 pt-2">
          <WorkspaceDropdown
            value={activeWorkspaceId ?? ""}
            options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
            onChange={(workspaceId) => void selectWorkspace(workspaceId || null)}
            placeholder={t(lang, "workspace")}
            ariaLabel={t(lang, "workspace")}
            disabled={workspaces.length === 0}
            tone="plain"
            containerClassName="min-w-0 flex-1"
            triggerClassName="h-8 text-[13px] font-medium"
          />
          {activeWorkspace && (
            <span className="flex-shrink-0 rounded-full bg-bg-hover px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
              {roleLabel(lang, activeWorkspace.role)}
            </span>
          )}
        </div>

        {/* Publication filter as chips, the shape the note explorer already uses
            for tags: same radius, same padding, same accent fill when selected. */}
        {workspaces.length > 0 && (
          <div
            role="group"
            aria-label={t(lang, "publicationStatus")}
            className="flex flex-shrink-0 flex-wrap items-center gap-1 px-2 py-1.5"
          >
            {publicationFilterOptions.map((option) => {
              const selected = publicationFilter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setPublicationFilter(option.value)}
                  className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
                    selected
                      ? "bg-accent text-on-accent"
                      : "bg-bg-hover text-text-secondary hover:bg-bg-active hover:text-text-primary"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        )}

        <div ref={documentListRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {/* A real row, not a header: the overview is a destination of this
              column, and it was unreachable from here once a document was open
              (the strip's workspace name only exists while nothing is open). */}
          {workspaces.length > 0 && (
            <div className="relative mb-0.5 rounded-lg">
              <button
                type="button"
                onClick={() => selectDocument(null)}
                aria-current={activeDocumentId ? undefined : "page"}
                title={t(lang, "overviewBackToOverview")}
                className={`relative flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left ${
                  activeDocumentId
                    ? "text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    : "flat-active-row text-[13px] font-medium text-text-primary"
                }`}
              >
                {!activeDocumentId && <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-r-full bg-accent" />}
                <span className={`flex flex-shrink-0 items-center justify-center ${activeDocumentId ? "text-text-muted" : "text-accent-text"}`}>
                  <LayoutDashboard size={13} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1 truncate">{t(lang, "workspaceOverview")}</span>
              </button>
            </div>
          )}
          {filteredDocuments.map((document) => {
            const isActive = document.id === activeDocumentId;
            const isDragOver = document.id === dragOverDocumentId;
            const PublicationIcon = document.publicationStatus === "scheduled"
              ? FileClock
              : document.publicationStatus === "published"
                ? FileCheck2
                : FileText;
            // The status lives in the icon colour rather than in a second line
            // of badges: this row is 32px tall, exactly like a note or a list.
            const statusTone = isActive
              ? "text-accent-text"
              : document.publicationStatus === "scheduled"
                ? "text-warning"
                : document.publicationStatus === "published"
                  ? "text-success"
                  : "text-text-muted";
            const documentDate = new Date(document.updatedAt);
            // Year-omitted for the current year, the same rule the todo date
            // slot uses: a 32px row has no room for "2026/10/24".
            const documentDateLabel = documentDate.getFullYear() === new Date().getFullYear()
              ? documentDate.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
                month: "numeric",
                day: "numeric",
              })
              : documentDate.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US");
            return (
              <div
                key={document.id}
                data-document-row
                data-document-id={document.id}
                onContextMenu={canEdit
                  ? (event) => {
                    // The whole row is the target: the hover `...` button it
                    // used to have made the menu a moving target that vanished
                    // as soon as the pointer travelled towards it.
                    event.preventDefault();
                    documentDetailsAnchorRef.current = event.currentTarget;
                    openDocumentActionMenu(document.id, event.clientX, event.clientY);
                  }
                  : undefined}
                onKeyDown={canEdit
                  ? (event) => {
                    // Keyboard parity for a mouse-only gesture: the context-menu
                    // key and Shift+F10 are what a right click is on a keyboard.
                    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    documentDetailsAnchorRef.current = event.currentTarget;
                    openDocumentActionMenu(document.id, rect.left + 24, rect.top + rect.height - 4);
                  }
                  : undefined}
                className={`relative mb-0.5 rounded-lg ${
                  isDragOver ? "bg-accent-light/40" : ""
                } ${draggedDocumentId === document.id ? "opacity-55" : ""}`}
              >
                {isDragOver && dragOverDocumentPosition && (
                  <span
                    aria-hidden="true"
                    className={`drag-insertion-line drag-insertion-line--${dragOverDocumentPosition}`}
                  />
                )}
                <button
                  type="button"
                  data-flat-row-button
                  onClick={() => selectDocument(document.id)}
                  aria-current={isActive ? "page" : undefined}
                  title={document.title}
                  className={`relative flex h-8 w-full items-center gap-1.5 overflow-hidden rounded-lg px-2 text-left ${
                    isActive
                      ? "flat-active-row text-[13px] font-medium text-text-primary"
                      : "text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  {isActive && <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-r-full bg-accent" />}
                  <span
                    onMouseDown={(event) => startDocumentDrag(event, document.id)}
                    title={canEdit
                      ? `${publicationStatusLabel(lang, document.publicationStatus)} · ${t(lang, "dragCloudDocument")}`
                      : publicationStatusLabel(lang, document.publicationStatus)}
                    className={`flex flex-shrink-0 items-center justify-center ${statusTone} ${
                      canEdit ? "cursor-grab active:cursor-grabbing" : ""
                    }`}
                  >
                    <PublicationIcon size={13} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{document.title}</span>
                  <span className="flex-shrink-0 text-[10px] tabular-nums text-text-muted">{documentDateLabel}</span>
                </button>
              </div>
            );
          })}
          {filteredDocuments.length === 0 && (
            <div className="mt-1 rounded-xl border border-dashed border-border bg-bg-primary/35">
              {documents.length > 0 ? (
                // The filter, not the workspace, is what hides every row, so the
                // empty state names the filter and offers no action.
                <EmptyState
                  icon={<Filter size={17} />}
                  title={t(lang, "noFilteredCloudDocuments")}
                />
              ) : workspaces.length > 0 ? (
                <EmptyState
                  icon={<FilePlus2 size={17} />}
                  title={t(lang, "noCloudDocuments")}
                  action={canEdit
                    ? { label: t(lang, "newCloudDocument"), onClick: () => openDialog("newDocument") }
                    : undefined}
                />
              ) : (
                <EmptyState
                  icon={<Users size={17} />}
                  title={t(lang, "overviewNoWorkspaceTitle")}
                  description={t(lang, "overviewNoWorkspaceHint")}
                />
              )}
            </div>
          )}
        </div>

        <div className="grid flex-shrink-0 grid-cols-2 gap-1 border-t border-border px-2 py-2">
          <button
            type="button"
            onClick={() => openDialog("createWorkspace")}
            className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            title={t(lang, "createWorkspace")}
          >
            <Plus size={13} className="flex-shrink-0" />
            <span className="truncate">{t(lang, "createWorkspace")}</span>
          </button>
          <button
            type="button"
            onClick={() => openDialog("joinWorkspace")}
            className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            title={t(lang, "joinWorkspace")}
          >
            <UserPlus size={13} className="flex-shrink-0" />
            <span className="truncate">{t(lang, "joinWorkspace")}</span>
          </button>
        </div>
      </aside>

      {actionDocument && documentActionMenuPosition && createPortal(
        <div
          data-document-action-menu
          role="menu"
          aria-label={t(lang, "documentActions")}
          className="fixed z-[10003] overflow-y-auto rounded-xl border border-border bg-bg-primary p-1.5 text-text-primary shadow-xl shadow-black/20"
          style={{
            left: documentActionMenuPosition.left,
            top: documentActionMenuPosition.top,
            width: documentActionMenuPosition.width,
            maxHeight: documentActionMenuPosition.maxHeight,
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setDocumentActionMenu(null);
              openRenameDialog({ id: actionDocument.id, title: actionDocument.title });
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent-text"
          >
            <Pencil size={13} />
            {t(lang, "renameCloudDocument")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => openDocumentPublication(actionDocument.id)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent-text"
          >
            <CalendarClock size={13} />
            {t(lang, "scheduleCloudDocument")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => openDocumentDetails(actionDocument.id)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent-text"
          >
            <Info size={13} />
            {t(lang, "documentDetails")}
          </button>
          <div className="my-1 border-t border-border/70" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setDocumentActionMenu(null);
              requestDelete({ kind: "document", id: actionDocument.id, title: actionDocument.title });
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-danger transition-colors hover:bg-danger/10"
          >
            <Trash2 size={13} />
            {t(lang, "deleteCloudDocument")}
          </button>
        </div>,
        document.body,
      )}

      {detailedDocument && documentDetailsPosition && createPortal(
        <div
          data-document-details
          role="dialog"
          aria-label={t(lang, "documentDetails")}
          className="fixed z-[10002] overflow-y-auto rounded-xl border border-border bg-bg-primary text-text-primary shadow-2xl shadow-black/20"
          style={{
            left: documentDetailsPosition.left,
            top: documentDetailsPosition.top,
            width: documentDetailsPosition.width,
            maxHeight: documentDetailsPosition.maxHeight,
          }}
        >
          <div className="flex items-center gap-2.5 border-b border-border bg-bg-sidebar/45 px-4 py-3">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text">
              <Info size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-text-primary">{t(lang, "documentDetails")}</h3>
              <p className="mt-0.5 truncate text-[11px] text-text-muted">{detailedDocument.title}</p>
            </div>
            <button
              type="button"
              onClick={() => setDocumentDetailsId(null)}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              aria-label={t(lang, "close")}
              title={t(lang, "close")}
            >
              <X size={15} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 p-4 text-xs">
            {[
              [t(lang, "cloudDocumentName"), detailedDocument.title],
              [t(lang, "documentCreator"), detailedDocumentCreator ?? "—"],
              [t(lang, "createdAt"), formatDocumentDate(lang, detailedDocument.createdAt)],
              [t(lang, "updatedAt"), formatDocumentDate(lang, detailedDocument.updatedAt)],
              [t(lang, "publicationStatus"), publicationStatusLabel(lang, detailedDocument.publicationStatus)],
              [t(lang, "collaborationMode"), t(lang, "realTimeCollaboration")],
              [t(lang, "documentAccessLevel"), accessLevelLabel(lang, detailedDocument.accessLevel)],
              ...(detailedDocument.scheduledPublishAt
                ? [[t(lang, "scheduledPublishTime"), formatDocumentDate(lang, detailedDocument.scheduledPublishAt)]]
                : []),
              ...(detailedDocument.publishedAt
                ? [[t(lang, "publishedAt"), formatDocumentDate(lang, detailedDocument.publishedAt)]]
                : []),
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 rounded-lg border border-border bg-bg-secondary/40 px-3 py-2">
                <div className="text-[11px] text-text-muted">{label}</div>
                <div className="mt-0.5 break-words text-[13px] leading-relaxed text-text-primary">{value}</div>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default WorkspaceSidebar;
