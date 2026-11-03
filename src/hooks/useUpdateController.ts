import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUpdateStore } from "@/stores/updateStore";
import { UPDATE_PROGRESS_EVENT, type UpdateProgressPayload } from "@/utils/updateChecker";
import { runUpdateCheck } from "@/hooks/updateActions";

/**
 * 更新链路的唯一挂载点（App 里调用一次）。
 *
 * 负责三件没有 UI 的事：启动时查一次、窗口回到前台时按 1 小时限频重查、把下载进度
 * 事件写回 store。界面只读 store，不自己订阅事件 —— 否则卡片一卸载，进度就断在半路。
 *
 * `enabled` 跟着应用的初始化开关走：数据目录还没就绪时不该发网络请求。
 */
export function useUpdateController(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    void runUpdateCheck(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !isTauri()) return;

    let disposed = false;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => {
      if (disposed) stop();
      else stops.push(stop);
    };

    void listen<UpdateProgressPayload>(UPDATE_PROGRESS_EVENT, (event) => {
      useUpdateStore.getState().setProgress(event.payload);
    }).then(keep);

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        // 桌面应用常开数天，只在启动查会让徽标永远不出现；限频在 runUpdateCheck 里。
        if (focused) void runUpdateCheck(false);
      })
      .then(keep);

    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [enabled]);
}
