/**
 * Filesystem seam for the graph index.
 *
 * The index store and the layout cache need six file operations, and they must
 * be runnable from a plain `node` script: the whole write/replay/compact logic
 * is exactly the part that has to be tested without a GUI, and a module that
 * imports `@tauri-apps/plugin-fs` at the top cannot be bundled for `node`.
 *
 * So the operations are declared as an interface, and two implementations are
 * provided:
 *
 * - `tauriGraphFs` — the real one, a thin wrapper over `@tauri-apps/plugin-fs`.
 * - `nodeGraphFs(root)` — `node:fs/promises`, with every path confined to
 *   `root` so a bug in a script cannot touch anything outside its temp
 *   directory.
 *
 * `node:fs/promises` and `node:path` are loaded through a variable specifier
 * with `@vite-ignore`, on purpose: a static (or even literal dynamic) import of
 * a `node:` builtin would make the renderer bundle fail to resolve it, and this
 * module is imported by the renderer.
 *
 * Choosing the implementation is a factory (`createGraphFs`), never a
 * module-level `isTauri()` snapshot: the check has to happen after the webview
 * exists, and a module-level constant would also make the two implementations
 * impossible to test side by side.
 */
import {
  exists as fsExists,
  mkdir as fsMkdir,
  readDir as fsReadDir,
  readTextFile as fsReadTextFile,
  remove as fsRemove,
  rename as fsRename,
  writeTextFile as fsWriteTextFile,
} from "@tauri-apps/plugin-fs";

export interface GraphFs {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string, opts?: { append?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** 删除文件；目录需 `recursive`。路径不存在时静默成功（幂等）。 */
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /**
   * 子项名字（不含路径）。§8.2 的分片要能被逐个枚举出来：`meta.json` 记着各分片
   * 的 counts，但如果只靠 meta 当目录索引，一次「写完分片、还没写 meta」的崩溃
   * 就会留下看不见的孤儿分片。
   */
  readDir(path: string): Promise<string[]>;
}

/** Tauri 运行时里的实现。`append` 由 plugin-fs 的 `WriteFileOptions` 支持。 */
export const tauriGraphFs: GraphFs = {
  readTextFile: (path) => fsReadTextFile(path),
  writeTextFile: (path, data, opts) =>
    fsWriteTextFile(path, data, opts?.append ? { append: true } : undefined),
  exists: (path) => fsExists(path),
  mkdir: (path, opts) => fsMkdir(path, { recursive: opts?.recursive ?? true }),
  remove: async (path, opts) => {
    try {
      await fsRemove(path, { recursive: opts?.recursive ?? false });
    } catch (error) {
      // 幂等：目标已经不在了就当成功，否则原样抛出（权限问题不能被吞掉）。
      if (await fsExists(path)) throw error;
    }
  },
  rename: (from, to) => fsRename(from, to),
  // plugin-fs 返回 `DirEntry[]`；这一层只暴露名字，调用方拼路径，别的实现也好写。
  readDir: async (path) => (await fsReadDir(path)).map((entry) => entry.name),
};

/* -------------------------------------------------------------------------- */
/* Node implementation (scripts only)                                          */
/* -------------------------------------------------------------------------- */

/** 只声明用到的那几个方法，避免为 renderer 引入 `@types/node`。 */
interface NodeFsPromises {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  appendFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  access(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

interface NodePath {
  resolve(...parts: string[]): string;
  sep: string;
}

interface NodeModules {
  fs: NodeFsPromises;
  path: NodePath;
}

let nodeModules: Promise<NodeModules> | null = null;

function loadNodeModules(): Promise<NodeModules> {
  if (!nodeModules) {
    const fsSpecifier = "node:fs/promises";
    const pathSpecifier = "node:path";
    nodeModules = Promise.all([
      import(/* @vite-ignore */ fsSpecifier),
      import(/* @vite-ignore */ pathSpecifier),
    ]).then(([fsModule, pathModule]) => {
      const fsNamespace = fsModule as unknown as { default?: NodeFsPromises };
      const pathNamespace = pathModule as unknown as { default?: NodePath };
      return {
        fs: fsNamespace.default ?? (fsModule as unknown as NodeFsPromises),
        path: pathNamespace.default ?? (pathModule as unknown as NodePath),
      };
    });
  }
  return nodeModules;
}

/**
 * `node:fs/promises` 实现，所有路径被限制在 `root` 内。
 *
 * 限制不是装饰：脚本会按 store 传下来的路径写文件，而 store 的路径来自
 * `joinPath`，一个手误的 `..` 就该在脚本里当场炸掉，而不是往仓库里写垃圾。
 */
export function nodeGraphFs(root: string): GraphFs {
  const guard = async (target: string): Promise<string> => {
    const { path } = await loadNodeModules();
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) {
      throw new Error(`path escapes the script sandbox: ${target}`);
    }
    return resolvedTarget;
  };

  return {
    async readTextFile(path) {
      const { fs } = await loadNodeModules();
      return fs.readFile(await guard(path), "utf8");
    },
    async writeTextFile(path, data, opts) {
      const { fs } = await loadNodeModules();
      const target = await guard(path);
      if (opts?.append) await fs.appendFile(target, data, "utf8");
      else await fs.writeFile(target, data, "utf8");
    },
    async exists(path) {
      const { fs } = await loadNodeModules();
      try {
        await fs.access(await guard(path));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(path, opts) {
      const { fs } = await loadNodeModules();
      await fs.mkdir(await guard(path), { recursive: opts?.recursive ?? true });
    },
    async remove(path, opts) {
      const { fs } = await loadNodeModules();
      await fs.rm(await guard(path), { recursive: opts?.recursive ?? false, force: true });
    },
    async rename(from, to) {
      const { fs } = await loadNodeModules();
      await fs.rename(await guard(from), await guard(to));
    },
    async readDir(path) {
      const { fs } = await loadNodeModules();
      return fs.readdir(await guard(path));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Runtime selection                                                          */
/* -------------------------------------------------------------------------- */

/** Tauri v2 在每个 webview 上都挂 `__TAURI_INTERNALS__`；node 里没有 window。 */
export function isTauriRuntime(): boolean {
  const scope = globalThis as {
    __TAURI_INTERNALS__?: unknown;
    window?: { __TAURI_INTERNALS__?: unknown };
  };
  if (typeof scope.__TAURI_INTERNALS__ !== "undefined") return true;
  return typeof scope.window?.__TAURI_INTERNALS__ !== "undefined";
}

/**
 * 应用里用的工厂。脚本**不要**调这个：它们的 `root` 是临时目录，必须显式走
 * `nodeGraphFs(tmp)`，否则会拿到一个要么抛错、要么写进真实数据目录的实现。
 */
export function createGraphFs(): GraphFs {
  if (!isTauriRuntime()) {
    throw new Error("createGraphFs() needs the Tauri runtime; scripts must use nodeGraphFs(root)");
  }
  return tauriGraphFs;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Join path segments with `/`.
 *
 * Deliberately not `@tauri-apps/api/path`'s `join`: that one is async and only
 * exists inside Tauri, while the store and the scripts both build paths. `/`
 * works on Windows for `node:fs`, for plugin-fs and for the Rust side (which
 * normalises), so a plain string join is the portable choice.
 */
export function joinPath(...segments: readonly string[]): string {
  const parts = segments.filter((segment) => segment.length > 0);
  if (parts.length === 0) return "";
  let joined = parts[0].replace(/[\\/]+$/, "");
  for (const part of parts.slice(1)) {
    joined += `/${part.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "")}`;
  }
  return joined;
}
