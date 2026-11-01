//! 软件内更新：Gitee 主源，GitHub 尽力而为。
//!
//! 为什么不把两个地址写进 `tauri.conf.json` 的 `endpoints` 数组：官方的回落语义是
//! 「**只有返回非 2xx 才试下一个 URL**」，连接超时、DNS 被污染这类传输层失败不会回落。
//! 于是"主源 + 备源"在真实网络里会静默退化成"主源挂了就整体挂掉"，还给人一种双源的错觉。
//!
//! 这里的做法是自己按顺序解析出一个**确定可用**的端点，再交给 updater：
//! 签名校验、版本比较、安装器调用（NSIS passive + 装完自动拉起）全部复用官方实现，
//! 不重写任何一条安全逻辑。
//!
//! 端点是"按版本定位"的，不是固定 URL：Gitee 不支持
//! `releases/latest/download/<file>` 这种路径（实测会 302 到 `/repository/archive/...`），
//! 所以先用 `/releases/latest` 的 302 拿到最新 tag，再拼出该 tag 下的清单附件地址。

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 仓库地址。tag 之外的路径都从这里派生，改名时只改这里。
const GITEE_REPO: &str = "https://gitee.com/PyTs1N9/Qing-Notepad";

/// Gitee 的清单文件名。刻意与 GitHub 那份不同名：两份内容只在 `url` 上不同，
/// 同名会让人分不清手里这坨 JSON 指向哪个下载源。
const GITEE_MANIFEST: &str = "latest-gitee.json";

/// GitHub 的清单走 `releases/latest/download`，这是官方支持、且与本文件是否在仓库里无关的固定路径。
const GITHUB_MANIFEST: &str =
    "https://github.com/PyTs1n9/Qing-Notepad/releases/latest/download/latest.json";

/// 探测预算。GitHub 在国内常常是"连不上也不报错"，给它更短的预算，
/// 免得每次启动都白等一个注定失败的请求。
const GITEE_PROBE: Duration = Duration::from_secs(6);
const GITHUB_PROBE: Duration = Duration::from_secs(4);

/// 安装包约 27 MB、官方 updater 没有断点续传。这个值只当上限用：
/// 低于约 45 KB/s 的连接会撞上它，而不是永久挂在那里。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

const PROGRESS_EVENT: &str = "update:progress";
const INSTALLING_EVENT: &str = "update:installing";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    body: Option<String>,
    date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

enum Probe {
    Found(Box<Update>),
    UpToDate,
    Failed(String),
}

/// Gitee 最新 tag 对应的清单地址。
///
/// `/releases/latest` 是 302 到 `/releases/tag/<tag>`，末段就是 tag。
/// 刻意不跟随重定向：跟到 tag 页面等于白白下载一份 HTML。
async fn gitee_manifest() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(GITEE_PROBE)
        .user_agent(concat!("QingNotepad/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("E_UPDATE_CLIENT: {error}"))?;

    let response = client
        .get(format!("{GITEE_REPO}/releases/latest"))
        .send()
        .await
        .map_err(|error| format!("E_UPDATE_GITEE: {error}"))?;

    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    let tag = location
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();

    // 只接受 `v` 开头的 tag。Gitee 的发行版页面在"还没有发行版"、"被限流"等情况下
    // 会给出别的跳转，这里硬挡一道，免得把一段 HTML 当成版本号拼进 URL。
    if !tag.starts_with('v') || tag.len() < 2 {
        return Err(format!(
            "E_UPDATE_TAG: {} (status {})",
            if location.is_empty() { "缺少 Location" } else { location },
            response.status()
        ));
    }

    Ok(format!(
        "{GITEE_REPO}/releases/download/{tag}/{GITEE_MANIFEST}"
    ))
}

async fn probe(app: &AppHandle, endpoint: &str, timeout: Duration) -> Probe {
    let Ok(url) = endpoint.parse::<tauri::Url>() else {
        return Probe::Failed(format!("E_UPDATE_ENDPOINT: {endpoint}"));
    };

    let updater = match app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| Ok(builder.timeout(timeout).build()?))
    {
        Ok(updater) => updater,
        Err(error) => return Probe::Failed(format!("{endpoint}: {error}")),
    };

    match updater.check().await {
        Ok(Some(update)) => Probe::Found(Box::new(update)),
        Ok(None) => Probe::UpToDate,
        Err(error) => Probe::Failed(format!("{endpoint}: {error}")),
    }
}

/// 按 Gitee → GitHub 的顺序找一个更新的版本。
async fn locate(app: &AppHandle) -> Result<Option<Box<Update>>, String> {
    let mut failures: Vec<String> = Vec::new();
    let mut endpoints: Vec<(String, Duration)> = Vec::new();

    match gitee_manifest().await {
        Ok(endpoint) => endpoints.push((endpoint, GITEE_PROBE)),
        Err(error) => failures.push(error),
    }
    endpoints.push((GITHUB_MANIFEST.to_string(), GITHUB_PROBE));

    let mut up_to_date = false;
    for (endpoint, timeout) in endpoints {
        match probe(app, &endpoint, timeout).await {
            Probe::Found(update) => return Ok(Some(update)),
            Probe::UpToDate => up_to_date = true,
            Probe::Failed(error) => failures.push(error),
        }
    }

    // 只要有一个源明确回答"已是最新"就算成功：另一个源挂了不该让用户看到"检查失败"。
    // 全部失败才把原因抛上去，这样"忘了给 Gitee 传清单"是可见的错误，而不是静默的"已是最新"。
    if up_to_date || failures.is_empty() {
        Ok(None)
    } else {
        Err(failures.join(" · "))
    }
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let Some(update) = locate(&app).await? else {
        return Ok(None);
    };

    Ok(Some(UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
        date: update.date.as_ref().map(|date| date.to_string()),
    }))
}

/// 下载并安装。**Windows 上这个命令通常不会返回**：官方说明是安装步骤执行时应用会被
/// 自动结束（受 Windows 安装器限制），新版本由安装器的 `/R` 拉起。
/// 所以"更新完成"的收尾逻辑不能写在 `await` 之后。
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let mut update = locate(&app)
        .await?
        .ok_or_else(|| "E_UPDATE_NOT_FOUND: 没有可安装的更新".to_string())?;

    // `locate` 用的是探测预算（6s / 4s），直接拿去下载 27 MB 会必失败。
    // `timeout` 是 `Update` 的公开字段，下载前单独放宽。
    update.timeout = Some(DOWNLOAD_TIMEOUT);

    let progress_app = app.clone();
    let installing_app = app.clone();
    let mut downloaded: u64 = 0;

    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            move || {
                let _ = installing_app.emit(INSTALLING_EVENT, ());
            },
        )
        .await
        .map_err(|error| format!("E_UPDATE_INSTALL: {error}"))
}
