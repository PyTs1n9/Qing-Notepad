/**
 * Typed wrappers around the five Rust vault commands, plus the change-event
 * subscription.
 *
 * This module is the renderer's only doorway to a vault folder. §2.1 forbids the
 * renderer from holding an `fs` scope for a user folder, so a bug here is not a
 * cosmetic bug: `paths` must always be vault-relative (`/` separated), because
 * the Rust side re-validates every one of them against the whitelisted root and
 * rejects anything that escapes it.
 *
 * Two hard limits come from the Rust side and are enforced here instead of being
 * discovered in production:
 *
 * - `vault_read_file` refuses a batch larger than 200 paths, so `readFiles`
 *   chunks internally. Callers pass the whole file list.
 * - every command fails with a plain string; it is wrapped into
 *   `VaultCommandError` so the UI can tell "this folder is gone" from "the IPC
 *   bridge is broken" without pattern-matching Chinese error text.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  VaultChangedPayload,
  VaultFileContent,
  VaultRecord,
  VaultScanResult,
} from "@/types/graph";

/** Must match `CHANGE_EVENT` in `src-tauri/src/vault.rs`. */
export const VAULT_CHANGE_EVENT = "vault://changed";

/** Must match `MAX_BATCH_FILES` in `src-tauri/src/vault.rs`. */
export const READ_BATCH_LIMIT = 200;

export type VaultOperation = "list" | "register" | "remove" | "scan" | "readFiles";

/**
 * A failed vault command.
 *
 * `message` always names the operation, because the raw Rust string is
 * actionable but anonymous ("unknown vault: 1a2b3c4d" tells a developer nothing
 * about which call produced it), and the alternative — logging at each call
 * site — leaves nothing for the error toast to show.
 */
export class VaultCommandError extends Error {
  readonly operation: VaultOperation;
  readonly detail: string;

  constructor(operation: VaultOperation, detail: string) {
    super(`vault ${operation} failed: ${detail}`);
    this.name = "VaultCommandError";
    this.operation = operation;
    this.detail = detail;
  }
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runCommand<T>(
  operation: VaultOperation,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new VaultCommandError(operation, describeError(error));
  }
}

/** 把任意长度的路径列表切成 Rust 能接受的批次（每批 ≤ 200）。 */
export function chunkPaths(
  paths: readonly string[],
  size: number = READ_BATCH_LIMIT,
): string[][] {
  const limit = Math.max(1, Math.floor(size));
  const batches: string[][] = [];
  for (let index = 0; index < paths.length; index += limit) {
    batches.push(paths.slice(index, index + limit));
  }
  return batches;
}

/** 已注册的 vault 列表。某条根不可用（拔盘）时整条命令会失败，不静默跳过。 */
export function listVaults(): Promise<VaultRecord[]> {
  return runCommand<VaultRecord[]>("list", "vault_list");
}

/** 注册（或重新启用）一个文件夹。key 由规范化路径派生，同一路径永远同一 key。 */
export function registerVault(root: string): Promise<VaultRecord> {
  return runCommand<VaultRecord>("register", "vault_register", { root });
}

/** 从白名单移除。vault 目录里的文件一个都不动。 */
export function removeVault(key: string): Promise<void> {
  return runCommand<void>("remove", "vault_remove", { key });
}

/**
 * 递归扫描一个 vault。
 *
 * 没有 `full` 参数：Rust 侧永远返回全量 stamps，增量由调用方拿上一轮的
 * `FileStamp[]` 比对（T01 定案 —— diff 留在 renderer）。`full` 只影响调用方
 * 是否丢掉旧 stamps，不影响这条命令。
 */
export function scanVault(key: string): Promise<VaultScanResult> {
  return runCommand<VaultScanResult>("scan", "vault_scan", { key });
}

/**
 * 批量读正文，自动按 200 分批。
 *
 * 返回值与 `paths` 一一对应且顺序一致；单个文件读失败只会让那一项的
 * `text` 为 null 并带 `skipped` 原因，整批不会失败。
 */
export async function readVaultFiles(
  key: string,
  paths: readonly string[],
): Promise<VaultFileContent[]> {
  const contents: VaultFileContent[] = [];
  for (const batch of chunkPaths(paths)) {
    const part = await runCommand<VaultFileContent[]>("readFiles", "vault_read_file", {
      key,
      paths: batch,
    });
    contents.push(...part);
  }
  return contents;
}

/**
 * Subscribe to `vault://changed`.
 *
 * The payload already carries everything the incremental pipeline needs, but the
 * pipeline itself belongs to the next batch, so this function only forwards the
 * payload. TODO(T04): `graphIndexer.ingestVaultChanges({ vaultKey, changed,
 * full })` is the function that consumes it — it is the single write entry point
 * of the graph index (see §3.2.4 boundary 1), so this subscription must never
 * touch the store directly.
 *
 * It also guarantees that unsubscribing before the IPC `listen` promise settles
 * still releases the listener — otherwise a component that mounts and unmounts
 * quickly leaks one listener per mount.
 */
export function subscribeVaultChanges(
  handler: (payload: VaultChangedPayload) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let disposed = false;

  void listen<VaultChangedPayload>(VAULT_CHANGE_EVENT, (event) => {
    handler(event.payload);
  })
    .then((release) => {
      if (disposed) release();
      else unlisten = release;
    })
    .catch((error: unknown) => {
      console.error("[graph] cannot subscribe to vault changes:", error);
    });

  return () => {
    disposed = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}
