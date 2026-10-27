/**
 * Example plugin: an outline of the note you have open.
 *
 * It is the reference for the two P1a-2 surfaces at once:
 *
 * - `qing.views` — a declarative panel in the note sidebar, built from the
 *   document's Markdown headings;
 * - `qing.editor.setSelection` — clicking a row moves the caret to that
 *   heading's line start.
 *
 * Two things worth copying:
 *
 * 1. **One command serves the whole tree.** Rows all carry the same
 *    `command: "qing.outline.focus"`; the host passes the clicked item's id to
 *    the handler, so the manifest lists one command instead of one per heading.
 *    Running the same command from the palette arrives with no id — that is
 *    what the "please click a row" toast is for.
 * 2. **`qing.views.refresh` is how the panel says "my data changed".** The host
 *    re-fetches the root when the open note changes on its own; the refresh
 *    command covers the other case (the user edited the headings in place).
 *
 * Positions are CodeMirror document offsets and the text is Markdown source —
 * see `src/qing.d.ts` for the two paragraphs that matter.
 */

const VIEW_ID = "qing.outline.toc";
const FOCUS_COMMAND = "qing.outline.focus";
const REFRESH_COMMAND = "qing.outline.refresh";
const BOLD_COMMAND = "qing.outline.bold";
const MARK_COMMAND = "qing.outline.mark-duplicates";
/** A row with no command, used when there is nothing to show. */
const EMPTY_ROW_ID = "qing.outline.empty";
/** Decoration bucket: one key so a re-run replaces the previous marks. */
const DUP_KEY = "dup";

interface OutlineNode {
  id: string;
  label: string;
  level: number;
  /** Line start offset in the Markdown source — where the caret goes. */
  offset: number;
  children: OutlineNode[];
}

let roots: OutlineNode[] = [];
const byId = new Map<string, OutlineNode>();

/**
 * Build the outline from the document text.
 *
 * ATX headings only (`#` … `######`, followed by a space), which is what the
 * spec asked for; lines inside a fenced code block are ignored so a `#` in a
 * code sample does not invent a section. Ids are `h0`, `h1`, … in document
 * order, which is also how `getChildren` addresses a level.
 */
function buildOutline(text: string): OutlineNode[] {
  const nextRoots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  byId.clear();

  let fence: string | null = null;
  let offset = 0;
  let index = 0;
  for (const line of text.split("\n")) {
    // ```` ``` ```` or `~~~` open and close a fence; the marker has to match.
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
        // `## Title ##` closes its own hashes; they are not part of the title.
        const label = heading[2].replace(/\s+#+\s*$/, "").trim() || "（无标题）";
        while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
        const node: OutlineNode = {
          id: `h${index}`,
          label,
          level,
          offset,
          children: [],
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

function toItem(node: OutlineNode) {
  return {
    id: node.id,
    label: node.label,
    // The host only draws an opener where one is promised, so a flat outline
    // looks like a flat list instead of a file picker with dead chevrons.
    collapsibleState: node.children.length > 0 ? ("expanded" as const) : ("none" as const),
    command: FOCUS_COMMAND,
  };
}

/** Rebuild from the live document; `true` also tells the panel to re-fetch. */
async function refreshOutline(announce: boolean): Promise<void> {
  try {
    roots = buildOutline(await qing.editor.getText());
  } catch (error) {
    // `E_NO_EDITOR` is the normal state on the todo page: an empty panel with a
    // reason beats an error toast the user did not ask for.
    roots = [];
    byId.clear();
    if (announce) {
      qing.ui.toast(
        error instanceof Error ? error.message : "读取当前笔记失败",
        "danger",
      );
    }
    return;
  }
  if (announce) await qing.views.refresh(VIEW_ID);
}

qing.views.registerTreeDataProvider(VIEW_ID, {
  getChildren: async (elementId?: string) => {
    if (roots.length === 0 && byId.size === 0) await refreshOutline(false);
    if (!elementId) {
      if (roots.length === 0) {
        return [
          {
            id: EMPTY_ROW_ID,
            label: "（这篇没有标题）",
            collapsibleState: "none" as const,
          },
        ];
      }
      return roots.map(toItem);
    }
    const node = byId.get(elementId);
    return node ? node.children.map(toItem) : [];
  },
});

qing.commands.register(FOCUS_COMMAND, async (itemId?: string) => {
  if (!itemId || !byId.has(itemId)) {
    // Ran from the command palette, where there is no row to point at.
    qing.ui.toast("请在侧栏的大纲面板里点一个标题", "info");
    return;
  }
  // Rebuild first: the outline on screen may be a moment old, and the caret
  // must land where the heading is *now*. Ids are positional, so the same id
  // in the fresh tree is the same slot in the outline.
  await refreshOutline(false);
  const node = byId.get(itemId);
  if (!node) {
    qing.ui.toast("标题已经变了，正在刷新大纲", "info");
    await qing.views.refresh(VIEW_ID);
    return;
  }
  try {
    // An empty selection at the line start: what clicking a heading in a real
    // outliner does, and the least surprising thing for a caret.
    await qing.editor.setSelection({ anchor: node.offset, head: node.offset });
  } catch (error) {
    qing.ui.toast(error instanceof Error ? error.message : "移动光标失败", "danger");
  }
});

qing.commands.register(REFRESH_COMMAND, async () => {
  await refreshOutline(true);
  if (roots.length === 0) qing.ui.toast("（这篇没有标题）", "info");
});

// ---------------------------------------------------------------------------
// `editor:write` — the one code that can change the text the user is typing in.
// ---------------------------------------------------------------------------

qing.commands.register(BOLD_COMMAND, async () => {
  const selection = await qing.editor.getSelection();
  if (selection.from === selection.to) {
    qing.ui.toast("请先选中要加粗的文字", "info");
    return;
  }
  const text = selection.text;
  // Idempotent: running it on already-bold text removes the markers instead of
  // nesting `**…**`. `**a**` is the shortest thing that can be bold, so five
  // characters is the boundary.
  const alreadyBold = text.startsWith("**") && text.endsWith("**") && text.length >= 5;
  const next = alreadyBold ? text.slice(2, -2) : `**${text}**`;
  try {
    // A plain change through the editor's own pipeline: it lands on disk and
    // Ctrl+Z reverses it, exactly like the user typing the asterisks.
    await qing.editor.replace({ from: selection.from, to: selection.to }, next);
    qing.ui.toast(alreadyBold ? "已取消加粗" : "已加粗", "success");
  } catch (error) {
    qing.ui.toast(error instanceof Error ? error.message : "替换失败", "danger");
  }
});

// ---------------------------------------------------------------------------
// `editor:decorate` — marks, not edits.
// ---------------------------------------------------------------------------

/** Are the duplicate-word marks currently on screen? */
let marksActive = false;

/** Latin/numeric words of at least three characters. */
const WORD = /[A-Za-z0-9]+/g;

qing.commands.register(MARK_COMMAND, async () => {
  // Second run clears: `setDecorations(key, [])` is how a plugin takes its own
  // marks back, and the host drops the rest when the plugin is disabled.
  if (marksActive) {
    await qing.editor.setDecorations(DUP_KEY, []);
    marksActive = false;
    qing.ui.toast("已清除标记", "info");
    return;
  }

  let text: string;
  try {
    text = await qing.editor.getText();
  } catch (error) {
    qing.ui.toast(error instanceof Error ? error.message : "读取当前笔记失败", "danger");
    return;
  }

  // Pass one: how often each word turns up. Case-insensitive, so `The` and
  // `the` are the same word.
  const totals = new Map<string, number>();
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (word.length < 3) continue;
    const key = word.toLowerCase();
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  // Pass two: mark the *second and later* occurrence of each repeated word.
  // The first one is the definition, the rest are the echoes — and marking only
  // the echoes is what makes the pattern readable.
  const ranges: Array<{ from: number; to: number; kind: "warning" }> = [];
  const seen = new Map<string, number>();
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

  // An empty result is a clear, not a no-op: re-running after the user deleted
  // the duplicates has to take the old marks off the screen.
  await qing.editor.setDecorations(DUP_KEY, ranges);
  marksActive = ranges.length > 0;
  qing.ui.toast(
    ranges.length > 0 ? `标记了 ${ranges.length} 处重复词` : "没有重复词",
    ranges.length > 0 ? "success" : "info",
  );
});

// The panel is what starts this plugin (`onView:qing.outline.toc`, and the host
// activates on first render regardless), so build the outline as soon as we run
// instead of waiting for the first getChildren.
void refreshOutline(false);
