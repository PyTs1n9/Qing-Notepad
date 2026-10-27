import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  FilePlus2,
  FileText,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useWorkspaceUiStore } from "@/stores/workspaceUi";
import type {
  WorkspaceDocumentAccessLevel,
  WorkspaceInviteRole,
  WorkspaceRole,
} from "@/types/workspace";
import { supabase } from "@/utils/supabase";
import { t } from "@/utils/i18n";
import LoadingText from "@/components/LoadingText";
import EmptyState from "@/components/Layout/EmptyState";
import ModalShell from "@/components/Layout/ModalShell";
import UserAvatar from "@/components/UserAvatar";
import WorkspaceDropdown from "@/components/Workspace/WorkspaceDropdown";
import WorkspaceOverview from "@/components/Workspace/WorkspaceOverview";
import WorkspaceStrip from "@/components/Workspace/WorkspaceStrip";
import {
  accessLevelHint,
  accessLevelLabel,
  roleLabel,
} from "@/components/Workspace/workspaceLabels";

interface WorkspaceViewProps {
  onOpenAuth: () => void;
}

interface MemberRemovalConfirmation {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  displayName: string;
}

interface OwnershipTransferConfirmation {
  workspaceId: string;
  userId: string;
  displayName: string;
}

const CloudNoteEditor = lazy(() => import("@/components/Workspace/CloudNoteEditor"));

function isMissingSchemaError(error: string): boolean {
  return /workspace_members|workspaces|documents|relation .* does not exist|schema cache/i.test(error);
}

/**
 * Editor card of the workspace view: the 36px strip, then whatever the current
 * state calls for (login card, empty workspace, empty document list, or the
 * collaborative editor).
 *
 * The explorer column used to live here as an `aside` with its own width shell
 * and sash. It is now `WorkspaceSidebar`, rendered by `App.tsx` in the left
 * card like every other view's sidebar, so this component only owns the card's
 * content.
 */
export default function WorkspaceView({ onOpenAuth }: WorkspaceViewProps) {
  const lang = useSettingsStore((state) => state.lang);
  const user = useAuthStore((state) => state.user);
  const {
    workspaces,
    documents,
    members,
    activeWorkspaceId,
    activeDocumentId,
    loading,
    creatingDocument,
    error,
    reset,
    clearError,
    loadWorkspaces,
    loadDocuments,
    loadMembers,
    createWorkspace,
    joinWorkspace,
    leaveWorkspace,
    deleteWorkspace,
    updateWorkspace,
    regenerateInvite,
    createDocument,
    updateDocumentTitle,
    setDocumentPublication,
    setDocumentAccessLevel,
    deleteDocument,
    updateMemberRole,
    transferWorkspaceOwnership,
    removeMember,
  } = useWorkspaceStore();
  const dialog = useWorkspaceUiStore((state) => state.dialog);
  const dialogValue = useWorkspaceUiStore((state) => state.dialogValue);
  const dialogNotice = useWorkspaceUiStore((state) => state.dialogNotice);
  const renamingDocumentId = useWorkspaceUiStore((state) => state.renamingDocumentId);
  const deleteTarget = useWorkspaceUiStore((state) => state.deleteTarget);
  const manageOpen = useWorkspaceUiStore((state) => state.manageOpen);
  const manageSection = useWorkspaceUiStore((state) => state.manageSection);
  const publicationDocumentId = useWorkspaceUiStore((state) => state.publicationDocumentId);
  const openDialog = useWorkspaceUiStore((state) => state.openDialog);
  const closeDialog = useWorkspaceUiStore((state) => state.closeDialog);
  const setDialogValue = useWorkspaceUiStore((state) => state.setDialogValue);
  const setDialogNotice = useWorkspaceUiStore((state) => state.setDialogNotice);
  const cancelDelete = useWorkspaceUiStore((state) => state.cancelDelete);
  const setManageSection = useWorkspaceUiStore((state) => state.setManageSection);
  const openManage = useWorkspaceUiStore((state) => state.openManage);
  const closeManage = useWorkspaceUiStore((state) => state.closeManage);
  const clearPublicationDialog = useWorkspaceUiStore((state) => state.clearPublicationDialog);

  const [submittingDialog, setSubmittingDialog] = useState(false);
  const submittingDialogRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [memberRemovalConfirmation, setMemberRemovalConfirmation] = useState<MemberRemovalConfirmation | null>(null);
  const [removingMember, setRemovingMember] = useState(false);
  const [leavingWorkspace, setLeavingWorkspace] = useState(false);
  const [ownershipTransferConfirmation, setOwnershipTransferConfirmation] = useState<OwnershipTransferConfirmation | null>(null);
  const [transferringOwnership, setTransferringOwnership] = useState(false);
  const [updatingMemberUserId, setUpdatingMemberUserId] = useState<string | null>(null);
  const [updatingDocumentAccessId, setUpdatingDocumentAccessId] = useState<string | null>(null);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [savingWorkspaceName, setSavingWorkspaceName] = useState(false);
  const [copied, setCopied] = useState(false);
  const publishingDueDocumentIdsRef = useRef(new Set<string>());

  const activeWorkspace = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const activeDocument = documents.find((item) => item.id === activeDocumentId) ?? null;
  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "editor";
  const userMetadata = user?.user_metadata as Record<string, unknown> | undefined;
  const currentDisplayName = typeof userMetadata?.display_name === "string" && userMetadata.display_name.trim()
    ? userMetadata.display_name.trim()
    : null;
  const currentAvatarUrl = typeof userMetadata?.avatar_url === "string" || userMetadata?.avatar_url === null
    ? userMetadata.avatar_url
    : undefined;
  const displayedMembers = members.map((member) => member.userId === user?.id
    ? {
        ...member,
        displayName: currentDisplayName ?? member.displayName,
        avatarUrl: currentAvatarUrl !== undefined ? currentAvatarUrl : member.avatarUrl,
      }
    : member);

  useEffect(() => {
    if (user) {
      void loadWorkspaces(user.id);
    } else {
      reset();
    }
  }, [loadWorkspaces, reset, user]);

  useEffect(() => {
    if (manageOpen && activeWorkspaceId) {
      void loadMembers(activeWorkspaceId);
    }
  }, [activeWorkspaceId, loadMembers, manageOpen]);

  useEffect(() => {
    if (manageOpen && activeWorkspace) {
      setWorkspaceNameDraft(activeWorkspace.name);
    }
  }, [activeWorkspace?.id, activeWorkspace?.name, manageOpen]);

  useEffect(() => {
    const client = supabase;
    if (!client || !activeWorkspaceId || !user) return;
    let documentReloadTimer: number | null = null;
    const scheduleDocumentReload = () => {
      if (documentReloadTimer !== null) window.clearTimeout(documentReloadTimer);
      documentReloadTimer = window.setTimeout(() => {
        documentReloadTimer = null;
        void loadDocuments(activeWorkspaceId);
      }, 80);
    };
    const channel = client
      .channel(`workspace-meta-${activeWorkspaceId}-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "documents", filter: `workspace_id=eq.${activeWorkspaceId}` },
        scheduleDocumentReload,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspace_members", filter: `workspace_id=eq.${activeWorkspaceId}` },
        () => {
          void loadMembers(activeWorkspaceId);
          void loadWorkspaces(user.id);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspaces", filter: `id=eq.${activeWorkspaceId}` },
        () => { void loadWorkspaces(user.id); },
      )
      .on(
        "postgres_changes",
        // Profile rows hold the display name and avatar used by every member.
        // Listen to the full row lifecycle so a newly-created profile is also
        // picked up without requiring the user to reopen the workspace.
        { event: "*", schema: "public", table: "profiles" },
        () => { void loadMembers(activeWorkspaceId); },
      )
      .subscribe();
    return () => {
      if (documentReloadTimer !== null) window.clearTimeout(documentReloadTimer);
      void client.removeChannel(channel);
    };
  }, [activeWorkspaceId, loadDocuments, loadMembers, loadWorkspaces, user]);

  useEffect(() => {
    if (!activeWorkspaceId || !canEdit) return;
    let cancelled = false;
    let timerId: number | null = null;

    const scheduleNextPublication = () => {
      if (cancelled) return;
      const state = useWorkspaceStore.getState();
      if (state.activeWorkspaceId !== activeWorkspaceId) return;

      const scheduledDocuments = state.documents.flatMap((workspaceDocument) => {
        if (workspaceDocument.publicationStatus !== "scheduled" || !workspaceDocument.scheduledPublishAt) return [];
        const scheduledAt = Date.parse(workspaceDocument.scheduledPublishAt);
        return Number.isFinite(scheduledAt) ? [{ id: workspaceDocument.id, scheduledAt }] : [];
      });
      if (scheduledDocuments.length === 0) return;

      const now = Date.now();
      const dueDocuments = scheduledDocuments.filter(({ scheduledAt }) => scheduledAt <= now);
      const publishableDocuments = dueDocuments.filter(({ id }) => !publishingDueDocumentIdsRef.current.has(id));

      if (publishableDocuments.length > 0) {
        void Promise.all(publishableDocuments.map(async ({ id }) => {
          publishingDueDocumentIdsRef.current.add(id);
          try {
            await setDocumentPublication(id, "publish_now");
          } finally {
            publishingDueDocumentIdsRef.current.delete(id);
          }
        })).finally(() => {
          if (!cancelled) timerId = window.setTimeout(scheduleNextPublication, 5_000);
        });
        return;
      }

      if (dueDocuments.length > 0) {
        timerId = window.setTimeout(scheduleNextPublication, 250);
        return;
      }

      const nextScheduledAt = Math.min(...scheduledDocuments.map(({ scheduledAt }) => scheduledAt));
      const maximumTimerDelay = 2_147_000_000;
      const delay = Math.min(maximumTimerDelay, Math.max(25, nextScheduledAt - now + 25));
      timerId = window.setTimeout(scheduleNextPublication, delay);
    };

    scheduleNextPublication();
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [activeWorkspaceId, canEdit, documents, setDocumentPublication]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const refreshVisibleDocuments = () => {
      if (document.visibilityState === "visible") void loadDocuments(activeWorkspaceId);
    };
    const intervalId = window.setInterval(refreshVisibleDocuments, 60_000);
    document.addEventListener("visibilitychange", refreshVisibleDocuments);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshVisibleDocuments);
    };
  }, [activeWorkspaceId, loadDocuments]);

  const submitDialog = async () => {
    if (!user || !dialogValue.trim() || submittingDialogRef.current) return;
    submittingDialogRef.current = true;
    setSubmittingDialog(true);
    setDialogNotice(null);
    try {
      let ok = false;
      if (dialog === "createWorkspace") ok = await createWorkspace(dialogValue, user.id);
      if (dialog === "joinWorkspace") {
        const result = await joinWorkspace(dialogValue, user.id);
        if (result === "alreadyJoined") {
          setDialogNotice(t(lang, "workspaceAlreadyJoined"));
          return;
        }
        ok = result === "joined";
      }
      if (dialog === "newDocument") ok = await createDocument(dialogValue, user.id);
      if (dialog === "renameDocument" && renamingDocumentId) {
        ok = await updateDocumentTitle(renamingDocumentId, dialogValue.trim());
      }
      if (ok) closeDialog();
    } finally {
      submittingDialogRef.current = false;
      setSubmittingDialog(false);
    }
  };

  const copyInviteCode = async () => {
    if (!activeWorkspace) return;
    await navigator.clipboard.writeText(activeWorkspace.inviteCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const saveWorkspaceName = async () => {
    if (!activeWorkspace || !user || activeWorkspace.role !== "owner" || savingWorkspaceName) return;
    const nextName = workspaceNameDraft.trim();
    if (!nextName || nextName === activeWorkspace.name) {
      setWorkspaceNameDraft(activeWorkspace.name);
      return;
    }

    setSavingWorkspaceName(true);
    try {
      const ok = await updateWorkspace(activeWorkspace.id, { name: nextName }, user.id);
      if (ok) setWorkspaceNameDraft(nextName);
    } finally {
      setSavingWorkspaceName(false);
    }
  };

  const handleRemoveMember = (memberUserId: string, displayName: string) => {
    if (!activeWorkspace) return;
    setMemberRemovalConfirmation({
      workspaceId: activeWorkspace.id,
      workspaceName: activeWorkspace.name,
      userId: memberUserId,
      displayName,
    });
  };

  const handleMemberRoleChange = async (
    memberUserId: string,
    displayName: string,
    nextRole: WorkspaceRole,
  ) => {
    if (!activeWorkspace || activeWorkspace.role !== "owner" || updatingMemberUserId) return;
    if (nextRole === "owner") {
      setOwnershipTransferConfirmation({
        workspaceId: activeWorkspace.id,
        userId: memberUserId,
        displayName,
      });
      return;
    }

    setUpdatingMemberUserId(memberUserId);
    try {
      await updateMemberRole(activeWorkspace.id, memberUserId, nextRole);
    } finally {
      setUpdatingMemberUserId(null);
    }
  };

  const confirmOwnershipTransfer = async () => {
    if (!ownershipTransferConfirmation || !user || transferringOwnership) return;
    setTransferringOwnership(true);
    try {
      const transferred = await transferWorkspaceOwnership(
        ownershipTransferConfirmation.workspaceId,
        ownershipTransferConfirmation.userId,
        user.id,
      );
      if (transferred) setOwnershipTransferConfirmation(null);
    } finally {
      setTransferringOwnership(false);
    }
  };

  const handleDocumentAccessChange = async (
    documentId: string,
    accessLevel: WorkspaceDocumentAccessLevel,
  ) => {
    if (!activeWorkspace || !canEdit || updatingDocumentAccessId) return;
    if (activeWorkspace.role !== "owner" && accessLevel === "creator") return;
    setUpdatingDocumentAccessId(documentId);
    try {
      await setDocumentAccessLevel(documentId, accessLevel);
    } finally {
      setUpdatingDocumentAccessId(null);
    }
  };

  const confirmRemoveMember = async () => {
    if (!memberRemovalConfirmation || removingMember) return;
    setRemovingMember(true);
    try {
      const removed = await removeMember(
        memberRemovalConfirmation.workspaceId,
        memberRemovalConfirmation.userId,
      );
      if (removed) setMemberRemovalConfirmation(null);
    } finally {
      setRemovingMember(false);
    }
  };

  const handleLeaveOrDelete = async () => {
    if (!activeWorkspace || !user || leavingWorkspace) return;
    if (activeWorkspace.role === "owner") {
      useWorkspaceUiStore.getState().requestDelete({
        kind: "workspace",
        id: activeWorkspace.id,
        title: activeWorkspace.name,
      });
      return;
    }
    setLeavingWorkspace(true);
    try {
      if (await leaveWorkspace(activeWorkspace.id, user.id)) closeManage();
    } finally {
      setLeavingWorkspace(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    const pendingDelete = deleteTarget;
    setDeleting(true);
    try {
      const ok = pendingDelete.kind === "document"
        ? await deleteDocument(pendingDelete.id)
        : user
          ? await deleteWorkspace(pendingDelete.id, user.id)
          : false;
      if (ok) {
        cancelDelete();
        if (pendingDelete.kind === "workspace") closeManage();
      }
    } finally {
      setDeleting(false);
    }
  };

  const dialogTitle = dialog === "createWorkspace"
    ? t(lang, "createWorkspace")
    : dialog === "joinWorkspace"
      ? t(lang, "joinWorkspace")
      : dialog === "renameDocument"
        ? t(lang, "renameCloudDocument")
        : t(lang, "newCloudDocument");
  const dialogPlaceholder = dialog === "joinWorkspace"
    ? t(lang, "inviteCode")
    : dialog === "newDocument" || dialog === "renameDocument"
      ? t(lang, "cloudDocumentName")
      : t(lang, "workspaceName");
  const isDialogSubmitting = submittingDialog || (dialog === "newDocument" && creatingDocument);
  const DialogIcon = dialog === "joinWorkspace"
    ? UserPlus
    : dialog === "newDocument"
      ? FilePlus2
      : dialog === "renameDocument"
        ? Pencil
        : Plus;

  const schemaError = useMemo(() => Boolean(error && isMissingSchemaError(error)), [error]);

  if (!user) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary/40 p-7 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-accent-light text-accent-text">
            <Users size={23} />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-text-primary">{t(lang, "workspaceLoginRequired")}</h1>
          <p className="mt-2 text-sm text-text-muted">{t(lang, "workspaceLoginHint")}</p>
          <button
            type="button"
            onClick={onOpenAuth}
            className="mx-auto mt-5 flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            <LogIn size={15} />
            {t(lang, "authSignIn")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-interactive-surface flex min-h-0 flex-1 flex-col">
      <WorkspaceStrip />

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {error && (
          <div className="flex items-start gap-2 border-b border-danger/25 bg-danger/5 px-4 py-2 text-xs text-danger">
            <span className="flex-1">{schemaError ? t(lang, "workspaceBackendNotReady") : error}</span>
            <button type="button" onClick={clearError}><X size={13} /></button>
          </div>
        )}

        {loading && workspaces.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            <LoadingText label={t(lang, "authWorking")} />
          </div>
        ) : activeDocument && activeWorkspace ? (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
                <LoadingText label={t(lang, "authWorking")} />
              </div>
            }
          >
            <CloudNoteEditor
              key={activeDocument.id}
              document={activeDocument}
              workspaceId={activeWorkspace.id}
              role={activeWorkspace.role}
              user={user}
              publicationDialogRequested={publicationDocumentId === activeDocument.id}
              onPublicationDialogRequestHandled={clearPublicationDialog}
            />
          </Suspense>
        ) : (
          // Every other state - no workspace, a workspace without documents and
          // a workspace whose documents are all closed - renders the same
          // overview skeleton, so entering the view never changes its shape.
          <WorkspaceOverview
            onCreateDocument={() => openDialog("newDocument")}
            onCreateWorkspace={() => openDialog("createWorkspace")}
            onJoinWorkspace={() => openDialog("joinWorkspace")}
            onOpenManage={openManage}
          />
        )}
      </section>

      {dialog && (
        <ModalShell
          onClose={closeDialog}
          title={dialogTitle}
          icon={<DialogIcon size={16} />}
          size="sm"
          closeDisabled={submittingDialog}
          footer={(
            <>
              <button
                type="button"
                onClick={closeDialog}
                className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {t(lang, "confirmNo")}
              </button>
              <button
                type="button"
                onClick={() => void submitDialog()}
                disabled={!dialogValue.trim() || loading || submittingDialog || (dialog === "newDocument" && creatingDocument)}
                aria-busy={submittingDialog || (dialog === "newDocument" && creatingDocument)}
                className="h-8 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDialogSubmitting
                  ? <LoadingText label={dialogTitle} variant="bounce" />
                  : dialogTitle}
              </button>
            </>
          )}
        >
          <label className="text-xs font-medium text-text-secondary" htmlFor="workspace-dialog-input">
            {dialogPlaceholder}
          </label>
          <input
            id="workspace-dialog-input"
            value={dialogValue}
            onChange={(event) => {
              setDialogValue(event.target.value);
              setDialogNotice(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitDialog();
              }
            }}
            disabled={submittingDialog}
            autoFocus
            className="mt-2 h-8 w-full rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-60"
            placeholder={dialogPlaceholder}
          />
          {dialogNotice && <p className="mt-2 text-xs text-accent-text">{dialogNotice}</p>}
          {error && <p className="mt-2 text-xs text-danger">{schemaError ? t(lang, "workspaceBackendNotReady") : error}</p>}
        </ModalShell>
      )}

      {manageOpen && activeWorkspace && (
        <ModalShell
          onClose={closeManage}
          title={(
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">{activeWorkspace.name}</span>
              <span className="flex-shrink-0 rounded-full bg-accent-light px-2 py-0.5 text-[11px] font-semibold text-accent-text">
                {roleLabel(lang, activeWorkspace.role)}
              </span>
            </span>
          )}
          description={t(lang, manageSection === "permissions" ? "permissionManagementHint" : "workspaceSettings")}
          icon={<ShieldCheck size={16} />}
          size="xl"
          scrollBody={false}
          bodyClassName="px-4"
          tabs={(
            <div className="grid grid-cols-2 px-4">
              {(["permissions", "settings"] as const).map((section) => {
                const selected = manageSection === section;
                return (
                  <button
                    key={section}
                    type="button"
                    onClick={() => setManageSection(section)}
                    className={`relative flex h-11 items-center justify-center gap-2 text-xs font-semibold transition-colors ${
                      selected ? "text-accent-text" : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {section === "permissions" ? <ShieldCheck size={14} /> : <Settings2 size={14} />}
                    {t(lang, section === "permissions" ? "permissionManagement" : "workspaceSettings")}
                    {selected && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-accent" />}
                  </button>
                );
              })}
            </div>
          )}
          footerStart={manageSection === "settings" ? (
            <button
              type="button"
              onClick={() => void handleLeaveOrDelete()}
              disabled={leavingWorkspace}
              aria-busy={leavingWorkspace}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-danger transition-colors hover:bg-danger/10"
            >
              {leavingWorkspace ? (
                <LoadingText label={t(lang, "leaveWorkspace")} variant="bounce" />
              ) : (
                <>
                  {activeWorkspace.role === "owner" ? <Trash2 size={13} /> : <LogOut size={13} />}
                  {t(lang, activeWorkspace.role === "owner" ? "deleteWorkspace" : "leaveWorkspace")}
                </>
              )}
            </button>
          ) : undefined}
          footer={(
            <button
              type="button"
              onClick={closeManage}
              className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              {t(lang, "close")}
            </button>
          )}
        >
          <div className="flex min-h-0 flex-1 flex-col">
              {manageSection === "settings" && (
                // One scroll container for the whole tab. The page used to be
                // `overflow-hidden`, so any window shorter than the 800px panel
                // simply cut the lower sections off with no way to reach them.
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1 pr-1 [scrollbar-gutter:stable]">
                  {activeWorkspace.role === "owner" ? (
                    <>
                      <section className="border-b border-border py-5">
                        <div className="mb-3">
                          <h3 className="text-sm font-semibold text-text-primary">{t(lang, "renameWorkspace")}</h3>
                          <p className="mt-1 text-xs leading-relaxed text-text-muted">{t(lang, "workspaceNameHint")}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            value={workspaceNameDraft}
                            onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void saveWorkspaceName();
                              }
                            }}
                            maxLength={80}
                            disabled={savingWorkspaceName}
                            aria-label={t(lang, "workspaceName")}
                            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-60"
                          />
                          <button
                            type="button"
                            onClick={() => void saveWorkspaceName()}
                            disabled={savingWorkspaceName || !workspaceNameDraft.trim() || workspaceNameDraft.trim() === activeWorkspace.name}
                            className="flex h-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {savingWorkspaceName
                              ? <LoadingText label={t(lang, "authWorking")} variant="bounce" />
                              : t(lang, "saveWorkspaceName")}
                          </button>
                        </div>
                      </section>

                      {/* Share used to be one horizontal flex row that also
                          swallowed the invite-role control, with the code
                          rendered twice (one copy hidden on small screens). Three
                          stacked blocks instead: code + actions, then the
                          default role for whoever joins. */}
                      <section className="border-b border-border py-5">
                        <h3 className="text-sm font-semibold text-text-primary">{t(lang, "shareWorkspace")}</h3>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <code className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-semibold tracking-[0.16em] text-text-primary">
                            {activeWorkspace.inviteCode}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copyInviteCode()}
                            className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
                          >
                            <Copy size={12} />
                            <span>{copied ? t(lang, "copied") : t(lang, "copyInvite")}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void regenerateInvite(activeWorkspace.id, user.id)}
                            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                          >
                            <RefreshCw size={12} />
                            <span>{t(lang, "regenerateInvite")}</span>
                          </button>
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/70 pt-3">
                          <label className="text-xs font-medium text-text-secondary">{t(lang, "inviteRole")}</label>
                          <WorkspaceDropdown
                            value={activeWorkspace.inviteRole}
                            options={[
                              { value: "editor", label: t(lang, "roleEditor") },
                              { value: "viewer", label: t(lang, "roleViewer") },
                            ]}
                            onChange={(value) => void updateWorkspace(
                              activeWorkspace.id,
                              { invite_role: value as WorkspaceInviteRole },
                              user.id,
                            )}
                            ariaLabel={t(lang, "inviteRole")}
                            triggerClassName="h-8 min-w-[104px] text-xs"
                          />
                        </div>
                      </section>
                    </>
                  ) : (
                    // A non-owner used to get an entirely empty tab here.
                    <EmptyState
                      icon={<ShieldCheck size={17} />}
                      title={t(lang, "workspaceSettings")}
                      description={t(lang, "permissionManagementHint")}
                    />
                  )}
                </div>
              )}

              {manageSection === "permissions" && (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="grid flex-shrink-0 grid-cols-3 gap-2 pt-4">
                    {(["owner", "editor", "viewer"] as const).map((role) => (
                      <div key={role} className="rounded-xl border border-border bg-bg-secondary/40 px-3 py-2">
                        <div className="text-[11px] text-text-muted">{roleLabel(lang, role)}</div>
                        <div className="mt-0.5 text-xl font-semibold leading-none tabular-nums text-text-primary">
                          {displayedMembers.filter((member) => member.role === role).length}
                        </div>
                      </div>
                    ))}
                  </div>

                  <section className="flex-shrink-0 border-b border-border py-4">
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-text-primary">{t(lang, "memberPermissions")}</h3>
                        <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{t(lang, "memberPermissionsHint")}</p>
                      </div>
                      <span className="flex-shrink-0 rounded-full bg-bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-text-muted">
                        {displayedMembers.length}
                      </span>
                    </div>

                    {/* The list scrolls inside itself: with a dozen members it
                        used to grow unbounded and push the document table - the
                        only part that needs room - down to nothing. */}
                    <div className="max-h-[200px] overflow-y-auto overscroll-contain rounded-xl border border-border [scrollbar-gutter:stable]">
                      {displayedMembers.map((member, index) => (
                        <div
                          key={member.userId}
                          className={`flex items-center gap-2.5 px-3 py-2 ${index > 0 ? "border-t border-border" : ""}`}
                        >
                          <UserAvatar
                            name={member.displayName}
                            avatarUrl={member.avatarUrl}
                            className="h-7 w-7 bg-accent-light text-[11px] font-semibold text-accent-text"
                          />
                          <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                            {member.displayName}
                            {member.userId === user.id && (
                              <span className="ml-1.5 text-[11px] text-text-muted">({t(lang, "currentUser")})</span>
                            )}
                          </span>
                          {activeWorkspace.role === "owner" && member.role !== "owner" ? (
                            <>
                              <WorkspaceDropdown
                                value={member.role}
                                options={[
                                  { value: "owner", label: t(lang, "roleOwner") },
                                  { value: "editor", label: t(lang, "roleEditor") },
                                  { value: "viewer", label: t(lang, "roleViewer") },
                                ]}
                                onChange={(value) => void handleMemberRoleChange(
                                  member.userId,
                                  member.displayName,
                                  value as WorkspaceRole,
                                )}
                                ariaLabel={member.displayName}
                                disabled={updatingMemberUserId === member.userId}
                                triggerClassName="h-7 min-w-[104px] px-2 text-[11px] text-text-secondary"
                              />
                              <button
                                type="button"
                                onClick={() => handleRemoveMember(member.userId, member.displayName)}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                                title={t(lang, "removeMember")}
                                aria-label={t(lang, "removeMember")}
                              >
                                <UserMinus size={13} />
                              </button>
                            </>
                          ) : (
                            <span className="shrink-0 rounded-full bg-bg-secondary px-2 py-0.5 text-[11px] font-semibold text-text-muted">
                              {roleLabel(lang, member.role)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="flex min-h-0 flex-1 flex-col overflow-hidden py-4">
                    <div className="mb-2.5 flex flex-shrink-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-text-primary">{t(lang, "documentPermissions")}</h3>
                        <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{t(lang, "documentPermissionsHint")}</p>
                      </div>
                      <span className="flex-shrink-0 rounded-full bg-bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-text-muted">
                        {documents.length}
                      </span>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border border-border [scrollbar-gutter:stable]">
                      {documents.map((workspaceDocument, index) => (
                        <div
                          key={workspaceDocument.id}
                          className={`flex items-center gap-2.5 px-3 py-2 ${index > 0 ? "border-t border-border" : ""}`}
                        >
                          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-bg-secondary text-text-muted">
                            <FileText size={13} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-text-primary">{workspaceDocument.title}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                              {accessLevelHint(lang, workspaceDocument.accessLevel)}
                            </span>
                          </span>
                          {canEdit ? (
                            <WorkspaceDropdown
                              value={workspaceDocument.accessLevel}
                              options={[
                                ...(activeWorkspace.role === "owner"
                                  ? [{ value: "creator", label: t(lang, "accessCreator") }]
                                  : []),
                                { value: "managers", label: t(lang, "accessManagers") },
                                { value: "members", label: t(lang, "accessMembers") },
                              ]}
                              onChange={(value) => void handleDocumentAccessChange(
                                workspaceDocument.id,
                                value as WorkspaceDocumentAccessLevel,
                              )}
                              ariaLabel={`${workspaceDocument.title} · ${t(lang, "documentAccessLevel")}`}
                              disabled={updatingDocumentAccessId === workspaceDocument.id}
                              triggerClassName="h-7 min-w-[132px] px-2 text-[11px] text-text-secondary"
                            />
                          ) : (
                            <span className="shrink-0 rounded-full border border-border bg-bg-secondary px-2 py-0.5 text-[11px] font-semibold text-text-muted">
                              {accessLevelLabel(lang, workspaceDocument.accessLevel)}
                            </span>
                          )}
                        </div>
                      ))}
                      {documents.length === 0 && (
                        <EmptyState
                          icon={<FilePlus2 size={17} />}
                          title={t(lang, "noCloudDocuments")}
                        />
                      )}
                    </div>
                  </section>
                </div>
              )}
            </div>

        </ModalShell>
      )}

      {ownershipTransferConfirmation && (
        <ModalShell
          onClose={() => setOwnershipTransferConfirmation(null)}
          title={t(lang, "transferCreator")}
          description={ownershipTransferConfirmation.displayName}
          icon={<ShieldCheck size={16} />}
          tone="warning"
          size="sm"
          closeDisabled={transferringOwnership}
          footer={(
            <>
              <button
                type="button"
                onClick={() => setOwnershipTransferConfirmation(null)}
                disabled={transferringOwnership}
                className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              >
                {t(lang, "confirmNo")}
              </button>
              <button
                type="button"
                onClick={() => void confirmOwnershipTransfer()}
                disabled={transferringOwnership}
                aria-busy={transferringOwnership}
                className="h-8 rounded-lg bg-warning px-3 text-xs font-medium text-on-warning transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {transferringOwnership
                  ? <LoadingText label={t(lang, "confirmTransferCreator")} variant="bounce" />
                  : t(lang, "confirmTransferCreator")}
              </button>
            </>
          )}
        >
          <p className="text-sm leading-relaxed text-text-secondary">
            {t(lang, "transferCreatorWarning").replace(
              "{member}",
              ownershipTransferConfirmation.displayName,
            )}
          </p>
        </ModalShell>
      )}

      {deleteTarget && (
        <ModalShell
          onClose={cancelDelete}
          title={t(lang, deleteTarget.kind === "workspace" ? "deleteWorkspace" : "deleteCloudDocument")}
          description={deleteTarget.title}
          icon={<Trash2 size={16} />}
          tone="danger"
          size="sm"
          closeDisabled={deleting}
          footer={(
            <>
              <button
                type="button"
                onClick={cancelDelete}
                disabled={deleting}
                className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t(lang, "confirmNo")}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                aria-busy={deleting}
                className="h-8 rounded-lg bg-danger px-3 text-xs text-on-danger transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting
                  ? <LoadingText label={t(lang, "confirmYes")} variant="bounce" />
                  : t(lang, "confirmYes")}
              </button>
            </>
          )}
        >
          <p className="text-sm leading-relaxed text-text-secondary">
            {t(
              lang,
              deleteTarget.kind === "workspace"
                ? "confirmDeleteWorkspace"
                : "confirmDeleteCloudDocument",
            ).replace(
              deleteTarget.kind === "workspace" ? "{workspace}" : "{document}",
              deleteTarget.title,
            )}
          </p>
        </ModalShell>
      )}

      {memberRemovalConfirmation && (
        <ModalShell
          onClose={() => setMemberRemovalConfirmation(null)}
          title={t(lang, "removeMember")}
          description={memberRemovalConfirmation.workspaceName}
          icon={<UserMinus size={16} />}
          tone="danger"
          size="sm"
          closeDisabled={removingMember}
          footer={(
            <>
              <button
                type="button"
                onClick={() => setMemberRemovalConfirmation(null)}
                disabled={removingMember}
                className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t(lang, "confirmNo")}
              </button>
              <button
                type="button"
                onClick={() => void confirmRemoveMember()}
                disabled={removingMember}
                aria-busy={removingMember}
                className="h-8 rounded-lg bg-danger px-3 text-xs text-on-danger transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {removingMember
                  ? <LoadingText label={t(lang, "confirmYes")} variant="bounce" />
                  : t(lang, "confirmYes")}
              </button>
            </>
          )}
        >
          <p className="text-sm leading-relaxed text-text-secondary">
            {t(lang, "confirmRemoveMember")
              .replace("{member}", memberRemovalConfirmation.displayName)
              .replace("{workspace}", memberRemovalConfirmation.workspaceName)}
          </p>
        </ModalShell>
      )}
    </div>
  );
}
