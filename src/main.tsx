import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TileView from "./components/Tile/TileView";
import StickyNote from "./components/Sticky/StickyNote";
import CanvasTileView from "./components/Canvas/CanvasTileView";
import NoteWindowView from "./components/NoteWindow/NoteWindowView";
import RootErrorBoundary from "./components/Layout/RootErrorBoundary";
import "./index.css";

// Disable the WebView's default context menu. A custom app menu can be mounted here later.
window.addEventListener("contextmenu", (event) => event.preventDefault());

/**
 * Startup failures never reach an error boundary: a module that throws while
 * being evaluated (or a rejected top-level `invoke`) happens before React has a
 * tree, and the window simply stays at its background colour. Print the message
 * into the page instead of leaving a black screen.
 *
 * Only acts while the root is still empty — once React has mounted, render
 * errors belong to `RootErrorBoundary` and runtime errors belong to the console.
 */
window.addEventListener("error", (event) => {
  const root = document.getElementById("root");
  if (!root || root.childElementCount > 0) return;
  const detail = event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message;
  const panel = document.createElement("pre");
  panel.id = "startup-error";
  panel.textContent = `启动失败 / Startup failed\n\n${detail}`;
  panel.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:99999",
    "margin:0",
    "padding:24px",
    "overflow:auto",
    "white-space:pre-wrap",
    "background:#141518",
    "color:#ff9b9b",
    "font:12px/1.6 ui-monospace,Consolas,monospace",
  ].join(";");
  document.body.appendChild(panel);
});

const params = new URLSearchParams(window.location.search);
const isTile = params.get("tile") === "1";
const stickyNoteId = params.get("sticky");
const canvasTileId = params.get("canvasTile");
const noteWindowId = params.get("noteWindow");
const wantsProbe = params.get("probe") === "1" && import.meta.env.DEV;

// Applied before React mounts, not in an effect: the window is frameless and
// the first paint would otherwise be the WebView's white background.
if (noteWindowId) document.body.classList.add("note-window-body");

let content: React.ReactNode;
if (wantsProbe) {
  // Dev-only: verifies the blob-worker isolation the plugin runtime depends on.
  // `import.meta.env.DEV` is `false` in a production build, so this branch and
  // the dynamic import are removed by the bundler.
  void import("@/probe/workerProbe").then((module) => module.mountProbe());
  content = <div />;
} else if (noteWindowId) {
  content = <NoteWindowView noteId={noteWindowId} />;
} else if (canvasTileId) {
  content = <CanvasTileView />;
} else if (stickyNoteId) {
  content = <StickyNote noteId={stickyNoteId} />;
} else if (isTile) {
  content = <TileView />;
} else {
  content = <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>{content}</RootErrorBoundary>
  </React.StrictMode>,
);
