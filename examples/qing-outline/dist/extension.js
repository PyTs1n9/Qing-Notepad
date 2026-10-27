// src/extension.ts
var VIEW_ID = "qing.outline.toc";
var FOCUS_COMMAND = "qing.outline.focus";
var REFRESH_COMMAND = "qing.outline.refresh";
var BOLD_COMMAND = "qing.outline.bold";
var MARK_COMMAND = "qing.outline.mark-duplicates";
var EMPTY_ROW_ID = "qing.outline.empty";
var DUP_KEY = "dup";
var roots = [];
var byId = /* @__PURE__ */ new Map();
function buildOutline(text) {
  const nextRoots = [];
  const stack = [];
  byId.clear();
  let fence = null;
  let offset = 0;
  let index = 0;
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      offset += line.length + 1;
      continue;
    }
    if (!fence) {
      const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        const label = heading[2].replace(/\s+#+\s*$/, "").trim() || "（无标题）";
        while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
        const node = {
          id: `h${index}`,
          label,
          level,
          offset,
          children: []
        };
        index += 1;
        byId.set(node.id, node);
        if (stack.length > 0) stack[stack.length - 1].children.push(node);
        else nextRoots.push(node);
        stack.push(node);
      }
    }
    offset += line.length + 1;
  }
  return nextRoots;
}
function toItem(node) {
  return {
    id: node.id,
    label: node.label,
    // The host only draws an opener where one is promised, so a flat outline
    // looks like a flat list instead of a file picker with dead chevrons.
    collapsibleState: node.children.length > 0 ? "expanded" : "none",
    command: FOCUS_COMMAND
  };
}
async function refreshOutline(announce) {
  try {
    roots = buildOutline(await qing.editor.getText());
  } catch (error) {
    roots = [];
    byId.clear();
    if (announce) {
      qing.ui.toast(
        error instanceof Error ? error.message : "读取当前笔记失败",
        "danger"
      );
    }
    return;
  }
  if (announce) await qing.views.refresh(VIEW_ID);
}
qing.views.registerTreeDataProvider(VIEW_ID, {
  getChildren: async (elementId) => {
    if (roots.length === 0 && byId.size === 0) await refreshOutline(false);
    if (!elementId) {
      if (roots.length === 0) {
        return [
          {
            id: EMPTY_ROW_ID,
            label: "（这篇没有标题）",
            collapsibleState: "none"
          }
        ];
      }
      return roots.map(toItem);
    }
    const node = byId.get(elementId);
    return node ? node.children.map(toItem) : [];
  }
});
qing.commands.register(FOCUS_COMMAND, async (itemId) => {
  if (!itemId || !byId.has(itemId)) {
    qing.ui.toast("请在侧栏的大纲面板里点一个标题", "info");
    return;
  }
  await refreshOutline(false);
  const node = byId.get(itemId);
  if (!node) {
    qing.ui.toast("标题已经变了，正在刷新大纲", "info");
    await qing.views.refresh(VIEW_ID);
    return;
  }
  try {
    await qing.editor.setSelection({ anchor: node.offset, head: node.offset });
  } catch (error) {
    qing.ui.toast(error instanceof Error ? error.message : "移动光标失败", "danger");
  }
});
qing.commands.register(REFRESH_COMMAND, async () => {
  await refreshOutline(true);
  if (roots.length === 0) qing.ui.toast("（这篇没有标题）", "info");
});
qing.commands.register(BOLD_COMMAND, async () => {
  const selection = await qing.editor.getSelection();
  if (selection.from === selection.to) {
    qing.ui.toast("请先选中要加粗的文字", "info");
    return;
  }
  const text = selection.text;
  const alreadyBold = text.startsWith("**") && text.endsWith("**") && text.length >= 5;
  const next = alreadyBold ? text.slice(2, -2) : `**${text}**`;
  try {
    await qing.editor.replace({ from: selection.from, to: selection.to }, next);
    qing.ui.toast(alreadyBold ? "已取消加粗" : "已加粗", "success");
  } catch (error) {
    qing.ui.toast(error instanceof Error ? error.message : "替换失败", "danger");
  }
});
var marksActive = false;
var WORD = /[A-Za-z0-9]+/g;
qing.commands.register(MARK_COMMAND, async () => {
  if (marksActive) {
    await qing.editor.setDecorations(DUP_KEY, []);
    marksActive = false;
    qing.ui.toast("已清除标记", "info");
    return;
  }
  let text;
  try {
    text = await qing.editor.getText();
  } catch (error) {
    qing.ui.toast(error instanceof Error ? error.message : "读取当前笔记失败", "danger");
    return;
  }
  const totals = /* @__PURE__ */ new Map();
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (word.length < 3) continue;
    const key = word.toLowerCase();
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const ranges = [];
  const seen = /* @__PURE__ */ new Map();
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (word.length < 3) continue;
    const key = word.toLowerCase();
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    if (nth < 2 || (totals.get(key) ?? 0) < 2) continue;
    const from = match.index ?? 0;
    ranges.push({ from, to: from + word.length, kind: "warning" });
  }
  await qing.editor.setDecorations(DUP_KEY, ranges);
  marksActive = ranges.length > 0;
  qing.ui.toast(
    ranges.length > 0 ? `标记了 ${ranges.length} 处重复词` : "没有重复词",
    ranges.length > 0 ? "success" : "info"
  );
});
void refreshOutline(false);
