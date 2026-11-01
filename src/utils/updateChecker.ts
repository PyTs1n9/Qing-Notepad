import packageJson from "../../package.json";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export const APP_VERSION = packageJson.version;
export const GITHUB_URL = "https://github.com/PyTs1n9/Qing-Notepad";
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;

/**
 * 更新链路的两个人机边界事件。名字由 Rust 侧的 `update.rs` 决定，
 * 两边必须一致 —— 所以这里导出常量，组件不许再手写字符串。
 */
export const UPDATE_PROGRESS_EVENT = "update:progress";
export const UPDATE_INSTALLING_EVENT = "update:installing";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** 发行说明，取自清单里的 `notes`，可能为空。 */
  body: string | null;
  /** RFC 3339 发布时间。Gitee 与 GitHub 两份清单各自写入。 */
  date: string | null;
}

export interface UpdateProgressPayload {
  downloaded: number;
  /** 服务端没给 `Content-Length` 时为 null。 */
  total: number | null;
}

interface ParsedVersion {
  numbers: [number, number, number];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i);
  if (!match) return null;

  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

/**
 * Compares two versions by their three numeric parts **only**, ignoring any
 * prerelease suffix.
 *
 * This is the primitive the announcement feed needs for its version windows
 * (`minAppVersion` inclusive, `maxAppVersionExclusive` exclusive). It exists
 * because range syntax is the wrong tool here: `semver.satisfies("0.8.0-beta.1",
 * ">=0.7.0")` is `false` by default, which would hide every notice from beta
 * users. A triple comparison sidesteps that rule entirely.
 *
 * Unparsable input throws instead of collapsing to a value: a silent `0` would
 * make a typo'd `maxAppVersionExclusive` hide *every* item (0 means "equal",
 * and equal fails the exclusive bound), and any invented `-1`/`1` would be a
 * lie. Callers that want "no constraint" semantics must decide it themselves.
 */
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(`Unparsable app version: ${!left ? a : b}`);
  }

  for (let index = 0; index < left.numbers.length; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  // Prerelease is deliberately not consulted - see the doc comment.
  return 0;
}

/**
 * `1.2.3-beta.1` is a prerelease, `1.2.3` is not. Reuses `parseVersion` so the
 * accepted grammar stays in one place.
 */
export function isPrereleaseVersion(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.prerelease.length > 0;
}

/**
 * Shared remote fetch for every outbound request in the renderer.
 *
 * Update checks (and the announcement feed) run through the http plugin in the
 * desktop app. A webview `fetch` would force the host into the CSP
 * `connect-src` for requests that are not part of the page's own traffic. The
 * plugin performs them in Rust (outside the CSP) and its own allowlist already
 * covers `https://**`. `cache` is not part of the plugin's RequestInit subset,
 * and it never caches.
 */
export const remoteFetch: typeof fetch = isTauri() ? (tauriFetch as unknown as typeof fetch) : fetch;

/**
 * 检查更新。
 *
 * 源的顺序、端点解析、签名校验与版本比较全部在 Rust 侧（`update.rs`）：
 * Gitee 主源，GitHub 尽力而为。前端不自己拼 URL 依次请求，是因为官方
 * `endpoints` 数组只在返回非 2xx 时才回落，连接超时那类失败会静默吞掉备源。
 *
 * 返回 `null` 表示已是最新；抛错表示**所有**源都失败（含"忘了给 Gitee 传清单"）。
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  return invoke<UpdateInfo | null>("check_update");
}

/**
 * 下载并安装。
 *
 * **Windows 上这个 promise 通常不会正常 resolve**：官方说明是安装步骤执行时
 * 应用会被自动结束（受 Windows 安装器限制），新版本由安装器的 `/R` 参数拉起。
 * 所以"更新成功"的收尾逻辑不能写在 `await` 之后，进度只能靠事件。
 */
export async function installUpdate(): Promise<void> {
  if (!isTauri()) {
    throw new Error("E_UPDATE_DESKTOP_ONLY: 仅桌面版支持软件内更新");
  }
  await invoke("install_update");
}
