// src/extension.ts
var COMMAND_ID = "qing.wordcount-ts.run";
function countCharacters(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
  return cjk + words;
}
qing.commands.register(COMMAND_ID, async () => {
  const notes = await qing.notes.list();
  if (notes.length === 0) {
    qing.ui.toast("还没有笔记可以统计", "info");
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
  qing.ui.toast(`共 ${counted} 篇笔记，${total} 字`, "success");
});
