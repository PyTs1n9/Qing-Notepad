import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, FileCheck2, FileClock, FileText, MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useWorkspaceUiStore } from "@/stores/workspaceUi";
import { t } from "@/utils/i18n";
import ShellStrip from "@/components/Layout/ShellStrip";
import DropdownMenu, { type DropdownEntry } from "@/components/Layout/DropdownMenu";
import { publicationStatusLabel } from "@/components/Workspace/workspaceLabels";

/** Tone of the publication chip; muted while the document is still a draft. */
const PUBLICATION_TONE: Record<string, string> = {
  draft: "border-border text-text-muted",
  scheduled: "border-warning/25 bg-warning/10 text-warning",
  published: "border-success/25 bg-success/10 text-success",
};

/**
 * Top strip of the workspace card. 36px, one hairline, so it lands on the same
 * line as the note tab strip and the todo strip.
 *
 * With a document open it carries the document name, the publication state and
 * the number of collaborators in the room; with nothing open it falls back to
 * "workspace + document count" and offers no actions, because there is nothing
 * to act on (the editor card shows the empty state).
 *
 * Renaming lives here now that the document title is no longer an input inside
 * the editor: the `...` menu starts an inline edit whose draft is debounced the
 * same way the old editor field was (600ms idle, queued so two saves can never
 * interleave, Escape restores the persisted name).
 */
const WorkspaceStrip: React.FC = () => {
  const lang = useSettingsStore((state) => state.lang);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const documents = useWorkspaceStore((state) => state.documents);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const activeDocumentId = useWorkspaceStore((state) => state.activeDocumentId);
  const updateDocumentTitle = useWorkspaceStore((state) => state.updateDocumentTitle);
  const selectDocument = useWorkspaceStore((state) => state.selectDocument);
  const onlineCollaborators = useWorkspaceUiStore((state) => state.onlineCollaborators);
  const requestDelete = useWorkspaceUiStore((state) => state.requestDelete);

  const activeWorkspace = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const activeDocument = documents.find((item) => item.id === activeDocumentId) ?? null;
  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "editor";

  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const persistedTitleRef = useRef("");
  const titleDirtyRef = useRef(false);
  const queuedTitleRef = useRef<string | null>(null);
  const titleSaveInProgressRef = useRef(false);
  const titleSaveTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const documentId = activeDocument?.id ?? null;
  const documentTitle = activeDocument?.title ?? "";

  // Another tab, another device or a rename elsewhere must win over a stale
  // draft - but never over keystrokes that have not been saved yet.
  useEffect(() => {
    persistedTitleRef.current = documentTitle;
    if (titleDirtyRef.current || titleSaveInProgressRef.current || queuedTitleRef.current !== null) return;
    draftRef.current = documentTitle;
    setDraft(documentTitle);
  }, [documentId, documentTitle]);

  // A different document closes the editor instead of carrying the draft over.
  useEffect(() => {
    setEditingTitle(false);
    titleDirtyRef.current = false;
    queuedTitleRef.current = null;
    if (titleSaveTimerRef.current !== null) {
      window.clearTimeout(titleSaveTimerRef.current);
      titleSaveTimerRef.current = null;
    }
  }, [documentId]);

  useEffect(() => {
    if (!editingTitle) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingTitle]);

  const clearTitleSaveTimer = useCallback(() => {
    if (titleSaveTimerRef.current === null) return;
    window.clearTimeout(titleSaveTimerRef.current);
    titleSaveTimerRef.current = null;
  }, []);

  const flushQueuedTitle = useCallback(async () => {
    if (titleSaveInProgressRef.current || !documentId) return;
    titleSaveInProgressRef.current = true;
    try {
      while (queuedTitleRef.current !== null) {
        const title = queuedTitleRef.current;
        queuedTitleRef.current = null;
        if (title === persistedTitleRef.current) {
          if (draftRef.current.trim() === title) titleDirtyRef.current = false;
          continue;
        }

        const saved = await updateDocumentTitle(documentId, title);
        if (!saved) break;
        persistedTitleRef.current = title;
        if (draftRef.current.trim() === title) titleDirtyRef.current = false;
        if (!titleDirtyRef.current && draftRef.current !== title) {
          draftRef.current = title;
          setDraft(title);
        }
      }
    } finally {
      titleSaveInProgressRef.current = false;
    }
  }, [documentId, updateDocumentTitle]);

  const requestTitleSave = useCallback(() => {
    if (!canEdit) return;
    const title = draftRef.current.trim();
    if (!title) return;
    queuedTitleRef.current = title;
    void flushQueuedTitle();
  }, [canEdit, flushQueuedTitle]);

  const commitTitle = useCallback(() => {
    clearTitleSaveTimer();
    const title = draftRef.current.trim();
    if (!title) {
      queuedTitleRef.current = null;
      titleDirtyRef.current = false;
      draftRef.current = persistedTitleRef.current;
      setDraft(persistedTitleRef.current);
      setEditingTitle(false);
      return;
    }
    if (draftRef.current !== title) {
      draftRef.current = title;
      setDraft(title);
    }
    titleDirtyRef.current = title !== persistedTitleRef.current;
    requestTitleSave();
    setEditingTitle(false);
  }, [clearTitleSaveTimer, requestTitleSave]);

  useEffect(() => {
    if (!editingTitle || !canEdit || !titleDirtyRef.current || !draft.trim()) return;
    const timer = window.setTimeout(requestTitleSave, 600);
    titleSaveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (titleSaveTimerRef.current === timer) titleSaveTimerRef.current = null;
    };
  }, [canEdit, draft, editingTitle, requestTitleSave]);

  const PublicationIcon = activeDocument?.publicationStatus === "scheduled"
    ? FileClock
    : activeDocument?.publicationStatus === "published"
      ? FileCheck2
      : FileText;

  const startRenaming = () => {
    if (!activeDocument) return;
    draftRef.current = activeDocument.title;
    setDraft(activeDocument.title);
    titleDirtyRef.current = false;
    setEditingTitle(true);
  };

  return (
    <ShellStrip
      leading={
        activeDocument ? (
          <>
            {/* With a document open the strip carries the document title, so the
                workspace name is gone and this chevron is the only way back to
                the overview from a collapsed sidebar. */}
            <button
              type="button"
              onClick={() => selectDocument(null)}
              title={t(lang, "overviewBackToOverview")}
              aria-label={t(lang, "overviewBackToOverview")}
              className="-ml-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-accent-text"
            >
              <ChevronLeft size={15} />
            </button>
            <PublicationIcon
              size={14}
              className={`flex-shrink-0 ${
                activeDocument.publicationStatus === "published"
                  ? "text-success"
                  : activeDocument.publicationStatus === "scheduled"
                    ? "text-warning"
                    : "text-accent-text"
              }`}
            />
          </>
        ) : (
          <Users size={14} className="flex-shrink-0 text-accent-text" />
        )
      }
      trailing={
        activeDocument ? (
          <>
            <span
              className="flex h-6 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted"
              title={t(lang, "onlineUsers")}
            >
              <Users size={12} />
              <span className="tabular-nums">{onlineCollaborators}</span>
            </span>
            {canEdit && (
              <DropdownMenu
                label={t(lang, "documentActions")}
                icon={MoreHorizontal}
                iconSize={15}
                align="end"
                triggerClassName="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                entries={[
                  {
                    id: "rename",
                    label: t(lang, "renameCloudDocument"),
                    icon: Pencil,
                    onSelect: startRenaming,
                  },
                  { separator: true },
                  {
                    id: "delete",
                    label: t(lang, "deleteCloudDocument"),
                    icon: Trash2,
                    danger: true,
                    onSelect: () => requestDelete({
                      kind: "document",
                      id: activeDocument.id,
                      title: activeDocument.title,
                    }),
                  },
                ] satisfies DropdownEntry[]}
              />
            )}
          </>
        ) : null
      }
    >
      {activeDocument ? (
        <>
          {editingTitle ? (
            <input
              ref={inputRef}
              value={draft}
              maxLength={200}
              onChange={(event) => {
                draftRef.current = event.target.value;
                titleDirtyRef.current = true;
                setDraft(event.target.value);
              }}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  clearTitleSaveTimer();
                  queuedTitleRef.current = null;
                  titleDirtyRef.current = false;
                  draftRef.current = persistedTitleRef.current;
                  setDraft(persistedTitleRef.current);
                  setEditingTitle(false);
                }
              }}
              aria-label={t(lang, "cloudDocumentName")}
              className="h-6 min-w-0 flex-1 rounded border border-accent/40 bg-bg-primary/60 px-1.5 text-[13px] font-semibold text-text-primary outline-none"
            />
          ) : (
            <span className="min-w-0 max-w-[240px] truncate text-[13px] font-semibold text-text-primary">
              {activeDocument.title}
            </span>
          )}
          <span
            className={`shell-strip__optional flex-shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium ${
              PUBLICATION_TONE[activeDocument.publicationStatus] ?? PUBLICATION_TONE.draft
            }`}
          >
            {publicationStatusLabel(lang, activeDocument.publicationStatus)}
          </span>
        </>
      ) : (
        <>
          {/* Without an open document this strip *is* the overview header, so
              the name doubles as the "back to overview" target. With a document
              open the editor owns the card and the name stays plain text -
              a fake link back to where the user already is would only add noise. */}
          {activeWorkspace ? (
            <button
              type="button"
              onClick={() => selectDocument(null)}
              title={t(lang, "overviewBackToOverview")}
              aria-label={t(lang, "overviewBackToOverview")}
              className="min-w-0 max-w-[220px] truncate rounded text-left text-[13px] font-semibold text-text-primary transition-colors hover:text-accent-text"
            >
              {activeWorkspace.name}
            </button>
          ) : (
            <span className="min-w-0 max-w-[220px] truncate text-[13px] font-semibold text-text-primary">
              {t(lang, "workspaceTitle")}
            </span>
          )}
          <span className="shell-strip__optional flex-shrink-0 text-[11px] text-text-muted">
            <span className="tabular-nums">{documents.length}</span> {t(lang, "workspaceDocuments")}
          </span>
        </>
      )}
    </ShellStrip>
  );
};

export default WorkspaceStrip;
