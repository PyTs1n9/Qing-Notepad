// src/extension.ts
var COMMAND_ID = "qing.editor-demo.report";
var TOP_WORDS = 5;
function countCharacters(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
  return cjk + words;
}
function topWords(text, limit) {
  const counts = /* @__PURE__ */ new Map();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_'’-]+/g)) {
    const word = match[0];
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].map(([word, count]) => ({ word, count })).sort((left, right) => right.count - left.count || left.word.localeCompare(right.word)).slice(0, limit);
}
function formatTopWords(words) {
  if (words.length === 0) return "";
  return ` · 词频 ${words.map((entry) => `${entry.word}×${entry.count}`).join(" ")}`;
}
qing.commands.register(COMMAND_ID, async () => {
  const selection = await qing.editor.getSelection();
  const scoped = selection.from !== selection.to;
  const text = scoped ? await qing.editor.getText({ from: selection.from, to: selection.to }) : await qing.editor.getText();
  if (!text.trim()) {
    qing.ui.toast(scoped ? "选区是空的" : "当前笔记是空的", "info");
    return;
  }
  const characters = countCharacters(text);
  const words = topWords(text, TOP_WORDS);
  const scope = scoped ? `选区 ${selection.to - selection.from} 字符` : "整篇";
  qing.ui.toast(`${scope}：${characters} 字${formatTopWords(words)}`, "success");
});
