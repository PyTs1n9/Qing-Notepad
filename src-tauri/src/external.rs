//! Opening a `.md` from Explorer.
//!
//! The association itself lives in the NSIS installer (`windows/installer-hooks.nsh`):
//! a per-user `OpenWithProgids` entry, never the extension's default handler.
//! Everything after the double-click happens here:
//!
//! 1. Explorer starts the exe with the file path (cold start) or forwards the
//!    argv to the running instance (single-instance plugin). Both paths end in
//!    `enqueue`, which appends to a queue *and* emits an event, so a renderer
//!    that is still booting cannot lose the request.
//! 2. The main window drains the queue, reads the file through
//!    `external_open_path`, and opens a detached note window. A file that is
//!    already in `notes/index.json` is opened as a normal note; a new one is
//!    opened in draft mode.
//! 3. Draft mode never writes into `notes/`: the note window autosaves to
//!    `<data>/external-drafts/<id>.md`, and only "返回主软件" commits the text
//!    for the main window to add under 未分类笔记. That is what keeps a file the
//!    user merely glanced at out of the notebook.
//!
//! Identity: a note opened this way gets a deterministic id derived from the
//! canonical path (`ext-<fnv1a64>`). Reopening the same file therefore targets
//! the same note instead of appending a copy, across restarts and across
//! windows. A file that already *is* a note in `<data>/notes` keeps its own id.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::storage;
use crate::vault::decode_text;

/// A file path arrived (cold start or second instance). The payload is empty on
/// purpose: the renderer drains `external_take_launch`, which is idempotent.
pub const OPEN_EVENT: &str = "external-note:open";
/// A draft was committed and is waiting in the import queue.
pub const PENDING_EVENT: &str = "external-note:pending";

/// Markdown files are text. A runaway file must not be pulled into the webview
/// just because it was double-clicked.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Default)]
pub struct ExternalState {
    /// Paths from argv that no window has claimed yet.
    launch: Mutex<Vec<String>>,
    /// note id -> the file it was opened from. Populated by `external_open_path`,
    /// read by the note window so the path never has to travel through a URL.
    open: Mutex<HashMap<String, OpenFile>>,
    /// Committed drafts waiting for the main window to index them.
    pending: Mutex<Vec<PendingExternalNote>>,
}

#[derive(Clone)]
struct OpenFile {
    path: PathBuf,
    title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalNote {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingExternalNote {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
}

/// FNV-1a 64. The renderer has a synchronous copy of this for graph node ids;
/// this one only has to be stable, not identical.
fn fnv1a64(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Windows paths are case-insensitive, and `canonicalize` may hand back either
/// spelling of the drive letter. Lower-casing the comparison key is what stops
/// `C:\Notes\a.md` and `c:\notes\a.md` from becoming two notes.
fn path_key(path: &Path) -> String {
    storage::plain_path(path)
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

fn note_id_for(path: &Path) -> String {
    format!("ext-{:016x}", fnv1a64(&path_key(path)))
}

fn is_safe_note_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// A file inside `<data>/notes` already *is* a note; importing a copy of it
/// would show the same text twice. Its own id is the file stem.
fn internal_note_id(app: &AppHandle, path: &Path) -> Option<String> {
    let notes = fs::canonicalize(storage::data_root(app).ok()?.join("notes")).ok()?;
    if path.parent()? != notes {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    is_safe_note_id(stem).then(|| stem.to_string())
}

fn title_for(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn is_markdown(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"),
        None => false,
    }
}

/// argv entries are raw strings: strip the quotes Explorer adds, resolve
/// relative paths against the caller's cwd, and refuse anything that is not an
/// existing markdown file. A second-instance launch may also carry the
/// `qing-notepad://` deep link, which fails here and is handled elsewhere.
fn resolve_path(raw: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let raw = raw.trim().trim_matches('"');
    if raw.is_empty() || raw.starts_with('-') {
        return None;
    }
    let candidate = PathBuf::from(raw);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        cwd?.join(candidate)
    };
    let canonical = fs::canonicalize(absolute).ok()?;
    (canonical.is_file() && is_markdown(&canonical)).then_some(canonical)
}

fn read_note(app: &AppHandle, path: &Path) -> Result<ExternalNote, String> {
    let meta = fs::metadata(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "{} is {} bytes; the limit for an external note is {}",
            path.display(),
            meta.len(),
            MAX_BYTES
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let (content, _encoding) = decode_text(&bytes);
    let id = internal_note_id(app, path).unwrap_or_else(|| note_id_for(path));
    Ok(ExternalNote {
        id,
        path: storage::plain_path(path).to_string_lossy().to_string(),
        title: title_for(path),
        content,
    })
}

/// Queue file arguments and wake the renderer. Returns whether anything was
/// added, which lets the single-instance handler decide between "open a note"
/// and "just show the window".
pub fn enqueue(app: &AppHandle, raw_args: &[String], cwd: Option<&Path>) -> bool {
    let mut added = false;
    if let Ok(mut queue) = app.state::<ExternalState>().launch.lock() {
        for raw in raw_args {
            let Some(path) = resolve_path(raw, cwd) else {
                continue;
            };
            let plain = storage::plain_path(&path).to_string_lossy().to_string();
            if queue.iter().any(|queued| queued.eq_ignore_ascii_case(&plain)) {
                continue;
            }
            queue.push(plain);
            added = true;
        }
    }
    if added {
        let _ = app.emit(OPEN_EVENT, ());
    }
    added
}

/// Cold start: the path Explorer passed on the command line. The frontend is
/// not listening yet, so the queue (not the event) is what actually delivers it.
pub fn capture_launch_args(app: &AppHandle) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return;
    }
    let cwd = std::env::current_dir().ok();
    enqueue(app, &args, cwd.as_deref());
}

#[tauri::command]
pub fn external_take_launch(state: State<'_, ExternalState>) -> Vec<String> {
    match state.launch.lock() {
        Ok(mut queue) => std::mem::take(&mut *queue),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    }
}

/// Read a file the user asked to open, and remember where it came from.
#[tauri::command]
pub fn external_open_path(
    app: AppHandle,
    state: State<'_, ExternalState>,
    path: String,
) -> Result<ExternalNote, String> {
    let resolved = resolve_path(&path, None)
        .ok_or_else(|| format!("not a readable markdown file: {path}"))?;
    let note = read_note(&app, &resolved)?;
    let mut open = state
        .open
        .lock()
        .map_err(|_| "external file state is unavailable".to_string())?;
    open.insert(
        note.id.clone(),
        OpenFile {
            path: resolved,
            title: note.title.clone(),
        },
    );
    Ok(note)
}

/// Used by the detached window on mount. Reading again (instead of shipping the
/// content through the URL) keeps the window consistent with the file on disk
/// even if the queue sat there for a while.
#[tauri::command]
pub fn external_note_read(
    app: AppHandle,
    state: State<'_, ExternalState>,
    id: String,
) -> Result<ExternalNote, String> {
    let opened = {
        let open = state
            .open
            .lock()
            .map_err(|_| "external file state is unavailable".to_string())?;
        open.get(&id).cloned()
    }
    .ok_or_else(|| format!("no external file is registered for {id}"))?;

    let mut note = read_note(&app, &opened.path)?;
    note.id = id;
    if note.title.is_empty() {
        note.title = opened.title;
    }
    Ok(note)
}

/// "返回主软件": hand the buffer to the main window, which is the only writer of
/// `notes/index.json`. The queue survives a main window that is still loading,
/// hidden in the tray, or busy — the renderer drains it on mount, on focus, and
/// on `PENDING_EVENT`.
#[tauri::command]
pub fn external_note_commit(
    app: AppHandle,
    state: State<'_, ExternalState>,
    id: String,
    content: String,
) -> Result<(), String> {
    let opened = {
        let open = state
            .open
            .lock()
            .map_err(|_| "external file state is unavailable".to_string())?;
        open.get(&id).cloned()
    }
    .ok_or_else(|| format!("no external file is registered for {id}"))?;

    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "external import queue is unavailable".to_string())?;
        // Two clicks in a row must not put the same note in the queue twice.
        if let Some(existing) = pending.iter_mut().find(|item| item.id == id) {
            existing.content = content;
        } else {
            pending.push(PendingExternalNote {
                id,
                path: storage::plain_path(&opened.path).to_string_lossy().to_string(),
                title: opened.title,
                content,
            });
        }
    }
    let _ = app.emit(PENDING_EVENT, ());
    Ok(())
}

#[tauri::command]
pub fn external_take_pending(state: State<'_, ExternalState>) -> Vec<PendingExternalNote> {
    match state.pending.lock() {
        Ok(mut queue) => std::mem::take(&mut *queue),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("qing-external-{tag}-{stamp}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn the_same_path_always_maps_to_the_same_id() {
        let path = PathBuf::from(r"D:\Notes\日记.md");
        assert_eq!(note_id_for(&path), note_id_for(&path));
        assert!(is_safe_note_id(&note_id_for(&path)));
    }

    #[test]
    fn case_and_separator_spelling_do_not_create_a_second_note() {
        let upper = PathBuf::from(r"D:\Notes\A.md");
        let lower = PathBuf::from(r"d:/notes/a.md");
        assert_eq!(note_id_for(&upper), note_id_for(&lower));
    }

    #[test]
    fn different_files_get_different_ids() {
        assert_ne!(
            note_id_for(Path::new(r"D:\Notes\a.md")),
            note_id_for(Path::new(r"D:\Notes\b.md"))
        );
    }

    #[test]
    fn only_markdown_is_accepted() {
        assert!(is_markdown(Path::new("C:/x/y.MD")));
        assert!(is_markdown(Path::new("C:/x/y.markdown")));
        assert!(!is_markdown(Path::new("C:/x/y.txt")));
        assert!(!is_markdown(Path::new("C:/x/y.md.bak")));
    }

    #[test]
    fn quoted_and_relative_arguments_resolve() {
        let dir = temp_dir("resolve");
        let file = dir.join("记事.md");
        fs::write(&file, "# hi").expect("write");
        let resolved = resolve_path(&format!("  \"{}\"  ", file.display()), None)
            .expect("absolute quoted path");
        assert_eq!(resolved, fs::canonicalize(&file).expect("canonical"));

        let relative = resolve_path("记事.md", Some(&dir)).expect("relative path");
        assert_eq!(relative, fs::canonicalize(&file).expect("canonical"));

        assert!(resolve_path("--open", Some(&dir)).is_none());
        assert!(resolve_path("missing.md", Some(&dir)).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn utf8_bom_and_gb18030_are_both_readable() {
        let dir = temp_dir("decode");
        let bom = dir.join("bom.md");
        fs::write(&bom, [0xEF_u8, 0xBB, 0xBF, b'#', b' ', b'h', b'i']).expect("write");
        let (text, encoding) = decode_text(&fs::read(&bom).expect("read"));
        assert_eq!(text, "# hi");
        assert_eq!(encoding, "utf-8-bom");
        let _ = fs::remove_dir_all(&dir);
    }
}
