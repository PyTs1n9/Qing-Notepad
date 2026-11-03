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

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
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

/// 已下载、还没安装的那一份。只活在内存里：进程退出就丢，下次启动重新下载。
///
/// 不落临时文件是有意的。临时文件要额外处理三件事——版本失效、目录权限、装完的残留清理，
/// 而 27 MB 的重复下载比这三件事便宜。
struct Pending {
    version: String,
    update: Box<Update>,
    bytes: Vec<u8>,
}

/// 两个命令之间的状态。
///
/// `available` 存的是 `check()` 的返回值：下载需要版本号、下载地址与签名，三样都在里面。
/// 点击「下载」时重新 `locate()` 会让用户先白等一轮探测（Gitee 预算 6s），所以检查时
/// 就把句柄留下。句柄过期不构成风险：签名与版本比较都由 `download()` 重新校验。
#[derive(Default)]
pub struct UpdateState {
    available: Mutex<Option<Box<Update>>>,
    pending: Mutex<Option<Pending>>,
}

const LOCK_ERROR: &str = "E_UPDATE_LOCK: 更新状态锁不可用";

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
pub async fn check_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    let Some(update) = locate(&app).await? else {
        // 服务端明确说没有更新：上一次下载的安装包已经没有意义。
        *state.pending.lock().map_err(|_| LOCK_ERROR)? = None;
        return Ok(None);
    };

    let info = UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
        date: update.date.as_ref().map(|date| date.to_string()),
    };

    {
        // 版本变了就丢掉旧的待装包，否则「重启」会装上一个卡片从没写过的版本。
        let mut pending = state.pending.lock().map_err(|_| LOCK_ERROR)?;
        if pending
            .as_ref()
            .is_some_and(|item| item.version != info.version)
        {
            *pending = None;
        }
    }

    *state.available.lock().map_err(|_| LOCK_ERROR)? = Some(update);
    Ok(Some(info))
}

/// 只下载，不安装。
///
/// 拆成两步是因为 Windows 上「先装完、再重启」不存在：`install` 启动 NSIS 后会直接
/// `exit(0)`，安装器必须先看到进程结束才能覆盖 exe。所以唯一能停在中间等待用户的节点
/// 是「下载完成」。
///
/// 返回下载到的版本号，前端拿它和卡片上的版本对一次账。
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<String, String> {
    let cached = state.available.lock().map_err(|_| LOCK_ERROR)?.take();
    let mut update = match cached {
        Some(update) => update,
        // 检查已经过去很久（或者应用重启过），句柄没了就现场再找一次，而不是直接失败。
        None => locate(&app)
            .await?
            .ok_or_else(|| "E_UPDATE_NOT_FOUND: 没有可下载的更新".to_string())?,
    };

    // 探测预算（6s / 4s）拿来下 27 MB 会必失败。`timeout` 在 `Update` 上是公开字段。
    update.timeout = Some(DOWNLOAD_TIMEOUT);

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;

    // `download` 内部已校验签名；`install` 会再校验一次。这里不重写任何安全逻辑。
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| format!("E_UPDATE_DOWNLOAD: {error}"))?;

    let version = update.version.clone();
    *state.pending.lock().map_err(|_| LOCK_ERROR)? = Some(Pending {
        version: version.clone(),
        update,
        bytes,
    });

    Ok(version)
}

/// 启动安装器。**Windows 上这个命令不会返回**：`install` 调完 `ShellExecuteW` 就
/// `exit(0)`，新版本由安装器的 `/R` 拉起。所以前端不能把「收到 Ok」当成安装成功的凭据，
/// 只能把「连接断开」当成预期内的收尾。
#[tauri::command]
pub async fn install_downloaded(state: State<'_, UpdateState>) -> Result<(), String> {
    let pending = state.pending.lock().map_err(|_| LOCK_ERROR)?.take();
    let Some(pending) = pending else {
        return Err("E_UPDATE_NOT_READY: 安装包尚未下载".to_string());
    };

    // 写临时文件 + 拉起安装器都在这一步，同步实现；放阻塞线程池，别占住主线程。
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let result = pending.update.install(&pending.bytes);
        (result, pending)
    })
    .await
    .map_err(|error| format!("E_UPDATE_JOIN: {error}"))?;

    let (result, pending) = outcome;
    if let Err(error) = result {
        // 装不上就把字节还回去，用户重试不必重新下载 27 MB。
        *state.pending.lock().map_err(|_| LOCK_ERROR)? = Some(pending);
        return Err(format!("E_UPDATE_INSTALL: {error}"));
    }

    Ok(())
}
