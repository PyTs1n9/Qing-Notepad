import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { AlignLeft, Trash2, Circle, Check, CheckCircle2, Flag, GripVertical, CalendarDays, X, ChevronLeft, ChevronRight, Pin, PinOff, ListPlus } from "lucide-react";
import { useTodoStore } from "@/stores/todoStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import { subscribeTodoIntent, type TodoIntent } from "@/utils/todoIntent";
import TodoStrip from "@/components/Todo/TodoStrip";
import TodoDescriptionCard from "@/components/Todo/TodoDescriptionCard";
import EmptyState from "@/components/Layout/EmptyState";
import ModalShell from "@/components/Layout/ModalShell";
import { dispatchPortalAction } from "@/utils/portalActions";
import type { Todo } from "@/types";

type Priority = "low" | "medium" | "high";
type CalendarView = "day" | "month" | "year";
type CalendarMotion = "next" | "prev" | "zoomIn" | "zoomOut";

/** Priority is one flag, tinted by token. A text pill ("low/medium/high") used to
 *  sit here and cost ~44px of every row's trailing space for a fact the colour
 *  already carries; token tints also survive the dark theme, which the old
 *  `bg-blue-100` blocks did not. */
const priorityTone: Record<Priority, string> = {
  low: "text-text-muted",
  medium: "text-warning",
  high: "text-danger",
};

const priorityCycle: Record<Priority, Priority> = {
  low: "medium",
  medium: "high",
  high: "low",
};

const formatDateInputValue = (value: string, lang: "zh" | "en") => {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;

  const date = new Date(year, month - 1, day);
  const isCurrentYear = year === new Date().getFullYear();

  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    ...(isCurrentYear ? {} : { year: "numeric" }),
  }).format(date);
};

const getTodayInputValue = () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const toDateInputValue = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseDateInputValue = (value?: string) => {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
};

const getMonthStart = (value?: string) => {
  const selectedDate = parseDateInputValue(value) ?? new Date();
  return new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
};

const addMonths = (date: Date, offset: number) =>
  new Date(date.getFullYear(), date.getMonth() + offset, 1);

const getCalendarDays = (monthDate: Date) => {
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const startDate = new Date(firstDay);
  startDate.setDate(firstDay.getDate() - mondayOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + index);
    return {
      date,
      value: toDateInputValue(date),
      isCurrentMonth: date.getMonth() === monthDate.getMonth(),
    };
  });
};

const getYearRange = (date: Date) => {
  const startYear = Math.floor(date.getFullYear() / 12) * 12;
  return Array.from({ length: 12 }, (_, index) => startYear + index);
};

const TodoView: React.FC = () => {
  // Filters are owned by TodoStrip now; this view only reads them.
  const { todos, activeListId, filter, priorityFilter, addSubtask, toggleExpanded, toggleTodo, deleteTodo, updateTodo, togglePinned, reorderTodos } = useTodoStore();
  const lang = useSettingsStore((s) => s.lang);
  const listTodos = todos.filter((todo) => todo.listId === activeListId);
  const topLevelTodos = listTodos.filter((todo) => !todo.parentId);
  const subtasksByParent = new Map<string, Todo[]>();
  listTodos.forEach((todo) => {
    if (!todo.parentId) return;
    const siblings = subtasksByParent.get(todo.parentId);
    if (siblings) siblings.push(todo);
    else subtasksByParent.set(todo.parentId, [todo]);
  });
  const [deleteConfirmTodo, setDeleteConfirmTodo] = useState<Todo | null>(null);
  /** Task whose description is open in the editor; one at a time. */
  const [descriptionEditorId, setDescriptionEditorId] = useState<string | null>(null);
  /** Requests raised in the sidebar; consumed below, never handled on arrival. */
  const [todoIntent, setTodoIntent] = useState<TodoIntent | null>(null);

  useEffect(() => subscribeTodoIntent(setTodoIntent), []);

  // 内联编辑标题状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [openCalendarTodoId, setOpenCalendarTodoId] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => getMonthStart());
  const [calendarView, setCalendarView] = useState<CalendarView>("day");
  const [calendarMotion, setCalendarMotion] = useState<CalendarMotion>("zoomIn");
  const [calendarPosition, setCalendarPosition] = useState({ top: 0, left: 0 });
  const calendarRef = useRef<HTMLDivElement>(null);
  const calendarAnchorRef = useRef<HTMLElement | null>(null);

  // 拖拽排序状态
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after" | null>(null);
  const dragNodeRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragTodoIdRef = useRef<string | null>(null);
  const dragOverTodoIdRef = useRef<string | null>(null);
  const dragOverPositionRef = useRef<"before" | "after">("before");

  const confirmDeleteTodo = () => {
    if (!deleteConfirmTodo) return;
    const latestTodo = todos.find((todo) => todo.id === deleteConfirmTodo.id);
    if (latestTodo?.pinned) {
      setDeleteConfirmTodo(null);
      return;
    }

    deleteTodo(deleteConfirmTodo.id);
    setDeleteConfirmTodo(null);
  };

  const handleDragStart = (e: React.MouseEvent, filteredIndex: number) => {
    e.preventDefault();
    const draggedTodo = filteredTodos[filteredIndex];
    if (!draggedTodo || draggedTodo.pinned) return;

    setDragIndex(filteredIndex);
    dragTodoIdRef.current = draggedTodo.id;
    dragOverPositionRef.current = "before";

    const itemEls = listRef.current?.querySelectorAll<HTMLElement>("[data-todo-row-id]");
    if (!itemEls || !itemEls[filteredIndex]) return;
    const startRect = itemEls[filteredIndex].getBoundingClientRect();
    const offsetY = e.clientY - startRect.top;

    // 创建浮动克隆
    const clone = itemEls[filteredIndex].cloneNode(true) as HTMLElement;
    clone.style.position = "fixed";
    clone.style.left = `${startRect.left}px`;
    clone.style.top = `${startRect.top}px`;
    clone.style.width = `${startRect.width}px`;
    clone.style.zIndex = "9999";
    clone.style.pointerEvents = "none";
    clone.style.opacity = "0.85";
    clone.style.boxShadow = "0 4px 16px rgba(0,0,0,0.15)";
    clone.style.borderRadius = "8px";
    clone.style.transition = "none";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    document.body.appendChild(clone);
    dragNodeRef.current = clone;

    const onMove = (ev: MouseEvent) => {
      clone.style.top = `${ev.clientY - offsetY}px`;

      // 计算当前 hover 到哪个 item
      if (!listRef.current) return;
      const viewport = listRef.current.getBoundingClientRect();
      if (ev.clientX < viewport.left || ev.clientX > viewport.right) {
        dragOverTodoIdRef.current = null;
        setDragOverIndex(null);
        setDragOverPosition(null);
        return;
      }
      const children = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-todo-row-id]"));
      let found = false;
      for (let i = 0; i < children.length; i++) {
        if (filteredTodos[i]?.pinned || filteredTodos[i]?.id === draggedTodo.id) continue;
        const rect = children[i].getBoundingClientRect();
        if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          setDragOverIndex(i);
          dragOverTodoIdRef.current = filteredTodos[i]?.id ?? null;
          dragOverPositionRef.current = ev.clientY >= rect.top + rect.height / 2 ? "after" : "before";
          setDragOverPosition(dragOverPositionRef.current);
          found = true;
          break;
        }
      }
      if (found) return;
      for (let i = 0; i < children.length; i++) {
        if (filteredTodos[i]?.pinned) continue;
        if (filteredTodos[i]?.id === draggedTodo.id) continue;
        const rect = children[i].getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (ev.clientY < mid) {
          setDragOverIndex(i);
          dragOverTodoIdRef.current = filteredTodos[i]?.id ?? null;
          dragOverPositionRef.current = "before";
          setDragOverPosition("before");
          found = true;
          break;
        }
      }
      if (!found) {
        let last = -1;
        for (let index = filteredTodos.length - 1; index >= 0; index -= 1) {
          if (!filteredTodos[index].pinned && filteredTodos[index].id !== draggedTodo.id) {
            last = index;
            break;
          }
        }
        if (last < 0) return;
        setDragOverIndex(last);
        dragOverTodoIdRef.current = filteredTodos[last]?.id ?? null;
        dragOverPositionRef.current = "after";
        setDragOverPosition("after");
      }
    };

    const onUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      clone.remove();
      dragNodeRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";

      const todoId = dragTodoIdRef.current;
      const targetTodoId = dragOverTodoIdRef.current;
      const viewport = listRef.current?.getBoundingClientRect();
      const insideViewport = !viewport || (upEvent.clientX >= viewport.left && upEvent.clientX <= viewport.right);
      if (insideViewport && todoId && targetTodoId && todoId !== targetTodoId) {
        reorderTodos(todoId, targetTodoId, dragOverPositionRef.current);
      }
      setDragIndex(null);
      setDragOverIndex(null);
      setDragOverPosition(null);
      dragTodoIdRef.current = null;
      dragOverTodoIdRef.current = null;
      dragOverPositionRef.current = "before";
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  useEffect(() => {
    setEditingId(null);
    setEditingTitle("");
    setOpenCalendarTodoId(null);
    setDeleteConfirmTodo(null);
    setDescriptionEditorId(null);
  }, [activeListId]);

  useEffect(() => {
    if (!openCalendarTodoId) return;

    const closeCalendar = (event: MouseEvent) => {
      if (calendarRef.current?.contains(event.target as Node)) return;
      setOpenCalendarTodoId(null);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenCalendarTodoId(null);
    };

    document.addEventListener("mousedown", closeCalendar);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeCalendar);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openCalendarTodoId]);

  const positionCalendar = useCallback((calendarHeight = 284) => {
    const anchor = calendarAnchorRef.current;
    if (!anchor?.isConnected) return;

    const rect = anchor.getBoundingClientRect();
    const calendarWidth = 248;
    const margin = 12;
    const gap = 8;
    const spaceBelow = window.innerHeight - rect.bottom - margin - gap;
    const spaceAbove = rect.top - margin - gap;
    const openAbove = spaceBelow < calendarHeight && spaceAbove > spaceBelow;
    const preferredTop = openAbove
      ? rect.top - gap - calendarHeight
      : rect.bottom + gap;
    const maxTop = Math.max(margin, window.innerHeight - calendarHeight - margin);
    const top = Math.min(Math.max(preferredTop, margin), maxTop);
    const maxLeft = Math.max(margin, window.innerWidth - calendarWidth - margin);
    const left = Math.min(Math.max(rect.left, margin), maxLeft);

    setCalendarPosition((current) => (
      current.top === top && current.left === left ? current : { top, left }
    ));
  }, []);

  useLayoutEffect(() => {
    if (!openCalendarTodoId) return;
    const calendar = calendarRef.current;
    if (!calendar) return;

    const updatePosition = () => positionCalendar(calendar.getBoundingClientRect().height);
    updatePosition();

    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(calendar);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [calendarView, openCalendarTodoId, positionCalendar]);

  const startEditing = (id: string, title: string) => {
    setEditingId(id);
    setEditingTitle(title);
  };

  const confirmEdit = () => {
    const targetId = editingId;
    if (!targetId) return;

    const current = todos.find((todo) => todo.id === targetId);
    const nextTitle = editingTitle.trim();
    if (!nextTitle) {
      // 新建的空子待办未填写内容时直接丢弃，避免留下空行
      if (current?.parentId) deleteTodo(targetId);
    } else if (nextTitle !== current?.title) {
      updateTodo(targetId, { title: nextTitle });
    }
    setEditingId(null);
    setEditingTitle("");
  };

  const cancelEdit = () => {
    const targetId = editingId;
    const current = targetId ? todos.find((todo) => todo.id === targetId) : undefined;
    if (targetId && current?.parentId && !current.title) deleteTodo(targetId);
    setEditingId(null);
    setEditingTitle("");
  };

  // 新建子待办：立即落库并进入内联编辑，未填内容则在失焦时自动丢弃
  const handleAddSubtask = (parentId: string) => {
    const parent = todos.find((todo) => todo.id === parentId);
    if (!parent) return;
    if (!parent.expanded) toggleExpanded(parentId);
    const subtaskId = addSubtask(parentId, "");
    setEditingId(subtaskId);
    setEditingTitle("");
  };

  // Runs in the same commit as the list switch the sidebar triggered, and after
  // the reset effect above — handling it on arrival would be undone by that reset.
  useEffect(() => {
    if (!todoIntent) return;
    setTodoIntent(null);
    const target = todos.find((todo) => todo.id === todoIntent.todoId);
    if (!target) return;
    if (todoIntent.kind === "edit-description") {
      setDescriptionEditorId(target.id);
    } else if (todoIntent.kind === "add-subtask") {
      handleAddSubtask(target.id);
    } else if (!target.pinned) {
      // 置顶任务在 store 里拒绝删除，这里直接跳过，避免弹出点了也没用的确认框
      setDeleteConfirmTodo(target);
    }
    // `todos` is read from the render that produced the intent; re-running on
    // every todo change would only re-enter the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todoIntent]);

  // 点击优先级标签直接循环切换：低→中→高→低
  const cyclePriority = (id: string, current: Priority) => {
    updateTodo(id, { priority: priorityCycle[current] });
  };

  const toggleCalendar = (todoId: string, dueDate: string | undefined, element: HTMLElement) => {
    if (openCalendarTodoId === todoId) {
      setOpenCalendarTodoId(null);
      calendarAnchorRef.current = null;
      return;
    }

    calendarAnchorRef.current = element;
    positionCalendar();
    setCalendarMonth(getMonthStart(dueDate));
    setCalendarView("day");
    setCalendarMotion("zoomIn");
    setOpenCalendarTodoId(todoId);
  };

  const moveCalendar = (motion: "next" | "prev") => {
    setCalendarMotion(motion);
    setCalendarMonth((current) => {
      if (calendarView === "day") return addMonths(current, motion === "next" ? 1 : -1);
      if (calendarView === "month") {
        return new Date(current.getFullYear() + (motion === "next" ? 1 : -1), current.getMonth(), 1);
      }
      return new Date(current.getFullYear() + (motion === "next" ? 12 : -12), current.getMonth(), 1);
    });
  };

  const showCalendarView = (view: CalendarView, motion: CalendarMotion) => {
    setCalendarMotion(motion);
    setCalendarView(view);
  };

  // 筛选只作用于父待办；展开后子待办始终完整显示
  const filteredTodos = topLevelTodos.filter((t) => {
    if (filter === "active" && t.completed) return false;
    if (filter === "completed" && !t.completed) return false;
    if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
    return true;
  });

  const todayInputValue = getTodayInputValue();

  return (
    <div className="todo-surface flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <TodoStrip />

      {/* Todo List */}
      {/* The list sits on its own recessed sheet inside the card: at 8px of row
          padding the rows need an edge to stop against, otherwise they read as
          loose chips floating on the frosted card. The sheet is the scroll
          container too, so its rounded corners clip the rows for free. */}
      <div className="min-h-0 flex-1 px-2.5 pb-2.5 pt-2">
        <div className="h-full overflow-y-auto rounded-xl border border-border/45 bg-bg-secondary/20 px-1.5 py-1.5">
        <div ref={listRef}>
          {filteredTodos.map((todo, index) => {
            const isDragging = dragIndex === index;
            const isDragOver = dragOverIndex === index && dragIndex !== index;
            const isOverdue = Boolean(todo.dueDate && todo.dueDate < todayInputValue && !todo.completed);
            const selectedDueDate = parseDateInputValue(todo.dueDate);
            const subtasks = subtasksByParent.get(todo.id) ?? [];
            const hasSubtasks = subtasks.length > 0;
            const doneSubtasks = subtasks.filter((subtask) => subtask.completed).length;
            const isExpanded = hasSubtasks && Boolean(todo.expanded);
            return (
            <div key={todo.id} className="todo-task-group border-b border-border/55 last:border-b-0">
            <div
              data-todo-row-id={todo.id}
              className={`todo-task-row group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2
                ${isDragging ? "opacity-30" : "hover:bg-bg-hover"}
                ${isDragOver ? "bg-accent-light/35" : ""}`}
            >
              {isDragOver && dragOverPosition && (
                <span
                  aria-hidden="true"
                  className={`drag-insertion-line drag-insertion-line--${dragOverPosition}`}
                />
              )}
              {/* 把手与展开位合成一个「行前导」簇：簇内不留间距，簇右边缘再内收
                  6px，把把手到勾选框的间距从 40.5px 收到 24.5px。簇外的行间距
                  gap-2.5 保持不变，右侧按钮组因此不受影响。
                  改这两个值时必须同步下面描述容器 ml-[58px] 与子任务竖线 ml-[58px]
                  的算式：10 + 14 + 0 + 16 - 6 = 34（簇 margin box 右缘）。 */}
              <div className="flex flex-shrink-0 items-center gap-0 -mr-1.5">
                {!todo.pinned && (
                  <GripVertical
                    size={14}
                    className="flex-shrink-0 cursor-grab select-none text-text-muted opacity-30 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
                    onMouseDown={(e) => handleDragStart(e, index)}
                  />
                )}
                {todo.pinned && <Pin size={14} className="flex-shrink-0 text-accent-text" />}
                {/* 固定宽度的展开位，保证有无子待办时勾选框都对齐 */}
                <div className="flex w-4 flex-shrink-0 items-center justify-center">
                  {hasSubtasks && (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(todo.id)}
                      className="flex h-4 w-4 cursor-pointer items-center justify-center rounded text-text-muted
                        transition-colors hover:bg-bg-hover hover:text-text-primary"
                      title={isExpanded ? t(lang, "collapseSubtasks") : t(lang, "expandSubtasks")}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? t(lang, "collapseSubtasks") : t(lang, "expandSubtasks")}
                    >
                      <ChevronRight
                        size={13}
                        className={`transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
                      />
                    </button>
                  )}
                </div>
              </div>
              <button
                onClick={() => toggleTodo(todo.id)}
                className={`flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-accent-light ${todo.completed ? "todo-check-done" : ""}`}
              >
                {todo.completed ? (
                  <CheckCircle2 size={19} className="text-success" />
                ) : (
                  <Circle size={19} className="text-text-muted hover:text-accent-text transition-colors" />
                )}
              </button>

              {/* 内联编辑标题：点击原地变输入框 */}
              {editingId === todo.id ? (
                <input
                  ref={editInputRef}
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmEdit();
                    if (e.key === "Escape") cancelEdit();
                  }}
                  onBlur={confirmEdit}
                  className="flex-1 text-sm px-1 py-0.5 rounded border border-accent bg-bg-primary
                    text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              ) : (
                <span
                  onClick={() => startEditing(todo.id, todo.title)}
                  className={`min-w-0 flex-1 cursor-text truncate rounded px-1 py-0.5 text-sm transition-colors hover:bg-bg-hover
                    ${todo.completed ? "text-text-secondary line-through" : "text-text-primary"}`}
                  title={todo.title}
                >
                  {todo.title}
                </span>
              )}

              {/* Subtask progress. It used to be a pill wedged between the title
                  and the date, which meant it floated wherever the title happened
                  to end and moved from row to row. A fixed 34px slot, right
                  aligned against the date column, puts every counter in the same
                  place and lets the number itself be plain - a pill out there in
                  the middle of the row read as a button nobody could press. */}
              <span className="flex w-[34px] flex-shrink-0 justify-end">
                {hasSubtasks && (
                  <span
                    className="text-[11px] leading-none tabular-nums text-text-secondary"
                    title={`${doneSubtasks}/${subtasks.length} ${t(lang, "subtask")}`}
                    aria-label={`${doneSubtasks}/${subtasks.length} ${t(lang, "subtask")}`}
                  >
                    {doneSubtasks}/{subtasks.length}
                  </span>
                )}
              </span>

              {/* Fixed-width date slot, sitting to the left of the icon cluster.
                  The slot is always 96px - wide enough for the longest string the
                  formatter can produce ("2025/10/28") - whether or not a date
                  exists: with a shrink-to-fit chip, every row that had a
                  deadline pushed the actions sideways and the right edge went
                  ragged. Left-aligned, not right: the formatter drops the year
                  for dates in the current year, so right-aligning would slide
                  "10/28" and "2025/10/28" to different starting points inside the
                  same column. */}
              <div className="flex w-[96px] flex-shrink-0 items-center justify-start gap-1">
                {todo.dueDate ? (
                  <button
                    type="button"
                    onClick={(e) => toggleCalendar(todo.id, todo.dueDate, e.currentTarget)}
                    className={`flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs tabular-nums transition-colors
                      ${isOverdue ? "text-danger hover:bg-danger/10" : "text-text-secondary hover:bg-bg-hover"}`}
                    title={t(lang, "dueDate")}
                    aria-expanded={openCalendarTodoId === todo.id}
                    aria-label={t(lang, "dueDate")}
                  >
                    <CalendarDays size={12} className="flex-shrink-0" />
                    <span className="whitespace-nowrap leading-none">
                      {formatDateInputValue(todo.dueDate, lang)}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => toggleCalendar(todo.id, todo.dueDate, e.currentTarget)}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-text-muted
                      transition-all hover:bg-bg-hover hover:text-accent-text"
                    title={t(lang, "noDueDate")}
                    aria-expanded={openCalendarTodoId === todo.id}
                    aria-label={t(lang, "dueDate")}
                  >
                    <CalendarDays size={12} />
                  </button>
                )}
                {openCalendarTodoId === todo.id && createPortal(
                  <div
                    ref={calendarRef}
                    className="todo-popover fixed z-50 max-h-[calc(100vh-24px)] w-[248px] overflow-y-auto rounded-xl border border-border bg-bg-primary p-3
                      text-text-primary shadow-lg shadow-black/10"
                    style={{ top: calendarPosition.top, left: calendarPosition.left }}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <button
                        type="button"
                        onClick={() => moveCalendar("prev")}
                        className="h-7 w-7 rounded-md flex items-center justify-center text-text-muted
                          hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                      >
                        <ChevronLeft size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (calendarView === "day") showCalendarView("month", "zoomOut");
                          if (calendarView === "month") showCalendarView("year", "zoomOut");
                        }}
                        className="min-w-28 rounded-md px-2 py-1 text-sm font-medium text-text-primary
                          transition-colors hover:bg-bg-hover cursor-pointer"
                      >
                        {calendarView === "day"
                          ? new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
                              year: "numeric",
                              month: "long",
                            }).format(calendarMonth)
                          : calendarView === "month"
                            ? calendarMonth.getFullYear()
                            : `${getYearRange(calendarMonth)[0]} - ${getYearRange(calendarMonth)[11]}`}
                      </button>
                      <button
                        type="button"
                        onClick={() => moveCalendar("next")}
                        className="h-7 w-7 rounded-md flex items-center justify-center text-text-muted
                          hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                      >
                        <ChevronRight size={15} />
                      </button>
                    </div>
                    <div
                      key={`${calendarView}-${calendarMonth.getFullYear()}-${calendarMonth.getMonth()}`}
                      className={`calendar-motion calendar-motion-${calendarMotion}`}
                    >
                    {calendarView === "day" && (
                      <>
                        <div className="grid grid-cols-7 gap-1 mb-1">
                          {(lang === "zh" ? ["一", "二", "三", "四", "五", "六", "日"] : ["M", "T", "W", "T", "F", "S", "S"]).map((day, dayIndex) => (
                            <div key={`${day}-${dayIndex}`} className="h-6 flex items-center justify-center text-[11px] text-text-muted">
                              {day}
                            </div>
                          ))}
                        </div>
                        <div className="grid grid-cols-7 gap-1">
                          {getCalendarDays(calendarMonth).map((day) => {
                            const isSelected = day.value === todo.dueDate;
                            const isToday = day.value === todayInputValue;
                            return (
                              <button
                                type="button"
                                key={day.value}
                                onClick={() => {
                                  updateTodo(todo.id, { dueDate: day.value });
                                  setOpenCalendarTodoId(null);
                                }}
                                className={`h-7 rounded-md text-xs transition-colors cursor-pointer
                                  ${isSelected
                                    ? "bg-accent text-on-accent"
                                    : isToday
                                      ? "bg-accent-light text-accent-text"
                                      : day.isCurrentMonth
                                        ? "text-text-primary hover:bg-bg-hover"
                                        : "text-text-muted/45 hover:bg-bg-hover"}`}
                              >
                                {day.date.getDate()}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                    {calendarView === "month" && (
                      <div className="grid grid-cols-3 gap-2">
                        {Array.from({ length: 12 }, (_, monthIndex) => {
                          const isSelectedMonth = selectedDueDate?.getFullYear() === calendarMonth.getFullYear()
                            && selectedDueDate?.getMonth() === monthIndex;
                          const isCurrentMonth = new Date().getFullYear() === calendarMonth.getFullYear()
                            && new Date().getMonth() === monthIndex;

                          return (
                            <button
                              type="button"
                              key={monthIndex}
                              onClick={() => {
                                setCalendarMonth(new Date(calendarMonth.getFullYear(), monthIndex, 1));
                                showCalendarView("day", "zoomIn");
                              }}
                              className={`h-9 rounded-md text-xs transition-colors cursor-pointer
                                ${isSelectedMonth
                                  ? "bg-accent text-on-accent"
                                  : isCurrentMonth
                                    ? "bg-accent-light text-accent-text"
                                    : "text-text-primary hover:bg-bg-hover"}`}
                            >
                              {new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { month: "short" }).format(new Date(calendarMonth.getFullYear(), monthIndex, 1))}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {calendarView === "year" && (
                      <div className="grid grid-cols-3 gap-2">
                        {getYearRange(calendarMonth).map((year) => {
                          const isSelectedYear = selectedDueDate?.getFullYear() === year;
                          const isCurrentYear = new Date().getFullYear() === year;

                          return (
                            <button
                              type="button"
                              key={year}
                              onClick={() => {
                                setCalendarMonth(new Date(year, calendarMonth.getMonth(), 1));
                                showCalendarView("month", "zoomIn");
                              }}
                              className={`h-9 rounded-md text-xs transition-colors cursor-pointer
                                ${isSelectedYear
                                  ? "bg-accent text-on-accent"
                                  : isCurrentYear
                                    ? "bg-accent-light text-accent-text"
                                    : "text-text-primary hover:bg-bg-hover"}`}
                            >
                              {year}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    </div>
                    {/* Clearing moved in here when the row-level × left: the
                        date cell is a fixed 84px slot, and a second button
                        inside it would have widened every row again. */}
                    {todo.dueDate && (
                      <button
                        type="button"
                        onClick={() => {
                          updateTodo(todo.id, { dueDate: undefined });
                          setOpenCalendarTodoId(null);
                        }}
                        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-border/60 py-1
                          text-[11px] text-text-muted transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
                      >
                        <X size={11} />
                        {t(lang, "clearDueDate")}
                      </button>
                    )}
                  </div>,
                  document.body,
                )}
              </div>

              {/* The icon cluster follows the date slot, so its left edge is a
                  fixed distance from the row's end on every row. */}
              <div className="flex flex-shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setDescriptionEditorId(todo.id)}
                  className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-full transition-all
                    ${Boolean(todo.description?.trim())
                      ? "text-accent-text hover:bg-accent-light"
                      : "text-text-muted hover:bg-bg-hover hover:text-accent-text"}`}
                  title={Boolean(todo.description?.trim()) ? t(lang, "editTodoDescription") : t(lang, "addTodoDescription")}
                  aria-label={Boolean(todo.description?.trim()) ? t(lang, "editTodoDescription") : t(lang, "addTodoDescription")}
                >
                  <AlignLeft size={12} />
                </button>

                <button
                  type="button"
                  onClick={() => handleAddSubtask(todo.id)}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-text-muted
                    transition-all hover:bg-bg-hover hover:text-accent-text"
                  title={t(lang, "addSubtask")}
                  aria-label={t(lang, "addSubtask")}
                >
                  <ListPlus size={12} />
                </button>

                <button
                  type="button"
                  onClick={() => togglePinned(todo.id)}
                  className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-full transition-all
                    ${todo.pinned
                      ? "text-accent-text bg-accent-light"
                      : "text-text-muted hover:bg-bg-hover hover:text-accent-text"}`}
                  title={todo.pinned ? t(lang, "unpinTodo") : t(lang, "pinTodo")}
                  aria-label={todo.pinned ? t(lang, "unpinTodo") : t(lang, "pinTodo")}
                >
                  {todo.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                </button>
              </div>

              {/* 点击优先级旗直接循环切换。颜色走 token（低=中性、中=warning、高=danger），
                  在深色主题下不会再出现 `bg-*-100` 那种亮块。 */}
              <button
                type="button"
                onClick={() => cyclePriority(todo.id, todo.priority)}
                className={`flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md
                  transition-colors hover:bg-bg-hover ${priorityTone[todo.priority]}`}
                title={t(lang, todo.priority === "low" ? "low" : todo.priority === "medium" ? "medium" : "high")}
                aria-label={t(lang, todo.priority === "low" ? "low" : todo.priority === "medium" ? "medium" : "high")}
              >
                <Flag
                  size={12}
                  className={todo.priority === "low" ? "opacity-45" : ""}
                  fill={todo.priority === "high" ? "currentColor" : "none"}
                />
              </button>

              <button
                onClick={() => {
                  if (todo.pinned) return;
                  setDeleteConfirmTodo(todo);
                }}
                disabled={todo.pinned}
                className={`transition-all
                  ${todo.pinned
                    ? "text-text-muted/35 cursor-not-allowed"
                    : "text-text-muted hover:text-danger cursor-pointer"}`}
                title={t(lang, "deleteTodo")}
                aria-disabled={todo.pinned}
              >
                <Trash2 size={14} />
              </button>
            </div>

            {/* The body of the task hangs off the same rail as the subtasks
                (58px = the toggle's centre), so description and children read as
                two faces of one task instead of a card parked under a row. */}
            <div className="ml-[58px] mr-2 pb-0.5">
              <TodoDescriptionCard
                description={todo.description}
                completed={todo.completed}
                editing={descriptionEditorId === todo.id}
                onEditingChange={(next) => setDescriptionEditorId(next ? todo.id : null)}
                onSave={(value) => updateTodo(todo.id, { description: value || undefined })}
              />
            </div>

            {isExpanded && (
              // The guide line sits at the parent circle's centre (leading cluster
              // right edge 34 + gap 10 + half of the 28px toggle = 58), so the
              // branch visually hangs off the box it belongs to.
              <div className="todo-subtask-list ml-[58px] mt-0.5 mb-1 space-y-0.5 border-l border-border/60 pl-3">
                {subtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    data-subtask-row-id={subtask.id}
                    className="group/sub flex items-center gap-2 rounded-lg py-1.5 pr-2 transition-colors hover:bg-bg-hover/60"
                  >
                    {/* Subtasks are a different rank of the same thing: the round
                        toggle belongs to the parent item, a square one to a child. */}
                    <button
                      type="button"
                      onClick={() => toggleTodo(subtask.id)}
                      className={`flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded
                        transition-colors hover:bg-accent-light ${subtask.completed ? "todo-check-done" : ""}`}
                      aria-label={t(lang, "subtask")}
                    >
                      <span
                        className={`flex h-3 w-3 items-center justify-center rounded-[3px] border transition-colors ${
                          subtask.completed
                            ? "border-success bg-success text-on-success"
                            : "border-text-muted/70 bg-transparent"
                        }`}
                      >
                        {subtask.completed && <Check size={9} strokeWidth={3.5} />}
                      </span>
                    </button>

                    {editingId === subtask.id ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editingTitle}
                        placeholder={t(lang, "addSubtask")}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") confirmEdit();
                          if (e.key === "Escape") cancelEdit();
                        }}
                        onBlur={confirmEdit}
                        className="flex-1 rounded border border-accent bg-bg-primary px-1 py-0.5 text-[13px]
                          text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    ) : (
                      <span
                        onClick={() => startEditing(subtask.id, subtask.title)}
                        className={`flex-1 cursor-text rounded px-1 py-0.5 text-[13px] transition-colors hover:bg-bg-hover
                          text-text-secondary ${subtask.completed ? "line-through" : ""}`}
                        title={subtask.title}
                      >
                        {subtask.title || t(lang, "subtask")}
                      </span>
                    )}

                    <button
                      type="button"
                      onClick={() => deleteTodo(subtask.id)}
                      className="h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-full text-text-muted
                        transition-all hover:bg-bg-hover hover:text-danger cursor-pointer"
                      title={t(lang, "deleteSubtask")}
                      aria-label={t(lang, "deleteSubtask")}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            </div>
            );
          })}
        </div>
        {filteredTodos.length === 0 && (
          // A blank sheet is still a sheet: the rule that separates two tasks
          // keeps going below the prompt, so an empty list reads as an empty
          // notebook page rather than a hole in the card. The fill is a gradient
          // so it always reaches the bottom edge, whatever the panel height.
          <div className="flex min-h-full flex-col">
            <EmptyState
              icon={<CheckCircle2 size={18} />}
              title={
                topLevelTodos.length === 0
                  ? t(lang, "noTodos")
                  : filter === "completed"
                    ? t(lang, "noCompleted")
                    : filter === "active"
                      ? t(lang, "allDone")
                      : t(lang, "noTodos")
              }
              description={topLevelTodos.length === 0 ? t(lang, "noTodosHint") : undefined}
              action={
                topLevelTodos.length === 0
                  ? { label: t(lang, "newTodo"), onClick: () => dispatchPortalAction("new-todo") }
                  : undefined
              }
            />
            {/* 96px, not 160: the fill only has to reach the bottom of a normal
                card. A taller floor pushed the prompt into a scrollbar on short
                windows, which is the one thing an empty state must never do. */}
            <div aria-hidden="true" className="todo-rule-fill min-h-[96px] flex-1" />
          </div>
        )}
        </div>
      </div>

      {deleteConfirmTodo && (
        <ModalShell
          onClose={() => setDeleteConfirmTodo(null)}
          title={t(lang, "deleteTodo")}
          description={deleteConfirmTodo.title}
          icon={<Trash2 size={16} />}
          tone="danger"
          size="sm"
          footer={(
            <>
              <button
                type="button"
                onClick={() => setDeleteConfirmTodo(null)}
                className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {t(lang, "confirmNo")}
              </button>
              <button
                type="button"
                onClick={confirmDeleteTodo}
                className="h-8 rounded-lg bg-danger px-3 text-xs text-on-danger transition-colors hover:bg-danger/90"
              >
                {t(lang, "confirmYes")}
              </button>
            </>
          )}
        >
          <p className="text-sm leading-relaxed text-text-secondary">
            {(subtasksByParent.get(deleteConfirmTodo.id)?.length ?? 0) > 0
              ? tWithParams(lang, "confirmDeleteTodoWithSubtasks", {
                  todo: deleteConfirmTodo.title,
                  count: subtasksByParent.get(deleteConfirmTodo.id)?.length ?? 0,
                })
              : t(lang, "confirmDeleteTodoMessage").replace("{todo}", deleteConfirmTodo.title)}
          </p>
        </ModalShell>
      )}
    </div>
  );
};

export default TodoView;
