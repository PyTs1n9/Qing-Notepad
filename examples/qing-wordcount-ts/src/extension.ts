/**
 * Example plugin: count characters across the note library (TypeScript build).
 *
 * The functionality is deliberately identical to `qing-note-wordcount/` — that
 * pairing is the point of this example: same plugin, two manifests. The older
 * one ships `plugin.json` with `id` / `engines.host` / `commands[].id`; this one
 * ships a VS Code style `package.json` with `publisher` + `name` /
 * `engines.qing` / `commands[].command`. The host maps both onto the same
 * internal manifest, so the two packages behave the same once installed.
 *
 * Only `notes:read` is used, and only through the documented API. Note bodies
 * arrive as plain text — the host strips the editor's HTML before handing them
 * over — so the counter does not have to understand markup.
 *
 * `apiVersion: 1` has no "which note is open" call, so the count covers the
 * whole library ("N notes · M characters") rather than the note in the editor.
 */
const COMMAND_ID = "qing.wordcount-ts.run";

/** CJK ideographs count per character; everything else counts per word. */
function countCharacters(text: string): number {
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
