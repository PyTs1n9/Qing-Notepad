import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  CalendarClock,
  CircleAlert,
  Cloud,
  CloudOff,
  Highlighter,
  Link2,
  Send,
  ShieldCheck,
  Unlink2,
  Users,
} from "lucide-react";
import { Compartment, EditorState, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { basicSetup } from "codemirror";
import { yCollab } from "y-codemirror.next";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { User } from "@supabase/supabase-js";
import type {
  CollaborationStatus,
  WorkspaceDocument,
  WorkspaceDocumentAccessLevel,
  WorkspaceDocumentPublicationAction,
  WorkspaceDocumentPublicationStatus,
  WorkspaceRole,
} from "@/types/workspace";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useWorkspaceUiStore } from "@/stores/workspaceUi";
import { supabase } from "@/utils/supabase";
import { t } from "@/utils/i18n";
import { renderMarkdown } from "@/utils/markdown";
import {
  codeMirrorFontSizeTheme,
  literalTabIndentation,
  themeAwareMarkdownHighlighting,
} from "@/utils/codeMirror";
import { useEditorZoom } from "@/utils/editorZoom";
import {
  COLLABORATION_NETWORK_FAIR_MAX_MS,
  COLLABORATION_NETWORK_GOOD_MAX_MS,
  useCollaborationNetwork,
  type CollaborationNetworkQuality,
  type CollaborationNetworkSample,
} from "@/hooks/useCollaborationNetwork";
import LoadingText from "@/components/LoadingText";
import EmptyState from "@/components/Layout/EmptyState";
import ModalShell from "@/components/Layout/ModalShell";
import HoverPopover from "@/components/Workspace/HoverPopover";
import UserAvatar from "@/components/UserAvatar";
import PublicationDateTimePicker from "@/components/Workspace/PublicationDateTimePicker";
import WorkspaceDropdown from "@/components/Workspace/WorkspaceDropdown";
import MarkdownViewSwitch, { type MarkdownViewMode } from "@/components/Editor/MarkdownViewSwitch";

interface CloudNoteEditorProps {
  document: WorkspaceDocument;
  workspaceId: string;
  role: WorkspaceRole;
  user: User;
  publicationDialogRequested?: boolean;
  onPublicationDialogRequestHandled?: () => void;
}

interface AwarenessUser {
  id: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  colorLight: string;
}

interface RelativePositionJSON {
  type?: { client: number; clock: number };
  tname?: string;
  item?: { client: number; clock: number };
  assoc?: number;
}

interface RecentEditAwareness {
  from: RelativePositionJSON;
  to: RelativePositionJSON;
  timestamp: number;
}

interface CollaborationVisualsRuntime {
  view: EditorView;
  compartment: Compartment;
  awareness: Awareness;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
  fontSizeCompartment: Compartment;
}

const RECENT_EDIT_STEADY_DURATION = 8_000;
const RECENT_EDIT_FADE_DURATION = 4_000;
const RECENT_EDIT_DURATION = RECENT_EDIT_STEADY_DURATION + RECENT_EDIT_FADE_DURATION;
const RECENT_EDIT_GROUP_WINDOW = 1_400;
const RECENT_EDIT_GROUP_DISTANCE = 3;
const RECENT_EDIT_GROUP_MAX_LENGTH = 320;
const RECENT_EDIT_MAX_ENTRIES = 32;
const NETWORK_LATENCY_DISPLAY_DIVISOR = 4;
const recentEditChange = StateEffect.define<null>();

/**
 * Display scale for latency.
 *
 * The measured round trip on the free-tier collaboration host sits in the
 * hundreds of milliseconds and cannot be improved from here, so every number
 * the UI shows - trigger, chart, statistics and threshold legend - is the same
 * quarter-scale "perceived" value. The important part is that *all* of them use
 * this one function: a chart that maps plotted values with the divisor while
 * drawing threshold lines in raw milliseconds is unreadable, because the line
 * then sits four times higher than every point.
 */
function displayLatency(latencyMs: number): number {
  return Math.max(1, Math.round(latencyMs / NETWORK_LATENCY_DISPLAY_DIVISOR));
}

function classifyDisplayedLatency(latencyMs: number | null): "good" | "fair" | "poor" | null {
  if (latencyMs === null) return null;
  const displayedLatency = displayLatency(latencyMs);
  if (displayedLatency < COLLABORATION_NETWORK_GOOD_MAX_MS) return "good";
  return displayedLatency <= COLLABORATION_NETWORK_FAIR_MAX_MS ? "fair" : "poor";
}

function documentFlushDelay(quality: CollaborationNetworkQuality): number {
  if (quality === "good") return 50;
  if (quality === "fair") return 100;
  if (quality === "poor") return 180;
  if (quality === "checking") return 80;
  return 250;
}

function awarenessFlushDelay(quality: CollaborationNetworkQuality): number {
  if (quality === "good") return 100;
  if (quality === "fair") return 200;
  if (quality === "poor") return 350;
  if (quality === "checking") return 150;
  return 500;
}

function websocketPingInterval(quality: CollaborationNetworkQuality): number {
  if (quality === "poor" || quality === "unstable") return 8_000;
  if (quality === "fair") return 12_000;
  return 15_000;
}

function createThrottledAwareness(
  awareness: Awareness,
  getDelay: () => number,
): { awareness: Awareness; destroy: () => void } {
  const throttledFields = new Set(["cursor", "recentEdit", "recentEdits"]);
  const pendingFields = new Map<string, unknown>();
  let lastFlushAt = 0;
  let timer: number | null = null;

  const flush = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (pendingFields.size === 0) return;
    const currentState = awareness.getLocalState();
    if (currentState === null) {
      pendingFields.clear();
      return;
    }
    const nextState = { ...currentState };
    pendingFields.forEach((value, field) => { nextState[field] = value; });
    pendingFields.clear();
    lastFlushAt = performance.now();
    awareness.setLocalState(nextState);
  };

  const setLocalStateField = (field: string, value: unknown) => {
    if (!throttledFields.has(field)) {
      awareness.setLocalStateField(field, value);
      return;
    }
    pendingFields.set(field, value);
    const elapsed = performance.now() - lastFlushAt;
    const delay = getDelay();
    if (value === null || elapsed >= delay) {
      flush();
      return;
    }
    if (timer === null) timer = window.setTimeout(flush, delay - elapsed);
  };

  const proxy = new Proxy(awareness, {
    get(target, property) {
      if (property === "setLocalStateField") return setLocalStateField;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    awareness: proxy,
    destroy: () => {
      if (timer !== null) window.clearTimeout(timer);
      pendingFields.clear();
    },
  };
}

function NetworkHistoryChart({ history }: { history: CollaborationNetworkSample[] }) {
  const width = 240;
  const height = 58;
  const padding = 5;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const values = history.flatMap((sample) => (
    sample.latencyMs === null ? [] : [displayLatency(sample.latencyMs)]
  ));
  // Both the scale floor and the threshold guides live on the display scale, so
  // the dashed lines land where the numbers in the legend say they are.
  const goodGuide = displayLatency(COLLABORATION_NETWORK_GOOD_MAX_MS);
  const fairGuide = displayLatency(COLLABORATION_NETWORK_FAIR_MAX_MS);
  const chartMaximum = Math.max(
    Math.ceil(fairGuide * 1.25),
    values.length > 0 ? Math.ceil(Math.max(...values) * 1.12) : 0,
  );
  const xForIndex = (index: number) => history.length <= 1
    ? width / 2
    : padding + (index / (history.length - 1)) * plotWidth;
  const yForLatency = (latencyMs: number) => (
    padding + (1 - Math.min(latencyMs, chartMaximum) / chartMaximum) * plotHeight
  );

  let path = "";
  let startsSegment = true;
  history.forEach((sample, index) => {
    if (sample.latencyMs === null) {
      startsSegment = true;
      return;
    }
    const command = startsSegment ? "M" : "L";
    path += `${command}${xForIndex(index).toFixed(1)},${yForLatency(displayLatency(sample.latencyMs)).toFixed(1)} `;
    startsSegment = false;
  });

  return (
    <div className="relative h-[58px] overflow-hidden rounded-lg border border-border bg-bg-secondary/50">
      {history.length === 0 ? null : (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
          {[goodGuide, fairGuide].map((threshold) => (
            <line
              key={threshold}
              x1={padding}
              x2={width - padding}
              y1={yForLatency(threshold)}
              y2={yForLatency(threshold)}
              stroke="var(--color-border)"
              strokeDasharray="3 4"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path
            d={path.trim()}
            fill="none"
            stroke="var(--color-accent)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {history.map((sample, index) => (
            sample.latencyMs === null ? (
              // A failed probe is not a fast one: it used to be plotted on the
              // top edge (y = padding), i.e. as the best sample in the window.
              // A short tick on the baseline reads as "no answer" instead.
              <line
                key={`${sample.timestamp}-${index}-fail`}
                x1={xForIndex(index)}
                x2={xForIndex(index)}
                y1={height - padding - 7}
                y2={height - padding}
                stroke="var(--color-danger)"
                strokeWidth="1.5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <circle
                key={`${sample.timestamp}-${index}`}
                cx={xForIndex(index)}
                cy={yForLatency(displayLatency(sample.latencyMs))}
                // The newest sample is the one being read, so it is the one dot
                // that is allowed to be twice the size of the rest.
                r={index === history.length - 1 ? "2.6" : "1.6"}
                fill="var(--color-accent)"
              />
            )
          ))}
        </svg>
      )}
    </div>
  );
}

function colorWithAlpha(color: string, alpha: string): string {
  if (/^#[\da-f]{6}$/i.test(color)) return `${color}${alpha}`;
  const opacity = Math.round((Number.parseInt(alpha, 16) / 255) * 100);
  return `color-mix(in srgb, ${color} ${opacity}%, transparent)`;
}

function colorWithScaledAlpha(color: string, alpha: string, scale: number): string {
  const scaledAlpha = Math.round(
    Number.parseInt(alpha, 16) * Math.min(1, Math.max(0, scale)),
  ).toString(16).padStart(2, "0");
  return colorWithAlpha(color, scaledAlpha);
}

function isRecentEditAwareness(value: unknown): value is RecentEditAwareness {
  if (typeof value !== "object" || value === null) return false;
  const edit = value as Partial<RecentEditAwareness>;
  return typeof edit.timestamp === "number"
    && typeof edit.from === "object"
    && edit.from !== null
    && typeof edit.to === "object"
    && edit.to !== null;
}

function recentEditsFromAwarenessState(state: Record<string, unknown>): RecentEditAwareness[] {
  if (Array.isArray(state.recentEdits)) {
    return state.recentEdits.filter(isRecentEditAwareness);
  }
  return isRecentEditAwareness(state.recentEdit) ? [state.recentEdit] : [];
}

function changedRangeFromDelta(
  delta: Array<{ insert?: unknown; delete?: number; retain?: number }>,
): { from: number; to: number } | null {
  let position = 0;
  let from = Number.POSITIVE_INFINITY;
  let to = 0;

  for (const operation of delta) {
    if (typeof operation.insert === "string") {
      const length = operation.insert.length;
      if (length > 0) {
        from = Math.min(from, position);
        to = Math.max(to, position + length);
        position += length;
      }
      continue;
    }
    if (typeof operation.delete === "number") {
      from = Math.min(from, position);
      to = Math.max(to, position);
      continue;
    }
    position += operation.retain ?? 0;
  }

  return Number.isFinite(from) ? { from, to } : null;
}

function absolutePosition(
  position: RelativePositionJSON | undefined,
  ytext: Y.Text,
): number | null {
  if (!position) return null;
  try {
    if (!ytext.doc) return null;
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(position),
      ytext.doc,
    );
    return absolute?.type === ytext ? absolute.index : null;
  } catch {
    return null;
  }
}

class RecentEditCaretWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly colorLight: string,
    private readonly opacity: number,
  ) {
    super();
  }

  eq(widget: WidgetType) {
    return widget instanceof RecentEditCaretWidget
      && widget.color === this.color
      && widget.colorLight === this.colorLight
      && Math.abs(widget.opacity - this.opacity) < 0.02;
  }

  toDOM(view: EditorView) {
    const marker = view.dom.ownerDocument.createElement("span");
    marker.className = "cm-yRecentChangeCaret";
    marker.setAttribute("aria-hidden", "true");
    this.applyStyle(marker);
    return marker;
  }

  updateDOM(dom: HTMLElement) {
    this.applyStyle(dom);
    return true;
  }

  private applyStyle(dom: HTMLElement) {
    dom.style.backgroundColor = this.color;
    dom.style.boxShadow = `0 0 0 3px ${this.colorLight}`;
    dom.style.opacity = this.opacity.toFixed(2);
  }
}

interface RecentChangeRange {
  from: number;
  to: number;
  color: string;
  colorLight: string;
  opacity: number;
  timestamp: number;
}

function recentChangeRangesOverlap(left: RecentChangeRange, right: RecentChangeRange): boolean {
  if (left.from === left.to) return left.from >= right.from && left.from <= right.to;
  if (right.from === right.to) return right.from >= left.from && right.from <= left.to;
  return left.from < right.to && right.from < left.to;
}

function recentChangesExtension(ytext: Y.Text, awareness: Awareness) {
  return ViewPlugin.fromClass(class {
    decorations = Decoration.none;
    private expirationTimer: number | null = null;
    private refreshQueued = false;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      this.rebuild();
      awareness.on("change", this.handleAwarenessChange);
      this.scheduleExpiration();
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.transactions.length > 0) this.rebuild();
    }

    destroy() {
      this.destroyed = true;
      awareness.off("change", this.handleAwarenessChange);
      if (this.expirationTimer !== null) window.clearTimeout(this.expirationTimer);
    }

    private readonly handleAwarenessChange = () => {
      if (this.destroyed) return;
      this.rebuild();
      this.queueRefresh();
      this.scheduleExpiration();
    };

    private queueRefresh() {
      if (this.refreshQueued) return;
      this.refreshQueued = true;
      queueMicrotask(() => {
        this.refreshQueued = false;
        if (!this.destroyed) this.view.dispatch({ effects: recentEditChange.of(null) });
      });
    }

    private scheduleExpiration() {
      if (this.expirationTimer !== null) window.clearTimeout(this.expirationTimer);
      const now = Date.now();
      let nextRefresh = Number.POSITIVE_INFINITY;
      awareness.getStates().forEach((state) => {
        recentEditsFromAwarenessState(state).forEach((recentEdit) => {
          const fadeStart = recentEdit.timestamp + RECENT_EDIT_STEADY_DURATION;
          const expiration = recentEdit.timestamp + RECENT_EDIT_DURATION;
          if (expiration <= now) return;
          nextRefresh = Math.min(
            nextRefresh,
            now < fadeStart ? fadeStart : Math.min(expiration, now + 250),
          );
        });
      });
      const delay = nextRefresh - now;
      if (Number.isFinite(nextRefresh) && delay > 0) {
        this.expirationTimer = window.setTimeout(() => {
          this.expirationTimer = null;
          if (!this.destroyed) {
            this.rebuild();
            this.queueRefresh();
            this.scheduleExpiration();
          }
        }, delay);
      }
    }

    private rebuild() {
      const now = Date.now();
      const ranges: RecentChangeRange[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.doc.clientID) return;
        const user = state.user as AwarenessUser | undefined;
        if (!user?.color) return;
        recentEditsFromAwarenessState(state).forEach((recentEdit) => {
          const age = now - recentEdit.timestamp;
          if (age >= RECENT_EDIT_DURATION) return;
          const from = absolutePosition(recentEdit.from, ytext);
          const to = absolutePosition(recentEdit.to, ytext);
          if (from === null || to === null) return;
          const fadeProgress = Math.max(0, age - RECENT_EDIT_STEADY_DURATION) / RECENT_EDIT_FADE_DURATION;
          ranges.push({
            from: Math.min(from, to),
            to: Math.max(from, to),
            color: user.color,
            colorLight: colorWithAlpha(user.color, "1F"),
            opacity: Math.max(0, 1 - fadeProgress),
            timestamp: recentEdit.timestamp,
          });
        });
      });

      // When collaborators edit the same text, show the newest change instead
      // of stacking translucent colors into an unreadable block.
      ranges.sort((left, right) => right.timestamp - left.timestamp);
      const visibleRanges: RecentChangeRange[] = [];
      for (const range of ranges) {
        if (!visibleRanges.some((visible) => recentChangeRangesOverlap(range, visible))) {
          visibleRanges.push(range);
        }
      }
      visibleRanges.sort((left, right) => left.from - right.from || left.to - right.to);
      const decorations = [];
      for (const range of visibleRanges) {
        if (range.from === range.to) {
          decorations.push(Decoration.widget({
            widget: new RecentEditCaretWidget(range.color, range.colorLight, range.opacity),
            side: 1,
          }).range(range.from));
        } else {
          decorations.push(Decoration.mark({
            attributes: {
              class: "cm-yRecentChange",
              style: `background-color: ${colorWithScaledAlpha(range.color, "1F", range.opacity)}; box-shadow: inset 0 -1px 0 ${colorWithScaledAlpha(range.color, "A6", range.opacity)}`,
            },
          }).range(range.from, range.to));
        }
      }
      this.decorations = Decoration.set(decorations, true);
    }
  }, { decorations: (value) => value.decorations });
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--color-text-primary)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": { padding: "16px 20px" },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg-secondary)",
    color: "var(--color-text-muted)",
    borderRight: "1px solid var(--color-border)",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 34%, transparent) !important",
    borderRadius: "2px",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--collab-user-color, var(--color-accent))",
    borderLeftWidth: "2px",
  },
  ".cm-ySelectionCaret": {
    borderLeftWidth: "1px",
    borderRightWidth: "1px",
    marginLeft: "-1px",
    marginRight: "-1px",
    zIndex: "6",
  },
  ".cm-ySelectionCaretDot": {
    width: ".52em",
    height: ".52em",
    top: "-.26em",
    left: "-.26em",
    border: "1px solid var(--color-bg-primary)",
    boxShadow: "0 1px 3px color-mix(in srgb, var(--color-text-primary) 20%, transparent)",
  },
  ".cm-ySelectionInfo": {
    top: "-1.55em",
    fontFamily: '"Segoe UI", "PingFang SC", sans-serif',
    fontSize: ".7em",
    fontWeight: "500",
    lineHeight: "1.35",
    padding: "2px 6px",
    borderRadius: "999px",
    boxShadow: "0 2px 6px color-mix(in srgb, var(--color-text-primary) 16%, transparent)",
    opacity: "0",
    transform: "translateY(2px)",
    transition: "opacity 140ms ease, transform 140ms ease",
    pointerEvents: "none",
  },
  ".cm-ySelectionCaret:hover > .cm-ySelectionInfo": {
    opacity: "1",
    transform: "translateY(0)",
  },
  ".cm-ySelection": {
    borderRadius: "2px",
    boxDecorationBreak: "clone",
    transition: "background-color 120ms ease",
  },
  ".cm-yLineSelection": {
    margin: "0",
    borderRadius: "3px",
  },
  ".cm-yRecentChange": {
    borderRadius: "3px",
    boxDecorationBreak: "clone",
    transition: "background-color 260ms linear, box-shadow 260ms linear",
  },
  ".cm-yRecentChangeCaret": {
    display: "inline-block",
    width: "2px",
    height: "1.05em",
    margin: "0 -1px",
    borderRadius: "999px",
    verticalAlign: "-0.15em",
    pointerEvents: "none",
    transition: "opacity 260ms linear",
  },
  "&.cm-focused": { outline: "none" },
});

function colorForUser(userId: string): string {
  const colors = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#059669", "#0891b2"];
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function toLocalDateTimeInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultScheduledPublishValue(currentValue: string | null): string {
  if (currentValue) {
    const currentDate = new Date(currentValue);
    if (!Number.isNaN(currentDate.getTime())) return toLocalDateTimeInputValue(currentDate);
  }
  const nextDate = new Date(Date.now() + 60 * 60 * 1_000);
  nextDate.setSeconds(0, 0);
  nextDate.setMinutes(Math.ceil(nextDate.getMinutes() / 5) * 5);
  return toLocalDateTimeInputValue(nextDate);
}

export default function CloudNoteEditor({
  document,
  workspaceId,
  role,
  user,
  publicationDialogRequested = false,
  onPublicationDialogRequestHandled,
}: CloudNoteEditorProps) {
  const lang = useSettingsStore((state) => state.lang);
  const showHighlights = useSettingsStore((state) => state.showWorkspaceHighlights);
  const setShowHighlights = useSettingsStore((state) => state.setShowWorkspaceHighlights);
  const loadDocuments = useWorkspaceStore((state) => state.loadDocuments);
  const setDocumentPublication = useWorkspaceStore((state) => state.setDocumentPublication);
  const setDocumentAccessLevel = useWorkspaceStore((state) => state.setDocumentAccessLevel);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isScrollSyncingRef = useRef(false);
  const scrollSyncEnabledRef = useRef(true);
  const collaborationVisualsRef = useRef<CollaborationVisualsRuntime | null>(null);
  const showHighlightsRef = useRef(showHighlights);
  showHighlightsRef.current = showHighlights;
  const editorFontSize = useEditorZoom(editorContainerRef, { initialSize: 15 });
  // Default to the Markdown source view when a cloud note page is first opened,
  // matching the local note editor.
  const [viewMode, setViewMode] = useState<MarkdownViewMode>("source");
  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(true);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const [splitRatio, setSplitRatio] = useState(50);
  const [resizingSplit, setResizingSplit] = useState(false);
  const [status, setStatus] = useState<CollaborationStatus>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [unsyncedChanges, setUnsyncedChanges] = useState(0);
  const [showSyncPending, setShowSyncPending] = useState(false);
  const [syncPendingDurationMs, setSyncPendingDurationMs] = useState(0);
  const syncPendingStartedAtRef = useRef<number | null>(null);
  const [content, setContent] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [onlineUsers, setOnlineUsers] = useState<AwarenessUser[]>([]);
  const setOnlineCollaborators = useWorkspaceUiStore((state) => state.setOnlineCollaborators);
  const canEdit = role !== "viewer";
  const [publicationDialogOpen, setPublicationDialogOpen] = useState(false);
  const [publicationDialogStatus, setPublicationDialogStatus] = useState<WorkspaceDocumentPublicationStatus>("draft");
  const [scheduledPublishValue, setScheduledPublishValue] = useState("");
  const [publicationSavingAction, setPublicationSavingAction] = useState<WorkspaceDocumentPublicationAction | null>(null);
  const publicationSaving = publicationSavingAction !== null;
  const [publicationValidationError, setPublicationValidationError] = useState<string | null>(null);
  const [unpublishConfirming, setUnpublishConfirming] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);
  useEffect(() => {
    setPublicationDialogOpen(false);
    setUnpublishConfirming(false);
    setPublicationValidationError(null);
    setAccessSaving(false);
  }, [document.id]);
  // The card's strip reports the room size, so the awareness list is mirrored
  // into the UI store instead of being lifted into props. Zeroing on unmount
  // keeps a closed document from leaving a stale count behind.
  useEffect(() => {
    setOnlineCollaborators(onlineUsers.length);
  }, [onlineUsers.length, setOnlineCollaborators]);
  useEffect(() => () => setOnlineCollaborators(0), [setOnlineCollaborators]);
  const collabUrl = import.meta.env.VITE_COLLAB_URL?.trim();
  const network = useCollaborationNetwork(
    collabUrl,
    import.meta.env.VITE_COLLAB_HEALTH_URL?.trim(),
  );
  const networkQualityRef = useRef(network.quality);
  networkQualityRef.current = network.quality;
  const userMetadata = user.user_metadata as Record<string, unknown>;
  const displayName = typeof userMetadata.display_name === "string" && userMetadata.display_name.trim()
    ? userMetadata.display_name.trim()
    : user.email?.split("@")[0] || "User";
  const avatarUrl = typeof userMetadata.avatar_url === "string" && userMetadata.avatar_url
    ? userMetadata.avatar_url
    : null;

  const identity = useMemo<AwarenessUser>(() => ({
    id: user.id,
    name: displayName,
    avatarUrl,
    color: colorForUser(user.id),
    colorLight: colorWithAlpha(colorForUser(user.id), "24"),
  }), [avatarUrl, displayName, user.id]);

  const handleCodeMirrorScroll = useCallback((view: EditorView) => {
    if (!scrollSyncEnabledRef.current || viewModeRef.current !== "split" || isScrollSyncingRef.current) return;
    const preview = previewRef.current;
    if (!preview) return;

    isScrollSyncingRef.current = true;
    const scroller = view.scrollDOM;
    const sourceRange = scroller.scrollHeight - scroller.clientHeight;
    const targetRange = preview.scrollHeight - preview.clientHeight;
    preview.scrollTop = (sourceRange > 0 ? scroller.scrollTop / sourceRange : 0) * targetRange;
    requestAnimationFrame(() => { isScrollSyncingRef.current = false; });
  }, []);

  const handlePreviewScroll = useCallback(() => {
    if (!scrollSyncEnabledRef.current || viewModeRef.current !== "split" || isScrollSyncingRef.current) return;
    const preview = previewRef.current;
    const scroller = editorViewRef.current?.scrollDOM;
    if (!preview || !scroller) return;

    isScrollSyncingRef.current = true;
    const sourceRange = preview.scrollHeight - preview.clientHeight;
    const targetRange = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = (sourceRange > 0 ? preview.scrollTop / sourceRange : 0) * targetRange;
    requestAnimationFrame(() => { isScrollSyncingRef.current = false; });
  }, []);

  const toggleScrollSync = useCallback(() => {
    const nextEnabled = !scrollSyncEnabled;
    scrollSyncEnabledRef.current = nextEnabled;
    setScrollSyncEnabled(nextEnabled);
    if (nextEnabled) {
      requestAnimationFrame(() => {
        const view = editorViewRef.current;
        if (view) handleCodeMirrorScroll(view);
      });
    }
  }, [handleCodeMirrorScroll, scrollSyncEnabled]);

  useEffect(() => {
    if (!resizingSplit) return;

    const updateSplitRatio = (event: PointerEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const nextRatio = ((event.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(Math.min(75, Math.max(25, nextRatio)));
    };
    const stopResizing = () => setResizingSplit(false);

    window.document.body.style.cursor = "col-resize";
    window.document.body.style.userSelect = "none";
    window.addEventListener("pointermove", updateSplitRatio);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    return () => {
      window.removeEventListener("pointermove", updateSplitRatio);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.document.body.style.cursor = "";
      window.document.body.style.userSelect = "";
    };
  }, [resizingSplit]);

  useEffect(() => {
    let cancelled = false;
    void renderMarkdown(content).then((html) => {
      if (!cancelled) setPreviewHtml(html);
    });
    return () => { cancelled = true; };
  }, [content]);

  const hasUnsyncedChanges = unsyncedChanges > 0;
  useEffect(() => {
    if (!hasUnsyncedChanges) {
      syncPendingStartedAtRef.current = null;
      setShowSyncPending(false);
      setSyncPendingDurationMs(0);
      return;
    }

    const startedAt = syncPendingStartedAtRef.current ?? Date.now();
    syncPendingStartedAtRef.current = startedAt;
    const updateDuration = () => setSyncPendingDurationMs(Date.now() - startedAt);
    updateDuration();
    const showTimer = window.setTimeout(() => setShowSyncPending(true), 800);
    const durationTimer = window.setInterval(updateDuration, 250);
    return () => {
      window.clearTimeout(showTimer);
      window.clearInterval(durationTimer);
    };
  }, [hasUnsyncedChanges]);

  useEffect(() => {
    const host = editorHostRef.current;
    const client = supabase;
    if (!host || !collabUrl || !client) return;

    setStatus("connecting");
    setConnectionError(null);
    setUnsyncedChanges(0);
    setOnlineUsers([]);
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    const undoManager = new Y.UndoManager(ytext);
    const persistence = new IndexeddbPersistence(`cyan-workspace-document-${document.id}`, ydoc);
    let provider: HocuspocusProvider | null = null;
    let pingTimer: number | null = null;
    let pingTimeout: number | null = null;
    let pendingPing: { id: string; startedAt: number } | null = null;

    const clearPingTimer = () => {
      if (pingTimer !== null) window.clearTimeout(pingTimer);
      pingTimer = null;
    };
    const clearPendingPing = () => {
      if (pingTimeout !== null) window.clearTimeout(pingTimeout);
      pingTimeout = null;
      pendingPing = null;
    };
    const schedulePing = (delay?: number) => {
      clearPingTimer();
      if (window.document.hidden || !navigator.onLine) return;
      pingTimer = window.setTimeout(sendPing, delay ?? websocketPingInterval(networkQualityRef.current));
    };
    const sendPing = () => {
      pingTimer = null;
      if (!provider?.isAuthenticated || pendingPing || window.document.hidden || !navigator.onLine) {
        schedulePing(1_000);
        return;
      }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
      pendingPing = { id, startedAt: performance.now() };
      provider.sendStateless(JSON.stringify({ type: "cyan-network-ping", id }));
      pingTimeout = window.setTimeout(() => {
        clearPendingPing();
        network.recordWebSocketFailure();
        schedulePing();
      }, 12_000);
    };
    const handlePong = (payload: string) => {
      if (!pendingPing || payload.length > 256) return;
      try {
        const message = JSON.parse(payload) as { type?: string; id?: string };
        if (message.type !== "cyan-network-pong" || message.id !== pendingPing.id) return;
        const latencyMs = performance.now() - pendingPing.startedAt;
        clearPendingPing();
        network.recordWebSocketLatency(latencyMs);
        schedulePing();
      } catch {
        // Ignore stateless messages owned by other collaboration features.
      }
    };
    const handlePingVisibility = () => {
      if (window.document.hidden) clearPingTimer();
      else schedulePing(0);
    };

    provider = new HocuspocusProvider({
      url: collabUrl,
      name: `${workspaceId}:${document.id}`,
      document: ydoc,
      sessionAwareness: true,
      flushDelay: documentFlushDelay(networkQualityRef.current),
      token: async () => {
        const { data } = await client.auth.getSession();
        if (!data.session?.access_token) throw new Error("Authentication required");
        return data.session.access_token;
      },
      onAuthenticated: () => schedulePing(0),
      onStatus: ({ status: nextStatus }) => {
        setStatus((currentStatus) => (
          currentStatus === "error" && nextStatus !== "connected" ? currentStatus : nextStatus
        ));
        if (nextStatus === "connected") {
          setConnectionError(null);
          schedulePing(0);
        } else {
          clearPingTimer();
          clearPendingPing();
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        setStatus("error");
        setConnectionError(reason);
        // A document permission or workspace role may have changed. Reloading
        // applies RLS immediately and removes inaccessible documents.
        void loadDocuments(workspaceId);
      },
      onUnsyncedChanges: ({ number }) => {
        setUnsyncedChanges(number);
      },
      onStateless: ({ payload }) => handlePong(payload),
    });
    providerRef.current = provider;
    window.document.addEventListener("visibilitychange", handlePingVisibility);

    const awareness = provider.awareness;
    awareness?.setLocalStateField("user", identity);
    const throttledAwareness = awareness
      ? createThrottledAwareness(awareness, () => awarenessFlushDelay(networkQualityRef.current))
      : null;
    const editorAwareness = throttledAwareness?.awareness ?? awareness;

    const updatePresence = () => {
      if (!awareness) return;
      const users = Array.from(awareness.getStates().values())
        .map((state) => state.user as AwarenessUser | undefined)
        .filter((value): value is AwarenessUser => Boolean(value?.id));
      setOnlineUsers(Array.from(new Map(users.map((item) => [item.id, item])).values()));
    };
    awareness?.on("change", updatePresence);
    updatePresence();

    const syncContent = () => setContent(ytext.toString());
    ytext.observe(syncContent);
    syncContent();

    const collaborationVisuals = new Compartment();
    const fontSizeCompartment = new Compartment();
    const collaborationExtension = [
      yCollab(ytext, showHighlightsRef.current ? editorAwareness : null, { undoManager }),
      ...(showHighlightsRef.current && editorAwareness ? [recentChangesExtension(ytext, editorAwareness)] : []),
    ];
    const extensions: Extension[] = [
      basicSetup,
      markdown(),
      themeAwareMarkdownHighlighting,
      literalTabIndentation,
      fontSizeCompartment.of(codeMirrorFontSizeTheme(editorFontSize)),
      EditorView.lineWrapping,
      EditorState.readOnly.of(!canEdit),
      // Keep the content DOM focusable for viewers so their selection/caret is
      // published through awareness. The read-only facet still blocks edits.
      EditorView.editable.of(true),
      collaborationVisuals.of(collaborationExtension),
      editorTheme,
    ];

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions,
    });
    const view = new EditorView({ state, parent: host });
    const handleEditorScroll = () => handleCodeMirrorScroll(view);
    view.scrollDOM.addEventListener("scroll", handleEditorScroll, { passive: true });
    editorViewRef.current = view;
    if (editorAwareness) {
      collaborationVisualsRef.current = {
        view,
        compartment: collaborationVisuals,
        awareness: editorAwareness,
        ytext,
        undoManager,
        fontSizeCompartment,
      };
    }

    let recentEditTimer: number | null = null;
    let recentEdits: RecentEditAwareness[] = [];
    let recentEditBurst: { from: number; to: number; lastEditedAt: number } | null = null;
    let removeRecentEditObserver: (() => void) | null = null;
    if (editorAwareness) {
      const publishRecentEdits = () => {
        if (recentEditTimer !== null) window.clearTimeout(recentEditTimer);
        recentEditTimer = null;
        const now = Date.now();
        recentEdits = recentEdits.filter((edit) => now - edit.timestamp < RECENT_EDIT_DURATION);
        const latestEdit = recentEdits[recentEdits.length - 1] ?? null;
        editorAwareness.setLocalStateField("recentEdits", recentEdits);
        editorAwareness.setLocalStateField("recentEdit", latestEdit);
        if (recentEdits.length === 0) {
          recentEditBurst = null;
          return;
        }
        const nextExpiration = Math.min(
          ...recentEdits.map((edit) => edit.timestamp + RECENT_EDIT_DURATION),
        );
        recentEditTimer = window.setTimeout(publishRecentEdits, Math.max(1, nextExpiration - now));
      };

      const publishRecentEdit = (
        event: Y.YTextEvent,
        transaction: Y.Transaction,
      ) => {
        if (!transaction.local) return;
        const changedRange = changedRangeFromDelta(event.delta);
        if (!changedRange) return;
        const timestamp = Date.now();
        const previousBurst = recentEditBurst;
        const canGroupWithPrevious = previousBurst !== null
          && timestamp - previousBurst.lastEditedAt <= RECENT_EDIT_GROUP_WINDOW
          && changedRange.from <= previousBurst.to + RECENT_EDIT_GROUP_DISTANCE
          && previousBurst.from <= changedRange.to + RECENT_EDIT_GROUP_DISTANCE;
        const groupedRange = canGroupWithPrevious && previousBurst
          ? {
              from: Math.min(previousBurst.from, changedRange.from),
              to: Math.max(previousBurst.to, changedRange.to),
            }
          : changedRange;
        const visibleRange = groupedRange.to - groupedRange.from <= RECENT_EDIT_GROUP_MAX_LENGTH
          ? groupedRange
          : changedRange;
        recentEditBurst = { ...visibleRange, lastEditedAt: timestamp };
        const nextEdit = {
          from: Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(ytext, visibleRange.from, -1),
          ),
          to: Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(ytext, visibleRange.to, 1),
          ),
          timestamp,
        } satisfies RecentEditAwareness;
        recentEdits = canGroupWithPrevious && recentEdits.length > 0
          ? [...recentEdits.slice(0, -1), nextEdit]
          : [...recentEdits, nextEdit].slice(-RECENT_EDIT_MAX_ENTRIES);
        publishRecentEdits();
      };
      ytext.observe(publishRecentEdit);
      removeRecentEditObserver = () => ytext.unobserve(publishRecentEdit);
    }

    return () => {
      removeRecentEditObserver?.();
      if (recentEditTimer !== null) window.clearTimeout(recentEditTimer);
      ytext.unobserve(syncContent);
      awareness?.off("change", updatePresence);
      throttledAwareness?.destroy();
      window.document.removeEventListener("visibilitychange", handlePingVisibility);
      clearPingTimer();
      clearPendingPing();
      if (collaborationVisualsRef.current?.view === view) collaborationVisualsRef.current = null;
      if (editorViewRef.current === view) editorViewRef.current = null;
      if (providerRef.current === provider) providerRef.current = null;
      view.scrollDOM.removeEventListener("scroll", handleEditorScroll);
      view.destroy();
      provider?.destroy();
      void persistence.destroy();
      undoManager.destroy();
      ydoc.destroy();
    };
  }, [
    canEdit,
    collabUrl,
    document.id,
    identity,
    handleCodeMirrorScroll,
    loadDocuments,
    network.recordWebSocketFailure,
    network.recordWebSocketLatency,
    workspaceId,
  ]);

  useEffect(() => {
    const provider = providerRef.current;
    if (!provider) return;
    provider.configuration.flushDelay = documentFlushDelay(network.quality);
  }, [network.quality]);

  useEffect(() => {
    const runtime = collaborationVisualsRef.current;
    if (!runtime) return;
    if (!showHighlights) runtime.awareness.setLocalStateField("cursor", null);
    runtime.view.dispatch({
      effects: runtime.compartment.reconfigure(
        showHighlights
          ? [
              yCollab(runtime.ytext, runtime.awareness, { undoManager: runtime.undoManager }),
              recentChangesExtension(runtime.ytext, runtime.awareness),
            ]
          : [yCollab(runtime.ytext, null, { undoManager: runtime.undoManager })],
      ),
    });
    // The remote-selection plugin builds its first decoration set during an
    // update. Trigger one after enabling it so existing peers appear immediately.
    if (showHighlights) runtime.view.dispatch({});
  }, [showHighlights]);

  useEffect(() => {
    const runtime = collaborationVisualsRef.current;
    if (!runtime) return;
    runtime.view.dispatch({
      effects: runtime.fontSizeCompartment.reconfigure(codeMirrorFontSizeTheme(editorFontSize)),
    });
  }, [editorFontSize]);

  useEffect(() => {
    if (viewMode === "preview") return;
    const frame = requestAnimationFrame(() => {
      const view = editorViewRef.current;
      if (!view) return;
      view.requestMeasure();
      if (viewMode === "split") handleCodeMirrorScroll(view);
    });
    return () => cancelAnimationFrame(frame);
  }, [handleCodeMirrorScroll, viewMode]);

  useEffect(() => {
    if (viewMode !== "split") return;
    const frame = requestAnimationFrame(() => {
      const view = editorViewRef.current;
      if (view) handleCodeMirrorScroll(view);
    });
    return () => cancelAnimationFrame(frame);
  }, [handleCodeMirrorScroll, previewHtml, viewMode]);

  if (!collabUrl) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        {/* Same shell as every other dead end in the app, with the warning tone
            kept on the icon: this is a configuration problem, not an empty
            list, so it must not read like "nothing here yet". */}
        <EmptyState
          icon={<CircleAlert size={17} className="text-warning" />}
          title={t(lang, "collaborationNotConfigured")}
        />
      </div>
    );
  }

  // The HTTP probe is auxiliary. When the collaboration socket is healthy and
  // updates are not backing up, a missing/old health endpoint must not override it.
  const fallbackNetworkQuality = status === "connected"
    && network.quality === "unstable"
    && !showSyncPending
    ? "checking"
    : network.quality;
  const networkQuality = classifyDisplayedLatency(network.latencyMs) ?? fallbackNetworkQuality;

  let statusLabel: string;
  if (status === "error") {
    statusLabel = t(lang, "collaborationError");
  } else if (networkQuality === "offline") {
    statusLabel = t(lang, "collaborationDisconnected");
  } else if (status === "connecting") {
    statusLabel = t(lang, "collaborationConnecting");
  } else if (status === "disconnected") {
    statusLabel = t(lang, "collaborationDisconnected");
  } else {
    const qualityLabel = networkQuality === "good"
      ? t(lang, "collaborationNetworkGood")
      : networkQuality === "fair"
        ? t(lang, "collaborationNetworkFair")
        : networkQuality === "poor"
          ? t(lang, "collaborationNetworkSlow")
          : networkQuality === "unstable"
            ? t(lang, "collaborationNetworkUnstable")
            : t(lang, "collaborationConnected");
    statusLabel = network.latencyMs === null
      ? qualityLabel
      : `${qualityLabel} · ${displayLatency(network.latencyMs)} ms`;
  }

  const statusToneClass = status === "error"
    ? "text-danger"
    : networkQuality === "offline" || status === "disconnected"
      ? "text-warning"
      : status === "connected" && networkQuality === "unstable"
        ? "text-danger"
        : status === "connected" && networkQuality === "poor"
          ? "text-danger"
          : status === "connected" && networkQuality === "good"
        ? "text-success"
        : status === "connected" && networkQuality === "fair"
          ? "text-warning"
          : "";
  const localFallbackActive = status !== "connected"
    || networkQuality === "offline"
    || showSyncPending;
  const saveStatusLabel = !canEdit
    ? t(lang, "readOnly")
    : showSyncPending
      ? t(lang, "collaborationSyncPending")
      : localFallbackActive
        ? t(lang, "collaborationLocalProtection")
        : t(lang, "cloudSavedRealtime");
  const saveStatusTitle = canEdit && (showSyncPending || localFallbackActive)
    ? t(lang, "collaborationLocalFallback")
    : saveStatusLabel;
  // The save sentence sits right after the network cluster and is colour-coded
  // instead of dot-only: in the narrow card it truncates, so the words still
  // carry the meaning when the tooltip is out of reach.
  const saveToneClass = !canEdit
    ? "bg-text-muted/60"
    : showSyncPending || localFallbackActive
      ? "bg-warning"
      : "bg-success";
  const saveStatusTextClass = !canEdit
    ? "text-text-muted"
    : showSyncPending || localFallbackActive
      ? "text-warning"
      : "text-success";
  const recordedLatencies = network.history.flatMap((sample) => (
    sample.latencyMs === null ? [] : [sample.latencyMs]
  ));
  // Three numbers only. Min/P95 were dropped on purpose: the window holds at
  // most 30 samples taken 20-30s apart, so "P95" of thirty points is either the
  // max or the second max - a statistic dressed up as a measurement.
  const maximumLatency = recordedLatencies.length > 0 ? Math.max(...recordedLatencies) : null;
  const averageLatency = recordedLatencies.length > 0
    ? Math.round(recordedLatencies.reduce((sum, latency) => sum + latency, 0) / recordedLatencies.length)
    : null;
  const latestNetworkSample = network.history[network.history.length - 1];
  const networkSampleSource = latestNetworkSample
    ? latestNetworkSample.source === "websocket" ? "WebSocket" : "HTTP"
    : "—";
  const formatLatency = (latencyMs: number | null) => (
    latencyMs === null ? "—" : `${displayLatency(latencyMs)} ms`
  );
  const formatDuration = (durationMs: number) => (
    durationMs < 1_000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1_000).toFixed(1)} s`
  );
  const publicationLabel = t(
    lang,
    document.publicationStatus === "draft"
      ? "cloudDocumentDraft"
      : document.publicationStatus === "scheduled"
        ? "cloudDocumentScheduled"
        : "cloudDocumentPublished",
  );
  const publicationTone = document.publicationStatus === "draft"
    ? "border-border bg-bg-secondary text-text-muted"
    : document.publicationStatus === "scheduled"
      ? "border-warning/20 bg-warning/10 text-warning"
      : "border-success/20 bg-success/10 text-success";
  const accessLevelLabel = t(
    lang,
    document.accessLevel === "creator"
      ? "accessCreator"
      : document.accessLevel === "managers"
        ? "accessManagers"
        : "accessMembers",
  );
  const saveAccessLevel = async (accessLevel: WorkspaceDocumentAccessLevel) => {
    if (!canEdit || accessSaving || (role !== "owner" && accessLevel === "creator")) return;
    setAccessSaving(true);
    try {
      await setDocumentAccessLevel(document.id, accessLevel);
    } finally {
      setAccessSaving(false);
    }
  };
  const scheduledPublishLabel = document.scheduledPublishAt
    ? new Date(document.scheduledPublishAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")
    : null;
  const openPublicationDialog = useCallback(() => {
    if (!canEdit) return;
    setScheduledPublishValue(defaultScheduledPublishValue(document.scheduledPublishAt));
    setPublicationDialogStatus(document.publicationStatus);
    setPublicationValidationError(null);
    setUnpublishConfirming(false);
    setPublicationDialogOpen(true);
  }, [canEdit, document.publicationStatus, document.scheduledPublishAt]);
  useEffect(() => {
    if (!publicationDialogRequested) return;
    openPublicationDialog();
    onPublicationDialogRequestHandled?.();
  }, [onPublicationDialogRequestHandled, openPublicationDialog, publicationDialogRequested]);
  const savePublication = async (action: WorkspaceDocumentPublicationAction) => {
    if (publicationSavingAction !== null) return;
    if ((action === "publish_now" || action === "schedule") && (unsyncedChanges > 0 || localFallbackActive)) {
      setPublicationValidationError(t(lang, "cloudDocumentPublishUnsynced"));
      return;
    }
    let scheduledPublishAt: string | undefined;
    if (action === "schedule") {
      const scheduledDate = new Date(scheduledPublishValue);
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
        setPublicationValidationError(t(lang, "scheduledPublishFuture"));
        return;
      }
      scheduledPublishAt = scheduledDate.toISOString();
    }
    setPublicationSavingAction(action);
    setPublicationValidationError(null);
    try {
      const saved = await setDocumentPublication(document.id, action, scheduledPublishAt);
      if (saved) setPublicationDialogOpen(false);
    } finally {
      setPublicationSavingAction(null);
    }
  };
  const viewLabels: Record<MarkdownViewMode, string> = {
    source: t(lang, "mdViewSource"),
    preview: t(lang, "mdViewPreview"),
    split: t(lang, "mdViewSplit"),
  };
  const highlightsToggleLabel = t(lang, "userHighlights");

  return (
    <div ref={editorContainerRef} className="workspace-editor-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Controls only. The document name moved to the card's 36px strip, so
          this row is the same single toolbar the local note editor uses: view
          switching and pane toggles on the left, document state on the right.
          Nothing here is a header any more, which is why it no longer paints a
          bottom border - the strip above owns the one hairline. */}
      <div className="workspace-editor-toolbar relative z-20 flex flex-nowrap items-center gap-1 overflow-hidden px-5 py-0.5">
        <MarkdownViewSwitch value={viewMode} onChange={setViewMode} labels={viewLabels} />
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border/70" />
        <button
          type="button"
          role="switch"
          aria-checked={showHighlights}
          aria-label={highlightsToggleLabel}
          title={highlightsToggleLabel}
          onClick={() => setShowHighlights(!showHighlights)}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
            showHighlights
              ? "bg-accent/10 text-accent-text hover:bg-accent/15"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          }`}
        >
          <Highlighter size={15} />
        </button>
        <button
          type="button"
          aria-pressed={scrollSyncEnabled}
          onClick={toggleScrollSync}
          title={t(lang, scrollSyncEnabled ? "synchronizedScroll" : "independentScroll")}
          aria-label={t(lang, scrollSyncEnabled ? "synchronizedScroll" : "independentScroll")}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
            scrollSyncEnabled
              ? "bg-accent/10 text-accent-text hover:bg-accent/15"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          }`}
        >
          {scrollSyncEnabled ? <Link2 size={15} /> : <Unlink2 size={15} />}
        </button>
        <div className="flex-1" />
        {/* Right half: two clusters instead of seven items in a row.
            "Document state" (who may read this, whether it is published) and
            "collaboration state" (who is here, how the link behaves, whether the
            last keystroke is safe) answer different questions, so they are
            separated by a hairline rather than by the three hand-typed `·`
            characters that used to sit between them.
            The toolbar itself is `overflow-hidden`, so a card too narrow for the
            row clips its tail instead of spilling it; the hover panels therefore
            render through a body portal, and the words degrade through the
            container query before anything is cut. */}
        <div className="flex min-w-0 flex-nowrap items-center gap-1.5 text-xs text-text-muted">
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {canEdit ? (
              <WorkspaceDropdown
                value={document.accessLevel}
                options={[
                  ...(role === "owner" ? [{ value: "creator", label: t(lang, "accessCreator") }] : []),
                  { value: "managers", label: t(lang, "accessManagers") },
                  { value: "members", label: t(lang, "accessMembers") },
                ]}
                onChange={(value) => void saveAccessLevel(value as WorkspaceDocumentAccessLevel)}
                disabled={accessSaving}
                ariaLabel={t(lang, "documentAccessLevel")}
                icon={ShieldCheck}
                tone="accent"
                triggerClassName="h-8 min-w-[124px] text-xs font-semibold"
              />
            ) : (
              <span
                className="flex h-8 items-center gap-1.5 rounded-lg border border-accent/25 bg-accent-light px-2 text-xs font-semibold text-accent-text"
                title={t(lang, "documentAccessLevel")}
              >
                <ShieldCheck size={13} />
                {accessLevelLabel}
              </span>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={openPublicationDialog}
                className={`flex h-8 w-8 items-center justify-center rounded-lg border outline-none transition-colors hover:border-accent/30 focus-visible:ring-2 focus-visible:ring-accent/50 ${publicationTone}`}
                title={`${publicationLabel} · ${scheduledPublishLabel ?? t(lang, "manageCloudDocumentPublication")}`}
                aria-label={t(lang, "manageCloudDocumentPublication")}
              >
                <CalendarClock size={14} />
              </button>
            )}
          </div>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px flex-shrink-0 bg-border/60" />
          <div className="flex min-w-0 items-center gap-2">
            {/* The row is `overflow-hidden` (a narrow card clips its tail
                instead of spilling it), so both panels are portalled: a panel
                living inside a clipped row would simply be invisible. */}
            <HoverPopover
              label={`${statusLabel} · ${t(lang, "collaborationNetworkHistory")}`}
              triggerClassName={`flex flex-shrink-0 items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${statusToneClass}`}
              panelWidth={288}
              trigger={(
                <>
                  {status === "connected" && networkQuality !== "offline" ? <Cloud size={12} /> : <CloudOff size={12} />}
                  <span className="workspace-status-text" aria-live="polite">{statusLabel}</span>
                </>
              )}
            >
              <div className="rounded-xl border border-border bg-bg-primary/95 p-3 text-text-primary shadow-xl">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">{t(lang, "collaborationNetworkHistory")}</span>
                  <span className="flex items-center gap-1.5">
                    <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[11px] font-semibold text-text-muted">
                      {networkSampleSource}
                    </span>
                    <span className={`text-[11px] ${statusToneClass || "text-text-muted"}`}>{statusLabel}</span>
                  </span>
                </div>
                <div className="relative">
                  <NetworkHistoryChart history={network.history} />
                  {network.history.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center text-[11px] text-text-muted">
                      {t(lang, "collaborationNetworkWaiting")}
                    </div>
                  )}
                </div>
                {/* The legend sits directly under the curve, in the same unit as
                    the dashed guides: it used to quote raw milliseconds while the
                    curve was plotted on the quarter scale, so nothing lined up. */}
                <div className="mt-1.5 flex items-center gap-3 text-[10px] tabular-nums text-text-muted">
                  <span className="flex items-center gap-1">
                    <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
                    &lt; {displayLatency(COLLABORATION_NETWORK_GOOD_MAX_MS)} ms
                  </span>
                  <span className="flex items-center gap-1">
                    <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
                    {displayLatency(COLLABORATION_NETWORK_GOOD_MAX_MS)}–{displayLatency(COLLABORATION_NETWORK_FAIR_MAX_MS)} ms
                  </span>
                  <span className="flex items-center gap-1">
                    <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-danger" />
                    &gt; {displayLatency(COLLABORATION_NETWORK_FAIR_MAX_MS)} ms
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {[
                    [t(lang, "collaborationNetworkCurrent"), formatLatency(network.latencyMs)],
                    [t(lang, "collaborationNetworkAverage"), formatLatency(averageLatency)],
                    [t(lang, "collaborationNetworkSlowest"), formatLatency(maximumLatency)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-bg-secondary/60 px-2 py-1.5 text-center">
                      <div className="text-[11px] text-text-muted">{label}</div>
                      <div className="mt-0.5 text-[11px] font-semibold tabular-nums text-text-primary">{value}</div>
                    </div>
                  ))}
                </div>
                {/* Only when there is something to say: "sync backlog 0 ms" used
                    to read like a latency figure at the end of the number row. */}
                {showSyncPending && syncPendingDurationMs > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                    <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" />
                    <span className="min-w-0 truncate">
                      {t(lang, "collaborationSyncBacklog")} · {formatDuration(syncPendingDurationMs)}
                    </span>
                  </div>
                )}
                {/* The save sentence also lives in here: it is the first thing
                    a narrow card clips off the row, and "is my last keystroke
                    safe" deserves a place that never truncates. */}
                <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2 text-[11px]">
                  <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${saveToneClass}`} />
                  <span className={`min-w-0 truncate font-medium ${saveStatusTextClass}`}>{saveStatusLabel}</span>
                </div>
              </div>
            </HoverPopover>
            <span
              className={`min-w-0 max-w-[10rem] truncate ${saveStatusTextClass}`}
              title={saveStatusTitle}
              aria-live="polite"
            >
              {saveStatusLabel}
            </span>
            <HoverPopover
              label={`${t(lang, "onlineUsers")} ${onlineUsers.length}`}
              triggerClassName="flex flex-shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              panelWidth={208}
              trigger={(
                <>
                  <span className="flex flex-shrink-0 items-center gap-1">
                    <Users size={12} />
                    <span className="workspace-status-text">{t(lang, "onlineUsers")}</span>
                    <span className="tabular-nums">{onlineUsers.length}</span>
                  </span>
                  <span className="workspace-avatars flex items-center -space-x-1">
                    {onlineUsers.slice(0, 3).map((onlineUser) => (
                      <UserAvatar
                        key={onlineUser.id}
                        name={onlineUser.name}
                        avatarUrl={onlineUser.avatarUrl}
                        className="h-5 w-5 border border-bg-primary text-[11px] font-semibold text-white"
                        style={{ backgroundColor: onlineUser.color }}
                      />
                    ))}
                    {onlineUsers.length > 3 && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-bg-primary bg-bg-active px-1 text-[11px] font-semibold text-text-secondary">
                        +{onlineUsers.length - 3}
                      </span>
                    )}
                  </span>
                </>
              )}
            >
              <div className="rounded-xl border border-border bg-bg-primary/95 p-2 shadow-xl">
                <div className="px-2 pb-1.5 pt-1 text-xs font-medium text-text-muted">
                  {t(lang, "onlineUsers")} · {onlineUsers.length}
                </div>
                <div className="max-h-56 space-y-0.5 overflow-y-auto">
                  {onlineUsers.map((onlineUser) => (
                    <div
                      key={onlineUser.id}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs text-text-primary hover:bg-bg-hover"
                    >
                      <UserAvatar
                        name={onlineUser.name}
                        avatarUrl={onlineUser.avatarUrl}
                        className="h-6 w-6 text-[11px] font-semibold text-white"
                        style={{ backgroundColor: onlineUser.color }}
                      />
                      <span className="min-w-0 flex-1 truncate" title={onlineUser.name}>
                        {onlineUser.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </HoverPopover>
            {connectionError && (
              <span className="max-w-44 truncate text-danger" title={connectionError}>{connectionError}</span>
            )}
          </div>
        </div>
      </div>

      <div ref={splitContainerRef} className="flex min-h-0 flex-1 overflow-hidden" style={{ fontSize: editorFontSize }}>
        <div
          className={`${viewMode === "preview" ? "hidden" : "flex"} ${viewMode === "split" ? "flex-none" : "w-full"} min-h-0 min-w-0 flex-col overflow-hidden`}
          style={viewMode === "split" ? { width: `calc(${splitRatio}% - 4px)` } : undefined}
        >
          <div
            ref={editorHostRef}
            className="cloud-codemirror min-h-0 flex-1 overflow-hidden"
            style={{ "--collab-user-color": identity.color } as React.CSSProperties}
          />
        </div>
        {viewMode === "split" && (
          <div
            role="separator"
            aria-label={t(lang, "mdViewSplit")}
            aria-orientation="vertical"
            aria-valuemin={25}
            aria-valuemax={75}
            aria-valuenow={Math.round(splitRatio)}
            onPointerDown={(event) => {
              event.preventDefault();
              setResizingSplit(true);
            }}
            onDoubleClick={() => setSplitRatio(50)}
            className="group relative h-full w-2 flex-shrink-0 cursor-col-resize bg-transparent"
            title={t(lang, "mdViewSplit")}
          >
            <span
              aria-hidden="true"
              className={`sidebar-resize-guide pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
                resizingSplit ? "sidebar-resize-guide--active bg-accent/80" : "bg-accent/30 group-hover:bg-accent/50"
              }`}
            />
          </div>
        )}
        <div
          ref={previewRef}
          onScroll={handlePreviewScroll}
          className={`${viewMode === "source" ? "hidden" : "block"} ${viewMode === "split" ? "min-w-0 flex-1" : "w-full"} overflow-y-auto px-5 py-4`}
        >
          <div
            className="markdown-preview prose mr-auto w-full max-w-[820px] text-text-primary [&_a]:text-accent-text [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-accent [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-bg-secondary [&_code]:px-1 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_img]:max-w-full [&_li]:ml-5 [&_ol]:list-decimal [&_p]:leading-[1.7] [&_ul]:list-disc"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      </div>
      {publicationDialogOpen && (
        <ModalShell
          onClose={() => setPublicationDialogOpen(false)}
          title={t(lang, "manageCloudDocumentPublication")}
          description={publicationLabel}
          icon={<CalendarClock size={16} />}
          size="md"
          closeDisabled={publicationSaving}
          footer={publicationDialogStatus !== "published" ? (
            <>
              {publicationDialogStatus === "scheduled" && (
                <button
                  type="button"
                  onClick={() => { void savePublication("cancel_schedule"); }}
                  disabled={publicationSaving}
                  aria-busy={publicationSavingAction === "cancel_schedule"}
                  className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed"
                >
                  {publicationSavingAction === "cancel_schedule"
                    ? <LoadingText label={t(lang, "cancelScheduledPublish")} variant="bounce" />
                    : t(lang, "cancelScheduledPublish")}
                </button>
              )}
              <button
                type="button"
                onClick={() => { void savePublication("schedule"); }}
                disabled={!scheduledPublishValue || publicationSaving}
                aria-busy={publicationSavingAction === "schedule"}
                className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent/70"
              >
                {publicationSavingAction === "schedule"
                  ? <LoadingText
                      label={t(lang, publicationDialogStatus === "scheduled" ? "rescheduleCloudDocument" : "scheduleCloudDocument")}
                      variant="bounce"
                    />
                  : t(lang, publicationDialogStatus === "scheduled" ? "rescheduleCloudDocument" : "scheduleCloudDocument")}
              </button>
            </>
          ) : undefined}
        >
          <div className="space-y-4">
              {publicationDialogStatus === "published" ? (
                <>
                  <p className="rounded-lg bg-bg-secondary/65 px-3 py-2 text-xs leading-relaxed text-text-muted">
                    {t(lang, "cloudDocumentPublishedHint")}
                  </p>
                  {unpublishConfirming ? (
                    <div className="rounded-xl border border-danger/20 bg-danger/5 p-3">
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
                          <CircleAlert size={14} />
                        </span>
                        <p className="text-xs leading-relaxed text-text-secondary">
                          {t(lang, "cloudDocumentUnpublishWarning")}
                        </p>
                      </div>
                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setUnpublishConfirming(false)}
                          disabled={publicationSaving}
                          className="h-8 rounded-lg border border-border px-3 text-xs text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed"
                        >
                          {t(lang, "keepCloudDocumentPublished")}
                        </button>
                        <button
                          type="button"
                          onClick={() => { void savePublication("unpublish"); }}
                          disabled={publicationSaving}
                          aria-busy={publicationSavingAction === "unpublish"}
                          className="inline-flex h-8 items-center rounded-lg bg-danger px-3 text-xs font-medium text-on-danger hover:bg-danger/90 disabled:cursor-not-allowed disabled:bg-danger/80"
                        >
                          {publicationSavingAction === "unpublish"
                            ? <LoadingText label={t(lang, "confirmUnpublishCloudDocument")} variant="bounce" />
                            : t(lang, "confirmUnpublishCloudDocument")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setUnpublishConfirming(true)}
                      disabled={publicationSaving}
                      className="flex w-full items-center gap-3 rounded-xl border border-danger/20 bg-danger/5 px-3 py-3 text-left text-sm font-medium text-danger transition-colors hover:border-danger/40 disabled:cursor-not-allowed"
                    >
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
                        <ArchiveRestore size={14} />
                      </span>
                      {t(lang, "unpublishCloudDocument")}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="rounded-lg bg-bg-secondary/65 px-3 py-2 text-xs leading-relaxed text-text-muted">
                    {t(lang, "cloudDocumentPublicationHint")}
                  </p>
                  <button
                    type="button"
                    onClick={() => { void savePublication("publish_now"); }}
                    disabled={publicationSaving}
                    aria-busy={publicationSavingAction === "publish_now"}
                    className="flex w-full items-center gap-3 rounded-xl border border-accent/20 bg-accent-light px-3 py-3 text-left text-sm font-medium text-accent-text transition-colors hover:border-accent/40 disabled:cursor-not-allowed"
                  >
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent">
                      <Send size={14} />
                    </span>
                    {publicationSavingAction === "publish_now"
                      ? <LoadingText label={t(lang, "publishCloudDocumentNow")} variant="bounce" />
                      : t(lang, "publishCloudDocumentNow")}
                  </button>
                  <div>
                    <div className="mb-2 text-xs font-medium text-text-secondary">
                      {t(lang, "scheduledPublishTime")}
                    </div>
                    <PublicationDateTimePicker
                      value={scheduledPublishValue}
                      minimumDate={new Date()}
                      lang={lang}
                      disabled={publicationSaving}
                      onChange={(nextValue) => {
                        setScheduledPublishValue(nextValue);
                        setPublicationValidationError(null);
                      }}
                    />
                    {publicationValidationError && (
                      <p className="mt-2 text-xs text-danger">{publicationValidationError}</p>
                    )}
                  </div>
                </>
              )}
          </div>
        </ModalShell>
      )}
    </div>
  );
}
