// src/main.js
var COMMAND_ID = "qing.note-wordcount.run";
function countCharacters(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
  return cjk + words;
}
qing.commands.register(COMMAND_ID, async () => {
  const notes = await qing.notes.list();
  if (notes.length === 0) {
    qing.ui.toast("\u8FD8\u6CA1\u6709\u7B14\u8BB0\u53EF\u4EE5\u7EDF\u8BA1", "info");
    return;
  }
  let total = 0;
  let counted = 0;
  for (const summary of notes) {
    const note = await qing.notes.get(summary.id);
    if (!note) continue;
    total += countCharacters(note.content);
    counted += 1;
  }
  qing.ui.toast(`\u5171 ${counted} \u7BC7\u7B14\u8BB0\uFF0C${total} \u5B57`, "success");
});
