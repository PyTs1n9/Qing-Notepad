import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TileView from "./components/Tile/TileView";
import StickyNote from "./components/Sticky/StickyNote";
import CanvasTileView from "./components/Canvas/CanvasTileView";
import "./index.css";

// Disable the WebView's default context menu. A custom app menu can be mounted here later.
window.addEventListener("contextmenu", (event) => event.preventDefault());

const params = new URLSearchParams(window.location.search);
const isTile = params.get("tile") === "1";
const stickyNoteId = params.get("sticky");
const canvasTileId = params.get("canvasTile");
const wantsProbe = params.get("probe") === "1" && import.meta.env.DEV;

let content: React.ReactNode;
if (wantsProbe) {
  // Dev-only: verifies the blob-worker isolation the plugin runtime depends on.
  // `import.meta.env.DEV` is `false` in a production build, so this branch and
  // the dynamic import are removed by the bundler.
  void import("@/probe/workerProbe").then((module) => module.mountProbe());
  content = <div />;
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
    {content}
  </React.StrictMode>,
);
