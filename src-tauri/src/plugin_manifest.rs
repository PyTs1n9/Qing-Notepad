//! Manifest deserialisation and validation, for both file formats.
//!
//! Two manifests are understood:
//!
//! - `plugin.json` — the original format, with this project's own vocabulary
//!   (`id`, `engines.host`, `contributes.commands[].id`). Every field is read
//!   straight into [`PluginManifest`].
//! - `package.json` — the VS Code shape (`name` + `publisher`, `engines.qing`,
//!   `contributes.commands[].command`). It is *mapped* onto the same
//!   [`PluginManifest`] by [`from_package_json`], so nothing downstream — the
//!   IPC payload, the frontend types, the installed records — has to know which
//!   file the package shipped. `plugin.json` stays supported because packages
//!   installed from the old format must keep working.
//!
//! Everything a plugin package claims about itself is untrusted input: the id
//! becomes a directory name, `main` becomes a file path, and `permissions`
//! becomes an authorisation grant. So this module validates rather than
//! normalises — an invalid manifest is rejected with a machine-readable code
//! instead of being coerced into something that happens to work. That is also
//! why the `package.json` mapping is strict about the four fields it cannot
//! guess (`name`, `version`, `engines.qing`, `main`) and tolerant about the
//! ones that are decoration (`author`, `repository`, unknown fields).
//!
//! `engines.host` / `engines.qing` is deliberately *not* range-checked here:
//! range parsing lives in `src/plugin/version.ts` (the `semver` package), and
//! duplicating it in Rust would mean two implementations of the same range
//! grammar drifting apart. The command layer checks that the field is present
//! and non-empty; the frontend decides whether the range matches the host.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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

// ---------------------------------------------------------------------------
// `package.json` → `PluginManifest`
// ---------------------------------------------------------------------------

/// A `package.json` as written by a VS Code extension author.
///
/// Deserialised field by field rather than with `rename` aliases because three
/// of them (`engines`, `main`, `contributes.commands`) accept two spellings
/// each. Unknown keys — `scripts`, `devDependencies`, `dependencies`, `icon`,
/// `categories`, everything else in the npm/VS Code world — are ignored by
/// serde's default behaviour, which is what makes a real `package.json`
/// readable here at all.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PackageJson {
    name: Option<String>,
    publisher: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    author: Option<Value>,
    license: Option<String>,
    repository: Option<Value>,
    version: Option<String>,
    engines: Option<PackageEngines>,
    main: Option<String>,
    activation_events: Option<Vec<String>>,
    permissions: Option<Vec<String>>,
    contributes: Option<PackageContributions>,
    api_version: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PackageEngines {
    /// Preferred spelling.
    qing: Option<String>,
    /// Accepted for packages written before the rename from `host`.
    host: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PackageContributions {
    commands: Option<Vec<PackageCommand>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PackageCommand {
    /// VS Code spelling.
    command: Option<String>,
    /// This project's original spelling, still accepted.
    id: Option<String>,
    title: Option<String>,
    category: Option<String>,
}

/// `./dist/extension.js` and `dist/extension.js` mean the same thing; the
/// stored form is always the second one, because that is what every consumer
/// (`is_safe_relative_path`, `staging_dir.join`, the worker's path walk) expects.
pub fn normalize_relative_entry(raw: &str) -> String {
    let mut path = raw.trim().replace('\\', "/");
    while let Some(rest) = path.strip_prefix("./") {
        path = rest.to_string();
    }
    path
}

/// `author` is a string, `{name, url}` or `{name, email}` in the wild. A shape
/// this build does not recognise loses the credit line, not the install.
fn author_from_value(value: Option<&Value>) -> Option<AuthorField> {
    match value? {
        Value::String(name) => {
            let name = name.trim();
            if name.is_empty() {
                None
            } else {
                Some(AuthorField::Name(name.to_string()))
            }
        }
        Value::Object(map) => {
            let name = map.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            let url = map
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_string);
            Some(AuthorField::Detailed(PluginAuthor {
                name: name.to_string(),
                url,
            }))
        }
        _ => None,
    }
}

/// `repository` is a URL string or `{type, url}` (the npm shape).
fn repository_from_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(url) => {
            let url = url.trim();
            if url.is_empty() {
                None
            } else {
                Some(url.to_string())
            }
        }
        Value::Object(map) => map
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

/// `*` is VS Code's "activate as early as possible". This host has exactly one
/// such moment, `onStartup`, so the wildcard is translated rather than passed
/// through as an event no consumer would ever match. Anything else is left
/// alone: an unknown event is a forward-compatibility problem for the *event*,
/// never a reason to refuse the package.
fn map_activation_events(events: Option<Vec<String>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for event in events.unwrap_or_default() {
        let event = event.trim();
        if event.is_empty() {
            continue;
        }
        let event = if event == "*" { "onStartup" } else { event };
        if !out.iter().any(|existing| existing == event) {
            out.push(event.to_string());
        }
    }
    out
}

/// `contributes.commands[]` uses `command` in VS Code and `id` here; both are
/// accepted, `command` wins when a package carries both.
fn map_commands(contributes: Option<PackageContributions>) -> Vec<CommandContribution> {
    let mut out: Vec<CommandContribution> = Vec::new();
    for command in contributes.and_then(|value| value.commands).unwrap_or_default() {
        let id = command
            .command
            .or(command.id)
            .map(|id| id.trim().to_string())
            .unwrap_or_default();
        let title = command.title.map(|title| title.trim().to_string()).unwrap_or_default();
        let category = command
            .category
            .map(|category| category.trim().to_string())
            .filter(|category| !category.is_empty());
        // An entry with no id or no title is a broken contribution, not a
        // broken package: `validate` rejects it with the same code the old
        // format produced, so the author sees one consistent message.
        out.push(CommandContribution { id, title, category });
    }
    out
}

/// Turn a `package.json` document into the internal manifest.
///
/// `dependencies` / `devDependencies` are deliberately *not* read: they are
/// normal, expected fields in a `package.json` and refusing them (the rule that
/// still applies to `plugin.json`) would reject every real package. The mapped
/// manifest therefore always carries `dependencies: None`, so [`validate`] has
/// nothing to reject.
pub fn from_package_json(raw: &str) -> Result<PluginManifest, ManifestError> {
    let package: PackageJson = serde_json::from_str(raw).map_err(|error| {
        ManifestError::new("E_MANIFEST_INVALID", format!("package.json: {error}"))
    })?;
    map_package_json(package)
}

fn map_package_json(package: PackageJson) -> Result<PluginManifest, ManifestError> {
    let name = package
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ManifestError::new("E_MANIFEST_INVALID", "package.json needs a `name`"))?;
    let publisher = package
        .publisher
        .as_deref()
        .map(str::trim)
        .filter(|publisher| !publisher.is_empty());
    // `publisher.name` is the documented composition; a package without a
    // publisher has to put a full, valid id in `name` instead. Either way the
    // result is checked by `validate`, which is the only place that owns the
    // id pattern.
    let id = match publisher {
        Some(publisher) => format!("{publisher}.{name}"),
        None => name.to_string(),
    };

    let version = package
        .version
        .as_deref()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .ok_or_else(|| {
            ManifestError::new("E_MANIFEST_INVALID", "package.json needs a `version`")
        })?;

    let engines = package.engines.unwrap_or_default();
    let host = engines
        .qing
        .as_deref()
        .map(str::trim)
        .filter(|range| !range.is_empty())
        .or_else(|| {
            engines
                .host
                .as_deref()
                .map(str::trim)
                .filter(|range| !range.is_empty())
        })
        .ok_or_else(|| {
            ManifestError::new(
                "E_MANIFEST_INVALID",
                "package.json needs `engines.qing` (or `engines.host`)",
            )
        })?;

    let main = normalize_relative_entry(package.main.as_deref().unwrap_or_default());
    if main.is_empty() {
        return Err(ManifestError::new(
            "E_MANIFEST_INVALID",
            "package.json needs a `main` entry point",
        ));
    }

    let display_name = package
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name);

    Ok(PluginManifest {
        id,
        name: display_name.to_string(),
        version: version.to_string(),
        // Absent means "the one contract this build implements"; present means
        // the author wrote it down, and `validate` still has to agree.
        api_version: package.api_version.unwrap_or(1),
        engines: PluginEngines {
            host: host.to_string(),
        },
        description: package
            .description
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        author: author_from_value(package.author.as_ref()),
        license: package
            .license
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        repository: repository_from_value(package.repository.as_ref()),
        main,
        activation_events: map_activation_events(package.activation_events),
        permissions: package.permissions.unwrap_or_default(),
        contributes: Contributions {
            commands: map_commands(package.contributes),
        },
        dependencies: None,
    })
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

    // -----------------------------------------------------------------------
    // package.json mapping
    // -----------------------------------------------------------------------

    /// The smallest `package.json` this build accepts, with `extra` spliced in
    /// as additional top-level keys so each test only states what it is about.
    fn package_json(body: &str) -> String {
        format!(
            r#"{{
              "name": "wordcount",
              "publisher": "qing",
              "version": "1.0.0",
              "engines": {{ "qing": ">=0.7.3 <1.0.0" }},
              "main": "dist/extension.js"{body}
            }}"#
        )
    }

    #[test]
    fn publisher_and_name_compose_the_id() {
        let manifest = from_package_json(&package_json("")).expect("a complete package parses");
        assert_eq!(manifest.id, "qing.wordcount");
        assert_eq!(manifest.name, "wordcount");
        assert!(validate(&manifest).is_ok());
    }

    #[test]
    fn a_package_without_a_publisher_must_carry_a_full_id() {
        let manifest = from_package_json(
            r#"{"name":"qing.wordcount","version":"1.0.0",
                "engines":{"qing":">=0.7.3 <1.0.0"},"main":"main.js"}"#,
        )
        .expect("a dotted name is a valid id");
        assert_eq!(manifest.id, "qing.wordcount");
        assert!(validate(&manifest).is_ok());

        // The same name without a publisher is not an id, so it is refused at
        // the same place any other bad id would be.
        let bare = from_package_json(
            r#"{"name":"wordcount","version":"1.0.0",
                "engines":{"qing":">=0.7.3 <1.0.0"},"main":"main.js"}"#,
        )
        .expect("the mapping itself succeeds");
        let error = validate(&bare).expect_err("a name without a dot is not an id");
        assert_eq!(error.code, "E_MANIFEST_INVALID");
    }

    #[test]
    fn engines_qing_and_engines_host_are_equivalent() {
        let qing = from_package_json(&package_json("")).expect("engines.qing parses");
        let host = from_package_json(
            r#"{"name":"wordcount","publisher":"qing","version":"1.0.0",
                "engines":{"host":">=0.7.3 <1.0.0"},"main":"dist/extension.js"}"#,
        )
        .expect("engines.host parses");
        assert_eq!(qing.engines.host, host.engines.host);
        assert_eq!(qing.engines.host, ">=0.7.3 <1.0.0");

        // Both spellings present: `qing` wins, documented in the module header.
        let both = from_package_json(
            r#"{"name":"wordcount","publisher":"qing","version":"1.0.0",
                "engines":{"qing":">=0.8.0","host":">=0.7.3"},
                "main":"dist/extension.js"}"#,
        )
        .expect("both spellings parse");
        assert_eq!(both.engines.host, ">=0.8.0");

        let missing = from_package_json(
            r#"{"name":"wordcount","publisher":"qing","version":"1.0.0",
                "engines":{"node":">=18"},"main":"dist/extension.js"}"#,
        )
        .expect_err("engines.node does not describe the host");
        assert_eq!(missing.code, "E_MANIFEST_INVALID");
    }

    #[test]
    fn commands_accept_both_the_command_and_the_id_spelling() {
        let vscode = from_package_json(&package_json(
            r#","contributes":{"commands":[{"command":"qing.wordcount.run","title":"Count"}]}"#,
        ))
        .expect("the VS Code spelling parses");
        let legacy = from_package_json(&package_json(
            r#","contributes":{"commands":[{"id":"qing.wordcount.run","title":"Count"}]}"#,
        ))
        .expect("the legacy spelling parses");
        assert_eq!(vscode.contributes.commands.len(), 1);
        assert_eq!(vscode.contributes.commands[0].id, "qing.wordcount.run");
        assert_eq!(vscode.contributes.commands[0].title, "Count");
        assert_eq!(vscode.contributes.commands[0].id, legacy.contributes.commands[0].id);
        assert!(validate(&vscode).is_ok());
        assert!(validate(&legacy).is_ok());

        // A command with no title is refused, exactly as in `plugin.json`.
        let untitled = from_package_json(&package_json(
            r#","contributes":{"commands":[{"command":"qing.wordcount.run"}]}"#,
        ))
        .expect("the mapping itself succeeds");
        assert_eq!(
            validate(&untitled).expect_err("a command needs a title").code,
            "E_MANIFEST_INVALID"
        );
    }

    #[test]
    fn a_package_without_a_name_is_refused() {
        let error = from_package_json(
            r#"{"publisher":"qing","version":"1.0.0",
                "engines":{"qing":">=0.7.3"},"main":"main.js"}"#,
        )
        .expect_err("a nameless package has no id");
        assert_eq!(error.code, "E_MANIFEST_INVALID");
        assert!(error.detail.contains("name"), "{}", error.detail);

        let blank = from_package_json(
            r#"{"name":"  ","publisher":"qing","version":"1.0.0",
                "engines":{"qing":">=0.7.3"},"main":"main.js"}"#,
        )
        .expect_err("a blank name is not a name");
        assert_eq!(blank.code, "E_MANIFEST_INVALID");
    }

    #[test]
    fn dependencies_in_a_package_json_are_ignored() {
        let manifest = from_package_json(&package_json(
            r#","dependencies":{"semver":"^7.0.0"},"devDependencies":{"esbuild":"^0.25.0"},
                "scripts":{"build":"node build.mjs"},"private":true"#,
        ))
        .expect("npm bookkeeping is not a plugin declaration");
        assert!(
            manifest.dependencies.is_none(),
            "dependencies must not survive the mapping: {manifest:?}"
        );
        assert!(
            validate(&manifest).is_ok(),
            "a package.json with dependencies must install"
        );
        // The old format keeps its stricter rule.
        let legacy: PluginManifest = serde_json::from_str(
            r#"{"id":"qing.x","name":"X","version":"1.0.0","apiVersion":1,
                "engines":{"host":">=0.7.3"},"main":"main.js",
                "dependencies":{"y":"1.0.0"}}"#,
        )
        .expect("plugin.json still parses");
        assert_eq!(
            validate(&legacy).expect_err("plugin.json may not declare dependencies").code,
            "E_DEPENDENCIES_UNSUPPORTED"
        );
    }

    #[test]
    fn main_is_normalised_and_still_bounded() {
        assert_eq!(normalize_relative_entry("./dist/extension.js"), "dist/extension.js");
        assert_eq!(normalize_relative_entry(".\\dist\\extension.js"), "dist/extension.js");
        assert_eq!(normalize_relative_entry("dist/extension.js"), "dist/extension.js");

        let manifest = from_package_json(&package_json("").replace(
            "\"main\": \"dist/extension.js\"",
            "\"main\": \"./dist/extension.mjs\"",
        ))
        .expect("a ./-prefixed .mjs entry parses");
        assert_eq!(manifest.main, "dist/extension.mjs");
        assert!(validate(&manifest).is_ok());

        let escape = from_package_json(
            r#"{"name":"wordcount","publisher":"qing","version":"1.0.0",
                "engines":{"qing":">=0.7.3"},"main":"./../evil.js"}"#,
        )
        .expect("the mapping itself succeeds");
        assert_eq!(
            validate(&escape).expect_err("main must stay inside the package").code,
            "E_MANIFEST_INVALID"
        );
    }

    #[test]
    fn decoration_fields_are_tolerant_and_api_version_defaults_to_one() {
        let manifest = from_package_json(&package_json(
            r#","displayName":"字数统计","description":"统计全库字数","license":"MIT",
                "author":{"name":"Qing Notepad","url":"https://example.invalid"},
                "repository":{"type":"git","url":"https://example.invalid/repo"},
                "activationEvents":["onCommand:qing.wordcount.run","onStartup","*","onWebview:x"]"#,
        ))
        .expect("a fully decorated package parses");
        assert_eq!(manifest.name, "字数统计");
        assert_eq!(manifest.description.as_deref(), Some("统计全库字数"));
        assert_eq!(manifest.license.as_deref(), Some("MIT"));
        assert_eq!(manifest.api_version, 1);
        assert!(matches!(manifest.author, Some(AuthorField::Detailed(_))));
        assert_eq!(
            manifest.repository.as_deref(),
            Some("https://example.invalid/repo")
        );
        // `*` becomes the one early-activation moment this host has; the
        // unknown event is passed through and never matched.
        assert_eq!(
            manifest.activation_events,
            vec![
                "onCommand:qing.wordcount.run",
                "onStartup",
                "onWebview:x"
            ]
        );

        // A shape this build does not know loses the credit line, not the install.
        let odd = from_package_json(&package_json(r#","author":42,"repository":[1,2]"#))
            .expect("odd decoration still parses");
        assert!(odd.author.is_none());
        assert!(odd.repository.is_none());
        assert!(validate(&odd).is_ok());
    }

    #[test]
    fn a_package_json_needs_version_engines_and_main() {
        for (body, needle) in [
            (r#"{"name":"qing.x","engines":{"qing":">=0.7.3"},"main":"main.js"}"#, "version"),
            (r#"{"name":"qing.x","version":"1.0.0","main":"main.js"}"#, "engines.qing"),
            (r#"{"name":"qing.x","version":"1.0.0","engines":{"qing":">=0.7.3"}}"#, "main"),
        ] {
            let error = from_package_json(body).expect_err("a required field is missing");
            assert_eq!(error.code, "E_MANIFEST_INVALID");
            assert!(error.detail.contains(needle), "{needle}: {}", error.detail);
        }
        // Non-strict semver is refused by the same validator as before.
        let loose = from_package_json(
            r#"{"name":"qing.x","version":"1.0","engines":{"qing":">=0.7.3"},"main":"main.js"}"#,
        )
        .expect("the mapping itself succeeds");
        assert_eq!(
            validate(&loose).expect_err("1.0 is not strict semver").code,
            "E_MANIFEST_INVALID"
        );
    }
}
