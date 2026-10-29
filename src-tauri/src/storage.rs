//! Relocatable data directory.
//!
//! The app keeps a single `data` directory (notes, images, AI history, config).
//! It used to be pinned beside the executable; now the user may point it at
//! another drive. Three things have to live here rather than in the frontend:
//!
//! 1. the pointer file — it must be readable before the data directory itself
//!    is known, so it sits in the OS config directory;
//! 2. the fs / asset-protocol scopes — a directory outside them can be neither
//!    read nor rendered, and scopes are runtime state on this side;
//! 3. the migration — moving thousands of files over IPC per file is slow, and
//!    a same-volume `rename` is instant while a cross-volume move is not.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_fs::FsExt;

const POINTER_FILE: &str = "storage.json";
const PROGRESS_EVENT: &str = "storage:migrate-progress";
/// Progress is throttled: one event per file would flood the IPC bridge.
const PROGRESS_INTERVAL_MS: u128 = 120;

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoragePointer {
    #[serde(rename = "dataRoot", default)]
    data_root: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageProbe {
    path: String,
    exists: bool,
    is_dir: bool,
    writable: bool,
    file_count: u64,
    total_bytes: u64,
    is_empty: bool,
    /// Looks like a Qing Notepad data directory rather than an arbitrary folder.
    is_library: bool,
}

/// True when a directory is a notebook, not a random folder: it has note files,
/// a note index, or the app's settings file.
fn looks_like_library(root: &Path) -> bool {
    if root.join("settings.json").is_file() || root.join("notes").join("index.json").is_file() {
        return true;
    }
    match fs::read_dir(root.join("notes")) {
        Ok(entries) => entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".md")
        }),
        Err(_) => false,
    }
}

/// Notes or AI history: content that cannot be regenerated. Config files
/// (`settings.json`, empty `index.json`) do not count — the app recreates them
/// on every launch, so replacing them is harmless.
fn has_user_content(root: &Path) -> bool {
    if let Ok(entries) = fs::read_dir(root.join("notes")) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".md")
            {
                return true;
            }
        }
    }
    if let Ok(mut entries) = fs::read_dir(root.join("ai").join("chats")) {
        if entries.next().is_some() {
            return true;
        }
    }
    false
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    files: u64,
    bytes: u64,
    /// `true` when every entry moved with a filesystem rename (same volume).
    same_volume: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    files: u64,
    total_files: u64,
    bytes: u64,
    total_bytes: u64,
}

fn pointer_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("no config directory: {error}"))?;
    Ok(dir.join(POINTER_FILE))
}

fn read_pointer(app: &AppHandle) -> Option<PathBuf> {
    let path = pointer_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let parsed: StoragePointer = serde_json::from_str(&raw).ok()?;
    parsed.data_root.map(PathBuf::from)
}

fn write_pointer(app: &AppHandle, root: Option<&Path>) -> Result<(), String> {
    let path = pointer_path(app)?;
    match root {
        Some(root) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let pointer = StoragePointer {
                data_root: Some(plain_path(root).to_string_lossy().to_string()),
            };
            let body = serde_json::to_string_pretty(&pointer).map_err(|error| error.to_string())?;
            fs::write(&path, body).map_err(|error| error.to_string())
        }
        None => match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

/// `fs::canonicalize` answers in the Windows verbatim form (`\\?\D:\notes`).
/// That form is unusable as a stored value: `@tauri-apps/api/path` joins it into
/// asset URLs the webview then fails to encode, and the scopes match on strings.
/// The plain form is what every other tool expects.
///
/// `pub(crate)`: `vault.rs` stores vault roots the same way, and it derives a
/// vault key from the stored spelling — two implementations would drift and
/// hand the same folder two different keys.
pub(crate) fn plain_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    path.to_path_buf()
}

/// Widen both scopes to the chosen root. Without this a custom directory reads
/// as empty in the UI (fs denied) and its images fail to load (asset 403).
///
/// Both the plain and the canonical form are registered: the scopes compare
/// strings, and the app reaches the same file through either spelling.
fn register_data_root(app: &AppHandle, root: &Path) {
    let plain = plain_path(root);
    let mut forms = vec![plain];
    if let Ok(canonical) = fs::canonicalize(root) {
        forms.push(canonical);
    }
    forms.sort();
    forms.dedup();

    for form in forms {
        if let Err(error) = app.fs_scope().allow_directory(&form, true) {
            eprintln!("[storage] failed to extend the fs scope: {error}");
        }
        if let Err(error) = app.asset_protocol_scope().allow_directory(&form, true) {
            eprintln!("[storage] failed to extend the asset scope: {error}");
        }
    }
}

fn measure(path: &Path) -> (u64, u64) {
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes)
}

struct Progress<'a> {
    app: &'a AppHandle,
    files: u64,
    bytes: u64,
    total_files: u64,
    total_bytes: u64,
    last_emit: Instant,
}

impl<'a> Progress<'a> {
    fn new(app: &'a AppHandle, total_files: u64, total_bytes: u64) -> Self {
        Self {
            app,
            files: 0,
            bytes: 0,
            total_files,
            total_bytes,
            // Backdated so the very first tick emits: a short migration would
            // otherwise never show anything but the final 100%.
            last_emit: Instant::now()
                .checked_sub(Duration::from_millis(PROGRESS_INTERVAL_MS as u64))
                .unwrap_or_else(Instant::now),
        }
    }

    fn tick(&mut self, files: u64, bytes: u64) {
        self.files += files;
        self.bytes += bytes;
        if self.last_emit.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
            self.flush();
        }
    }

    fn flush(&mut self) {
        let _ = self.app.emit(
            PROGRESS_EVENT,
            ProgressPayload {
                files: self.files,
                total_files: self.total_files,
                bytes: self.bytes,
                total_bytes: self.total_bytes,
            },
        );
        self.last_emit = Instant::now();
    }
}

fn copy_tree(from: &Path, to: &Path, progress: &mut Progress) -> std::io::Result<()> {
    let meta = fs::metadata(from)?;
    if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()), progress)?;
        }
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        let copied = fs::copy(from, to)?;
        progress.tick(1, copied);
    }
    Ok(())
}

/// Where the app keeps its data when no pointer exists.
///
/// Mirrors `resolveLocalProjectDataDirectory()` in `src/utils/storage.ts`: a dev
/// run keeps `data/` in the repository (resource dir is `src-tauri/target/…`),
/// an installed build keeps it beside the executable.
fn default_data_root(app: &AppHandle) -> Option<PathBuf> {
    let resource = app.path().resource_dir().ok()?;
    let normalized = resource.to_string_lossy().replace('\\', "/");
    if let Some(index) = normalized.find("/src-tauri/target/") {
        return Some(PathBuf::from(format!("{}/data", &normalized[..index])));
    }
    Some(resource.join("data"))
}

/// Extend the scopes for the directory the app is about to read.
///
/// Called once from `setup`: `fs:scope` in the capability is narrow on purpose,
/// and the data directory has to stay readable whether it is the default one or
/// the one named by the pointer file.
pub fn register_startup_roots(app: &AppHandle) {
    if let Some(root) = default_data_root(app) {
        register_data_root(app, &root);
    }
    if let Some(custom) = read_pointer(app) {
        if custom.is_dir() {
            register_data_root(app, &custom);
        }
    }
}

/// The directory the app currently reads and writes.
///
/// Shared with `plugin.rs`, which stores packages under `<root>/plugins`. It
/// resolves the same way the frontend does: a pointer file wins, otherwise the
/// default location. A pointer at a directory that is no longer there is an
/// error rather than a silent fallback — recreating an empty library is what
/// makes a moved library look deleted.
pub fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = read_pointer(app) {
        if custom.is_dir() {
            return Ok(custom);
        }
        return Err(format!(
            "E_DATA_DIRECTORY_UNAVAILABLE: {}",
            custom.to_string_lossy()
        ));
    }
    default_data_root(app).ok_or_else(|| "E_DATA_DIRECTORY_UNAVAILABLE: no data directory".to_string())
}

/// Open a folder inside the data directory in Explorer.
///
/// The opener permission list can only name build-time paths, and the data
/// directory may be anywhere the user picked — so the two "open folder" buttons
/// go through here instead. The path is validated against the live root, which
/// keeps the capability list free of `{"path": "**"}`.
#[tauri::command]
pub fn open_data_path(app: AppHandle, path: String) -> Result<(), String> {
    let requested = PathBuf::from(&path);
    let root = read_pointer(&app).unwrap_or_else(|| {
        default_data_root(&app).unwrap_or_default()
    });
    let root = fs::canonicalize(&root).map_err(|error| format!("data directory unavailable: {error}"))?;
    let target = fs::canonicalize(&requested).map_err(|error| format!("path unavailable: {error}"))?;
    if !target.starts_with(&root) {
        return Err("path is outside the data directory".into());
    }
    tauri_plugin_opener::open_path(target, None::<&str>).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn storage_get_root(app: AppHandle) -> Option<String> {
    let stored = read_pointer(&app)?;
    // Pointers written by the first build of this feature kept the verbatim
    // `\\?\` prefix. Rewrite them once so the setting stops showing it.
    let root = plain_path(&stored);
    if root != stored {
        if let Err(error) = write_pointer(&app, Some(&root)) {
            eprintln!("[storage] failed to normalise the stored path: {error}");
        }
    }
    // A stale pointer at an unplugged drive is returned as-is: the frontend
    // decides how to report it, and it must not silently fall back to an empty
    // library beside the executable.
    if root.is_dir() {
        register_data_root(&app, &root);
    }
    Some(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn storage_set_root(app: AppHandle, path: String) -> Result<(), String> {
    let root = PathBuf::from(&path);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    // Prove the directory is writable before it becomes the only data home.
    let probe = root.join(".qing-write-test");
    fs::write(&probe, b"ok").map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&probe);
    write_pointer(&app, Some(&root))?;
    register_data_root(&app, &root);
    Ok(())
}

#[tauri::command]
pub fn storage_clear_root(app: AppHandle) -> Result<(), String> {
    write_pointer(&app, None)
}

#[tauri::command]
pub async fn storage_probe(path: String) -> Result<StorageProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        let exists = root.exists();
        let is_dir = root.is_dir();
        let writable = if is_dir {
            let probe = root.join(".qing-write-test");
            let ok = fs::write(&probe, b"ok").is_ok();
            let _ = fs::remove_file(&probe);
            ok
        } else {
            false
        };
        let is_empty = is_dir
            && fs::read_dir(&root)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
        let (file_count, total_bytes) = if is_dir { measure(&root) } else { (0, 0) };
        StorageProbe {
            path,
            exists,
            is_dir,
            writable,
            file_count,
            total_bytes,
            is_empty,
            is_library: is_dir && looks_like_library(&root),
        }
    })
    .await
    .map_err(|error| error.to_string())
}

/// Move every entry of `from` into the directory `to`.
///
/// Same volume: one `rename` per top-level entry, instant and leaving no partial
/// copy. Cross volume: recursive copy, byte-count verification per entry, and
/// only then the source entry is removed. The pointer is written once this
/// returns, so a failed run leaves the app on the old directory.
///
/// `replace_bootstrap` allows a target that only holds files the app generates
/// itself (settings, empty index) — that is what "restore default directory"
/// needs, since launching the app recreates them. A target with real notes or
/// AI history is always refused.
#[tauri::command]
pub async fn storage_migrate(
    app: AppHandle,
    from: String,
    to: String,
    replace_bootstrap: bool,
) -> Result<MigrationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        migrate_blocking(&app, &from, &to, replace_bootstrap)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn migrate_blocking(
    app: &AppHandle,
    from: &str,
    to: &str,
    replace_bootstrap: bool,
) -> Result<MigrationReport, String> {
    let source = PathBuf::from(from);
    let target = PathBuf::from(to);
    if !source.is_dir() {
        return Err(format!("source directory is missing: {from}"));
    }
    let source = fs::canonicalize(&source).map_err(|error| error.to_string())?;
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let target = fs::canonicalize(&target).map_err(|error| error.to_string())?;

    if source == target {
        return Err("source and target are the same directory".into());
    }
    if target.starts_with(&source) || source.starts_with(&target) {
        return Err("target must not be inside the current data directory".into());
    }

    let mut existing = fs::read_dir(&target).map_err(|error| error.to_string())?;
    if existing.next().is_some() {
        if !replace_bootstrap {
            return Err("target directory is not empty".into());
        }
        if has_user_content(&target) {
            return Err(
                "the default directory already contains notes; move or remove them first".into(),
            );
        }
        // Only generated files here: drop them, the app recreates whatever it needs.
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
        fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    }

    let (total_files, total_bytes) = measure(&source);
    let mut progress = Progress::new(app, total_files, total_bytes);
    let mut same_volume = true;

    let entries: Vec<PathBuf> = fs::read_dir(&source)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .collect();

    for entry in entries {
        let name = entry
            .file_name()
            .ok_or_else(|| "unreadable entry name".to_string())?;
        let destination = target.join(name);

        // Fast path: same volume, so this is a metadata operation.
        if fs::rename(&entry, &destination).is_ok() {
            let (files, bytes) = measure(&destination);
            progress.tick(files, bytes);
            continue;
        }

        same_volume = false;
        copy_tree(&entry, &destination, &mut progress).map_err(|error| {
            format!(
                "copying {} failed: {error}. Nothing was deleted; the app still uses the old directory.",
                entry.display()
            )
        })?;

        // Verify before deleting anything: a truncated copy must not destroy the
        // only copy of the user's notes.
        let before = measure(&entry);
        let after = measure(&destination);
        if before != after {
            return Err(format!(
                "verification failed for {} ({} files / {} bytes copied, {} / {} expected). \
                 Nothing was deleted; the app still uses the old directory.",
                entry.display(),
                after.0,
                after.1,
                before.0,
                before.1
            ));
        }
        fs::remove_dir_all(&entry).or_else(|error| {
            // A single file entry is removed with remove_file.
            if entry.is_dir() {
                Err(error)
            } else {
                fs::remove_file(&entry)
            }
        })
        .map_err(|error| format!("moved but could not delete {}: {error}", entry.display()))?;
    }

    progress.flush();

    // The pointer is the last step on purpose: until here the app keeps running
    // on the old directory, so a failed move never points at half a library.
    write_pointer(app, Some(&target))?;
    register_data_root(app, &target);

    Ok(MigrationReport {
        files: total_files,
        bytes: total_bytes,
        same_volume,
    })
}
