//! 窗口贴合：两个自有窗口的缝被双击后成组，移动或缩放一方带动另一方。
//!
//! 只覆盖本应用自己的顶层窗口（`main` 与 `note-window-*`）。成组必须能自由改写
//! 对方的位置与尺寸，跨进程写第三方窗口会同时撞上 UIPI、最小尺寸约束和自绘边框
//! 三件事，本模块不做那件事——理由见 `docs/decisions-window-binding.md` D3。
//!
//! 三条不变量：
//! 1. `a` 永远是左/上那一个，`b` 是右/下那一个，传播公式因此只有两套；
//! 2. 传播只按「当前几何 + 成组时记下的偏移」重算绝对落点，不累加增量，拖多久都不漂；
//! 3. 自己写出去的位置必然回流成窗口事件，靠 `echoes` 里的预期表辨认，认不出来的
//!    变化才算用户操作。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Window, WindowEvent};

/// 成组状态变化：所有窗口都收到完整快照，界面按自己的 label 挑。
pub const CHANGED_EVENT: &str = "window-binding:changed";

/// 缝两侧至少要有这么长的共享边；短于此只是两个窗口擦肩而过。
const MIN_SEAM: i32 = 48;
/// 对面那条边与自己这条边的最大距离（物理像素基准，按 DPI 放大）。
const SNAP_TOLERANCE: i32 = 24;
/// 允许的相互压边量。`decorations: false` 并不消除外框：每侧仍有约 11 物理像素的
/// 不可见缩放边框，用户照着"看得见的边缘"对齐时，两个外框会互相压住约 22px。
/// 压边超过这个数就是真的叠在一起了，不再算一条缝。
const OVERLAP_SLACK: i32 = 30;
/// 双击落点离窗口内边缘多远仍算点在这条缝上（CSS 像素，按 DPI 放大）。
const CLICK_BAND: f64 = 12.0;
/// 自己写位置引发的回流窗口。
const ECHO_WINDOW: Duration = Duration::from_millis(400);
/// 回声比对容差：系统会把越界位置夹紧，取整也会差一两像素。
const ECHO_TOLERANCE: i32 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl Rect {
    fn right(self) -> i32 {
        self.x + self.w
    }

    fn bottom(self) -> i32 {
        self.y + self.h
    }

    /// 两个矩形在竖直方向上的共享区长度。
    fn share_y(self, other: Rect) -> i32 {
        (self.bottom().min(other.bottom()) - self.y.max(other.y)).max(0)
    }

    /// 两个矩形在水平方向上的共享区长度。
    fn share_x(self, other: Rect) -> i32 {
        (self.right().min(other.right()) - self.x.max(other.x)).max(0)
    }

    fn close_to(self, other: Rect, tolerance: i32) -> bool {
        (self.x - other.x).abs() <= tolerance
            && (self.y - other.y).abs() <= tolerance
            && (self.w - other.w).abs() <= tolerance
            && (self.h - other.h).abs() <= tolerance
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    /// 左右并排，共享一条竖直的缝。
    Vertical,
    /// 上下堆叠，共享一条水平的缝。
    Horizontal,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingInfo {
    /// 左/上那个窗口的 label。
    pub a: String,
    /// 右/下那个窗口的 label。
    pub b: String,
    pub axis: Axis,
    /// `b` 的起始边到 `a` 的结束边的距离，0 表示严丝合缝。
    pub gap: i32,
}

#[derive(Clone, Debug)]
struct Binding {
    info: BindingInfo,
    /// `b` 相对 `a` 在缝的垂直方向上的偏移，成组那一刻固定下来。
    offset: i32,
}

/// 一次「我刚把谁放到哪」的记录，用来把自己的回流从用户操作里摘出来。
struct Echo {
    label: String,
    rect: Rect,
    at: Instant,
}

#[derive(Default)]
struct Inner {
    bindings: Vec<Binding>,
    /// 每个成员最后一次被认可的矩形：`Moved` 只给位置，尺寸得从这里补齐。
    known: HashMap<String, Rect>,
    echoes: Vec<Echo>,
}

#[derive(Default)]
pub struct WindowBindingState {
    inner: Mutex<Inner>,
}

impl WindowBindingState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 本次操作的结果，前端只用来判断「要不要有反馈」。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindOutcome {
    /// 这次操作之后是否处于成组状态。
    pub bound: bool,
    pub partner: Option<String>,
    pub axis: Option<Axis>,
    /// 没有动作的原因；有值时前端什么都不该做。
    pub reason: Option<String>,
}

/// 参与成组的窗口。贴纸与画布磁贴常驻置顶、尺寸由内容决定，成组只会互相打架。
fn is_bindable(label: &str) -> bool {
    label == "main" || label.starts_with("note-window-")
}

/// 窗口与 webview 窗口各自带一套几何 API（`WebviewWindow` 没有 Deref 到 `Window`），
/// 两者在这一层收敛成一个矩形。
trait Geometry {
    fn geometry(&self) -> Option<Rect>;
}

impl<R: tauri::Runtime> Geometry for Window<R> {
    fn geometry(&self) -> Option<Rect> {
        rect_from(self.outer_position().ok()?, self.outer_size().ok()?)
    }
}

impl<R: tauri::Runtime> Geometry for tauri::WebviewWindow<R> {
    fn geometry(&self) -> Option<Rect> {
        rect_from(self.outer_position().ok()?, self.outer_size().ok()?)
    }
}

fn rect_from(position: PhysicalPosition<i32>, size: tauri::PhysicalSize<u32>) -> Option<Rect> {
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(Rect {
        x: position.x,
        y: position.y,
        w: size.width as i32,
        h: size.height as i32,
    })
}

fn rect_of(window: &impl Geometry) -> Option<Rect> {
    window.geometry()
}

/// 一个窗口此刻的矩形；不可见、最小化、最大化一律视为「不在场上」。
fn live_rect(app: &AppHandle, label: &str) -> Option<Rect> {
    let window = app.get_webview_window(label)?;
    if !window.is_visible().unwrap_or(false) {
        return None;
    }
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return None;
    }
    rect_of(&window)
}

/// 两个窗口是否处在同一缩放比例下。物理像素偏移只在同比例下守恒。
fn same_scale(app: &AppHandle, left: &str, right: &str) -> bool {
    let scale =
        |label: &str| app.get_webview_window(label).and_then(|window| window.scale_factor().ok());
    match (scale(left), scale(right)) {
        (Some(left), Some(right)) => (left - right).abs() < 0.01,
        _ => true,
    }
}

fn snapshot(inner: &Inner) -> Vec<BindingInfo> {
    inner
        .bindings
        .iter()
        .map(|binding| binding.info.clone())
        .collect()
}

/// 把当前快照推给所有窗口。调用方必须先放开锁——事件派发会回到同一把锁。
fn publish(app: &AppHandle) {
    let state = app.state::<WindowBindingState>();
    let list = {
        let inner = state.lock();
        snapshot(&inner)
    };
    let _ = app.emit(CHANGED_EVENT, list);
}

/// 摘掉所有涉及 `label` 的组，返回是否有变化。
fn detach(inner: &mut Inner, label: &str) -> bool {
    let before = inner.bindings.len();
    inner
        .bindings
        .retain(|binding| binding.info.a != label && binding.info.b != label);
    inner.bindings.len() != before
}

/// 这次变化是不是我刚写出去的那一次。
fn absorb_echo(inner: &mut Inner, label: &str, rect: Rect) -> bool {
    let now = Instant::now();
    inner.echoes.retain(|echo| now.duration_since(echo.at) < ECHO_WINDOW);
    let mut hit = false;
    for echo in inner.echoes.iter_mut() {
        if echo.label != label || !echo.rect.close_to(rect, ECHO_TOLERANCE) {
            continue;
        }
        // 刷新时间戳：紧随其后的 `Resized` 也要一起吸收掉。
        echo.at = now;
        hit = true;
        break;
    }
    hit
}

/// 被带动的那个窗口应该落在哪。`None` 表示这个 label 不在任何组里。
fn plan(inner: &Inner, driver: &str, rect: Rect) -> Option<(String, PhysicalPosition<i32>)> {
    let binding = inner
        .bindings
        .iter()
        .find(|binding| binding.info.a == driver || binding.info.b == driver)?;

    let (target, position) = if binding.info.a == driver {
        let position = match binding.info.axis {
            Axis::Vertical => PhysicalPosition::new(
                rect.right() + binding.info.gap,
                rect.y + binding.offset,
            ),
            Axis::Horizontal => PhysicalPosition::new(
                rect.x + binding.offset,
                rect.bottom() + binding.info.gap,
            ),
        };
        (binding.info.b.clone(), position)
    } else {
        // 被带动的是 `a`：它的尺寸事件里没有，只能从这条缝上一次的几何里取。
        let anchor = inner.known.get(&binding.info.a).copied()?;
        let position = match binding.info.axis {
            Axis::Vertical => PhysicalPosition::new(
                rect.x - anchor.w - binding.info.gap,
                rect.y - binding.offset,
            ),
            Axis::Horizontal => PhysicalPosition::new(
                rect.x - binding.offset,
                rect.y - anchor.h - binding.info.gap,
            ),
        };
        (binding.info.a.clone(), position)
    };

    Some((target, position))
}

/// 指针是否落在两个窗口之间那条缝上；返回缝的方向与指针到缝的距离。
fn seam(
    caller: Rect,
    partner: Rect,
    pointer: (i32, i32),
    band: i32,
    tolerance: i32,
) -> Option<(Axis, i32)> {
    let (px, py) = pointer;

    // 左右并排：共享一条竖直的缝，缝在 caller 的 `edge_x` 这一侧。
    let vertical = |gap: i32, edge_x: i32, from_y: i32, to_y: i32| -> Option<i32> {
        if gap < -OVERLAP_SLACK || gap > tolerance || caller.share_y(partner) < MIN_SEAM {
            return None;
        }
        if px < edge_x - band || px > edge_x + band + gap.max(0) {
            return None;
        }
        if py < from_y || py > to_y {
            return None;
        }
        Some((px - edge_x).abs())
    };

    // 上下堆叠：共享一条水平的缝，缝在 caller 的 `edge_y` 这一侧。
    let horizontal = |gap: i32, edge_y: i32, from_x: i32, to_x: i32| -> Option<i32> {
        if gap < -OVERLAP_SLACK || gap > tolerance || caller.share_x(partner) < MIN_SEAM {
            return None;
        }
        if py < edge_y - band || py > edge_y + band + gap.max(0) {
            return None;
        }
        if px < from_x || px > to_x {
            return None;
        }
        Some((py - edge_y).abs())
    };

    let top = caller.y.max(partner.y);
    let bottom = caller.bottom().min(partner.bottom());
    let left = caller.x.max(partner.x);
    let right = caller.right().min(partner.right());

    if let Some(distance) = vertical(partner.x - caller.right(), caller.right(), top, bottom) {
        return Some((Axis::Vertical, distance));
    }
    if let Some(distance) = vertical(caller.x - partner.right(), caller.x, top, bottom) {
        return Some((Axis::Vertical, distance));
    }
    if let Some(distance) = horizontal(partner.y - caller.bottom(), caller.bottom(), left, right) {
        return Some((Axis::Horizontal, distance));
    }
    if let Some(distance) = horizontal(caller.y - partner.bottom(), caller.y, left, right) {
        return Some((Axis::Horizontal, distance));
    }
    None
}

fn no_op(reason: &str) -> BindOutcome {
    BindOutcome {
        bound: false,
        partner: None,
        axis: None,
        reason: Some(reason.to_string()),
    }
}

/// 窗口事件入口：由 `lib.rs` 的 `on_window_event` 转进来。
pub fn handle_window_event(app: &AppHandle, window: &Window, event: &WindowEvent) {
    let label = window.label().to_string();
    if !is_bindable(&label) {
        return;
    }

    if matches!(event, WindowEvent::Destroyed) {
        let removed = {
            let state = app.state::<WindowBindingState>();
            let mut inner = state.lock();
            let removed = detach(&mut inner, &label);
            inner.known.remove(&label);
            removed
        };
        if removed {
            publish(app);
        }
        return;
    }

    if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
        return;
    }

    // 最大化/最小化之后几何不再代表「用户摆在哪」，成组关系当场失效。
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        let removed = {
            let state = app.state::<WindowBindingState>();
            let mut inner = state.lock();
            detach(&mut inner, &label)
        };
        if removed {
            publish(app);
        }
        return;
    }

    let Some(rect) = rect_of(window) else {
        return;
    };

    let mut drop_group = false;
    let actions = {
        let state = app.state::<WindowBindingState>();
        let mut inner = state.lock();

        if absorb_echo(&mut inner, &label, rect) {
            inner.known.insert(label.clone(), rect);
            Vec::new()
        } else if !same_scale_with_partner(app, &inner, &label) {
            drop_group = detach(&mut inner, &label);
            inner.known.insert(label.clone(), rect);
            Vec::new()
        } else {
            inner.known.insert(label.clone(), rect);
            match plan(&inner, &label, rect) {
                Some((target, position)) => {
                    // 先登记预期，再去写：`set_position` 可能同步把事件灌回来。
                    let size = inner.known.get(&target).copied().unwrap_or(Rect {
                        x: 0,
                        y: 0,
                        w: 0,
                        h: 0,
                    });
                    inner.echoes.push(Echo {
                        label: target.clone(),
                        rect: Rect {
                            x: position.x,
                            y: position.y,
                            w: size.w,
                            h: size.h,
                        },
                        at: Instant::now(),
                    });
                    vec![(target, position)]
                }
                None => Vec::new(),
            }
        }
    };

    for (target, position) in actions {
        if let Some(partner) = app.get_webview_window(&target) {
            let _ = partner.set_position(position);
        }
    }

    if drop_group {
        publish(app);
    }
}

fn same_scale_with_partner(app: &AppHandle, inner: &Inner, label: &str) -> bool {
    let Some(binding) = inner
        .bindings
        .iter()
        .find(|binding| binding.info.a == label || binding.info.b == label)
    else {
        return true;
    };
    let partner = if binding.info.a == label {
        &binding.info.b
    } else {
        &binding.info.a
    };
    same_scale(app, label, partner)
}

/// 双击缝隙：已成组则解绑，未成组则与最近的那个窗口成组。
#[tauri::command]
pub fn window_binding_toggle(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
) -> Result<BindOutcome, String> {
    if !is_bindable(&label) {
        return Ok(no_op("unsupported-window"));
    }
    let caller = app
        .get_webview_window(&label)
        .ok_or_else(|| "window-not-found".to_string())?;
    if caller.is_maximized().unwrap_or(false) || caller.is_minimized().unwrap_or(false) {
        return Ok(no_op("not-floating"));
    }

    let caller_rect = rect_of(&caller).ok_or_else(|| "no-geometry".to_string())?;
    let scale = caller.scale_factor().unwrap_or(1.0);
    let pointer = (
        caller_rect.x + (x * scale).round() as i32,
        caller_rect.y + (y * scale).round() as i32,
    );
    let band = (CLICK_BAND * scale).round() as i32;
    let tolerance = (SNAP_TOLERANCE as f64 * scale).round() as i32;

    let mut best: Option<(i32, String, Axis)> = None;
    for (partner_label, partner) in app.webview_windows() {
        if partner_label == label || !is_bindable(&partner_label) {
            continue;
        }
        if !partner.is_visible().unwrap_or(false) {
            continue;
        }
        if partner.is_minimized().unwrap_or(false) || partner.is_maximized().unwrap_or(false) {
            continue;
        }
        if !same_scale(&app, &label, &partner_label) {
            continue;
        }
        let Some(partner_rect) = rect_of(&partner) else {
            continue;
        };
        let Some((axis, distance)) = seam(caller_rect, partner_rect, pointer, band, tolerance)
        else {
            continue;
        };
        if best
            .as_ref()
            .map(|(best_distance, ..)| distance < *best_distance)
            .unwrap_or(true)
        {
            best = Some((distance, partner_label, axis));
        }
    }

    let Some((_, partner_label, axis)) = best else {
        return Ok(no_op("no-seam"));
    };

    let already = {
        let state = app.state::<WindowBindingState>();
        let inner = state.lock();
        inner.bindings.iter().any(|binding| {
            (binding.info.a == label && binding.info.b == partner_label)
                || (binding.info.a == partner_label && binding.info.b == label)
        })
    };

    if already {
        let state = app.state::<WindowBindingState>();
        {
            let mut inner = state.lock();
            detach(&mut inner, &label);
        }
        publish(&app);
        return Ok(BindOutcome {
            bound: false,
            partner: Some(partner_label),
            axis: Some(axis),
            reason: None,
        });
    }

    // 一个窗口只属于一组：先把涉及任一方的旧组摘掉，再按当前几何重建。
    let Some(caller_now) = live_rect(&app, &label) else {
        return Ok(no_op("not-floating"));
    };
    let Some(partner_now) = live_rect(&app, &partner_label) else {
        return Ok(no_op("partner-gone"));
    };
    let (a_label, a_rect, b_label, b_rect) = match axis {
        Axis::Vertical if caller_now.x <= partner_now.x => {
            (label.clone(), caller_now, partner_label.clone(), partner_now)
        }
        Axis::Vertical => (partner_label.clone(), partner_now, label.clone(), caller_now),
        Axis::Horizontal if caller_now.y <= partner_now.y => {
            (label.clone(), caller_now, partner_label.clone(), partner_now)
        }
        Axis::Horizontal => (partner_label.clone(), partner_now, label.clone(), caller_now),
    };
    let gap = match axis {
        Axis::Vertical => b_rect.x - a_rect.right(),
        Axis::Horizontal => b_rect.y - a_rect.bottom(),
    };
    let offset = match axis {
        Axis::Vertical => b_rect.y - a_rect.y,
        Axis::Horizontal => b_rect.x - a_rect.x,
    };
    let info = BindingInfo {
        a: a_label.clone(),
        b: b_label.clone(),
        axis,
        gap,
    };

    {
        let state = app.state::<WindowBindingState>();
        let mut inner = state.lock();
        inner
            .bindings
            .retain(|binding| binding.info.a != label && binding.info.b != label);
        inner.bindings.retain(|binding| {
            binding.info.a != partner_label && binding.info.b != partner_label
        });
        inner.known.insert(a_label, a_rect);
        inner.known.insert(b_label.clone(), b_rect);
        inner.bindings.push(Binding {
            info: info.clone(),
            offset,
        });
    }
    publish(&app);

    Ok(BindOutcome {
        bound: true,
        partner: Some(if info.a == label {
            info.b.clone()
        } else {
            info.a.clone()
        }),
        axis: Some(axis),
        reason: None,
    })
}

#[tauri::command]
pub fn window_binding_status(app: AppHandle) -> Vec<BindingInfo> {
    let state = app.state::<WindowBindingState>();
    let inner = state.lock();
    snapshot(&inner)
}

/// 解绑：给了 label 只拆这一组，不给就全拆。
#[tauri::command]
pub fn window_binding_release(app: AppHandle, label: Option<String>) {
    {
        let state = app.state::<WindowBindingState>();
        let mut inner = state.lock();
        match label {
            Some(label) => {
                detach(&mut inner, &label);
            }
            None => inner.bindings.clear(),
        }
    }
    publish(&app);
}

/// 几何与传播是纯函数，也是这套功能里唯一能在无 GUI 环境钉死的部分：
/// 拖拽时序在 `verify:webview` 里验不了，规则只能靠这里守住。
#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }

    /// 800×600 的主窗口，右边 8px 处并排一个同样高的笔记窗口。
    fn side_by_side() -> (Rect, Rect) {
        (rect(100, 100, 800, 600), rect(908, 100, 800, 600))
    }

    #[test]
    fn finds_the_seam_when_the_pointer_is_near_the_inner_edge() {
        let (caller, partner) = side_by_side();
        let hit = seam(caller, partner, (895, 400), 12, 24);
        assert_eq!(hit.map(|(axis, _)| axis), Some(Axis::Vertical));
    }

    #[test]
    fn finds_the_same_seam_from_the_other_side() {
        let (left, right) = side_by_side();
        let hit = seam(right, left, (915, 400), 12, 24);
        assert_eq!(hit.map(|(axis, _)| axis), Some(Axis::Vertical));
    }

    #[test]
    fn ignores_a_double_click_far_from_the_edge() {
        let (caller, partner) = side_by_side();
        assert!(seam(caller, partner, (820, 400), 12, 24).is_none());
    }

    #[test]
    fn ignores_windows_that_are_only_passing_by() {
        let (caller, _) = side_by_side();
        // 横向差 200px：不是一条缝。
        assert!(seam(caller, rect(1100, 100, 800, 600), (895, 400), 12, 24).is_none());
        // 完全错开的竖排：共享区为 0，擦肩而过不算。
        assert!(seam(caller, rect(908, 700, 800, 600), (895, 400), 12, 24).is_none());
    }

    #[test]
    fn accepts_edges_aligned_by_eye_not_by_invisible_frame() {
        // 用户把两条"看得见"的边对齐：外框各自多出约 11px，于是外框互相压住 22px。
        let caller = rect(100, 100, 800, 600);
        let partner = rect(878, 100, 800, 600);
        let hit = seam(caller, partner, (895, 400), 12, 24);
        assert_eq!(hit.map(|(axis, _)| axis), Some(Axis::Vertical));
    }

    #[test]
    fn ignores_windows_that_really_overlap() {
        let caller = rect(100, 100, 800, 600);
        // 压住 120px：那是叠在一起，不是一条缝。
        assert!(seam(caller, rect(780, 100, 800, 600), (895, 400), 12, 24).is_none());
    }

    #[test]
    fn finds_a_horizontal_seam_when_stacked() {
        let caller = rect(100, 100, 800, 600);
        let partner = rect(100, 708, 800, 600);
        let hit = seam(caller, partner, (400, 695), 12, 24);
        assert_eq!(hit.map(|(axis, _)| axis), Some(Axis::Horizontal));
    }

    fn bound_group() -> Inner {
        let mut inner = Inner::default();
        inner.known.insert("main".into(), rect(100, 100, 800, 600));
        inner
            .known
            .insert("note-window-a".into(), rect(904, 120, 600, 500));
        inner.bindings.push(Binding {
            info: BindingInfo {
                a: "main".into(),
                b: "note-window-a".into(),
                axis: Axis::Vertical,
                gap: 4,
            },
            offset: 20,
        });
        inner
    }

    #[test]
    fn dragging_the_left_window_pulls_the_right_one_along() {
        let inner = bound_group();
        let (target, position) = plan(&inner, "main", rect(140, 160, 800, 600)).expect("bonded");
        assert_eq!(target, "note-window-a");
        assert_eq!((position.x, position.y), (944, 180));
    }

    #[test]
    fn dragging_the_right_window_pushes_the_left_one_back() {
        let inner = bound_group();
        let (target, position) =
            plan(&inner, "note-window-a", rect(1000, 170, 600, 500)).expect("bonded");
        assert_eq!(target, "main");
        assert_eq!((position.x, position.y), (196, 150));
    }

    #[test]
    fn widening_from_the_outer_edge_leaves_the_partner_alone() {
        let inner = bound_group();
        // 左边缘外扩 40px：右边缘没动，缝没动，邻居不该被推。
        let (_, position) = plan(&inner, "main", rect(60, 100, 840, 600)).expect("bonded");
        assert_eq!(position.x, 904);
    }

    #[test]
    fn an_unbound_window_never_moves_anything() {
        let inner = Inner::default();
        assert!(plan(&inner, "main", rect(0, 0, 800, 600)).is_none());
    }

    #[test]
    fn our_own_write_is_absorbed_as_an_echo() {
        let mut inner = bound_group();
        inner.echoes.push(Echo {
            label: "note-window-a".into(),
            rect: rect(944, 180, 600, 500),
            at: Instant::now(),
        });
        // 同一位置（±几像素的取整）算自己的回声。
        assert!(absorb_echo(&mut inner, "note-window-a", rect(945, 180, 600, 500)));
        // 用户真的拖走了，就不算。
        assert!(!absorb_echo(&mut inner, "note-window-a", rect(1200, 180, 600, 500)));
    }
}

