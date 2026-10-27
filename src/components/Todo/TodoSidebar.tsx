import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  GripVertical,
  ListChecks,
  ListPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useTodoStore } from "@/stores/todoStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import { dispatchPortalAction } from "@/utils/portalActions";
import { requestTodoIntent } from "@/utils/todoIntent";
import TreeContextMenu, { type TreeMenuItem } from "@/components/Layout/TreeContextMenu";
import ModalShell from "@/components/Layout/ModalShell";
import type { Todo, TodoList } from "@/types";

/** One menu at a time; a task entry carries the list it belongs to as well. */
interface SidebarMenuState {
  x: number;
  y: number;
  list: TodoList;
  todo: Todo | null;
}

const TodoSidebar: React.FC = () => {
  const {
    todos,
    lists,
    activeListId,
    addList,
    renameList,
    deleteList,
    toggleListPinned,
    reorderLists,
    setActiveList,
    toggleTodo,
    togglePinned,
  } = useTodoStore();
  const lang = useSettingsStore((state) => state.lang);
  const [creating, setCreating] = useState(false);
  const [newListName, setNewListName] = useState("");
  /** Lists whose tasks are peeked at inline. Session-only: it is a reading aid,
   *  not part of the saved data. */
  const [expandedListIds, setExpandedListIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteConfirmList, setDeleteConfirmList] = useState<TodoList | null>(null);
  const [menu, setMenu] = useState<SidebarMenuState | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after" | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const createAnchorRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const dragCloneRef = useRef<HTMLElement | null>(null);
  const dragTargetRef = useRef<string | null>(null);
  const dragPositionRef = useRef<"before" | "after">("before");
  const cancelRenameRef = useRef(false);

  const orderedLists = useMemo(
    () => [...lists].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.order - b.order;
    }),
    [lists],
  );
  // 侧边栏计数与列表进度只统计父待办，子待办在展开区内单独体现
  const topLevelTodos = todos.filter((todo) => !todo.parentId);
  const completedCount = topLevelTodos.filter((todo) => todo.completed).length;
  const pendingCount = topLevelTodos.length - completedCount;

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const closeCreate = () => {
    setCreating(false);
    setNewListName("");
  };

  const confirmCreate = () => {
    const name = newListName.trim();
    if (!name) return;
    addList(name);
    closeCreate();
    // A brand-new list is empty, so the next thing wanted is its first task.
    // The compose field lives in the strip and focuses itself on this action.
    dispatchPortalAction("new-todo");
  };

  // The panel lives inside the card (no portal), so it has to close on an
  // outside click of its own anchor — nothing else dismisses it.
  useEffect(() => {
    if (!creating) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (createAnchorRef.current?.contains(event.target as Node)) return;
      closeCreate();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCreate();
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [creating]);

  const startRename = (list: TodoList) => {
    cancelRenameRef.current = false;
    setEditingId(list.id);
    setEditingName(list.name);
  };

  const confirmRename = () => {
    const name = editingName.trim();
    if (!cancelRenameRef.current && editingId && name) renameList(editingId, name);
    cancelRenameRef.current = false;
    setEditingId(null);
    setEditingName("");
  };

  const resetDrag = () => {
    dragCloneRef.current?.remove();
    dragCloneRef.current = null;
    dragTargetRef.current = null;
    dragPositionRef.current = "before";
    setDragOverId(null);
    setDragOverPosition(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  const startDrag = (event: React.MouseEvent, list: TodoList) => {
    if (event.button !== 0 || list.pinned) return;
    event.preventDefault();
    event.stopPropagation();
    const row = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-todo-list-id]");
    if (!row) return;

    const rect = row.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const clone = row.cloneNode(true) as HTMLElement;
    clone.style.position = "fixed";
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.zIndex = "9999";
    clone.style.pointerEvents = "none";
    clone.style.opacity = "0.88";
    clone.style.boxShadow = "0 8px 24px rgba(0,0,0,0.16)";
    document.body.appendChild(clone);
    dragCloneRef.current = clone;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";

    const onMove = (moveEvent: MouseEvent) => {
      clone.style.top = `${moveEvent.clientY - offsetY}px`;
      const viewport = listContainerRef.current?.getBoundingClientRect();
      if (viewport && (moveEvent.clientX < viewport.left || moveEvent.clientX > viewport.right)) {
        dragTargetRef.current = null;
        setDragOverId(null);
        setDragOverPosition(null);
        return;
      }
      const candidates = Array.from(
        listContainerRef.current?.querySelectorAll<HTMLElement>("[data-todo-list-id]") ?? [],
      ).filter((element) =>
        element.dataset.todoListId !== list.id &&
        element.dataset.listPinned === String(list.pinned)
      );
      let target = candidates.find((element) => {
        const targetRect = element.getBoundingClientRect();
        return moveEvent.clientY >= targetRect.top && moveEvent.clientY <= targetRect.bottom;
      });
      let position: "before" | "after" = "before";
      if (target) {
        const targetRect = target.getBoundingClientRect();
        position = moveEvent.clientY >= targetRect.top + targetRect.height / 2 ? "after" : "before";
      } else {
        target = candidates.find((element) => {
          const targetRect = element.getBoundingClientRect();
          return moveEvent.clientY < targetRect.top + targetRect.height / 2;
        });
        if (!target && candidates.length > 0) {
          target = candidates[candidates.length - 1];
          position = "after";
        }
      }
      const targetId = target?.dataset.todoListId ?? null;
      dragTargetRef.current = targetId;
      dragPositionRef.current = position;
      setDragOverId(targetId);
      setDragOverPosition(targetId ? position : null);
    };

    const onUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const viewport = listContainerRef.current?.getBoundingClientRect();
      const insideViewport = !viewport || (upEvent.clientX >= viewport.left && upEvent.clientX <= viewport.right);
      if (insideViewport && dragTargetRef.current) {
        reorderLists(list.id, dragTargetRef.current, dragPositionRef.current);
      }
      resetDrag();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const toggleListExpanded = (listId: string) => {
    setExpandedListIds((current) =>
      current.includes(listId) ? current.filter((id) => id !== listId) : [...current, listId],
    );
  };

  const confirmDelete = () => {
    if (!deleteConfirmList) return;
    deleteList(deleteConfirmList.id, t(lang, "defaultTodoList"));
    setDeleteConfirmList(null);
  };

  /** Right-click never selects: the browser fires no click for it, and the menu
   *  keeps its own list/task instead of touching `activeListId`. */
  const openContextMenu = (event: React.MouseEvent, list: TodoList, todo: Todo | null) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, list, todo });
  };

  const buildMenuItems = ({ list, todo }: SidebarMenuState): TreeMenuItem[] => {
    if (todo) {
      const hasDescription = typeof todo.description === "string" && todo.description.trim().length > 0;
      return [
        {
          key: "description",
          label: t(lang, hasDescription ? "editTodoDescription" : "addTodoDescription"),
          icon: <AlignLeft size={12} />,
          // The editor lives on the main card, so the list has to be the open
          // one before the intent can land on a rendered row.
          onSelect: () => {
            setActiveList(list.id);
            requestTodoIntent({ kind: "edit-description", todoId: todo.id });
          },
        },
        {
          key: "subtask",
          label: t(lang, "addSubtask"),
          icon: <ListPlus size={12} />,
          onSelect: () => {
            setActiveList(list.id);
            requestTodoIntent({ kind: "add-subtask", todoId: todo.id });
          },
        },
        {
          key: "pin",
          label: t(lang, todo.pinned ? "unpinTodo" : "pinTodo"),
          icon: todo.pinned ? <PinOff size={12} /> : <Pin size={12} />,
          onSelect: () => togglePinned(todo.id),
        },
        {
          key: "delete",
          label: t(lang, "deleteTodo"),
          icon: <Trash2 size={12} />,
          danger: true,
          separatorBefore: true,
          // Pinned rows refuse deletion in the store, so the entry says so
          // instead of failing silently.
          disabled: Boolean(todo.pinned),
          onSelect: () => {
            setActiveList(list.id);
            requestTodoIntent({ kind: "delete-todo", todoId: todo.id });
          },
        },
      ];
    }

    const taskCount = todos.filter((item) => item.listId === list.id && !item.parentId).length;
    const isExpanded = expandedListIds.includes(list.id);
    return [
      {
        key: "rename",
        label: t(lang, "renameTodoList"),
        icon: <Pencil size={12} />,
        onSelect: () => startRename(list),
      },
      {
        key: "pin",
        label: t(lang, list.pinned ? "unpinTodoList" : "pinTodoList"),
        icon: list.pinned ? <PinOff size={12} /> : <Pin size={12} />,
        onSelect: () => toggleListPinned(list.id),
      },
      {
        key: "expand",
        label: t(lang, isExpanded ? "collapseList" : "expandList"),
        icon: (
          <ChevronRight size={12} className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
        ),
        disabled: taskCount === 0,
        onSelect: () => toggleListExpanded(list.id),
      },
      {
        key: "new-task",
        label: t(lang, "newTaskInList"),
        icon: <ListPlus size={12} />,
        onSelect: () => {
          // The compose field belongs to the strip, and it focuses itself when
          // this action arrives — no second focus path to keep in sync.
          setActiveList(list.id);
          dispatchPortalAction("new-todo");
        },
      },
      {
        key: "delete",
        label: t(lang, "deleteTodoList"),
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        onSelect: () => setDeleteConfirmList(list),
      },
    ];
  };

  return (
    <aside className="todo-surface flex h-full w-full flex-col">
      {/* Same 36px bar as the explorer header and the note tab strip: the two
          counters that used to live in a hero block are folded in here so this
          border sits on one continuous line across the shell. */}
      <div className="relative flex h-9 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <h2 className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {t(lang, "todoLists")}
        </h2>
        <div ref={createAnchorRef} className="flex flex-shrink-0 items-center gap-1.5">
          <span
            className="flex items-center gap-1 text-[11px] font-semibold leading-none tabular-nums"
            title={`${t(lang, "filterActive")} ${pendingCount} · ${t(lang, "filterCompleted")} ${completedCount}`}
          >
            <span className="text-accent-text">{pendingCount}</span>
            <span className="text-text-muted/40">/</span>
            <span className="text-text-muted">{completedCount}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              if (creating) {
                closeCreate();
                return;
              }
              setNewListName("");
              setCreating(true);
            }}
            aria-expanded={creating}
            aria-haspopup="dialog"
            aria-label={t(lang, "newTodoList")}
            title={t(lang, "newTodoList")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted
              transition-colors hover:bg-bg-hover hover:text-accent-text"
          >
            <Plus size={14} />
          </button>
          {creating && (
            // 196px keeps the panel inside the card at the narrowest sidebar
            // width; the card clips its children, so a wider panel would be cut.
            <div
              role="dialog"
              aria-label={t(lang, "newTodoList")}
              className="todo-popover absolute right-2 top-full z-40 mt-1 w-[196px] max-w-[calc(100%-1rem)]
                rounded-lg border border-border bg-bg-primary p-2 shadow-lg"
            >
              <div className="mb-1.5 flex items-center justify-between gap-1 px-0.5">
                <span className="truncate text-[11px] font-semibold text-text-primary">
                  {t(lang, "newTodoList")}
                </span>
                <button
                  type="button"
                  onClick={closeCreate}
                  aria-label={t(lang, "confirmNo")}
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-muted
                    hover:bg-bg-hover hover:text-text-primary"
                >
                  <X size={11} />
                </button>
              </div>
              <input
                ref={createInputRef}
                value={newListName}
                onChange={(event) => setNewListName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") confirmCreate();
                  if (event.key === "Escape") closeCreate();
                }}
                placeholder={t(lang, "listNamePlaceholder")}
                className="h-8 w-full rounded-md border border-border bg-bg-secondary px-2 text-xs
                  text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
              />
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={closeCreate}
                  className="h-7 rounded-md px-2 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  {t(lang, "confirmNo")}
                </button>
                <button
                  type="button"
                  onClick={confirmCreate}
                  disabled={!newListName.trim()}
                  className="flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium
                    text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Plus size={11} strokeWidth={2.5} />
                  {t(lang, "add")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div ref={listContainerRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {orderedLists.map((list) => {
          const listTodos = todos.filter((todo) => todo.listId === list.id && !todo.parentId);
          const listPending = listTodos.filter((todo) => !todo.completed).length;
          const isActive = activeListId === list.id;
          const isEditing = editingId === list.id;
          const isListExpanded = expandedListIds.includes(list.id);
          return (
            <div
              key={list.id}
              data-todo-list-id={list.id}
              data-list-pinned={String(list.pinned)}
              className={`group relative mb-0.5 rounded-lg transition-all duration-200 ${
                dragOverId === list.id ? "scale-[1.015] bg-accent-light/40" : ""
              }`}
            >
              {dragOverId === list.id && dragOverPosition && (
                <span
                  aria-hidden="true"
                  className={`drag-insertion-line drag-insertion-line--${dragOverPosition}`}
                />
              )}
              {isEditing ? (
                <div className="todo-create-panel flex h-8 items-center gap-1.5 rounded-lg border border-accent/40 bg-bg-primary px-2 ring-2 ring-accent/15">
                  {list.pinned
                    ? <Pin size={13} className="flex-shrink-0 text-accent-text" />
                    : <GripVertical size={13} className="flex-shrink-0 text-text-muted" />}
                  <input
                    ref={editInputRef}
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onBlur={confirmRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        cancelRenameRef.current = true;
                        event.currentTarget.blur();
                      }
                    }}
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none"
                  />
                </div>
              ) : (
                <>
                  {/* The disclosure sits outside the row button: it has to be a
                      sibling, since a button cannot nest inside a button. It is
                      pinned to the row's own 32px band — anchoring it to the
                      wrapper would put 50% in the middle of the expanded area. */}
                  {listTodos.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleListExpanded(list.id)}
                      aria-expanded={isListExpanded}
                      aria-label={isListExpanded ? t(lang, "collapseList") : t(lang, "expandList")}
                      title={isListExpanded ? t(lang, "collapseList") : t(lang, "expandList")}
                      className="absolute left-0.5 top-0 z-10 flex h-8 w-6 items-center justify-center
                        rounded text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <ChevronRight
                        size={12}
                        className={`transition-transform duration-150 ${isListExpanded ? "rotate-90" : ""}`}
                      />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      // First click selects, second click on the row that is
                      // already open peeks inside it — the disclosure arrow
                      // stays, but the common case needs no 6px target.
                      if (isActive && listTodos.length > 0) {
                        toggleListExpanded(list.id);
                        return;
                      }
                      setActiveList(list.id);
                    }}
                    onContextMenu={(event) => openContextMenu(event, list, null)}
                    data-todo-row-button
                    title={list.name}
                    className={`relative flex h-8 w-full items-center gap-1.5 overflow-hidden rounded-lg pl-6 pr-12 text-left ${
                      isActive
                        ? "flat-active-row text-[13px] font-medium text-text-primary"
                        : "text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    }`}
                  >
                    {isActive && <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-r-full bg-accent" />}
                    {!list.pinned && (
                      <span
                        onMouseDown={(event) => startDrag(event, list)}
                        onClick={(event) => event.stopPropagation()}
                        title={t(lang, "dragTodoList")}
                        className="flex-shrink-0 cursor-grab text-text-muted opacity-35 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
                      >
                        <GripVertical size={12} />
                      </span>
                    )}
                    {list.pinned
                      ? <Pin size={13} className="flex-shrink-0 text-accent-text" />
                      : <ListChecks size={13} className={`flex-shrink-0 ${isActive ? "text-accent-text" : "text-text-muted"}`} />}
                    <span className="min-w-0 flex-1 truncate">{list.name}</span>
                    <span
                      className={`absolute right-2 inline-flex h-[17px] min-w-[34px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none tabular-nums tracking-tight ${
                        isActive
                          ? "bg-accent text-on-accent"
                          : "text-text-muted"
                      }`}
                    >
                      {listPending}/{listTodos.length}
                    </span>
                  </button>

                  {/* Peek inside the list without leaving the sidebar. Tasks keep
                      the main view's round toggle, subtasks the square one, so the
                      two levels read the same here as they do in the card. */}
                  {isListExpanded && (
                    <div className="todo-subtask-list mb-1 ml-[26px] border-l border-border/60 pl-2">
                      {listTodos.length === 0 ? (
                        <p className="px-1.5 py-1.5 text-[11px] text-text-muted">{t(lang, "noTodos")}</p>
                      ) : (
                        listTodos.map((todo) => {
                          const subtasks = todos.filter((item) => item.parentId === todo.id);
                          const doneSubtasks = subtasks.filter((item) => item.completed).length;
                          return (
                            <div key={todo.id}>
                              <div
                                onContextMenu={(event) => openContextMenu(event, list, todo)}
                                className="flex h-7 items-center gap-1.5 rounded-md pr-1.5 hover:bg-bg-hover/70"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleTodo(todo.id)}
                                  aria-label={todo.title}
                                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full hover:bg-accent-light"
                                >
                                  {todo.completed ? (
                                    <CheckCircle2 size={13} className="text-success" />
                                  ) : (
                                    <Circle size={13} className="text-text-muted hover:text-accent-text" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setActiveList(list.id)}
                                  title={todo.title}
                                  className={`min-w-0 flex-1 truncate text-left text-xs transition-colors ${
                                    todo.completed ? "text-text-muted line-through" : "text-text-secondary"
                                  }`}
                                >
                                  {todo.title}
                                </button>
                                {/* A dot, not an icon component: this is the one
                                    node that depends on the description field, so
                                    it stays a plain element. */}
                                {typeof todo.description === "string" && todo.description.trim().length > 0 && (
                                  <span
                                    aria-hidden="true"
                                    title={t(lang, "todoDescription")}
                                    className="h-1 w-1 flex-shrink-0 rounded-full bg-accent/60"
                                  />
                                )}
                                {subtasks.length > 0 && (
                                  <span className="flex-shrink-0 text-[10px] tabular-nums text-text-muted">
                                    {doneSubtasks}/{subtasks.length}
                                  </span>
                                )}
                              </div>
                              {subtasks.map((subtask) => (
                                <div
                                  key={subtask.id}
                                  className="ml-4 flex h-6 items-center gap-1.5 rounded-md pr-1.5 hover:bg-bg-hover/60"
                                >
                                  <button
                                    type="button"
                                    onClick={() => toggleTodo(subtask.id)}
                                    aria-label={subtask.title}
                                    className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded hover:bg-accent-light"
                                  >
                                    <span
                                      className={`flex h-2.5 w-2.5 items-center justify-center rounded-[2px] border ${
                                        subtask.completed
                                          ? "border-success bg-success text-on-success"
                                          : "border-text-muted/60"
                                      }`}
                                    >
                                      {subtask.completed && <Check size={7} strokeWidth={4} />}
                                    </span>
                                  </button>
                                  <span
                                    className={`min-w-0 flex-1 truncate text-[11px] ${
                                      subtask.completed ? "text-text-muted line-through" : "text-text-muted"
                                    }`}
                                  >
                                    {subtask.title}
                                  </span>
                                </div>
                              ))}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}

      {deleteConfirmList && (
        <ModalShell
          onClose={() => setDeleteConfirmList(null)}
          title={t(lang, "deleteTodoList")}
          description={deleteConfirmList.name}
          icon={<Trash2 size={16} />}
          tone="danger"
          size="sm"
          footer={(
            <>
              <button
                type="button"
                onClick={() => setDeleteConfirmList(null)}
                className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {t(lang, "confirmNo")}
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="h-8 rounded-lg bg-danger px-3 text-xs text-on-danger transition-colors hover:bg-danger/90"
              >
                {t(lang, "confirmYes")}
              </button>
            </>
          )}
        >
          <p className="text-sm leading-relaxed text-text-secondary">
            {t(lang, "confirmDeleteTodoListMessage")
              .replace("{list}", deleteConfirmList.name)
              .replace("{count}", String(todos.filter((todo) => todo.listId === deleteConfirmList.id).length))}
          </p>
        </ModalShell>
      )}
    </aside>
  );
};

export default TodoSidebar;
