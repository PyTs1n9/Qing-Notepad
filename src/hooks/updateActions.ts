import { useUpdateStore } from "@/stores/updateStore";
import {
  checkForUpdate,
  downloadUpdate,
  installDownloaded,
} from "@/utils/updateChecker";

/**
 * 更新动作的编排层：调命令、写 store，两种界面（顶栏卡片、帮助弹窗）共用。
 *
 * 不放进 store，是因为 store 不许 import `@tauri-apps/*`
 * （见 `decisions-architecture-layering.md`）；不放进 `utils`，是因为 `utils → stores`
 * 只有白名单里的十一条，新增一条会被 `verify-architecture` 拦下。
 */

/** 聚焦重查的最小间隔。与公告源的软 TTL 一致。 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 检查新版本。
 *
 * `force` 为真时（帮助菜单的「检查更新」）忽略限频，并把失败原样抛给调用方；
 * 后台检查失败只写控制台 —— 顶栏徽标不出现本身已经是"没有新版本"的表达，
 * 再画一个红点只会让网络抖动变成噪音（D7）。
 */
export async function runUpdateCheck(force = false): Promise<void> {
  const state = useUpdateStore.getState();
  if (!force && Date.now() - state.lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) return;
  // 下载/安装进行中不插检查：那会重写 `available`，把已经下到一半的包判成失效。
  if (state.phase === "downloading" || state.phase === "installing") return;

  // 只有手动检查才把「检查中」画到界面上；后台检查不该让一个开着的弹窗闪一下。
  if (force) {
    state.setError("");
    state.setPhase("checking");
  }

  try {
    const info = await checkForUpdate();
    const current = useUpdateStore.getState();
    current.markChecked();
    // 阶段由 `setAvailable` 收尾：同版本且已下载时保持 ready。
    current.setAvailable(info);
  } catch (cause) {
    const current = useUpdateStore.getState();
    current.markChecked();
    if (!force) {
      // 后台失败不产生界面噪音：徽标不出现本身已经是「没有新版本」（D7）。
      console.warn("Automatic update check failed:", cause);
      if (useUpdateStore.getState().phase === "checking") current.setPhase("idle");
      return;
    }
    current.setError(errorMessage(cause));
    current.setPhase("error");
    throw cause;
  }
}

/** 第一次点击：下载 27 MB 安装包。完成后阶段变为 `ready`，等用户重启。 */
export async function beginUpdateDownload(): Promise<void> {
  const state = useUpdateStore.getState();
  if (!state.available) return;
  if (state.phase === "downloading" || state.phase === "installing") return;

  state.setError("");
  state.setProgress({ downloaded: 0, total: null });
  state.setPhase("downloading");

  try {
    const version = await downloadUpdate();
    const current = useUpdateStore.getState();
    current.setReadyVersion(version);
    current.setPhase("ready");
  } catch (cause) {
    const current = useUpdateStore.getState();
    current.setError(errorMessage(cause));
    current.setPhase("error");
  }
}

/**
 * 第二次点击：启动安装器。
 *
 * Windows 上进程会在 `install` 里被结束，IPC 随之断开 —— 那不是失败。判据是错误码：
 * 只有 Rust 明确回 `E_UPDATE_*` 才算真的装不上，其余按"进程正在退出"处理。
 */
export async function installUpdateAndRestart(): Promise<void> {
  const state = useUpdateStore.getState();
  if (state.phase !== "ready") return;

  state.setError("");
  state.setPhase("installing");

  try {
    await installDownloaded();
  } catch (cause) {
    const message = errorMessage(cause);
    if (!message.includes("E_UPDATE_")) return;
    const current = useUpdateStore.getState();
    current.setError(message);
    current.setPhase("ready");
  }
}

/** 忽略此版本：只在本次运行内隐藏。 */
export function dismissUpdateForSession(): void {
  useUpdateStore.getState().dismissSession();
}
