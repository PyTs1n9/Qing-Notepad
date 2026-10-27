import React, { useCallback, useEffect, useRef } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";

interface TodoDescriptionCardProps {
  description?: string;
  completed?: boolean;
  /** Controlled by the row's button: true renders the editor instead of the card. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Called with the trimmed text; an empty string means "clear it". */
  onSave: (value: string) => void;
}

/**
 * The body of a task.
 *
 * It reads as the task's own text, not as a card appended to it: no border, no
 * "DESCRIPTION" micro-label, no pencil badge - just a muted paragraph behind a
 * hairline rail, hanging off the task the way the subtask list does. The old
 * framed version announced itself as a separate object, which is exactly what
 * made a two-line note look like a machine-written appendix.
 *
 * Two states only: being written (a bare textarea on the same rail) and written
 * (the paragraph, click to edit). There is deliberately no "empty" state - an
 * always-visible "add a description" line under every row turned a long list
 * into a wall of the same four words, so the entry lives in the row actions.
 */
const TodoDescriptionCard: React.FC<TodoDescriptionCardProps> = ({
  description,
  completed = false,
  editing,
  onEditingChange,
  onSave,
}) => {
  const lang = useSettingsStore((s) => s.lang);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(description ?? "");
  /** Set before the textarea unmounts so a blur cannot save twice. */
  const settledRef = useRef(false);

  const saved = (description ?? "").trim();
  const hasDescription = saved.length > 0;

  const autoGrow = useCallback((element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, []);

  // Entering edit mode always starts from the saved text, never from whatever
  // was typed and abandoned last time.
  useEffect(() => {
    if (!editing) return;
    const element = textareaRef.current;
    if (!element) return;
    draftRef.current = description ?? "";
    element.value = description ?? "";
    settledRef.current = false;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    autoGrow(element);
  }, [editing, description, autoGrow]);

  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = draftRef.current.trim();
    onEditingChange(false);
    if (next !== saved) onSave(next);
  };

  const cancel = () => {
    settledRef.current = true;
    draftRef.current = description ?? "";
    onEditingChange(false);
  };

  if (editing) {
    return (
      <div className="border-l-2 border-accent/45 pl-3">
        <textarea
          ref={textareaRef}
          defaultValue={description ?? ""}
          rows={2}
          placeholder={t(lang, "todoDescriptionPlaceholder")}
          onChange={(event) => {
            draftRef.current = event.target.value;
            autoGrow(event.currentTarget);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-text-primary
            outline-none placeholder:text-text-muted"
        />
        <div className="mt-1 flex items-center justify-end gap-1">
          {/* preventDefault keeps focus in the textarea so the blur handler
              does not fire on the click itself — each button decides. */}
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              cancel();
            }}
            className="flex h-6 items-center rounded-md px-2 text-[11px] text-text-muted
              transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            {t(lang, "confirmNo")}
          </button>
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              commit();
            }}
            className="flex h-6 items-center rounded-md px-2 text-[11px] text-accent-text
              transition-colors hover:bg-accent-light"
          >
            {t(lang, "save")}
          </button>
        </div>
      </div>
    );
  }

  if (!hasDescription) return null;

  return (
    <button
      type="button"
      onClick={() => onEditingChange(true)}
      title={t(lang, "editTodoDescription")}
      className="group/desc block w-full cursor-text border-l-2 border-border/45 pl-3 text-left
        transition-colors hover:border-accent/45"
    >
      <span
        className={`block whitespace-pre-wrap break-words text-[13px] leading-relaxed transition-colors
          ${completed ? "text-text-muted" : "text-text-secondary"}
          group-hover/desc:text-text-primary`}
      >
        {description}
      </span>
    </button>
  );
};

export default TodoDescriptionCard;
