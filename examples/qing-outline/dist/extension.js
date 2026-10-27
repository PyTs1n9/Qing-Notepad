// src/extension.ts
var VIEW_ID = "qing.outline.toc";
var FOCUS_COMMAND = "qing.outline.focus";
var REFRESH_COMMAND = "qing.outline.refresh";
var EMPTY_ROW_ID = "qing.outline.empty";
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
void refreshOutline(false);
