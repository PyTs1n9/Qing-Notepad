import { useState } from "react";
import {
  BookOpen,
  Bug,
  CircleHelp,
  Info,
  Keyboard,
  Megaphone,
  MousePointer2,
  RefreshCw,
  Settings,
} from "lucide-react";
import DropdownMenu, { type DropdownEntry } from "@/components/Layout/DropdownMenu";
import HelpCenterModal, { type HelpTab } from "@/components/Help/HelpCenterModal";
import UpdateCheckModal from "@/components/Help/UpdateCheckModal";
import ChangelogModal from "@/components/Help/ChangelogModal";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { openInDefaultBrowser } from "@/utils/externalLinks";
import { GITHUB_URL } from "@/utils/updateChecker";

interface HelpMenuProps {
  onOpenSettings: () => void;
  onOpenAbout: () => void;
}

const ISSUES_URL = `${GITHUB_URL}/issues`;

/**
 * The single dropdown left in the title bar.
 *
 * Everything global that is not a view or a document action lives here: help
 * content that already ships with the app, update checking as a first-class
 * entry, the issue tracker, and the About dialog. Quitting deliberately does
 * not live here — it moved to the profile popover, where session-level actions
 * belong.
 */
export default function HelpMenu({ onOpenSettings, onOpenAbout }: HelpMenuProps) {
  const lang = useSettingsStore((state) => state.lang);
  const [tab, setTab] = useState<HelpTab | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);

  const entries: DropdownEntry[] = [
    {
      id: "manual",
      label: t(lang, "helpManual"),
      icon: BookOpen,
      onSelect: () => setTab("manual"),
    },
    {
      id: "faq",
      label: t(lang, "helpFaq"),
      icon: CircleHelp,
      onSelect: () => setTab("faq"),
    },
    {
      id: "shortcuts",
      label: t(lang, "helpShortcuts"),
      icon: Keyboard,
      onSelect: () => setTab("shortcuts"),
    },
    {
      // The canvas guide used to be one glance away inside 传送门; a direct entry
      // keeps it one click away instead of two tabs deep in the help centre.
      id: "canvas-guide",
      label: t(lang, "canvasGuideTitle"),
      icon: MousePointer2,
      onSelect: () => setTab("canvas"),
    },
    { separator: true },
    {
      id: "check-update",
      label: t(lang, "checkUpdate"),
      icon: RefreshCw,
      onSelect: () => setUpdateOpen(true),
    },
    {
      // Sits next to "check for updates" because it answers the same question
      // ("what changed?"), and it is the only announcement surface a user who
      // never signs in will ever reach.
      id: "changelog",
      label: t(lang, "helpChangelog"),
      icon: Megaphone,
      onSelect: () => setChangelogOpen(true),
    },
    {
      id: "report-issue",
      label: t(lang, "helpReportIssue"),
      icon: Bug,
      onSelect: () => void openInDefaultBrowser(ISSUES_URL),
    },
    { separator: true },
    {
      id: "settings",
      label: t(lang, "settings"),
      icon: Settings,
      onSelect: onOpenSettings,
    },
    {
      id: "about",
      label: t(lang, "about"),
      icon: Info,
      onSelect: onOpenAbout,
    },
  ];

  return (
    <>
      <DropdownMenu
        label={t(lang, "helpMenu")}
        icon={CircleHelp}
        entries={entries}
        align="start"
        triggerClassName="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
      />
      <HelpCenterModal
        tab={tab}
        onTabChange={setTab}
        onClose={() => setTab(null)}
      />
      <UpdateCheckModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
      <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
    </>
  );
}
