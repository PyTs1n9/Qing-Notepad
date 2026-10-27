import React from "react";
import { CheckSquare, FileText, Images, PanelLeftClose, PanelLeftOpen, Pin, Puzzle, Settings, Sparkles, Users } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ViewType } from "@/types";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAiStore } from "@/stores/aiStore";
import { countUpdates, usePluginStore } from "@/plugin/store";
import { t } from "@/utils/i18n";

interface ActivityBarProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  onOpenSettings: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/** The narrow, always-visible navigation rail inspired by VS Code's activity bar. */
const ActivityBar: React.FC<ActivityBarProps> = ({
  currentView,
  onViewChange,
  onOpenSettings,
  collapsed,
  onToggleCollapse,
}) => {
  const lang = useSettingsStore((s) => s.lang);
  const alwaysOnTop = useSettingsStore((s) => s.alwaysOnTop);
  const setAlwaysOnTop = useSettingsStore((s) => s.setAlwaysOnTop);
  const aiSidebarOpen = useAiStore((s) => s.sidebarOpen);
  const setAiSidebarOpen = useAiStore((s) => s.setSidebarOpen);
  const updateCount = usePluginStore((s) => countUpdates(s.installed, s.index));
  // `motion` already ships with the app; this only asks it to stop animating,
  // it does not swap the indicator for a static one - the capsule must still be
  // painted on the first frame.
  const reduceMotion = useReducedMotion();

  const items: Array<{ view?: ViewType; label: string; icon: React.ReactNode; disabled?: boolean; badge?: number }> = [
    { view: "note", label: t(lang, "notepad"), icon: <FileText size={22} strokeWidth={1.7} /> },
    { view: "todo", label: t(lang, "todo"), icon: <CheckSquare size={22} strokeWidth={1.7} /> },
    { view: "workspace", label: t(lang, "workspace"), icon: <Users size={22} strokeWidth={1.7} /> },
    { view: "canvas", label: t(lang, "canvas"), icon: <Images size={22} strokeWidth={1.7} /> },
    // Fifth page, not a bottom toggle: the plugin page is a destination like the
    // other four, and it has to join the sliding capsule (one `layoutId`, never
    // a second element — see the AI and pin buttons below).
    {
      view: "plugins",
      label: t(lang, "pluginsTitle"),
      icon: <Puzzle size={22} strokeWidth={1.7} />,
      badge: updateCount,
    },
  ];

  // One element shared through `layoutId`: it travels between items instead of
  // blinking out at the old one and in at the new one. Only the current page has
  // it, which is also why the old 2px rail could go - a block *and* a rail was
  // the same fact stated twice.
  const indicator = (layoutId: string) => (
    <motion.span
      layoutId={layoutId}
      className="activity-capsule absolute inset-0 rounded-lg"
      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
    />
  );

  return (
    // No divider and no background of its own: the rail and the explorer beside
    // it are one card, distinguished by hover and selection only. The card's
    // `overflow: hidden` rounds the corners of the first and last buttons.
    <aside className="flex h-full w-12 flex-shrink-0 flex-col items-center text-text-primary transition-colors">
      <nav className="flex w-full flex-col items-center gap-1" aria-label="Activity bar">
        {items.map(({ view, label, icon, disabled, badge }) => {
          const active = !disabled && currentView === view;
          return (
            <button
              key={label}
              type="button"
              onClick={() => {
                if (!disabled && view) onViewChange(view);
              }}
              disabled={disabled}
              title={label}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              // Same height as the four buttons below: at h-11 the icon baseline
              // of the two groups sat 1px apart, which read as a misalignment.
              className={`relative flex h-10 w-11 items-center justify-center rounded-lg transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-default disabled:opacity-60 ${
                active ? "text-text-primary" : "text-text-muted"
              }`}
            >
              {active && indicator("activity-indicator")}
              <span className="relative inline-flex">{icon}</span>
              {typeof badge === "number" && badge > 0 && (
                // Counts above nine stop being information and start being a
                // badge-shaped smudge at 44px wide.
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-on-accent"
                >
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex w-full flex-col items-center gap-1 pb-2">
        <button
          type="button"
          onClick={() => setAiSidebarOpen(!aiSidebarOpen)}
          title={t(lang, "aiAssistant")}
          aria-label={t(lang, "aiAssistant")}
          aria-pressed={aiSidebarOpen}
          className={`relative flex h-10 w-11 items-center justify-center rounded-lg transition-colors hover:bg-bg-hover hover:text-text-primary ${
            aiSidebarOpen ? "text-accent-text" : "text-text-muted"
          }`}
        >
          {/* A toggle is not a page: it gets the same capsule but never joins the
              sliding indicator, otherwise the two would fight over one element. */}
          {aiSidebarOpen && <span className="activity-capsule absolute inset-0 rounded-lg" />}
          <Sparkles size={20} strokeWidth={1.7} className="relative" />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={collapsed ? t(lang, "expandSidebar") : t(lang, "collapseSidebar")}
          aria-label={collapsed ? t(lang, "expandSidebar") : t(lang, "collapseSidebar")}
          className="flex h-10 w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          {collapsed ? <PanelLeftOpen size={20} strokeWidth={1.7} /> : <PanelLeftClose size={20} strokeWidth={1.7} />}
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          title={t(lang, "settings")}
          aria-label={t(lang, "settings")}
          className="flex h-10 w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <Settings size={20} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          onClick={() => setAlwaysOnTop(!alwaysOnTop)}
          title={t(lang, alwaysOnTop ? "disableAlwaysOnTop" : "enableAlwaysOnTop")}
          aria-label={t(lang, alwaysOnTop ? "disableAlwaysOnTop" : "enableAlwaysOnTop")}
          aria-pressed={alwaysOnTop}
          className={`relative flex h-10 w-11 items-center justify-center rounded-lg transition-colors hover:bg-bg-hover hover:text-text-primary ${
            alwaysOnTop ? "text-accent-text" : "text-text-muted"
          }`}
        >
          {alwaysOnTop && <span className="activity-capsule absolute inset-0 rounded-lg" />}
          <Pin size={20} strokeWidth={1.7} className="relative" />
        </button>
      </div>
    </aside>
  );
};

export default ActivityBar;
