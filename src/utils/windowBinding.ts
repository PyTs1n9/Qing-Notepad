/**
 * 窗口贴合（window binding）的前端侧：双击缝隙成组/解绑，以及成组状态的回读。
 *
 * 命名与 `src-tauri/src/window_binding.rs` 一一对应。两边的 label 规则必须一致，
 * 否则界面会给一个根本不参与成组的窗口画接缝线。
 *
 * 几何判定一律在 Rust：窗口矩形是物理像素（`outerPosition`），鼠标坐标是 CSS 像素
 * （`clientX`），150% 缩放下差 1.5 倍，放在前端等于把同一件事写两遍。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 成组状态变化；payload 是全量快照。 */
export const WINDOW_BINDING_CHANGED = "window-binding:changed";

export type BindingAxis = "vertical" | "horizontal";

export interface WindowBindingInfo {
  /** 左/上那个窗口。 */
  a: string;
  /** 右/下那个窗口。 */
  b: string;
  axis: BindingAxis;
  gap: number;
}

export interface BindOutcome {
  bound: boolean;
  partner: string | null;
  axis: BindingAxis | null;
  /** 有值就表示这次点击附近没有可贴的窗口，界面不该有任何反馈。 */
  reason: string | null;
}

const MAIN_LABEL = "main";
const NOTE_WINDOW_PREFIX = "note-window-";

/** 与 Rust 侧 `is_bindable` 保持一致：只有主窗口与独立笔记窗口参与。 */
export function isBindableLabel(label: string): boolean {
  return label === MAIN_LABEL || label.startsWith(NOTE_WINDOW_PREFIX);
}

/**
 * 当前窗口的 label；不参与成组的窗口（贴纸、画布磁贴）返回 null。
 * 在浏览器里跑预览页时 `getCurrentWindow()` 会抛，一并吞掉。
 */
export function bindableWindowLabel(): string | null {
  try {
    const { label } = getCurrentWindow();
    return isBindableLabel(label) ? label : null;
  } catch {
    return null;
  }
}

export function bindingToggle(label: string, x: number, y: number): Promise<BindOutcome> {
  return invoke<BindOutcome>("window_binding_toggle", { label, x, y });
}

export function bindingStatus(): Promise<WindowBindingInfo[]> {
  return invoke<WindowBindingInfo[]>("window_binding_status");
}

/** 不给 label 就释放全部。 */
export function bindingRelease(label?: string): Promise<void> {
  return invoke<void>("window_binding_release", { label: label ?? null });
}

export function onBindingChange(
  handler: (bindings: WindowBindingInfo[]) => void,
): Promise<UnlistenFn> {
  return listen<WindowBindingInfo[]>(WINDOW_BINDING_CHANGED, (event) =>
    handler(event.payload ?? []),
  );
}
