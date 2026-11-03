/**
 * Note file export, shared by the main editor and the detached note window.
 *
 * Two windows can export the same note now, and an export that behaved
 * differently depending on which window it was launched from would be a bug
 * waiting to happen: the filter list, the "Windows appends only the first
 * extension" fix-up, the HTML→Markdown downgrade and the print sheet are all
 * decisions that must be made once. The caller owns *which* content to write
 * (the main editor flushes and re-reads the active note; the detached window
 * hands over its own buffer), this module owns everything after that.
 */
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { alertDialog } from "@/stores/dialogStore";
import type { LangType } from "@/stores/settingsStore";
import { t, tWithParams } from "@/utils/i18n";
import { renderStoredNoteContentForExport } from "@/utils/markdown";
import { storedContentToMarkdown } from "@/utils/htmlToMarkdown";

export interface ExportNoteInput {
  title: string;
  /** Stored note body: Markdown, or the HTML written by the old editor. */
  content: string;
  lang: LangType;
}

/**
 * Off-screen sheet handed to WebView2's print engine. It lives outside `#root`
 * so the print stylesheet can hide the whole app and leave only the note.
 */
function mountPrintSheet(title: string, html: string): HTMLElement {
  const sheet = document.createElement("article");
  sheet.className = "print-sheet";

  const heading = document.createElement("h1");
  heading.className = "print-sheet-title";
  heading.textContent = title;
  sheet.appendChild(heading);

  const body = document.createElement("div");
  body.className = "print-sheet-body";
  body.innerHTML = html;
  sheet.appendChild(body);

  document.body.appendChild(sheet);
  document.body.classList.add("exporting-pdf");
  return sheet;
}

function unmountPrintSheet(sheet: HTMLElement): void {
  document.body.classList.remove("exporting-pdf");
  sheet.remove();
}

/** PrintToPdf captures the layout as it is now, so wait for paint and images. */
async function waitForPrintLayout(sheet: HTMLElement): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  try {
    await document.fonts.ready;
  } catch {
    // Font loading is best-effort; printing can proceed with fallbacks.
  }
  await Promise.all(
    Array.from(sheet.querySelectorAll("img")).map((image) =>
      image.decode ? image.decode().catch(() => undefined) : Promise.resolve(),
    ),
  );
}

/**
 * Ask for a destination and write the note there.
 *
 * Every failure is reported through the app dialog rather than swallowed: a
 * dialog that closes without a file is indistinguishable from a broken button.
 */
export async function exportNoteFile({ title, content, lang }: ExportNoteInput): Promise<void> {
  try {
    const defaultPath = `${title || t(lang, "untitled")}.md`;
    const savePath = await save({
      filters: [
        { name: t(lang, "exportFilterMarkdown"), extensions: ["md"] },
        { name: t(lang, "exportFilterText"), extensions: ["txt"] },
        { name: t(lang, "exportFilterWord"), extensions: ["docx"] },
        { name: t(lang, "exportFilterPdf"), extensions: ["pdf"] },
      ],
      defaultPath,
    });
    if (!savePath) return;

    // Windows only appends the first filter's extension, so a name typed
    // without one after picking Word or PDF would otherwise land on `.md`.
    const hasExtension = /\.[^./\\]+$/.test(savePath);
    const exportPath = hasExtension ? savePath : `${savePath}.md`;
    const target = exportPath.toLowerCase();

    // Word and PDF both need the rendered form: images inlined as data URLs
    // (both loaders drop asset URLs), code blocks highlighted, Markdown parsed.
    if (target.endsWith(".docx") || target.endsWith(".pdf")) {
      const html = await renderStoredNoteContentForExport(content);

      if (target.endsWith(".docx")) {
        // The DOCX writer is only pulled in when someone actually exports
        // Word, which keeps it out of the startup bundle.
        const { buildNoteDocx } = await import("@/utils/exportDocx");
        const { data, droppedImages } = await buildNoteDocx({ title, html });
        await writeFile(exportPath, data);
        if (droppedImages > 0) {
          await alertDialog({
            title: t(lang, "exportFile"),
            body: tWithParams(lang, "exportImagesDropped", { count: droppedImages }),
            confirmLabel: t(lang, "dialogConfirm"),
            tone: "warning",
          });
        }
        return;
      }

      const sheet = mountPrintSheet(title || t(lang, "untitled"), html);
      try {
        await waitForPrintLayout(sheet);
        await invoke("export_pdf", { path: exportPath });
      } finally {
        unmountPrintSheet(sheet);
      }
      return;
    }

    await writeTextFile(exportPath, storedContentToMarkdown(content));
  } catch (e) {
    console.error("Export file failed:", e);
    const detail = e instanceof Error ? e.message : String(e);
    void alertDialog({
      title: t(lang, "exportFile"),
      body: tWithParams(lang, "exportFailed", { message: detail }),
      confirmLabel: t(lang, "dialogConfirm"),
      tone: "danger",
    });
  }
}
