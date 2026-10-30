/**
 * 碎片墙 — the browser entry point.
 *
 * Two surfaces share one page: the wall catches fragments, the notebook lets
 * them grow into Markdown notes. Storage is localStorage, so everything works
 * offline and never leaves the browser; `tidy.js` and `md.js` own the text
 * pipelines and are unit-tested on their own.
 */
import { deriveTitle, parseInline, parseMarkdown } from "./md.js";
import { extractTags, matchDue, tidy } from "./tidy.js";

const STORAGE_KEY = "qing-fragment-wall:v1";
const NOTES_KEY = "qing-notes:v1";
const GUIDE_KEY = "qing-fragment-wall:guide-seen";

const ICONS = {
  check:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.3 4.7 8.8 9.8 3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 1.9 14.1 6.6l-2 .5-2.4 2.4.4 1.9-1.2 1.2L3.9 7.6 5.1 6.4l1.9.4L9.4 4.4z" fill="currentColor"/><path d="M5.8 10.2 2.4 13.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.6l2.6 2.6-7.2 7.2-3.4.8.8-3.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 4.5h9.6M6.3 4.5V3.1h3.4v1.4M4.7 4.5l.5 8.2c0 .5.4.8.9.8h3.8c.5 0 .9-.3.9-.8l.5-8.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

const els = {
  composer: document.getElementById("composer-input"),
  save: document.getElementById("composer-save"),
  search: document.getElementById("search"),
  tidyButton: document.getElementById("tidy-button"),
  newNoteButton: document.getElementById("new-note-button"),
  surfaceButtons: Array.from(document.querySelectorAll("[data-surface]")),
  wallView: document.getElementById("wall-view"),
  notesView: document.getElementById("notes-view"),
  guide: document.getElementById("guide"),
  guideClose: document.getElementById("guide-close"),
  tabs: Array.from(document.querySelectorAll("[data-status]")),
  tagList: document.getElementById("tag-list"),
  counter: document.getElementById("counter"),
  sort: document.getElementById("sort"),
  wall: document.getElementById("wall"),
  empty: document.getElementById("empty"),
  emptyFocus: document.getElementById("empty-focus"),
  explorerWall: document.getElementById("explorer-wall"),
  explorerNotes: document.getElementById("explorer-notes"),
  explorerNewNote: document.getElementById("explorer-new-note"),
  titlebarView: document.getElementById("titlebar-view"),
  folderList: document.getElementById("folder-list"),
  folderAdd: document.getElementById("folder-add"),
  folderForm: document.getElementById("folder-form"),
  folderName: document.getElementById("folder-name"),
  noteList: document.getElementById("note-list"),
  notesEmptyHint: document.getElementById("notes-empty-hint"),
  noteHeadEl: document.querySelector(".note-head"),
  noteBodyEl: document.getElementById("note-body"),
  noteBack: document.getElementById("note-back"),
  noteTitle: document.getElementById("note-title"),
  noteStatus: document.getElementById("note-status"),
  noteEditor: document.getElementById("note-editor"),
  notePreview: document.getElementById("note-preview"),
  notePlaceholder: document.getElementById("note-placeholder"),
  noteFolder: document.getElementById("note-folder"),
  noteDelete: document.getElementById("note-delete"),
  /* `.view-button` only: `#note-body` also carries data-view for the layout. */
  viewButtons: Array.from(document.querySelectorAll(".view-button")),
  panel: document.getElementById("panel"),
  panelSummary: document.getElementById("panel-summary"),
  panelMarkdown: document.getElementById("panel-markdown"),
  panelClose: document.getElementById("panel-close"),
  panelCopy: document.getElementById("panel-copy"),
  panelSaveNote: document.getElementById("panel-save-note"),
  panelDownload: document.getElementById("panel-download"),
  panelClear: document.getElementById("panel-clear"),
  toast: document.getElementById("toast"),
};

const state = {
  surface: "wall",
  items: [],
  status: "open",
  tag: null,
  query: "",
  sort: "smart",
  editingId: null,
  notes: [],
  folders: [],
  activeNoteId: null,
  folderFilter: null,
  noteQuery: "",
  noteView: "edit",
};

/** Ids already painted once, so the entry animation only plays for new cards. */
const painted = new Set();
let lastMarkdown = "";
let storageBroken = false;
let toastTimer = 0;
let undoSnapshot = null;
/** What the empty-state button should do; set while rendering that block. */
let emptyAction = "compose";
/** Element focused before the drawer opened, restored when it closes. */
let focusBeforePanel = null;

/* ------------------------------------------------------------------ helpers */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function tagsOf(item) {
  return extractTags(item.text).tags;
}

function timeLabel(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff >= 0 && diff < 60_000) return "刚刚";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `今天 ${clock}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/* ------------------------------------------------------------------ storage */

function seedItems() {
  const now = Date.now();
  const make = (text, extra = {}) => ({
    id: createId(),
    text,
    done: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return [
    make("#工作 改完首页的活动文案，明天上午给运营看", { createdAt: now - 1000 * 60 * 38 }),
    make("要不要把便签做成置顶小窗？#想法", { createdAt: now - 1000 * 60 * 94 }),
    make("#工作 会议里提到的新手引导，需要补三张图", { createdAt: now - 1000 * 60 * 60 * 3 }),
    make("用户说「慢一点更好」", { createdAt: now - 1000 * 60 * 60 * 6 }),
    make("#生活 周末把书房那张桌子收拾一下", { createdAt: now - 1000 * 60 * 60 * 20 }),
    make("周一开会前把上周复盘写完", { done: true, createdAt: now - 1000 * 60 * 60 * 26 }),
  ];
}

function toItem(raw) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : createId(),
    text: String(raw.text ?? ""),
    done: Boolean(raw.done),
    pinned: Boolean(raw.pinned),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { items: seedItems(), seeded: true };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { items: [], seeded: false };
    return {
      items: parsed.filter((entry) => entry && typeof entry.text === "string").map(toItem),
      seeded: false,
    };
  } catch {
    storageBroken = true;
    return { items: seedItems(), seeded: false };
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
  } catch {
    if (!storageBroken) {
      storageBroken = true;
      showToast("浏览器不允许写入本地存储，本次修改只在当前页面有效");
    }
  }
}

/* ------------------------------------------------------------ notes storage */

function seedNotes() {
  const now = Date.now();
  const work = { id: createId(), name: "工作" };
  const reading = { id: createId(), name: "读书" };
  return {
    folders: [work, reading],
    notes: [
      {
        id: createId(),
        folderId: work.id,
        body: [
          "# 周会记录",
          "",
          "## 本周进展",
          "",
          "- 碎片墙的整理算法改成按标签分组",
          "- [x] 把 `tidy.js` 拆成纯函数，方便单测",
          "- [ ] 下周补上笔记的搜索与文件夹",
          "",
          "> 先保证「打开就能用」，再谈花活。",
          "",
          "```ts",
          "export function tidy(fragments: Fragment[], now = new Date()) { … }",
          "```",
        ].join("\n"),
        createdAt: now - 1000 * 60 * 60 * 20,
        updatedAt: now - 1000 * 60 * 34,
      },
      {
        id: createId(),
        folderId: reading.id,
        body: [
          "# 《卡片笔记写作法》摘记",
          "",
          "**核心**：不要给笔记分类，给笔记建立联系。",
          "",
          "1. 闪念笔记 → 永久笔记",
          "2. 一条只写一个想法",
          "3. 用自己的话重写",
          "",
          "参考 [Zettelkasten](https://zettelkasten.de/introduction/)。",
        ].join("\n"),
        createdAt: now - 1000 * 60 * 60 * 50,
        updatedAt: now - 1000 * 60 * 60 * 5,
      },
    ],
  };
}

function toNote(raw) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : createId(),
    folderId: typeof raw.folderId === "string" ? raw.folderId : null,
    body: String(raw.body ?? ""),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function loadNotesStore() {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    if (raw === null) return { ...seedNotes(), seeded: true };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { folders: [], notes: [], seeded: false };
    const folders = Array.isArray(parsed.folders)
      ? parsed.folders
          .filter((entry) => entry && typeof entry.name === "string")
          .map((entry) => ({ id: typeof entry.id === "string" && entry.id ? entry.id : createId(), name: entry.name }))
      : [];
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter((entry) => entry && typeof entry.body === "string").map(toNote)
      : [];
    return { folders, notes, seeded: false };
  } catch {
    storageBroken = true;
    return { folders: [], notes: [], seeded: false };
  }
}

function saveNotes() {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify({ folders: state.folders, notes: state.notes }));
  } catch {
    if (!storageBroken) {
      storageBroken = true;
      showToast("浏览器不允许写入本地存储，本次修改只在当前页面有效");
    }
  }
}

/* ------------------------------------------------------------------- render */

function matchesFilter(item) {
  if (state.tag && !tagsOf(item).includes(state.tag)) return false;
  const query = state.query.trim().toLowerCase();
  if (query && !item.text.toLowerCase().includes(query)) return false;
  return true;
}

function visibleItems() {
  const list = state.items.filter((item) => {
    if (state.status === "open" && item.done) return false;
    if (state.status === "done" && !item.done) return false;
    return matchesFilter(item);
  });

  const sorters = {
    smart: (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.createdAt - a.createdAt,
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
  };
  return list.sort(sorters[state.sort] ?? sorters.smart);
}

function render() {
  const list = visibleItems();
  renderTags();
  renderCounter(list.length);
  renderWall(list);
  renderEmpty(list.length);
}

function renderCounter(visibleCount) {
  const total = state.items.length;
  const done = state.items.filter((item) => item.done).length;
  const open = total - done;
  const parts = [`${open} 条未处理`];
  if (done) parts.push(`${done} 条已完成`);
  if (visibleCount !== open && (state.query.trim() || state.tag)) {
    parts.push(`筛出 ${visibleCount} 条`);
  }
  if (storageBroken) parts.push("未写入本地");
  els.counter.textContent = parts.join(" · ");
}

function renderTags() {
  const counts = new Map();
  for (const item of state.items) {
    for (const tag of tagsOf(item)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"));

  els.tagList.textContent = "";
  for (const [tag, count] of tags) {
    const active = state.tag === tag;
    els.tagList.append(
      el(
        "button",
        {
          class: `tag-filter${active ? " is-active" : ""}`,
          type: "button",
          "aria-pressed": String(active),
          onclick: () => {
            state.tag = active ? null : tag;
            render();
          },
        },
        `#${tag}`,
        el("span", { text: String(count) }),
      ),
    );
  }
  if (state.tag) {
    els.tagList.append(
      el("button", {
        class: "tag-filter",
        type: "button",
        text: "清除筛选",
        onclick: () => {
          state.tag = null;
          render();
        },
      }),
    );
  }
}

function buildEditor(item) {
  const editor = el("textarea", {
    class: "card-editor",
    "aria-label": "编辑碎片",
    rows: "3",
  });
  editor.value = item.text;
  editor.dataset.editId = item.id;

  // Committing re-renders and detaches the textarea, which fires `blur` again;
  // `settled` keeps that echo from re-entering the commit path.
  let settled = false;
  const finish = (apply) => {
    if (settled) return;
    settled = true;
    if (apply) {
      commitEdit(item.id, editor.value);
      return;
    }
    state.editingId = null;
    render();
  };

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      finish(true);
    }
  });
  editor.addEventListener("blur", () => finish(true));

  requestAnimationFrame(() => {
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  });

  return editor;
}

function buildActions(item) {
  return el(
    "div",
    { class: "card-actions" },
    el("button", {
      class: "icon-button",
      type: "button",
      dataset: { act: "pin" },
      "aria-pressed": String(item.pinned),
      "aria-label": item.pinned ? "取消置顶" : "置顶这条碎片",
      title: item.pinned ? "取消置顶" : "置顶",
      html: ICONS.pin,
    }),
    el("button", {
      class: "icon-button",
      type: "button",
      dataset: { act: "edit" },
      "aria-label": "编辑这条碎片",
      title: "编辑",
      html: ICONS.edit,
    }),
    el("button", {
      class: "icon-button is-danger",
      type: "button",
      dataset: { act: "delete" },
      "aria-label": "删除这条碎片",
      title: "删除",
      html: ICONS.trash,
    }),
  );
}

function buildFoot(item) {
  const foot = el("div", { class: "card-foot" }, el("span", { class: "card-time", text: timeLabel(item.createdAt) }));
  const due = matchDue(extractTags(item.text).text);
  if (due) foot.append(el("span", { class: "chip chip-due", text: `⏰ ${due}` }));
  foot.append(buildActions(item));
  return foot;
}

/**
 * Paint the card body, tagging `#topic` tokens in place so the reader sees the
 * same string they typed while the tag still reads as a tag.
 */
function renderText(text) {
  const nodes = [];
  const pattern = /#([\p{L}\p{N}_-]{1,20})/gu;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(document.createTextNode(text.slice(cursor, match.index)));
    nodes.push(el("span", { class: "tag-inline", text: match[0] }));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
  return nodes;
}

function renderWall(list) {
  els.wall.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const item of list) {
    const isNew = !painted.has(item.id);
    painted.add(item.id);

    const card = el("article", {
      class: [
        "card",
        item.pinned ? "is-pinned" : "",
        item.done ? "is-done" : "",
        isNew ? "is-new" : "",
      ]
        .filter(Boolean)
        .join(" "),
      dataset: { id: item.id },
    });

    const check = el("button", {
      class: "card-check",
      type: "button",
      dataset: { act: "toggle" },
      "aria-pressed": String(item.done),
      "aria-label": item.done ? "标记为未处理" : "标记为已完成",
      html: ICONS.check,
    });

    const body =
      state.editingId === item.id
        ? buildEditor(item)
        : el("p", { class: "card-text" }, ...renderText(item.text));

    card.append(el("div", { class: "card-main" }, check, body));
    card.append(buildFoot(item));
    fragment.append(card);
  }

  els.wall.append(fragment);
}

function renderEmpty(visibleCount) {
  const isEmpty = visibleCount === 0;
  els.empty.hidden = !isEmpty;
  if (!isEmpty) return;

  const hasFilter = Boolean(state.query.trim() || state.tag);
  let title;
  let copy;
  let cta;
  let action;

  if (!state.items.length) {
    title = "墙上还是空的";
    copy = "写下第一句，回车就存下来了。";
    cta = "开始写";
    action = "compose";
  } else if (hasFilter) {
    title = "没有匹配的碎片";
    copy = "换个关键词，或者清掉标签筛选再看看。";
    cta = "清空筛选";
    action = "clear";
  } else if (state.status === "done") {
    title = "还没有已完成的碎片";
    copy = "勾掉一条，它就会出现在这里。";
    cta = "回到未处理";
    action = "open";
  } else {
    title = "未处理的都清空了";
    copy = "可以切到「已完成」看看，或者再记一条。";
    cta = "再记一条";
    action = "compose";
  }

  emptyAction = action;
  els.empty.querySelector(".empty-title").textContent = title;
  els.empty.querySelector(".empty-copy").textContent = copy;
  els.emptyFocus.textContent = cta;
}

function syncStatusTabs() {
  for (const tab of els.tabs) {
    const active = tab.dataset.status === state.status;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
}

function setStatus(status) {
  state.status = status;
  syncStatusTabs();
  render();
}

function clearFilters() {
  state.tag = null;
  state.query = "";
  els.search.value = "";
  render();
}

/* ------------------------------------------------------------------- notes */

let noteEditorId = null;
let noteSaveTimer = 0;
let noteSavePending = false;

function activeNote() {
  return state.notes.find((note) => note.id === state.activeNoteId) ?? null;
}

function folderName(id) {
  return state.folders.find((folder) => folder.id === id)?.name ?? "未分类";
}

function filteredNotes() {
  const query = state.noteQuery.trim().toLowerCase();
  return state.notes
    .filter((note) => {
      if (state.folderFilter && note.folderId !== state.folderFilter) return false;
      if (!query) return true;
      return `${deriveTitle(note.body)}\n${note.body}`.toLowerCase().includes(query);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderNotes() {
  renderFolders();
  renderNoteList();
  renderNotePane();
}

function renderFolders() {
  els.folderList.textContent = "";
  const chips = [{ id: null, name: "全部", count: state.notes.length }].concat(
    state.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      count: state.notes.filter((note) => note.folderId === folder.id).length,
    })),
  );

  for (const chip of chips) {
    const active = state.folderFilter === chip.id;
    els.folderList.append(
      el(
        "button",
        {
          class: `folder${active ? " is-active" : ""}`,
          type: "button",
          "aria-pressed": String(active),
          onclick: () => {
            state.folderFilter = chip.id;
            renderNotes();
          },
        },
        `${chip.name}`,
        el("span", { text: String(chip.count) }),
      ),
    );
  }
}

function renderNoteList() {
  const notes = filteredNotes();
  els.noteList.textContent = "";

  for (const note of notes) {
    els.noteList.append(
      el(
        "button",
        {
          class: `note-item${note.id === state.activeNoteId ? " is-active" : ""}`,
          type: "button",
          "aria-current": note.id === state.activeNoteId ? "true" : "false",
          onclick: () => selectNote(note.id),
        },
        el("span", { class: "note-item-title", text: deriveTitle(note.body) }),
        el("span", {
          class: "note-item-meta",
          text: `${timeLabel(note.updatedAt)} · ${folderName(note.folderId)}`,
        }),
      ),
    );
  }

  const filtered = Boolean(state.noteQuery.trim() || state.folderFilter);
  els.notesEmptyHint.hidden = notes.length > 0;
  if (!notes.length) {
    els.notesEmptyHint.textContent = filtered
      ? "这个范围里没有笔记，换个文件夹或关键词试试。"
      : "还没有笔记。点右上角「新建笔记」，或者把整理结果存成笔记。";
  }

  if (!notes.length) {
    state.activeNoteId = null;
  } else if (!notes.some((note) => note.id === state.activeNoteId)) {
    state.activeNoteId = notes[0].id;
  }
}

/* ---------------------------------------------------- markdown → DOM nodes */

function inlineNodes(text) {
  return parseInline(text).map((token) => {
    switch (token.type) {
      case "strong":
        return el("strong", {}, ...inlineNodes(token.text));
      case "em":
        return el("em", {}, ...inlineNodes(token.text));
      case "code":
        return el("code", { text: token.text });
      case "link":
        return el(
          "a",
          { href: token.href, target: "_blank", rel: "noopener noreferrer" },
          ...inlineNodes(token.text),
        );
      default:
        return document.createTextNode(token.text);
    }
  });
}

function withBreaks(text) {
  const nodes = [];
  String(text ?? "")
    .split("\n")
    .forEach((line, index) => {
      if (index > 0) nodes.push(document.createElement("br"));
      nodes.push(...inlineNodes(line));
    });
  return nodes;
}

function blockNode(block) {
  switch (block.type) {
    case "heading":
      return el(`h${Math.min(block.level, 4)}`, {}, ...inlineNodes(block.text));
    case "paragraph":
      return el("p", {}, ...withBreaks(block.text));
    case "list": {
      const list = el(block.ordered ? "ol" : "ul", {});
      for (const item of block.items) {
        const li = el("li", {});
        if (item.checked === null) {
          li.append(...withBreaks(item.text));
        } else {
          li.className = `is-task${item.checked ? " is-done" : ""}`;
          li.append(
            el("span", { class: "task-box", text: item.checked ? "☑" : "☐" }),
            el("span", {}, ...withBreaks(item.text)),
          );
        }
        list.append(li);
      }
      return list;
    }
    case "code":
      return el("pre", {}, el("code", { text: block.code }));
    case "quote":
      return el("blockquote", {}, ...withBreaks(block.text));
    case "hr":
      return el("hr", {});
    default:
      return el("p", {});
  }
}

function renderNotePreview(body) {
  els.notePreview.textContent = "";
  for (const block of parseMarkdown(body)) els.notePreview.append(blockNode(block));
}

function noteStatusText(note) {
  return `已保存 · ${timeLabel(note.updatedAt)}`;
}

function renderNotePane() {
  const note = activeNote();
  const hasNote = Boolean(note);

  els.noteHeadEl.hidden = !hasNote;
  els.noteBodyEl.hidden = !hasNote;
  els.notePlaceholder.hidden = hasNote;

  if (!note) {
    els.noteTitle.textContent = "还没有打开笔记";
    els.noteStatus.textContent = "";
    els.noteEditor.value = "";
    els.notePreview.textContent = "";
    noteEditorId = null;
    return;
  }

  els.noteTitle.textContent = deriveTitle(note.body);
  els.noteStatus.textContent = noteStatusText(note);

  if (noteEditorId !== note.id) {
    els.noteEditor.value = note.body;
    noteEditorId = note.id;
  }
  renderNotePreview(note.body);

  els.noteFolder.textContent = "";
  els.noteFolder.append(el("option", { value: "", text: "未分类" }));
  for (const folder of state.folders) {
    els.noteFolder.append(el("option", { value: folder.id, text: folder.name }));
  }
  els.noteFolder.value = note.folderId ?? "";
}

function setNoteView(view) {
  state.noteView = view;
  els.noteBodyEl.dataset.view = view;
  for (const button of els.viewButtons) {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function scheduleNoteSave() {
  const note = activeNote();
  if (!note) return;

  note.body = els.noteEditor.value;
  note.updatedAt = Date.now();
  noteSavePending = true;
  els.noteStatus.textContent = "正在保存…";

  clearTimeout(noteSaveTimer);
  noteSaveTimer = window.setTimeout(() => {
    noteSavePending = false;
    saveNotes();
    els.noteStatus.textContent = noteStatusText(note);
    els.noteTitle.textContent = deriveTitle(note.body);
    renderNoteList();
    renderNotePreview(note.body);
  }, 320);
}

function flushNoteSave() {
  if (!noteSavePending) return;
  clearTimeout(noteSaveTimer);
  noteSavePending = false;
  saveNotes();
}

function setNoteMode(mode) {
  document.body.dataset.noteMode = mode;
}

function selectNote(id) {
  flushNoteSave();
  state.activeNoteId = id;
  setNoteMode("read");
  renderNotePane();
  renderNoteList();
}

function createNote() {
  flushNoteSave();
  const now = Date.now();
  const note = {
    id: createId(),
    folderId: state.folderFilter,
    body: "# 新笔记\n\n",
    createdAt: now,
    updatedAt: now,
  };
  state.notes.unshift(note);
  state.activeNoteId = note.id;
  state.noteQuery = "";
  els.search.value = "";
  saveNotes();

  if (state.surface !== "notes") setSurface("notes");
  setNoteMode("read");
  renderNotes();

  els.noteEditor.focus();
  els.noteEditor.setSelectionRange(note.body.length, note.body.length);
  showToast("新笔记已建好，直接写就行");
}

function deleteNote() {
  const note = activeNote();
  if (!note) return;
  const backup = state.notes.map((entry) => ({ ...entry }));
  state.notes = state.notes.filter((entry) => entry.id !== note.id);
  state.activeNoteId = null;
  noteEditorId = null;
  saveNotes();
  renderNotes();
  showToast("已删除这篇笔记", {
    label: "撤销",
    run: () => {
      state.notes = backup;
      state.activeNoteId = note.id;
      saveNotes();
      renderNotes();
    },
  });
}

function assignFolder(folderId) {
  const note = activeNote();
  if (!note) return;
  note.folderId = folderId || null;
  note.updatedAt = Date.now();
  saveNotes();
  renderNoteList();
  showToast(`已移到「${folderName(note.folderId)}」`);
}

function commitFolder(event) {
  event.preventDefault();
  const name = els.folderName.value.trim().slice(0, 12);
  els.folderForm.hidden = true;
  els.folderName.value = "";
  if (!name) return;
  state.folders.push({ id: createId(), name });
  saveNotes();
  renderNotes();
  showToast(`已新建文件夹「${name}」`);
}

/* ------------------------------------------------------------- surface swap */

function setSurface(surface) {
  flushNoteSave();
  state.surface = surface;
  const isNotes = surface === "notes";

  els.wallView.hidden = isNotes;
  els.notesView.hidden = !isNotes;
  els.tidyButton.hidden = isNotes;
  els.newNoteButton.hidden = !isNotes;
  els.explorerWall.hidden = isNotes;
  els.explorerNotes.hidden = !isNotes;
  /* The folder form lives in the notes explorer, so its trigger goes with it. */
  els.folderAdd.hidden = !isNotes;
  els.titlebarView.textContent = isNotes ? "笔记" : "碎片墙";
  document.body.dataset.surface = surface;

  for (const button of els.surfaceButtons) {
    const active = button.dataset.surface === surface;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  els.search.placeholder = isNotes ? "搜索标题与正文" : "搜索碎片";
  els.search.value = isNotes ? state.noteQuery : state.query;

  if (isNotes) {
    if (!document.body.dataset.noteMode) document.body.dataset.noteMode = "list";
    renderNotes();
  } else {
    render();
  }
}

function saveMarkdownAsNote() {
  if (!lastMarkdown) return;
  const now = Date.now();
  const note = {
    id: createId(),
    folderId: state.folderFilter,
    body: `${lastMarkdown}`.trimEnd() + "\n",
    createdAt: now,
    updatedAt: now,
  };
  state.notes.unshift(note);
  state.activeNoteId = note.id;
  state.noteQuery = "";
  els.search.value = "";
  saveNotes();
  closePanel();
  setSurface("notes");
  setNoteMode("read");
  renderNotes();
  els.noteEditor.focus();
  showToast("已存为笔记，接着往下写就行");
}

/* -------------------------------------------------------------------- edits */

function snapshot() {
  undoSnapshot = state.items.map((item) => ({ ...item }));
}

function commitEdit(id, value) {
  const text = value.trim();
  const item = state.items.find((entry) => entry.id === id);
  state.editingId = null;

  if (!item) {
    render();
    return;
  }
  if (!text) {
    showToast("内容为空，已保留原来那句");
    render();
    return;
  }
  if (text !== item.text) {
    item.text = text;
    item.updatedAt = Date.now();
    save();
  }
  render();
}

function toggleItem(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  item.done = !item.done;
  item.updatedAt = Date.now();
  save();
  render();
}

function togglePin(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  item.pinned = !item.pinned;
  item.updatedAt = Date.now();
  save();
  render();
}

function deleteItem(id) {
  const index = state.items.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  snapshot();
  const [removed] = state.items.splice(index, 1);
  save();
  render();
  showToast("已删除一条碎片", {
    label: "撤销",
    run: () => {
      state.items.splice(index, 0, removed);
      save();
      render();
    },
  });
}

/* --------------------------------------------------------------------- tidy */

function runTidy() {
  const matching = state.items.filter((item) => !item.done && matchesFilter(item));
  const hasFilter = Boolean(state.tag || state.query.trim());
  const pool = matching.length ? matching : state.items.filter((item) => !item.done);

  if (!pool.length) {
    showToast("先写一条碎片，再整理");
    els.composer.focus();
    return;
  }
  if (hasFilter && !matching.length) {
    showToast("当前筛选没有未处理碎片，已整理全部");
  }

  const result = tidy(pool, new Date());
  lastMarkdown = result.markdown;
  els.panelMarkdown.textContent = result.markdown;

  const summary = [`${result.stats.fragments} 条碎片`, `${result.stats.actions} 个行动项`];
  if (result.stats.questions) summary.push(`${result.stats.questions} 条待确认`);
  if (result.stats.notes) summary.push(`${result.stats.notes} 条原样保留`);
  if (result.stats.dropped) summary.push(`合并重复 ${result.stats.dropped} 条`);
  els.panelSummary.textContent = summary.join(" · ");

  openPanel();
}

function openPanel() {
  focusBeforePanel = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  els.panel.hidden = false;
  els.panel.classList.add("is-open");
  els.panel.setAttribute("aria-hidden", "false");
  els.panelClose.focus();
}

function closePanel() {
  if (els.panel.hidden) return;
  els.panel.classList.remove("is-open");
  els.panel.hidden = true;
  els.panel.setAttribute("aria-hidden", "true");
  if (focusBeforePanel && document.contains(focusBeforePanel)) focusBeforePanel.focus();
  focusBeforePanel = null;
}

async function copyMarkdown() {
  if (!lastMarkdown) return;
  try {
    await navigator.clipboard.writeText(lastMarkdown);
    showToast("清单已复制，粘进笔记就能用");
    return;
  } catch {
    /* Falls through to the textarea trick on non-secure origins. */
  }
  const area = el("textarea", { class: "visually-hidden" });
  area.value = lastMarkdown;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  showToast(ok ? "清单已复制" : "复制失败，可以手动选中文本");
}

function downloadMarkdown() {
  if (!lastMarkdown) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name = `碎片整理-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
  const blob = new Blob([lastMarkdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("已导出 Markdown");
}

function clearDone() {
  const done = state.items.filter((item) => item.done);
  if (!done.length) {
    showToast("还没有已完成的碎片");
    return;
  }
  snapshot();
  state.items = state.items.filter((item) => !item.done);
  save();
  render();
  showToast(`已清空 ${done.length} 条已完成`, {
    label: "撤销",
    run: () => {
      if (!undoSnapshot) return;
      state.items = undoSnapshot;
      undoSnapshot = null;
      save();
      render();
    },
  });
}

/* -------------------------------------------------------------------- toast */

function hideToast() {
  els.toast.classList.remove("is-visible");
}

function showToast(message, action) {
  clearTimeout(toastTimer);
  els.toast.textContent = "";
  els.toast.append(el("span", { text: message }));
  if (action) {
    els.toast.append(
      el("button", {
        class: "toast-action",
        type: "button",
        text: action.label,
        onclick: () => {
          hideToast();
          action.run();
        },
      }),
    );
  }
  els.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(hideToast, action ? 6000 : 2800);
}

/* ---------------------------------------------------------------- composer */

function autosize() {
  const field = els.composer;
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 220)}px`;
}

function submitFragment() {
  const text = els.composer.value.trim();
  if (!text) {
    showToast("写点什么再存");
    els.composer.focus();
    return;
  }
  const now = Date.now();
  const entry = {
    id: createId(),
    text,
    done: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  state.items.unshift(entry);
  els.composer.value = "";
  autosize();
  save();

  // A new fragment must not land out of sight: drop filters that would hide it.
  if (state.status === "done") state.status = "open";
  if (state.tag && !extractTags(text).tags.includes(state.tag)) state.tag = null;
  syncStatusTabs();
  render();

  const open = state.items.filter((item) => !item.done).length;
  showToast(`已存下 · 墙上 ${open} 条未处理`);
}

/* -------------------------------------------------------------------- bind */

function bindEvents() {
  els.composer.addEventListener("input", autosize);
  els.composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitFragment();
    }
  });
  els.save.addEventListener("click", submitFragment);

  els.search.addEventListener("input", () => {
    if (state.surface === "notes") {
      state.noteQuery = els.search.value;
      renderNotes();
      return;
    }
    state.query = els.search.value;
    render();
  });

  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    render();
  });

  for (const tab of els.tabs) {
    tab.addEventListener("click", () => setStatus(tab.dataset.status));
  }

  els.wall.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-act]");
    if (!trigger) return;
    const card = trigger.closest(".card");
    const id = card?.dataset.id;
    if (!id) return;

    switch (trigger.dataset.act) {
      case "toggle":
        toggleItem(id);
        break;
      case "pin":
        togglePin(id);
        break;
      case "edit":
        state.editingId = id;
        render();
        break;
      case "delete":
        deleteItem(id);
        break;
      default:
        break;
    }
  });

  els.tidyButton.addEventListener("click", runTidy);
  els.panelClose.addEventListener("click", closePanel);
  els.panelCopy.addEventListener("click", copyMarkdown);
  els.panelSaveNote.addEventListener("click", saveMarkdownAsNote);
  els.panelDownload.addEventListener("click", downloadMarkdown);
  els.panelClear.addEventListener("click", clearDone);

  for (const button of els.surfaceButtons) {
    button.addEventListener("click", () => setSurface(button.dataset.surface));
  }

  els.newNoteButton.addEventListener("click", createNote);
  els.explorerNewNote.addEventListener("click", createNote);
  els.noteEditor.addEventListener("input", scheduleNoteSave);
  els.noteDelete.addEventListener("click", deleteNote);
  els.noteFolder.addEventListener("change", () => assignFolder(els.noteFolder.value));
  els.noteBack.addEventListener("click", () => {
    flushNoteSave();
    setNoteMode("list");
  });
  for (const button of els.viewButtons) {
    button.addEventListener("click", () => setNoteView(button.dataset.view));
  }

  els.folderAdd.addEventListener("click", () => {
    els.folderForm.hidden = false;
    els.folderName.focus();
  });
  els.folderForm.addEventListener("submit", commitFolder);
  els.folderName.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      els.folderForm.hidden = true;
      els.folderName.value = "";
    }
  });
  els.folderName.addEventListener("blur", () => {
    if (!els.folderName.value.trim()) {
      els.folderForm.hidden = true;
      els.folderName.value = "";
    }
  });

  els.guideClose.addEventListener("click", () => {
    els.guide.hidden = true;
    try {
      localStorage.setItem(GUIDE_KEY, "1");
    } catch {
      /* A blocked storage only costs the dismissal memory. */
    }
  });

  els.emptyFocus.addEventListener("click", () => {
    if (emptyAction === "clear") {
      clearFilters();
      return;
    }
    if (emptyAction === "open") {
      setStatus("open");
      return;
    }
    els.composer.focus();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (state.surface === "wall") runTidy();
      else flushNoteSave();
      return;
    }
    if (event.key === "Escape") {
      if (!els.folderForm.hidden) {
        els.folderForm.hidden = true;
        els.folderName.value = "";
        return;
      }
      if (state.editingId) {
        state.editingId = null;
        render();
      } else {
        closePanel();
      }
      return;
    }

    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable);
    if (typing) return;

    if (event.key === "/") {
      event.preventDefault();
      els.search.focus();
    } else if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (state.surface === "notes") {
        if (activeNote()) els.noteEditor.focus();
        else createNote();
      } else {
        els.composer.focus();
      }
    }
  });
}

/* -------------------------------------------------------------------- boot */

function boot() {
  const loaded = loadItems();
  state.items = loaded.items;
  if (loaded.seeded) save();

  const notebook = loadNotesStore();
  state.folders = notebook.folders;
  state.notes = notebook.notes;
  if (notebook.seeded) saveNotes();

  bindEvents();
  autosize();
  setNoteMode("list");
  setNoteView(state.noteView);
  setSurface("wall");

  try {
    if (!localStorage.getItem(GUIDE_KEY)) els.guide.hidden = false;
  } catch {
    els.guide.hidden = false;
  }
}

boot();
