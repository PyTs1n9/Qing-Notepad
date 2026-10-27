//! The `qing-plugin-rpc` custom protocol: how the extension-host webview talks
//! to the rest of the app.
//!
//! The extension host is a hidden webview with **no capabilities at all**, so it
//! cannot use Tauri IPC — no `invoke`, no `listen`. Its only door is this
//! protocol, which is plain HTTP over a custom scheme and therefore needs no
//! capability to reach. That is deliberate: a plugin that breaks out of its
//! worker lands in a webview that can do exactly one thing — talk to this
//! bridge — and everything on the far side of it (`bridge.ts`) re-checks
//! permissions anyway.
//!
//! Two endpoints, one conversation:
//!
//! - `POST /up` — plugin → host messages (`ready`, `rpc`, `res`, `log`). The body
//!   is `{pluginId, message}` and is forwarded to the main window as
//!   [`UP_EVENT`].
//! - `GET /down` — host → plugin messages (`init`, `call`, `event`, `res`).
//!   Long-polls: blocks up to [`INBOX_WAIT`] and answers `null` when nothing is
//!   waiting. Pushing goes the other way, through the [`DOWN_EVENT`] command.
//!
//! Why long-polling instead of a streamed response or a Tauri event: a streamed
//! body needs the platform's streaming support in every place the response is
//! built, and a Tauri event needs `core:event:allow-listen`, which would
//! contradict "no capabilities". A poll that blocks until there is something to
//! deliver is push-shaped for the caller and boring everywhere else.
//!
//! **Large text does not travel as a value here.** Host → plugin payloads that
//! carry a document body are the exception (`editor.getText` has to return
//! text), so the down direction has a ceiling sized for a note rather than for
//! a file; everything else is a reference (`{noteId, from, to}`) resolved on the
//! main window, where the data already is.
//!
//! Two limits worth keeping in view:
//!
//! - **CORS here is not a boundary.** The custom scheme is only resolvable
//!   inside app-owned webviews (Tauri registers it), so `Access-Control-Allow-
//!   Origin: *` costs nothing; everything that matters is re-checked in
//!   `bridge.ts`.
//! - **Who may call `/up` is a *list* question, not a token question — today.**
//!   Only the extension-host webview is meant to reach this scheme. If a second
//!   webview is ever given access (a plugin UI, say), `pluginId` becomes
//!   spoofable: one plugin's page could post `up` messages as another, and the
//!   `ready|rpc|res|log` whitelist would not stop it. At that point `/up` needs
//!   a per-session token bound to the webview that started the session. Do not
//!   add a second client without adding the token first.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

/// The scheme the ext-host page fetches.
pub const SCHEME: &str = "qing-plugin-rpc";
/// Plugin → host messages land on the main window as this event.
pub const UP_EVENT: &str = "plugin-ext-host-up";
/// The main window pushes a host → plugin message by invoking `plugin_ext_host_send`,
/// which reaches the ext-host through the poll.
pub const DOWN_COMMAND: &str = "plugin_ext_host_send";

/// Plugin → host payloads are small by construction: an `rpc` is a call into
/// `bridge.ts`, and a `res` is a command's return value or one level of tree
/// rows. Anything bigger is a bug in the caller, not a legitimate use.
const MAX_UP_BYTES: usize = 256 * 1024;
/// Host → plugin payloads can legitimately carry a note body, because
/// `editor.getText` has to hand the plugin the text. Sixteen mebibytes is
/// several times any note the app will open, and exists so a runaway response
/// cannot exhaust the receiver.
const MAX_DOWN_BYTES: usize = 16 * 1024 * 1024;
/// How long `/down` may block before answering "nothing yet".
const INBOX_WAIT: Duration = Duration::from_secs(20);

/// One routed message: the plugin it belongs to and the wire message itself.
///
/// `Serialize` is what lets it cross to the main window as a Tauri event
/// payload; the shape on the wire is exactly `{pluginId, message}`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Routed {
    pub plugin_id: String,
    pub message: Value,
}

#[derive(Debug, Default)]
struct Queue {
    items: VecDeque<Routed>,
    closed: bool,
}

/// What a `/down` poll produced.
#[derive(Debug, PartialEq)]
pub enum Take {
    Message(Routed),
    /// The wait expired with nothing queued.
    Idle,
    /// The bridge was closed (the extension host is going away).
    Closed,
}

/// Shared between the protocol handler and the main window's commands.
#[derive(Default)]
pub struct HostBridge {
    queue: Mutex<Queue>,
    ready: Condvar,
}

impl HostBridge {
    /// Queue a host → plugin message. Errors on an oversized payload or a
    /// bridge that has already been closed.
    pub fn push_down(&self, routed: Routed) -> Result<(), String> {
        let body = encode_down(&routed)?;
        if body.len() > MAX_DOWN_BYTES {
            return Err(format!(
                "E_TOO_LARGE: host → plugin message is {} bytes (limit {MAX_DOWN_BYTES})",
                body.len()
            ));
        }
        let mut queue = self.lock();
        if queue.closed {
            return Err("E_INTERNAL: the extension-host bridge is closed".into());
        }
        queue.items.push_back(routed);
        self.ready.notify_one();
        Ok(())
    }

    /// Pop the next message, blocking up to `wait`.
    pub fn take_down(&self, wait: Duration) -> Take {
        let mut queue = self.lock();
        if let Some(item) = queue.items.pop_front() {
            return Take::Message(item);
        }
        if queue.closed {
            return Take::Closed;
        }
        let (mut queue, _timeout) = self
            .ready
            .wait_timeout(queue, wait)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(item) = queue.items.pop_front() {
            return Take::Message(item);
        }
        if queue.closed {
            return Take::Closed;
        }
        Take::Idle
    }

    /// Stop accepting and wake every poller, so a closing host does not leave
    /// a thread parked on the condvar.
    pub fn close(&self) {
        let mut queue = self.lock();
        queue.closed = true;
        self.ready.notify_all();
    }

    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Parse a plugin → host body: `{pluginId, message}`.
///
/// The `message.t` is checked against the four the worker prelude can send, so
/// a malformed extension host cannot smuggle an `init` back at the app.
pub fn parse_up(body: &[u8]) -> Result<Routed, String> {
    if body.len() > MAX_UP_BYTES {
        return Err(format!(
            "E_TOO_LARGE: plugin → host message is {} bytes (limit {MAX_UP_BYTES})",
            body.len()
        ));
    }
    let value: Value =
        serde_json::from_slice(body).map_err(|error| format!("E_INTERNAL: {error}"))?;
    let plugin_id = value
        .get("pluginId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "E_INTERNAL: `pluginId` is required".to_string())?
        .to_string();
    let message = value
        .get("message")
        .cloned()
        .ok_or_else(|| "E_INTERNAL: `message` is required".to_string())?;
    match message.get("t").and_then(Value::as_str) {
        // `gone` is the extension host reporting a worker that will not answer
        // again — the cross-process form of a worker crash.
        Some("ready" | "rpc" | "res" | "log" | "gone") => {}
        Some(other) => return Err(format!("E_INTERNAL: unknown message `{other}`")),
        None => return Err("E_INTERNAL: `message.t` is required".to_string()),
    }
    Ok(Routed { plugin_id, message })
}

/// Serialise a host → plugin message for the wire.
pub fn encode_down(routed: &Routed) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&json!({
        "pluginId": routed.plugin_id,
        "message": routed.message,
    }))
    .map_err(|error| format!("E_INTERNAL: {error}"))
}

/// Which part of the bridge a request is asking for.
#[derive(Debug, PartialEq)]
pub enum Route {
    /// `POST /up`
    Up(Routed),
    /// `GET /down`
    Down,
    /// `OPTIONS`, so `fetch` from the ext-host page can preflight.
    Preflight,
}

/// Map a request onto the bridge. Method and path only — the body is parsed for
/// `/up` and rejected there if it is not one of ours.
pub fn route(method: &str, path: &str, body: &[u8]) -> Result<Route, String> {
    // `path` may carry a query string (the probe reports through one); it is
    // not part of the routing.
    let path = path.split('?').next().unwrap_or_default().trim_start_matches('/');
    // The scheme is addressed as `qing-plugin-rpc://<host>/<path>`; both the
    // host segment and a trailing slash are ignored, so `//up`, `/up` and
    // `ext/up` all mean the same thing.
    let path = path.rsplit('/').next().unwrap_or_default();
    match (method, path) {
        ("OPTIONS", _) => Ok(Route::Preflight),
        ("POST", "up") => Ok(Route::Up(parse_up(body)?)),
        ("GET", "down") => Ok(Route::Down),
        _ => Err(format!("E_INTERNAL: no route for {method} {path}")),
    }
}

/// Append a line to the probe log.
///
/// `eprintln!` is invisible from a GUI-subsystem binary launched detached —
/// which is exactly how this app runs when it is not a child of a console — so
/// the CSP probe reports to a file instead of stderr. Only written while
/// `QING_EXT_HOST_PROBE` is set: this is a dev instrument, not a log.
fn probe_log(line: &str) {
    if std::env::var("QING_EXT_HOST_PROBE").is_err() {
        return;
    }
    use std::io::Write;
    let path = std::env::temp_dir().join("qing-probe-result.txt");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

/// The main window answers a plugin's `rpc` — or pushes anything else down —
/// by invoking this. It is the only command the bridge needs: everything else
/// is an event or a poll.
#[tauri::command]
pub fn plugin_ext_host_send(
    bridge: tauri::State<'_, std::sync::Arc<HostBridge>>,
    plugin_id: String,
    message: Value,
) -> Result<(), String> {
    bridge.push_down(Routed {
        plugin_id,
        message,
    })
}

/// Open the hidden extension-host webview. Idempotent: one per app session.
///
/// The label `ext-host` deliberately matches **no capability file** —
/// `default.json` covers `main`/`sticky-*`/`tile-*`/`canvas-tile-*` and
/// `tile.json` covers `tile-*` — so the webview comes up with zero capabilities
/// without a permission list to maintain. Deny-by-default falls out of the
/// naming.
///
/// It is not opened yet as part of the plugin system: this is the probe
/// (`QING_EXT_HOST_PROBE=1`) that answers the CSP question before step 3 builds
/// on top of it. The mode switch (step 7) decides when it opens for real.
#[tauri::command]
pub fn plugin_ext_host_open(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::{Manager, WebviewUrl};

    if app.get_webview_window("ext-host").is_some() {
        return Ok("already-open".into());
    }
    // The page takes its mode from the URL, not from an env var it cannot see:
    // `?probe=1` turns on the CSP probe instead of starting the worker pool.
    let page = if std::env::var("QING_EXT_HOST_PROBE").is_ok() {
        "ext-host.html?probe=1"
    } else {
        "ext-host.html"
    };
    tauri::WebviewWindowBuilder::new(&app, "ext-host", WebviewUrl::App(page.into()))
        .title("Qing Extension Host")
        .visible(false)
        .skip_taskbar(true)
        // The probe's only other instrument: if this line never appears, the
        // page did not load and the CSP question is not even being asked yet.
        .on_page_load(move |_window, payload| {
            probe_log(&format!("page load: {}", payload.url()));
        })
        .build()
        .map_err(|error| format!("E_INTERNAL: {error}"))?;
    probe_log("ext-host webview created");
    Ok("opened".into())
}

/// JSON response with the CORS headers the ext-host page needs.
///
/// The hidden webview's origin comes out as `http://qing-plugin-rpc.localhost/`
/// on Windows (custom schemes are rewritten there), so its `fetch` to this
/// scheme is cross-origin in practice and has to be allowed explicitly. This is
/// not a security boundary — the webview has no capabilities, and every call
/// that matters is re-checked on the main window — it is what makes `fetch`
/// work at all.
fn respond(status: u16, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type")
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn respond_json(status: u16, value: &Value) -> tauri::http::Response<Vec<u8>> {
    respond(status, value.to_string().into_bytes())
}

/// The protocol handler body: glue over [`route`] and [`HostBridge`].
///
/// `/down` blocks until there is something to deliver, so the caller runs this
/// off the protocol thread and responds asynchronously.
pub fn handle_request(
    app: &tauri::AppHandle,
    bridge: &HostBridge,
    method: &str,
    path: &str,
    body: &[u8],
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Emitter;

    // One line per request, and it is the only place the CSP probe can report
    // from: a page with no capabilities has no other channel out. The query
    // string is kept because that is where the probe puts its verdict.
    probe_log(&format!("{method} {path}"));
    eprintln!("[plugin-host] {method} {path}");

    match route(method, path, body) {
        Ok(Route::Preflight) => respond(204, Vec::new()),
        Ok(Route::Up(routed)) => {
            // Forward and answer immediately: the main window's reply is a
            // message of its own, pushed down the queue, so this hop never
            // waits on the other one.
            if let Err(error) = app.emit(UP_EVENT, &routed) {
                return respond_json(
                    500,
                    &json!({ "ok": false, "code": "E_INTERNAL", "message": error.to_string() }),
                );
            }
            respond_json(200, &json!({ "ok": true }))
        }
        Ok(Route::Down) => match bridge.take_down(INBOX_WAIT) {
            Take::Message(routed) => respond_json(
                200,
                &json!({
                    "ok": true,
                    "item": { "pluginId": routed.plugin_id, "message": routed.message },
                }),
            ),
            Take::Idle => respond_json(200, &json!({ "ok": true, "item": null })),
            Take::Closed => respond_json(
                503,
                &json!({ "ok": false, "code": "E_INTERNAL", "message": "the extension-host bridge is closed" }),
            ),
        },
        Err(error) => respond_json(400, &json!({ "ok": false, "message": error })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up_body(t: &str) -> Vec<u8> {
        json!({
            "pluginId": "qing.example",
            "message": { "t": t, "rid": 1, "ok": true }
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn the_up_message_kinds_are_accepted_and_nothing_else() {
        // `gone` is the cross-process form of a worker crash: the extension host
        // saying "this one will not answer again".
        for kind in ["ready", "rpc", "res", "log", "gone"] {
            let routed = parse_up(&up_body(kind)).unwrap_or_else(|error| panic!("{kind}: {error}"));
            assert_eq!(routed.plugin_id, "qing.example");
            assert_eq!(routed.message["t"], kind);
        }
        // An extension host that could send `init` would be able to start a
        // plugin under an id of its choosing; the kinds above are all it is
        // allowed to say.
        for kind in ["init", "call", "event", "load", "unload", "nonsense", ""] {
            let error = parse_up(&up_body(kind)).expect_err("`init` is not an up message");
            assert!(error.starts_with("E_INTERNAL"), "{kind}: {error}");
        }
    }

    #[test]
    fn a_malformed_up_body_names_what_is_wrong() {
        for (body, needle) in [
            (br#"{"message":{"t":"log"}}"#.to_vec(), "pluginId"),
            (br#"{"pluginId":"qing.example"}"#.to_vec(), "message"),
            (
                br#"{"pluginId":"qing.example","message":{}}"#.to_vec(),
                "message.t",
            ),
            (b"not json".to_vec(), "E_INTERNAL"),
        ] {
            let error = parse_up(&body).expect_err("the body is not ours");
            assert!(error.contains(needle), "{needle}: {error}");
        }
    }

    #[test]
    fn an_oversized_up_body_is_refused_before_it_is_parsed() {
        let mut body = br#"{"pluginId":"qing.example","message":{"t":"log","level":"info","args":["#.to_vec();
        body.extend(std::iter::repeat(b'x').take(MAX_UP_BYTES));
        body.extend_from_slice(br#""}}"#);
        let error = parse_up(&body).expect_err("a huge body is refused");
        assert!(error.starts_with("E_TOO_LARGE"), "{error}");
    }

    #[test]
    fn down_messages_arrive_in_order_and_the_poll_is_a_wait() {
        let bridge = HostBridge::default();
        assert_eq!(bridge.take_down(Duration::ZERO), Take::Idle, "nothing queued yet");

        for index in 0..3 {
            bridge
                .push_down(Routed {
                    plugin_id: "qing.example".into(),
                    message: json!({ "t": "event", "name": index }),
                })
                .expect("queued");
        }
        for index in 0..3 {
            match bridge.take_down(Duration::ZERO) {
                Take::Message(routed) => assert_eq!(routed.message["name"], index, "FIFO"),
                other => panic!("expected a message, got {other:?}"),
            }
        }
        assert_eq!(bridge.take_down(Duration::ZERO), Take::Idle);
    }

    #[test]
    fn closing_the_bridge_wakes_parked_pollers() {
        use std::thread;

        let bridge = std::sync::Arc::new(HostBridge::default());
        let parked = {
            let bridge = bridge.clone();
            thread::spawn(move || bridge.take_down(Duration::from_secs(30)))
        };
        // Give the poller a moment to park; closing must wake it either way.
        thread::sleep(Duration::from_millis(20));
        bridge.close();
        assert_eq!(parked.join().expect("poller"), Take::Closed);
        // A bridge that is closed stops accepting work instead of silently
        // swallowing it.
        let error = bridge
            .push_down(Routed {
                plugin_id: "qing.example".into(),
                message: json!({ "t": "event", "name": "deactivate" }),
            })
            .expect_err("closed");
        assert!(error.contains("closed"), "{error}");
    }

    #[test]
    fn the_router_speaks_the_url_the_ext_host_page_uses() {
        assert_eq!(
            route("POST", "/up", &up_body("log")).expect("up"),
            Route::Up(parse_up(&up_body("log")).expect("parsed"))
        );
        assert_eq!(route("GET", "/down", b"").expect("down"), Route::Down);
        assert_eq!(
            route("OPTIONS", "/up", b"").expect("preflight"),
            Route::Preflight
        );
        // The scheme is addressed with a host segment (`ext/up`), and that must
        // not turn into "no route".
        assert_eq!(route("POST", "ext/up", &up_body("ready")).expect("host"), {
            Route::Up(parse_up(&up_body("ready")).expect("parsed"))
        });
        assert!(route("GET", "/up", b"").is_err(), "GET /up is not a thing");
    }

    #[test]
    fn a_host_message_is_the_shape_the_worker_expects() {
        // The wire form is `{pluginId, message}` and `message` is passed through
        // untouched — the worker prelude parses the same JSON the transport
        // types describe, so anything else here would be a second contract.
        let routed = Routed {
            plugin_id: "qing.example".into(),
            message: json!({ "t": "call", "rid": 7, "ns": "editor", "method": "getText", "args": [] }),
        };
        let body = encode_down(&routed).expect("encoded");
        let value: Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(value["pluginId"], "qing.example");
        assert_eq!(value["message"]["t"], "call");
        assert_eq!(value["message"]["rid"], 7);
    }
}
