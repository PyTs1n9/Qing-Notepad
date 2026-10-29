import { useEffect, useState } from "react";
import { Megaphone, RefreshCw } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import {
  getCachedAnnouncements,
  getSnapshotAnnouncements,
  isAnnouncementRefreshThrottled,
  refreshAnnouncements,
  type AnnouncementViewItem,
} from "@/utils/announcements";
import ModalShell from "@/components/Layout/ModalShell";
import AnnouncementBoard from "@/components/Auth/AnnouncementBoard";
import PanelErrorBoundary from "@/components/PanelErrorBoundary";

interface ChangelogModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Changelog / announcements as a first-class entry (Help → Changelog).
 *
 * A user who never opens the login dialog would otherwise never see an
 * announcement (D9), so the same board is reachable from the help menu. The
 * loading order is the same three layers as the login dialog: snapshot first
 * (synchronous, so the dialog is never empty on open), then the disk cache, then
 * the network. Nothing is awaited before the first paint.
 */
export default function ChangelogModal({ open, onClose }: ChangelogModalProps) {
  const lang = useSettingsStore((state) => state.lang);
  const announcementsEnabled = useSettingsStore((state) => state.announcementsEnabled);
  const [items, setItems] = useState<AnnouncementViewItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * What the footer says about the last manual attempt. `upToDate` is the honest
   * answer for the common case: the source has a 1h soft TTL and a 1h hard
   * cooldown, so a click within the hour is not a failure, it is a no-op.
   */
  const [refreshNote, setRefreshNote] = useState<"none" | "upToDate" | "failed">("none");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRefreshNote("none");
    setItems(getSnapshotAnnouncements(lang));
    void getCachedAnnouncements(lang).then((cached) => {
      // An empty result means "no cache", not "nothing to announce": it must not
      // wipe the snapshot that is already on screen.
      if (!cancelled && cached.length > 0) setItems(cached);
    });
    void refreshAnnouncements(lang).then((next) => {
      if (!cancelled && next) setItems(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open, lang]);

  if (!open) return null;

  const handleRefresh = async () => {
    // Asked before the call, not inferred from its result: a throttled refresh
    // and a failed one both resolve to `null`, and only the second one deserves
    // a "couldn't load" caption.
    if (isAnnouncementRefreshThrottled()) {
      setRefreshNote("upToDate");
      return;
    }

    setRefreshing(true);
    setRefreshNote("none");
    const next = await refreshAnnouncements(lang);
    setRefreshing(false);
    if (next) {
      setItems(next);
      setRefreshNote("upToDate");
      return;
    }
    // A real attempt that produced nothing: silent while a list is on screen
    // (D7 keeps network failures quiet), a caption only when the panel is empty.
    setRefreshNote(items.length === 0 ? "failed" : "none");
  };

  return (
    <ModalShell
      onClose={onClose}
      title={t(lang, "helpChangelog")}
      description={t(lang, "announcementTitle")}
      icon={<Megaphone size={16} />}
      size="xl"
      footer={(
        <div className="flex items-center gap-2">
          {refreshNote !== "none" && (
            <span className="text-[11px] leading-4 text-text-muted">
              {t(lang, refreshNote === "failed" ? "announcementLoadFailed" : "announcementUpToDate")}
            </span>
          )}
          {/*
            Not disabled while throttled: `isAnnouncementRefreshThrottled()` is
            read at render time, so a disabled button would (a) look broken with
            no explanation right after the on-open refresh succeeded and (b) never
            re-enable itself, because nothing re-renders when the cooldown lapses.
            Leaving it clickable routes the click into `handleRefresh`, which is
            where "up to date" comes from - the caption is the explanation.
          */}
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing || !announcementsEnabled}
            title={t(lang, "announcementRefresh")}
            className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? t(lang, "announcementRefreshing") : t(lang, "announcementRefresh")}
          </button>
        </div>
      )}
    >
      <div className="space-y-3">
        <PanelErrorBoundary lang={lang}>
          {/* Full width, no height cap: the shell already scrolls the body. */}
          <AnnouncementBoard lang={lang} items={items} variant="inline" />
        </PanelErrorBoundary>
      </div>
    </ModalShell>
  );
}
