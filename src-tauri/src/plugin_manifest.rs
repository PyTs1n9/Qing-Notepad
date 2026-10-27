//! `plugin.json` deserialisation and validation.
//!
//! Everything a plugin package claims about itself is untrusted input: the id
//! becomes a directory name, `main` becomes a file path, and `permissions`
//! becomes an authorisation grant. So this module validates rather than
//! normalises — an invalid manifest is rejected with a machine-readable code
//! instead of being coerced into something that happens to work.
//!
//! `engines.host` is deliberately *not* checked here: range parsing lives in
//! `src/plugin/version.ts` (the `semver` package), and duplicating it in Rust
//! would mean two implementations of the same range grammar drifting apart.
//! The command layer checks that the field is present and non-empty; the
//! frontend decides whether the range matches the running host.

use serde::{Deserialize, Serialize};

/// The only API contract this build implements (see D5).
pub const SUPPORTED_API_VERSIONS: &[u32] = &[1];

/// The full L1 permission set. Anything outside this list is a hard error: an
/// unknown permission would otherwise be stored, shown to the user, and grant
/// nothing, which is worse than refusing the package.
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "storage",
    "notes:read",
    "notes:write",
    "todo:read",
    "todo:write",
    "clipboard:read",
    "clipboard:write",
    "notify",
];

const MAX_ID_LEN: usize = 64;
const MAX_NAME_LEN: usize = 96;
const MAX_VERSION_LEN: usize = 64;
const MAX_RANGE_LEN: usize = 96;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AuthorField {
    Name(String),
    Detailed(PluginAuthor),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAuthor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngines {
    pub host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
    #[serde(default)]
    pub commands: Vec<CommandContribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub engines: PluginEngines,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<AuthorField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub main: String,
    #[serde(default)]
    pub activation_events: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: Contributions,
    /// D6: kept in the file for forward compatibility, rejected when non-empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<serde_json::Value>,
}

/// Validation failure carrying the code the frontend maps to a localised string.
#[derive(Debug, Clone)]
pub struct ManifestError {
    pub code: &'static str,
    pub detail: String,
}

impl ManifestError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    /// `CODE: detail` — the frontend splits on the first colon.
    pub fn message(&self) -> String {
        format!("{}: {}", self.code, self.detail)
    }
}

/// `^[a-z0-9]+(\.[a-z0-9-]+)+$`, at most 64 characters.
///
/// Hand-rolled because the crate would only be used here, and the pattern has
/// no features (no alternation, no quantifier nesting) that a parser would buy.
pub fn is_valid_plugin_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return false;
    }
    let mut segments = id.split('.');
    let first = match segments.next() {
        Some(first) => first,
        None => return false,
    };
    if first.is_empty() || !first.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return false;
    }
    let mut count = 1;
    for segment in segments {
        count += 1;
        if segment.is_empty() {
            return false;
        }
        let mut chars = segment.chars();
        let first_ok = chars
            .next()
            .map(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
            .unwrap_or(false);
        // A leading hyphen is rejected by `first_ok`; a trailing one reads as a
        // typo in every id we have seen, so both ends are refused rather than
        // letting the pattern be "almost right".
        if !first_ok
            || segment.ends_with('-')
            || !chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        {
            return false;
        }
    }
    count >= 2
}

/// Strict semver (`x.y.z`, optional `-prerelease`, optional `+build`).
///
/// "Strict" is the contract: a plugin author who writes `1.0` gets an error
/// instead of a version that compares as something they did not intend.
pub fn is_strict_semver(version: &str) -> bool {
    if version.is_empty() || version.len() > MAX_VERSION_LEN {
        return false;
    }
    let (rest, build) = match version.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (version, None),
    };
    if let Some(build) = build {
        if build.is_empty() || !build.split('.').all(is_semver_identifier) {
            return false;
        }
    }
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    if let Some(pre) = pre {
        if pre.is_empty() {
            return false;
        }
        // Numeric identifiers must not have leading zeroes (`-01` is invalid),
        // which is the one rule a naive split would let through.
        for part in pre.split('.') {
            if !is_semver_identifier(part) {
                return false;
            }
            let numeric = part.bytes().all(|b| b.is_ascii_digit());
            if numeric && part.len() > 1 && part.starts_with('0') {
                return false;
            }
        }
    }
    let numbers: Vec<&str> = core.split('.').collect();
    if numbers.len() != 3 {
        return false;
    }
    numbers.iter().all(|part| {
        !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_digit())
            && (part.len() == 1 || !part.starts_with('0'))
            && part.len() <= 10
    })
}

fn is_semver_identifier(part: &str) -> bool {
    !part.is_empty()
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A `main` entry must stay inside the package. The archive extractor already
/// refuses traversal entries; this catches a manifest that points at `../`.
pub fn is_safe_relative_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 240 {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    if path.contains('\0') {
        return false;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return false;
    }
    !path
        .replace('\\', "/")
        .split('/')
        .any(|part| part == ".." || part.is_empty())
}

pub fn validate(manifest: &PluginManifest) -> Result<(), ManifestError> {
    if !is_valid_plugin_id(&manifest.id) {
        return Err(ManifestError::new(
            "E_MANIFEST_INVALID",
            format!("invalid plugin id `{}`", manifest.id),
        ));
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > MAX_NAME_LEN {
        return Err(ManifestError::new(
            "E_MANIFEST_INVALID",
            "plugin name is empty or too long",
        ));
    }
    if !is_strict_semver(&manifest.version) {
        return Err(ManifestError::new(
            "E_MANIFEST_INVALID",
            format!("invalid semver version `{}`", manifest.version),
        ));
    }
    if !SUPPORTED_API_VERSIONS.contains(&manifest.api_version) {
        return Err(ManifestError::new(
            "E_API_VERSION",
            format!("apiVersion {} is not supported", manifest.api_version),
        ));
    }
    if manifest.engines.host.trim().is_empty() || manifest.engines.host.len() > MAX_RANGE_LEN {
        return Err(ManifestError::new(
            "E_MANIFEST_INVALID",
            "engines.host is missing or not a version range",
        ));
    }
    if !is_safe_relative_path(&manifest.main) {
        return Err(ManifestError::new(
            "E_MANIFEST_INVALID",
            format!("main `{}` must be a path inside the package", manifest.main),
        ));
    }
    for permission in &manifest.permissions {
        if !KNOWN_PERMISSIONS.contains(&permission.as_str()) {
            return Err(ManifestError::new(
                "E_PERMISSION_UNKNOWN",
                format!("unknown permission `{permission}`"),
            ));
        }
    }
    for command in &manifest.contributes.commands {
        if command.id.trim().is_empty() || command.title.trim().is_empty() {
            return Err(ManifestError::new(
                "E_MANIFEST_INVALID",
                "commands[] entries need a non-empty id and title",
            ));
        }
    }
    let has_dependencies = match &manifest.dependencies {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Array(items)) => !items.is_empty(),
        Some(serde_json::Value::Object(map)) => !map.is_empty(),
        Some(_) => true,
    };
    if has_dependencies {
        return Err(ManifestError::new(
            "E_DEPENDENCIES_UNSUPPORTED",
            "plugin dependencies are not supported",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_the_documented_pattern() {
        assert!(is_valid_plugin_id("qing.hello-headless"));
        assert!(is_valid_plugin_id("com.example.a1"));
        assert!(!is_valid_plugin_id("qing"));
        assert!(!is_valid_plugin_id("Qing.hello"));
        assert!(!is_valid_plugin_id("qing..hello"));
        assert!(!is_valid_plugin_id("qing.-x"));
        assert!(!is_valid_plugin_id("qing.x-"));
        assert!(!is_valid_plugin_id(".qing.x"));
    }

    #[test]
    fn versions_are_strict_semver() {
        assert!(is_strict_semver("1.0.0"));
        assert!(is_strict_semver("1.0.0-beta.1"));
        assert!(is_strict_semver("1.0.0-beta+exp.sha.5114f85"));
        assert!(!is_strict_semver("1.0"));
        assert!(!is_strict_semver("v1.0.0"));
        assert!(!is_strict_semver("01.0.0"));
        assert!(!is_strict_semver("1.0.0-01"));
        assert!(!is_strict_semver("1.0.0-"));
    }

    #[test]
    fn main_path_cannot_escape() {
        assert!(is_safe_relative_path("main.js"));
        assert!(is_safe_relative_path("dist/main.js"));
        assert!(!is_safe_relative_path("../main.js"));
        assert!(!is_safe_relative_path("/main.js"));
        assert!(!is_safe_relative_path("C:/main.js"));
        assert!(!is_safe_relative_path("dist//main.js"));
    }
}
