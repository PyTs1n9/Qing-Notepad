/**
 * A deliberate subset of Markdown for the notes surface.
 *
 * The desktop app renders with `marked` + `highlight.js` (633 lines of
 * `src/utils/markdown.ts`), which a zero-build page cannot import. Rather than
 * drag a bundler in, this file parses the subset the editor actually produces
 * and returns plain data; `app.js` builds DOM nodes from it, so user text is
 * never fed to innerHTML.
 *
 * Supported: headings, paragraphs, ordered/unordered/task lists, fenced code,
 * quotes, rules, and inline bold / italic / code / links.
 */

const FENCE_RE = /^```([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const RULE_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^>\s?/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

function startsBlock(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line)
  );
}

/**
 * @param {string} source
 * @returns {Array<object>} block tokens
 */
export function parseMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence, or past the end of an unterminated block
      blocks.push({ type: "code", lang: fence[1] || "", code: code.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quoted = [];
      while (index < lines.length && QUOTE_RE.test(lines[index])) {
        quoted.push(lines[index].replace(QUOTE_RE, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quoted.join("\n") });
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      const ordered = /^\d/.test(list[2]);
      const items = [];
      while (index < lines.length) {
        const match = LIST_RE.exec(lines[index]);
        if (!match) break;
        if (/^\d/.test(match[2]) !== ordered) break;
        const task = TASK_RE.exec(match[3]);
        items.push(
          task
            ? { text: task[2], checked: task[1].toLowerCase() === "x" }
            : { text: match[3], checked: null },
        );
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

/** Only trust schemes a note is allowed to link to. */
export function sanitizeHref(href) {
  const value = String(href ?? "").trim();
  if (!value) return "";
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return value;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value; // bare domain / relative path
  return "";
}

/**
 * @param {string} text
 * @returns {Array<{type: "text"|"code"|"strong"|"em"|"link", text: string, href?: string}>}
 */
export function parseInline(text) {
  const tokens = [];
  const source = String(text ?? "");
  let cursor = 0;

  for (const match of source.matchAll(INLINE_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ type: "text", text: source.slice(cursor, start) });
    const raw = match[0];

    if (match[1]) {
      tokens.push({ type: "code", text: raw.slice(1, -1) });
    } else if (match[2]) {
      tokens.push({ type: "strong", text: raw.slice(2, -2) });
    } else if (match[3]) {
      tokens.push({ type: "em", text: raw.slice(1, -1) });
    } else if (match[4]) {
      const parsed = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw);
      if (parsed) {
        const href = sanitizeHref(parsed[2]);
        tokens.push(href ? { type: "link", text: parsed[1], href } : { type: "text", text: parsed[1] });
      } else {
        tokens.push({ type: "text", text: raw });
      }
    }

    cursor = start + raw.length;
  }

  if (cursor < source.length) tokens.push({ type: "text", text: source.slice(cursor) });
  return tokens.length ? tokens : [{ type: "text", text: "" }];
}

/**
 * Title shown in the list and the note header. The first non-empty line wins,
 * because every note here starts with its own `# heading`.
 */
export function deriveTitle(body, fallback = "无标题笔记") {
  const line = String(body ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return fallback;
  const stripped = line.replace(/^#{1,6}\s*/, "").replace(/^[-*+]\s+/, "").trim();
  if (!stripped) return fallback;
  return stripped.length > 40 ? `${stripped.slice(0, 40)}…` : stripped;
}
