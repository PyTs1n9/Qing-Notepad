import { useUpdateStore } from "@/stores/updateStore";
import { APP_VERSION } from "@/utils/updateChecker";
import {
  beginUpdateDownload,
  dismissUpdateForSession,
  installUpdateAndRestart,
} from "@/hooks/updateActions";
import UpdateBadge from "@/components/Layout/UpdateBadge";

/**
 * 把 store 接到纯展示的 `UpdateBadge` 上。
 *
 * 可见性只由一个条件决定：有可用更新，且这个版本没有在本次运行里被忽略。
 * 检查失败不占位 —— 见 D7，失败只留控制台。
 */
export default function UpdateEntry() {
  const available = useUpdateStore((state) => state.available);
  const dismissedVersion = useUpdateStore((state) => state.dismissedVersion);
  const phase = useUpdateStore((state) => state.phase);
  const progress = useUpdateStore((state) => state.progress);
  const error = useUpdateStore((state) => state.error);
  const readyVersion = useUpdateStore((state) => state.readyVersion);

  if (!available || dismissedVersion === available.version) return null;

  // 下载期间清单换代时，卡片要跟着实际下到手的版本走，而不是停在旧版本号上。
  const version = phase === "ready" && readyVersion ? readyVersion : available.version;

  return (
    <UpdateBadge
      version={version}
      currentVersion={APP_VERSION}
      notes={available.body}
      phase={phase}
      progress={progress}
      error={error}
      onDownload={() => void beginUpdateDownload()}
      onInstall={() => void installUpdateAndRestart()}
      onDismiss={dismissUpdateForSession}
    />
  );
}
