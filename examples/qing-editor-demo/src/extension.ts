/**
 * Example plugin: count the note the user has open.
 *
 * The point of this example is `qing.editor`, not the maths. Three things it
 * demonstrates that a note plugin will need:
 *
 * 1. **Selection-aware scope.** `getSelection()` first: a plugin that reports on
 *    "the text I am looking at" should honour a selection rather than always
 *    reading the whole note.
 * 2. **Ranged `getText`.** Only the slice is fetched when there is a selection,
 *    so a 40 kB note costs nothing more than a 40-character selection.
 * 3. **Positions are CodeMirror offsets into the Markdown source**, and the text
 *    is Markdown — see `src/qing.d.ts` for the two paragraphs that matter.
 *
 * Permissions are `editor:read` + `notify` only. It never writes, so it never
 * asks for `editor:write`, and it paints nothing so it does not ask for
 * `editor:decorate` either. The permission list the user sees at install time is
 * exactly what this plugin can do.
 */

const COMMAND_ID = "qing.editor-demo.report";
const TOP_WORDS = 5;

/**
 * CJK ideographs count per character; everything else counts per word — the
 * same rule the note word-count example uses, so the two numbers are comparable.
 */
function countCharacters(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
  return cjk + words;
}

/** The most frequent Latin/numeric words, case-insensitive. */
function topWords(text: string, limit: number): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_'’-]+/g)) {
    const word = match[0];
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((left, right) => right.count - left.count || left.word.localeCompare(right.word))
    .slice(0, limit);
}

/** Keep the toast readable: the host truncates at 500 characters. */
function formatTopWords(words: Array<{ word: string; count: number }>): string {
  if (words.length === 0) return "";
  return ` · 词频 ${words.map((entry) => `${entry.word}×${entry.count}`).join(" ")}`;
}

qing.commands.register(COMMAND_ID, async () => {
  const selection = await qing.editor.getSelection();
  const scoped = selection.from !== selection.to;

  // Ranged read when something is selected; the whole document otherwise. The
  // range is exactly what `getSelection` returned, so the two calls cannot
  // disagree about what is being counted.
  const text = scoped
    ? await qing.editor.getText({ from: selection.from, to: selection.to })
    : await qing.editor.getText();

  if (!text.trim()) {
    qing.ui.toast(scoped ? "选区是空的" : "当前笔记是空的", "info");
    return;
  }

  const characters = countCharacters(text);
  const words = topWords(text, TOP_WORDS);
  const scope = scoped
    ? `选区 ${selection.to - selection.from} 字符`
    : "整篇";
  qing.ui.toast(`${scope}：${characters} 字${formatTopWords(words)}`, "success");
});
