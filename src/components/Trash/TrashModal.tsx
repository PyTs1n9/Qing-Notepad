import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { useNoteStore } from "@/stores/noteStore";
import {
  TRASH_RETENTION_FOREVER,
  useSettingsStore,
} from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import EmptyState from "@/components/Layout/EmptyState";
import ModalShell from "@/components/Layout/ModalShell";
import {
  emptyNoteTrash,
  listTrashNotes,
  purgeExpiredNoteTrash,
  purgeTrashNote,
  restoreTrashNote,
  type TrashNoteEntry,
} from "@/utils/storage";

const DAY_MS = 24 * 60 * 60 * 1000;

interface TrashModalProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onRestored?: (noteId: string) => void;
}

type PendingConfirm =
  | { type: "delete"; entry: TrashNoteEntry }
  | { type: "empty" }
  | null;

interface Notice {
  tone: "success" | "warning" | "error";
  text: string;
}

const formatDateTime = (value: string, lang: "zh" | "en") => {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
};

const TrashModal: React.FC<TrashModalProps> = ({
  open,
  onClose,
  onOpenSettings,
  onRestored,
}) => {
  const lang = useSettingsStore((s) => s.lang);
  const trashRetentionDays = useSettingsStore((s) => s.trashRetentionDays);
  const categories = useNoteStore((s) => s.categories);
  const restoreNote = useNoteStore((s) => s.restoreNote);

  const [entries, setEntries] = useState<TrashNoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const trashDisabled = trashRetentionDays === 0;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await purgeExpiredNoteTrash();
      setEntries(await listTrashNotes());
    } catch (error) {
      console.error("Failed to refresh the recycle bin:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setPendingConfirm(null);
      setNotice(null);
      return;
    }
    // Refreshing on open also covers retention changes made while the panel stays mounted.
    void refresh();
  }, [open, trashRetentionDays, refresh]);

  const getCategoryLabel = (entry: TrashNoteEntry) =>
    entry.categoryName
    ?? categories.find((category) => category.id === entry.categoryId)?.name
    ?? t(lang, "uncategorizedNotes");

  const getRemainingLabel = (entry: TrashNoteEntry) => {
    if (trashRetentionDays === TRASH_RETENTION_FOREVER) return t(lang, "trashExpiresNever");
    const deletedAt = Date.parse(entry.deletedAt);
    if (Number.isNaN(deletedAt)) return t(lang, "trashRemainingLessThanDay");
    const days = Math.ceil((deletedAt + trashRetentionDays * DAY_MS - Date.now()) / DAY_MS);
    if (days <= 0) return t(lang, "trashRemainingLessThanDay");
    return tWithParams(lang, "trashRemaining", { days });
  };

  const handleRestore = async (entry: TrashNoteEntry) => {
    setBusyId(entry.id);
    setNotice(null);
    try {
      const restored = await restoreTrashNote(entry.id);
      if (!restored) {
        setNotice({ tone: "error", text: t(lang, "trashRestoreFailed") });
        return;
      }
      restoreNote(restored.note);
      const missing = restored.missingAttachments.length;
      setNotice({
        tone: missing > 0 ? "warning" : "success",
        text: missing > 0
          ? `${tWithParams(lang, "trashRestored", { note: restored.note.title || t(lang, "untitled") })} · ${tWithParams(lang, "trashRestoreMissingImages", { count: missing })}`
          : tWithParams(lang, "trashRestored", { note: restored.note.title || t(lang, "untitled") }),
      });
      onRestored?.(restored.note.id);
      await refresh();
    } catch (error) {
      console.error("Failed to restore a trash note:", error);
      setNotice({ tone: "error", text: t(lang, "trashRestoreFailed") });
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmedAction = async () => {
    if (!pendingConfirm) return;
    if (pendingConfirm.type === "delete") {
      setBusyId(pendingConfirm.entry.id);
      try {
        await purgeTrashNote(pendingConfirm.entry.id);
        setNotice(null);
        await refresh();
      } finally {
        setBusyId(null);
      }
    } else {
      try {
        await emptyNoteTrash();
        setNotice(null);
        await refresh();
      } catch (error) {
        console.error("Failed to empty the recycle bin:", error);
      }
    }
    setPendingConfirm(null);
  };

  if (!open) return null;

  const confirmMessage = pendingConfirm
    ? pendingConfirm.type === "delete"
      ? tWithParams(lang, "trashConfirmDeleteMessage", {
        note: pendingConfirm.entry.title || t(lang, "untitled"),
      })
      : tWithParams(lang, "trashConfirmClearMessage", { count: entries.length })
    : "";

  return (
    <ModalShell
      onClose={onClose}
      title={t(lang, "trash")}
      description={t(lang, "trashHint")}
      icon={<Trash2 size={16} />}
      size="lg"
      scrollBody={false}
      footerStart={pendingConfirm ? undefined : (
        <span className="text-xs tabular-nums text-text-muted">
          {entries.length} · {t(lang, "trash")}
        </span>
      )}
      footer={pendingConfirm ? (
        <>
          <button
            type="button"
            onClick={() => setPendingConfirm(null)}
            className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            {t(lang, "confirmNo")}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirmedAction()}
            className="h-8 rounded-lg bg-danger px-3 text-xs text-on-danger transition-colors hover:bg-danger/90"
          >
            {t(lang, "confirmYes")}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setPendingConfirm({ type: "empty" })}
          disabled={entries.length === 0}
          className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t(lang, "trashClearAll")}
        </button>
      )}
    >
        {trashDisabled ? (
          <div className="flex flex-1 flex-col items-center gap-3 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-secondary text-text-muted">
              <Trash2 size={18} />
            </div>
            <div className="text-sm font-medium text-text-primary">{t(lang, "trashDisabled")}</div>
            <p className="max-w-[320px] text-xs leading-relaxed text-text-muted">
              {t(lang, "trashDisabledHint")}
            </p>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
              className="mt-1 h-8 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
            >
              {t(lang, "trashOpenSettings")}
            </button>
          </div>
        ) : (
          <>
            {pendingConfirm && (
              <div className="flex flex-shrink-0 items-start gap-2 border-b border-border bg-danger/5 px-4 py-2.5 text-text-secondary">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-danger" />
                <p className="min-w-0 flex-1 text-xs leading-relaxed">{confirmMessage}</p>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {notice && (
                <div
                  className={`mb-2 rounded-lg border px-3 py-2 text-xs
                    ${notice.tone === "error"
                      ? "border-danger/30 bg-danger/10 text-danger"
                      : notice.tone === "warning"
                        ? "border-border bg-bg-secondary text-text-secondary"
                        : "border-accent/25 bg-accent-light text-accent-text"}`}
                >
                  {notice.text}
                </div>
              )}

              {loading && entries.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-text-muted">{t(lang, "trashLoading")}</p>
              ) : entries.length === 0 ? (
                <EmptyState
                  icon={<Trash2 size={17} />}
                  title={t(lang, "trashEmpty")}
                  description={t(lang, "trashEmptyHint")}
                />
              ) : (
                <div className="space-y-1.5">
                  {entries.map((entry) => (
                    <div
                      key={entry.id}
                      className="group flex items-center gap-3 rounded-lg border border-border bg-bg-secondary/40 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-text-primary" title={entry.title}>
                          {entry.title || t(lang, "untitled")}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted">
                          <span className="truncate">
                            {tWithParams(lang, "trashOriginalCategory", { category: getCategoryLabel(entry) })}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{tWithParams(lang, "trashDeletedAt", { time: formatDateTime(entry.deletedAt, lang) })}</span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">{getRemainingLabel(entry)}</span>
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void handleRestore(entry)}
                          disabled={busyId === entry.id}
                          className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                          title={t(lang, "trashRestore")}
                        >
                          <RotateCcw size={12} />
                          <span>{t(lang, "trashRestore")}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingConfirm({ type: "delete", entry })}
                          disabled={busyId === entry.id}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-danger disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                          title={t(lang, "trashDeleteForever")}
                          aria-label={t(lang, "trashDeleteForever")}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
    </ModalShell>
  );
};

export default TrashModal;
