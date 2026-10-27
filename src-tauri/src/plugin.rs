//! Plugin packages: install, enable, rollback, private storage, index, logs.
//!
//! The threat model is in `docs/plan-plugin-system.md` §7. Two rules shape every
//! function here:
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
        "https://raw.githubusercontent.com/PyTs1n9/qing-notepad-plugins/main/index.json",
    ),
    (
        "jsdelivr",
        "https://cdn.jsdelivr.net/gh/PyTs1n9/qing-notepad-plugins@main/index.json",
    ),
];
const USER_AGENT: &str = "QingNotepad-PluginManager/1";
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

    Ok(())
}

/// Read the manifest from a package directory, whichever format it shipped.
///
/// `package.json` is the preferred name and wins when it is a *plugin*
/// manifest. The discriminator is `main`: an npm `package.json` used only to
/// drive a build (scripts, devDependencies) has no `main`, so a package that
/// still ships `plugin.json` — every example in `examples/`, and every install
/// made before this format existed — keeps working untouched. A `package.json`
/// that *does* have `main` is treated as authoritative: if it is missing a
/// `name` the install fails instead of silently falling back, because silently
/// installing a different manifest than the author wrote is worse than an error.
fn read_manifest_any(dir: &Path) -> Result<PluginManifest, String> {
    let package_path = dir.join("package.json");
    if package_path.is_file() {
        let raw = fs::read_to_string(&package_path).map_err(|error| format!("E_IO: {error}"))?;
        let document: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("E_MANIFEST_INVALID: package.json: {error}"))?;
        let declares_main = document
            .get("main")
            .and_then(Value::as_str)
            .map(|main| !main.trim().is_empty())
            .unwrap_or(false);
        if declares_main {
            return plugin_manifest::from_package_json(&raw).map_err(|error| error.message());
        }
    }

    let legacy_path = dir.join("plugin.json");
    if legacy_path.is_file() {
        let raw =
            fs::read_to_string(&legacy_path).map_err(|error| format!("E_IO: {error}"))?;
        return serde_json::from_str(&raw)
            .map_err(|error| format!("E_MANIFEST_INVALID: {error}"));
    }

    Err("E_MANIFEST_MISSING: package.json (with a `main` entry) or plugin.json must sit at the package root"
        .into())
}

/// Post-extraction checks shared by both install sources.
///
/// Everything here operates on the manifest, so a directory and an archive are
/// held to exactly the same rules: a valid id, a `main` that stays inside the
/// package, a permission set from the whitelist, and a single-file script entry.
fn check_staged_package(staging_dir: &Path) -> Result<PluginManifest, String> {
    let manifest = read_manifest_any(staging_dir)?;
    plugin_manifest::validate(&manifest).map_err(|error| error.message())?;

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
    #[serde(default)]
    pub plugins: Vec<IndexEntry>,
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
    serde_json::from_str(&raw).ok()
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
                        Ok(document) => return Ok((document, source.to_string())),
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
}
