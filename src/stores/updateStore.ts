import { create } from "zustand";
import type { UpdateInfo, UpdateProgressPayload } from "@/utils/updateChecker";

/**
 * 更新链路在界面上的全部状态。
 *
 * 只放内存，不碰 `@tauri-apps/*`、不读写文件（见 `decisions-architecture-layering.md`）：
 * 事件订阅与命令调用在 `hooks/useUpdateController.ts` 与 `hooks/updateActions.ts` 里。
 *
 * 放在 store 而不是卡片组件里，是因为 hover 卡片会随指针移开而卸载；下载进度必须比它活得久。
 */
export type UpdatePhase =
  /** 没有进行中的动作；`available` 决定徽标是否出现。 */
  | "idle"
  | "checking"
  | "downloading"
  /** 安装包已下载，等用户点重启。 */
  | "ready"
  | "installing"
  | "error";

interface UpdateState {
  available: UpdateInfo | null;
  phase: UpdatePhase;
  progress: UpdateProgressPayload | null;
  error: string;
  /**
   * 本次运行内被忽略的版本。只活到进程结束：一次误点不该让人永久错过后续版本。
   * 存版本号而不是布尔值，这样忽略 0.9.0 之后发布的 0.9.1 仍然会出现。
   */
  dismissedVersion: string | null;
  /** 实际下载到的版本；清单在下载期间换代时，它是卡片该显示的那个。 */
  readyVersion: string | null;
  /** 最近一次检查完成的时间戳（ms），聚焦重查的限频依据。 */
  lastCheckedAt: number;

  setAvailable: (info: UpdateInfo | null) => void;
  dismissSession: () => void;
  setPhase: (phase: UpdatePhase) => void;
  setProgress: (progress: UpdateProgressPayload | null) => void;
  setError: (error: string) => void;
  setReadyVersion: (version: string) => void;
  markChecked: () => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  available: null,
  phase: "idle",
  progress: null,
  error: "",
  dismissedVersion: null,
  readyVersion: null,
  lastCheckedAt: 0,

  setAvailable: (available) =>
    set((state) => {
      // 清单换了版本，之前下载的包就不再对应当前卡片，作废。
      const versionChanged = available?.version !== state.available?.version;
      const readyVersion = versionChanged ? null : state.readyVersion;
      return {
        available,
        readyVersion,
        // 检查结束只负责把「检查中」收回去；已经下载好的包要保持 ready，
        // 否则打开帮助菜单查一次就会把人退回「立即更新」，让人再下一次 27 MB。
        phase: !available
          ? "idle"
          : state.phase === "checking"
            ? (readyVersion ? "ready" : "idle")
            : state.phase,
      };
    }),
  dismissSession: () =>
    set((state) => ({ dismissedVersion: state.available?.version ?? null })),
  setPhase: (phase) => set({ phase }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  setReadyVersion: (readyVersion) => set({ readyVersion }),
  markChecked: () => set({ lastCheckedAt: Date.now() }),
}));
