import { useEffect, useState } from "react";
import { BookOpen, HelpCircle, Keyboard, MousePointer2 } from "lucide-react";
import manualRaw from "../../../docs/user-manual.md?raw";
import faqRaw from "../../../docs/user-faq.md?raw";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { renderMarkdown } from "@/utils/markdown";
import ModalShell from "@/components/Layout/ModalShell";
import { SHORTCUT_REFERENCE } from "@/utils/shortcutReference";

export type HelpTab = "manual" | "faq" | "shortcuts" | "canvas";

interface HelpCenterModalProps {
  tab: HelpTab | null;
  onTabChange: (tab: HelpTab) => void;
  onClose: () => void;
}

type CanvasGuideKey =
  | "canvasGuideSelect"
  | "canvasGuidePan"
  | "canvasGuideAdd"
  | "canvasGuideZoom"
  | "canvasGuideEdit"
  | "canvasGuideOverview";

/**
 * The canvas operating hints that used to sit in a `<details>` at the bottom of
 * the old 传送门 menu. The menu is gone, so this list is their only home — the
 * wording is kept verbatim from the i18n keys.
 */
const CANVAS_GUIDE_KEYS: CanvasGuideKey[] = [
  "canvasGuideSelect",
  "canvasGuidePan",
  "canvasGuideAdd",
  "canvasGuideZoom",
  "canvasGuideEdit",
  "canvasGuideOverview",
];

const TAB_KEYS: Array<{
  id: HelpTab;
  labelKey: "helpManual" | "helpFaq" | "helpShortcuts" | "canvasGuideTitle";
  icon: typeof BookOpen;
}> = [
  { id: "manual", labelKey: "helpManual", icon: BookOpen },
  { id: "faq", labelKey: "helpFaq", icon: HelpCircle },
  { id: "shortcuts", labelKey: "helpShortcuts", icon: Keyboard },
  { id: "canvas", labelKey: "canvasGuideTitle", icon: MousePointer2 },
];

/**
 * In-app help: the manual and FAQ that already ship with the app (and feed 小青's
 * retrieval), the accelerator reference, and the canvas operating guide.
 */
export default function HelpCenterModal({ tab, onTabChange, onClose }: HelpCenterModalProps) {
  const lang = useSettingsStore((state) => state.lang);
  const toggleWindowKeys = useSettingsStore((state) => state.shortcuts.toggleWindow);
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (!tab) return;
    // Both non-markdown tabs render from structured data instead.
    if (tab === "shortcuts" || tab === "canvas") {
      setHtml("");
      return;
    }
    let cancelled = false;
    setHtml("");
    void renderMarkdown(tab === "manual" ? manualRaw : faqRaw)
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  useEffect(() => {
    if (!tab) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, onClose]);

  if (!tab) return null;

  return (
    <ModalShell
      onClose={onClose}
      title={t(lang, "helpMenu")}
      icon={<BookOpen size={16} />}
      size="lg"
      scrollBody={false}
      bodyClassName="px-6 py-5"
      tabs={(
        <div className="flex items-center gap-1 overflow-x-auto px-2">
          {TAB_KEYS.map(({ id, labelKey, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTabChange(id)}
                className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors ${
                  active
                    ? "bg-bg-active text-text-primary"
                    : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
                }`}
              >
                <Icon size={13} />
                {t(lang, labelKey)}
              </button>
            );
          })}
        </div>
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "shortcuts" ? (
            <div className="mx-auto w-full max-w-[560px]">
              {SHORTCUT_REFERENCE.map((group) => (
                <div key={group.titleKey} className="mb-5 last:mb-0">
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                    {t(lang, group.titleKey)}
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-border">
                    {group.items.map((item) => (
                      <div
                        key={item.keys}
                        className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs last:border-b-0"
                      >
                        <span className="text-text-secondary">{t(lang, item.labelKey)}</span>
                        <kbd className="flex-shrink-0 rounded border border-border bg-bg-primary px-1.5 py-0.5 text-[11px] text-text-primary">
                          {/* Show/Hide Window is rebindable, so its row must show the
                              accelerator the user actually saved, not the default.
                              `?? ""` is load-bearing: persisted settings fall back only as
                              a whole object (`shortcuts || DEFAULT_SHORTCUTS` in
                              settingsStore), so an older or hand-edited settings.json can
                              carry `shortcuts` without `toggleWindow`. A render-time
                              TypeError here would white-screen the window — there is no
                              root error boundary. */}
                          {item.labelKey === "shortcutToggleWindow"
                            ? (toggleWindowKeys ?? "").trim() || item.keys
                            : item.keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <p className="mt-4 text-[11px] leading-5 text-text-muted">{t(lang, "helpShortcutsNote")}</p>
            </div>
          ) : tab === "canvas" ? (
            // No in-page heading: the active tab already names this list, and a
            // second copy of the same title above it just read as a duplicate.
            <div className="mx-auto w-full max-w-[560px]">
              <ul className="overflow-hidden rounded-lg border border-border">
                {CANVAS_GUIDE_KEYS.map((key) => (
                  <li
                    key={key}
                    className="border-b border-border px-3 py-2 text-[13px] leading-6 text-text-secondary last:border-b-0"
                  >
                    {t(lang, key)}
                  </li>
                ))}
              </ul>
            </div>
          ) : html ? (
            <article
              className="markdown-preview prose mx-auto w-full max-w-[680px] text-text-primary
                [&_h1]:mb-3 [&_h1]:mt-1 [&_h1]:text-xl [&_h1]:font-bold
                [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold
                [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold
                [&_p]:my-2 [&_p]:text-[13px] [&_p]:leading-6
                [&_li]:my-1 [&_li]:text-[13px] [&_li]:leading-6
                [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5
                [&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary
                [&_code]:rounded [&_code]:bg-bg-primary [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs
                [&_hr]:my-4 [&_hr]:border-border
                [&_a]:text-accent-text [&_a]:underline
                [&_strong]:font-semibold"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-text-muted">
              {t(lang, "loading")}
            </div>
          )}
        </div>
    </ModalShell>
  );
}
