import { useEffect, useRef, useState, type FocusEvent } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, Loader2, RotateCcw } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import type { UpdatePhase } from "@/stores/updateStore";
import { t, tWithParams } from "@/utils/i18n";
import { releaseNotesUrl, type UpdateProgressPayload } from "@/utils/updateChecker";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import UpdateStatusPanel from "@/components/Help/UpdateStatusPanel";
import UpdateNotes from "@/components/Help/UpdateNotes";

interface UpdateBadgeProps {
  version: string;
  currentVersion: string;
  /** 清单里的发行说明；为空时卡片不画正文，也不留空白框。 */
  notes: string | null;
  phase: UpdatePhase;
  progress: UpdateProgressPayload | null;
  error: string;
  onDownload: () => void;
  onInstall: () => void;
  onDismiss: () => void;
}

/** 展开延迟：给指针一个"只是路过"的机会，别让划过标题栏就弹卡片。 */
const OPEN_DELAY_MS = 120;
/** 关闭宽限：指针从按钮移到卡片要穿过 4px 间隙，立刻关会闪。 */
const CLOSE_DELAY_MS = 160;

/**
 * 顶栏更新徽标（纯展示）。
 *
 * 只在有新版本时由 `UpdateEntry` 挂载，所以这里没有"无更新"分支 —— 平时它不存在，
 * 出现本身就是信号（D7）。
 *
 * 卡片放在 portal 里而不是按钮下面：标题栏是 `flex h-9`，卡片比它高得多，留在原地会
 * 被后续兄弟节点（工作台卡片）盖住。portal 用 fixed 定位，位置由按钮的
 * `getBoundingClientRect` 算出，窗口缩放时重新算。
 */
export default function UpdateBadge({
  version,
  currentVersion,
  notes,
  phase,
  progress,
  error,
  onDownload,
  onInstall,
  onDismiss,
}: UpdateBadgeProps) {
  const lang = useSettingsStore((state) => state.lang);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const busy = phase === "downloading" || phase === "installing";
  const ready = phase === "ready";

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
  };

  const show = () => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      place();
      setOpen(true);
    }, OPEN_DELAY_MS);
  };

  const hideSoon = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  // 指针可能在卡片打开时移到卡片上：两个元素都在 portal/按钮上，各自 cancel 关闭。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.blur();
    };
    const onResize = () => place();
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    if (next && cardRef.current?.contains(next)) return;
    setOpen(false);
  };

  const handlePrimaryClick = () => {
    if (busy) return;
    if (ready) onInstall();
    else onDownload();
  };

  const icon = phase === "downloading"
    ? <Loader2 size={14} strokeWidth={2} className="animate-spin text-accent-text" />
    : ready
      ? <RotateCcw size={14} strokeWidth={2} className="text-accent-text" />
      : <Download size={14} strokeWidth={2} className="text-text-muted transition-colors group-hover:text-text-primary" />;

  return (
    <div
      className="relative flex h-full items-center"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={() => {
        place();
        setOpen(true);
      }}
      onBlur={handleBlur}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={handlePrimaryClick}
        aria-label={ready ? t(lang, "updateReadyAction") : tWithParams(lang, "updateBadgeLabel", { version })}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={ready ? t(lang, "updateReadyAction") : tWithParams(lang, "updateBadgeLabel", { version })}
        className="group relative mr-1 flex h-8 w-8 items-center justify-center rounded-md border border-accent/25 bg-accent-light/40 transition-all duration-150 hover:border-accent/45 hover:bg-accent-light"
      >
        {icon}
        {!busy && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-bg-primary"
          />
        )}
      </button>

      {open && anchor && createPortal(
        <div
          ref={cardRef}
          role="dialog"
          aria-label={tWithParams(lang, "updateCardTitle", { version })}
          style={{ top: anchor.top, right: anchor.right }}
          className="fixed z-[9000] w-[360px] max-w-[calc(100vw-12px)] rounded-xl border border-border bg-bg-primary shadow-2xl"
          onMouseEnter={() => {
            window.clearTimeout(closeTimer.current);
            window.clearTimeout(openTimer.current);
          }}
          onMouseLeave={hideSoon}
        >
          <div className="flex items-start justify-between gap-3 px-3.5 pt-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">
                {tWithParams(lang, "updateCardTitle", { version })}
              </p>
              <p className="mt-0.5 text-[11px] text-text-muted">
                {t(lang, "currentVersion")} v{currentVersion}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDismiss();
              }}
              className="mt-0.5 flex-shrink-0 rounded px-1 py-0.5 text-[11px] text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-bg-hover hover:text-text-primary"
            >
              {t(lang, "ignoreVersion")}
            </button>
          </div>

          {notes && (
            <div className="relative mt-2.5">
              <div className="max-h-[300px] overflow-y-auto px-3.5 pb-1">
                <UpdateNotes notes={notes} />
              </div>
              {/* 渐隐提示「下面还有」：滚动容器一定会把下一行切一半，
                  一条与卡片同色的渐隐比硬切口更像"可以继续滚"。 */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-bg-primary to-transparent"
              />
            </div>
          )}

          <div className="mt-3 px-3.5">
            <UpdateStatusPanel
              phase={phase}
              progress={progress}
              error={error}
              onDownload={onDownload}
              onInstall={onInstall}
            />
          </div>

          <div className="mt-2.5 border-t border-border/70 px-3.5 py-2">
            <button
              type="button"
              onClick={() => void openInDefaultBrowser(releaseNotesUrl(version))}
              className="inline-flex items-center gap-1 text-[11px] text-text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-accent-text"
            >
              {t(lang, "viewFullNotes")}
              <ExternalLink size={10} />
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
