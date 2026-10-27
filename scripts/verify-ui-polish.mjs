/**
 * UI-polish audit: the parts of `docs/prompt-ui-polish.md` that can be asserted
 * statically.
 *
 * What a rendered window *looks* like, how a hover wave feels and whether the
 * first frame still flashes can only be judged by the project owner on a
 * machine with a desktop session; those are deliberately absent here and listed
 * in the batch report as "待人工确认".
 *
 *   npm run verify:ui-polish
 *
 * Groups map 1:1 to the prompt's batch items (P0-1 … P2-3).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const css = read("src/index.css");

let failed = 0;
const results = [];

function check(id, label, fn) {
  let detail = "";
  let ok = false;
  try {
    const out = fn();
    // `true`/`undefined` mean pass; a returned string is a pass with a detail
    // note; only `false` is a failure.
    ok = out !== false;
    if (typeof out === "string") detail = out;
  } catch (error) {
    detail = error.message;
  }
  if (!ok) failed += 1;
  results.push({ id, label, ok, detail });
}

/** Every .tsx/.ts under src, with its source. */
function sources(dir = path.join(root, "src")) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name))
      out.push({
        file: path.relative(root, full).replace(/\\/g, "/"),
        text: fs.readFileSync(full, "utf8"),
      });
  }
  return out;
}
const all = sources();

// ---------------------------------------------------------------- P0-1
check("P0-1a", "@theme 定义四个 on-* 前景色", () => {
  // Sliced to the closing brace rather than a fixed 2000-character window: the
  // block grew past that after the accent-text comment was added, which pushed
  // the last declaration out of range and failed a sheet that was correct.
  const start = css.indexOf("@theme {");
  const theme = css.slice(start, css.indexOf("}", start));
  for (const kind of ["accent", "success", "danger", "warning"]) {
    if (!new RegExp(`--color-on-${kind}:\\s*#[0-9a-f]{6}`, "i").test(theme)) {
      throw new Error(`@theme 缺少 --color-on-${kind}`);
    }
  }
  return true;
});

check("P0-1b", "四个主题各自覆盖四个 on-* 前景色", () => {
  for (const theme of ["blue", "dark", "yellow", "green"]) {
    const start = css.indexOf(`.theme-${theme} {`);
    const body = css.slice(start, css.indexOf("}", start));
    for (const kind of ["accent", "success", "danger", "warning"]) {
      if (!body.includes(`--color-on-${kind}:`)) throw new Error(`.theme-${theme} 缺少 --color-on-${kind}`);
    }
  }
  return true;
});

check("P0-1c", "剩余的 text-white 都已归类（非主题色块）", () => {
  // Every surviving `text-white` must sit on a background that is not one of the
  // four themed blocks: hard-coded amber, a black overlay scrim or a runtime
  // avatar colour. The warning blocks moved to `text-on-warning`, so the two
  // workspace sidebar sites and the transfer-ownership button are gone from
  // this list - leaving them listed would make the audit fail *after* the fix.
  const allowed = {
    "src/components/AI/AiSidebar.tsx": 2, // bg-amber-500/90
    "src/components/Settings/AvatarCropper.tsx": 1, // bg-black/55 scrim
    "src/components/Workspace/CloudNoteEditor.tsx": 2, // style={{ backgroundColor: user.color }}
  };
  const found = {};
  for (const { file, text } of all) {
    const n = (text.match(/\btext-white\b/g) ?? []).length;
    if (n) found[file] = n;
  }
  for (const [file, n] of Object.entries(found)) {
    if (allowed[file] !== n) throw new Error(`${file}: ${n} 处 text-white，清单里登记的是 ${allowed[file] ?? 0}`);
  }
  return `${Object.keys(found).length} 个文件保留 text-white（均为非主题色块）`;
});

check("P0-1d", "text-on-* 已覆盖所有主题色块", () => {
  let n = 0;
  for (const { text } of all) n += (text.match(/\btext-on-(accent|success|danger|warning)\b/g) ?? []).length;
  if (n < 40) throw new Error(`只找到 ${n} 处，提示词估算约 40 处`);
  return `${n} 处`;
});

// ---------------------------------------------------------------- P0-2
check("P0-2", "全局焦点环 + 滚动容器负 offset", () => {
  if (!/:where\(button, a, input, textarea, select, \[role="treeitem"\], \[tabindex\]\):focus-visible/.test(css)) {
    throw new Error("缺少全局 :focus-visible 规则");
  }
  if (!css.includes("outline-offset: -2px")) throw new Error("缺少负 offset 覆盖");
  for (const keep of [".canvas-switcher-create:focus-within::after", ".sticky-mode .sticky-content:focus"]) {
    if (!css.includes(keep)) throw new Error(`既有焦点样式被破坏：${keep}`);
  }
  return true;
});

// ---------------------------------------------------------------- P0-3
check("P0-3", "启动底色：命令 + setup 读取 + 前端只写变化值", () => {
  if (!read("src-tauri/src/lib.rs").includes("window_bg::apply_persisted")) throw new Error("setup 未读取持久化底色");
  if (!read("src-tauri/src/lib.rs").includes("window_bg::set_window_background")) throw new Error("命令未注册");
  const app = read("src/App.tsx");
  if (!app.includes('invoke("set_window_background"')) throw new Error("前端未调用");
  if (!app.includes("hex === windowBgRef.current")) throw new Error("缺少「只在变化时调用」的保护");
  const rust = read("src-tauri/src/window_bg.rs");
  if (!rust.includes("set_background_color")) throw new Error("未调用原生 API");
  return true;
});

// ---------------------------------------------------------------- P1-1
check("P1-1", "双层阴影 + 暗底内高光 + 拖拽期降级", () => {
  const box = css.slice(css.indexOf(".shell-box {"), css.indexOf(".shell-box {") + 600);
  if ((box.match(/color-mix\(in srgb, #000/g) ?? []).length < 2) throw new Error("shell-box 不是双层阴影");
  if (!/\.theme-dark \.shell-box\s*{[^}]*inset 0 1px/.test(css.replace(/\n/g, " "))) throw new Error("暗色主题缺少 inset 高光");
  if (!css.includes(".app-root.sidebar-resizing .shell-box")) throw new Error("拖拽期降级被删除");
  return true;
});

// ---------------------------------------------------------------- P1-2
check("P1-2", "纸纹只画在 ::before，且仅在无壁纸时启用", () => {
  const before = css.slice(css.indexOf(".surface-glass::before {"), css.indexOf(".surface-glass--editor {"));
  if (!before.includes("background-color:")) throw new Error("::before 的 tint 被吃掉");
  if (!before.includes("background-image: var(--paper-grain)")) throw new Error("纸纹没有落在 ::before");
  if (!before.includes("backdrop-filter")) throw new Error("磨砂层被移走");
  if (!css.includes(".app-root.app-has-custom-background .surface-glass::before")) throw new Error("壁纸下未关闭纸纹");
  const glassOff = css.slice(css.indexOf('[data-glass="off"]'), css.indexOf('[data-glass="off"]') + 300);
  if (glassOff.includes("background-image")) throw new Error("磨砂关闭时误删纸纹");
  if (!/\.theme-dark\s*{[^}]*--paper-grain:/s.test(css)) throw new Error("暗色纸纹变体缺失");
  return true;
});

// ---------------------------------------------------------------- P1-3
check("P1-3", "品牌字体自托管且 ≤ 60 KiB", () => {
  const dir = path.join(root, "public", "fonts");
  const files = fs.readdirSync(dir).filter((f) => /\.(woff2?|ttf|otf)$/.test(f));
  if (!files.length) throw new Error("public/fonts 下没有字体文件");
  const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  if (bytes > 60 * 1024) throw new Error(`字体合计 ${(bytes / 1024).toFixed(1)} KiB，超出 60 KiB 闸门`);
  if (/url\(["']?https?:/.test(css)) throw new Error("出现了 CDN 外链字体");
  if (!css.includes("@font-face")) throw new Error("缺少 @font-face");
  if (!css.includes(".brand-face")) throw new Error("缺少品牌字体类");
  return `${(bytes / 1024).toFixed(1)} KiB`;
});

// ---------------------------------------------------------------- P1-4
check("P1-4", "ActivityBar 单一胶囊 + 顶部按钮 h-10", () => {
  const bar = read("src/components/Layout/ActivityBar.tsx");
  const layoutIds = (bar.match(/layoutId=\{?"?[a-z-]+"?\}?/g) ?? []).length;
  if (layoutIds !== 1) throw new Error(`layoutId 出现 ${layoutIds} 次，应只有一个滑动指示器`);
  // `h-11` may legitimately survive in a comment explaining the old height;
  // only a real utility class counts.
  const classNames = bar.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? [];
  if (classNames.some((c) => /\bh-11\b/.test(c))) throw new Error("仍有按钮使用 h-11");
  // Four of the five literals are inside a `.map`, so the count of source
  // occurrences is smaller than the number of rendered buttons: assert every
  // button class uses h-10 and no competing button height survives.
  if ((bar.match(/\bh-10\b/g) ?? []).length < 5) throw new Error("按钮高度没有统一为 h-10");
  if (classNames.some((c) => /\bh-(?:8|9|11|12)\b/.test(c))) throw new Error("仍有按钮使用其它高度");
  if (!bar.includes("useReducedMotion")) throw new Error("缺少 reduced-motion 分支");
  if (!bar.includes("aria-current")) throw new Error("aria-current 语义丢失");
  return true;
});

// ---------------------------------------------------------------- P1-5
check("P1-5", "标题波浪：错峰 + 降幅 + reduced-motion", () => {
  const bar = read("src/components/Layout/TitleBar.tsx");
  if (!bar.includes("transitionDelay: `${index * 12}ms`")) throw new Error("缺少错峰延迟");
  const letter = css.slice(css.indexOf(".title-brand-letter {"), css.indexOf(".note-tab-bar {"));
  if (!letter.includes("translateY(-1px) scale(1.1)")) throw new Error("幅度不是 -1px / 1.1");
  if (!/prefers-reduced-motion: reduce\)\s*{\s*\.title-brand-letter/.test(letter)) throw new Error("缺少 reduced-motion 分支");
  if (!letter.includes("color var(--dur-fast)")) throw new Error("颜色过渡丢失");
  return true;
});

// ---------------------------------------------------------------- P2-1
check("P2-1", "动效曲线收敛：只允许 token 定义里出现 cubic-bezier", () => {
  const lines = css.split("\n");
  const offenders = lines
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => line.includes("cubic-bezier(") && !/--ease-[a-z-]+:/.test(line));
  if (offenders.length) throw new Error(offenders.map((o) => `index.css:${o.i}`).join(", "));
  for (const token of ["--ease-out", "--ease-spring", "--ease-in-out", "--dur-fast", "--dur-base", "--dur-slow"]) {
    if (!css.includes(`${token}:`)) throw new Error(`缺少 ${token}`);
  }
  return `0 处手写曲线，${(css.match(/var\(--ease-/g) ?? []).length} 处引用 token`;
});

// ---------------------------------------------------------------- P2-2
check("P2-2", "EmptyState 组件与四个接入点", () => {
  const file = "src/components/Layout/EmptyState.tsx";
  const src = read(file);
  for (const prop of ["icon", "title", "description", "hint", "action"]) {
    if (!new RegExp(`\\b${prop}\\??:`).test(src)) throw new Error(`EmptyStateProps 缺少 ${prop}`);
  }
  const users = all.filter((s) => s.file !== file && /<EmptyState/.test(s.text)).map((s) => s.file);
  if (users.length < 3) throw new Error(`只有 ${users.length} 个接入点，需要笔记树 / Todo / 回收站`);
  for (const key of ["searchNoResults", "searchNoResultsHint"]) {
    if ((read("src/utils/i18n.ts").match(new RegExp(`${key}:`, "g")) ?? []).length < 3) {
      throw new Error(`${key} 没有补齐中英 key`);
    }
  }
  return users.join(", ");
});

// ---------------------------------------------------------------- P2-3
check("P2-3", "滚动条：兜底进 @supports，伪元素重写", () => {
  const supports = css.slice(css.indexOf("@supports not selector(::-webkit-scrollbar)"), css.indexOf("::-webkit-scrollbar {"));
  if (!supports.includes("scrollbar-width: thin")) throw new Error("scrollbar-width 没有隔离进 @supports");
  // The universal selector may only carry `scrollbar-width` inside the
  // @supports block, so that block is cut out before looking for stray ones.
  const withoutSupports = css.replace(/@supports not selector\(::-webkit-scrollbar\)\s*{[\s\S]*?}\s*}/, "");
  if (/\*\s*{[^}]*scrollbar-width/s.test(withoutSupports)) {
    throw new Error("* 上仍直接声明 scrollbar-width");
  }
  const thumb = css.slice(css.indexOf("::-webkit-scrollbar-thumb {"), css.indexOf("::-webkit-scrollbar-thumb {") + 260);
  if (!thumb.includes("45%")) throw new Error("默认 thumb 不是 45%");
  if (!thumb.includes("border-radius: 3px")) throw new Error("thumb 圆角不是 3px");
  if (!thumb.includes("background-color var(--dur-fast)")) throw new Error("缺少过渡");
  if (!/:hover::-webkit-scrollbar-thumb/.test(css)) throw new Error("缺少容器 hover 加深");
  if (!/::-webkit-scrollbar {\s*width: 6px;\s*height: 6px;/.test(css)) throw new Error("宽度不是 6px");
  return true;
});

// ---------------------------------------------------------------- 侧栏拖动条
check("SEAM", "拖动条：默认不可见 / 悬停高光 / 拖动加宽发光", () => {
  const line = css.slice(css.indexOf(".seam-line {"), css.indexOf(".seam-line {") + 700);
  if (!/linear-gradient/.test(line)) throw new Error("分隔线不是两端淡出的渐变");
  if (!/opacity: 0;/.test(line)) throw new Error("默认态没有隐藏");
  if (!/width: 2px/.test(line)) throw new Error("线宽不是 2px");
  if (!/\.seam:hover \.seam-line\s*{\s*opacity: 1;/.test(css)) throw new Error("悬停态没有高光");
  if (!/\.seam\[data-dragging="true"\] \.seam-line\s*{[^}]*scaleX\(1\.5\)/s.test(css)) {
    throw new Error("拖动态没有加宽");
  }
  if (!/\.seam::after\s*{[^}]*left: -4px/s.test(css)) throw new Error("缺少 14px 指针热区");
  const seamBlock = css
    .slice(css.indexOf(".seam-line {"), css.indexOf(".sidebar-resizing .sidebar-width-shell"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (/filter:\s*blur/.test(seamBlock)) throw new Error("拖动条回到了 filter: blur（每帧重绘全高）");
  if (!/prefers-reduced-motion: reduce\)\s*{\s*\.seam-line/s.test(css)) throw new Error("缺少 reduced-motion 分支");
  return true;
});

// ---------------------------------------------------------------- output
const pad = (v, n) => String(v).padEnd(n);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.id, 7)}${r.label}${r.detail ? `  → ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
