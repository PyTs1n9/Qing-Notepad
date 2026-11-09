import { marked, type Tokens } from "marked";
import { hljs } from "@/utils/highlight";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { join, resourceDir } from "@tauri-apps/api/path";
import { isSafeLinkHref, schemeOf } from "@/utils/linkScheme";
import { getDataDirectory, getStorageLocation, resolveImageAttachment } from "@/utils/storage";

const markdownRenderer = new marked.Renderer();

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCodeLanguage(lang?: string): string {
  return lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

const CODE_LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  powershell: "PowerShell",
  ps1: "PowerShell",
  py: "Python",
  python: "Python",
  rust: "Rust",
  rs: "Rust",
  shell: "Shell",
  sh: "Shell",
  sql: "SQL",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
};

function getCodeLanguageLabel(language: string): string {
  if (!language) return "Code";
  return CODE_LANGUAGE_LABELS[language]
    ?? `${language.charAt(0).toUpperCase()}${language.slice(1)}`;
}

function highlightCode(text: string, language: string): string | null {
  if (!language || !hljs.getLanguage(language)) return null;

  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/**
 * Image schemes are image-only on purpose: `data:`/`blob:`/`attachment:` are
 * inert as a source but must never become clickable link destinations, so they
 * stay out of `linkScheme.ts`.
 */
const IMAGE_SCHEME_ALLOWLIST = /^(?:https?|blob|attachment|asset|data)$/i;

/** True when the target carries no scheme at all (`#anchor`, `/path`, `x.md`). */
function isRelativeTarget(value: string): boolean {
  return !schemeOf(value);
}

// Re-exported so the renderer stays the single import for "may this href become
// an `<a>`"; the list itself lives in `linkScheme.ts` because the click resolver
// has to answer the same question.
export { isSafeLinkHref };

export function isSafeImageSrc(src: string): boolean {
  const value = src.trim();
  if (!value) return false;
  if (value.startsWith("//")) return true;
  if (isRelativeTarget(value)) return true;
  const scheme = schemeOf(value);
  if (!IMAGE_SCHEME_ALLOWLIST.test(scheme)) return false;
  // `data:` is only inert when the payload really is an image.
  if (/^data$/i.test(scheme) && !/^data:image\//i.test(value)) return false;
  return true;
}

// Markdown permits raw HTML, but note previews are inserted as HTML. Keep the
// existing safe behavior while still allowing Markdown-generated <img> tags.
markdownRenderer.html = ({ text }: Tokens.HTML): string => escapeHtml(text);

// Delegate to marked's own link renderer (it knows how to render inline
// tokens), then drop the href when the scheme is not on the allowlist — the
// link text survives as plain text so nothing silently disappears.
const defaultLinkRenderer = markdownRenderer.link.bind(markdownRenderer);
markdownRenderer.link = (token: Tokens.Link): string => {
  if (isSafeLinkHref(token.href)) return defaultLinkRenderer(token);
  return markdownRenderer.parser.parseInline(token.tokens);
};
markdownRenderer.space = ({ raw }: Tokens.Space): string => {
  const blankLineCount = Math.max(0, (raw.match(/\n/g)?.length ?? 0) - 1);
  if (blankLineCount === 0) return "";
  return `<span class="markdown-blank-lines" style="--markdown-blank-line-count:${blankLineCount}" aria-hidden="true"></span>\n`;
};
markdownRenderer.checkbox = ({ checked }: Tokens.Checkbox): string => {
  return `<input class="markdown-task-checkbox"${checked ? " checked" : ""} disabled type="checkbox">`;
};
markdownRenderer.image = ({ href, title, text }: Tokens.Image): string => {
  const marker = /#attachment=([^#]+)$/i.exec(href);
  const src = marker ? href.slice(0, marker.index) : href;
  if (!isSafeImageSrc(src)) {
    // A local absolute path that did not resolve (outside the data directory, or
    // it does not exist). Rendering the bare alt text hides the problem, so it
    // becomes a labelled chip that names the file in its tooltip.
    const localPath = localPathFromImageSource(src);
    if (localPath) {
      const label = text.trim() || "Image";
      return `<span class="markdown-external-image" title="${escapeHtml(localPath)}">${escapeHtml(label)}</span>`;
    }
    return escapeHtml(text);
  }
  const attributes = [`src="${escapeHtml(src)}"`, `alt="${escapeHtml(text)}"`];
  if (title) attributes.push(`title="${escapeHtml(title)}"`);
  if (marker) {
    attributes.push(`data-attachment-src="attachment://${escapeHtml(decodeUrl(marker[1]))}"`);
  }
  return `<img ${attributes.join(" ")}>`;
};
markdownRenderer.code = ({ text, lang }: Tokens.Code): string => {
  const language = getCodeLanguage(lang);
  const highlighted = highlightCode(text, language);
  const languageClass = /^[a-z0-9_+#.-]+$/i.test(language)
    ? ` language-${escapeHtml(language)}`
    : "";
  const highlightClass = highlighted ? " hljs" : "";
  const code = highlighted ?? escapeHtml(text);
  const languageLabel = escapeHtml(getCodeLanguageLabel(language));

  return `<pre class="markdown-code-block"><span class="markdown-code-language">${languageLabel}</span><code class="markdown-code${highlightClass}${languageClass}">${code}</code></pre>\n`;
};

const IMAGE_MARKDOWN_PATTERN = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]+\)))?\s*\)/g;
const IMAGE_HTML_PATTERN = /(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi;

function decodeUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isNonFileImageSource(source: string): boolean {
  // `asset:` and `http://asset.localhost` are what `convertFileSrc` returns for
  // an already-resolved local image. Without them a re-render would treat the
  // URL as a relative path and join it onto the data directory again.
  return /^(?:https?:|data:|blob:|asset:|\/\/|about:|#)/i.test(source);
}

function fileUrlToPath(source: string): string | null {
  if (!/^file:\/\//i.test(source)) return null;

  try {
    const url = new URL(source);
    let path = decodeURIComponent(url.pathname);
    if (url.host && url.host !== "localhost") {
      path = `\\\\${url.host}${path.replace(/\//g, "\\")}`;
    } else if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
    }
    return path.replace(/\//g, "\\");
  } catch {
    return null;
  }
}

function isAbsoluteFilePath(source: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(source);
}

function imageMimeType(path: string): string {
  const extension = path.split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "avif":
      return "image/avif";
    case "ico":
      return "image/x-icon";
    default:
      return "image/png";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Where the resolved URL ends up decides how a local image may be read.
 *
 * - `render`: the preview, sticky window, tile window and AI panel. The URL is
 *   handed to the webview as an asset URL; the asset-protocol scope in
 *   `tauri.conf.json` is the boundary, so an out-of-scope path never reaches JS.
 * - `export`: DOCX and PDF. Both loaders only understand `data:` URLs, so the
 *   bytes still have to be inlined — under a tighter cap and restricted to the
 *   data directory, which is what stops "read any file on disk".
 */
type ImageResolutionMode = "render" | "export";

const MAX_RENDER_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_EXPORT_IMAGE_BYTES = 8 * 1024 * 1024;

/** Collapse `a/../b`, unify separators and drop trailing slashes. */
function normalizeFilePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  const prefix = /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+\/|\/)/.exec(unified)?.[0] ?? "";
  const segments = unified.slice(prefix.length).split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return prefix + stack.join("/");
}

/**
 * Prefix comparison on normalized paths. Windows is case-insensitive, so the
 * comparison is too; the asset-protocol scope remains the final authority.
 */
function isInsideDirectory(path: string, directory: string): boolean {
  const target = normalizeFilePath(path).toLowerCase();
  const root = normalizeFilePath(directory).replace(/\/+$/, "").toLowerCase();
  if (!root) return false;
  return target === root || target.startsWith(`${root}/`);
}

let assetScopeCoversDataPromise: Promise<boolean> | null = null;

/**
 * Whether an asset URL for a data-directory file is reachable.
 *
 * - A custom data directory is registered into the asset scope by Rust on
 *   startup (`storage_get_root`), so asset URLs work there.
 * - The default directory is only covered when it sits under `$RESOURCE`
 *   (installed builds). Dev keeps `data/` in the repository, outside the scope,
 *   so those renders fall back to a capped data URL.
 */
function assetScopeCoversDataDirectory(): Promise<boolean> {
  if (!assetScopeCoversDataPromise) {
    assetScopeCoversDataPromise = (async () => {
      try {
        const location = await getStorageLocation();
        if (location.custom) return true;
        return isInsideDirectory(location.path, await resourceDir());
      } catch {
        // Unknown: keep the asset protocol, whose scope still rejects the path.
        return true;
      }
    })();
  }
  return assetScopeCoversDataPromise;
}

async function readImageAsDataUrl(path: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(path);
    if ((info.size ?? 0) > maxBytes) return null;
    const bytes = await readFile(path);
    return `data:${imageMimeType(path)};base64,${bytesToBase64(bytes)}`;
  } catch {
    return null;
  }
}

/**
 * URL a renderer can load for a local image: an asset URL, except where the
 * asset-protocol scope cannot reach the file (dev keeps `data/` in the
 * repository), which falls back to an inlined copy under the same byte cap.
 *
 * Anything outside the data directory gets `null`: the asset-protocol scope no
 * longer covers the user's Pictures/Desktop/Downloads, so handing back an asset
 * URL would only produce a 403. Those images render as a visible placeholder
 * instead of a silently broken <img>.
 */
async function renderUrlForLocalImage(path: string): Promise<string | null> {
  const dataDirectory = await getDataDirectory().catch(() => null);
  const insideDataDirectory = dataDirectory !== null && isInsideDirectory(path, dataDirectory);

  let size: number | null = null;
  try {
    size = (await stat(path)).size ?? 0;
  } catch {
    size = null;
  }
  if (size !== null && size > MAX_RENDER_IMAGE_BYTES) return null;

  // Outside the data directory nothing is readable any more: the fs scope was
  // narrowed to the data root, so both stat above and the asset protocol fail.
  if (!insideDataDirectory) return null;
  // A file we cannot even measure is one the webview cannot load either.
  if (size === null) return null;
  if (!(await assetScopeCoversDataDirectory())) {
    return readImageAsDataUrl(path, MAX_RENDER_IMAGE_BYTES);
  }
  return convertFileSrc(path);
}

async function resolveLocalImagePath(
  source: string,
  mode: ImageResolutionMode,
): Promise<string | null> {
  const decodedSource = decodeUrl(source.trim());

  const attachmentMatch = /^attachment:\/\/([^/?#]+)$/i.exec(decodedSource);
  if (attachmentMatch) {
    const filename = attachmentMatch[1];
    const attachmentPath = await resolveImageAttachment(filename);
    if (!attachmentPath) return null;
    if (mode === "export") return readImageAsDataUrl(attachmentPath, MAX_EXPORT_IMAGE_BYTES);
    const url = await renderUrlForLocalImage(attachmentPath);
    if (!url) return null;
    // The marker is how a later edit maps an <img> back to its attachment.
    return url.startsWith("data:")
      ? url
      : `${url}#attachment=${encodeURIComponent(filename)}`;
  }

  const filePath = fileUrlToPath(decodedSource) ?? decodedSource;
  const dataDirectory = await getDataDirectory().catch(() => null);

  let path: string;
  if (isAbsoluteFilePath(filePath)) {
    // Absolute paths are no longer read here. They become an asset URL and the
    // protocol scope decides; the export path below has to keep them inside the
    // data directory because it reads the bytes itself.
    path = normalizeFilePath(filePath);
  } else {
    if (!dataDirectory) return null;
    try {
      path = normalizeFilePath(await join(dataDirectory, "notes", filePath));
    } catch {
      return null;
    }
    if (!isInsideDirectory(path, dataDirectory)) return null;
  }

  if (mode === "export") {
    if (!dataDirectory || !isInsideDirectory(path, dataDirectory)) return null;
    return readImageAsDataUrl(path, MAX_EXPORT_IMAGE_BYTES);
  }

  return renderUrlForLocalImage(path);
}

async function resolveImageSource(
  source: string,
  mode: ImageResolutionMode,
): Promise<string> {
  const trimmed = source.trim();
  if (!trimmed || isNonFileImageSource(trimmed)) return trimmed;
  return (await resolveLocalImagePath(trimmed, mode)) ?? source;
}

const ASSET_URL_PATTERN = /^https?:\/\/asset\.localhost\/(.+)$/i;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Local filesystem path behind an `<img src>`, or null for every other scheme. */
function localPathFromImageSource(source: string): string | null {
  const assetMatch = ASSET_URL_PATTERN.exec(source);
  if (assetMatch) {
    try {
      const decoded = decodeURIComponent(assetMatch[1]);
      // Only an absolute path is a real file reference. A hand-written
      // `http://asset.localhost/x.png` carries a relative fragment and must be
      // left alone, otherwise a re-render would nest placeholders.
      return isAbsoluteFilePath(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return isAbsoluteFilePath(source) ? source : null;
}

/**
 * Turn `<img>` tags that point outside the data directory into a visible
 * placeholder.
 *
 * The asset-protocol scope no longer covers the user's Pictures/Desktop/
 * Downloads, so those tags would 403 and leave a broken-image icon with no
 * explanation. Re-inserting the picture from the editor copies it into
 * `data/img`, which is the supported path.
 *
 * Runs on the HTML string rather than the DOM so the headless harness
 * (`npm run verify:batch2`) can cover it.
 */
function replaceExternalImages(html: string, dataDirectory: string | null): string {
  if (!dataDirectory) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = decodeHtmlEntities(
      /\bsrc\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bsrc\s*=\s*'([^']*)'/i.exec(tag)?.[1] ?? "",
    );
    const path = src ? localPathFromImageSource(src) : null;
    if (!path || isInsideDirectory(path, dataDirectory)) return tag;
    const alt = decodeHtmlEntities(/\balt\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? "");
    const label = alt.trim() || "Image";
    return `<span class="markdown-external-image" title="${escapeHtml(path)}">${escapeHtml(label)}</span>`;
  });
}

async function resolveMarkdownImages(
  content: string,
  mode: ImageResolutionMode,
): Promise<string> {
  const matches = [...content.matchAll(IMAGE_MARKDOWN_PATTERN)];
  if (matches.length === 0) return content;

  let result = "";
  let cursor = 0;
  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    const source = match[1] ?? match[2];
    if (!source) continue;

    const destinationStart = match[0].indexOf("](") + 2;
    const sourceOffset = match[0].indexOf(source, destinationStart);
    const absoluteSourceStart = matchIndex + sourceOffset;
    const resolvedSource = await resolveImageSource(source, mode);

    result += content.slice(cursor, absoluteSourceStart);
    result += resolvedSource;
    cursor = absoluteSourceStart + source.length;
  }
  return result + content.slice(cursor);
}

export async function resolveHtmlImages(
  content: string,
  mode: ImageResolutionMode = "render",
): Promise<string> {
  const matches = [...content.matchAll(IMAGE_HTML_PATTERN)];
  if (matches.length === 0) return content;

  let result = "";
  let cursor = 0;
  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    const prefix = match[1];
    const quote = match[2];
    const source = match[3];
    const absoluteSourceStart = matchIndex + prefix.length + quote.length;
    const resolvedSource = await resolveImageSource(source, mode);

    result += content.slice(cursor, absoluteSourceStart);
    result += resolvedSource;
    cursor = absoluteSourceStart + source.length;
  }
  return result + content.slice(cursor);
}

async function renderMarkdownWithMode(
  content: string,
  mode: ImageResolutionMode,
): Promise<string> {
  const resolvedContent = await resolveMarkdownImages(content, mode);
  const html = marked.parse(resolvedContent, {
    breaks: true,
    gfm: true,
    renderer: markdownRenderer,
  });
  return typeof html === "string" ? html : await html;
}

export async function renderMarkdown(content: string): Promise<string> {
  const html = await renderMarkdownWithMode(content, "render");
  const dataDirectory = await getDataDirectory().catch(() => null);
  return replaceExternalImages(html, dataDirectory);
}

function highlightStoredHtmlCodeBlocks(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;

  container.querySelectorAll("pre > code").forEach((code) => {
    const languageClass = Array.from(code.classList).find((name) => name.startsWith("language-"));
    const language = languageClass?.slice("language-".length).toLowerCase() ?? "";
    const highlighted = highlightCode(code.textContent ?? "", language);

    const block = code.parentElement;
    block?.classList.add("markdown-code-block");
    if (block && !block.querySelector(":scope > .markdown-code-language")) {
      const languageLabel = document.createElement("span");
      languageLabel.className = "markdown-code-language";
      languageLabel.textContent = getCodeLanguageLabel(language);
      block.insertBefore(languageLabel, code);
    }
    code.classList.add("markdown-code");
    if (highlighted) {
      code.innerHTML = highlighted;
      code.classList.add("hljs");
    }
  });

  return container.innerHTML;
}

export function stripMarkdownSyntaxHighlighting(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;

  container.querySelectorAll("code.hljs").forEach((code) => {
    code.replaceChildren(document.createTextNode(code.textContent ?? ""));
    code.classList.remove("hljs");
  });

  return container.innerHTML;
}

function isHtmlContent(content: string): boolean {
  // A generic `<word>` match also treats C++ template arguments such as
  // `vector<int>` as HTML. Stored editor HTML has a matching closing tag, or
  // a real void element, so only use those as the signal.
  return /<([a-z][\w-]*)\b[^>]*>[\s\S]*<\/\1\s*>/i.test(content)
    || /<(?:img|br|hr)\b(?:\s+[^>]*)?\/?\s*>/i.test(content);
}

async function renderStoredContent(
  content: string,
  mode: ImageResolutionMode,
): Promise<string> {
  const html = isHtmlContent(content)
    ? highlightStoredHtmlCodeBlocks(await resolveHtmlImages(content, mode))
    : await renderMarkdownWithMode(content, mode);
  if (mode !== "render") return html;
  // Export paths keep their <img> tags: DOCX/PDF need real images, and they read
  // the bytes themselves under the data-directory + 8MB cap.
  const dataDirectory = await getDataDirectory().catch(() => null);
  return replaceExternalImages(html, dataDirectory);
}

export async function renderStoredNoteContent(content: string): Promise<string> {
  return renderStoredContent(content, "render");
}

/**
 * DOCX and PDF need `data:` URLs for images, so this variant inlines them —
 * restricted to the data directory and to `MAX_EXPORT_IMAGE_BYTES`.
 */
export async function renderStoredNoteContentForExport(content: string): Promise<string> {
  return renderStoredContent(content, "export");
}
