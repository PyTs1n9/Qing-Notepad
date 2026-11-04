use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_deep_link::DeepLinkExt;

mod clipboard;
mod credentials;
mod external;
mod pdf_export;
mod plugin;
mod plugin_host;
mod plugin_manifest;
mod storage;
mod update;
mod vault;
mod window_bg;

// Global flag: whether we are truly quitting the app
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Stable tray id. A fixed id is what makes it possible to rebuild the tray
/// menu later (`set_tray_language`), instead of being stuck with the labels
/// that were baked in at setup time.
const TRAY_ID: &str = "qing-main-tray";

/// Fallback language before the frontend reports the persisted setting.
/// Chinese is the product's primary language, and the frontend corrects this
/// within the first frame after settings load.
const DEFAULT_LANG: &str = "zh";

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Tray menu labels for the two supported UI languages.
///
/// Kept in sync with `showWindow` / `quitApp` in `src/utils/i18n.ts` so the
/// tray reads the same as the in-app wording.
fn tray_labels(lang: &str) -> (&'static str, &'static str) {
    if lang == "en" {
        ("Show Window", "Quit Application")
    } else {
        ("显示窗口", "退出软件")
    }
}

/// Builds the tray menu for a language. Shared by setup and by
/// `set_tray_language` so the two paths can never drift apart.
fn build_tray_menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let (show_label, quit_label) = tray_labels(lang);
    let show_item = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    Menu::with_items(app, &[&show_item, &quit_item])
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    QUITTING.store(true, Ordering::Relaxed);
    app.exit(0);
}

/// Rebuilds the tray menu in `lang` ("zh" or "en").
///
/// The frontend calls this once on startup and again on every language change,
/// so the tray never shows stale wording. Menu item ids stay identical, which
/// keeps the existing `on_menu_event` handler valid.
#[tauri::command]
fn set_tray_language(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| format!("tray icon `{TRAY_ID}` not found"))?;
    let menu = build_tray_menu(&app, &lang).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The extension host's only door. Held as `Arc<HostBridge>` so the protocol
    // handler and `plugin_ext_host_send` reach the same queue; the poll itself
    // blocks, so it runs on its own thread rather than the protocol thread.
    let ext_bridge = std::sync::Arc::new(plugin_host::HostBridge::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // A second launch can be a plain "show the window" (tray shortcut)
            // or Explorer handing us an `.md`. Only the latter suppresses the
            // main window: the note window it creates is the thing to look at.
            let opened = external::enqueue(app, &argv, Some(std::path::Path::new(&cwd)));
            if !opened {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        // 软件内更新。只有 Rust 侧在用（前端调的是 `update::*` 两个命令，不是
        // `@tauri-apps/plugin-updater` 的 JS API），所以不需要在 capabilities 里加
        // `updater:*` 权限。端点由 `update.rs` 自己按源解析，配置里的 endpoints 留空。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|_app, _shortcut, _event| {
                    // All shortcut handling done in frontend JS
                })
                .build(),
        )
        .manage(ext_bridge.clone())
        // Files opened from Explorer: the launch queue, the id→path map the
        // detached window reads, and the committed drafts waiting for the main
        // window. Lives for the process only; the draft files are the durable part.
        .manage(external::ExternalState::default())
        // 更新链路的跨命令状态：检查得到的 `Update` 句柄与已下载的安装包。
        // 只活在本进程内，退出即丢（见 `update.rs` 的 `UpdateState`）。
        .manage(update::UpdateState::default())
        // `qing-plugin-rpc`: the hidden extension-host webview's only way out.
        // `capabilities: []` rules out Tauri IPC there, so the conversation has
        // to ride a custom scheme — which needs no capability and is still
        // re-checked on the main window at every hop.
        .register_asynchronous_uri_scheme_protocol(plugin_host::SCHEME, {
            let bridge = ext_bridge.clone();
            move |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                let method = request.method().to_string();
                // Path *and* query: the probe reports its verdict in the query
                // string, and dropping it here would blind the only instrument
                // that can see a blocked `fetch`.
                let path = request
                    .uri()
                    .path_and_query()
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default();
                let body = request.into_body();
                let bridge = bridge.clone();
                // `/down` blocks until there is something to deliver. One
                // thread, at most, is parked here: the ext-host keeps a single
                // poll in flight for all of its workers.
                std::thread::spawn(move || {
                    let response =
                        plugin_host::handle_request(&app, &bridge, &method, &path, &body);
                    responder.respond(response);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            set_tray_language,
            credentials::encrypt_login_credentials,
            credentials::decrypt_login_credentials,
            credentials::encrypt_secret,
            credentials::decrypt_secret,
            pdf_export::export_pdf,
            storage::storage_get_root,
            storage::storage_set_root,
            storage::storage_clear_root,
            storage::storage_probe,
            storage::storage_migrate,
            storage::open_data_path,
            window_bg::set_window_background,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            plugin::plugin_list_installed,
            plugin::plugin_install,
            plugin::plugin_uninstall,
            plugin::plugin_set_enabled,
            plugin::plugin_set_permissions,
            plugin::plugin_rollback,
            plugin::plugin_read_manifest,
            plugin::plugin_discard_staging,
            plugin::plugin_storage_get,
            plugin::plugin_storage_set,
            plugin::plugin_storage_delete,
            plugin::plugin_storage_keys,
            plugin::plugin_fetch_index,
            plugin::plugin_read_log,
            plugin::plugin_append_log,
            plugin_host::plugin_ext_host_send,
            plugin_host::plugin_ext_host_open,
            vault::vault_register,
            vault::vault_list,
            vault::vault_remove,
            vault::vault_scan,
            vault::vault_read_file,
            update::check_update,
            update::download_update,
            update::install_downloaded,
            external::external_take_launch,
            external::external_open_path,
            external::external_note_read,
            external::external_note_read_path,
            external::external_note_write,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.deep_link().register("qing-notepad")?;

            // Paint the surface in last session's colour before the first frame.
            window_bg::apply_persisted(app.handle());

            // `fs:scope` is deliberately narrow, so the directory the app will
            // read from has to be allowed explicitly before the first frame.
            storage::register_startup_roots(app.handle());

            // Vault whitelist + directory watchers. Runs after the data root is
            // known (it stores `vaults.json` under `<data>/graph/`). The
            // watcher thread is started here so a folder edited in another
            // application shows up in the graph without a manual refresh.
            vault::init(app.handle());

            // Cold start from "打开方式". Queues the path and emits; the main
            // window drains it once it has loaded `notes/index.json`, so a slow
            // boot cannot lose the file and cannot import before the list is ready.
            external::capture_launch_args(app.handle());

            // A crash during an install must not leave a staging tree behind;
            // it is scratch space, so clearing it unconditionally is safe.
            plugin::clean_staging_on_startup(app.handle());

            // CSP probe: open the hidden extension host so its page can answer
            // whether `connect-src` reaches a custom scheme on this WebView2.
            // Dev-only by env var; the mode switch (P1b step 7) decides when it
            // opens for real.
            if std::env::var("QING_EXT_HOST_PROBE").is_ok() {
                match plugin_host::plugin_ext_host_open(app.handle().clone()) {
                    Ok(outcome) => eprintln!("[plugin-host] probe: {outcome}"),
                    Err(error) => eprintln!("[plugin-host] probe failed: {error}"),
                }
            }

            // Create tray menu in the fallback language; the frontend replaces
            // it as soon as it knows the persisted `lang`.
            let menu = build_tray_menu(app.handle(), DEFAULT_LANG)?;

            // Create tray icon
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Qing Notepad")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "quit" => {
                        QUITTING.store(true, Ordering::Relaxed);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } => {
                        let app = tray.app_handle();
                        show_main_window(app);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept main window close → hide to tray
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !QUITTING.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

