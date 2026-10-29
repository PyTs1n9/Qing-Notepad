// src/extension.ts
var VIEW_ID = "qing.snippet.panel";
var INSERT_COMMAND = "qing.snippet.insert";
var NEW_COMMAND = "qing.snippet.new";
var DELETE_COMMAND = "qing.snippet.delete";
var RESTORE_COMMAND = "qing.snippet.restore";
var EXPORT_COMMAND = "qing.snippet.export";
var IMPORT_COMMAND = "qing.snippet.import";
var SNIPPETS_KEY = "snippets";
var TRASH_KEY = "trash";
var SEEDED_KEY = "seeded";
var GROUP_PREFIX = "g:";
var SNIPPET_PREFIX = "s:";
var UNGROUPED = "未分组";
var BUILTIN_GROUPS = ["写作", "会议", "待办"];
var MAX_BODY = 2e4;
var MAX_NAME = 30;
var MAX_ITEMS = 500;
var MAX_EXPORT = 2e5;
var MAX_STORE_KB = 800;
var SEED_SNIPPETS = [
  { group: "写作", name: "日期小标题", body: "## ${date}\n\n${cursor}" },
  {
    group: "会议",
    name: "会议纪要",
    body: "### ${date} ${time} 会议\n\n- 议题：\n- 结论：\n- 待办：\n\n${cursor}"
  },
  { group: "待办", name: "任务清单骨架", body: "- [ ] ${cursor}\n- [ ] \n- [ ] " }
];
function toSnippet(entry) {
  if (!entry || typeof entry !== "object") return null;
  const record = entry;
  const body = typeof record.body === "string" ? record.body : "";
  if (body.length === 0 || body.length > MAX_BODY) return null;
  const rawName = typeof record.name === "string" ? record.name.trim() : "";
  const rawGroup = typeof record.group === "string" ? record.group.trim() : "";
  const rawId = typeof record.id === "string" ? record.id : "";
  return {
    id: rawId.length > 0 ? rawId : newId(),
    group: rawGroup.length > 0 ? rawGroup.slice(0, 24) : UNGROUPED,
    name: rawName.length > 0 ? rawName.slice(0, MAX_NAME) : "未命名片段",
    body
  };
}
function parseList(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const snippet = toSnippet(entry);
    if (snippet) out.push(snippet);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}
async function loadSnippets() {
  return parseList(await qing.storage.get(SNIPPETS_KEY));
}
function approxBytes(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (code >= 55296 && code <= 56319) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
async function persist(items) {
  const json = JSON.stringify(items);
  const bytes = approxBytes(json);
  if (bytes > MAX_STORE_KB * 1024) {
    qing.ui.toast(
      `片段总量约 ${Math.round(bytes / 1024)} KB，超过 ${MAX_STORE_KB} KB 上限，请先删掉一些`,
      "danger"
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
var ready = null;
function ensureReady() {
  if (!ready) {
    ready = seedOnce().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}
async function seedOnce() {
  const marker = await qing.storage.get(SEEDED_KEY);
  if (marker) return;
  const existing = await loadSnippets();
  if (existing.length === 0) {
    const seeded = SEED_SNIPPETS.map((seed) => ({ id: newId(), ...seed }));
    await qing.storage.set(SNIPPETS_KEY, JSON.stringify(seeded));
  }
  await qing.storage.set(SEEDED_KEY, "1");
}
var idCounter = 0;
function newId() {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}
function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function renderBody(body, selectionText) {
  const now = /* @__PURE__ */ new Date();
  let out = "";
  let last = 0;
  let caret = null;
  const token = /\$\{(date|time|selection|cursor)\}/g;
  let match = token.exec(body);
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
        out += selectionText;
        break;
      case "cursor":
        if (caret === null) caret = out.length;
        break;
    }
    match = token.exec(body);
  }
  out += body.slice(last);
  return { text: out, caret };
}
function groupRank(group) {
  if (group === UNGROUPED) return 900;
  const index = BUILTIN_GROUPS.indexOf(group);
  return index >= 0 ? index : 500;
}
function compareGroups(left, right) {
  const delta = groupRank(left) - groupRank(right);
  return delta !== 0 ? delta : left.localeCompare(right, "zh");
}
function preview(body) {
  const line = body.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return "";
  const plain = line.replace(/^#{1,6}\s+/, "").replace(/^>\s*/, "").trim();
  return plain.length > 20 ? `${plain.slice(0, 20)}…` : plain;
}
function snippetRow(snippet) {
  return {
    id: `${SNIPPET_PREFIX}${snippet.id}`,
    label: snippet.name,
    description: preview(snippet.body),
    command: INSERT_COMMAND,
    // A leaf: no chevron to offer, so none is promised.
    collapsibleState: "none"
  };
}
function groupRows(items) {
  const groups = [...new Set(items.map((item) => item.group))];
  if (groups.length === 0) {
    return [
      {
        id: "empty",
        label: `（还没有片段，选中一段文字后执行「把选中文字存为片段」）`,
        collapsibleState: "none"
      }
    ];
  }
  groups.sort(compareGroups);
  const counts = /* @__PURE__ */ new Map();
  for (const item of items) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  return groups.map((group) => ({
    id: `${GROUP_PREFIX}${encodeURIComponent(group)}`,
    label: group,
    description: `${counts.get(group) ?? 0} 条`,
    // Clicking the label creates a snippet *in this group*; the chevron still
    // expands. This is the only way to choose a group without an input box.
    command: NEW_COMMAND,
    collapsibleState: "expanded"
  }));
}
qing.views.registerTreeDataProvider(VIEW_ID, {
  getChildren: async (elementId) => {
    try {
      await ensureReady();
      const items = await loadSnippets();
      if (!elementId) return groupRows(items);
      const group = groupFromRowId(elementId);
      if (group === null) return [];
      return items.filter((item) => item.group === group).map(snippetRow);
    } catch (error) {
      qing.log("读取片段失败", errorText(error));
      return [];
    }
  }
});
async function refreshPanel() {
  try {
    await qing.views.refresh(VIEW_ID);
  } catch {
  }
}
function groupFromRowId(rowId) {
  if (!rowId || !rowId.startsWith(GROUP_PREFIX)) return null;
  try {
    return decodeURIComponent(rowId.slice(GROUP_PREFIX.length));
  } catch {
    return null;
  }
}
function snippetIdFromRowId(rowId) {
  if (!rowId || !rowId.startsWith(SNIPPET_PREFIX)) return null;
  const id = rowId.slice(SNIPPET_PREFIX.length);
  return id.length > 0 ? id : null;
}
function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
function isNoEditor(error) {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "E_NO_EDITOR") return true;
  }
  return /E_NO_EDITOR/.test(errorText(error));
}
function noEditorToast() {
  qing.ui.toast("请先打开一篇笔记，片段要插到光标处", "info");
}
async function readSelection() {
  try {
    return await qing.editor.getSelection();
  } catch (error) {
    if (isNoEditor(error)) noEditorToast();
    else qing.ui.toast(errorText(error), "danger");
    return null;
  }
}
async function insertSnippet(snippet) {
  const selection = await readSelection();
  if (!selection) return;
  const rendered = renderBody(snippet.body, selection.text);
  const base = selection.from;
  try {
    await qing.editor.replace({ from: selection.from, to: selection.to }, rendered.text);
  } catch (error) {
    qing.ui.toast(errorText(error), "danger");
    return;
  }
  const caret = rendered.caret ?? rendered.text.length;
  try {
    await qing.editor.setSelection({ anchor: base + caret, head: base + caret });
  } catch {
  }
  qing.ui.toast(`已插入「${snippet.name}」`, "success");
}
qing.commands.register(INSERT_COMMAND, async (itemId) => {
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
function deriveName(text) {
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const plain = firstLine.replace(/^#{1,6}\s+/, "").replace(/^>\s*/, "").replace(/^[-*+]\s+\[[ xX]\]\s+/, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/[*_`]/g, "").trim();
  if (plain.length === 0) return "未命名片段";
  return plain.length > MAX_NAME ? `${plain.slice(0, MAX_NAME)}…` : plain;
}
qing.commands.register(NEW_COMMAND, async (itemId) => {
  await ensureReady();
  const group = groupFromRowId(itemId) ?? UNGROUPED;
  const selection = await readSelection();
  if (!selection) return;
  if (selection.from === selection.to) {
    qing.ui.toast(
      group === UNGROUPED ? "请先选中要存成片段的文字" : `请先选中要存进「${group}」的文字`,
      "info"
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
  if (!await persist(items)) return;
  await refreshPanel();
  qing.ui.toast(`已存为片段「${name}」`, "success");
});
qing.commands.register(DELETE_COMMAND, async (itemId) => {
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
  try {
    await qing.storage.set(TRASH_KEY, JSON.stringify({ at: Date.now(), items }));
  } catch (error) {
    qing.ui.toast(`无法备份，已取消删除：${errorText(error)}`, "danger");
    return;
  }
  if (!await persist(items.filter((entry) => entry.id !== id))) return;
  await refreshPanel();
  qing.ui.toast(`已删除「${target.name}」，可用「恢复上次删除的片段」找回`, "success");
});
qing.commands.register(RESTORE_COMMAND, async () => {
  await ensureReady();
  const raw = await qing.storage.get(TRASH_KEY);
  let snapshot = raw;
  if (typeof raw === "string") {
    try {
      snapshot = JSON.parse(raw);
    } catch {
      snapshot = null;
    }
  }
  const record = snapshot;
  const restored = parseList(record?.items);
  if (restored.length === 0) {
    qing.ui.toast("没有可恢复的片段", "info");
    return;
  }
  if (!await persist(restored)) return;
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
  const payload = "```json\n" + JSON.stringify(items, null, 2) + "\n```\n";
  if (payload.length > MAX_EXPORT) {
    qing.ui.toast(
      `导出内容 ${payload.length} 字符，超过 ${MAX_EXPORT} 上限，请先删掉一些片段`,
      "danger"
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
function parseImport(raw) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(raw);
  const payload = (fenced ? fenced[1] : raw).trim();
  if (payload.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = [];
  for (const entry of parsed) {
    const snippet = toSnippet(entry);
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
  if (!await persist(items)) return;
  await refreshPanel();
  qing.ui.toast(`已导入 ${added} 条片段${skipped > 0 ? `，跳过 ${skipped} 条` : ""}`, "success");
});
