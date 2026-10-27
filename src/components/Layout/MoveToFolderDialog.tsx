import React from "react";
import { Check, Folder, FolderOpen } from "lucide-react";
import { getTreeIndent } from "@/components/Layout/noteTreeModel";
import ModalShell from "@/components/Layout/ModalShell";
import { t } from "@/utils/i18n";
import type { LangType } from "@/stores/settingsStore";

export interface MoveTarget {
  /** null targets the uncategorized bucket. */
  id: string | null;
  label: string;
  depth: number;
}

interface MoveToFolderDialogProps {
  lang: LangType;
  targets: MoveTarget[];
  currentId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}

/**
 * Folder picker for "move to folder…". A flat indented list is easier to scan
 * than a nested submenu inside a 240–320px sidebar.
 *
 * Rows are `-mx-4 px-4` on the shell's body padding so the hover fill reaches
 * the panel edges, the same trick the note tree uses inside its own card.
 */
const MoveToFolderDialog: React.FC<MoveToFolderDialogProps> = ({
  lang,
  targets,
  currentId,
  onSelect,
  onClose,
}) => (
  <ModalShell
    onClose={onClose}
    title={t(lang, "moveToFolder")}
    icon={<FolderOpen size={16} />}
    size="sm"
    footer={(
      <button
        type="button"
        onClick={onClose}
        className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        {t(lang, "confirmNo")}
      </button>
    )}
  >
    <div className="-mx-4 -my-4">
      {targets.map((target) => {
        const isCurrent = (target.id ?? null) === (currentId ?? null);
        return (
          <button
            key={target.id ?? "uncategorized"}
            type="button"
            disabled={isCurrent}
            onClick={() => onSelect(target.id)}
            className={`flex h-8 w-full items-center gap-1.5 pr-4 text-left text-[13px] transition-colors ${
              isCurrent
                ? "cursor-default bg-bg-secondary/50 font-medium text-accent-text"
                : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            }`}
            style={{ paddingLeft: getTreeIndent(target.depth) + 16 }}
          >
            <Folder size={12} className="flex-shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1 truncate">{target.label}</span>
            {isCurrent && <Check size={12} className="flex-shrink-0" />}
          </button>
        );
      })}
    </div>
  </ModalShell>
);

export default MoveToFolderDialog;
