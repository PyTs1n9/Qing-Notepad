/**
 * Node ids and content fingerprints.
 *
 * The design document specifies `sha256(...)[0..16]` for both the vault node id
 * and the dangling node id. The renderer cannot use it: `crypto.subtle.digest`
 * is asynchronous, while ids have to be produced inside a synchronous walk over
 * 5000 files (and inside `Map` keys that are built in one pass). So this module
 * uses **64-bit FNV-1a** instead — synchronous, dependency-free, and emitting
 * the same 16 lowercase hex characters. That is the one and only place this
 * module deviates from the document's signatures, and the character set and
 * length stay identical, so `NOTE_ID_PATTERN` still holds:
 *
 *   vault    → "v-<vaultKey8>-<hash16>"   27 chars (document says 26; the
 *                                          arithmetic in §3.2.1 forgot the
 *                                          second dash)
 *   dangling → "d-<hash16>"               18 chars
 *   native   → "n-<uuid>"                 38 chars
 *
 * FNV-1a is not a cryptographic hash. That is fine for both uses: the id only
 * has to be stable and collision-resistant enough to separate file paths inside
 * one vault, and `contentHash` is used for rename pairing (§3.4.3), never for
 * content addressing or deduplication.
 */

/** 64-bit FNV-1a offset basis and prime. */
const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** §3.4.3: "前 512 字节 + 长度". Enough to tell two files apart, cheap enough to
 *  run during a startup scan over 20 MB of notes. */
export const CONTENT_HASH_PREFIX_BYTES = 512;

const encoder = new TextEncoder();

/** UTF-8 bytes without allocating through Buffer (browser and Node both have
 *  `TextEncoder`; the renderer bundle must not depend on Node built-ins). */
export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/** 64-bit FNV-1a over a byte range, as 16 lowercase hex characters. */
export function fnv1a64Bytes(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (let index = start; index < end; index += 1) {
    hash ^= BigInt(bytes[index]);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** 64-bit FNV-1a over the UTF-8 bytes of a string. */
export function fnv1a64Hex(value: string): string {
  return fnv1a64Bytes(utf8Bytes(value));
}

/**
 * Vault node id. `vaultKey` is the 8-hex key the Rust side derives from the
 * vault's normalised absolute path, so a node id survives a restart and is
 * unique across vaults without a global counter.
 */
export function vaultNodeId(vaultKey: string, relPath: string): string {
  return `v-${vaultKey.slice(0, 8)}-${fnv1a64Hex(relPath)}`;
}

/**
 * Dangling (unresolved) node id. The key is the *normalised* target, so
 * `[[笔记]]`, `[[笔记.md]]` and `[[ 笔记 ]]` all land on one dashed node instead
 * of three.
 */
export function danglingNodeId(normalizedTarget: string): string {
  return `d-${fnv1a64Hex(normalizedTarget)}`;
}

/** Native note id, matching `Note.id` verbatim. */
export function nativeNodeId(noteId: string): string {
  return `n-${noteId}`;
}

/**
 * `contentHash` for rename pairing: FNV-1a over the first 512 UTF-8 bytes, plus
 * the total byte length. Two files that differ only after byte 512 still get
 * different hashes whenever their lengths differ; identical copies collide on
 * purpose (that is the signal §3.4.3 uses, and an ambiguous match is explicitly
 * *not* guessed there).
 */
export function contentHashOf(body: string): string {
  const bytes = utf8Bytes(body);
  const head = Math.min(bytes.length, CONTENT_HASH_PREFIX_BYTES);
  return `${fnv1a64Bytes(bytes, 0, head)}-${bytes.length.toString(16)}`;
}
