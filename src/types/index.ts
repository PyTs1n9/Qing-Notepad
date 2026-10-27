export interface Todo {
  id: string;
  listId: string;
  /** Parent todo id for subtasks; null/undefined means a top-level todo. */
  parentId?: string | null;
  /** Whether the subtask list of this top-level todo is expanded. */
  expanded?: boolean;
  title: string;
  completed: boolean;
  priority: "low" | "medium" | "high";
  pinned?: boolean;
  dueDate?: string;
  category?: string;
  /** Free-form body shown as a card under the task in the todo view. */
  description?: string;
  createdAt: string;
  order: number;
}

export interface TodoList {
  id: string;
  name: string;
  pinned: boolean;
  order: number;
  createdAt: string;
}

export interface TodoListData {
  lists: TodoList[];
  activeListId: string | null;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  categoryId?: string | null;
  pinned?: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoteCategory {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  /** Parent folder id; null/undefined means a top-level folder. */
  parentId?: string | null;
  /** Pinned folders sort above their siblings in the note tree. */
  pinned?: boolean;
}

export interface AppFont {
  name: string;
  family: string;
  path: string;
}

export type ViewType = "todo" | "note" | "canvas" | "workspace" | "plugins";

export type {
  CanvasBoard,
  CanvasAnchor,
  CanvasConnectorBinding,
  CanvasConnectorItem,
  CanvasConnectorStyle,
  CanvasDocument,
  CanvasDoodleEraserMark,
  CanvasDoodleEraserShape,
  CanvasDoodleItem,
  CanvasDoodlePoint,
  CanvasImageItem,
  CanvasItem,
  CanvasNodeItem,
  CanvasRichTextFields,
  CanvasRichTextItem,
  CanvasShapeItem,
  CanvasShapeType,
  CanvasTextItem,
  CanvasViewport,
} from "./canvas";
