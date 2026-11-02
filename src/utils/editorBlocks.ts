import { EditorState, type Text } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";

/**
 * A block is the unit live preview renders and degrades: the caret inside a
 * block shows that block as source, everything else stays rendered.
 */
export type BlockKind =
  | "paragraph"
  | "heading"
  | "code"
  | "quote"
  | "table"
  | "hr"
  | "html"
  | "listItem";

export interface Block {
  /** Document offset of the first character, inclusive. */
  from: number;
  /** Document offset one past the last character, exclusive. */
  to: number;
  kind: BlockKind;
  /**
   * Meaning depends on `kind`:
   * - `heading`: ATX / Setext level, 1–6.
   * - `listItem`: 1-based list nesting level (a top-level item is 1).
   * - `quote`: always 1 — quotes are atomic, so we never split a nested one out.
   * - everything else: 0.
   */
  depth: number;
}

export interface BlocksOptions {
  /**
   * Milliseconds allowed for the synchronous parse. Defaults to 5000. A
   * document too large to finish in that window yields the blocks of the
   * parsed prefix instead of blocking the caller.
   */
  timeout?: number;
}

/**
 * `markdown()` alone defaults to a CommonMark base, where `Table` does not
 * exist and a GFM table parses as a paragraph — hence the GFM base. The keymap
 * is off because this language exists to be parsed, not edited: the editor
 * keeps its own `markdown()` setup.
 */
const BLOCK_LANGUAGE = markdown({ base: markdownLanguage, addKeymap: false });

const DEFAULT_PARSE_TIMEOUT_MS = 5_000;

/** Atomic block nodes: named once, then never descended into. */
const ATOMIC_NODE_KINDS: Record<string, BlockKind | undefined> = {
  Paragraph: "paragraph",
  // A link definition looks like a paragraph, and the caret can sit in it, so
  // it needs a block of its own rather than being left unowned.
  LinkReference: "paragraph",
  Blockquote: "quote",
  Table: "table",
  HorizontalRule: "hr",
  FencedCode: "code",
  CodeBlock: "code",
  HTMLBlock: "html",
  CommentBlock: "html",
  ProcessingInstructionBlock: "html",
};

/**
 * Block structure of a Markdown document, derived from the lezer tree built by
 * `@codemirror/lang-markdown` (`syntaxTree`) — never from blank-line heuristics,
 * which misread nested lists and fenced code that contains blank lines.
 *
 * Rules (`docs/typora-editor-impl-plan.md` §4):
 * - one block per `ListItem`, not one per list;
 * - quotes, tables and list items are atomic: their inner paragraphs, rows and
 *   code blocks are not split out, and a quote nested inside them stays part of
 *   them. The single exception is a list nested in an item — those items become
 *   blocks of their own;
 * - every other top-level node becomes one block of its own.
 *
 * Blocks come back in document order and may nest: a `listItem` that contains a
 * nested list also covers that list's items. Ask `blockAt` for the innermost
 * block at a position instead of assuming the list is flat.
 *
 * Pure: it reads the document text only, never an `EditorView`, and keeps no
 * state, so the same document always yields the same blocks.
 */
export function blocks(doc: Text, options?: BlocksOptions): Block[] {
  return blocksFromState(EditorState.create({ doc, extensions: BLOCK_LANGUAGE }), options);
}

/**
 * Same result as `blocks`, but reuses the parse tree of an existing state — the
 * form the decoration layer wants, since it already holds the editor's state
 * and must not pay for a second parse on every update.
 *
 * The state's language has to be Markdown with the GFM base (tables); see
 * `BLOCK_LANGUAGE`. A CommonMark-only state turns tables into paragraphs.
 */
export function blocksFromState(state: EditorState, options?: BlocksOptions): Block[] {
  const timeout = options?.timeout ?? DEFAULT_PARSE_TIMEOUT_MS;
  // `syntaxTree` alone may hold only the part that has been parsed so far;
  // forcing the parse up to the document end is what makes the walk complete.
  const tree = ensureSyntaxTree(state, state.doc.length, timeout) ?? syntaxTree(state);
  const result: Block[] = [];
  collectBlocks(tree.topNode, 0, result);
  result.sort(compareBlocks);
  return result;
}

/**
 * Innermost block containing `pos`, or `null` when the position falls in a gap
 * between blocks (blank lines between top-level nodes own nothing).
 */
export function blockAt(blocks: readonly Block[], pos: number): Block | null {
  let best: Block | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    if (pos < block.from || pos > block.to) continue;
    const span = block.to - block.from;
    // Nested list items overlap their parent item; the smallest range wins.
    if (span < bestSpan) {
      best = block;
      bestSpan = span;
    }
  }
  return best;
}

/**
 * The block that owns caret position `pos`, resolved from the tree that is
 * already parsed around it.
 *
 * `blockAt(blocks(state.doc), pos)` answers the same question, but `blocks()`
 * walks the entire document — fine for tests and tools, not for a cursor that
 * moves on every keypress. The rules are identical (this reuses `describeAtomic`
 * and the same container precedence), and `scripts/verify-live-preview.mjs`
 * cross-checks the two over every offset of a fixture.
 */
export function blockAtPosition(state: EditorState, pos: number): Block | null {
  const clamped = Math.max(0, Math.min(pos, state.doc.length));
  const tree = syntaxTree(state);
  // A caret sits *between* characters, so both edges of a block resolve outside
  // it: forward from the first character finds the block that starts here,
  // backward from the position after the last character finds the one that ends
  // here. Try the opening edge first — "the block I am about to type into" —
  // then the closing one.
  return blockFromChain(tree.resolveInner(clamped, 1)) ?? blockFromChain(tree.resolveInner(clamped, -1));
}

function blockFromChain(start: SyntaxNode): Block | null {
  let result: Block | null = null;

  for (let node: SyntaxNode | null = start; node; node = node.parent) {
    const name = node.name;
    if (name === "Document") break;

    // An outer item must not steal the block from the inner one the caret is in.
    if (name === "ListItem") {
      if (result?.kind !== "listItem") {
        result = { from: node.from, to: node.to, kind: "listItem", depth: listDepthOf(node) };
      }
      continue;
    }

    // Quotes and tables are atomic, and `blocks()` never descends into them, so
    // the outermost one is the block that gets rendered or degraded.
    if (name === "Blockquote" || name === "Table") {
      result = {
        from: node.from,
        to: node.to,
        kind: name === "Blockquote" ? "quote" : "table",
        depth: name === "Blockquote" ? 1 : 0,
      };
      continue;
    }

    if (result) continue;
    const described = describeAtomic(name);
    if (described) result = { from: node.from, to: node.to, kind: described.kind, depth: described.depth };
  }

  return result;
}

/** 1-based list nesting of a `ListItem`, counted from the lists above it. */
function listDepthOf(node: SyntaxNode): number {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "BulletList" || parent.name === "OrderedList") depth += 1;
  }
  return Math.max(1, depth);
}

/**
 * Walks block children in document order. `listDepth` is the level assigned to
 * `ListItem`s found directly in `node`'s children — 1 for a top-level list — so
 * entering a list always raises it by one.
 */function collectBlocks(node: SyntaxNode, listDepth: number, out: Block[]): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
      case "Document":
        collectBlocks(child, listDepth, out);
        break;
      // Lists are containers, not blocks: descend so each item can be its own
      // block, which is what makes the caret degrade one item at a time.
      case "BulletList":
      case "OrderedList":
        collectBlocks(child, listDepth + 1, out);
        break;
      case "ListItem": {
        out.push({ from: child.from, to: child.to, kind: "listItem", depth: listDepth });
        // Only nested lists are interesting here: the item's own paragraphs are
        // already covered by the item block and must not become blocks.
        for (let inner = child.firstChild; inner; inner = inner.nextSibling) {
          if (inner.name === "BulletList" || inner.name === "OrderedList") {
            collectBlocks(inner, listDepth + 1, out);
          }
        }
        break;
      }
      default: {
        // `ATOMIC_NODE_KINDS` covers every block node CommonMark + GFM emits.
        // An unseen one is still a block the caret can enter, so it keeps a
        // paragraph block rather than having its text left unowned.
        const described = describeAtomic(child.name) ?? { kind: "paragraph", depth: 0 };
        out.push({ from: child.from, to: child.to, kind: described.kind, depth: described.depth });
        break;
      }
    }
  }
}

function describeAtomic(name: string): { kind: BlockKind; depth: number } | null {
  if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
    // ATXHeading1…6 / SetextHeading1…2 — the trailing digit is the level.
    return { kind: "heading", depth: name.charCodeAt(name.length - 1) - 48 };
  }
  const kind = ATOMIC_NODE_KINDS[name];
  if (!kind) return null;
  // Quotes are never descended into, so an emitted quote is always top level.
  return { kind, depth: kind === "quote" ? 1 : 0 };
}

function compareBlocks(a: Block, b: Block): number {
  if (a.from !== b.from) return a.from - b.from;
  // Outer block first, so pre-order equals document order for nested items.
  if (a.to !== b.to) return b.to - a.to;
  if (a.kind === b.kind) return 0;
  return a.kind < b.kind ? -1 : 1;
}
