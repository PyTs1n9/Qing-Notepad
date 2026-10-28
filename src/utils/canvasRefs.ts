/**
 * Cross-surface signal between the canvas and the app shell.
 *
 * A reference node knows a note id but does not own routing: the canvas lives
 * inside one of several views, so it announces the intent and lets `App.tsx`
 * switch to the note view. Kept in its own module so both ends share one
 * literal instead of matching strings by hand.
 */
export const CANVAS_OPEN_NOTE_EVENT = "canvas:open-note";

export function requestOpenNoteFromCanvas(noteId: string): void {
  window.dispatchEvent(new CustomEvent<string>(CANVAS_OPEN_NOTE_EVENT, { detail: noteId }));
}
