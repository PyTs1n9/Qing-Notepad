/**
 * Atomic file writes for the Tauri host.
 *
 * `writeTextFile(target, …)` truncates the target first, so a crash / power loss
 * / disk-full between truncate and flush leaves a zero-byte or half-written file.
 * The safe shape is: write a sibling temp file, then `rename` it over the target
 * — rename is atomic, so a reader sees either the whole old file or the whole new
 * one. `storage.ts:1004` already does this for the note index; this module lifts
 * that sequence out so new call sites do not re-derive it *and* do not import
 * `@/stores/**` the way `storage.ts` does. Only the host layer
 * (`@tauri-apps/plugin-fs`) may be reached from here.
 *
 * One deliberate divergence from `storage.ts:1005-1014`: that branch falls back to
 * `remove(target)` then `rename(temp, target)`, which **deletes the old file
 * before the replacement is known to succeed**. If the second rename also fails
 * (disk full, permission change mid-write) the user's previous contents are gone.
 * For a note app that is unacceptable, so the fallback here moves the old file
 * aside to a backup, retries, and rolls the backup back on failure. Same common
 * path, non-destructive worst case.
 */
import {
  exists,
  remove,
  rename,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

/** Suffix of the sibling temp file. `.tmp` is what `storage.ts` already uses. */
const TEMP_EXTENSION = "tmp";

/** Suffix of the rollback copy of the target, used only by the fallback path. */
const BACKUP_EXTENSION = "bak";

interface SplitPath {
  /** Everything up to and including the final separator ("" for a bare name). */
  dirPrefix: string;
  /** The final path segment. */
  fileName: string;
}

/**
 * Splits a host path without the async `@tauri-apps/api/path` helpers.
 *
 * `join`/`dirname` are async IPC calls on Tauri, which would triple the round
 * trips of every write. Both separators are handled because the host may hand
 * back either: `C:\Users\…` on Windows, `/data/…` elsewhere. Keeping the
 * original separator is what makes the temp file a true sibling.
 */
function splitPath(path: string): SplitPath {
  let separatorIndex = -1;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const char = path[i];
    if (char === "/" || char === "\\") {
      separatorIndex = i;
      break;
    }
  }
  if (separatorIndex < 0) return { dirPrefix: "", fileName: path };
  return {
    dirPrefix: path.slice(0, separatorIndex + 1),
    fileName: path.slice(separatorIndex + 1),
  };
}

/**
 * Unique per call, so two concurrent writers targeting the same file can never
 * collide on the same temp path (same reasoning as `storage.ts:989-994`).
 */
function uniqueSuffix(): string {
  const hostCrypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (typeof hostCrypto?.randomUUID === "function") {
    return hostCrypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Renames temp over target, tolerating filesystems that refuse to replace.
 *
 * On Windows `rename` is `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, so the target
 * never disappears even for an instant — the happy path is a single call.
 *
 * The fallback is where this differs from `src/utils/storage.ts:1005-1014`. That
 * branch does `remove(target)` and retries; if the retry fails, the previous file
 * is already gone. Here the old file is *moved aside* instead, and moved back if
 * the retry fails, so a failed write can only ever cost the new contents.
 */
async function renameIntoPlace(
  tempPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await rename(tempPath, targetPath);
    return;
  } catch (firstError) {
    // No previous contents to protect: retry once anyway. This branch covers the
    // highest-traffic path in the app — the *first* save of a brand-new note, where
    // the target does not exist yet — and a single transient lock (indexer, AV
    // scanner, another writer) must not make that note impossible to save.
    // Retrying here matches the behaviour the old `storage.ts` branch had.
    if (!(await exists(targetPath))) {
      try {
        await rename(tempPath, targetPath);
        return;
      } catch {
        // Report the *first* error: the second one is usually the same cause
        // repeated, and swapping them would lose the original information.
        throw firstError;
      }
    }

    // Unique per call, so two concurrent writers cannot overwrite each other's
    // backup and roll back to the wrong contents.
    const backupPath = `${targetPath}.${uniqueSuffix()}.${BACKUP_EXTENSION}`;
    try {
      await rename(targetPath, backupPath);
    } catch {
      // Could not even move the old file aside (read-only volume, locked file).
      // Leave the target untouched and report the original failure.
      throw firstError;
    }

    try {
      await rename(tempPath, targetPath);
    } catch (secondError) {
      try {
        await rename(backupPath, targetPath);
      } catch (restoreError) {
        // Worst case: the previous contents survive, but under the backup name.
        console.error(
          `writeFileAtomic: failed to restore target, previous contents kept at ${backupPath}:`,
          restoreError,
        );
      }
      throw secondError;
    }

    // Committed. A leftover backup is garbage, not data loss, so it must not fail
    // a write that already succeeded.
    try {
      await remove(backupPath);
    } catch (cleanupError) {
      console.error("writeFileAtomic: failed to remove backup file:", cleanupError);
    }
  }
}

/**
 * Writes `contents` to `path` atomically (temp file in the same directory, then
 * rename). Throws on any failure; a failed write never leaves the target
 * truncated.
 *
 * The temp file must live in the target's own directory: renaming across a
 * volume boundary fails outright on both Windows and POSIX.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("writeFileAtomic: path must be a non-empty string");
  }
  const { dirPrefix, fileName } = splitPath(path);
  if (fileName.length === 0) {
    throw new Error(`writeFileAtomic: "${path}" does not name a file`);
  }
  const tempPath = `${dirPrefix}${fileName}.${uniqueSuffix()}.${TEMP_EXTENSION}`;

  try {
    if (typeof contents === "string") {
      await writeTextFile(tempPath, contents);
    } else {
      // `writeFile` is the binary entry point of `@tauri-apps/plugin-fs`.
      await writeFile(tempPath, contents);
    }
    await renameIntoPlace(tempPath, path);
  } catch (error) {
    // Never swallow: the caller decides whether a failed save is fatal. The
    // cleanup runs in its own try/catch so a failing cleanup cannot mask the
    // original error — the caller must still see why the write failed.
    try {
      if (await exists(tempPath)) await remove(tempPath);
    } catch (cleanupError) {
      console.error("writeFileAtomic: failed to clean temp file:", cleanupError);
    }
    throw error;
  }
}

/**
 * JSON variant: pretty-printed (2 spaces, matching the rest of the on-disk
 * payloads) then written atomically.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== "string") {
    throw new Error("writeJsonAtomic: value is not JSON-serialisable");
  }
  await writeFileAtomic(path, text);
}
