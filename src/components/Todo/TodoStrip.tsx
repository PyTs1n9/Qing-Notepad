import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Flag, ListChecks, Plus } from "lucide-react";
import { useTodoStore } from "@/stores/todoStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { PORTAL_ACTION_EVENT, type PortalAction } from "@/utils/portalActions";
import ShellStrip from "@/components/Layout/ShellStrip";

type FilterValue = "all" | "active" | "completed";
type PriorityFilterValue = "all" | "low" | "medium" | "high";
type Priority = "low" | "medium" | "high";
type OpenMenu = "filterPriority" | "taskPriority";

/** Icon tint per priority; the flag is the only coloured affordance in the row. */
const PRIORITY_TONE: Record<Priority, string> = {
  low: "text-sky-500",
  medium: "text-amber-500",
  high: "text-danger",
};

/**
 * Top strip of the todo card. It carries everything that used to need a header
 * block *and* a separate compose row: which list is open, how far it is done,
 * what is filtered, and adding a task. Creating a list lives in the sidebar
 * header now — it is a left-hand concern, not a property of the open list.
 *
 * At 36px this only works because every part is flat — no icon tiles, no framed
 * cards. Groups that can be dropped when the card narrows carry
 * `.shell-strip__optional` (see index.css: a container query, because the card
 * width does not follow the viewport).
 */
const TodoStrip: React.FC = () => {
  const lang = useSettingsStore((s) => s.lang);
  const todos = useTodoStore((s) => s.todos);
  const lists = useTodoStore((s) => s.lists);
  const activeListId = useTodoStore((s) => s.activeListId);
  const filter = useTodoStore((s) => s.filter);
  const priorityFilter = useTodoStore((s) => s.priorityFilter);
  const setFilter = useTodoStore((s) => s.setFilter);
  const setPriorityFilter = useTodoStore((s) => s.setPriorityFilter);
  const addTodo = useTodoStore((s) => s.addTodo);

  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("low");
  /** One popover at a time; `null` means none. */
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const filterPriorityRef = useRef<HTMLDivElement>(null);
  const taskPriorityRef = useRef<HTMLDivElement>(null);

  // The title bar's "new todo" action lands here, not on a removed compose row.
  useEffect(() => {
    const handlePortalAction = (event: Event) => {
      if ((event as CustomEvent<PortalAction>).detail !== "new-todo") return;
      inputRef.current?.focus();
    };
    window.addEventListener(PORTAL_ACTION_EVENT, handlePortalAction);
    return () => window.removeEventListener(PORTAL_ACTION_EVENT, handlePortalAction);
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const anchor = openMenu === "filterPriority" ? filterPriorityRef : taskPriorityRef;
    const closeOnOutside = (event: MouseEvent) => {
      if (anchor.current?.contains(event.target as Node)) return;
      setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  const activeList = lists.find((list) => list.id === activeListId);
  // Counts and the progress bar follow the sidebar's rule: subtasks are shown
  // inside their parent row, not as their own item here.
  const topLevelTodos = todos.filter((todo) => todo.listId === activeListId && !todo.parentId);
  const completedCount = topLevelTodos.filter((todo) => todo.completed).length;
  const completionRate = topLevelTodos.length === 0
    ? 0
    : Math.round((completedCount / topLevelTodos.length) * 100);

  const submitTodo = () => {
    const value = title.trim();
    if (!value || !activeListId) return;
    addTodo(value, priority);
    setTitle("");
    setPriority("low");
    inputRef.current?.focus();
  };

  const filterOptions: { value: FilterValue; label: string }[] = [
    { value: "all", label: t(lang, "filterAll") },
    { value: "active", label: t(lang, "filterActive") },
    { value: "completed", label: t(lang, "filterCompleted") },
  ];
  const priorityFilterOptions: { value: PriorityFilterValue; label: string }[] = [
    { value: "all", label: t(lang, "filterAll") },
    { value: "low", label: t(lang, "low") },
    { value: "medium", label: t(lang, "medium") },
    { value: "high", label: t(lang, "high") },
  ];
  const newTaskPriorityOptions: { value: Priority; label: string }[] = [
    { value: "low", label: t(lang, "lowPriority") },
    { value: "medium", label: t(lang, "mediumPriority") },
    { value: "high", label: t(lang, "highPriority") },
  ];
  const selectedPriorityFilterLabel =
    priorityFilterOptions.find((option) => option.value === priorityFilter)?.label ?? t(lang, "filterAll");

  return (
    <ShellStrip
      leading={
        <>
          <ListChecks size={14} className="flex-shrink-0 text-accent-text" />
          <span className="min-w-0 max-w-[150px] truncate text-[13px] font-semibold text-text-primary">
            {activeList?.name ?? t(lang, "todoTitle")}
          </span>
        </>
      }
      trailing={
        <>
          <div className="flex h-6 flex-shrink-0 items-center overflow-hidden rounded-md border border-border">
            {filterOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setFilter(option.value)}
                aria-pressed={filter === option.value}
                className={`h-full px-2 text-[11px] font-medium transition-colors cursor-pointer ${
                  filter === option.value
                    ? "bg-accent text-on-accent"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="relative flex-shrink-0" ref={filterPriorityRef}>
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === "filterPriority" ? null : "filterPriority")}
              aria-expanded={openMenu === "filterPriority"}
              aria-haspopup="menu"
              title={`${t(lang, "priorityFilter")} · ${selectedPriorityFilterLabel}`}
              className={`flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors cursor-pointer
                hover:bg-bg-hover ${
                  priorityFilter === "all"
                    ? "border-border text-text-secondary hover:text-text-primary"
                    : "border-accent/30 bg-accent-light/60 text-accent-text"
                }`}
            >
              <Flag
                size={12}
                className={`flex-shrink-0 ${priorityFilter === "all" ? "text-text-muted" : ""}`}
              />
              <ChevronDown
                size={11}
                className={`flex-shrink-0 transition-transform ${openMenu === "filterPriority" ? "rotate-180" : ""}`}
              />
            </button>
            {openMenu === "filterPriority" && (
              <div
                role="menu"
                className="todo-popover absolute right-0 top-full z-30 mt-1 min-w-[104px] overflow-hidden rounded-lg border border-border bg-bg-primary shadow-lg"
              >
                {priorityFilterOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPriorityFilter(option.value);
                      setOpenMenu(null);
                    }}
                    className={`w-full whitespace-nowrap px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer ${
                      priorityFilter === option.value
                        ? "bg-accent-light text-accent-text"
                        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      }
    >
      <div className="shell-strip__optional flex flex-shrink-0 items-center gap-2 text-[11px] text-text-muted">
        <span className="tabular-nums">{completedCount}/{topLevelTodos.length}</span>
        <span aria-hidden="true" className="h-1 w-10 overflow-hidden rounded-full bg-bg-secondary">
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${completionRate}%` }}
          />
        </span>
        <span className="tabular-nums text-accent-text">{completionRate}%</span>
      </div>

      {/* Adding a task lives here now: the strip is the only always-visible row,
          so the field never scrolls away and the card needs no compose row. */}
      <div
        className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-border/70
          bg-bg-primary/50 pl-1.5 pr-1 transition-colors focus-within:border-accent/45"
      >
        <Plus size={12} className="flex-shrink-0 text-accent-text" />
        <input
          ref={inputRef}
          type="text"
          value={title}
          disabled={!activeListId}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitTodo();
            if (event.key === "Escape") setTitle("");
          }}
          placeholder={t(lang, "addTaskPlaceholder")}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-text-primary
            outline-none placeholder:text-text-muted disabled:cursor-not-allowed"
        />
        <div className="relative flex-shrink-0" ref={taskPriorityRef}>
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === "taskPriority" ? null : "taskPriority")}
            title={newTaskPriorityOptions.find((option) => option.value === priority)?.label}
            aria-label={t(lang, "priorityFilter")}
            aria-haspopup="menu"
            className={`flex h-5 w-5 items-center justify-center rounded transition-colors cursor-pointer
              hover:bg-bg-hover ${PRIORITY_TONE[priority]}`}
          >
            <Flag size={12} />
          </button>
          {openMenu === "taskPriority" && (
            <div
              role="menu"
              className="todo-popover absolute right-0 top-full z-30 mt-1 min-w-[104px] overflow-hidden rounded-lg border border-border bg-bg-primary shadow-lg"
            >
              {newTaskPriorityOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPriority(option.value);
                    setOpenMenu(null);
                    inputRef.current?.focus();
                  }}
                  className={`flex w-full items-center gap-1.5 whitespace-nowrap px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer ${
                    priority === option.value
                      ? "bg-accent-light text-accent-text"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  <Flag size={11} className={PRIORITY_TONE[option.value]} />
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {title.trim() && (
          <button
            type="button"
            onClick={submitTodo}
            title={t(lang, "add")}
            aria-label={t(lang, "add")}
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-accent
              text-on-accent transition-colors cursor-pointer hover:bg-accent-hover"
          >
            <Check size={11} strokeWidth={3} />
          </button>
        )}
      </div>
    </ShellStrip>
  );
};

export default TodoStrip;
