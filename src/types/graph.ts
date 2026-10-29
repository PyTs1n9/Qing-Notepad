/**
 * Knowledge-graph data model.
 *
 * Every interface below that also appears in `docs/decisions-knowledge-graph.md`
 * §3.2.1 is copied field for field, including the comments that explain why a
 * field exists — the file layout, the index writer (T04) and the renderer (T06)
 * all read from these types, and a renamed field would silently desynchronise
 * the on-disk ndjson from the in-memory snapshot.
 *
 * Two things in this file are *not* in the design document, both deliberate:
 *
 * 1. `VaultScanResult` / `VaultFileStamp` / `VaultSkipped` / `VaultFileContent`
 *    mirror the Rust structs in `src-tauri/src/vault.rs`. They are declared with
 *    `camelCase` names on both sides, so a rename has to happen in two places —
 *    keeping the mirror in one file means there is exactly one place to look.
 * 2. `ParsedLink` / `Resolution` / `GraphPalette` come from the class diagram in
 *    §3.2.4 but needed concrete field types (the diagram only lists names).
 */

/** 节点来源。dangling 是"被引用但不存在"的虚拟节点，不落盘为独立记录。 */
export type GraphNodeKind = "native" | "vault" | "dangling";

/** 边类型决定布局长度与视觉：embed 更短更粗，markdown 与 wiki 同权。 */
export type GraphEdgeKind = "wiki" | "embed" | "markdown";

/**
 * 节点 id 的字符集刻意与 storage.ts 的 NOTE_ID_PATTERN 对齐
 * （/^[A-Za-z0-9_-]{1,64}$/）。这些 id 永远不该被传进 storage.ts，
 * 但对齐后即使误传也只会得到"非法 id"而不是路径逃逸。
 *   native   → "n-<uuid>"                       38 字符
 *   vault    → "v-<vaultKey8>-<hash16>"         27 字符
 *   dangling → "d-<hash16>"                     18 字符
 *
 * 文档写的是 `<sha256(relPath)[0..16]>`；renderer 里没有同步可用的 sha256
 * （SubtleCrypto 只有异步版本，而 id 需要在单次同步遍历里造出来），所以改用
 * 同步的 64 位 FNV-1a，输出同样是 16 位小写 hex，字符集与长度不变。
 * 见 `src/utils/graph/ids.ts`。
 */
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /** 取文件/写回时用的真实身份：native=uuid，vault=根相对路径，dangling=归一封目标 */
  refId: string;
  vaultKey: string | null;
  title: string;
  /** vault：根相对路径（保留用户原名，中文/空格/括号原样）；native：null */
  path: string | null;
  /** vault：所在目录（筛子图用）；native：null */
  dir: string | null;
  /** native：现有 Note.categoryId，用于按文件夹筛 */
  categoryId: string | null;
  tags: string[];
  /** 派生：出度 + 入度，用于节点尺寸与"孤立节点"判定 */
  degree: number;
  /** 前 512 字节 + 长度的摘要，用于重命名修补（§3.4.3），不做内容去重 */
  contentHash: string | null;
  bytes: number;
  mtimeMs: number;
  /** 非 null 表示这篇解析失败（编码错、超限、读失败），图里画成灰点 */
  parseError: string | null;
}

export interface GraphEdge {
  source: string; // GraphNode.id
  target: string; // GraphNode.id（悬空目标也有节点）
  kind: GraphEdgeKind;
  /** 1-based 行号，供"跳到正文该行"与断链定位 */
  line: number;
  /** 原始链接文本，如 "[[会议纪要|纪要]]"，断链修复时原样展示 */
  raw: string;
}

/** 悬空引用：目标没解析到，或解析到多个候选（后者 candidateCount > 1）。 */
export interface DanglingRef {
  id: string; // == 虚拟节点 id
  source: string; // 谁指向它
  rawTarget: string; // 用户写的原文
  normalized: string; // 归一化后的目标（消歧失败也留下它，便于提示"你是不是想写 X"）
  kind: GraphEdgeKind;
  line: number;
  /** 1 = 真的不存在；>1 = 歧义（同名多篇），两种在 UI 上文案不同 */
  candidateCount: number;
}

/** 文件戳：增量扫描的唯一依据。5000 行 × ~100 B ≈ 0.5 MB ［估］ */
export interface FileStamp {
  id: string;
  vaultKey: string;
  relPath: string;
  mtimeMs: number;
  bytes: number;
  hash: string;
  /** 上次解析结果里出边条数，用于"戳没变但边没了"的异常自检 */
  edgeCount: number;
}

export interface VaultRecord {
  key: string; // 8 位十六进制，由规范化路径派生，路径不变则 key 不变
  root: string; // 规范化后的绝对路径
  name: string; // 显示名 = 目录名
  addedAt: string;
  lastScanAt: string | null;
  enabled: boolean;
  fileCount: number;
}

/** 别名表 schema 先定、v1 不写入（v2 由 frontmatter 填充）。 */
export interface AliasEntry {
  nodeId: string;
  alias: string;
  normalized: string;
}

export interface GraphIndexMeta {
  /**
   * 3 = 标题候选链改版（frontmatter → H1 → H2–H6 → 正文首行 → 文件名）及其
   * 同轮修正（单段超长正文截断 40 字 + `…`、frontmatter 块标量/嵌套映射忽略、
   * frontmatter 值清洗）。升版本号的效果见 `graphIndexStore.load()`：旧分片整批
   * 作废后全量重读，否则 mtime/bytes 没变的文件永远不会按新规则重算标题。
   * 版本号是"标题规则"的版本，规则再变就继续 +1，不复用旧号。
   */
  schemaVersion: 3;
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  danglingCount: number;
  /** 被上限跳过的文件（>2 MB、非文本、编码失败），UI 里可展开看 */
  skipped: { relPath: string; reason: string }[];
}

/** 入向索引：targetNodeId → 来源节点 id 列表。反链面板与"被引用次数"都读它。 */
export type IncomingIndex = Map<string, string[]>;

/** 运行期唯一快照，渲染器与面板都只读它。 */
export interface GraphSnapshot {
  nodes: GraphNode[];
  nodeById: Map<string, GraphNode>;
  edges: GraphEdge[];
  outByNode: Map<string, GraphEdge[]>;
  incoming: IncomingIndex;
  dangling: DanglingRef[];
  meta: GraphIndexMeta;
}

/* -------------------------------------------------------------------------- */
/* Parsed links and their resolution (LinkScanner / LinkResolver)              */
/* -------------------------------------------------------------------------- */

/**
 * One link found in a note body.
 *
 * Offsets are code-unit offsets into the *same-length masked* body, so they can
 * be used directly against the original text (see §3.3.4: masking replaces
 * characters with spaces precisely so no offset mapping table is needed).
 */
export interface ParsedLink {
  kind: GraphEdgeKind;
  /** 原文，含 `[[ ]]` 或 `[](…)`，断链修复时原样展示 */
  raw: string;
  /** 括号内/圆括号内的目标原文，未做任何归一化 */
  rawTarget: string;
  /** `[[目标|别名]]` 的别名；别名只影响显示，不参与消歧 */
  alias: string | null;
  /** `[[目标#锚点]]` 的锚点；`[[#锚点]]` 只有锚点，是自引用，不建边 */
  anchor: string | null;
  /** 1-based 行号 */
  line: number;
  /** 1-based 列号（UTF-16 code unit 计） */
  column: number;
  /** 0-based，正文中的字符偏移 */
  offset: number;
}

/** 命中一个节点。 */
export interface ResolvedLink {
  status: "resolved";
  nodeId: string;
  candidateCount: 1;
}

/**
 * 命中多个候选，`candidateCount === candidates.length`。
 *
 * 绝不在这里挑一个：猜错的边会让用户对整张图失去信任，而"命中 3 篇，请写
 * 路径"是一个可修复的提示（§3.3.3 硬规则）。
 */
export interface AmbiguousLink {
  status: "ambiguous";
  candidateCount: number;
  candidates: string[];
}

/** 一个都没命中，建悬空节点。 */
export interface MissingLink {
  status: "missing";
  candidateCount: 0;
}

export type Resolution = ResolvedLink | AmbiguousLink | MissingLink;

/* -------------------------------------------------------------------------- */
/* Theme palette (§4.5.1: canvas reads CSS variables once, never per frame)     */
/* -------------------------------------------------------------------------- */

/** 画布取色缓存。所有值都来自 `--color-*` / `--text-*` 等 CSS 变量。 */
export interface GraphPalette {
  nodeNative: string;
  nodeVault: string;
  nodeIsolatedFill: string;
  nodeDanglingStroke: string;
  edge: string;
  edgeActive: string;
  label: string;
  labelMuted: string;
  selection: string;
}

/* -------------------------------------------------------------------------- */
/* Rust vault commands (mirror of src-tauri/src/vault.rs)                      */
/* -------------------------------------------------------------------------- */

/** `vault_scan` 的一个文件戳。`relPath` 用 `/` 分隔、相对 vault 根。 */
export interface VaultFileStamp {
  relPath: string;
  mtimeMs: number;
  bytes: number;
}

/** 扫描时被跳过的文件/目录，`reason` 直接展示给用户。 */
export interface VaultSkipped {
  relPath: string;
  reason: string;
}

/**
 * `vault_scan` 的结果。**不做 diff** —— 增量比对由 renderer 拿 `files` 与
 * 上一轮的 `FileStamp[]` 自行完成（见 §3.5.2 与 T01 定案）。
 */
export interface VaultScanResult {
  key: string;
  root: string;
  files: VaultFileStamp[];
  skipped: VaultSkipped[];
  fileCount: number;
  scannedAt: string;
}

/**
 * `vault_read_file` 的一项。`text === null` 时 `skipped` 一定有值：超限、
 * 读失败、路径非法都只影响这一条，整批不会失败。
 */
export interface VaultFileContent {
  relPath: string;
  text: string | null;
  bytes: number;
  mtimeMs: number;
  /** "utf-8" | "utf-8-bom" | "gb18030" | "gb18030-lossy" | "none" */
  encoding: string;
  skipped: string | null;
}

/** `vault://changed` 的 payload。三个字段恒在（Rust 侧总是全部发送）。 */
export interface VaultChangedPayload {
  vaultKey: string;
  changed: string[];
  full: boolean;
}
