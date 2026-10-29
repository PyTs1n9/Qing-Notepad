/**
 * The editor handle: the one document plugins are allowed to touch, plus the
 * decoration layer they can paint on it.
 *
 * ## Why CodeMirror and not ProseMirror
 *
 * The note surface in this build is `MarkdownSourceEditor` — a CodeMirror 6
 * `EditorView` over the note's Markdown source (`NoteEditor.tsx` mounts it, and
 * the `source` view is the default). TipTap/ProseMirror exists only in the
 * canvas rich-text tool, which is not a note. So "document position" here means
 * a **CodeMirror document offset**: `0 … view.state.doc.length`, measured in
 * UTF-16 code units against the exact text that gets written to disk.
 *
 * That is a simpler model than ProseMirror positions (no node/mark tree to walk)
 * and it has one property worth stating: a plugin edits the same string the user
 * sees in source mode, so what it reads is what is saved.
 *
 * ## Why the module is separate from React
 *
 * `bridge.ts` (a plugin's host call) and `headless.ts` (worker teardown) both
 * need the editor, and neither may import a component. This module owns the
 * registry and the CodeMirror `StateField`; `NoteEditor.tsx` only publishes its
 * view and puts `pluginDecorations` in its extension list.
 */

import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/**
 * The only decoration kinds a plugin may ask for.
 *
 * Semantic names, not CSS: a plugin that could pass a class name could restyle
 * the editor, position an element over the app, or read the result. The mapping
 * from kind to `.qing-dec-<kind>` is fixed in `index.css`, where the theme tokens
 * live.
 */
export const DECORATION_KINDS = ["error", "warning", "success", "muted", "highlight"] as const;

export type DecorationKind = (typeof DECORATION_KINDS)[number];

export function isDecorationKind(value: unknown): value is DecorationKind {
  return typeof value === "string" && (DECORATION_KINDS as readonly string[]).includes(value);
}

export interface DecorationRange {
  from: number;
  to: number;
  kind: DecorationKind;
}

/**
 * Per-key ceiling. A mark is a DOM span, so 10 000 ranges is 10 000 elements in
 * the editor and a frozen UI on the next keystroke; the limit is enforced at the
 * bridge (with `E_TOO_LARGE`) rather than truncating silently here.
 */
export const MAX_DECORATION_RANGES = 1000;

export function decorationClass(kind: DecorationKind): string {
  return `qing-dec-${kind}`;
}

/** `pluginId::key` — the per-plugin, per-key bucket a decoration set lives in. */
function ownerKey(pluginId: string, key: string): string {
  return `${pluginId}::${key}`;
}

type DecorationAction =
  | { type: "set"; owner: string; ranges: readonly DecorationRange[] }
  | { type: "clear"; pluginId: string };

const applyDecorations = StateEffect.define<DecorationAction>();

function toDecorationSet(ranges: readonly DecorationRange[]): DecorationSet {
  return Decoration.set(
    ranges.map((range) =>
      Decoration.mark({ class: decorationClass(range.kind) }).range(range.from, range.to),
    ),
    // One owner's ranges are already ordered; the flattened read below sorts.
    true,
  );
}

/** Merge every owner's set into the one `DecorationSet` the view renders. */
function flatten(map: Map<string, DecorationSet>): DecorationSet {
  if (map.size === 0) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const set of map.values()) {
    const cursor = set.iter();
    while (cursor.value) {
      ranges.push(cursor.value.range(cursor.from, cursor.to));
      cursor.next();
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * The decoration state field. `Map<pluginId::key, DecorationSet>` is rebuilt per
 * transaction, which is the idiomatic CodeMirror shape: state is immutable, and
 * "clear one plugin's marks" is a map delete rather than a walk.
 *
 * Position drift is handled, not accepted: `set.map(transaction.changes)` moves
 * every mark through an edit, so typing above a mark keeps it on the text it was
 * attached to. (The P1a brief allowed "accept the drift"; CodeMirror makes the
 * correct behaviour one call, so accepting it would be a choice to be worse.)
 */
export const pluginDecorations: Extension = StateField.define<Map<string, DecorationSet>>({
  create: () => new Map(),

  update(map, transaction) {
    let next: Map<string, DecorationSet> | null = null;
    /** Copy-on-write: most transactions carry no decoration effect at all. */
    const writable = (): Map<string, DecorationSet> => {
      if (!next) next = new Map(map);
      return next;
    };

    if (transaction.docChanged) {
      for (const [owner, set] of map) {
        writable().set(owner, set.map(transaction.changes));
      }
    }

    for (const effect of transaction.effects) {
      if (!effect.is(applyDecorations)) continue;
      const action = effect.value;
      const target = writable();
      if (action.type === "clear") {
        const prefix = `${action.pluginId}::`;
        for (const owner of [...target.keys()]) {
          if (owner.startsWith(prefix)) target.delete(owner);
        }
        continue;
      }
      // An empty array is how a plugin clears one key.
      if (action.ranges.length === 0) target.delete(action.owner);
      else target.set(action.owner, toDecorationSet(action.ranges));
    }

    return next ?? map;
  },

  provide: (field) => EditorView.decorations.from(field, flatten),
});

// ---------------------------------------------------------------------------
// The active view
// ---------------------------------------------------------------------------

/**
 * The mounted note editor, or `null` when no note is open. Only one is ever
 * mounted: opening another note re-keys `MarkdownSourceEditor`, which destroys
 * the old view and publishes the new one through `onViewChange`.
 *
 * Two things this deliberately does *not* include:
 *
 * - **Preview mode is not "no editor".** Switching the note between source,
 *   preview and split only toggles a CSS class (`NoteEditor.tsx:807`), so the
 *   view stays mounted and plugins keep a working document while the user reads
 *   the rendered version.
 * - **Cloud notes are not published here.** `Workspace/CloudNoteEditor.tsx` is
 *   a separate CodeMirror instance backed by Yjs/Hocuspocus; it never calls
 *   `setActiveEditor`, so `qing.editor.*` answers `E_NO_EDITOR` while the
 *   workspace is open instead of writing into a collaborative document whose
 *   remote transaction merge has not been verified.
 */
let active: EditorView | null = null;

export function setActiveEditor(view: EditorView | null): void {
  active = view;
}

export function getActiveEditor(): EditorView | null {
  return active;
}

/**
 * Replace the marks one plugin painted under one key.
 *
 * The view is passed in rather than looked up so the caller has already
 * validated the ranges against *that* document — a stale registry entry cannot
 * turn into a write against the wrong note.
 */
export function setPluginDecorations(
  view: EditorView,
  pluginId: string,
  key: string,
  ranges: readonly DecorationRange[],
): void {
  view.dispatch({
    effects: applyDecorations.of({ type: "set", owner: ownerKey(pluginId, key), ranges }),
  });
}

/**
 * Drop every mark a plugin left, used when it is disabled, uninstalled, updated
 * or rolled back. Without this the decorations of a plugin that no longer exists
 * stay on screen until the note is reopened.
 *
 * Decorations are per mounted view, not persisted: reopening a note creates a
 * fresh `EditorState` with an empty map, so nothing can leak across notes.
 */
export function clearPluginDecorations(pluginId: string): void {
  const view = active;
  if (!view) return;
  try {
    view.dispatch({ effects: applyDecorations.of({ type: "clear", pluginId }) });
  } catch (error) {
    // Deactivation can race a note switch, and a disposed view throws. There is
    // nothing to clear on a view that is already gone.
    console.warn("[plugin] could not clear decorations:", error);
  }
}
