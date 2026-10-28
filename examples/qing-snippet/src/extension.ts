/**
 * Example plugin: a snippet library.
 *
 * The reason this example exists is coverage. `qing-outline` covers the editor
 * side and `qing-note-wordcount` covers notes; this one is the first that needs
 * four permission surfaces at once — `storage` (the snippets), `views` (the
 * panel), `editor:read`/`editor:write` (insert), `editor:selection` (put the
 * caret where the snippet asked for it).
 *
 * Four things worth reading before copying it:
 *
 * 1. **The panel is the only input surface.** `qing.ui` has `toast` and nothing
 *    else — no prompt, no dialog. So a snippet is *named* after the first line
 *    of the text it was made from, and a group can only be chosen by clicking
 *    the group row first (its `command` arrives here as `itemId`).
 * 2. **One scan replaces every placeholder.** `renderBody` walks the body once
 *    with a global regex and accumulates the output length, which is how it
 *    knows the caret offset without a second pass or any bookkeeping about
 *    earlier substitutions changing the indices.
 * 3. **Writes go through `editor.replace`**, so autosave, dirty tracking and
 *    Ctrl+Z treat an insertion exactly like typing. Nothing here touches
 *    `storage` on behalf of a note.
 * 4. **Deletion is undoable, not confirmed.** There is no way to ask "are you
 *    sure", so the whole table is snapshotted into a `trash` key first.
 *
 * Positions are CodeMirror document offsets and the text is Markdown source —
 * see `src/qing.d.ts`.
 */

const VIEW_ID = "qing.snippet.panel";

const INSERT_COMMAND = "qing.snippet.insert";
const NEW_COMMAND = "qing.snippet.new";
const DELETE_COMMAND = "qing.snippet.delete";
const RESTORE_COMMAND = "qing.snippet.restore";
const EXPORT_COMMAND = "qing.snippet.export";
const IMPORT_COMMAND = "qing.snippet.import";

const SNIPPETS_KEY = "snippets";
const TRASH_KEY = "trash";
const SEEDED_KEY = "seeded";

/** Row id namespaces. `g:` a group, `s:` one snippet. */
const GROUP_PREFIX = "g:";
const SNIPPET_PREFIX = "s:";

const UNGROUPED = "未分组";
/** Order groups appear in the panel; anything else sorts between these and `UNGROUPED`. */
const BUILTIN_GROUPS = ["写作", "会议", "待办"];

const MAX_BODY = 20_000;
const MAX_NAME = 30;
const MAX_ITEMS = 500;
const MAX_EXPORT = 200_000;
/** `storage` is 1 MB in total; stop well short so the host never has to refuse a write. */
const MAX_STORE_KB = 800;

interface Snippet {
  id: string;
  group: string;
  name: string;
  body: string;
}

/** What `renderBody` produces: the text plus where the caret should land. */
interface RenderedBody {
  text: string;
  /** Offset of `${cursor}` inside `text`, or `null` when the body has none. */
  caret: number | null;
}

const SEED_SNIPPETS: ReadonlyArray<Omit<Snippet, "id">> = [
  { group: "写作", name: "日期小标题", body: "## ${date}\n\n${cursor}" },
  {
    group: "会议",
    name: "会议纪要",
    body: "### ${date} ${time} 会议\n\n- 议题：\n- 结论：\n- 待办：\n\n${cursor}",
  },
  { group: "待办", name: "任务清单骨架", body: "- [ ] ${cursor}\n- [ ] \n- [ ] " },
];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * `storage.get` hands back whatever was written, and a hand-edited or
 * half-written value must not take the whole panel down. Every entry is
 * re-validated on the way out, and a bad one is dropped rather than thrown.
 */
function toSnippet(entry: unknown): Snippet | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;

  const body = typeof record.body === "string" ? record.body : "";
  // An empty or oversized body is a broken record, not a snippet: inserting
  // nothing is worse than the row not being there.
  if (body.length === 0 || body.length > MAX_BODY) return null;

  const rawName = typeof record.name === "string" ? record.name.trim() : "";
  const rawGroup = typeof record.group === "string" ? record.group.trim() : "";
  const rawId = typeof record.id === "string" ? record.id : "";

  return {
    id: rawId.length > 0 ? rawId : newId(),
    group: rawGroup.length > 0 ? rawGroup.slice(0, 24) : UNGROUPED,
    name: rawName.length > 0 ? rawName.slice(0, MAX_NAME) : "未命名片段",
    body,
  };
}

function parseList(raw: unknown): Snippet[] {
  // Stored as a JSON string so the byte budget below is measurable; a real
  // array is accepted too, in case an earlier version wrote one.
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: Snippet[] = [];
  for (const entry of list) {
    const snippet = toSnippet(entry);
    if (snippet) out.push(snippet);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

async function loadSnippets(): Promise<Snippet[]> {
  return parseList(await qing.storage.get(SNIPPETS_KEY));
}

/**
 * UTF-8 length without `TextEncoder`: the worker has no DOM lib in its type
 * surface, and an approximation would hide the one thing this guards against.
 */
function approxBytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one code point, four bytes — skip the low half.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Write the whole table back. `true` means the caller may now refresh the
 * panel; every failure has already been reported, because a caller that
 * toasted again would double up on the reason.
 */
async function persist(items: Snippet[]): Promise<boolean> {
  const json = JSON.stringify(items);
  const bytes = approxBytes(json);
  if (bytes > MAX_STORE_KB * 1024) {
    qing.ui.toast(
      `片段总量约 ${Math.round(bytes / 1024)} KB，超过 ${MAX_STORE_KB} KB 上限，请先删掉一些`,
      "danger",
    );
    return false;
  }
  try {
    await qing.storage.set(SNIPPETS_KEY, json);
  } catch (error) {
    qing.ui.toast(errorText(error), "danger");
    return false;
  }
  return true;
}

let ready: Promise<void> | null = null;

/** Load-once initialisation: seeding must not run twice, and must not lose a race. */
function ensureReady(): Promise<void> {
  if (!ready) {
    ready = seedOnce().catch((error) => {
      // Let the next call retry instead of caching a failure forever.
      ready = null;
      throw error;
    });
  }
  return ready;
}

/**
 * Seed once, ever.
 *
 * The marker is deliberately separate from the data: seeding "when the array is
 * empty" would resurrect the examples every time the user deleted the last
 * snippet, which reads as a bug.
 */
async function seedOnce(): Promise<void> {
  const marker = await qing.storage.get(SEEDED_KEY);
  if (marker) return;
  const existing = await loadSnippets();
  if (existing.length === 0) {
    const seeded = SEED_SNIPPETS.map((seed) => ({ id: newId(), ...seed }));
    await qing.storage.set(SNIPPETS_KEY, JSON.stringify(seeded));
  }
  await qing.storage.set(SEEDED_KEY, "1");
}

let idCounter = 0;

function newId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Replace `${date}` / `${time}` / `${cursor}` / `${selection}` in one pass.
 *
 * One pass, not four `String.replace` calls, because the caret offset has to be
 * measured in the *output*: doing it afterwards would mean knowing how much
 * every earlier substitution shifted the text. Accumulating `out.length` as the
 * pieces are appended makes the offsets exact by construction.
 *
 * An unknown `${…}` is left as literal text on purpose — a user who typed
 * `${title}` should see that it was not expanded, rather than silently get
 * nothing. (`${title}` cannot work: `apiVersion: 1` has no "which note is
 * open" call, so there is no title to inject.)
 */
function renderBody(body: string, selectionText: string): RenderedBody {
  const now = new Date();
  let out = "";
  let last = 0;
  let caret: number | null = null;

  const token = /\$\{(date|time|selection|cursor)\}/g;
  let match: RegExpExecArray | null = token.exec(body);
  while (match !== null) {
    out += body.slice(last, match.index);
    last = match.index + match[0].length;
    switch (match[1]) {
      case "date":
        out += formatDate(now);
        break;
      case "time":
        out += formatTime(now);
        break;
      case "selection":
        // With nothing selected the token collapses to nothing — this is how a
        // wrapper snippet degrades into a plain insertion.
        out += selectionText;
        break;
      case "cursor":
        // First one wins; the rest are dropped so a body cannot have two carets.
        if (caret === null) caret = out.length;
        break;
    }
    match = token.exec(body);
  }
  out += body.slice(last);

  return { text: out, caret };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function groupRank(group: string): number {
  if (group === UNGROUPED) return 900;
  const index = BUILTIN_GROUPS.indexOf(group);
  return index >= 0 ? index : 500;
}

function compareGroups(left: string, right: string): number {
  const delta = groupRank(left) - groupRank(right);
  return delta !== 0 ? delta : left.localeCompare(right, "zh");
}

/** One line of the body, markdown noise stripped, for the row's second column. */
function preview(body: string): string {
  const line = body
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "";
  const plain = line.replace(/^#{1,6}\s+/, "").replace(/^>\s*/, "").trim();
  return plain.length > 20 ? `${plain.slice(0, 20)}…` : plain;
}

function snippetRow(snippet: Snippet): QingTreeItem {
  return {
    id: `${SNIPPET_PREFIX}${snippet.id}`,
    label: snippet.name,
    description: preview(snippet.body),
    command: INSERT_COMMAND,
    // A leaf: no chevron to offer, so none is promised.
    collapsibleState: "none",
  };
}

function groupRows(items: Snippet[]): QingTreeItem[] {
  const groups = [...new Set(items.map((item) => item.group))];
  if (groups.length === 0) {
    return [
      {
        id: "empty",
        label: `（还没有片段，选中一段文字后执行「把选中文字存为片段」）`,
        collapsibleState: "none",
      },
    ];
  }
  groups.sort(compareGroups);
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  return groups.map((group) => ({
    id: `${GROUP_PREFIX}${encodeURIComponent(group)}`,
    label: group,
    description: `${counts.get(group) ?? 0} 条`,
    // Clicking the label creates a snippet *in this group*; the chevron still
    // expands. This is the only way to choose a group without an input box.
    command: NEW_COMMAND,
    collapsibleState: "expanded",
  }));
}

qing.views.registerTreeDataProvider(VIEW_ID, {
  getChildren: async (elementId?: string) => {
    try {
      await ensureReady();
      const items = await loadSnippets();
      if (!elementId) return groupRows(items);
      const group = groupFromRowId(elementId);
      if (group === null) return [];
      return items.filter((item) => item.group === group).map(snippetRow);
    } catch (error) {
      // An empty panel with a log line beats an unhandled rejection: the host
      // has nowhere to show one.
      qing.log("读取片段失败", errorText(error));
      return [];
    }
  },
});

async function refreshPanel(): Promise<void> {
  try {
    await qing.views.refresh(VIEW_ID);
  } catch {
    // Nothing to do: the panel is simply not on screen.
  }
}

function groupFromRowId(rowId: string | undefined): string | null {
  if (!rowId || !rowId.startsWith(GROUP_PREFIX)) return null;
  try {
    return decodeURIComponent(rowId.slice(GROUP_PREFIX.length));
  } catch {
    return null;
  }
}

function snippetIdFromRowId(rowId: string | undefined): string | null {
  if (!rowId || !rowId.startsWith(SNIPPET_PREFIX)) return null;
  const id = rowId.slice(SNIPPET_PREFIX.length);
  return id.length > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** The bridge throws `PluginError`; its `code` is what callers should branch on. */
function isNoEditor(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    if ((error as { code?: unknown }).code === "E_NO_EDITOR") return true;
  }
  return /E_NO_EDITOR/.test(errorText(error));
}

function noEditorToast(): void {
  qing.ui.toast("请先打开一篇笔记，片段要插到光标处", "info");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function readSelection(): Promise<QingSelection | null> {
  try {
    return await qing.editor.getSelection();
  } catch (error) {
    if (isNoEditor(error)) noEditorToast();
    else qing.ui.toast(errorText(error), "danger");
    return null;
  }
}

async function insertSnippet(snippet: Snippet): Promise<void> {
  const selection = await readSelection();
  if (!selection) return;

  const rendered = renderBody(snippet.body, selection.text);
  const base = selection.from;
  try {
    // One transaction, so undo takes the insertion back in one step.
    await qing.editor.replace({ from: selection.from, to: selection.to }, rendered.text);
  } catch (error) {
    qing.ui.toast(errorText(error), "danger");
    return;
  }

  // Caret placement is a courtesy: the text is already on disk, so a failure
  // here is not worth interrupting the user over. With no `${cursor}` the caret
  // goes to the end of what was inserted — the VS Code snippet convention, and
  // the only outcome that is the same for every body.
  const caret = rendered.caret ?? rendered.text.length;
  try {
    await qing.editor.setSelection({ anchor: base + caret, head: base + caret });
  } catch {
    // Ignored on purpose — see above.
  }

  qing.ui.toast(`已插入「${snippet.name}」`, "success");
}

qing.commands.register(INSERT_COMMAND, async (itemId?: string) => {
  await ensureReady();
  const id = snippetIdFromRowId(itemId);
  if (!id) {
    qing.ui.toast("请在「片段」面板里点一条片段", "info");
    return;
  }
  const snippet = (await loadSnippets()).find((entry) => entry.id === id);
  if (!snippet) {
    qing.ui.toast("这条片段已经不在了，正在刷新面板", "info");
    await refreshPanel();
    return;
  }
  await insertSnippet(snippet);
});

/** First meaningful line of the selection, stripped of block markers. */
function deriveName(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const plain = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/[*_`]/g, "")
    .trim();
  if (plain.length === 0) return "未命名片段";
  return plain.length > MAX_NAME ? `${plain.slice(0, MAX_NAME)}…` : plain;
}

qing.commands.register(NEW_COMMAND, async (itemId?: string) => {
  await ensureReady();
  const group = groupFromRowId(itemId) ?? UNGROUPED;

  const selection = await readSelection();
  if (!selection) return;
  if (selection.from === selection.to) {
    qing.ui.toast(
      group === UNGROUPED
        ? "请先选中要存成片段的文字"
        : `请先选中要存进「${group}」的文字`,
      "info",
    );
    return;
  }
  if (selection.text.length > MAX_BODY) {
    qing.ui.toast(`选中的内容有 ${selection.text.length} 字符，超过 ${MAX_BODY} 上限`, "danger");
    return;
  }

  const items = await loadSnippets();
  if (items.length >= MAX_ITEMS) {
    qing.ui.toast(`已经有 ${MAX_ITEMS} 条片段了，请先删掉一些`, "danger");
    return;
  }

  const name = deriveName(selection.text);
  items.push({ id: newId(), group, name, body: selection.text });
  if (!(await persist(items))) return;
  await refreshPanel();
  qing.ui.toast(`已存为片段「${name}」`, "success");
});

qing.commands.register(DELETE_COMMAND, async (itemId?: string) => {
  await ensureReady();
  const id = snippetIdFromRowId(itemId);
  if (!id) {
    qing.ui.toast("请在「片段」面板里点一条片段，再执行删除", "info");
    return;
  }
  const items = await loadSnippets();
  const target = items.find((entry) => entry.id === id);
  if (!target) {
    qing.ui.toast("这条片段已经不在了，正在刷新面板", "info");
    await refreshPanel();
    return;
  }

  // Snapshot before removing: there is no confirm dialog to fall back on.
  try {
    await qing.storage.set(TRASH_KEY, JSON.stringify({ at: Date.now(), items }));
  } catch (error) {
    qing.ui.toast(`无法备份，已取消删除：${errorText(error)}`, "danger");
    return;
  }

  if (!(await persist(items.filter((entry) => entry.id !== id)))) return;
  await refreshPanel();
  qing.ui.toast(`已删除「${target.name}」，可用「恢复上次删除的片段」找回`, "success");
});

qing.commands.register(RESTORE_COMMAND, async () => {
  await ensureReady();
  const raw = await qing.storage.get(TRASH_KEY);
  let snapshot: unknown = raw;
  if (typeof raw === "string") {
    try {
      snapshot = JSON.parse(raw);
    } catch {
      snapshot = null;
    }
  }
  const record = snapshot as { items?: unknown } | null;
  const restored = parseList(record?.items);
  if (restored.length === 0) {
    qing.ui.toast("没有可恢复的片段", "info");
    return;
  }
  if (!(await persist(restored))) return;
  // One level of undo only: keeping the snapshot would let a second restore
  // silently rewind work done after the first one.
  await qing.storage.delete(TRASH_KEY);
  await refreshPanel();
  qing.ui.toast(`已恢复 ${restored.length} 条片段`, "success");
});

qing.commands.register(EXPORT_COMMAND, async () => {
  await ensureReady();
  const items = await loadSnippets();
  if (items.length === 0) {
    qing.ui.toast("还没有片段可导出", "info");
    return;
  }
  // Fenced so the block is inert in the note, and so import can find it.
  const payload = "```json\n" + JSON.stringify(items, null, 2) + "\n```\n";
  if (payload.length > MAX_EXPORT) {
    qing.ui.toast(
      `导出内容 ${payload.length} 字符，超过 ${MAX_EXPORT} 上限，请先删掉一些片段`,
      "danger",
    );
    return;
  }

  const selection = await readSelection();
  if (!selection) return;
  try {
    await qing.editor.replace({ from: selection.from, to: selection.to }, payload);
  } catch (error) {
    qing.ui.toast(errorText(error), "danger");
    return;
  }
  qing.ui.toast(`已导出 ${items.length} 条片段到光标处，记得保存`, "success");
});

function parseImport(raw: string): Snippet[] | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(raw);
  const payload = (fenced ? fenced[1] : raw).trim();
  if (payload.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Snippet[] = [];
  for (const entry of parsed) {
    const snippet = toSnippet(entry);
    // Keep the imported ids: they are what makes re-importing the same file a
    // no-op instead of a source of duplicates.
    if (snippet) out.push(snippet);
  }
  return out;
}

qing.commands.register(IMPORT_COMMAND, async () => {
  await ensureReady();
  const selection = await readSelection();
  if (!selection) return;
  if (selection.text.trim().length === 0) {
    qing.ui.toast("请先选中要导入的片段 JSON", "info");
    return;
  }

  const incoming = parseImport(selection.text);
  if (!incoming) {
    qing.ui.toast("选中的内容不是片段 JSON", "danger");
    return;
  }

  const items = await loadSnippets();
  const known = new Set(items.map((entry) => entry.id));
  let added = 0;
  let skipped = 0;
  for (const candidate of incoming) {
    if (known.has(candidate.id) || items.length >= MAX_ITEMS) {
      skipped += 1;
      continue;
    }
    items.push(candidate);
    known.add(candidate.id);
    added += 1;
  }

  if (added === 0) {
    qing.ui.toast(`没有新片段可导入（跳过 ${skipped} 条）`, "info");
    return;
  }
  if (!(await persist(items))) return;
  await refreshPanel();
  qing.ui.toast(`已导入 ${added} 条片段${skipped > 0 ? `，跳过 ${skipped} 条` : ""}`, "success");
});

// Registration is synchronous and local, so the panel's first render is what
// starts this worker; nothing here needs an `onStartup` activation event.
