//! Read-only vault (knowledge base) access.
//!
//! A *vault* is a folder the user picked as a knowledge base. The app never
//! writes inside it and never copies it: the folder stays the authority, and
//! `docs/decisions-knowledge-graph.md` §2.1 forbids the renderer from holding a
//! filesystem scope for it too. So every read goes through a command in this
//! file, which makes this file the module's single security boundary:
//!
//! 1. a `key` is accepted only when it is listed in `<data>/graph/vaults.json`;
//! 2. a path is accepted only when its canonical form is still *inside* that
//!    vault root, compared component-wise (`Path::starts_with`), never as a
//!    string — `C:\data2` must not satisfy the prefix `C:\data`.
//!
//! The only file this module writes is `vaults.json` itself, atomically
//! (temporary file + rename), exactly like `storage.rs` writes its pointer.
//!
//! Commands are all `async` and do their work inside `spawn_blocking`: a Tauri
//! command without `async` runs on the main thread, and a 5000-file walk there
//! would freeze the window (see §0.2 of the design doc).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::event::EventKind;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::storage;

/// Directory under the data root that holds every derived graph artefact.
const GRAPH_DIR: &str = "graph";
/// The vault whitelist. Authoritative, never inside `graph/index/`, so that
/// "clear the cache" can never delete it (design decision D3).
const VAULTS_FILE: &str = "vaults.json";
const STORE_VERSION: u32 = 1;

/// File kinds that become graph nodes.
const EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];
/// Directories that are never part of a knowledge base. Names starting with a
/// dot (`.git`, `.obsidian`, `.trash`, hidden files) are skipped as well.
const SKIP_NAMES: [&str; 3] = [".git", "node_modules", ".obsidian"];

/// One file above this size is reported as skipped instead of being sent over
/// IPC: the whole point of the limit is that a stray 500 MB log cannot stall
/// the graph build.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// The renderer batches reads; more than this in one call is a caller bug.
const MAX_BATCH_FILES: usize = 200;

/// Editors save with `Create(tmp) -> Modify(tmp) -> Rename(over target)`, so one
/// save can arrive as three to five events. A fixed 300 ms window turns that
/// back into one change without adding a delay a user can feel.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(300);
/// A watcher can die silently (network share unmounted, drive removed). The
/// cheap recursive entry count catches the creates and removes it would miss.
const FALLBACK_INTERVAL: Duration = Duration::from_secs(60);

/// Event pushed to the renderer. `vaultKey` is present so a future second
/// window can decide whether it cares.
const CHANGE_EVENT: &str = "vault://changed";

// ---------------------------------------------------------------------------
// Data shapes crossing the IPC bridge
// ---------------------------------------------------------------------------

/// One registered vault. Field names are the renderer's contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecord {
    /// First 8 hex characters of `sha256(normalized absolute path)`: the same
    /// folder always yields the same key, a different folder a different one.
    pub key: String,
    /// Absolute path in plain (non-verbatim) form.
    pub root: String,
    /// Display name — the folder name.
    pub name: String,
    pub added_at: String,
    pub last_scan_at: Option<String>,
    pub enabled: bool,
    pub file_count: u64,
}

/// One file found by `vault_scan`. `relPath` is relative to the vault root,
/// separated by `/`, with the user's own characters (Chinese, spaces, brackets)
/// preserved verbatim.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFileStamp {
    pub rel_path: String,
    pub mtime_ms: i64,
    pub bytes: u64,
}

/// Something the scan walked past and why. Shown in the settings panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSkipped {
    pub rel_path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultScanResult {
    pub key: String,
    pub root: String,
    pub files: Vec<VaultFileStamp>,
    pub skipped: Vec<VaultSkipped>,
    pub file_count: u64,
    pub scanned_at: String,
}

/// One entry of a batch read. A single unreadable file never fails the batch:
/// it comes back with `text: None` and a `skipped` reason instead.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFileContent {
    pub rel_path: String,
    pub text: Option<String>,
    pub bytes: u64,
    pub mtime_ms: i64,
    /// `utf-8` | `utf-8-bom` | `gb18030` | `gb18030-lossy` | `none`
    pub encoding: String,
    pub skipped: Option<String>,
}

/// Payload of `vault://changed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultChangePayload {
    vault_key: String,
    changed: Vec<String>,
    full: bool,
}

/// On-disk shape of `vaults.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultStoreFile {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    vaults: Vec<VaultRecord>,
}

fn store_version() -> u32 {
    STORE_VERSION
}

impl Default for VaultStoreFile {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            vaults: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Path helpers — the security boundary
// ---------------------------------------------------------------------------

/// First 8 lowercase hex characters of `sha256(path)`.
///
/// The path is normalised first (verbatim prefix stripped, lowercased on
/// Windows) so the same folder reached through two spellings keeps one key.
fn derive_key(canonical_root: &Path) -> String {
    let plain = storage::plain_path(canonical_root);
    let mut normalized = plain.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        normalized = normalized.to_lowercase();
    }
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut key = String::with_capacity(8);
    for byte in digest.iter().take(4) {
        key.push_str(&format!("{byte:02x}"));
    }
    key
}

/// True when `candidate` is inside `root`, compared component by component.
///
/// This is the function that keeps `C:\data2\x.md` out of the vault `C:\data`.
/// `Path::starts_with` is documented to compare whole components, which a
/// string `starts_with` does not.
fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Turn a renderer-supplied relative path into a filesystem-safe one, refusing
/// everything that could leave the root *before* the disk is touched.
///
/// Rejected forms: empty, NUL bytes, `/abs`, `C:/abs`, `\\server\share`, and any
/// `..` that would climb above the root. A `..` that stays inside is folded
/// away instead (`notes/../a.md` becomes `a.md`) because a resolved markdown
/// link routinely looks like that, and refusing it would read as a broken link.
/// Folding is textual only; the physical check is the canonicalise step in
/// `resolve_within`.
fn sanitize_relative(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("empty path".to_string());
    }
    if raw.contains('\0') {
        return Err("path contains a NUL byte".to_string());
    }
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(format!("absolute path rejected: {raw}"));
    }
    let candidate = Path::new(&normalized);
    if candidate.is_absolute() {
        return Err(format!("absolute path rejected: {raw}"));
    }
    let mut parts: Vec<String> = Vec::new();
    for component in candidate.components() {
        match component {
            Component::Normal(value) => {
                let text = value.to_string_lossy().to_string();
                // A colon cannot appear in a Windows file name, so a component
                // carrying one is either a drive letter or a stream specifier.
                if text.contains(':') {
                    return Err(format!("absolute path rejected: {raw}"));
                }
                parts.push(text);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err(format!("path escapes the vault root: {raw}"));
                }
            }
            _ => {
                return Err(format!("absolute path rejected: {raw}"));
            }
        }
    }
    if parts.is_empty() {
        return Err(format!("path does not name a file: {raw}"));
    }
    Ok(PathBuf::from(parts.join("/")))
}

/// Resolve a relative path inside an already-canonicalised root.
///
/// The component check in `sanitize_relative` catches textual escapes; the
/// canonicalise step catches the physical ones (a symlink or junction inside
/// the vault that points elsewhere). Both must pass.
fn resolve_within(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let relative = sanitize_relative(raw)?;
    let joined = root.join(&relative);
    let canonical = fs::canonicalize(&joined)
        .map_err(|error| format!("file unavailable: {raw}: {error}"))?;
    if !is_within(root, &canonical) {
        return Err(format!("path escapes the vault root: {raw}"));
    }
    Ok(canonical)
}

/// Renderer-facing form of a relative path: forward slashes, empty for the root
/// itself, `None` when the path is not under the root at all.
fn relative_wire(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Echo back the caller's own spelling, with separators unified.
fn normalize_wire(raw: &str) -> String {
    raw.replace('\\', "/")
}

/// Only `md`, `markdown` and `txt` become nodes, case-insensitively.
fn has_note_extension(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, extension)) => {
            !stem.is_empty() && EXTENSIONS.iter().any(|allowed| extension.eq_ignore_ascii_case(allowed))
        }
        None => false,
    }
}

/// Hidden entries and build directories are never walked into.
fn should_skip_name(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    SKIP_NAMES.iter().any(|blocked| name.eq_ignore_ascii_case(blocked))
}

// ---------------------------------------------------------------------------
// The application data directory is never part of a vault
// ---------------------------------------------------------------------------
//
// `<data>/graph/index/positions.ndjson` is written by the renderer every time
// the force layout settles. When `<data>` itself is a vault, that write lands
// *inside* the watched tree, the watcher reports it, the renderer rescans, the
// new snapshot resets the layout, the layout settles again — a loop that never
// converges. The three guards below cut that loop at every layer: the folder
// cannot be registered, the scan never walks into it, and events under it are
// dropped before they can ask for a rescan.

/// Shown when the user picks the app's own data directory as a vault.
const RESERVED_ROOT_ERROR: &str = "该目录是 Qing Notepad 的应用数据目录，不能作为知识库";

/// Compare form of a path: `fs::canonicalize` when it exists (resolves `..`,
/// junctions and 8.3 names), then `storage::plain_path` to drop the Windows
/// verbatim prefix. Without the second step a notify path (`D:\notes\a.md`)
/// and a canonical root (`\\?\D:\notes`) never match component-wise.
fn compare_form(path: &Path) -> PathBuf {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    storage::plain_path(&resolved)
}

/// `true` when `candidate` is `reserved` itself or lives below it.
///
/// `Path::starts_with` compares component by component, so `D:\notes2` does
/// not satisfy the prefix `D:\notes` — which a string prefix would.
fn is_reserved_path(candidate: &Path, reserved: &Path) -> bool {
    compare_form(candidate).starts_with(reserved)
}

/// Registration guard: the data directory and everything under it is refused.
///
/// Takes the two paths instead of an `AppHandle` so it can be unit-tested; the
/// command resolves `storage::data_root` and calls this before touching
/// `vaults.json`.
fn check_root_not_reserved(canonical_root: &Path, data_root: &Path) -> Result<(), String> {
    if is_reserved_path(canonical_root, &compare_form(data_root)) {
        return Err(RESERVED_ROOT_ERROR.to_string());
    }
    Ok(())
}

/// Live compare form of the current data directory, `None` when it cannot be
/// resolved — in that case nothing is pruned, and the write that started the
/// loop cannot happen either.
fn reserved_root(app: &AppHandle) -> Option<PathBuf> {
    storage::data_root(app).ok().map(|root| compare_form(&root))
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Timestamps (no date crate needed for a single ISO8601 field)
// ---------------------------------------------------------------------------

fn iso8601_now() -> String {
    iso8601_from(SystemTime::now())
}

fn iso8601_from(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or(Duration::from_millis(0));
    let seconds = duration.as_secs() as i64;
    let millis = duration.subsec_millis();
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = remainder / 3600;
    let minute = (remainder % 3600) / 60;
    let second = remainder % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to a calendar
/// date, proleptic Gregorian, no leap-second or timezone involvement.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------------------
// Whitelist persistence
// ---------------------------------------------------------------------------

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = storage::data_root(app)?;
    Ok(root.join(GRAPH_DIR).join(VAULTS_FILE))
}

fn load_store(app: &AppHandle) -> Result<VaultStoreFile, String> {
    load_store_at(&store_path(app)?)
}

/// Read and validate the whitelist.
///
/// The file is user-editable, so every field is checked: a version we do not
/// know, a key that does not match its own root, a root that is gone, or a
/// duplicate key all make this an error rather than a silently wrong scope.
fn load_store_at(path: &Path) -> Result<VaultStoreFile, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(VaultStoreFile::default()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(VaultStoreFile::default());
    }
    let parsed: VaultStoreFile = serde_json::from_str(&raw)
        .map_err(|error| format!("{} is not valid: {error}", path.display()))?;
    validate_store(&parsed)?;
    Ok(parsed)
}

fn validate_store(store: &VaultStoreFile) -> Result<(), String> {
    if store.version != STORE_VERSION {
        return Err(format!(
            "unsupported vaults.json version: {} (expected {STORE_VERSION})",
            store.version
        ));
    }
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for record in &store.vaults {
        if record.key.len() != 8
            || !record
                .key
                .chars()
                .all(|value| value.is_ascii_digit() || ('a'..='f').contains(&value))
        {
            return Err(format!("vault key is not 8 lowercase hex characters: {}", record.key));
        }
        if !seen.insert(record.key.as_str()) {
            return Err(format!("duplicate vault key: {}", record.key));
        }
        let canonical = fs::canonicalize(&record.root)
            .map_err(|error| format!("vault {} is unavailable: {error}", record.key))?;
        if !canonical.is_dir() {
            return Err(format!("vault {} is not a folder: {}", record.key, record.root));
        }
        if derive_key(&canonical) != record.key {
            return Err(format!(
                "vault {} does not match its recorded root {}",
                record.key, record.root
            ));
        }
    }
    Ok(())
}

/// Atomic write: same directory temporary file, then rename over the target.
/// A half-written whitelist is unrecoverable (it is authoritative, not a
/// cache), so the temporary file must never be the file we read back.
fn save_store_at(path: &Path, store: &VaultStoreFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
        file.write_all(body.as_bytes())
            .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("cannot flush {}: {error}", temporary.display()))?;
    }
    if let Err(first) = fs::rename(&temporary, path) {
        // Windows refuses the replace while another process holds the target
        // open. Dropping the stale file is safe here because it is ours.
        let _ = fs::remove_file(path);
        fs::rename(&temporary, path).map_err(|second| {
            format!(
                "cannot replace {}: {first} / {second}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn find_vault(store: &VaultStoreFile, key: &str) -> Result<VaultRecord, String> {
    store
        .vaults
        .iter()
        .find(|record| record.key == key)
        .cloned()
        .ok_or_else(|| format!("unknown vault: {key}"))
}

/// Canonical root of a key already present in the whitelist.
fn vault_root(store: &VaultStoreFile, key: &str) -> Result<(VaultRecord, PathBuf), String> {
    let record = find_vault(store, key)?;
    let canonical = fs::canonicalize(&record.root)
        .map_err(|error| format!("vault {} is unavailable: {error}", key))?;
    if !canonical.is_dir() {
        return Err(format!("vault {} is not a folder: {}", key, record.root));
    }
    Ok((record, canonical))
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Walk `root` and collect note stamps.
///
/// `reserved` is the app's own data directory in compare form: the whole
/// subtree is skipped, so a vault that *contains* the data directory (the
/// common case: `<data>` lives next to the notes, or is the notes folder)
/// never yields the graph's own artefacts as notes and never sees its own
/// writes as changes.
fn walk_vault(
    root: &Path,
    reserved: Option<&Path>,
    files: &mut Vec<VaultFileStamp>,
    skipped: &mut Vec<VaultSkipped>,
) {
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                skipped.push(VaultSkipped {
                    rel_path: relative_wire(root, &current).unwrap_or_default(),
                    reason: format!("cannot list directory: {error}"),
                });
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    skipped.push(VaultSkipped {
                        rel_path: relative_wire(root, &current).unwrap_or_default(),
                        reason: format!("cannot read directory entry: {error}"),
                    });
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if should_skip_name(&name) {
                continue;
            }
            let path = entry.path();
            let rel_path = match relative_wire(root, &path) {
                Some(rel_path) => rel_path,
                None => continue,
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    skipped.push(VaultSkipped {
                        rel_path,
                        reason: format!("cannot stat: {error}"),
                    });
                    continue;
                }
            };
            // A link inside the vault may point anywhere; following it would
            // defeat the root check that the rest of this file enforces.
            if file_type.is_symlink() {
                skipped.push(VaultSkipped {
                    rel_path,
                    reason: "symbolic link skipped".to_string(),
                });
                continue;
            }
            if file_type.is_dir() {
                // The app's own data directory is pruned as a whole: its
                // `graph/` artefacts are written by this app, not by the user.
                if let Some(reserved) = reserved {
                    if is_reserved_path(&path, reserved) {
                        continue;
                    }
                }
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || !has_note_extension(&name) {
                continue;
            }
            match entry.metadata() {
                Ok(meta) => files.push(VaultFileStamp {
                    rel_path,
                    mtime_ms: mtime_ms(&meta),
                    bytes: meta.len(),
                }),
                Err(error) => skipped.push(VaultSkipped {
                    rel_path,
                    reason: format!("cannot stat: {error}"),
                }),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// UTF-8 first (that is what every editor writes), BOM stripped, GB18030 as
/// the fallback: Chinese notes saved by older Windows tools are GBK, which is a
/// subset of GB18030, and a lossy decode still beats "unreadable file".
fn decode_text(bytes: &[u8]) -> (String, &'static str) {
    let (body, has_bom) = match bytes.strip_prefix(&[0xEF_u8, 0xBB, 0xBF]) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    if let Ok(text) = std::str::from_utf8(body) {
        return (text.to_string(), if has_bom { "utf-8-bom" } else { "utf-8" });
    }
    let (decoded, _, had_errors) = encoding_rs::GB18030.decode(body);
    (
        decoded.into_owned(),
        if had_errors { "gb18030-lossy" } else { "gb18030" },
    )
}

fn empty_content(rel_path: String, reason: String) -> VaultFileContent {
    VaultFileContent {
        rel_path,
        text: None,
        bytes: 0,
        mtime_ms: 0,
        encoding: "none".to_string(),
        skipped: Some(reason),
    }
}

/// Read one file. Every failure mode is reported inside the value, never as a
/// batch error: one unreadable note must not lose the other 199.
fn read_one(root: &Path, raw: &str) -> VaultFileContent {
    let rel_path = normalize_wire(raw);
    let target = match resolve_within(root, raw) {
        Ok(target) => target,
        Err(reason) => return empty_content(rel_path, reason),
    };
    let meta = match fs::metadata(&target) {
        Ok(meta) => meta,
        Err(error) => return empty_content(rel_path, format!("cannot stat: {error}")),
    };
    if !meta.is_file() {
        return empty_content(rel_path, "not a file".to_string());
    }
    let bytes = meta.len();
    let mtime = mtime_ms(&meta);
    if bytes > MAX_FILE_BYTES {
        return VaultFileContent {
            rel_path,
            text: None,
            bytes,
            mtime_ms: mtime,
            encoding: "none".to_string(),
            skipped: Some(format!("larger than {MAX_FILE_BYTES} bytes")),
        };
    }
    let raw_bytes = match fs::read(&target) {
        Ok(raw_bytes) => raw_bytes,
        Err(error) => return empty_content(rel_path, format!("cannot read: {error}")),
    };
    let (text, encoding) = decode_text(&raw_bytes);
    VaultFileContent {
        rel_path,
        text: Some(text),
        bytes: raw_bytes.len() as u64,
        mtime_ms: mtime,
        encoding: encoding.to_string(),
        skipped: None,
    }
}

// ---------------------------------------------------------------------------
// Directory watching
// ---------------------------------------------------------------------------

/// Messages the notify callbacks and the commands send to the supervisor.
enum SupervisorMsg {
    /// Re-read `vaults.json` and add or drop watchers accordingly.
    Resync,
    Events {
        key: String,
        event: notify::Event,
    },
    WatcherError {
        key: String,
        message: String,
    },
    Shutdown,
}

/// One raw observation, before debouncing.
enum BatchEntry {
    File { rel_path: String, mtime_ms: i64 },
    Full,
}

#[derive(Default, Debug)]
struct VaultBatch {
    /// Keyed by `(relPath, mtimeMs)` on purpose: two real saves inside one
    /// window have two mtimes and both survive, while the repeated events of a
    /// single atomic save share one and collapse.
    entries: BTreeSet<(String, i64)>,
    full: bool,
}

#[derive(Default, Debug)]
struct DebounceState {
    batches: BTreeMap<String, VaultBatch>,
    deadline: Option<Instant>,
}

#[derive(Debug)]
struct VaultBatchOut {
    key: String,
    changed: Vec<String>,
    full: bool,
}

impl DebounceState {
    fn arm(&mut self, now: Instant, window: Duration) {
        // The window starts at the *first* event: a continuous stream of
        // events must not postpone the emit forever.
        if self.deadline.is_none() {
            self.deadline = Some(now + window);
        }
    }

    fn push(&mut self, key: &str, entry: BatchEntry, now: Instant, window: Duration) {
        let batch = self.batches.entry(key.to_string()).or_default();
        match entry {
            BatchEntry::File { rel_path, mtime_ms } => {
                batch.entries.insert((rel_path, mtime_ms));
            }
            BatchEntry::Full => batch.full = true,
        }
        self.arm(now, window);
    }

    fn due(&self, now: Instant) -> bool {
        match self.deadline {
            Some(deadline) => now >= deadline,
            None => false,
        }
    }

    fn take(&mut self) -> Vec<VaultBatchOut> {
        self.deadline = None;
        let mut out: Vec<VaultBatchOut> = Vec::new();
        for (key, batch) in std::mem::take(&mut self.batches) {
            if !batch.full && batch.entries.is_empty() {
                continue;
            }
            let mut seen: BTreeSet<String> = BTreeSet::new();
            let mut changed: Vec<String> = Vec::new();
            for (rel_path, _) in batch.entries {
                if seen.insert(rel_path.clone()) {
                    changed.push(rel_path);
                }
            }
            out.push(VaultBatchOut {
                key,
                changed,
                full: batch.full,
            });
        }
        out
    }
}

struct WatchedVault {
    /// Dropping this stops the watch, which is why it is kept alive here.
    _watcher: notify::RecommendedWatcher,
    root: PathBuf,
    entry_count: u64,
}

/// Managed state: the only door into the supervisor thread.
pub struct VaultWatchState {
    tx: Mutex<Sender<SupervisorMsg>>,
}

impl VaultWatchState {
    fn resync(&self) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(SupervisorMsg::Resync);
        }
    }
}

impl Drop for VaultWatchState {
    /// The supervisor thread cannot notice a closed channel on its own: it
    /// holds a sender of its own, so the only way out is an explicit message.
    fn drop(&mut self) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(SupervisorMsg::Shutdown);
        }
    }
}

fn request_resync(app: &AppHandle) {
    if let Some(state) = app.try_state::<VaultWatchState>() {
        state.resync();
    }
}

/// Recursive entry count, files and directories alike. Cheap enough for once a
/// minute, and it is the signal that survives a silently dead watcher: a
/// content edit is still caught by notify, a create or remove is what needs it.
fn count_entries(root: &Path) -> u64 {
    let mut total = 0_u64;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            total += 1;
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                stack.push(entry.path());
            }
        }
    }
    total
}

fn start_watch(
    tx: &Sender<SupervisorMsg>,
    record: &VaultRecord,
) -> Result<notify::RecommendedWatcher, String> {
    let key = record.key.clone();
    let sender = tx.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        match result {
            Ok(event) => {
                let _ = sender.send(SupervisorMsg::Events {
                    key: key.clone(),
                    event,
                });
            }
            Err(error) => {
                let _ = sender.send(SupervisorMsg::WatcherError {
                    key: key.clone(),
                    message: error.to_string(),
                });
            }
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(Path::new(&record.root), RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    Ok(watcher)
}

fn resync_watchers(
    app: &AppHandle,
    tx: &Sender<SupervisorMsg>,
    watched: &mut BTreeMap<String, WatchedVault>,
) {
    let store = match load_store(app) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("[vault] cannot rebuild watchers: {error}");
            return;
        }
    };
    let enabled: BTreeMap<String, VaultRecord> = store
        .vaults
        .into_iter()
        .filter(|record| record.enabled)
        .map(|record| (record.key.clone(), record))
        .collect();
    watched.retain(|key, _| enabled.contains_key(key));
    for (key, record) in enabled {
        if watched.contains_key(&key) {
            continue;
        }
        match start_watch(tx, &record) {
            Ok(watcher) => {
                let root = PathBuf::from(&record.root);
                let entry_count = count_entries(&root);
                watched.insert(
                    key,
                    WatchedVault {
                        _watcher: watcher,
                        root,
                        entry_count,
                    },
                );
            }
            Err(error) => eprintln!("[vault] cannot watch {}: {error}", record.root),
        }
    }
}

/// Translate one notify event into either a concrete `(relPath, mtimeMs)` or a
/// request for a full rescan.
///
/// `reserved` is the app's own data directory in compare form. Events under it
/// are dropped without a trace: neither a concrete file nor a full rescan.
/// That single `continue` is what breaks the settle-write-rescan loop.
fn translate_event(
    root: &Path,
    reserved: Option<&Path>,
    event: notify::Event,
) -> (Vec<(String, i64)>, bool) {
    let mut concrete: Vec<(String, i64)> = Vec::new();
    let mut full = false;
    if matches!(event.kind, EventKind::Access(_)) {
        // Reads are not changes, and this module reads the vault itself.
        return (concrete, full);
    }
    for path in event.paths {
        if let Some(reserved) = reserved {
            if is_reserved_path(&path, reserved) {
                // `<data>/graph/index/positions.ndjson` and friends. The
                // renderer wrote these; telling it to rescan would make it
                // write them again.
                continue;
            }
        }
        let Some(rel_path) = relative_wire(root, &path) else {
            // A rename that landed outside the root: nothing specific to name.
            full = true;
            continue;
        };
        if rel_path.is_empty() {
            full = true;
            continue;
        }
        if path.is_dir() {
            // Directory-level create / remove / rename: the affected files are
            // not named by the event, so the renderer must re-diff the tree.
            full = true;
            continue;
        }
        if !has_note_extension(&rel_path) {
            // Content change of a file we never index: never a rescan.
            //
            // Dropping a *missing* non-note path is safe, and it is what keeps
            // this module from reacting to its own index writes:
            //   * `a.md -> a.txt` sends the `From` path `a.md`, which has a
            //     note extension and takes the mtime branch below, so the
            //     deletion of the note is still reported (`mtime = 0`);
            //   * `a.txt -> a.md` and a rename from outside the vault are both
            //     covered by the `To` event, whose path does exist.
            continue;
        }
        let mtime = fs::metadata(&path)
            .ok()
            .map(|meta| mtime_ms(&meta))
            .unwrap_or(0);
        concrete.push((rel_path, mtime));
    }
    (concrete, full)
}

fn supervisor_loop(app: AppHandle, tx: Sender<SupervisorMsg>, rx: Receiver<SupervisorMsg>) {
    let mut state = DebounceState::default();
    let mut watched: BTreeMap<String, WatchedVault> = BTreeMap::new();
    let mut fallback_at = Instant::now() + FALLBACK_INTERVAL;

    loop {
        let now = Instant::now();
        let mut wake = fallback_at;
        if let Some(deadline) = state.deadline {
            if deadline < wake {
                wake = deadline;
            }
        }
        let timeout = wake.saturating_duration_since(now);
        let message = rx.recv_timeout(timeout);
        let now = Instant::now();

        match message {
            Ok(SupervisorMsg::Shutdown) => break,
            Ok(SupervisorMsg::Resync) => resync_watchers(&app, &tx, &mut watched),
            Ok(SupervisorMsg::Events { key, event }) => {
                let Some(entry) = watched.get(&key) else {
                    continue;
                };
                // Resolved per event batch, not cached: the user can move the
                // data directory at any time and the guard must follow it.
                let reserved = reserved_root(&app);
                let (concrete, full) = translate_event(&entry.root, reserved.as_deref(), event);
                for (rel_path, mtime) in concrete {
                    state.push(
                        &key,
                        BatchEntry::File {
                            rel_path,
                            mtime_ms: mtime,
                        },
                        now,
                        DEBOUNCE_WINDOW,
                    );
                }
                if full {
                    state.push(&key, BatchEntry::Full, now, DEBOUNCE_WINDOW);
                }
            }
            Ok(SupervisorMsg::WatcherError { key, message }) => {
                eprintln!("[vault] watcher for {key} reported: {message}");
                // Force the next fallback tick to see a mismatch, so a watcher
                // that keeps failing still produces a refresh.
                if let Some(entry) = watched.get_mut(&key) {
                    entry.entry_count = u64::MAX;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if state.due(now) {
            for batch in state.take() {
                let _ = app.emit(
                    CHANGE_EVENT,
                    VaultChangePayload {
                        vault_key: batch.key,
                        changed: batch.changed,
                        full: batch.full,
                    },
                );
            }
        }

        if now >= fallback_at {
            fallback_at = now + FALLBACK_INTERVAL;
            for (key, entry) in watched.iter_mut() {
                let current = count_entries(&entry.root);
                if current != entry.entry_count {
                    entry.entry_count = current;
                    let _ = app.emit(
                        CHANGE_EVENT,
                        VaultChangePayload {
                            vault_key: key.clone(),
                            changed: Vec::new(),
                            full: true,
                        },
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Make sure `<data>/graph/vaults.json` exists and start the watcher thread.
///
/// Called once from `setup`. A missing data directory is logged rather than
/// fatal: `vault_*` commands report it themselves, and the rest of the app
/// keeps working.
pub fn init(app: &AppHandle) {
    match store_path(app) {
        Ok(path) => {
            if let Some(parent) = path.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    eprintln!("[vault] cannot create {}: {error}", parent.display());
                }
            }
            if !path.is_file() {
                if let Err(error) = save_store_at(&path, &VaultStoreFile::default()) {
                    eprintln!("[vault] cannot write {}: {error}", path.display());
                }
            }
        }
        Err(error) => eprintln!("[vault] no data directory: {error}"),
    }

    let (tx, rx) = channel::<SupervisorMsg>();
    let thread_sender = tx.clone();
    let thread_app = app.clone();
    thread::Builder::new()
        .name("qing-vault-watch".to_string())
        .spawn(move || supervisor_loop(thread_app, thread_sender, rx))
        .err()
        .map(|error| eprintln!("[vault] cannot start the watcher thread: {error}"));

    app.manage(VaultWatchState {
        tx: Mutex::new(tx.clone()),
    });
    let _ = tx.send(SupervisorMsg::Resync);
}

fn register_blocking(app: &AppHandle, root: &str) -> Result<VaultRecord, String> {
    let requested = PathBuf::from(root);
    let canonical = fs::canonicalize(&requested)
        .map_err(|error| format!("folder unavailable: {root}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    // The app's own data directory must never become a vault: its `graph/`
    // artefacts would then be both the input and the output of the graph.
    check_root_not_reserved(&canonical, &storage::data_root(app)?)?;
    // Prove it is readable now; a folder the process cannot list would
    // otherwise register fine and fail on every later scan.
    fs::read_dir(&canonical).map_err(|error| format!("folder is not readable: {root}: {error}"))?;

    let key = derive_key(&canonical);
    let display = canonical
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| canonical.to_string_lossy().to_string());
    let stored = storage::plain_path(&canonical)
        .to_string_lossy()
        .to_string();

    let path = store_path(app)?;
    let mut store = load_store_at(&path)?;
    let record = match store.vaults.iter_mut().find(|record| record.key == key) {
        Some(existing) => {
            existing.root = stored;
            existing.name = display;
            existing.enabled = true;
            existing.clone()
        }
        None => {
            let record = VaultRecord {
                key,
                root: stored,
                name: display,
                added_at: iso8601_now(),
                last_scan_at: None,
                enabled: true,
                file_count: 0,
            };
            store.vaults.push(record.clone());
            record
        }
    };
    save_store_at(&path, &store)?;
    request_resync(app);
    Ok(record)
}

fn scan_blocking(app: &AppHandle, key: &str) -> Result<VaultScanResult, String> {
    let path = store_path(app)?;
    let mut store = load_store_at(&path)?;
    let (record, root) = vault_root(&store, key)?;

    let mut files: Vec<VaultFileStamp> = Vec::new();
    let mut skipped: Vec<VaultSkipped> = Vec::new();
    let reserved = reserved_root(app);
    walk_vault(&root, reserved.as_deref(), &mut files, &mut skipped);
    files.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    skipped.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));

    let scanned_at = iso8601_now();
    let file_count = files.len() as u64;
    let result = VaultScanResult {
        key: record.key.clone(),
        root: storage::plain_path(&root).to_string_lossy().to_string(),
        files,
        skipped,
        file_count,
        scanned_at: scanned_at.clone(),
    };

    // Bookkeeping only: a failed write here must not lose a good scan result.
    if let Some(entry) = store.vaults.iter_mut().find(|entry| entry.key == record.key) {
        entry.last_scan_at = Some(scanned_at);
        entry.file_count = file_count;
        if let Err(error) = save_store_at(&path, &store) {
            eprintln!("[vault] cannot record the scan time: {error}");
        }
    }

    Ok(result)
}

/// The renderer batches reads; anything above `MAX_BATCH_FILES` is a caller bug
/// and is rejected before any file is touched.
fn check_batch_size(count: usize) -> Result<(), String> {
    if count > MAX_BATCH_FILES {
        return Err(format!(
            "too many paths in one batch: {count} (max {MAX_BATCH_FILES})"
        ));
    }
    Ok(())
}

fn read_files_blocking(
    app: &AppHandle,
    key: &str,
    paths: Vec<String>,
) -> Result<Vec<VaultFileContent>, String> {
    check_batch_size(paths.len())?;
    let store = load_store(app)?;
    let (_, root) = vault_root(&store, key)?;
    let mut out: Vec<VaultFileContent> = Vec::with_capacity(paths.len());
    for raw in paths {
        out.push(read_one(&root, &raw));
    }
    Ok(out)
}

/// Register (or re-enable) a folder as a vault.
#[tauri::command]
pub async fn vault_register(app: AppHandle, root: String) -> Result<VaultRecord, String> {
    tauri::async_runtime::spawn_blocking(move || register_blocking(&app, &root))
        .await
        .map_err(|error| error.to_string())?
}

/// Every registered vault, in whitelist order.
#[tauri::command]
pub async fn vault_list(app: AppHandle) -> Result<Vec<VaultRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || load_store(&app).map(|store| store.vaults))
        .await
        .map_err(|error| error.to_string())?
}

/// Forget a vault. Nothing on disk inside the vault is touched.
#[tauri::command]
pub async fn vault_remove(app: AppHandle, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = store_path(&app)?;
        let mut store = load_store_at(&path)?;
        // The key must resolve first: a stale key is an error, not a no-op.
        let _record = find_vault(&store, &key)?;
        store.vaults.retain(|record| record.key != key);
        save_store_at(&path, &store)?;
        request_resync(&app);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Recursive scan of one vault. No diffing: the renderer compares the returned
/// stamps against its own to work out what changed.
#[tauri::command]
pub async fn vault_scan(app: AppHandle, key: String) -> Result<VaultScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || scan_blocking(&app, &key))
        .await
        .map_err(|error| error.to_string())?
}

/// Batch read of file bodies. Call with at most 200 paths per call.
#[tauri::command]
pub async fn vault_read_file(
    app: AppHandle,
    key: String,
    paths: Vec<String>,
) -> Result<Vec<VaultFileContent>, String> {
    tauri::async_runtime::spawn_blocking(move || read_files_blocking(&app, &key, paths))
        .await
        .map_err(|error| error.to_string())?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("qing-vault-test-{tag}-{stamp}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_file(path: &Path, body: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, body).expect("write fixture");
    }

    #[test]
    fn derive_key_is_stable_short_and_lowercase_hex() {
        let root = temp_root("key");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        let first = derive_key(&canonical);
        let second = derive_key(&canonical);
        assert_eq!(first, second, "the same folder must keep one key");
        assert_eq!(first.len(), 8);
        assert!(first
            .chars()
            .all(|value| value.is_ascii_digit() || ('a'..='f').contains(&value)));
        let other = derive_key(&canonical.join("nested"));
        assert_ne!(first, other, "different folders must get different keys");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sanitize_rejects_parent_directory_escape() {
        for raw in [
            "../outside.md",
            "notes/../../outside.md",
            "..\\..\\outside.md",
            "..",
            "a/./../../b.md",
        ] {
            assert!(
                sanitize_relative(raw).is_err(),
                "`..` traversal above the root must be rejected: {raw}"
            );
        }
    }

    #[test]
    fn sanitize_folds_parent_segments_that_stay_inside() {
        // A resolved markdown link routinely looks like this; folding it keeps
        // it a working link instead of a broken one.
        assert_eq!(
            sanitize_relative("notes/../a.md").expect("accepted"),
            PathBuf::from("a.md")
        );
        assert_eq!(
            sanitize_relative("notes/sub/../a.md").expect("accepted"),
            PathBuf::from("notes/a.md")
        );
    }

    #[test]
    fn sanitize_rejects_absolute_paths() {
        for raw in [
            "/etc/passwd",
            "C:\\Windows\\win.ini",
            "C:/Users/me/note.md",
            "\\\\server\\share\\note.md",
            "//server/share/note.md",
        ] {
            assert!(
                sanitize_relative(raw).is_err(),
                "absolute path must be rejected: {raw}"
            );
        }
    }

    #[test]
    fn sanitize_accepts_regular_relative_paths() {
        assert_eq!(
            sanitize_relative("notes/会议纪要（一）.md").expect("accepted"),
            PathBuf::from("notes/会议纪要（一）.md")
        );
        assert_eq!(
            sanitize_relative("notes\\sub dir\\a.md").expect("accepted"),
            PathBuf::from("notes/sub dir/a.md")
        );
        assert_eq!(
            sanitize_relative("./readme.txt").expect("accepted"),
            PathBuf::from("readme.txt")
        );
    }

    #[test]
    fn prefix_check_compares_path_components() {
        let parent = temp_root("prefix");
        let vault = parent.join("data");
        let sibling = parent.join("data2");
        fs::create_dir_all(&vault).expect("create vault");
        fs::create_dir_all(&sibling).expect("create sibling");
        let evidence = sibling.join("secret.md");
        write_file(&evidence, b"# secret\n");

        let canonical_root = fs::canonicalize(&vault).expect("canonicalize vault");
        let canonical_evidence = fs::canonicalize(&evidence).expect("canonicalize evidence");

        // The whole reason `Path::starts_with` is used instead of `String`.
        assert!(canonical_evidence
            .to_string_lossy()
            .to_string()
            .starts_with(&canonical_root.to_string_lossy().to_string()));
        assert!(
            !is_within(&canonical_root, &canonical_evidence),
            "a sibling sharing the name prefix must stay outside the vault"
        );

        // And the same verdict through the function the commands actually use.
        let escape = format!(
            "../{}/secret.md",
            sibling.file_name().expect("name").to_string_lossy()
        );
        assert!(resolve_within(&canonical_root, &escape).is_err());

        let inside = vault.join("ok.md");
        write_file(&inside, b"# ok\n");
        assert!(resolve_within(&canonical_root, "ok.md").is_ok());

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn canonicalized_target_outside_root_is_rejected() {
        let parent = temp_root("symlink");
        let vault = parent.join("vault");
        let outside = parent.join("outside");
        fs::create_dir_all(&vault).expect("create vault");
        fs::create_dir_all(&outside).expect("create outside");
        write_file(&outside.join("leak.md"), b"# leak\n");
        let canonical_root = fs::canonicalize(&vault).expect("canonicalize vault");

        // A link inside the vault that points outside it must not resolve.
        // A Unix symlink and a Windows directory symlink both need privileges
        // that a test run may not have, so a junction is tried next: it needs
        // none, and it is the reparse point a user is most likely to have.
        #[cfg(unix)]
        let link = std::os::unix::fs::symlink(&outside, vault.join("link"));
        #[cfg(windows)]
        let link = std::os::windows::fs::symlink_dir(&outside, vault.join("link"))
            .or_else(|symlink_error| {
                let spawn = std::process::Command::new("cmd")
                    .args([
                        "/C",
                        "mklink",
                        "/J",
                        &vault.join("link").to_string_lossy().to_string(),
                        &outside.to_string_lossy().to_string(),
                    ])
                    .output();
                match spawn {
                    Ok(output) if output.status.success() => Ok(()),
                    _ => Err(symlink_error),
                }
            });

        match link {
            Ok(()) => {
                let result = resolve_within(&canonical_root, "link/leak.md");
                assert!(
                    result.is_err(),
                    "a link out of the vault must be rejected, got {result:?}"
                );
            }
            Err(error) => {
                eprintln!("[vault-test] no symlink or junction available, skipping: {error}");
            }
        }

        // A path that does not exist under the root is an error too.
        assert!(resolve_within(&canonical_root, "missing.md").is_err());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn unknown_vault_key_is_rejected() {
        let root = temp_root("unknown");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        let key = derive_key(&canonical);
        let store = VaultStoreFile {
            version: STORE_VERSION,
            vaults: vec![VaultRecord {
                key: key.clone(),
                root: canonical.to_string_lossy().to_string(),
                name: "root".to_string(),
                added_at: iso8601_now(),
                last_scan_at: None,
                enabled: true,
                file_count: 0,
            }],
        };
        validate_store(&store).expect("fixture must validate");
        assert!(find_vault(&store, &key).is_ok());
        assert!(find_vault(&store, "00000000").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn store_rejects_tampered_records() {
        let root = temp_root("tamper");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        let wrong_key = VaultStoreFile {
            version: STORE_VERSION,
            vaults: vec![VaultRecord {
                key: "deadbeef".to_string(),
                root: canonical.to_string_lossy().to_string(),
                name: "root".to_string(),
                added_at: iso8601_now(),
                last_scan_at: None,
                enabled: true,
                file_count: 0,
            }],
        };
        assert!(validate_store(&wrong_key).is_err(), "key must match its root");

        let bad_version = VaultStoreFile {
            version: 99,
            vaults: Vec::new(),
        };
        assert!(validate_store(&bad_version).is_err());

        let mut store = VaultStoreFile::default();
        store.vaults.push(VaultRecord {
            key: derive_key(&canonical),
            root: canonical.to_string_lossy().to_string(),
            name: "root".to_string(),
            added_at: iso8601_now(),
            last_scan_at: None,
            enabled: true,
            file_count: 0,
        });
        let path = root.join("graph").join(VAULTS_FILE);
        save_store_at(&path, &store).expect("save");
        let reloaded = load_store_at(&path).expect("load");
        assert_eq!(reloaded.vaults.len(), 1);

        fs::write(&path, "{ not json").expect("tamper");
        assert!(load_store_at(&path).is_err(), "corrupt json must be an error");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_ignores_hidden_and_build_directories() {
        let root = temp_root("walk");
        write_file(&root.join("keep").join("笔记（一）.md"), b"# a\n");
        write_file(&root.join("keep").join("image.png"), b"png");
        write_file(&root.join("readme.txt"), b"txt");
        write_file(&root.join("upper.MD"), b"# upper\n");
        write_file(&root.join(".hidden.md"), b"# hidden\n");
        write_file(&root.join(".git").join("config.md"), b"# git\n");
        write_file(&root.join("node_modules").join("pkg.md"), b"# pkg\n");
        write_file(&root.join(".obsidian").join("workspace.md"), b"# obs\n");

        let canonical = fs::canonicalize(&root).expect("canonicalize");
        let mut files: Vec<VaultFileStamp> = Vec::new();
        let mut skipped: Vec<VaultSkipped> = Vec::new();
        walk_vault(&canonical, None, &mut files, &mut skipped);
        files.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));

        let paths: Vec<&str> = files.iter().map(|file| file.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["keep/笔记（一）.md", "readme.txt", "upper.MD"]);
        for file in &files {
            assert!(!file.rel_path.starts_with('.'));
            assert!(!file.rel_path.contains("node_modules"));
            assert!(file.bytes > 0);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_one_reports_oversize_without_failing() {
        let root = temp_root("oversize");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        let big = canonical.join("big.md");
        write_file(&big, &vec![b'a'; (MAX_FILE_BYTES + 1) as usize]);

        let content = read_one(&canonical, "big.md");
        assert!(content.text.is_none());
        assert!(content.skipped.is_some());
        assert_eq!(content.encoding, "none");

        // Escaping paths are per-file failures as well, not batch errors.
        let escaped = read_one(&canonical, "../outside.md");
        assert!(escaped.text.is_none());
        assert!(escaped.skipped.is_some());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn decode_handles_bom_utf8_and_gb18030() {
        let (text, encoding) = decode_text("很普通".as_bytes());
        assert_eq!(text, "很普通");
        assert_eq!(encoding, "utf-8");

        let mut with_bom = vec![0xEF_u8, 0xBB, 0xBF];
        with_bom.extend_from_slice("# 标题".as_bytes());
        let (text, encoding) = decode_text(&with_bom);
        assert_eq!(text, "# 标题");
        assert_eq!(encoding, "utf-8-bom");

        // GBK bytes for "中文", invalid as UTF-8 on purpose.
        let (text, encoding) = decode_text(&[0xD6_u8, 0xD0, 0xCE, 0xC4]);
        assert_eq!(text, "中文");
        assert_eq!(encoding, "gb18030");
    }

    #[test]
    fn debounce_merges_repeated_events_of_one_save() {
        let start = Instant::now();
        let mut state = DebounceState::default();
        state.push(
            "aaaa1111",
            BatchEntry::File {
                rel_path: "notes/a.md".to_string(),
                mtime_ms: 1000,
            },
            start,
            DEBOUNCE_WINDOW,
        );
        state.push(
            "aaaa1111",
            BatchEntry::File {
                rel_path: "notes/a.md".to_string(),
                mtime_ms: 1000,
            },
            start + Duration::from_millis(120),
            DEBOUNCE_WINDOW,
        );
        state.push(
            "aaaa1111",
            BatchEntry::File {
                rel_path: "notes/b.md".to_string(),
                mtime_ms: 2000,
            },
            start + Duration::from_millis(200),
            DEBOUNCE_WINDOW,
        );

        assert!(!state.due(start + Duration::from_millis(299)));
        assert!(state.due(start + Duration::from_millis(300)));

        let batches = state.take();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].changed, vec!["notes/a.md", "notes/b.md"]);
        assert!(!batches[0].full);
        assert!(state.take().is_empty(), "a drained window must be empty");
    }

    #[test]
    fn debounce_keeps_two_real_saves_of_the_same_file() {
        let start = Instant::now();
        let mut state = DebounceState::default();
        state.push(
            "aaaa1111",
            BatchEntry::File {
                rel_path: "notes/a.md".to_string(),
                mtime_ms: 1000,
            },
            start,
            DEBOUNCE_WINDOW,
        );
        state.push(
            "aaaa1111",
            BatchEntry::File {
                rel_path: "notes/a.md".to_string(),
                mtime_ms: 1500,
            },
            start + Duration::from_millis(80),
            DEBOUNCE_WINDOW,
        );
        let batches = state.take();
        assert_eq!(batches.len(), 1);
        // One path, but both mtimes were recorded, so the renderer re-stats.
        assert_eq!(batches[0].changed, vec!["notes/a.md"]);
        assert!(batches[0].changed.len() == 1);
    }

    #[test]
    fn debounce_full_flag_is_sticky_and_windows_are_per_vault() {
        let start = Instant::now();
        let mut state = DebounceState::default();
        state.push(
            "aaaa1111",
            BatchEntry::Full,
            start,
            DEBOUNCE_WINDOW,
        );
        state.push(
            "bbbb2222",
            BatchEntry::File {
                rel_path: "x.md".to_string(),
                mtime_ms: 10,
            },
            start + Duration::from_millis(50),
            DEBOUNCE_WINDOW,
        );
        let batches = state.take();
        assert_eq!(batches.len(), 2);
        let first = batches
            .iter()
            .find(|batch| batch.key == "aaaa1111")
            .expect("full batch");
        assert!(first.full);
        assert!(first.changed.is_empty());
        let second = batches
            .iter()
            .find(|batch| batch.key == "bbbb2222")
            .expect("file batch");
        assert!(!second.full);
        assert_eq!(second.changed, vec!["x.md"]);
    }

    #[test]
    fn translate_event_escalates_directories_but_drops_foreign_files() {
        let root = temp_root("events");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        write_file(&canonical.join("notes").join("a.md"), b"# a\n");
        write_file(&canonical.join("notes").join("image.png"), b"png");

        let note = canonical.join("notes").join("a.md");
        let event = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(note.clone());
        let (concrete, full) = translate_event(&canonical, None, event);
        assert!(!full, "a real note file must not force a full rescan");
        assert_eq!(concrete.len(), 1);
        assert_eq!(concrete[0].0, "notes/a.md");
        assert!(concrete[0].1 > 0);

        // A directory-level event cannot name the files it affected.
        let event = notify::Event::new(EventKind::Create(notify::event::CreateKind::Folder))
            .add_path(canonical.join("notes"));
        let (_, full) = translate_event(&canonical, None, event);
        assert!(full);

        // A non-note file is never indexed, so it never asks for a rescan —
        // not even when the path is already gone.
        let event = notify::Event::new(EventKind::Remove(notify::event::RemoveKind::File))
            .add_path(canonical.join("notes").join("gone.png"));
        let (concrete, full) = translate_event(&canonical, None, event);
        assert!(concrete.is_empty());
        assert!(!full, "a removed .png must not force a full rescan");

        // Reads are not changes: this module reads the vault itself.
        let event = notify::Event::new(EventKind::Access(notify::event::AccessKind::Read))
            .add_path(note);
        let (concrete, full) = translate_event(&canonical, None, event);
        assert!(concrete.is_empty());
        assert!(!full);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn register_refuses_the_data_root_and_its_children_but_not_a_sibling() {
        // `<data>` and everything under it would make the app's own graph
        // artefacts both the input and the output of the scan.
        let data_root = temp_root("reserved");
        let notes = data_root.join("notes");
        fs::create_dir_all(&notes).expect("create notes");
        let sibling = temp_root("sibling");
        let canonical_data = fs::canonicalize(&data_root).expect("canonicalize data root");
        let canonical_notes = fs::canonicalize(&notes).expect("canonicalize notes");
        let canonical_sibling = fs::canonicalize(&sibling).expect("canonicalize sibling");

        assert!(
            check_root_not_reserved(&canonical_data, &canonical_data).is_err(),
            "the data directory itself must be refused"
        );
        assert!(
            check_root_not_reserved(&canonical_notes, &canonical_data).is_err(),
            "a folder inside the data directory must be refused"
        );
        let error = check_root_not_reserved(&canonical_notes, &canonical_data)
            .expect_err("refused");
        assert_eq!(error, RESERVED_ROOT_ERROR);
        assert!(
            check_root_not_reserved(&canonical_sibling, &canonical_data).is_ok(),
            "an unrelated folder must still be accepted"
        );
        // Component-wise, never a string prefix: a name that merely starts with
        // the same characters is a different folder.
        let lookalike = temp_root("reserved2");
        let canonical_lookalike = fs::canonicalize(&lookalike).expect("canonicalize lookalike");
        assert!(check_root_not_reserved(&canonical_lookalike, &canonical_data).is_ok());

        let _ = fs::remove_dir_all(&data_root);
        let _ = fs::remove_dir_all(&sibling);
        let _ = fs::remove_dir_all(&lookalike);
    }

    #[test]
    fn scan_prunes_the_data_directory_but_keeps_its_neighbours() {
        let root = temp_root("prune");
        write_file(&root.join("notes").join("a.md"), b"# a\n");
        write_file(&root.join("data").join("graph").join("x.ndjson"), b"{}");
        write_file(&root.join("data").join("notes").join("y.md"), b"# y\n");

        let canonical = fs::canonicalize(&root).expect("canonicalize");
        let data = fs::canonicalize(canonical.join("data")).expect("canonicalize data");
        let reserved = compare_form(&data);

        let mut files: Vec<VaultFileStamp> = Vec::new();
        let mut skipped: Vec<VaultSkipped> = Vec::new();
        walk_vault(&canonical, Some(&reserved), &mut files, &mut skipped);
        files.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));

        let paths: Vec<&str> = files.iter().map(|file| file.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["notes/a.md"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn events_under_the_data_root_are_dropped_without_a_rescan() {
        let root = temp_root("reserved-events");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        write_file(&canonical.join("notes").join("a.md"), b"# a\n");
        write_file(
            &canonical.join("graph").join("index").join("positions.ndjson"),
            b"{}\n",
        );
        let reserved = compare_form(&canonical.join("graph"));

        // Exactly the write that used to start the loop: the temp file of the
        // atomic rename, which is already gone when the event arrives.
        let temporary = canonical
            .join("graph")
            .join("index")
            .join("positions.ndjson.tmp");
        let event = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::From,
        )))
        .add_path(temporary);
        let (concrete, full) = translate_event(&canonical, Some(&reserved), event);
        assert!(concrete.is_empty(), "no concrete file may come out of it");
        assert!(!full, "and no full rescan may come out of it either");

        // A note inside the data directory is equally not part of the vault.
        let event = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(canonical.join("graph").join("cache").join("note.md"));
        let (concrete, full) = translate_event(&canonical, Some(&reserved), event);
        assert!(concrete.is_empty());
        assert!(!full);

        // The very same file one level outside the reserved root is reported.
        let event = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(canonical.join("notes").join("a.md"));
        let (concrete, full) = translate_event(&canonical, Some(&reserved), event);
        assert_eq!(concrete.len(), 1);
        assert!(!full);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_non_note_temporary_file_never_escalates() {
        // `positions.ndjson` is written as `positions.ndjson.tmp` + rename; by
        // the time the `From` event is handled the temp path is gone. That used
        // to be "a removal we cannot classify" and forced a full rescan.
        let root = temp_root("tmp-event");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        let missing = canonical.join("index").join("positions.ndjson.tmp");
        assert!(!missing.exists());

        let event = notify::Event::new(EventKind::Remove(notify::event::RemoveKind::File))
            .add_path(missing);
        let (concrete, full) = translate_event(&canonical, None, event);
        assert!(concrete.is_empty());
        assert!(!full, "a non-note path must never escalate to a full rescan");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn renaming_a_note_to_a_non_note_still_reports_the_note() {
        // Safety argument for dropping missing non-note paths: `From` is `a.md`,
        // which takes the note branch and reports `mtime = 0` — the delete is
        // not lost.
        let root = temp_root("rename-away");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        write_file(&canonical.join("notes").join("a.md"), b"# a\n");

        let event = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::From,
        )))
        .add_path(canonical.join("notes").join("a.md"));
        let (concrete, full) = translate_event(&canonical, None, event);
        assert!(!full);
        assert_eq!(concrete.len(), 1);
        assert_eq!(concrete[0].0, "notes/a.md");
        assert!(concrete[0].1 > 0);

        // Move the file away, then replay the same event: the stamp is 0, which
        // is what tells the renderer to drop the node.
        let moved = canonical.join("notes").join("a.png");
        fs::rename(canonical.join("notes").join("a.md"), &moved).expect("rename");
        let event = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::From,
        )))
        .add_path(canonical.join("notes").join("a.md"));
        let (concrete, full) = translate_event(&canonical, None, event);
        assert!(!full);
        assert_eq!(concrete.len(), 1);
        assert_eq!(concrete[0].0, "notes/a.md");
        assert_eq!(concrete[0].1, 0, "a vanished note reports mtime 0");

        // The `To` half of the same rename names `a.txt`, a non-note file, and
        // is dropped without a rescan.
        let event = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::To,
        )))
        .add_path(moved);
        let (concrete, full) = translate_event(&canonical, None, event);
        assert!(concrete.is_empty());
        assert!(!full);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn batch_guard_accepts_two_hundred_paths_and_rejects_two_hundred_one() {
        assert!(check_batch_size(MAX_BATCH_FILES).is_ok());
        assert!(check_batch_size(0).is_ok());
        assert!(check_batch_size(MAX_BATCH_FILES + 1).is_err());
        let error = check_batch_size(MAX_BATCH_FILES + 1).expect_err("rejected");
        assert!(error.contains("201"));
        assert!(error.contains("200"));
    }

    #[test]
    fn iso8601_matches_a_known_timestamp() {
        let time = UNIX_EPOCH + Duration::from_secs(1_730_000_000);
        assert_eq!(iso8601_from(time), "2024-10-27T03:33:20.000Z");
        let now = iso8601_now();
        assert!(now.ends_with('Z'));
        assert_eq!(now.len(), "2024-10-27T03:33:20.000Z".len());
    }

    #[test]
    fn wire_paths_use_forward_slashes_and_keep_names() {
        let root = temp_root("wire");
        let canonical = fs::canonicalize(&root).expect("canonicalize");
        let nested = canonical.join("sub dir").join("卡片（一）.md");
        write_file(&nested, b"# x\n");
        assert_eq!(
            relative_wire(&canonical, &nested),
            Some("sub dir/卡片（一）.md".to_string())
        );
        assert_eq!(relative_wire(&canonical, &canonical), Some(String::new()));
        assert_eq!(relative_wire(&canonical, Path::new("/nowhere/at/all")), None);
        assert_eq!(normalize_wire("a\\b\\c.md"), "a/b/c.md");
        let _ = fs::remove_dir_all(&root);
    }
}
