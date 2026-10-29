/**
 * Target normalisation and four-level disambiguation.
 *
 * Everything here is a pure string/Map operation: no IO, no store, no React.
 * The candidate table is handed in by the caller (T04 builds it from the node
 * array once per snapshot), which is what keeps this module testable against
 * hand-written fixtures and lets 5000 notes run through it in one pass.
 *
 * This module also owns "what a target string means" — the extension rules, the
 * normalisation pipeline, path joining. `linkScanner` and `noteSourceAdapter`
 * import those helpers instead of re-deriving them, so the scanner can never
 * disagree with the resolver about whether `foo.MD` is a note. The dependency
 * direction is one-way (resolver → types only), so there is no cycle.
 */
import type { GraphNode, ParsedLink, Resolution } from "@/types/graph";

/** 与 Rust 侧 `vault.rs` 的扩展名集合一致，大小写不敏感。 */
export const NOTE_EXTENSIONS = ["md", "markdown", "txt"] as const;

const NOTE_EXTENSION_SUFFIX = /\.(md|markdown|txt)$/i;

/** 最后一个 `.` 之后的扩展名，小写、不含点；没有扩展名返回 ""。 */
export function fileExtension(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 是 md / markdown / txt 之一吗（大小写不敏感）。 */
export function isNoteExtension(extension: string): boolean {
  const value = extension.toLowerCase();
  return (NOTE_EXTENSIONS as readonly string[]).includes(value);
}

/** `[[笔记.md]]` 与 `[[笔记]]` 必须等价（§3.3.2 第 6 步）。 */
export function stripNoteExtension(value: string): string {
  return value.replace(NOTE_EXTENSION_SUFFIX, "");
}

/** 路径的最后一段；没有 `/` 时返回原串。 */
export function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** 路径除最后一段之外的部分；根目录返回 ""。 */
export function dirnameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : "";
}

/**
 * `decodeURIComponent`, but a malformed escape keeps the original string
 * instead of throwing: `[[100%纯手工]]` and `[x](a%zzb.md)` are things users
 * actually type, and a scanner that throws on them loses the whole note.
 */
export function decodePercentSafe(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * §3.3.2, steps 1–6, in order. Step 7 (no simplified/traditional conversion, no
 * pinyin matching) is an explicit non-feature: a wrong edge is worse than a
 * broken link, because a broken link at least renders as a dashed line.
 */
export function normalizeTarget(raw: string): string {
  // 1. NFKC —— 全角括号/字母/冒号折叠成半角。
  let value = raw.normalize("NFKC");
  // 2. 从资源管理器复制来的路径是反斜杠。
  value = value.replace(/\\/g, "/");
  // 3. Markdown 链接里空格常被编码。
  value = decodePercentSafe(value);
  // 4. Windows 文件系统本身大小写不敏感。
  value = value.toLowerCase();
  // 5. 全角空格与连续空白折叠。
  value = value.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
  // 6. `[[笔记.md]]` 与 `[[笔记]]` 必须等价。
  value = stripNoteExtension(value);
  return value;
}

/**
 * Join a target onto a directory inside the vault, folding `.` and `..`.
 *
 * Returns `null` when the `..` chain climbs above the vault root: a link that
 * points outside the vault is not a knowledge-base edge at all (§3.3.3 1b), and
 * there is no node it could honestly become.
 */
export function joinVaultPath(dir: string, target: string): string | null {
  const combined = dir ? `${dir}/${target}` : target;
  const out: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * Three lookup tables, built in one pass over the nodes.
 *
 * Keys are already normalised, because both sides of every comparison must go
 * through the same pipeline: `[[Readme]]`, `[[readme.md]]` and `[[ＲＥＡＤＭＥ]]`
 * have to land on one key or the "unique filename" level can never be unique.
 */
export interface CandidateTable {
  /** 归一化 relPath（去扩展名）→ 节点 id */
  byRelPath: Map<string, string[]>;
  /** 归一化 basename（去扩展名）→ 节点 id */
  byBasename: Map<string, string[]>;
  /** 归一化 title → 节点 id */
  byTitle: Map<string, string[]>;
}

function pushCandidate(table: Map<string, string[]>, key: string, id: string): void {
  if (!key) return;
  const existing = table.get(key);
  if (!existing) {
    table.set(key, [id]);
    return;
  }
  if (!existing.includes(id)) existing.push(id);
}

/** 悬空节点不是解析目标：它的 refId 是被指向的归一化串，不是文件。 */
export function buildCandidateTable(nodes: readonly GraphNode[]): CandidateTable {
  const table: CandidateTable = {
    byRelPath: new Map(),
    byBasename: new Map(),
    byTitle: new Map(),
  };
  for (const node of nodes) {
    if (node.kind === "dangling") continue;
    if (node.path) {
      const normalizedPath = normalizeTarget(node.path);
      pushCandidate(table.byRelPath, normalizedPath, node.id);
      pushCandidate(table.byBasename, basenameOf(normalizedPath), node.id);
    }
    pushCandidate(table.byTitle, normalizeTarget(node.title), node.id);
  }
  return table;
}

export interface ResolveInput {
  link: ParsedLink;
  /** 来源节点；native 节点的 `dir` 是 null，此时只剩 3/4 级可用。 */
  from: GraphNode | null;
  table: CandidateTable;
}

function decide(ids: readonly string[] | undefined): Resolution | null {
  if (!ids || ids.length === 0) return null;
  if (ids.length === 1) {
    return { status: "resolved", nodeId: ids[0], candidateCount: 1 };
  }
  // 歧义不猜（§3.3.3 硬规则）：猜错的边会让用户对整张图失去信任。
  return { status: "ambiguous", candidateCount: ids.length, candidates: [...ids] };
}

/**
 * Four levels, first hit wins. A level that returns several candidates stops the
 * search immediately — falling through to a looser level would silently pick a
 * different file than the one the user's path selected.
 */
export function resolveLink({ link, from, table }: ResolveInput): Resolution {
  const normalized = normalizeTarget(link.rawTarget);
  if (!normalized) return { status: "missing", candidateCount: 0 };

  // 1. 路径式（t 含 "/"）
  if (normalized.includes("/")) {
    // 1a. 以 "/" 开头 → vault 根相对路径精确匹配。
    // 1b. 否则 → 相对 from 所在目录规范化后精确匹配（越界即失败）。
    const joined = normalized.startsWith("/")
      ? joinVaultPath("", normalized.replace(/^\/+/, ""))
      : joinVaultPath(normalizeTarget(from?.dir ?? ""), normalized);
    const hit = joined === null ? null : decide(table.byRelPath.get(joined));
    if (hit) return hit;
  }

  // 2. 同目录同名：Obsidian 的"就近优先"，也避免 a/笔记.md 与 b/笔记.md
  //    互相打断。
  const basename = basenameOf(normalized);
  if (basename) {
    const sibling = joinVaultPath(normalizeTarget(from?.dir ?? ""), basename);
    const hit = sibling === null ? null : decide(table.byRelPath.get(sibling));
    if (hit) return hit;
  }

  // 3. 全局唯一文件名。
  const byBasename = decide(table.byBasename.get(normalized));
  if (byBasename) return byBasename;

  // 4. 全局唯一标题。
  const byTitle = decide(table.byTitle.get(normalized));
  if (byTitle) return byTitle;

  return { status: "missing", candidateCount: 0 };
}
