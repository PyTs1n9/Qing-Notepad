import { classifyMarkdownLines, stripInlineMarkdown } from "@/utils/markdownStats";

/** One entry of the note's outline. `line` is 0-based, matching the source. */
export interface OutlineHeading {
  level: number;
  text: string;
  line: number;
}

/** ATX heading: 1–6 `#`, one required space, then the title. */
const ATX_HEADING = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** Setext heading underline. Only its presence matters; the title is above it. */
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)[ \t]*$/;

/**
 * Headings of a Markdown document, in document order.
 *
 * Fenced code blocks are skipped through the shared scanner: a `# comment`
 * inside a code sample is not a section, and an outline that lists it cannot be
 * clicked to anywhere useful.
 *
 * Setext headings (`Title` + `====`) are included because the preview renders
 * them as `<h1>`/`<h2>`; an outline that only knew about `#` would silently omit
 * whole sections of an imported file.
 */
export function extractOutline(source: string): OutlineHeading[] {
  const lines = classifyMarkdownLines(source);
  const headings: OutlineHeading[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const { text, kind } = lines[index];
    if (kind !== "markup") continue;

    const atx = text.match(ATX_HEADING);
    if (atx) {
      const title = stripInlineMarkdown(atx[2]).trim();
      // `#` alone is a valid empty heading; there is nothing to list or click.
      if (title) headings.push({ level: atx[1].length, text: title, line: index });
      continue;
    }

    // Setext: the heading text is the previous line, the marker is this one.
    const setext = text.match(SETEXT_UNDERLINE);
    if (!setext) continue;
    const previous = lines[index - 1];
    if (!previous || previous.kind !== "markup") continue;
    const title = stripInlineMarkdown(previous.text).trim();
    if (!title) continue;
    // A `---` directly above a blank line is a horizontal rule, not a heading;
    // the previous line already being consumed as a heading also rules it out.
    if (headings.some((heading) => heading.line === previous.line)) continue;
    headings.push({ level: setext[1][0] === "=" ? 1 : 2, text: title, line: previous.line });
  }

  return headings;
}
