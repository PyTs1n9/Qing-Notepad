import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  FileCheck2,
  FileClock,
  FilePlus2,
  FileText,
  Settings2,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { t } from "@/utils/i18n";
import EmptyState from "@/components/Layout/EmptyState";
import UserAvatar from "@/components/UserAvatar";
import { roleLabel } from "@/components/Workspace/workspaceLabels";

interface WorkspaceOverviewProps {
  onCreateDocument: () => void;
  onCreateWorkspace: () => void;
  onJoinWorkspace: () => void;
  onOpenManage: (section: "permissions" | "settings") => void;
}

const RECENT_DOCUMENT_LIMIT = 5;
const MAX_VISIBLE_MEMBERS = 5;

/**
 * Landing page of the workspace card.
 *
 * The workspace view used to drop straight into the first document, which made
 * an overview impossible: `loadDocuments` auto-selected `documents[0]`. Now the
 * card opens here and the editor is one click away, so this page is the place
 * that answers "what is in here" without a single extra request - documents and
 * members are already in the store, loaded by `loadWorkspaces` and
 * `selectWorkspace`.
 *
 * Four states, one skeleton (decision D7): no workspace, workspace without
 * documents, workspace with documents, and viewer. The footer block only exists
 * for the owner. Nothing here writes; every action is a callback that reuses the
 * dialogs already mounted by `WorkspaceView`.
 */
export default function WorkspaceOverview({
  onCreateDocument,
  onCreateWorkspace,
  onJoinWorkspace,
  onOpenManage,
}: WorkspaceOverviewProps) {
  const lang = useSettingsStore((state) => state.lang);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const documents = useWorkspaceStore((state) => state.documents);
  const members = useWorkspaceStore((state) => state.members);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const selectDocument = useWorkspaceStore((state) => state.selectDocument);

  const [copied, setCopied] = useState(false);

  const workspace = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const role = workspace?.role ?? null;
  // `canEdit` gates every create entry: an editor can add documents, a viewer
  // cannot. Owner-only surfaces (invite code, admin entries) use `isOwner`.
  const canEdit = role === "owner" || role === "editor";
  const isOwner = role === "owner";
  const isViewer = role === "viewer";

  const counts = useMemo(() => {
    let draft = 0;
    let scheduled = 0;
    let published = 0;
    for (const document of documents) {
      if (document.publicationStatus === "scheduled") scheduled += 1;
      else if (document.publicationStatus === "published") published += 1;
      else draft += 1;
    }
    return { total: documents.length, draft, scheduled, published };
  }, [documents]);

  const recentDocuments = useMemo(
    () => [...documents]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, RECENT_DOCUMENT_LIMIT),
    [documents],
  );

  const visibleMembers = members.slice(0, MAX_VISIBLE_MEMBERS);

  const copyInviteCode = useCallback(async () => {
    if (!workspace) return;
    try {
      await navigator.clipboard.writeText(workspace.inviteCode);
      setCopied(true);
    } catch {
      // Clipboard access can be denied. The code stays selectable in the
      // `<code>` element, so nothing is lost - only the confirmation is skipped.
      setCopied(false);
    }
  }, [workspace]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const formatDate = (value: string | null) => (
    value ? new Date(value).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US") : "—"
  );

  const stats: Array<{ key: string; label: string; value: number; icon: typeof FileText; pending?: boolean }> = [
    { key: "total", label: t(lang, "overviewDocuments"), value: counts.total, icon: FileText },
    { key: "draft", label: t(lang, "cloudDocumentDraft"), value: counts.draft, icon: FileText, pending: true },
    { key: "scheduled", label: t(lang, "cloudDocumentScheduled"), value: counts.scheduled, icon: FileClock },
    { key: "published", label: t(lang, "cloudDocumentPublished"), value: counts.published, icon: FileCheck2 },
  ];

  return (
    <div className="workspace-overview flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-5 py-5 sm:px-7 sm:py-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="brand-face min-w-0 truncate text-[19px] leading-tight text-text-primary">
                {workspace?.name ?? t(lang, "workspaceTitle")}
              </h1>
              {role && (
                <span className="flex-shrink-0 rounded-full border border-accent/15 bg-accent-light px-2 py-0.5 text-[11px] font-semibold text-accent-text">
                  {roleLabel(lang, role)}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {isViewer
                ? t(lang, "overviewReadOnlyHint")
                : `${counts.total} ${t(lang, "workspaceDocuments")} · ${members.length} ${t(lang, "overviewMembers")}`}
            </p>
          </div>
          {isOwner && (
            <button
              type="button"
              onClick={() => onOpenManage("permissions")}
              className="flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:bg-bg-hover/60 hover:text-text-primary"
            >
              <ShieldCheck size={13} className="text-accent-text" />
              {t(lang, "manageWorkspace")}
            </button>
          )}
        </header>

        {!workspace ? (
          <section className="mt-6">
            <div className="rounded-xl border border-border bg-bg-secondary/40">
              <EmptyState
                icon={<Users size={18} />}
                title={t(lang, "overviewNoWorkspaceTitle")}
                description={t(lang, "overviewNoWorkspaceHint")}
              />
              <div className="workspace-overview-pair px-6 pb-6">
                <button
                  type="button"
                  onClick={onCreateWorkspace}
                  className="flat-create-trigger group flex min-h-12 items-center gap-2.5 rounded-xl border border-border px-2.5 text-left text-sm font-medium text-text-primary hover:border-accent/40 hover:bg-bg-hover/45"
                >
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text transition-transform duration-200 group-hover:rotate-90">
                    <FilePlus2 size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate leading-tight">{t(lang, "createWorkspace")}</span>
                    <span className="mt-0.5 block truncate text-xs font-normal text-text-muted">
                      {t(lang, "workspaceName")}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={onJoinWorkspace}
                  className="flat-create-trigger group flex min-h-12 items-center gap-2.5 rounded-xl border border-border px-2.5 text-left text-sm font-medium text-text-primary hover:border-accent/40 hover:bg-bg-hover/45"
                >
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-light text-accent-text transition-transform duration-200 group-hover:scale-105">
                    <UserPlus size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate leading-tight">{t(lang, "joinWorkspace")}</span>
                    <span className="mt-0.5 block truncate text-xs font-normal text-text-muted">
                      {t(lang, "overviewInviteCode")}
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section
              className="workspace-overview-stats mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              aria-label={t(lang, "workspaceOverview")}
            >
              {stats.map((stat) => (
                <div
                  key={stat.key}
                  className="rounded-xl border border-border bg-bg-secondary/40 px-3.5 py-3"
                >
                  <div className="flex items-center gap-1.5 text-xs text-text-muted">
                    <stat.icon size={12} className="flex-shrink-0 opacity-70" />
                    <span className="min-w-0 truncate">{stat.label}</span>
                    {stat.pending && stat.value > 0 && (
                      <span
                        className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning"
                        title={t(lang, "overviewPendingPublish")}
                      />
                    )}
                  </div>
                  <div className="mt-1.5 text-2xl font-semibold leading-none tabular-nums text-text-primary">
                    {stat.value}
                  </div>
                </div>
              ))}
            </section>

            <div className="workspace-overview-body mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <section className="min-w-0 rounded-xl border border-border bg-bg-secondary/40">
                <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5">
                  <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">
                    {t(lang, "overviewRecent")}
                  </h2>
                  {recentDocuments.length > 0 && canEdit && (
                    <button
                      type="button"
                      onClick={onCreateDocument}
                      className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-accent-text transition-colors hover:bg-accent/10"
                    >
                      <FilePlus2 size={12} />
                      {t(lang, "newCloudDocument")}
                    </button>
                  )}
                </div>
                {recentDocuments.length === 0 ? (
                  <EmptyState
                    icon={<FilePlus2 size={18} />}
                    title={t(lang, "overviewRecentEmpty")}
                    description={t(lang, "overviewRecentEmptyHint")}
                    // A viewer gets no action: the button would open a dialog
                    // whose submit the permissions table rejects.
                    action={canEdit ? { label: t(lang, "newCloudDocument"), onClick: onCreateDocument } : undefined}
                  />
                ) : (
                  <ul className="p-1.5">
                    {recentDocuments.map((document) => {
                      const tone = document.publicationStatus === "published"
                        ? "bg-success"
                        : document.publicationStatus === "scheduled"
                          ? "bg-warning"
                          : "bg-text-muted/60";
                      return (
                        <li key={document.id}>
                          <button
                            type="button"
                            onClick={() => selectDocument(document.id)}
                            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-primary/60"
                          >
                            <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone}`} />
                            <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                              {document.title}
                            </span>
                            <span
                              className="flex-shrink-0 text-[11px] tabular-nums text-text-muted"
                              title={t(lang, "overviewUpdatedAt")}
                            >
                              {formatDate(document.updatedAt)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <aside className="min-w-0 rounded-xl border border-border bg-bg-secondary/40">
                <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5">
                  <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">
                    {t(lang, "overviewMembers")}
                  </h2>
                  <span className="text-[11px] font-semibold tabular-nums text-text-muted">
                    {members.length}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 px-3.5 py-3">
                  <div className="flex items-center -space-x-1.5">
                    {visibleMembers.map((member) => (
                      <UserAvatar
                        key={member.userId}
                        name={member.displayName}
                        avatarUrl={member.avatarUrl}
                        className="h-7 w-7 border-2 border-bg-secondary bg-accent-light text-[11px] font-semibold text-accent-text"
                      />
                    ))}
                    {members.length > visibleMembers.length && (
                      <span className="flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-bg-secondary bg-bg-active px-1 text-[11px] font-semibold tabular-nums text-text-secondary">
                        +{members.length - visibleMembers.length}
                      </span>
                    )}
                    {members.length === 0 && (
                      <span aria-hidden="true" className="text-xs text-text-muted">—</span>
                    )}
                  </div>
                  {role && (
                    <span className="ml-auto flex-shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                      {roleLabel(lang, role)}
                    </span>
                  )}
                </div>
              </aside>
            </div>

            {isOwner && (
              <section className="mt-3 rounded-xl border border-border bg-bg-secondary/40">
                <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5">
                  <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">
                    {t(lang, "overviewOwnerTools")}
                  </h2>
                  {counts.draft > 0 && (
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
                      <span className="tabular-nums">{counts.draft}</span>
                      {t(lang, "overviewPendingPublish")}
                    </span>
                  )}
                </div>
                <div className="workspace-overview-actions px-3.5 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-bg-primary/60 px-2.5 py-1.5 text-xs font-semibold tracking-[0.16em] text-text-primary">
                      {workspace.inviteCode}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyInviteCode()}
                      className="flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:bg-bg-hover/60 hover:text-text-primary"
                      aria-label={t(lang, "overviewCopyInvite")}
                      title={t(lang, "overviewCopyInvite")}
                    >
                      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                      <span className="max-w-[7.5rem] truncate">
                        {copied ? t(lang, "overviewCopied") : t(lang, "overviewCopyInvite")}
                      </span>
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenManage("permissions")}
                      className="flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-border px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
                    >
                      <Users size={12} />
                      {t(lang, "permissionManagement")}
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenManage("settings")}
                      className="flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-border px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
                    >
                      <Settings2 size={12} />
                      {t(lang, "workspaceSettings")}
                    </button>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
