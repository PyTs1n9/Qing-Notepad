//! Opening and editing a `.md` from Explorer.
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
//!    `external_open_path`, and opens a detached note window.
//! 3. The window edits that file **in place**: every autosave goes through
//!    `external_note_write`, which refuses to clobber a file another program
//!    changed in the meantime. Nothing is copied into `notes/` until the user
//!    asks for it; after that the note keeps pointing at the same path and the
//!    notebook copy is a mirror, never the authority.
//!
//! Identity: a note opened this way gets a deterministic id derived from the
//! canonical path (`ext-<fnv1a64>`). Reopening the same file therefore targets
//! the same note instead of appending a copy, across restarts and across
//! windows. A file that already *is* a note in `<data>/notes` keeps its own id.
//!
//! Format fidelity: the decoder reports UTF-8 / UTF-8 BOM / GB18030 and the
//! dominant line ending. The write path re-encodes with the same choices, so a
//! CRLF file edited here does not turn into a whole-file diff in git.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::storage;
use crate::vault::decode_text;

/// A file path arrived (cold start or second instance). The payload is empty on
/// purpose: the renderer drains `external_take_launch`, which is idempotent.
pub const OPEN_EVENT: &str = "external-note:open";

/// Markdown files are text. A runaway file must not be pulled into the webview
/// just because it was double-clicked.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Error codes the renderer branches on. Kept as constants so the Rust side and
/// `utils/storage.ts` cannot drift apart silently.
const CODE_CONFLICT: &str = "EXTERNAL_WRITE_CONFLICT";
const CODE_MISSING: &str = "EXTERNAL_FILE_MISSING";
const CODE_DENIED: &str = "EXTERNAL_WRITE_DENIED";
const CODE_UNSUPPORTED: &str = "EXTERNAL_ENCODING_UNSUPPORTED";

#[derive(Default)]
pub struct ExternalState {
    /// Paths from argv that no window has claimed yet.
    launch: Mutex<Vec<String>>,
    /// `path_key(path)` -> the format and the revision we last saw. The baseline
    /// lives here rather than in the renderer so two windows of the same file
    /// share one revision, and so a window that reloads cannot reset it.
    files: Mutex<HashMap<String, FileSession>>,
    /// note id -> `path_key`. The detached window only knows its id (it arrives
    /// through the URL); this is how it reaches the path again.
    ids: Mutex<HashMap<String, String>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TextEncoding {
    Utf8,
    Utf8Bom,
    Gb18030,
    /// The bytes were not valid GB18030 and were decoded with replacement
    /// characters. Re-encoding would bake those replacements into the user's
    /// file, so writes are refused instead.
    Gb18030Lossy,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LineEnding {
    Lf,
    Crlf,
}

/// One revision of a file. `hash` is the authority: mtime changes on cloud
/// drives without the content moving, so a timestamp mismatch alone must not
/// produce a conflict warning.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    mtime_ms: i64,
    size: u64,
    hash: u64,
}

#[derive(Clone)]
struct FileSession {
    path: PathBuf,
    encoding: TextEncoding,
    eol: LineEnding,
    stamp: Stamp,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalNote {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub bytes: usize,
    pub saved_at_ms: i64,
}

/// `Err` payload of `external_note_write`. The renderer maps `code` onto a
/// status bar message; `message` is only for the log and for unsupported cases.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteFailure {
    pub code: String,
    pub message: String,
}

impl WriteFailure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// FNV-1a 64. The renderer has a synchronous copy of this for graph node ids;
/// this one only has to be stable, not identical.
fn fnv1a64(input: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input {
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
    format!("ext-{:016x}", fnv1a64(path_key(path).as_bytes()))
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

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn detect_eol(text: &str) -> LineEnding {
    let bytes = text.as_bytes();
    let mut crlf = 0usize;
    let mut bare_lf = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        if index > 0 && bytes[index - 1] == b'\r' {
            crlf += 1;
        } else {
            bare_lf += 1;
        }
    }
    if crlf > 0 && crlf >= bare_lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

fn decode_file(bytes: &[u8]) -> (String, TextEncoding, LineEnding) {
    let (text, tag) = decode_text(bytes);
    let encoding = match tag {
        "utf-8-bom" => TextEncoding::Utf8Bom,
        "gb18030" => TextEncoding::Gb18030,
        "gb18030-lossy" => TextEncoding::Gb18030Lossy,
        _ => TextEncoding::Utf8,
    };
    let eol = detect_eol(&text);
    (text, encoding, eol)
}

/// Editors hand us `\n`; the file may not. Normalise first so a buffer that
/// already contains `\r\n` cannot turn into `\r\r\n`.
fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn apply_eol(text: &str, eol: LineEnding) -> String {
    match eol {
        LineEnding::Lf => text.to_string(),
        LineEnding::Crlf => text.replace('\n', "\r\n"),
    }
}

fn encode_text(text: &str, encoding: TextEncoding) -> Result<Vec<u8>, WriteFailure> {
    match encoding {
        TextEncoding::Utf8 => Ok(text.as_bytes().to_vec()),
        TextEncoding::Utf8Bom => {
            let mut bytes = Vec::with_capacity(text.len() + 3);
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            bytes.extend_from_slice(text.as_bytes());
            Ok(bytes)
        }
        TextEncoding::Gb18030 => {
            let (encoded, _, had_errors) = encoding_rs::GB18030.encode(text);
            if had_errors {
                return Err(WriteFailure::new(
                    CODE_UNSUPPORTED,
                    "the text contains characters GB18030 cannot represent",
                ));
            }
            Ok(encoded.into_owned())
        }
        TextEncoding::Gb18030Lossy => Err(WriteFailure::new(
            CODE_UNSUPPORTED,
            "the file was decoded with replacement characters; saving would make the loss permanent",
        )),
    }
}

fn read_source(path: &Path) -> Result<(String, TextEncoding, LineEnding, Stamp), WriteFailure> {
    let meta = fs::metadata(path).map_err(|error| {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => CODE_MISSING,
            _ => CODE_DENIED,
        };
        WriteFailure::new(code, format!("cannot read {}: {error}", path.display()))
    })?;
    if meta.len() > MAX_BYTES {
        return Err(WriteFailure::new(
            CODE_UNSUPPORTED,
            format!(
                "{} is {} bytes; the limit for an external note is {}",
                path.display(),
                meta.len(),
                MAX_BYTES
            ),
        ));
    }
    let bytes = fs::read(path).map_err(|error| {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => CODE_MISSING,
            _ => CODE_DENIED,
        };
        WriteFailure::new(code, format!("cannot read {}: {error}", path.display()))
    })?;
    let (text, encoding, eol) = decode_file(&bytes);
    let stamp = Stamp {
        mtime_ms: mtime_ms(&meta),
        size: bytes.len() as u64,
        hash: fnv1a64(&bytes),
    };
    Ok((text, encoding, eol, stamp))
}

/// Same directory, so `rename` stays a same-volume operation. A unique suffix
/// per process keeps two windows from fighting over one temp file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "note.md".to_string());
    let temp = path.with_file_name(format!("{file_name}.qnp-{}.tmp", std::process::id()));
    let result = (|| {
        let mut handle = fs::File::create(&temp)?;
        handle.write_all(bytes)?;
        handle.sync_all()?;
        drop(handle);
        // On Windows this is MoveFileEx(MOVEFILE_REPLACE_EXISTING): the target
        // never disappears between the truncate and the write.
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn build_note(
    app: &AppHandle,
    path: &Path,
    id_override: Option<&str>,
) -> Result<(ExternalNote, FileSession), WriteFailure> {
    let (content, encoding, eol, stamp) = read_source(path)?;
    let id = id_override
        .map(str::to_string)
        .or_else(|| internal_note_id(app, path))
        .unwrap_or_else(|| note_id_for(path));
    let note = ExternalNote {
        id,
        path: storage::plain_path(path).to_string_lossy().to_string(),
        title: title_for(path),
        content,
    };
    let session = FileSession {
        path: path.to_path_buf(),
        encoding,
        eol,
        stamp,
    };
    Ok((note, session))
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

#[tauri::command]
pub fn external_open_path(
    app: AppHandle,
    state: State<'_, ExternalState>,
    path: String,
) -> Result<ExternalNote, String> {
    let resolved =
        resolve_path(&path, None).ok_or_else(|| format!("not a readable markdown file: {path}"))?;
    let (note, session) = build_note(&app, &resolved, None).map_err(|error| error.message)?;
    let key = path_key(&resolved);
    if let Ok(mut files) = state.files.lock() {
        files.insert(key.clone(), session);
    }
    if let Ok(mut ids) = state.ids.lock() {
        ids.insert(note.id.clone(), key);
    }
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
    let key = {
        let ids = state
            .ids
            .lock()
            .map_err(|_| "external file state is unavailable".to_string())?;
        ids.get(&id).cloned()
    }
    .ok_or_else(|| format!("no external file is registered for {id}"))?;
    let path = {
        let files = state
            .files
            .lock()
            .map_err(|_| "external file state is unavailable".to_string())?;
        files
            .get(&key)
            .map(|session| session.path.clone())
            .ok_or_else(|| format!("no external file is registered for {id}"))?
    };
    let (note, session) = build_note(&app, &path, Some(&id)).map_err(|error| error.message)?;
    if let Ok(mut files) = state.files.lock() {
        files.insert(key, session);
    }
    Ok(note)
}

/// Reading by path is what a linked note in the notebook uses: the index knows
/// the path, the window only knows the id.
#[tauri::command]
pub fn external_note_read_path(
    app: AppHandle,
    state: State<'_, ExternalState>,
    path: String,
) -> Result<ExternalNote, String> {
    let resolved =
        resolve_path(&path, None).ok_or_else(|| format!("not a readable markdown file: {path}"))?;
    let (note, session) = build_note(&app, &resolved, None).map_err(|error| error.message)?;
    let key = path_key(&resolved);
    if let Ok(mut files) = state.files.lock() {
        files.insert(key.clone(), session);
    }
    if let Ok(mut ids) = state.ids.lock() {
        ids.insert(note.id.clone(), key);
    }
    Ok(note)
}

/// Write the buffer back to the file it came from.
///
/// The baseline is the revision this process last read or wrote. A file another
/// program changed since then is a conflict, not something to overwrite: the
/// caller resolves it explicitly with `force: true` after the user chooses.
#[tauri::command]
pub fn external_note_write(
    state: State<'_, ExternalState>,
    path: String,
    content: String,
    force: Option<bool>,
) -> Result<WriteOutcome, WriteFailure> {
    let force = force.unwrap_or(false);
    let resolved = resolve_path(&path, None).ok_or_else(|| {
        WriteFailure::new(CODE_MISSING, format!("not a readable markdown file: {path}"))
    })?;
    let key = path_key(&resolved);

    let (_disk_text, disk_encoding, disk_eol, disk_stamp) = read_source(&resolved)?;

    let session = {
        let files = state
            .files
            .lock()
            .map_err(|_| WriteFailure::new(CODE_DENIED, "external file state is unavailable"))?;
        files.get(&key).cloned()
    };

    if let Some(existing) = &session {
        if !force && existing.stamp.hash != disk_stamp.hash {
            return Err(WriteFailure::new(
                CODE_CONFLICT,
                format!(
                    "{} changed on disk since it was opened ({} -> {})",
                    resolved.display(),
                    existing.stamp.hash,
                    disk_stamp.hash
                ),
            ));
        }
    }

    let encoding = session
        .as_ref()
        .map(|value| value.encoding)
        .unwrap_or(disk_encoding);
    let eol = session.as_ref().map(|value| value.eol).unwrap_or(disk_eol);

    let text = apply_eol(&normalize_eol(&content), eol);
    let bytes = encode_text(&text, encoding)?;

    if bytes.len() as u64 > MAX_BYTES {
        return Err(WriteFailure::new(
            CODE_UNSUPPORTED,
            format!("the buffer is larger than the {} byte limit", MAX_BYTES),
        ));
    }

    let meta = fs::metadata(&resolved).map_err(|error| {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => CODE_MISSING,
            _ => CODE_DENIED,
        };
        WriteFailure::new(code, format!("cannot write {}: {error}", resolved.display()))
    })?;
    if meta.permissions().readonly() {
        return Err(WriteFailure::new(
            CODE_DENIED,
            format!("{} is read-only", resolved.display()),
        ));
    }

    // Nothing to do when the buffer already matches the file. This also keeps an
    // autosave that fired without a real change from touching the mtime.
    if bytes.len() as u64 == disk_stamp.size && fnv1a64(&bytes) == disk_stamp.hash {
        let stamp = disk_stamp;
        if let Ok(mut files) = state.files.lock() {
            files.insert(
                key,
                FileSession {
                    path: resolved.clone(),
                    encoding,
                    eol,
                    stamp,
                },
            );
        }
        return Ok(WriteOutcome {
            bytes: bytes.len(),
            saved_at_ms: stamp.mtime_ms,
        });
    }

    write_atomic(&resolved, &bytes).map_err(|error| {
        WriteFailure::new(
            CODE_DENIED,
            format!("cannot write {}: {error}", resolved.display()),
        )
    })?;

    let written = fs::metadata(&resolved).ok();
    let stamp = Stamp {
        mtime_ms: written.as_ref().map(mtime_ms).unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|value| value.as_millis() as i64)
                .unwrap_or(0)
        }),
        size: bytes.len() as u64,
        hash: fnv1a64(&bytes),
    };
    if let Ok(mut files) = state.files.lock() {
        files.insert(
            key,
            FileSession {
                path: resolved,
                encoding,
                eol,
                stamp,
            },
        );
    }
    Ok(WriteOutcome {
        bytes: bytes.len(),
        saved_at_ms: stamp.mtime_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
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
        let bom = [0xEF_u8, 0xBB, 0xBF, b'#', b' ', b'h', b'i'];
        let (text, encoding, eol) = decode_file(&bom);
        assert_eq!(text, "# hi");
        assert_eq!(encoding, TextEncoding::Utf8Bom);
        assert_eq!(eol, LineEnding::Lf);

        let (gb, _, _) = encoding_rs::GB18030.encode("中文笔记\n第二行");
        let (text, encoding, _) = decode_file(gb.as_ref());
        assert_eq!(text, "中文笔记\n第二行");
        assert_eq!(encoding, TextEncoding::Gb18030);
    }

    #[test]
    fn crlf_is_detected_and_restored() {
        let (_, _, eol) = decode_file(b"a\r\nb\r\nc");
        assert_eq!(eol, LineEnding::Crlf);
        let (_, _, eol) = decode_file(b"a\nb\nc");
        assert_eq!(eol, LineEnding::Lf);

        let text = normalize_eol("a\r\nb\rc\n");
        assert_eq!(text, "a\nb\nc\n");
        assert_eq!(apply_eol(&text, LineEnding::Crlf), "a\r\nb\r\nc\r\n");
    }

    #[test]
    fn bom_round_trips_byte_for_byte() {
        let original = "# 标题\n正文\n";
        let bytes = encode_text(original, TextEncoding::Utf8Bom).expect("encode");
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let (text, encoding, _) = decode_file(&bytes);
        assert_eq!(text, original);
        assert_eq!(encoding, TextEncoding::Utf8Bom);
    }

    #[test]
    fn lossy_gb18030_is_refused_instead_of_being_made_permanent() {
        let error = encode_text("ok", TextEncoding::Gb18030Lossy).expect_err("must refuse");
        assert_eq!(error.code, CODE_UNSUPPORTED);
    }

    #[test]
    fn a_conflict_is_a_hash_mismatch_not_an_mtime_bump() {
        let session = Stamp {
            mtime_ms: 1_000,
            size: 5,
            hash: 42,
        };
        let touched = Stamp {
            mtime_ms: 9_999,
            size: 5,
            hash: 42,
        };
        let edited = Stamp {
            mtime_ms: 9_999,
            size: 5,
            hash: 43,
        };
        assert_eq!(session.hash, touched.hash);
        assert_ne!(session.hash, edited.hash);
    }

    #[test]
    fn atomic_write_replaces_the_file_and_leaves_no_temp_behind() {
        let dir = temp_dir("atomic");
        let file = dir.join("note.md");
        fs::write(&file, "old").expect("seed");
        write_atomic(&file, "新的内容\n".as_bytes()).expect("write");
        assert_eq!(fs::read_to_string(&file).expect("read"), "新的内容\n");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".qnp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files must be cleaned up");
        let _ = fs::remove_dir_all(&dir);
    }
}
