import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Megaphone,
  Sparkles,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { LangType } from "@/stores/settingsStore";
import type { AnnouncementKind, AnnouncementViewItem } from "@/utils/announcements";
import {
  isAllowedAnnouncementUrl,
  loadSeenAnnouncements,
  markAnnouncementSeen,
  stripAnnouncementImages,
} from "@/utils/announcements";
import {
  loadDismissedAnnouncements,
  markAnnouncementDismissed,
} from "@/utils/storage";
import { handleExternalLinkClick, openInDefaultBrowser } from "@/utils/externalLinks";
import { renderMarkdown } from "@/utils/markdown";
import { t } from "@/utils/i18n";

interface AnnouncementBoardProps {
  lang: LangType;
  items: AnnouncementViewItem[];
  /** Optional owner hook; the board already hides a dismissed item locally. */
  onDismiss?: (id: string) => void;
  /**
   * `auth` is the 300px column beside the login card; `inline` is full width
   * with no height cap (the changelog dialog owns the scrolling).
   */
  variant?: "auth" | "inline";
}

interface KindStyle {
  icon: LucideIcon;
  /** Icon tile. Always a tinted `*-light` fill so the glyph needs the text tier. */
  tile: string;
  /** Accent bar that carries the severity when the tile is off-screen. */
  bar: string;
}

const KIND_STYLES: Record<AnnouncementKind, KindStyle> = {
  update: { icon: Sparkles, tile: "bg-accent-light text-accent-text", bar: "bg-accent" },
  notice: { icon: Megaphone, tile: "bg-accent-light text-accent-text", bar: "bg-accent" },
  maintenance: { icon: Wrench, tile: "bg-warning/12 text-warning", bar: "bg-warning" },
  critical: { icon: AlertTriangle, tile: "bg-danger/10 text-danger", bar: "bg-danger" },
};

/**
 * The announcement signpost: one panel, a short heading, then one entry per
 * announcement.
 *
 * Self-contained on purpose. It loads its own read marks (so a previously read
 * announcement carries a muted dot) and hides dismissed entries itself, which
 * keeps `AuthModal` and the changelog dialog from each re-implementing the same
 * three states.
 *
 * Deliberate omissions:
 * - no Escape handler: `AuthModal` already owns a window-level one, and a second
 *   listener here would either double-fire or swallow it (D9);
 * - no image support: the feed strips them before this point (D7);
 * - no `window.open` / `location.href`: links go through `externalLinks.ts`.
 */
export default function AnnouncementBoard({
  lang,
  items,
  onDismiss,
  variant = "auth",
}: AnnouncementBoardProps) {
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [seen, setSeen] = useState<Record<string, string>>({});
  const [htmlById, setHtmlById] = useState<Record<string, string>>({});
  const renderedKeys = useRef<Set<string>>(new Set());

  const visible = items.filter((item) => !hiddenIds.includes(item.id));
  // Effects below key off these strings: `items` is a fresh array on every
  // parent render, so an array dependency would re-run them forever.
  const idKey = visible.map((item) => item.id).join("|");
  const bodyKey = visible.map((item) => `${item.id}:${item.body.length}`).join("|");

  // Dismissals persist (`announcements/dismissed.json`). Component state alone
  // meant "close this announcement" only held until the dialog unmounted, so the
  // entry was back the next time the user opened it - which reads as a broken
  // button, not as a preference.
  useEffect(() => {
    let cancelled = false;
    void loadDismissedAnnouncements().then((dismissed) => {
      if (cancelled) return;
      const ids = Object.keys(dismissed);
      if (ids.length === 0) return;
      setHiddenIds((previous) => Array.from(new Set([...previous, ...ids])));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Read marks. The map is captured *before* this render's items are marked, so
  // the dot means "you had already read this", not "the effect just ran".
  // Trade-off (D8 allows either shape): the dot won for both variants because it
  // reuses this one read, whereas read-driven default expansion would only ever
  // apply to the collapsed narrow-screen strip.
  useEffect(() => {
    let cancelled = false;
    void loadSeenAnnouncements().then((marks) => {
      if (cancelled) return;
      setSeen(marks);
      for (const id of idKey ? idKey.split("|") : []) {
        if (!marks[id]) void markAnnouncementSeen(id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [idKey]);

  useEffect(() => {
    let cancelled = false;
    const pending = visible.filter(
      (item) => item.body && !renderedKeys.current.has(`${item.id}:${item.body.length}`),
    );
    if (pending.length === 0) return;
    for (const item of pending) renderedKeys.current.add(`${item.id}:${item.body.length}`);

    void Promise.all(
      pending.map(
        async (item) =>
          // `renderMarkdown` keeps https images (the feed's own stripping is only
          // a source-level best effort), so the produced HTML is filtered again.
          [item.id, stripAnnouncementImages(await renderMarkdown(item.body))] as const,
      ),
    )
      .then((pairs) => {
        if (cancelled) return;
        setHtmlById((previous) => ({ ...previous, ...Object.fromEntries(pairs) }));
      })
      .catch(() => {
        // A failed render leaves the body empty; the title and link still show.
      });
    return () => {
      cancelled = true;
    };
    // `bodyKey` covers both the ids and the bodies of exactly this list.
  }, [bodyKey]);

  const handleDismiss = (id: string) => {
    setHiddenIds((previous) => (previous.includes(id) ? previous : [...previous, id]));
    // Fire and forget: the item is already gone from this render, and a failed
    // write only means it reappears on the next launch.
    void markAnnouncementDismissed(id);
    onDismiss?.(id);
  };

  /**
   * Link proxy for body copy.
   *
   * `handleExternalLinkClick` only checks the scheme, so on its own it would open
   * `[下载](https://evil.tld/x.exe)` in the system browser. The item-level `link`
   * is host-allowlisted at parse time; body anchors are not parsed, so the same
   * allowlist is applied here before delegating. Anything rejected is swallowed
   * outright - including relative targets, which the delegate would otherwise
   * leave to the webview's own navigation (D7).
   */
  const handleBodyClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element | null)?.closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (isAllowedAnnouncementUrl(href)) {
      handleExternalLinkClick(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const isCompact = variant === "inline";

  // No `h-full` on the panel: the row top-aligns its columns (`items-start`), so
  // the board keeps its content height instead of being stretched - and it can
  // never collapse to zero either, because nothing gives it a percentage height.
  return (
    <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-bg-secondary/40">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Megaphone size={14} className="flex-shrink-0 text-accent-text" />
        <h3 className="min-w-0 truncate text-xs font-semibold text-text-primary">
          {t(lang, "announcementTitle")}
        </h3>
      </div>

      {visible.length === 0 ? (
        <p className="px-3 py-3 text-[11px] leading-5 text-text-muted">{t(lang, "announcementEmpty")}</p>
      ) : (
        <div
          // `flex-1` lets the list own exactly the space the panel got from the
          // row, and the `max-h` keeps a single-column dialog from growing past
          // the viewport when the feed has several entries.
          className={`min-h-0 flex-1 ${
            isCompact ? "" : "max-h-[min(58vh,420px)] overflow-y-auto"
          }`}
          onClick={handleBodyClick}
        >
          {visible.map((item, index) => {
            const style = KIND_STYLES[item.kind];
            const Icon = style.icon;
            const link = item.link;
            const html = htmlById[item.id] ?? "";
            const isRead = Boolean(seen[item.id]);

            return (
              <article
                key={item.id}
                className={`relative flex gap-2.5 px-3 py-3 ${
                  index > 0 ? "border-t border-border" : ""
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 w-0.5 ${style.bar} opacity-70`}
                />
                <div
                  className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ${style.tile}`}
                >
                  <Icon size={13} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-1.5 pr-6">
                    {isRead && (
                      <span
                        aria-label={t(lang, "announcementRead")}
                        title={t(lang, "announcementRead")}
                        className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-text-muted/50"
                      />
                    )}
                    <h4 className="min-w-0 flex-1 text-xs font-semibold leading-5 text-text-primary">
                      {item.title}
                    </h4>
                  </div>

                  {html ? (
                    <div
                      className="announcement-body markdown-preview mt-1 text-text-secondary
                        [&_a]:text-accent-text [&_a]:underline
                        [&_code]:rounded [&_code]:bg-bg-primary [&_code]:px-1 [&_code]:py-0.5
                        [&_strong]:font-semibold [&_strong]:text-text-primary"
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  ) : item.body ? (
                    // Markdown is async; the raw text is not shown in the
                    // meantime because it would reflow a frame later.
                    <div className="mt-1 h-3 w-2/3 animate-pulse rounded bg-bg-active/60" aria-hidden="true" />
                  ) : null}

                  {link && (
                    <button
                      type="button"
                      onClick={() => void openInDefaultBrowser(link.url)}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-primary px-2 py-1 text-[11px] font-medium text-accent-text transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover"
                    >
                      {link.label || link.url}
                      <ExternalLink size={10} className="flex-shrink-0" />
                    </button>
                  )}
                </div>

                {item.dismissible && (
                  <button
                    type="button"
                    onClick={() => handleDismiss(item.id)}
                    aria-label={t(lang, "announcementClose")}
                    title={t(lang, "announcementClose")}
                    className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary"
                  >
                    <X size={11} />
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
