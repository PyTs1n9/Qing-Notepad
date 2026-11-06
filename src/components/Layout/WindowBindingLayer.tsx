/**
 * 贴合接缝层。
 *
 * 挂在 `main.tsx` 的根节点上，一次覆盖所有窗口：主窗口与独立笔记窗口参与，
 * 贴纸与画布磁贴原样透传（`bindableWindowLabel()` 返回 null）。这里只做两件事——
 * 把「双击落在窗口内边带」翻译成一次 `window_binding_toggle`，以及在成组期间画出
 * 那条 2px 的接缝线。
 *
 * 判定分两层：前端只算「点得够靠边」（同步、零成本），成不成组由 Rust 按真实
 * 矩形判定，并回一个 `reason` 说明为什么没动。所以这里不需要任何提示文案。
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  bindableWindowLabel,
  bindingStatus,
  bindingToggle,
  onBindingChange,
  type WindowBindingInfo,
} from "@/utils/windowBinding";

/** 距窗口内边缘多少 CSS 像素之内算「点在缝上」。 */
const CLICK_BAND = 12;
/** 顶栏区的双击归系统（最大化），贴合不能抢这块。 */
const TITLEBAR_GUARD = 34;

type Edge = "left" | "right" | "top" | "bottom";

const EDGE_STYLE: Record<Edge, CSSProperties> = {
  left: { top: 0, bottom: 0, left: 0, width: 2 },
  right: { top: 0, bottom: 0, right: 0, width: 2 },
  top: { left: 0, right: 0, top: 0, height: 2 },
  bottom: { left: 0, right: 0, bottom: 0, height: 2 },
};

/** 本窗口朝向来缝的那条边。 */
function facingEdge(binding: WindowBindingInfo, label: string): Edge {
  const leading = binding.a === label;
  if (binding.axis === "vertical") {
    return leading ? "right" : "left";
  }
  return leading ? "bottom" : "top";
}

export default function WindowBindingLayer({ children }: { children: ReactNode }) {
  const label = useMemo(bindableWindowLabel, []);
  const [binding, setBinding] = useState<WindowBindingInfo | null>(null);

  useEffect(() => {
    if (!label) return;
    let alive = true;
    const apply = (bindings: WindowBindingInfo[]) => {
      if (!alive) return;
      setBinding(bindings.find((item) => item.a === label || item.b === label) ?? null);
    };
    // 先读一次现状：窗口可能是成组期间被重新加载的。
    void bindingStatus().then(apply).catch(() => undefined);
    const subscription = onBindingChange(apply);
    return () => {
      alive = false;
      void subscription.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [label]);

  useEffect(() => {
    if (!label) return;
    const onDoubleClick = (event: MouseEvent) => {
      if (event.detail < 2 || event.button !== 0) return;
      const { innerWidth, innerHeight } = window;
      // 顶栏双击会最大化窗口，那是系统行为，不能让贴合抢走。
      if (event.clientY < TITLEBAR_GUARD) return;
      const onEdgeBand =
        event.clientX <= CLICK_BAND ||
        event.clientX >= innerWidth - CLICK_BAND ||
        event.clientY >= innerHeight - CLICK_BAND;
      if (!onEdgeBand) return;
      // 成不成组由 Rust 判定；接缝线由 `window-binding:changed` 事件推回来。
      void bindingToggle(label, event.clientX, event.clientY).catch(() => undefined);
    };
    window.addEventListener("dblclick", onDoubleClick, true);
    return () => window.removeEventListener("dblclick", onDoubleClick, true);
  }, [label]);

  const edge = binding && label ? facingEdge(binding, label) : null;

  return (
    <>
      {children}
      {edge && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] bg-accent/60"
          style={EDGE_STYLE[edge]}
        />
      )}
    </>
  );
}
