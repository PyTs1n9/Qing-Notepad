import { useState, useCallback, useEffect } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { X, ExternalLink, QrCode, Copy, Check } from "lucide-react";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import { APP_VERSION, GITHUB_URL } from "@/utils/updateChecker";

const BLOG_URL = "https://qing.dreamisle.top/";
const BLOG_LABEL = new URL(BLOG_URL).host;
const QQ_GROUP_NUMBER = "902898359";

const SPONSOR_IMAGES = Object.entries(
  import.meta.glob("@/assets/sponsors/*.{jpg,jpeg,png,webp,gif,svg}", {
    eager: true,
    query: "?url",
    import: "default",
  }) as Record<string, string>,
)
  .map(([path, src]) => ({
    src,
    label:
      path
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") || "Sponsor",
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Identity card only: icon, name, version, author, source, blog, QQ group and
 * sponsors.
 *
 * Update checking deliberately does not live here anymore — it is a first-class
 * entry in the Help menu (`Help → 检查更新`), and one action keeps one entry.
 */
export default function AboutModal({ open, onClose }: AboutModalProps) {
  const lang = useSettingsStore((s) => s.lang);
  const [sponsorOpen, setSponsorOpen] = useState(false);
  const [qqCopied, setQqCopied] = useState(false);

  useEffect(() => {
    if (open) return;
    setQqCopied(false);
  }, [open]);

  useEffect(() => {
    if (!qqCopied) return;
    const timeoutId = window.setTimeout(() => setQqCopied(false), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [qqCopied]);

  const openGitHubPage = useCallback(() => {
    openInDefaultBrowser(GITHUB_URL);
  }, []);

  const openBlogPage = useCallback(() => {
    openInDefaultBrowser(BLOG_URL);
  }, []);

  const copyQqGroupNumber = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(QQ_GROUP_NUMBER);
      setQqCopied(true);
    } catch {
      setQqCopied(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Dialog */}
      <div className="isolate surface-glass surface-glass--dialog relative bg-bg-secondary border border-border rounded-xl shadow-2xl w-[360px] p-6 animate-in">
        {/* Close button */}
        <button
          className="absolute top-3 right-3 p-1 rounded-md hover:bg-bg-hover transition-colors text-text-muted"
          onClick={onClose}
        >
          <X size={16} />
        </button>

        {/* App icon area */}
        <div className="flex flex-col items-center text-center">
          <img
            src="/default-icon.png"
            alt="Qing Notepad"
            className="w-16 h-16 rounded-2xl object-cover mb-4"
          />

          {/* App name - clickable GitHub link */}
          <button
            type="button"
            onClick={openGitHubPage}
            className="text-lg font-semibold text-accent-text hover:underline inline-flex items-center gap-1.5"
          >
            Qing Notepad
            <ExternalLink size={15} />
          </button>

          {/* Version */}
          <p className="text-xs text-text-muted mt-1">
            {t(lang, "version")} {APP_VERSION}
          </p>
        </div>

        {/* Info rows */}
        <div className="mt-4 space-y-2.5">
          <div className="flex items-center justify-between text-sm px-3 py-2 rounded-lg bg-bg-primary">
            <span className="text-text-muted">{t(lang, "author")}</span>
            <span className="font-medium">PyTs1N9</span>
          </div>

          <button
            type="button"
            onClick={openGitHubPage}
            className="w-full flex items-center justify-between text-sm px-3 py-2 rounded-lg bg-bg-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <span className="text-text-muted">{t(lang, "sourceCode")}</span>
            <span className="text-accent-text text-xs flex items-center gap-1">
              GitHub
              <ExternalLink size={12} />
            </span>
          </button>

          <button
            type="button"
            onClick={openBlogPage}
            className="w-full flex items-center justify-between text-sm px-3 py-2 rounded-lg bg-bg-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <span className="text-text-muted">{t(lang, "personalBlog")}</span>
            <span className="text-accent-text text-xs flex items-center gap-1">
              {BLOG_LABEL}
              <ExternalLink size={12} />
            </span>
          </button>

          <button
            type="button"
            onClick={() => void copyQqGroupNumber()}
            title={t(lang, "copyQqGroupNumber")}
            className="w-full flex items-center justify-between text-sm px-3 py-2 rounded-lg bg-bg-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <span className="text-text-muted">{t(lang, "qqDiscussionGroup")}</span>
            <span className="text-accent-text text-xs flex items-center gap-1">
              {QQ_GROUP_NUMBER}
              {qqCopied ? <Check size={12} /> : <Copy size={12} />}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setSponsorOpen(true)}
            className="w-full flex items-center justify-between text-sm px-3 py-2 rounded-lg bg-bg-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <span className="text-text-muted">{t(lang, "friendSponsor")}</span>
            <QrCode size={16} className="text-accent-text" />
          </button>
        </div>
      </div>

      {sponsorOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-5">
          <div className="absolute inset-0 bg-black/45" onClick={() => setSponsorOpen(false)} />

          <div className="isolate surface-glass surface-glass--dialog relative w-[min(92vw,760px)] max-h-[88vh] overflow-auto rounded-xl border border-border bg-bg-secondary p-5 shadow-2xl animate-in">
            <button
              className="absolute top-3 right-3 p-1 rounded-md hover:bg-bg-hover transition-colors text-text-muted"
              onClick={() => setSponsorOpen(false)}
              aria-label={t(lang, "close")}
            >
              <X size={16} />
            </button>

            <div className="mb-4 pr-8">
              <h2 className="text-base font-semibold text-text-primary">{t(lang, "friendSponsor")}</h2>
            </div>

            <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-4">
              {SPONSOR_IMAGES.map((image) => (
                <div key={image.src} className="aspect-square w-full overflow-hidden rounded-lg border border-border bg-bg-primary">
                  <img
                    src={image.src}
                    alt={`${t(lang, "friendSponsor")} ${image.label}`}
                    className="h-full w-full object-contain"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
