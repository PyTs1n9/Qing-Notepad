//! Plugin packages: install, enable, rollback, private storage, index, logs.
//!
//! The threat model is in `docs/analysis-extension-host.md` §6 ("风险与不做什么").
//! Two rules shape every function here:
//!
//! 1. **Nothing from the package is trusted.** Entry names, sizes and the
//!    manifest are checked before a single byte lands outside `.staging/`, and
//!    a rejected package leaves no partial install behind.
//! 2. **Installing is two phases.** `dry_run: true` extracts into `.staging/`
//!    and returns the manifest; the frontend then checks `engines.host` with the
//!    real semver parser and asks the user for permissions; `dry_run: false`
//!    promotes the staged directory. Doing the range check in Rust would mean a
//!    second implementation of semver ranges (see `plugin_manifest.rs`).

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::plugin_manifest::{self, PluginManifest};

/// `.qnp` packages are zips; these limits are the ones documented to authors.
const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED: u64 = 20 * 1024 * 1024;
const MAX_SINGLE_FILE: u64 = 5 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;
/// Private key/value store per plugin.
const STORAGE_QUOTA_BYTES: usize = 1024 * 1024;
const LOG_LINES: usize = 100;
const INDEX_TTL_SECS: u64 = 24 * 60 * 60;
const INDEX_URLS: [(&str, &str); 2] = [
    (
        "github",
        "https://raw.githubusercontent.com/PyTs1n9/Qing-Notepad-Plugins/main/index.json",
    ),
    (
        "jsdelivr",
        "https://cdn.jsdelivr.net/gh/PyTs1n9/Qing-Notepad-Plugins@main/index.json",
    ),
];
const USER_AGENT: &str = "QingNotepad-PluginManager/1";
/// The newest index `schema` this build understands.
///
/// The field has been in the document since the first index and was read by
/// nobody, which is the same as not having it: the day the index moves to
/// schema 2 (new required field, different entry shape) every build shipped
/// before that day would mis-read it silently — `#[serde(default)]` fields would
/// come through empty and the market would look broken rather than old. A newer
/// schema is therefore an error, which lands in the existing "degrade to
/// cached/missing" path and says so in the log.
const SUPPORTED_INDEX_SCHEMA: u32 = 1;
const STAGING_DIR: &str = ".staging";
const INSTALLED_FILE: &str = "installed.json";
const INDEX_CACHE_FILE: &str = "index-cache.json";
const STORAGE_FILE: &str = "storage.json";
const LOG_FILE: &str = "error.log";

// ---------------------------------------------------------------------------
// Install records
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRecord {
    pub version: String,
    #[serde(default)]
    pub previous_version: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub granted_permissions: Vec<String>,
    #[serde(default)]
    pub installed_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledFile {
    #[serde(default = "default_schema")]
    schema: u32,
    #[serde(default)]
    plugins: BTreeMap<String, InstalledRecord>,
}

fn default_schema() -> u32 {
    1
}

impl Default for InstalledFile {
    fn default() -> Self {
        Self {
            schema: 1,
            plugins: BTreeMap::new(),
        }
    }
}

/// What `plugin_list_installed` returns: the record plus its manifest, so the
/// frontend can build the command palette without one IPC per plugin.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginDto {
    pub id: String,
    pub version: String,
    pub previous_version: Option<String>,
    pub enabled: bool,
    pub granted_permissions: Vec<String>,
    pub installed_at: String,
    pub updated_at: String,
    pub source: String,
    pub manifest: Option<PluginManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    /// Phase 1: a package already on disk. Either an archive (`.qnp` / `.zip`)
    /// or a directory — the frontend hands over whatever the picker returned.
    #[serde(default)]
    archive_path: Option<String>,
    /// Phase 1: a URL from the index (downloaded in Rust, outside the CSP).
    #[serde(default)]
    archive_url: Option<String>,
    /// Phase 2: the staging directory returned by phase 1.
    #[serde(default)]
    staging_id: Option<String>,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    expected_sha256: Option<String>,
    #[serde(default)]
    granted_permissions: Option<Vec<String>>,
    #[serde(default)]
    source: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub dry_run: bool,
    pub staging_id: Option<String>,
    pub manifest: PluginManifest,
    pub sha256: Option<String>,
    pub record: Option<InstalledPluginDto>,
}

// ---------------------------------------------------------------------------
// Paths and small helpers
// ---------------------------------------------------------------------------

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = crate::storage::data_root(app)?;
    let dir = root.join("plugins");
    fs::create_dir_all(&dir).map_err(|error| format!("E_IO: {error}"))?;
    Ok(dir)
}

fn installed_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(plugins_root(app)?.join(INSTALLED_FILE))
}

fn read_installed(app: &AppHandle) -> Result<InstalledFile, String> {
    let path = installed_path(app)?;
    if !path.is_file() {
        return Ok(InstalledFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|error| format!("E_IO: {error}"))?;
    // A hand-edited or half-written manifest must not take the whole feature
    // down: an unreadable file is treated as "nothing installed" and rewritten
    // on the next mutation.
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

/// Write through a temp file so an interrupted write cannot leave a half JSON
/// document that the next launch would read as "no plugins".
fn write_installed(app: &AppHandle, document: &InstalledFile) -> Result<(), String> {
    let path = installed_path(app)?;
    let temp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(document).map_err(|error| error.to_string())?;
    fs::write(&temp, body).map_err(|error| format!("E_IO: {error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("E_IO: {error}"))?;
    Ok(())
}

fn installed_record_dir(app: &AppHandle, id: &str, version: &str) -> Result<PathBuf, String> {
    Ok(plugins_root(app)?.join(id).join(version))
}

fn plugin_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(plugins_root(app)?.join(id))
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    iso_from_unix(secs)
}

fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month,
        day,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's `civil_from_days`, so the ISO timestamps in
/// `installed.json` do not pull a date crate in for four numbers.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn unique_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "{:x}{:x}{:x}",
        nanos,
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_valid_storage_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && !key.chars().any(|ch| ch.is_control())
}

/// `notes:write` implies `notes:read` and `todo:write` implies `todo:read`, so
/// the grant list is expanded once on install instead of being re-derived at
/// every call site.
fn expand_permissions(permissions: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for permission in permissions {
        if !out.contains(permission) {
            out.push(permission.clone());
        }
        let implied = match permission.as_str() {
            "notes:write" => Some("notes:read"),
            "todo:write" => Some("todo:read"),
            _ => None,
        };
        if let Some(implied) = implied {
            if !out.iter().any(|item| item == implied) {
                out.push(implied.to_string());
            }
        }
    }
    out.sort();
    out
}

fn is_grantable(permission: &str, declared: &[String]) -> bool {
    if declared.iter().any(|item| item == permission) {
        return true;
    }
    // The implied read permission can be granted even when only the write one
    // is declared, because the write permission already implies it.
    match permission {
        "notes:read" => declared.iter().any(|item| item == "notes:write"),
        "todo:read" => declared.iter().any(|item| item == "todo:write"),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Archive / directory safety
// ---------------------------------------------------------------------------

fn is_native_module(name: &str) -> bool {
    const BANNED: [&str; 6] = [".dll", ".node", ".exe", ".so", ".dylib", ".wasm"];
    let lower = name.to_ascii_lowercase();
    BANNED.iter().any(|extension| lower.ends_with(extension))
}

/// Reject traversal, absolute paths and Windows drive prefixes, then rebuild the
/// path one component at a time so nothing survives that could escape the root.
///
/// A colon anywhere is refused as well. On NTFS `name:stream` is not a file
/// name: writing it creates the file `name` plus an *alternate data stream*, so
/// an entry called `addon.node:payload` lands as a zero-byte `addon.node` and
/// the bytes hide where `is_native_module`, a content scan and the user browsing
/// the folder all fail to see them. A package has no legitimate use for a
/// stream, so the shape is refused rather than sanitised.
fn safe_entry_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("E_ZIP_SLIP: empty entry name".into());
    }
    if raw.contains('\0') {
        return Err("E_ZIP_SLIP: entry name contains a NUL byte".into());
    }
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(format!("E_ZIP_SLIP: absolute entry `{raw}`"));
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return Err(format!("E_ZIP_SLIP: drive-relative entry `{raw}`"));
    }
    let mut out = PathBuf::new();
    for component in normalized.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component.contains(':') {
            return Err(format!(
                "E_ZIP_SLIP: entry name contains a colon (an NTFS stream) `{raw}`"
            ));
        }
        if component == ".." {
            return Err(format!("E_ZIP_SLIP: entry escapes the package root `{raw}`"));
        }
        out.push(component);
    }
    if out.as_os_str().is_empty() {
        return Err(format!("E_ZIP_SLIP: entry has no file name `{raw}`"));
    }
    Ok(out)
}

/// Validate every entry first, then extract. A package with one bad entry
/// therefore never produces a partially written staging tree.
fn extract_archive(archive: &Path, target: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| format!("E_IO: {error}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| format!("E_NOT_A_PACKAGE: {error}"))?;

    if zip.len() > MAX_ENTRIES {
        return Err(format!(
            "E_TOO_MANY_FILES: package has {} entries (limit {MAX_ENTRIES})",
            zip.len()
        ));
    }

    let mut plan: Vec<(usize, PathBuf)> = Vec::new();
    let mut declared_total = 0_u64;
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|error| format!("E_NOT_A_PACKAGE: {error}"))?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        if let Some(mode) = entry.unix_mode() {
            // S_IFLNK: a link entry is a zip-slip vector no name check catches.
            if mode & 0o170000 == 0o120000 {
                return Err(format!("E_ZIP_SLIP: symbolic link entry `{name}`"));
            }
        }
        if is_native_module(&name) {
            return Err(format!("E_NATIVE_MODULE: `{name}`"));
        }
        let relative = safe_entry_path(&name)?;
        if entry.size() > MAX_SINGLE_FILE {
            return Err(format!("E_TOO_LARGE: `{name}` exceeds 5 MB"));
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_TOTAL_UNCOMPRESSED {
            return Err("E_TOO_LARGE: package expands past 20 MB".into());
        }
        plan.push((index, relative));
    }

    fs::create_dir_all(target).map_err(|error| format!("E_IO: {error}"))?;

    let mut written_total = 0_u64;
    for (index, relative) in plan {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| format!("E_NOT_A_PACKAGE: {error}"))?;
        // The header size is a claim; the cap here is what actually enforces it.
        let mut buffer = Vec::new();
        entry
            .by_ref()
            .take(MAX_SINGLE_FILE + 1)
            .read_to_end(&mut buffer)
            .map_err(|error| format!("E_NOT_A_PACKAGE: {error}"))?;
        if buffer.len() as u64 > MAX_SINGLE_FILE {
            return Err("E_TOO_LARGE: an entry grew past 5 MB while extracting".into());
        }
        written_total = written_total.saturating_add(buffer.len() as u64);
        if written_total > MAX_TOTAL_UNCOMPRESSED {
            return Err("E_TOO_LARGE: package expands past 20 MB".into());
        }
        let destination = target.join(&relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("E_IO: {error}"))?;
        }
        let mut out = File::create(&destination).map_err(|error| format!("E_IO: {error}"))?;
        out.write_all(&buffer)
            .map_err(|error| format!("E_IO: {error}"))?;
    }

    if let Some(name) = unwrap_single_wrapper_folder(target)? {
        eprintln!("[plugin-install] unwrapped single folder: {name}");
    }

    Ok(())
}

/// Is there a manifest file at the root of `dir`?
///
/// Only the file names matter here; whether the file *parses* is
/// `read_manifest_any`'s problem. A build-only `package.json` counts as a
/// manifest for this purpose on purpose: its presence means the author did put
/// the package at this level, so descending one folder would be wrong.
fn has_manifest_file(dir: &Path) -> bool {
    dir.join("package.json").is_file() || dir.join("plugin.json").is_file()
}

/// Move the contents of a single wrapper folder up one level.
///
/// Some zip tools always wrap the package in a folder: Explorer's
/// "Send to → Compressed (zipped) folder" does, and so does GitHub's
/// "Download ZIP". The result is a well-formed archive whose root holds one
/// directory, which by the letter of the layout rule is "no manifest at the
/// root" — a very common shape to reject.
///
/// The layout is normalised once, here, rather than teaching the reader that a
/// package may be one level deeper. Deliberately not recursive and not a
/// search: if the root holds anything besides that one folder, or the folder
/// has no manifest of its own, the archive is left alone and the caller reports
/// the shape it actually saw. Guessing further would install a different tree
/// than the author zipped.
fn unwrap_single_wrapper_folder(staging_dir: &Path) -> Result<Option<String>, String> {
    if has_manifest_file(staging_dir) {
        return Ok(None);
    }
    let entries: Vec<fs::DirEntry> = fs::read_dir(staging_dir)
        .map_err(|error| format!("E_IO: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("E_IO: {error}"))?;
    if entries.len() != 1 {
        return Ok(None);
    }
    let entry = &entries[0];
    let file_type = entry.file_type().map_err(|error| format!("E_IO: {error}"))?;
    if !file_type.is_dir() {
        return Ok(None);
    }
    let wrapper = entry.path();
    if !has_manifest_file(&wrapper) {
        return Ok(None);
    }
    let name = entry.file_name().to_string_lossy().to_string();
    let children: Vec<fs::DirEntry> = fs::read_dir(&wrapper)
        .map_err(|error| format!("E_IO: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("E_IO: {error}"))?;
    // `pkg/pkg/...` would try to move a child onto the path it is already at.
    // Not a shape worth inventing a rule for: leave it and let the caller report
    // the missing manifest.
    if children.iter().any(|child| child.file_name() == name.as_str()) {
        return Ok(None);
    }
    for child in children {
        let destination = staging_dir.join(child.file_name());
        fs::rename(child.path(), &destination).map_err(|error| format!("E_IO: {error}"))?;
    }
    fs::remove_dir(&wrapper).map_err(|error| format!("E_IO: {error}"))?;
    Ok(Some(name))
}

/// Which manifest file a package directory declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManifestFormat {
    PackageJson,
    PluginJson,
}

const MISSING_MANIFEST: &str = "E_MANIFEST_MISSING: package.json (with a `main` entry) or plugin.json must sit at the package root";

/// Decide which manifest is authoritative, without reading it as a manifest.
///
/// The discriminator is `main`: an npm `package.json` used only to drive a build
/// (scripts, devDependencies) has no `main`, so a package that still ships
/// `plugin.json` — every example in `examples/`, and every install made before
/// this format existed — keeps working untouched. A `package.json` that *does*
/// have `main` is authoritative: if it is missing a `name` the install fails
/// instead of silently falling back, because installing a different manifest
/// than the author wrote is worse than an error.
///
/// A `package.json` that cannot be parsed counts as authoritative too — it is
/// the file the install tried and failed to read, and the note added by
/// `with_shadow_note` is what tells the author why the `plugin.json` next to it
/// was ignored.
fn declared_format(dir: &Path) -> ManifestFormat {
    let package_path = dir.join("package.json");
    if !package_path.is_file() {
        return ManifestFormat::PluginJson;
    }
    let declares_main = fs::read_to_string(&package_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|document| {
            document
                .get("main")
                .and_then(Value::as_str)
                .map(|main| !main.trim().is_empty())
                .unwrap_or(false)
        })
        .unwrap_or(true);
    if declares_main {
        ManifestFormat::PackageJson
    } else {
        ManifestFormat::PluginJson
    }
}

/// Read the manifest from a package directory, whichever format it shipped.
fn read_manifest_any(dir: &Path) -> Result<PluginManifest, String> {
    match declared_format(dir) {
        ManifestFormat::PackageJson => {
            let path = dir.join("package.json");
            let raw = fs::read_to_string(&path).map_err(|error| format!("E_IO: {error}"))?;
            plugin_manifest::from_package_json(&raw).map_err(|error| error.message())
        }
        ManifestFormat::PluginJson => {
            let path = dir.join("plugin.json");
            if !path.is_file() {
                return Err(MISSING_MANIFEST.into());
            }
            let raw = fs::read_to_string(&path).map_err(|error| format!("E_IO: {error}"))?;
            serde_json::from_str(&raw).map_err(|error| format!("E_MANIFEST_INVALID: {error}"))
        }
    }
}

/// Explain a second manifest sitting next to the one that won.
///
/// Only ever appended to an error, never used to switch files: an install that
/// silently falls back to the other manifest puts a package on disk that the
/// author did not write, and the failure mode after that (a command that does
/// not exist, a `main` pointing at last build's file) is much harder to read
/// than the sentence below.
///
/// "The other one exists" is not enough — the note is only added when the pair
/// is actually a pair. A lone `package.json` with no `main` has no shadowed
/// `plugin.json` to mention, and saying otherwise sends the author looking for
/// a file that is not there.
fn with_shadow_note(dir: &Path, error: String) -> String {
    match declared_format(dir) {
        ManifestFormat::PackageJson => {
            if !dir.join("plugin.json").is_file() {
                return error;
            }
            format!(
                "{error}\nnote: plugin.json also exists but package.json (which declares \"main\") takes precedence"
            )
        }
        ManifestFormat::PluginJson => {
            if !dir.join("plugin.json").is_file() || !dir.join("package.json").is_file() {
                return error;
            }
            format!(
                "{error}\nnote: package.json also exists but it has no \"main\" entry, so plugin.json takes precedence"
            )
        }
    }
}

/// Post-extraction checks shared by both install sources.
///
/// Everything here operates on the manifest, so a directory and an archive are
/// held to exactly the same rules: a valid id, a `main` that stays inside the
/// package, a permission set from the whitelist, and a single-file script entry.
fn check_staged_package(staging_dir: &Path) -> Result<PluginManifest, String> {
    // The note is attached only to "the manifest itself is wrong" — a missing
    // `main` file is a problem with the package's contents, not with which
    // manifest won, and the reader is already looking at the right file.
    let manifest = read_manifest_any(staging_dir)
        .and_then(|manifest| {
            plugin_manifest::validate(&manifest)
                .map(|()| manifest)
                .map_err(|error| error.message())
        })
        .map_err(|error| with_shadow_note(staging_dir, error))?;

    // `main` is the one path the host reads back out of the package, so it is
    // rebuilt from scratch rather than trusted — the same treatment zip entry
    // names get.
    let main_relative = safe_entry_path(&manifest.main)?;
    if is_native_module(&manifest.main) {
        return Err(format!("E_NATIVE_MODULE: `{}`", manifest.main));
    }
    if !staging_dir.join(main_relative).is_file() {
        return Err(format!(
            "E_MISSING_MAIN: `{}` is not in the package",
            manifest.main
        ));
    }
    Ok(manifest)
}

/// Copy a package directory into staging.
///
/// A directory has no zip-slip problem — there are no entry names to forge —
/// but it has its own two: symlinks (a link inside the package could point at
/// `C:\Windows`) and size (`node_modules` alone can be gigabytes). Links are
/// skipped rather than followed, and the same 5 MB / 20 MB budget the archive
/// path enforces is applied here so "installs from a folder" cannot become the
/// way around the package limits.
fn copy_package_directory(source: &Path, target: &Path) -> Result<(), String> {
    /// Directories that are build output or version control, never package
    /// content. Matched on the component name at any depth.
    const SKIP_DIRS: [&str; 2] = ["node_modules", ".git"];

    struct Budget {
        total: u64,
        files: usize,
    }

    fn walk(from: &Path, to: &Path, budget: &mut Budget) -> Result<(), String> {
        fs::create_dir_all(to).map_err(|error| format!("E_IO: {error}"))?;
        let entries = fs::read_dir(from).map_err(|error| format!("E_IO: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("E_IO: {error}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            // `file_type` does not traverse a link, which is what makes the
            // `is_symlink` branch below reachable at all.
            let file_type = entry.file_type().map_err(|error| format!("E_IO: {error}"))?;
            if file_type.is_symlink() {
                continue;
            }
            let source_path = entry.path();
            let target_path = to.join(&name);
            if file_type.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                walk(&source_path, &target_path, budget)?;
                continue;
            }
            if !file_type.is_file() {
                // Sockets, devices, junctions: nothing a plugin package is made of.
                continue;
            }
            budget.files += 1;
            if budget.files > MAX_ENTRIES {
                return Err(format!(
                    "E_TOO_MANY_FILES: package has more than {MAX_ENTRIES} files"
                ));
            }
            let meta = entry.metadata().map_err(|error| format!("E_IO: {error}"))?;
            if meta.len() > MAX_SINGLE_FILE {
                return Err(format!("E_TOO_LARGE: `{name}` exceeds 5 MB"));
            }
            budget.total = budget.total.saturating_add(meta.len());
            if budget.total > MAX_TOTAL_UNCOMPRESSED {
                return Err("E_TOO_LARGE: package is larger than 20 MB".into());
            }
            fs::copy(&source_path, &target_path).map_err(|error| format!("E_IO: {error}"))?;
        }
        Ok(())
    }

    let mut budget = Budget { total: 0, files: 0 };
    walk(source, target, &mut budget)
}

async fn download_archive(url: &str) -> Result<Vec<u8>, String> {
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("E_NETWORK: {error}"))?;
    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("E_NETWORK: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("E_NETWORK: HTTP {}", response.status()));
    }
    if let Some(length) = response.content_length() {
        if length > MAX_ARCHIVE_BYTES {
            return Err("E_TOO_LARGE: package is larger than 20 MB".into());
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("E_NETWORK: {error}"))?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("E_TOO_LARGE: package is larger than 20 MB".into());
    }
    Ok(bytes.to_vec())
}

fn to_dto(id: &str, record: &InstalledRecord, manifest: Option<PluginManifest>) -> InstalledPluginDto {
    InstalledPluginDto {
        id: id.to_string(),
        version: record.version.clone(),
        previous_version: record.previous_version.clone(),
        enabled: record.enabled,
        granted_permissions: record.granted_permissions.clone(),
        installed_at: record.installed_at.clone(),
        updated_at: record.updated_at.clone(),
        source: record.source.clone(),
        manifest,
    }
}

fn read_record_manifest(app: &AppHandle, id: &str, version: &str) -> Option<PluginManifest> {
    let dir = installed_record_dir(app, id, version).ok()?;
    read_manifest_any(&dir).ok()
}

/// Keep the current version and the one before it; anything older is dead
/// weight. Rollback still works because it only ever needs one step back.
fn prune_versions(root: &Path, id: &str, record: &InstalledRecord) {
    let dir = root.join(id);
    let keep: Vec<&str> = std::iter::once(record.version.as_str())
        .chain(record.previous_version.as_deref())
        .collect();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !keep.contains(&name.as_str()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// Commands: install / uninstall / enable / rollback / manifest
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn plugin_list_installed(app: AppHandle) -> Result<Vec<InstalledPluginDto>, String> {
    let document = read_installed(&app)?;
    Ok(document
        .plugins
        .iter()
        .map(|(id, record)| {
            let manifest = read_record_manifest(&app, id, &record.version);
            to_dto(id, record, manifest)
        })
        .collect())
}

#[tauri::command]
pub async fn plugin_install(app: AppHandle, request: InstallRequest) -> Result<InstallResult, String> {
    if request.dry_run {
        stage_install(app, request).await
    } else {
        commit_install(&app, request)
    }
}

/// Phase 1: download or read the archive, verify sha256, extract into
/// `.staging/<token>/`, and hand the manifest back for the version/permission
/// checks that need the real semver implementation.
async fn stage_install(app: AppHandle, request: InstallRequest) -> Result<InstallResult, String> {
    let root = plugins_root(&app)?;
    let staging_root = root.join(STAGING_DIR);
    // A previous cancelled run must not accumulate: staging is scratch space.
    let _ = fs::remove_dir_all(&staging_root);
    fs::create_dir_all(&staging_root).map_err(|error| format!("E_IO: {error}"))?;

    let token = unique_token();
    let archive_path = staging_root.join(format!("{token}.qnp"));
    let staging_dir = staging_root.join(&token);

    let result = stage_install_inner(&app, &request, &archive_path, &staging_dir, &token).await;
    let _ = fs::remove_file(&archive_path);
    if result.is_err() {
        // Fail closed: never leave a half-extracted package behind.
        let _ = fs::remove_dir_all(&staging_dir);
    }
    result
}

async fn stage_install_inner(
    app: &AppHandle,
    request: &InstallRequest,
    archive_path: &Path,
    staging_dir: &Path,
    token: &str,
) -> Result<InstallResult, String> {
    let mut digest: Option<String> = None;

    match resolve_source(request).await? {
        InstallSource::Archive(bytes) => {
            if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
                return Err("E_TOO_LARGE: package is larger than 20 MB".into());
            }
            let value = sha256_hex(&bytes);
            if let Some(expected) = request.expected_sha256.as_deref() {
                if !expected.eq_ignore_ascii_case(&value) {
                    return Err(format!(
                        "E_SHA256_MISMATCH: expected {expected}, got {value}"
                    ));
                }
            }

            fs::write(archive_path, &bytes).map_err(|error| format!("E_IO: {error}"))?;

            let archive = archive_path.to_path_buf();
            let target = staging_dir.to_path_buf();
            tauri::async_runtime::spawn_blocking(move || extract_archive(&archive, &target))
                .await
                .map_err(|error| format!("E_INTERNAL: {error}"))??;
            digest = Some(value);
        }
        InstallSource::Directory(directory) => {
            // A folder cannot be hashed meaningfully (it has no bytes of its
            // own and its content can change between two reads), so a pinned
            // digest is refused instead of quietly ignored.
            if request.expected_sha256.is_some() {
                return Err(
                    "E_SHA256_MISMATCH: a directory has no sha256 to verify against".into(),
                );
            }
            let target = staging_dir.to_path_buf();
            tauri::async_runtime::spawn_blocking(move || {
                copy_package_directory(&directory, &target)
            })
            .await
            .map_err(|error| format!("E_INTERNAL: {error}"))??;
        }
    }

    let manifest = check_staged_package(staging_dir)?;

    let _ = app;
    Ok(InstallResult {
        dry_run: true,
        staging_id: Some(token.to_string()),
        manifest,
        sha256: digest,
        record: None,
    })
}

/// What the install source turned out to be. The distinction only exists
/// between "resolve" and "stage": everything after staging works on a directory.
enum InstallSource {
    Archive(Vec<u8>),
    Directory(PathBuf),
}

/// `.qnp`, `.zip` and a folder are all accepted entry points. The first two are
/// the same thing by construction (a `.qnp` *is* a zip; the extension exists so
/// a double-click opens this app instead of the archive tool), so the only
/// branch here is file-or-directory.
async fn resolve_source(request: &InstallRequest) -> Result<InstallSource, String> {
    if let Some(url) = request.archive_url.as_deref() {
        return Ok(InstallSource::Archive(download_archive(url).await?));
    }
    if let Some(path) = request.archive_path.as_deref() {
        let source = PathBuf::from(path);
        let meta = fs::metadata(&source).map_err(|error| format!("E_IO: {error}"))?;
        if meta.is_dir() {
            return Ok(InstallSource::Directory(source));
        }
        if !meta.is_file() {
            return Err("E_NOT_A_PACKAGE: the selected path is neither a file nor a directory".into());
        }
        if meta.len() > MAX_ARCHIVE_BYTES {
            return Err("E_TOO_LARGE: package is larger than 20 MB".into());
        }
        let bytes = fs::read(&source).map_err(|error| format!("E_IO: {error}"))?;
        return Ok(InstallSource::Archive(bytes));
    }
    Err("E_INSTALL_SOURCE: no archive path or URL was given".into())
}

/// Phase 2: move the validated tree into `<plugins>/<id>/<version>/` and record
/// the grant. A same-volume rename is atomic, so a crash cannot leave a version
/// directory that is half old and half new.
fn commit_install(app: &AppHandle, request: InstallRequest) -> Result<InstallResult, String> {
    let root = plugins_root(app)?;
    let token = request
        .staging_id
        .as_deref()
        .ok_or("E_STAGING_MISSING: no staging id was given")?;
    let staging_dir = root.join(STAGING_DIR).join(token);
    if !staging_dir.is_dir() {
        return Err("E_STAGING_MISSING: the staged package is gone".into());
    }

    // Re-read rather than trusting a manifest smuggled through the frontend:
    // phase 2 writes into the real plugin directory, so its input gets the same
    // check phase 1 did.
    let manifest = check_staged_package(&staging_dir)?;

    let granted_source = request
        .granted_permissions
        .clone()
        .unwrap_or_else(|| manifest.permissions.clone());
    for permission in &granted_source {
        if !is_grantable(permission, &manifest.permissions) {
            return Err(format!(
                "E_PERMISSION_NOT_DECLARED: `{permission}` is not declared by the plugin"
            ));
        }
    }
    let granted = expand_permissions(&granted_source);

    let mut document = read_installed(app)?;
    let target = root.join(&manifest.id).join(&manifest.version);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("E_IO: {error}"))?;
    }
    if target.exists() {
        // Reinstalling the same version: clear it first, otherwise the rename
        // would land *inside* the existing directory on Windows.
        fs::remove_dir_all(&target).map_err(|error| format!("E_IO: {error}"))?;
    }
    if let Err(error) = fs::rename(&staging_dir, &target) {
        // Cross-volume (a relocated data directory on another drive).
        copy_tree(&staging_dir, &target).map_err(|copy_error| {
            format!("E_IO: could not move the package ({error}; {copy_error})")
        })?;
        let _ = fs::remove_dir_all(&staging_dir);
    }

    let previous = document
        .plugins
        .get(&manifest.id)
        .map(|record| record.version.clone())
        .filter(|version| version != &manifest.version)
        .filter(|version| root.join(&manifest.id).join(version).is_dir());
    let now = now_iso();
    let installed_at = document
        .plugins
        .get(&manifest.id)
        .map(|record| record.installed_at.clone())
        .unwrap_or_else(|| now.clone());

    let record = InstalledRecord {
        version: manifest.version.clone(),
        previous_version: previous,
        enabled: true,
        granted_permissions: granted,
        installed_at,
        updated_at: now,
        source: request
            .source
            .clone()
            .unwrap_or_else(|| "file".to_string()),
    };
    document.plugins.insert(manifest.id.clone(), record.clone());
    write_installed(app, &document)?;
    prune_versions(&root, &manifest.id, &record);

    let plugin_id = manifest.id.clone();
    Ok(InstallResult {
        dry_run: false,
        staging_id: None,
        manifest: manifest.clone(),
        sha256: None,
        record: Some(to_dto(&plugin_id, &record, Some(manifest))),
    })
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let destination = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_discard_staging(app: AppHandle, staging_id: String) -> Result<(), String> {
    let root = plugins_root(&app)?;
    // The id comes from the frontend, so it is matched against the staging
    // directory listing instead of being joined blindly.
    if staging_id.is_empty() || !staging_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("E_INVALID_ARGUMENT: bad staging id".into());
    }
    let dir = root.join(STAGING_DIR).join(&staging_id);
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|error| format!("E_IO: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_uninstall(app: AppHandle, id: String, keep_storage: bool) -> Result<(), String> {
    if !plugin_manifest::is_valid_plugin_id(&id) {
        return Err("E_INVALID_ARGUMENT: bad plugin id".into());
    }
    let dir = plugin_dir(&app, &id)?;
    let storage = dir.join(STORAGE_FILE);
    let preserved = if keep_storage && storage.is_file() {
        fs::read(&storage).ok()
    } else {
        None
    };

    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|error| format!("E_IO: {error}"))?;
    }

    let mut document = read_installed(&app)?;
    document.plugins.remove(&id);
    write_installed(&app, &document)?;

    if let Some(bytes) = preserved {
        fs::create_dir_all(&dir).map_err(|error| format!("E_IO: {error}"))?;
        fs::write(dir.join(STORAGE_FILE), bytes).map_err(|error| format!("E_IO: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let mut document = read_installed(&app)?;
    let record = document
        .plugins
        .get_mut(&id)
        .ok_or("E_NOT_INSTALLED: unknown plugin")?;
    record.enabled = enabled;
    record.updated_at = now_iso();
    write_installed(&app, &document)
}

/// Shrink (or grow back) the grant without reinstalling.
///
/// Revoking a single permission is a first-class action in the UI: the point of
/// showing the list is that the user can take one away. Growing it is allowed
/// only for permissions the manifest declares, so this can never become a way
/// to hand a plugin something it did not ask for.
#[tauri::command]
pub fn plugin_set_permissions(
    app: AppHandle,
    id: String,
    permissions: Vec<String>,
) -> Result<InstalledPluginDto, String> {
    let mut document = read_installed(&app)?;
    let record = document
        .plugins
        .get(&id)
        .cloned()
        .ok_or("E_NOT_INSTALLED: unknown plugin")?;
    let manifest = read_record_manifest(&app, &id, &record.version);
    let declared = manifest
        .as_ref()
        .map(|value| value.permissions.clone())
        .unwrap_or_default();
    for permission in &permissions {
        if !plugin_manifest::KNOWN_PERMISSIONS.contains(&permission.as_str()) {
            return Err(format!("E_PERMISSION_UNKNOWN: `{permission}`"));
        }
        if !is_grantable(permission, &declared) {
            return Err(format!(
                "E_PERMISSION_NOT_DECLARED: `{permission}` is not declared by the plugin"
            ));
        }
    }
    let updated = InstalledRecord {
        granted_permissions: expand_permissions(&permissions),
        updated_at: now_iso(),
        ..record
    };
    document.plugins.insert(id.clone(), updated.clone());
    write_installed(&app, &document)?;
    Ok(to_dto(&id, &updated, manifest))
}

#[tauri::command]
pub fn plugin_rollback(app: AppHandle, id: String) -> Result<InstalledPluginDto, String> {
    let root = plugins_root(&app)?;
    let mut document = read_installed(&app)?;
    let record = document
        .plugins
        .get(&id)
        .cloned()
        .ok_or("E_NOT_INSTALLED: unknown plugin")?;
    let previous = record
        .previous_version
        .clone()
        .ok_or("E_NO_ROLLBACK: there is no earlier version to go back to")?;
    if !root.join(&id).join(&previous).is_dir() {
        return Err("E_NO_ROLLBACK: the previous version directory is gone".into());
    }

    let current_exists = root.join(&id).join(&record.version).is_dir();
    let rollback = InstalledRecord {
        version: previous,
        previous_version: if current_exists {
            Some(record.version.clone())
        } else {
            None
        },
        ..record
    };
    document.plugins.insert(id.clone(), rollback.clone());
    write_installed(&app, &document)?;
    let manifest = read_record_manifest(&app, &id, &rollback.version);
    Ok(to_dto(&id, &rollback, manifest))
}

#[tauri::command]
pub fn plugin_read_manifest(
    app: AppHandle,
    id: String,
    version: Option<String>,
) -> Result<PluginManifest, String> {
    let resolved = match version {
        Some(version) => version,
        None => read_installed(&app)?
            .plugins
            .get(&id)
            .map(|record| record.version.clone())
            .ok_or("E_NOT_INSTALLED: unknown plugin")?,
    };
    read_manifest_any(&installed_record_dir(&app, &id, &resolved)?)
}

// ---------------------------------------------------------------------------
// Commands: private storage
// ---------------------------------------------------------------------------

fn storage_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !plugin_manifest::is_valid_plugin_id(id) {
        return Err("E_INVALID_ARGUMENT: bad plugin id".into());
    }
    Ok(plugin_dir(app, id)?.join(STORAGE_FILE))
}

fn read_storage(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.is_file() {
        return Ok(serde_json::Map::new());
    }
    let raw = fs::read_to_string(path).map_err(|error| format!("E_IO: {error}"))?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => Ok(map),
        // A corrupt store is treated as empty rather than blocking the plugin
        // forever; the next write replaces it.
        _ => Ok(serde_json::Map::new()),
    }
}

fn write_storage(path: &Path, map: &serde_json::Map<String, Value>) -> Result<(), String> {
    let body = serde_json::to_string(map).map_err(|error| error.to_string())?;
    if body.len() > STORAGE_QUOTA_BYTES {
        return Err(format!(
            "E_QUOTA_EXCEEDED: plugin storage is limited to {} KB",
            STORAGE_QUOTA_BYTES / 1024
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("E_IO: {error}"))?;
    }
    fs::write(path, body).map_err(|error| format!("E_IO: {error}"))
}

#[tauri::command]
pub fn plugin_storage_get(app: AppHandle, id: String, key: String) -> Result<Option<Value>, String> {
    if !is_valid_storage_key(&key) {
        return Err("E_INVALID_ARGUMENT: bad storage key".into());
    }
    let path = storage_path(&app, &id)?;
    Ok(read_storage(&path)?.get(&key).cloned())
}

#[tauri::command]
pub fn plugin_storage_set(
    app: AppHandle,
    id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    if !is_valid_storage_key(&key) {
        return Err("E_INVALID_ARGUMENT: bad storage key".into());
    }
    let path = storage_path(&app, &id)?;
    let mut map = read_storage(&path)?;
    map.insert(key, value);
    write_storage(&path, &map)
}

#[tauri::command]
pub fn plugin_storage_delete(app: AppHandle, id: String, key: String) -> Result<(), String> {
    if !is_valid_storage_key(&key) {
        return Err("E_INVALID_ARGUMENT: bad storage key".into());
    }
    let path = storage_path(&app, &id)?;
    let mut map = read_storage(&path)?;
    map.remove(&key);
    write_storage(&path, &map)
}

#[tauri::command]
pub fn plugin_storage_keys(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let path = storage_path(&app, &id)?;
    let mut keys: Vec<String> = read_storage(&path)?.keys().cloned().collect();
    keys.sort();
    Ok(keys)
}

// ---------------------------------------------------------------------------
// Commands: error log
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn plugin_read_log(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    if !plugin_manifest::is_valid_plugin_id(&id) {
        return Err("E_INVALID_ARGUMENT: bad plugin id".into());
    }
    let path = plugin_dir(&app, &id)?.join(LOG_FILE);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|error| format!("E_IO: {error}"))?;
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.len().saturating_sub(LOG_LINES);
    Ok(lines[start..].iter().map(|line| line.to_string()).collect())
}

/// Errors from the worker cannot be written by the worker: it has no fs, and
/// that is the point of running it in a blob. The host appends on its behalf.
#[tauri::command]
pub fn plugin_append_log(
    app: AppHandle,
    id: String,
    level: String,
    message: String,
) -> Result<(), String> {
    if !plugin_manifest::is_valid_plugin_id(&id) {
        return Err("E_INVALID_ARGUMENT: bad plugin id".into());
    }
    let dir = plugin_dir(&app, &id)?;
    fs::create_dir_all(&dir).map_err(|error| format!("E_IO: {error}"))?;
    let path = dir.join(LOG_FILE);
    let existing = if path.is_file() {
        fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    };
    let mut lines: Vec<String> = existing.lines().map(|line| line.to_string()).collect();
    let trimmed: String = message.chars().take(500).collect();
    lines.push(format!("[{}] {} {}", now_iso(), level, trimmed));
    if lines.len() > LOG_LINES {
        lines.drain(0..lines.len() - LOG_LINES);
    }
    fs::write(&path, lines.join("\n")).map_err(|error| format!("E_IO: {error}"))
}

// ---------------------------------------------------------------------------
// Commands: index
// ---------------------------------------------------------------------------

fn de_author<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) => Some(name),
        Some(Value::Object(map)) => map
            .get("name")
            .and_then(|name| name.as_str())
            .map(|name| name.to_string()),
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, deserialize_with = "de_author")]
    pub author: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub api_version: Option<u32>,
    #[serde(default)]
    pub engines: Option<plugin_manifest::PluginEngines>,
    #[serde(default)]
    pub download: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDocument {
    #[serde(default)]
    pub schema: u32,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default, deserialize_with = "de_index_entries")]
    pub plugins: Vec<IndexEntry>,
}

/// Deserialize `plugins` one entry at a time.
///
/// A single malformed entry — `permissions` written as a string, `version` as a
/// number, an entry with no `id` — used to fail the whole document. Both mirrors
/// then "failed", the market fell back to "no plugins available", and every
/// author on the index disappeared because one of them had a typo. A network
/// failure is allowed to degrade the market; a format error must not take
/// everyone else down with it, so a bad entry is skipped and logged and the rest
/// still list.
fn de_index_entries<'de, D>(deserializer: D) -> Result<Vec<IndexEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<Value>::deserialize(deserializer)?;
    let mut entries = Vec::with_capacity(raw.len());
    for (index, value) in raw.into_iter().enumerate() {
        // Name the offender by id when it has one, by position otherwise: the
        // log line is what an author will be pointed at.
        let label = value
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("#{index}"));
        match serde_json::from_value::<IndexEntry>(value) {
            Ok(entry) => entries.push(entry),
            Err(error) => eprintln!("[plugin-index] skipping entry {label}: {error}"),
        }
    }
    Ok(entries)
}

/// Reject an index written for a newer client.
///
/// Called per source so the next mirror is still tried, and again on the cached
/// document so a cache written by a newer build is ignored instead of displayed
/// half-understood.
fn ensure_supported_index_schema(document: &IndexDocument) -> Result<(), String> {
    if document.schema > SUPPORTED_INDEX_SCHEMA {
        let message = format!(
            "E_INDEX_SCHEMA: index schema {} is newer than the supported {SUPPORTED_INDEX_SCHEMA}",
            document.schema
        );
        eprintln!("[plugin-index] {message}");
        return Err(message);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFetchResult {
    /// `ok` (fresh), `cached` (network failed, cache used) or `missing`.
    pub status: String,
    pub plugins: Vec<IndexEntry>,
    pub source: String,
    pub fetched_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexCache {
    fetched_at: String,
    fetched_at_epoch: u64,
    source: String,
    document: IndexDocument,
}

fn read_index_cache(path: &Path) -> Option<IndexCache> {
    let raw = fs::read_to_string(path).ok()?;
    let cache: IndexCache = serde_json::from_str(&raw).ok()?;
    // A cache written by a newer build is ignored rather than half-understood:
    // the fetch below will either bring a schema this build can read or fail
    // into the documented "missing" state.
    if ensure_supported_index_schema(&cache.document).is_err() {
        return None;
    }
    Some(cache)
}

async fn fetch_index_document() -> Result<(IndexDocument, String), String> {
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let mut last_error = String::from("no source tried");
    for (source, url) in INDEX_URLS {
        match client
            .get(url)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                // `json()` is not compiled into the reqwest build that
                // tauri-plugin-http re-exports, so parse the body by hand.
                match response.text().await {
                    Ok(body) => match serde_json::from_str::<IndexDocument>(&body) {
                        // Entry-level failures are already skipped and logged by
                        // `de_index_entries`; what is left is "is this document
                        // for a build like this one", which is checked per source
                        // so the next mirror is still tried.
                        Ok(document) => match ensure_supported_index_schema(&document) {
                            Ok(()) => return Ok((document, source.to_string())),
                            Err(error) => last_error = format!("{source}: {error}"),
                        },
                        Err(error) => last_error = format!("{source}: {error}"),
                    },
                    Err(error) => last_error = format!("{source}: {error}"),
                }
            }
            Ok(response) => last_error = format!("{source}: HTTP {}", response.status()),
            Err(error) => last_error = format!("{source}: {error}"),
        }
    }
    Err(last_error)
}

/// Index fetch, cached for 24h.
///
/// A missing index repository is an expected state, not an error: the plugin
/// page simply shows "no plugins available" and local installs keep working.
#[tauri::command]
pub async fn plugin_fetch_index(app: AppHandle, force: bool) -> Result<IndexFetchResult, String> {
    let root = plugins_root(&app)?;
    let cache_path = root.join(INDEX_CACHE_FILE);
    let cached = read_index_cache(&cache_path);

    if !force {
        if let Some(cache) = &cached {
            let age = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0)
                .saturating_sub(cache.fetched_at_epoch);
            if age < INDEX_TTL_SECS {
                return Ok(IndexFetchResult {
                    status: "ok".into(),
                    plugins: cache.document.plugins.clone(),
                    source: "cache".into(),
                    fetched_at: Some(cache.fetched_at.clone()),
                    updated_at: cache.document.updated_at.clone(),
                });
            }
        }
    }

    match fetch_index_document().await {
        Ok((document, source)) => {
            let fetched_at = now_iso();
            let epoch = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            let cache = IndexCache {
                fetched_at: fetched_at.clone(),
                fetched_at_epoch: epoch,
                source: source.clone(),
                document: document.clone(),
            };
            if let Ok(body) = serde_json::to_string(&cache) {
                let _ = fs::write(&cache_path, body);
            }
            Ok(IndexFetchResult {
                status: "ok".into(),
                plugins: document.plugins,
                source,
                fetched_at: Some(fetched_at),
                updated_at: document.updated_at,
            })
        }
        Err(_) => Ok(match cached {
            Some(cache) => IndexFetchResult {
                status: "cached".into(),
                plugins: cache.document.plugins,
                source: "cache".into(),
                fetched_at: Some(cache.fetched_at),
                updated_at: cache.document.updated_at,
            },
            None => IndexFetchResult {
                status: "missing".into(),
                plugins: Vec::new(),
                source: "none".into(),
                fetched_at: None,
                updated_at: None,
            },
        }),
    }
}

/// Called from `setup`: a crash during install must not leave a staging tree
/// that the next install would silently adopt.
pub fn clean_staging_on_startup(app: &AppHandle) {
    let Ok(root) = plugins_root(app) else {
        return;
    };
    let staging = root.join(STAGING_DIR);
    if staging.is_dir() {
        let _ = fs::remove_dir_all(staging);
    }
}

#[cfg(test)]
mod tests {
    //! The rejection paths are the ones with no UI to observe: an install that
    //! is refused looks exactly like one that failed for an unrelated reason.
    //! These tests build real archives and assert the code that comes back.

    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    fn build_zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut buffer);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for (name, body) in entries {
                writer.start_file(*name, options).expect("start entry");
                writer.write_all(body).expect("write entry");
            }
            writer.finish().expect("finish archive");
        }
        buffer.into_inner()
    }

    /// Extract into a fresh directory; returns the error string on refusal.
    fn extract(entries: &[(&str, Vec<u8>)]) -> Result<PathBuf, String> {
        let dir = std::env::temp_dir().join(format!("qing-plugin-test-{}", unique_token()));
        fs::create_dir_all(&dir).expect("scratch directory");
        let archive = dir.join("package.qnp");
        fs::write(&archive, build_zip(entries)).expect("write archive");
        let target = dir.join("out");
        extract_archive(&archive, &target).map(|()| target)
    }

    fn manifest_bytes(version: &str) -> Vec<u8> {
        format!(
            r#"{{"id":"qing.example","name":"Example","version":"{version}","apiVersion":1,
               "engines":{{"host":">=0.7.3 <1.0.0"}},"main":"main.js"}}"#
        )
        .into_bytes()
    }

    #[test]
    fn accepts_a_well_formed_package() {
        let target = extract(&[
            ("plugin.json", manifest_bytes("1.0.0")),
            ("main.js", b"qing.log('hi');".to_vec()),
        ])
        .expect("a normal package must extract");
        assert!(target.join("plugin.json").is_file());
        assert!(target.join("main.js").is_file());
    }

    #[test]
    fn rejects_traversal_entries() {
        let error = extract(&[
            ("plugin.json", manifest_bytes("1.0.0")),
            ("../../evil.js", b"x".to_vec()),
        ])
        .expect_err("zip slip must be refused");
        assert!(error.starts_with("E_ZIP_SLIP"), "{error}");
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        for name in ["/etc/passwd", "C:/windows/system32/x.js"] {
            let error = extract(&[("plugin.json", manifest_bytes("1.0.0")), (name, b"x".to_vec())])
                .expect_err("absolute paths must be refused");
            assert!(error.starts_with("E_ZIP_SLIP"), "{name}: {error}");
        }
    }

    #[test]
    fn rejects_native_modules() {
        for name in ["main.dll", "addon.NODE", "run.exe", "lib.so", "lib.dylib", "mod.wasm"] {
            let error = extract(&[("plugin.json", manifest_bytes("1.0.0")), (name, b"x".to_vec())])
                .expect_err("native modules must be refused");
            assert!(error.starts_with("E_NATIVE_MODULE"), "{name}: {error}");
        }
    }

    #[test]
    fn rejects_a_single_file_over_five_megabytes() {
        let big = vec![0_u8; (MAX_SINGLE_FILE + 1024) as usize];
        let error = extract(&[("plugin.json", manifest_bytes("1.0.0")), ("big.js", big)])
            .expect_err("a 6 MB entry must be refused");
        assert!(error.starts_with("E_TOO_LARGE"), "{error}");
    }

    #[test]
    fn rejects_a_package_over_twenty_megabytes() {
        // Five entries of exactly 5 MB: each is at the per-file limit, so only
        // the total can reject this package.
        let part = vec![0_u8; MAX_SINGLE_FILE as usize];
        let mut entries: Vec<(&str, Vec<u8>)> = vec![("plugin.json", manifest_bytes("1.0.0"))];
        for name in ["a.js", "b.js", "c.js", "d.js", "e.js"] {
            entries.push((name, part.clone()));
        }
        let error = extract(&entries).expect_err("a 25 MB package must be refused");
        assert!(error.starts_with("E_TOO_LARGE"), "{error}");
    }

    #[test]
    fn timestamp_is_iso8601() {
        // 1793070000 = 2026-10-27T03:00:00Z, checked with `date -u -d`.
        assert_eq!(iso_from_unix(1_793_070_000), "2026-10-27T03:00:00Z");
    }

    // -----------------------------------------------------------------------
    // Directory installs and the dual manifest format
    // -----------------------------------------------------------------------

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qing-plugin-dir-test-{}", unique_token()));
        fs::create_dir_all(&dir).expect("scratch directory");
        dir
    }

    fn write_file(path: &Path, body: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent directory");
        }
        fs::write(path, body).expect("write file");
    }

    const PACKAGE_JSON: &str = r#"{
      "name": "wordcount",
      "publisher": "qing",
      "displayName": "字数统计",
      "version": "1.1.0",
      "engines": { "qing": ">=0.7.3 <1.0.0" },
      "main": "./dist/extension.js",
      "activationEvents": ["onCommand:qing.wordcount.run"],
      "permissions": ["notes:read", "notify"],
      "contributes": { "commands": [{ "command": "qing.wordcount.run", "title": "Count" }] },
      "scripts": { "build": "node build.mjs" },
      "devDependencies": { "esbuild": "^0.25.0" }
    }"#;

    #[test]
    fn a_directory_is_copied_without_its_build_folders() {
        let source = scratch_dir().join("package");
        write_file(&source.join("package.json"), PACKAGE_JSON.as_bytes());
        write_file(&source.join("dist/extension.js"), b"qing.log('hi');");
        write_file(&source.join("node_modules/esbuild/main.js"), b"// vendored");
        write_file(&source.join(".git/config"), b"[core]");

        let target = scratch_dir().join("out");
        copy_package_directory(&source, &target).expect("a normal folder copies");

        assert!(target.join("dist/extension.js").is_file());
        assert!(target.join("package.json").is_file());
        assert!(!target.join("node_modules").exists());
        assert!(!target.join(".git").exists());

        let manifest = check_staged_package(&target).expect("the staged folder is installable");
        assert_eq!(manifest.id, "qing.wordcount");
        assert_eq!(manifest.main, "dist/extension.js");
    }

    #[test]
    fn a_directory_obeys_the_archive_size_limits() {
        let source = scratch_dir().join("package");
        write_file(&source.join("package.json"), PACKAGE_JSON.as_bytes());
        write_file(&source.join("dist/extension.js"), b"qing.log('hi');");
        write_file(
            &source.join("big.bin"),
            &vec![0_u8; (MAX_SINGLE_FILE + 1024) as usize],
        );
        let error = copy_package_directory(&source, &scratch_dir().join("out"))
            .expect_err("a 6 MB file must be refused");
        assert!(error.starts_with("E_TOO_LARGE"), "{error}");

        let heavy = scratch_dir().join("package");
        write_file(&heavy.join("package.json"), PACKAGE_JSON.as_bytes());
        write_file(&heavy.join("dist/extension.js"), b"qing.log('hi');");
        for name in ["a.bin", "b.bin", "c.bin", "d.bin", "e.bin"] {
            write_file(&heavy.join(name), &vec![0_u8; MAX_SINGLE_FILE as usize]);
        }
        let error = copy_package_directory(&heavy, &scratch_dir().join("out"))
            .expect_err("25 MB must be refused");
        assert!(error.starts_with("E_TOO_LARGE"), "{error}");
    }

    #[test]
    fn a_symlink_inside_a_directory_is_skipped_not_followed() {
        let source = scratch_dir().join("package");
        write_file(&source.join("package.json"), PACKAGE_JSON.as_bytes());
        write_file(&source.join("dist/extension.js"), b"qing.log('hi');");

        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink("/etc", source.join("escape")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir("C:\\Windows", source.join("escape")).is_ok();

        let target = scratch_dir().join("out");
        copy_package_directory(&source, &target).expect("a link does not break the copy");
        assert!(!target.join("escape").exists());
        // Loud on capable environments, silent where creating a link needs
        // privileges this test does not have.
        let _ = linked;
    }

    #[test]
    fn a_package_json_with_main_wins_over_plugin_json() {
        let dir = scratch_dir();
        write_file(&dir.join("package.json"), PACKAGE_JSON.as_bytes());
        write_file(&dir.join("plugin.json"), &manifest_bytes("9.9.9"));
        write_file(&dir.join("dist/extension.js"), b"qing.log('hi');");
        write_file(&dir.join("main.js"), b"qing.log('legacy');");

        let manifest = read_manifest_any(&dir).expect("package.json is authoritative");
        assert_eq!(manifest.id, "qing.wordcount");
        assert_eq!(manifest.version, "1.1.0");
        assert_eq!(manifest.name, "字数统计");
        assert_eq!(manifest.contributes.commands[0].id, "qing.wordcount.run");
        // `devDependencies` here are build bookkeeping, not a plugin dependency.
        assert!(manifest.dependencies.is_none());
    }

    #[test]
    fn a_build_only_package_json_falls_back_to_plugin_json() {
        // This is exactly what `examples/qing-note-wordcount/` ships: a
        // package.json that drives esbuild and a plugin.json that describes
        // the plugin.
        let dir = scratch_dir();
        write_file(
            &dir.join("package.json"),
            br#"{"name":"qing-note-wordcount","private":true,
                 "scripts":{"build":"esbuild src/main.js --outfile=main.js"},
                 "devDependencies":{"esbuild":"^0.25.0"}}"#,
        );
        write_file(&dir.join("plugin.json"), &manifest_bytes("1.0.0"));
        write_file(&dir.join("main.js"), b"qing.log('hi');");

        let manifest = read_manifest_any(&dir).expect("the legacy manifest is used");
        assert_eq!(manifest.id, "qing.example");
        assert_eq!(manifest.version, "1.0.0");
        assert!(check_staged_package(&dir).is_ok());
    }

    #[test]
    fn a_directory_with_no_manifest_is_refused() {
        let dir = scratch_dir();
        write_file(&dir.join("main.js"), b"qing.log('hi');");
        let error = read_manifest_any(&dir).expect_err("nothing describes this package");
        assert!(error.starts_with("E_MANIFEST_MISSING"), "{error}");
    }

    #[test]
    fn a_manifest_pointing_at_a_missing_main_is_refused() {
        let dir = scratch_dir();
        write_file(&dir.join("package.json"), PACKAGE_JSON.as_bytes());
        let error = check_staged_package(&dir).expect_err("dist/extension.js is not there");
        assert!(error.starts_with("E_MISSING_MAIN"), "{error}");
    }

    // -----------------------------------------------------------------------
    // QA: the real packages in `examples/`, through the real install path
    //
    // The point of these is that they read the committed files, not a copy of
    // them in a fixture: a manifest that drifts from the host's reader fails
    // here rather than in the app.
    // -----------------------------------------------------------------------

    fn examples_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("examples")
    }

    /// The whole folder→staging→manifest path, as `stage_install_inner` runs it.
    fn stage_folder(folder: &str) -> Result<(PathBuf, PluginManifest), String> {
        let source = examples_root().join(folder);
        assert!(source.is_dir(), "{} must be checked in", source.display());
        let staged = scratch_dir().join("staged");
        copy_package_directory(&source, &staged)?;
        let manifest = check_staged_package(&staged)?;
        Ok((staged, manifest))
    }

    #[test]
    fn a_folder_with_a_build_only_package_json_falls_back_to_plugin_json() {
        // The three original examples ship a `package.json` that drives esbuild
        // and a `plugin.json` that describes the plugin. Installing the folder
        // must use the second one — this is the direction the `main`
        // discriminator exists for.
        for (folder, id) in [
            ("qing-hello-headless", "qing.hello-headless"),
            ("qing-note-wordcount", "qing.note-wordcount"),
            ("qing-isolation-probe", "qing.isolation-probe"),
        ] {
            let (staged, manifest) =
                stage_folder(folder).unwrap_or_else(|error| panic!("{folder}: {error}"));
            assert_eq!(manifest.id, id, "{folder}");
            assert_eq!(manifest.main, "main.js", "{folder}");
            assert_eq!(manifest.api_version, 1, "{folder}");
            assert!(
                !manifest.contributes.commands.is_empty(),
                "{folder} must keep its contributed command"
            );
            assert!(
                manifest.dependencies.is_none(),
                "{folder}: devDependencies must not reach the manifest"
            );
            assert!(staged.join("main.js").is_file(), "{folder}");
            // The build file is package content and is still copied; it simply
            // is not the manifest.
            assert!(staged.join("package.json").is_file(), "{folder}");
        }
    }

    #[test]
    fn a_folder_using_package_json_as_its_manifest_installs_with_a_composed_id() {
        let (staged, manifest) = stage_folder("qing-wordcount-ts").expect("the TS example installs");
        assert_eq!(manifest.id, "qing.wordcount-ts");
        assert_eq!(manifest.name, "笔记字数统计（TypeScript）");
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(manifest.main, "dist/extension.js");
        assert_eq!(manifest.engines.host, ">=0.7.3 <1.0.0");
        assert_eq!(manifest.contributes.commands[0].id, "qing.wordcount-ts.run");
        assert!(manifest.dependencies.is_none());
        assert!(staged.join("dist/extension.js").is_file());
        assert!(
            !staged.join("plugin.json").exists(),
            "a package.json package must not need a plugin.json"
        );
        // `src/`, `build.mjs` and `tsconfig.json` are not skipped by the folder
        // copier (only build output directories are), so the entry has to be
        // found next to them rather than assuming a clean tree.
        assert!(staged.join("src/extension.ts").is_file());
    }

    #[test]
    fn every_shipped_archive_extracts_and_reads_its_manifest() {
        // Regression for the archive path: a `.qnp` holds the manifest at its
        // root, so the same `check_staged_package` that serves folders has to
        // find it there — for both formats.
        for (file, id) in [
            ("qing.hello-headless-1.0.0.qnp", "qing.hello-headless"),
            ("qing.isolation-probe-1.0.0.qnp", "qing.isolation-probe"),
            ("qing.note-wordcount-1.0.0.qnp", "qing.note-wordcount"),
            ("qing.wordcount-ts-1.0.0.qnp", "qing.wordcount-ts"),
        ] {
            let archive = examples_root().join(file);
            assert!(archive.is_file(), "{} must be committed", archive.display());
            let staged = scratch_dir().join("extracted");
            extract_archive(&archive, &staged).unwrap_or_else(|error| panic!("{file}: {error}"));
            let manifest =
                check_staged_package(&staged).unwrap_or_else(|error| panic!("{file}: {error}"));
            assert_eq!(manifest.id, id, "{file}");
            let entry = safe_entry_path(&manifest.main).expect("the entry is a safe path");
            assert!(
                staged.join(entry).is_file(),
                "{file}: `{}` did not land on disk",
                manifest.main
            );
        }
    }

    #[test]
    fn an_archive_that_wraps_everything_in_one_folder_is_unwrapped() {
        // The shape `Explorer → Send to → Compressed folder` and GitHub's
        // "Download ZIP" produce. P0 close-out: it used to report "manifest not
        // at the root", which is indistinguishable from "this is not a package"
        // and is the single most likely way a user creates a zip by hand.
        let target = extract(&[
            ("pkg/package.json", PACKAGE_JSON.as_bytes().to_vec()),
            ("pkg/dist/extension.js", b"qing.log('hi');".to_vec()),
        ])
        .expect("the archive is well formed");
        assert!(
            !target.join("pkg").exists(),
            "the wrapper folder must be gone, not merely bypassed"
        );
        let manifest = check_staged_package(&target).expect("the unwrapped package installs");
        assert_eq!(manifest.id, "qing.wordcount");
        assert_eq!(manifest.main, "dist/extension.js");
    }

    #[test]
    fn a_wrapper_folder_is_only_unwrapped_when_it_is_the_only_entry() {
        // Two shapes that must keep failing rather than be guessed at: extra
        // junk next to the folder, and a folder record ("__MACOSX", a top-level
        // README) that makes "which folder is the package?" ambiguous.
        let target = extract(&[
            ("pkg/package.json", PACKAGE_JSON.as_bytes().to_vec()),
            ("pkg/dist/extension.js", b"qing.log('hi');".to_vec()),
            ("README.md", b"downloaded from somewhere".to_vec()),
        ])
        .expect("the archive is well formed");
        let error = check_staged_package(&target).expect_err("two entries is not one folder");
        assert!(error.starts_with("E_MANIFEST_MISSING"), "{error}");
        assert!(target.join("pkg/package.json").is_file(), "nothing was moved");

        // One folder, but no manifest inside it: nothing to unwrap to.
        let target = extract(&[
            ("pkg/main.js", b"qing.log('hi');".to_vec()),
            ("pkg/README.md", b"no manifest here".to_vec()),
        ])
        .expect("the archive is well formed");
        let error = check_staged_package(&target).expect_err("no manifest anywhere");
        assert!(error.starts_with("E_MANIFEST_MISSING"), "{error}");

        // Two folders: also ambiguous.
        let target = extract(&[
            ("a/package.json", PACKAGE_JSON.as_bytes().to_vec()),
            ("a/dist/extension.js", b"qing.log('hi');".to_vec()),
            ("b/other.js", b"qing.log('hi');".to_vec()),
        ])
        .expect("the archive is well formed");
        let error = check_staged_package(&target).expect_err("two folders is ambiguous");
        assert!(error.starts_with("E_MANIFEST_MISSING"), "{error}");
    }

    #[test]
    fn a_wrapped_legacy_package_is_unwrapped_too() {
        // The unwrapping is about the archive's layout, not its manifest
        // format: a `.qnp` rebuilt from a folder by a tool that keeps the
        // folder must install whatever manifest it ships.
        let target = extract(&[
            ("qing.example-1.0.0/plugin.json", manifest_bytes("1.0.0")),
            ("qing.example-1.0.0/main.js", b"qing.log('hi');".to_vec()),
        ])
        .expect("the archive is well formed");
        let manifest = check_staged_package(&target).expect("the unwrapped package installs");
        assert_eq!(manifest.id, "qing.example");
    }

    // -----------------------------------------------------------------------
    // QA: the two directions of the "manifest format is decided by `main`" rule
    // -----------------------------------------------------------------------

    #[test]
    fn a_package_json_without_main_and_without_plugin_json_is_refused() {
        let dir = scratch_dir();
        write_file(&dir.join("package.json"), br#"{"name":"qing.x","version":"1.0.0"}"#);
        write_file(&dir.join("main.js"), b"qing.log('hi');");
        let error = read_manifest_any(&dir).expect_err("nothing describes the entry point");
        assert!(error.starts_with("E_MANIFEST_MISSING"), "{error}");
        assert!(check_staged_package(&dir).is_err(), "must not install silently");
    }

    #[test]
    fn a_build_package_json_that_also_declares_main_shadows_plugin_json() {
        // The cost of the discriminator, pinned deliberately: `examples/`'s
        // build-only package.json plus the one npm field an author would
        // naturally add (`main`, since the build output *is* main.js) turns the
        // build file into the manifest and the install fails — even though the
        // plugin.json next to it is complete.
        let dir = scratch_dir();
        write_file(
            &dir.join("package.json"),
            br#"{"name":"qing-note-wordcount","version":"1.0.0","private":true,
                 "main":"main.js",
                 "scripts":{"build":"esbuild src/main.js --outfile=main.js"},
                 "devDependencies":{"esbuild":"^0.25.0"}}"#,
        );
        write_file(&dir.join("plugin.json"), &manifest_bytes("1.0.0"));
        write_file(&dir.join("main.js"), b"qing.log('hi');");

        let error = check_staged_package(&dir).expect_err("the build file wins and is invalid");
        assert!(error.starts_with("E_MANIFEST_INVALID"), "{error}");
        assert!(
            error.contains("engines"),
            "the author is told about engines: {error}"
        );
        // …and about *why* the complete plugin.json next to it was ignored.
        // Before the P0 close-out the report stopped at "engines is missing",
        // which reads as a bug in the host to anyone who can see their own
        // plugin.json.
        assert!(
            error.contains(
                "note: plugin.json also exists but package.json (which declares \"main\") takes precedence"
            ),
            "the shadowing must be stated: {error}"
        );
    }

    #[test]
    fn a_malformed_package_json_fails_the_install_even_with_a_valid_plugin_json() {
        // A `package.json` with a trailing comma (or any comment) is read
        // before the fallback is even considered, so the parse error hides a
        // plugin.json that would have installed. That is deliberate — see
        // `with_shadow_note` — but the author has to be told which file they
        // are actually editing.
        let dir = scratch_dir();
        write_file(
            &dir.join("package.json"),
            br#"{"name":"qing-note-wordcount","private":true,}"#,
        );
        write_file(&dir.join("plugin.json"), &manifest_bytes("1.0.0"));
        write_file(&dir.join("main.js"), b"qing.log('hi');");
        let error = check_staged_package(&dir).expect_err("the malformed file is fatal");
        assert!(error.starts_with("E_MANIFEST_INVALID"), "{error}");
        assert!(
            error.contains(
                "note: plugin.json also exists but package.json (which declares \"main\") takes precedence"
            ),
            "an unparseable package.json still shadows the plugin.json: {error}"
        );
    }

    #[test]
    fn a_broken_plugin_json_says_why_the_neighbouring_package_json_was_ignored() {
        // The symmetric direction: the package.json is a build file (no
        // `main`), so plugin.json is the manifest — and it does not parse.
        let dir = scratch_dir();
        write_file(
            &dir.join("package.json"),
            br#"{"name":"qing-note-wordcount","private":true,
                 "scripts":{"build":"esbuild src/main.js --outfile=main.js"}}"#,
        );
        write_file(&dir.join("plugin.json"), br#"{"id":"qing.example",}"#);
        write_file(&dir.join("main.js"), b"qing.log('hi');");
        let error = check_staged_package(&dir).expect_err("the manifest does not parse");
        assert!(error.starts_with("E_MANIFEST_INVALID"), "{error}");
        assert!(
            error.contains(
                "note: package.json also exists but it has no \"main\" entry, so plugin.json takes precedence"
            ),
            "the note must be symmetric: {error}"
        );

        // …and no note at all when there is nothing to be shadowed.
        let dir = scratch_dir();
        write_file(&dir.join("plugin.json"), br#"{"id":"qing.example",}"#);
        let error = check_staged_package(&dir).expect_err("the manifest does not parse");
        assert!(!error.contains("note:"), "nothing to explain: {error}");

        // A lone `package.json` with no `main` is not shadowing anything: there
        // is no plugin.json, so a note about one would send the author looking
        // for a file that does not exist.
        let dir = scratch_dir();
        write_file(&dir.join("package.json"), br#"{"name":"qing.x","version":"1.0.0"}"#);
        write_file(&dir.join("main.js"), b"qing.log('hi');");
        let error = check_staged_package(&dir).expect_err("no manifest describes the entry");
        assert!(error.starts_with("E_MANIFEST_MISSING"), "{error}");
        assert!(!error.contains("note:"), "no plugin.json to mention: {error}");
    }

    // -----------------------------------------------------------------------
    // QA: the folder copier's limits and its link handling
    // -----------------------------------------------------------------------

    fn package_with_entry() -> PathBuf {
        let source = scratch_dir().join("package");
        write_file(&source.join("package.json"), PACKAGE_JSON.as_bytes());
        write_file(&source.join("dist/extension.js"), b"qing.log('hi');");
        source
    }

    #[test]
    fn a_folder_is_limited_to_two_thousand_files() {
        let source = package_with_entry();
        // 1998 filler files + manifest + entry = exactly the limit.
        for index in 0..(MAX_ENTRIES - 2) {
            write_file(&source.join(format!("filler/{index}.js")), b"");
        }
        let staged = scratch_dir().join("out");
        copy_package_directory(&source, &staged).expect("exactly 2000 files is allowed");
        assert!(check_staged_package(&staged).is_ok(), "the limit is inclusive");

        write_file(&source.join("filler/one-too-many.js"), b"");
        let error = copy_package_directory(&source, &scratch_dir().join("out2"))
            .expect_err("2001 files must be refused");
        assert!(error.starts_with("E_TOO_MANY_FILES"), "{error}");
    }

    #[test]
    fn a_folder_file_of_five_point_one_megabytes_is_refused() {
        let source = package_with_entry();
        write_file(&source.join("big.bin"), &vec![0_u8; MAX_SINGLE_FILE as usize + 102_400]);
        let error = copy_package_directory(&source, &scratch_dir().join("out"))
            .expect_err("5.1 MB must be refused");
        assert!(error.starts_with("E_TOO_LARGE"), "{error}");
    }

    #[test]
    fn a_folder_file_of_exactly_five_megabytes_is_allowed() {
        // The boundary in the other direction, so the limit is not quietly
        // off by one file-system block.
        let source = package_with_entry();
        write_file(&source.join("edge.bin"), &vec![0_u8; MAX_SINGLE_FILE as usize]);
        let staged = scratch_dir().join("out");
        copy_package_directory(&source, &staged).expect("exactly 5 MB is allowed");
        assert_eq!(
            fs::metadata(staged.join("edge.bin")).expect("copied").len(),
            MAX_SINGLE_FILE
        );
    }

    /// A directory link the package must not be able to pull content through.
    /// A junction needs no privilege on Windows, unlike a symlink, so the test
    /// is not vacuous on a default developer account.
    fn link_directory(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(target, link).is_ok() {
                return true;
            }
            return std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J", &link.to_string_lossy(), &target.to_string_lossy()])
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false);
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    fn link_file(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    /// Does any file under `root` contain `needle`?
    fn tree_contains(root: &Path, needle: &[u8]) -> bool {
        let Ok(entries) = fs::read_dir(root) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if tree_contains(&path, needle) {
                    return true;
                }
                continue;
            }
            if let Ok(body) = fs::read(&path) {
                if body.windows(needle.len()).any(|window| window == needle) {
                    return true;
                }
            }
        }
        false
    }

    #[test]
    fn content_behind_a_link_inside_a_folder_never_reaches_staging() {
        // A package folder is user-controlled input: a link to `C:\Users` would
        // otherwise copy the profile into the plugin directory, and a link to a
        // file would smuggle in content that no size or name check ever saw.
        let source = package_with_entry();
        let outside = scratch_dir().join("outside");
        write_file(&outside.join("secret.txt"), b"TOP-SECRET-PAYLOAD");
        write_file(&outside.join("nested/deeper.txt"), b"TOP-SECRET-PAYLOAD");

        let linked_dir = link_directory(&outside, &source.join("escape"));
        let linked_file = link_file(&outside.join("secret.txt"), &source.join("secret.txt"));
        assert!(
            linked_dir || linked_file,
            "no link could be created, so this test would prove nothing"
        );

        let staged = scratch_dir().join("out");
        copy_package_directory(&source, &staged).expect("a link does not break the copy");
        assert!(check_staged_package(&staged).is_ok(), "the package still installs");
        assert!(!staged.join("escape").exists(), "a linked directory was copied");
        assert!(!staged.join("secret.txt").exists(), "a linked file was copied");
        assert!(
            !tree_contains(&staged, b"TOP-SECRET-PAYLOAD"),
            "content behind a link reached staging under another name"
        );
    }

    // -----------------------------------------------------------------------
    // QA: post-staging checks that only exist once a package is on disk
    // -----------------------------------------------------------------------

    #[test]
    fn a_main_pointing_at_a_native_module_is_refused() {
        // New format: `main` lands on a `.node` file.
        let dir = scratch_dir();
        write_file(
            &dir.join("package.json"),
            PACKAGE_JSON.replace("dist/extension.js", "dist/addon.node").as_bytes(),
        );
        write_file(&dir.join("dist/addon.node"), b"not really a native module");
        let error = check_staged_package(&dir).expect_err("a native entry is refused");
        assert!(error.starts_with("E_NATIVE_MODULE"), "{error}");

        // Old format: the same rule, from `plugin.json`.
        let dir = scratch_dir();
        let legacy = String::from_utf8(manifest_bytes("1.0.0"))
            .expect("utf8")
            .replace("main.js", "main.dll");
        write_file(&dir.join("plugin.json"), legacy.as_bytes());
        write_file(&dir.join("main.dll"), b"not really a native module");
        let error = check_staged_package(&dir).expect_err("a native entry is refused");
        assert!(error.starts_with("E_NATIVE_MODULE"), "{error}");
    }

    #[test]
    fn a_manifest_that_declares_an_unknown_permission_is_refused_at_stage_time() {
        // The whitelist has to hold for the new format too: `permissions`
        // becomes a grant, and a grant the host does not know is shown to the
        // user and then does nothing.
        let dir = scratch_dir();
        write_file(
            &dir.join("package.json"),
            PACKAGE_JSON
                .replace(r#""permissions": ["notes:read", "notify"]"#, r#""permissions": ["telnet"]"#)
                .as_bytes(),
        );
        write_file(&dir.join("dist/extension.js"), b"qing.log('hi');");
        let error = check_staged_package(&dir).expect_err("`telnet` is not a host permission");
        assert!(error.starts_with("E_PERMISSION_UNKNOWN"), "{error}");
    }

    #[test]
    fn a_windows_style_or_dot_segment_main_resolves_to_the_staged_file() {
        // The manifest may spell the entry with backslashes or an inner `.`;
        // the staged file check has to resolve all of them to the one file the
        // package actually contains, and the *stored* form has to be the one the
        // runtime can walk. P0 close-out: `dist/./extension.js` used to be
        // stored verbatim, which installed and then failed to start because
        // `headless.ts::readMainSource` refuses `.` segments.
        for (main, stored) in [
            ("dist\\\\extension.js", "dist/extension.js"),
            ("dist/./extension.js", "dist/extension.js"),
            ("./dist/extension.js", "dist/extension.js"),
            ("./dist/./extension.js", "dist/extension.js"),
        ] {
            let dir = scratch_dir();
            let document = PACKAGE_JSON
                .replace(r#""main": "./dist/extension.js""#, &format!(r#""main": "{main}""#));
            write_file(&dir.join("package.json"), document.as_bytes());
            write_file(&dir.join("dist/extension.js"), b"qing.log('hi');");
            let manifest = check_staged_package(&dir)
                .unwrap_or_else(|error| panic!("main `{main}`: {error}"));
            assert_eq!(manifest.main, stored, "main `{main}`");
            // The stored form is what the worker reads, so it is what gets
            // asserted against the runtime's own path walk.
            let walked = safe_entry_path(&manifest.main).expect("the runtime accepts it");
            assert_eq!(walked, PathBuf::from("dist").join("extension.js"));
        }
    }

    #[test]
    fn a_main_that_points_outside_the_staged_folder_is_refused() {
        // `validate` catches `../` already; this asserts the staging check does
        // not lose that when it rebuilds the path a second time.
        let dir = scratch_dir();
        write_file(
            &dir.join("plugin.json"),
            String::from_utf8(manifest_bytes("1.0.0"))
                .expect("utf8")
                .replace(r#""main":"main.js""#, r#""main":"../main.js""#)
                .as_bytes(),
        );
        write_file(&dir.join("main.js"), b"qing.log('hi');");
        let error = check_staged_package(&dir).expect_err("`..` is not a package path");
        assert!(error.starts_with("E_MANIFEST_INVALID"), "{error}");
    }

    #[test]
    fn an_entry_name_containing_a_colon_is_refused() {
        // Windows: `evil.js:hidden` is not a file name, it is the stream
        // `hidden` on `evil.js`. Before the P0 close-out `safe_entry_path` only
        // refused a colon at position 1 (the drive prefix), so the entry was
        // accepted and landed as a zero-byte `evil.js` plus content that no
        // `fs::read` of the visible file ever shows — invisible to
        // `is_native_module`, to a content scan, and to the user browsing the
        // plugin folder. A package has no legitimate use for a stream.
        for entry in ["addon.node:payload", "evil.js:hidden", "dist/main.js:$DATA"] {
            let error = extract(&[
                ("plugin.json", manifest_bytes("1.0.0")),
                ("main.js", b"qing.log('hi');".to_vec()),
                (entry, b"ADS-CONTENT".to_vec()),
            ])
            .expect_err("a stream name must not extract");
            assert!(error.starts_with("E_ZIP_SLIP"), "{entry}: {error}");
            assert!(error.contains("colon"), "{entry}: {error}");
        }

        // Nothing was written, so there is no zero-byte decoy left behind and
        // no stream holding the payload.
        let dir = std::env::temp_dir().join(format!("qing-plugin-ads-{}", unique_token()));
        fs::create_dir_all(&dir).expect("scratch directory");
        let archive = dir.join("package.qnp");
        fs::write(
            &archive,
            build_zip(&[
                ("plugin.json", manifest_bytes("1.0.0")),
                ("main.js", b"qing.log('hi');".to_vec()),
                ("evil.js:hidden", b"ADS-CONTENT".to_vec()),
            ]),
        )
        .expect("write archive");
        let target = dir.join("out");
        assert!(extract_archive(&archive, &target).is_err());
        assert!(
            !target.join("evil.js").exists(),
            "the extractor wrote a visible empty file for a rejected entry"
        );
        assert!(!tree_contains(&target, b"ADS-CONTENT"), "the payload landed");
    }

    // -----------------------------------------------------------------------
    // QA / P1a-1.5: the index client, which is untrusted input from two mirrors
    // -----------------------------------------------------------------------

    #[test]
    fn one_malformed_index_entry_does_not_take_the_market_down() {
        // The shape the index repo actually produced: one entry with
        // `permissions` written as a string. Before this, the whole document
        // failed to deserialize, both mirrors "failed", and the market showed
        // "no plugins available" — every author disappeared because of one
        // typo.
        let body = r#"{
          "schema": 1,
          "updatedAt": "2026-10-27",
          "plugins": [
            { "id": "qing.a", "name": "A", "version": "1.0.0",
              "download": "https://example.invalid/a.qnp", "permissions": ["notify"] },
            { "id": "qing.broken", "name": "Broken", "version": "1.0.0",
              "download": "https://example.invalid/b.qnp", "permissions": "notify" },
            { "id": "qing.c", "name": "C", "version": "2.0.0",
              "download": "https://example.invalid/c.qnp", "permissions": [] }
          ]
        }"#;
        let document: IndexDocument =
            serde_json::from_str(body).expect("a bad entry must not fail the document");
        let ids: Vec<&str> = document.plugins.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["qing.a", "qing.c"], "the bad entry is skipped, the rest stay");
        assert_eq!(document.plugins[1].version, "2.0.0");
        assert_eq!(document.plugins[0].permissions, vec!["notify"]);

        // An entry with no id is skipped under a positional name, which is what
        // the log line shows.
        let body = r#"{
          "schema": 1,
          "plugins": [
            { "name": "No Id", "version": "1.0.0" },
            { "id": "qing.ok", "name": "Ok", "version": "1.0.0" }
          ]
        }"#;
        let document: IndexDocument = serde_json::from_str(body).expect("parses");
        assert_eq!(document.plugins.len(), 1);
        assert_eq!(document.plugins[0].id, "qing.ok");
    }

    #[test]
    fn an_index_written_for_a_newer_schema_is_refused() {
        // `schema` has been in the document since day one and was read by
        // nobody. A schema 2 entry shape (new required field) would otherwise be
        // half-understood by every build shipped before it: empty defaults where
        // the author filled something in, a market that looks broken instead of
        // old.
        let parse = |schema: u32| -> IndexDocument {
            serde_json::from_str(&format!(
                r#"{{"schema": {schema}, "plugins": [
                     {{"id": "qing.a", "name": "A", "version": "1.0.0"}}
                   ]}}"#
            ))
            .expect("the document itself parses")
        };

        for schema in [0, 1] {
            let document = parse(schema);
            assert!(
                ensure_supported_index_schema(&document).is_ok(),
                "schema {schema} is readable"
            );
        }

        let document = parse(2);
        let error = ensure_supported_index_schema(&document).expect_err("schema 2 is not");
        assert!(error.starts_with("E_INDEX_SCHEMA"), "{error}");
        assert!(error.contains('2'), "the message names the schema it saw: {error}");

        // The cached copy is held to the same rule: a cache written by a newer
        // build is ignored rather than displayed half-understood.
        let dir = scratch_dir();
        let path = dir.join("index-cache.json");
        write_file(
            &path,
            br#"{"fetchedAt":"2026-10-27","fetchedAtEpoch":0,"source":"cache",
                 "document":{"schema":2,"plugins":[{"id":"qing.a","name":"A","version":"1.0.0"}]}}"#,
        );
        assert!(read_index_cache(&path).is_none(), "a newer-schema cache is ignored");
        write_file(
            &path,
            br#"{"fetchedAt":"2026-10-27","fetchedAtEpoch":0,"source":"cache",
                 "document":{"schema":1,"plugins":[{"id":"qing.a","name":"A","version":"1.0.0"}]}}"#,
        );
        let cache = read_index_cache(&path).expect("a schema-1 cache is still usable");
        assert_eq!(cache.document.plugins.len(), 1);
    }
}
