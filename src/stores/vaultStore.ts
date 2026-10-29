/**
 * Registered vault list state.
 *
 * Separate from `graphStore` on purpose: registering or removing a vault is a
 * settings action that must work before any graph exists, and the vault list is
 * the only thing `vaultService.listVaults()` produces. Mixing it into the graph
 * store would mean a failed scan wipes the vault list from the UI.
 *
 * `records` always reflects the whitelist Rust owns; nothing here is optimistic.
 * A registration that fails leaves the previous list untouched, which is what
 * makes the "folder is unavailable" error message trustworthy.
 */
import { create } from "zustand";
import type { VaultRecord } from "@/types/graph";

interface VaultState {
  records: VaultRecord[];
  loading: boolean;
  error: string | null;
  activeVaultKey: string | null;
  setRecords: (records: VaultRecord[]) => void;
  upsertRecord: (record: VaultRecord) => void;
  removeRecord: (key: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setActiveVaultKey: (key: string | null) => void;
  reset: () => void;
}

export const useVaultStore = create<VaultState>((set) => ({
  records: [],
  loading: false,
  error: null,
  activeVaultKey: null,

  setRecords: (records) =>
    set((state) => ({
      records,
      // 列表里已经没有 active 的那条时清掉，否则过滤条件会指向一个不存在的
      // vault，图看起来"空了"但没有任何提示。
      activeVaultKey:
        state.activeVaultKey && records.some((record) => record.key === state.activeVaultKey)
          ? state.activeVaultKey
          : null,
    })),

  // key 由规范化路径派生，所以同一个文件夹重复注册只会更新那一条。
  upsertRecord: (record) =>
    set((state) => {
      const index = state.records.findIndex((item) => item.key === record.key);
      if (index < 0) return { records: [...state.records, record] };
      const records = state.records.slice();
      records[index] = record;
      return { records };
    }),

  removeRecord: (key) =>
    set((state) => ({
      records: state.records.filter((record) => record.key !== key),
      activeVaultKey: state.activeVaultKey === key ? null : state.activeVaultKey,
    })),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setActiveVaultKey: (activeVaultKey) => set({ activeVaultKey }),
  reset: () => set({ records: [], loading: false, error: null, activeVaultKey: null }),
}));

/* -------------------------------------------------------------------------- */
/* Selectors                                                                   */
/* -------------------------------------------------------------------------- */

export const selectVaultRecords = (state: VaultState): VaultRecord[] => state.records;
export const selectVaultLoading = (state: VaultState): boolean => state.loading;
export const selectVaultError = (state: VaultState): string | null => state.error;
export const selectActiveVaultKey = (state: VaultState): string | null => state.activeVaultKey;

/** 启用中的 vault，供筛选面板使用。数组每次都会新建 —— 调用方要么缓存，
 *  要么在 `useMemo` 里包一层，不要直接当 selector 用。 */
export function enabledVaultRecords(records: readonly VaultRecord[]): VaultRecord[] {
  return records.filter((record) => record.enabled);
}
