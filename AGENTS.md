# AGENTS.md

This file helps AI coding agents quickly understand and work safely in this repository.

## Project Overview

Qing Notepad is a Windows desktop app built with **Tauri v2 + React 19 + TypeScript**.

Core features:
- **Todo List**: CRUD, inline editing, drag reorder, three priority levels, status and priority filters.
- **Rich Text Notes**: TipTap WYSIWYG editor, Markdown source mode, split preview, import/export.
- **Sticky/Tile Windows**: independent always-on-top note windows created through Tauri webview windows.
- **Theme System**: dark/blue/yellow/green presets, custom palette, up to 5 saved custom presets.
- **i18n**: Chinese/English UI strings through a typed translation table.
- **System Integration**: custom title bar, tray icon, hide-to-tray close behavior, global shortcut.

## Session Workflow (Required)

Every conversation in this repo runs two skills, in this order. This is a standing
project convention, not a one-off preference.

### 1. `grill` — clarify before acting

- Open the work round with the `grill` skill before any non-trivial implementation.
- Ask for intensity first (浅问 / 常规 / 细问 / 深挖 / 拷打) unless the user already stated it.
- Ask in rounds; every question uses the `❓ Q1｜标题` / `➡️ 建议` format. Only ask what the
  current round has enough context for; defer dependent questions to the next round.
- Ask about goals, constraints, trade-offs and default assumptions — not about facts that can
  be verified directly in the repo or on official sites.
- When a decision log is wanted, create or append to `docs/decisions-<topic>.md` with
  "结论 + 理由" entries plus an open-questions list.
- Close with 已确定 / 暂未确定 / 下一步 and wait for confirmation before significant execution.
- Skip it only for pure lookups, single-line typo fixes, or when the user explicitly says to
  skip questioning and act directly.

### 2. `architect` — choose the stack deliberately

- Run the `architect` skill whenever the work involves a technical choice: a new dependency or
  library, storage/persistence layer, state or sync model, hosting, deployment, or build tooling.
- Read existing `docs/decisions-*.md` first and reuse settled conclusions instead of re-litigating them.
- Produce two or three options using the fixed template (技术栈 / 为什么适合 / 开发难度 / 维护成本 /
  目标地区可用性 / 你得自己管的东西 / 主要风险), ordered by boring-technology preference, then
  state `推荐：方案 X` plus the deciding reason.
- Verify pricing, quotas, regional availability and official support on current official pages;
  never quote remembered numbers.
- After the user picks, append the option and reason to `docs/decisions-<topic>.md`.

### Ordering and interaction

- `grill` runs first and feeds `architect`; unresolved grill questions that change the stack
  become the architect's "still-open questions" and may bounce back into the next grill round.
- `architect` stays silent when the conversation does not touch a technical choice — do not
  produce stack options for ordinary feature or bug work.
- This app already has a fixed stack (Tauri v2 + React 19 + TypeScript). Architect therefore
  applies to incremental choices inside that stack, not to greenfield re-selection.

## Multi-Agent Dispatch (Required)

For work that needs parallel roles, the main agent is the dispatcher. The rules in
`docs/team-collaboration-spec.md` are the single source of truth for workflow routing and
RACI; `docs/decisions-agent-dispatch.md` records why the dispatch setup is shaped this way.
A machine-local helper lives at `.workbuddy/skills/qing-dispatch/SKILL.md` — it is
git-ignored, so it must be rebuilt on a fresh clone.

- `grill` → `architect` still run first, in the main agent, before any team is created.
  A multi-agent round never replaces either step.
- The main agent is the **only** committer and the **only** build/acceptance runner.
  Sub-agents must not `git commit`, `npm install`, or touch capabilities, CSP,
  `package.json`, `release.yml`, or another member's in-flight files.
- All cross-member information goes through the main agent; members never message
  each other directly (spec §1.1, rule 1).
- Shared surfaces (`i18n.ts`, `App.tsx`, `index.css`, `types/`, `shellLayout.ts`) are
  assigned to exactly one member at a time — never two in parallel (spec §3.4 R1/R3).
- Every sub-agent prompt carries: the hard-rule digest from `.workbuddy/memory/MEMORY.md`,
  exact target paths, an explicit do-not list, and the handoff format
  (`IS_PASS: YES/NO` + QA routing).
- Team instances are session-scoped (state under `~/.workbuddy/teams/<name>/`) and are
  never assumed to survive into a new session. Only conclusions persist, in
  `docs/decisions-<topic>.md`.
- Default roster is three members (lead / engineer / QA) plus one read-only rule
  guardian; architect, PM, Rust specialist and the UI template are pulled in only when
  the workflow routing calls for them. See `docs/decisions-agent-dispatch.md` §5.
- After collection: dissolve the team, then one `git commit` (`feat(scope): 中文摘要`),
  no push. If the change can reach `dist/`, run the Build And WebView Acceptance loop
  once, from the main agent only, so two members never lock the exe.

## Commands

```bash
npm run dev           # Frontend-only Vite server, fixed port 8787
npm run tauri dev     # Full desktop dev mode: Vite + Tauri
npx tsc --noEmit      # TypeScript check
npm run build         # TypeScript + frontend production build
npm run verify:webview        # WebView2 acceptance; leaves the window open
npm run verify:webview:status # is a build still open, and is it current?
npm run verify:webview:close  # close the open build (also unlocks the exe)
npm run tauri build   # Windows installer build through Tauri/NSIS
```

`npm run build` runs `tsc && vite build`; use `npx tsc --noEmit` when you only need type checking.

On Windows PowerShell, `npx tsc --noEmit` may be blocked by the local script execution policy because it resolves through `npx.ps1`. If this is the only type-check failure and the requested change does not otherwise depend on type-check output, do not keep retrying or escalate just for this; skip type checking and mention the policy block in the final response.

## Build And WebView Acceptance (Required)

Every change that can reach the shipped bundle is built locally and then loaded in the
real WebView2 before it is reported as done. This is a standing rule, not a per-task
request.

### When it triggers

Run the loop when a change can alter `dist/` or the exe:

- anything under `src/`, `index.html`, `vite.config.ts`, `tsconfig.json`, `public/`
- anything under `src-tauri/` (`tauri.conf.json`, `capabilities/`, Rust, Cargo files)
- dependency or version changes (`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`)
- runtime-read content: `docs/user-manual.md` and `docs/user-faq.md` are imported with
  `?raw` into the bundle (`HelpCenterModal`, `knowledgeRetrieval`), so editing them counts

Skip it only for changes that cannot change the bundle: prose in `docs/**` that is not
imported above, `.github/**`, and comment-only edits.

### Steps

0. `npm run verify:webview:status` — a running build locks its own exe, so check
   before rebuilding. Exit `1` (nothing running) continues; exit `2` (stale) or `0`
   (running) means close it first: `npm run verify:webview:close`.
1. `npm run build` — type check plus Vite build. Run it in PowerShell, not Git Bash: a
   lowercase drive path breaks the `import.meta.glob("@/assets/...")` resolution.
2. `npm run tauri -- build --no-bundle` after loading the MSVC environment
   (`. .\env.ps1`). `--no-bundle` skips the NSIS installer but still embeds `dist/` into
   `src-tauri/target/release/qing-notepad.exe`; that exe is the acceptance target.
   Note: `env.ps1` is UTF-8 without BOM, so Windows PowerShell 5.1 can fail to parse its
   Chinese comments — inline the four variables from "Windows Build Environment", or save
   the file as UTF-8 with BOM, rather than skipping the build.
3. `npm run verify:webview` — boots the release exe through `explorer.exe` (a plain
   `spawn` gets reaped with the command's process tree), waits for the shell and note body
   to stop changing, asserts the DOM, collects console errors, writes
   `local_img/webview-main.png`, and **leaves the window open**.
4. Read the screenshot with an image tool. DOM assertions cannot judge typography,
   spacing, colour or clipping; the screenshot is the acceptance evidence.
5. When a specific element needs a measurement, probe the running build instead of
   guessing: `node scripts/verify-webview.mjs --eval "<js>"` (add `--shot <path>` to keep
   a second angle).

### Window lifecycle

- `verify:webview` keeps the window open by default. It is the surface the human inspects
  after the turn ends, so **do not close it when the turn ends** and do not kill
  `qing-notepad.exe` as cleanup.
- Only two things close it: a human, or `npm run verify:webview:close`. Clicking the X is
  not a close — the app is close-to-tray and only hides.
- `--close-after` is the explicit one-shot mode (assert, then close). Use it only for
  scripted runs, never as the default.
- Running the acceptance again while the window is open re-attaches over CDP instead of
  opening a second window (`"reused": true`); the single-instance plugin would swallow a
  second launch anyway. Console history is timestamp-filtered on re-attach so old 404s do
  not fail a fresh run.
- The window holds a lock on its exe. Rebuilding while it runs fails with access denied,
  which is why step 0 exists.
- The build fingerprint is the `dist/index.html` hash plus exe size/mtime
  (`verify-webview.mjs:118`). **Another session rebuilding `dist/` — even with no Rust
  change — makes the open window stale (exit `2`) and blocks CDP probes.** When several
  sessions share one working directory, build + verify must be run by one session at a
  time, in a quiet window (no `cargo`/`rustc`/`msbuild` processes, `dist/` and the exe
  unchanged for at least 3 minutes). Attach `HEAD`, the source blob hashes and a
  timestamp to every `ok:true`; an `ok:true` is only valid until the next external build.
- `verify:webview` exits 2 if `tasklist` finds **any** `qing-notepad.exe`
  (`verify-webview.mjs:349-357`), including an installed copy outside the repo. Do not
  kill the user's installed instance and do not expect `verify:webview:close` to clear
  it — that command only closes a tracked session. Ask the human to quit it from the tray,
  or record it as an environment blocker.
- For a clean-HEAD build, produce `dist/` in an isolated `git worktree` (junction
  `node_modules`, never `npm install`), verify it is byte-identical to the `dist/` you
  are about to embed, then run `tauri build --no-bundle` in the main tree. Never run the
  Tauri build inside the worktree: it recompiles all of Rust and collides on the cargo
  lock.

### Session resume

A new session (or a session reopened after the window was closed) must not assume the
previous window is still there or still current. Run `npm run verify:webview:status`
first and branch on its exit code:

| exit | meaning | what to do |
| --- | --- | --- |
| `0` | running, fingerprint matches `dist` + exe | reuse it: run `verify:webview` to re-assert without a new window |
| `1` | not running (never opened, or manually closed) | **full flow**: build → tauri build → `verify:webview` (opens a new window) |
| `2` | running, but a build happened since it opened | rebuild, then open: `verify:webview:close` and the full flow, or after rebuilding let `--replace` close the old window and open the new exe in one step |

Closing the window never means "carry on with the old build": the next session always
goes through steps 1–3 again and opens exactly one WebView.

### Acceptance criteria

All of these must hold, otherwise the change is not done:

- `npm run build` exits 0 with no TypeScript errors.
- `verify:webview` reports `"ok": true`, an empty `consoleErrors`, and
  `url: http://tauri.localhost/` — that URL proves the real WebView2 loaded the embedded
  bundle, not a browser stand-in. `"keptOpen": true` confirms the window survived the run.
- `.app-root` exists, `#root` is not empty, `#startup-error` is absent, and
  `window.__TAURI_INTERNALS__` is present.
- At least two `.shell-box` cards; the editor card is at least 320×200; a title-bar drag
  region exists; the activity rail has labelled buttons; no broken images; no horizontal
  overflow on `<body>`.
- The screenshot matches the intent of the change: no clipped text, no overlapping
  panels, no fallback font, no empty black region. When only one area was meant to
  change, compare against the previous screenshot.
- Anything the run cannot prove — hover, drag, streaming timing, IME, scroll
  choreography, tray and multi-window behaviour — is reported as 未验证, never as
  "tested".

### Failure handling and data safety

- A console error or a failed assertion means the work is unfinished: fix, rebuild,
  rerun. Never report success with a known failure. A failed run keeps its window open on
  purpose — the failure is what the human needs to see.
- Missing exe: run step 2. "Another qing-notepad.exe is running" means the installed build
  holds the single-instance lock — quit it from the tray first. "CDP is not listening"
  means the window was opened by hand, without the debugging flag: close it and let the
  runner open it instead.
- The runner never types or clicks destructive controls, but the app still resolves its
  data root from `%APPDATA%/com.qing-notepad.app/storage.json` (it may point outside the
  repo) and rewrites files on startup autosave. Back the data up before a change that
  touches the storage format.
- Screenshots land in `local_img/` (git-ignored). Do not commit them.
- A screenshot taken before the restored tab finishes loading shows the placeholder and
  "0 字"; that is a timing artefact, not data loss. The runner waits for a stable layout
  signature for exactly this reason — do not "fix" the empty state from such a shot.

## Release Content Sync (Required)

Every release writes the **same user-facing notes into three places**, in the same commit as
the version bump. None of them reads the others, so skipping one produces a visible hole:

| Place | Consumed by | When it takes effect |
| --- | --- | --- |
| `.github/workflows/release.yml` → `releaseBody` | the GitHub Release page | tag build (CI) |
| `UPDATE.md` (repo root) | `updater-manifest.mjs --notes-file UPDATE.md` → `notes` in both manifests → the in-app update card | tag build (CI) |
| `announcements.json` (repo root) | the remote feed behind the announcement board / changelog dialog | immediately on push to `main` (Gitee raw) |

Rules:

1. **The body text must match across the three.** The announcement may add one sentence about
   where the update entry lives; it must not describe features the other two omit.
2. **`announcements.json` gets a new item, never an edit of a shipped one.** `id` is the
   read/dismiss key, so editing an existing entry is invisible to everyone who dismissed it.
   Use `YYYY-MM-DD-vX-Y-Z`, put the item at the **front** of `items` (parsing slices to 20
   before sorting), and set `publishedAt` to the real **UTC** release time — local time minus
   the offset, not the wall clock.
3. **`UPDATE.md` and `releaseBody` are frozen at tag time.** Fixing them after a release means
   re-uploading release assets, not editing the source.
4. **`announcements.json` is not tagged content.** Pushing it to `main` reaches every installed
   client within the 1h cache window, with no release required. Use this for corrections.

Checklist before tagging (all three must print `ok`):

```bash
node -e "const v=require('./package.json').version.replace(/\./g,'-');const j=require('./announcements.json');console.log(j.items.some(i=>i.id.endsWith('v'+v))?'announcement ok':'MISSING announcement')"
grep -q '## 本次更新' .github/workflows/release.yml && echo 'releaseBody ok'
test -s UPDATE.md && echo 'UPDATE.md ok'
```

An empty or one-line `UPDATE.md` (for example `修复已知问题`) is allowed only when it is also
what the other two say. Any release that reuses an older version's notes (v0.9.2 did) must copy
the full text, not a summary of it.

## Release Runbook (Trigger: 「开始发行最新版vX.Y.Z」)

When the user says **「开始发行最新版vX.Y.Z」**, that sentence is the whole instruction: the
version is final, do not ask again, and run steps 1–8 below in order in the same turn,
reporting each step as it lands. A step that fails stops the chain — report it instead of
improvising. Anything the user must decide (dropping a section, shipping a known bug) is asked
once, before step 4, never in the middle of a tag.

**1. Pin the version**

`npm run version:set -- vX.Y.Z`. It rewrites `package.json`, `package-lock.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` together. Never
hand-edit these: CI reruns the same script from the tag, so a half-bumped tree fails the build.

**2. README**

Update only the bullets whose behaviour changed since the last tag, in the existing
numbered-emoji style. Do not add a version heading — the version badge reads live from GitHub.
Data-layout changes must also update the `data/` tree in the README.

**3. Release notes in three places**

Write the body once, then paste the identical text into all three (see **Release Content
Sync**): `UPDATE.md` is canonical, `releaseBody` in `.github/workflows/release.yml` carries it
under `## 本次更新`, and `announcements.json` gets a new front item with id
`YYYY-MM-DD-vX-Y-Z` and a real UTC `publishedAt`. Run the checklist above; all three print
`ok`.

**4. Commit**

Two commits so the tag points at content that already builds: `docs(agents|release): …` when
the runbook or decision log changed, then `chore(release): 发布 vX.Y.Z` for the bump plus
notes. `git status` must be clean before step 6.

**5. Push the branch**

`git pushall` (origin, then gitee). Never tag a commit the remotes do not have.

**6. Local build and WebView acceptance**

Run **Build And WebView Acceptance** above, starting with `verify:webview:status`.
`announcements.json` and `UPDATE.md` are imported with `?raw` / consumed by the manifest, so
this step always triggers on a release. The window stays open.

**7. Tag and publish**

`git tag vX.Y.Z` (lightweight, matching the existing tags), then:

- `git push origin vX.Y.Z` — this is the build trigger; `release.yml` fires on `v*`.
- `git push gitee vX.Y.Z` — mirror only, no CI on Gitee.

`npm run version:set` inside CI re-derives the version from the tag, so the tag and the tree
must agree before pushing.

**8. Verify the artefacts**

Follow the run named `Qing Notepad vX.Y.Z` at
`https://github.com/PyTs1n9/Qing-Notepad/actions`. Green means the Release holds the NSIS
installer plus `latest.json` / `latest-gitee.json`, and `notes` in both manifests equals
`UPDATE.md`. The updater manifest is generated from the CI `.sig` — a local build cannot stand
in for it.

**Failure notes**

- `Access is denied` while rebuilding: the acceptance window still holds the exe. Run
  `npm run verify:webview:close`, then rebuild.
- `tag 'vX.Y.Z' already exists`: that version is already published. Roll forward with the next
  patch; do not move or delete a tag that triggered a run.
- The run is green but the in-app card shows older notes: the manifests were built before
  `UPDATE.md` was final. Re-run the workflow **on the tag**; `workflow_dispatch` builds without
  publishing.
- Never force-push or re-create a released tag. A pushed `v*` tag is a public release.

## Git Remotes

`origin` is GitHub and nothing else — a plain `git push origin` must never reach Gitee.
Gitee is a separate remote named `gitee`. Do not reintroduce a `remote.origin.pushurl`
pointing at Gitee; that made one command write to two hosts and mixed their errors together.

- **Everyday commits still go to both platforms.** Use `git pushall` (a repo alias:
  `git push origin HEAD && git push gitee HEAD`) instead of two hand-written pushes, so a
  branch cannot land on one host and stay missing on the other.
- **Tags go to GitHub first.** Releases are built only by GitHub Actions; push the `v*` tag
  to `origin` to trigger the run, then push the same tag to `gitee` to keep the mirror equal.
- **`main` is the only long-lived branch.** Feature branches are merged and then deleted on
  both remotes, not kept around.

## Windows Build Environment

Rust/Tauri builds on Windows require the MSVC linker. Before `npm run tauri dev` or `npm run tauri build`, load the environment:

```powershell
Copy-Item env.example.ps1 env.ps1   # first time only
. .\env.ps1
```

`env.ps1` holds machine-local absolute paths and is git-ignored, so every clone creates its own copy from the tracked template `env.example.ps1`. The template pins versions below but falls back to the newest locally installed MSVC / Windows SDK when the pinned ones are missing.

The explicit variables used by this project are:

```powershell
$env:Path = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64;$env:USERPROFILE\.cargo\bin;$env:Path"
$env:LIB = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64"
$env:INCLUDE = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\cppwinrt"
$env:WindowsSdkDir = "C:\Program Files (x86)\Windows Kits\10\"
```

Version numbers such as `14.44.35207` and `10.0.26100.0` must match the local Visual Studio Build Tools / Windows SDK installation.

## Architecture

### Top-Level Structure

```text
src/                         React renderer source
src/components/Editor/       TipTap editor, Markdown mode, formatting toolbar
src/components/Layout/       Sidebar and custom title bar
src/components/Settings/     Settings and about modals
src/components/Sticky/       Editable always-on-top sticky note window
src/components/Tile/         Read-only note tile window
src/components/Todo/         Todo list view
src/stores/                  Zustand stores
src/types/                   Shared TypeScript types
src/utils/                   Storage, i18n, theme, shortcuts, window helpers
src-tauri/                   Tauri v2 Rust shell, config, capabilities, icons
public/                      Static renderer assets
```

### Entrypoints

- `src/main.tsx` chooses which React surface to render:
  - default: `<App />`
  - `?tile=1&noteId=...`: `<TileView />`
  - `?sticky=...`: `<StickyNote />`
- `src/App.tsx` owns app initialization, data loading, theme application, autosave wiring, sidebar resize/collapse, import handlers, settings/about modals, shortcut setup, and tile theme sync.
- `src-tauri/src/main.rs` must call `qing_notepad_lib::run()`.
- `src-tauri/src/lib.rs` configures Tauri plugins, tray behavior, close-to-tray behavior, and the `quit_app` command.

## Frontend State

The app uses Zustand stores in `src/stores/`.

| Store | File | Responsibility |
| --- | --- | --- |
| Todo | `todoStore.ts` | Todo items, status filter, priority filter, CRUD, reorder, completion sorting |
| Notes | `noteStore.ts` | Note metadata, active note ID, search query, tag filter, add/update/delete |
| Fonts | `fontStore.ts` | Built-in font list plus imported custom fonts |
| Settings | `settingsStore.ts` | Theme, language, custom colors, saved presets, global shortcuts |

Shared types live in `src/types/index.ts`.

## Data Persistence

All persistence goes through `src/utils/storage.ts`, which wraps `@tauri-apps/plugin-fs`.

Installed builds store data beside the executable. Tauri development builds use
the repository root. Both resolve to a `data` directory with this structure:

```text
<install-or-project-directory>/data/
├── todos.json
├── fonts.json
├── settings.json
├── app-icon.png
├── notes/
│   ├── index.json
│   └── <uuid>.md
└── trash/notes/
    ├── index.json
    ├── <uuid>.md
    └── img/
```

Do not silently fall back to `%APPDATA%`: the install/project `data` directory is
the single source of truth so portable data remains attached to the app folder.
Do not bundle `data` as an installer resource because reinstalling would overwrite
the user's live files. Existing install-directory data must remain external.

The user may relocate the whole directory from Settings → 存储. The rules that
keep that safe:

- The pointer file lives in the OS config directory (`%APPDATA%/com.qing-notepad.app/storage.json`)
  and is read/written only by `src-tauri/src/storage.rs`; it must stay outside the
  data directory, otherwise the location would be unknown after a move.
- A custom root is registered into the fs scope **and** the asset-protocol scope at
  startup, otherwise note images fail to load there. Never add a command that
  registers an arbitrary path — that would undo the scope tightening.
- `storage_migrate` moves same-volume entries with `rename`, copies cross-volume
  entries, verifies file/byte counts per entry, and only then rewrites the pointer.
  Do not write the pointer before the move completes.
- A missing custom root must throw (`DATA_DIRECTORY_UNAVAILABLE`) instead of being
  recreated: an unplugged drive must not look like an empty notebook.

Important details:
- `notes/index.json` stores metadata only: `id`, `title`, `tags`, `createdAt`, `updatedAt`.
- Note content files use `.md` extension but may contain either raw Markdown or TipTap HTML.
- `loadNoteContent()` must tolerate both HTML and Markdown.
- `saveNoteContent()` writes the current editor payload directly.
- `App.tsx` autosaves todos, note index, fonts, and settings after initialization.
- Note editor/sticky note content uses an 800ms debounce pattern for save-related flows.
- Deleting a note goes through `moveNoteToTrash()`: the `.md` plus its image attachments move into
  `trash/notes/`, and `trash/notes/index.json` keeps the metadata (including `deletedAt`).
  Retention comes from the `trashRetentionDays` setting (`0` = off, `-1` = forever) and also
  governs the `img-trash` quarantine window. `purgeExpiredNoteTrash()` runs on startup and
  whenever the setting changes.

## Note Editor Flow

`src/components/Editor/NoteEditor.tsx` supports two modes:

- **WYSIWYG mode**: TipTap stores/edits HTML.
- **Markdown mode**: textarea source editor plus marked preview.

Conversions:
- WYSIWYG -> Markdown: `turndown`
- Markdown -> WYSIWYG/preview: `marked`

The editor guards against common race conditions:
- Saves the previous note when switching active notes.
- Clears the editor immediately before loading new note content.
- Discards stale `loadNoteContent()` results if the active note changed.
- Suppresses dirty-state changes during programmatic content loading.

`Toolbar.tsx` works in both modes:
- In WYSIWYG mode it calls TipTap commands.
- In Markdown mode it inserts/wraps Markdown or HTML fallback syntax directly in the textarea.

## Sticky And Tile Windows

The project creates extra Tauri webview windows from the frontend.

- `src/utils/stickyManager.ts`
  - Creates `sticky-*` windows with `/?sticky=<noteId>`.
  - Tracks open sticky windows in memory.
  - Sticky notes are editable, transparent, always-on-top by default, and save back to note content.
  - Sync events:
    - main editor -> sticky: `sticky:note-updated`
    - sticky -> main editor: `sticky:note-saved`
    - sticky close tracking: `sticky:closed`

- `src/utils/tile.ts`
  - Creates/focuses `tile-*` windows with `/?tile=1&noteId=<noteId>`.
  - Tile windows are read-only note previews.
  - Theme updates sync through `tile-theme-sync`.

Tauri capabilities must allow labels matching `main`, `sticky-*`, and `tile-*`.

## Theme System

Theme variables are defined in `src/index.css` through Tailwind CSS v4 `@theme` tokens and theme classes.

Theme presets:
- default/blue: no class or `.theme-blue`
- dark: `.theme-dark`
- yellow: `.theme-yellow`
- green: `.theme-green`
- custom: `.theme-custom` plus inline CSS variables

`src/utils/theme.ts` applies/removes classes and inline custom properties. `settingsStore.ts` owns `THEME_COLORS` and syncs `customColors` when preset themes are selected.

When changing component styles:
- Prefer existing Tailwind token classes such as `bg-bg-primary`, `text-text-muted`, `bg-accent`, `border-border`.
- Avoid hardcoded hex colors in component `className` strings because they will not follow themes.
- Inline `style={{ backgroundColor: ... }}` is acceptable for user-selected color swatches/previews and editor color commands.

## i18n

`src/utils/i18n.ts` exports:
- `t(lang, key)`
- `tWithParams(lang, key, params)`

Rules:
- Every UI string key must exist in the `TranslationKeys` type.
- Add each new key to both `zh` and `en`.
- Components should read the language from `useSettingsStore(s => s.lang)`.
- Missing translation keys should fail at compile time; do not bypass the typed table for ordinary UI text.

## Tauri Backend

Tauri v2 lives in `src-tauri/`.

Plugins used:
- `tauri-plugin-fs`
- `tauri-plugin-dialog`
- `tauri-plugin-opener`
- `tauri-plugin-global-shortcut`

Rust side responsibilities:
- Register plugins.
- Create system tray menu.
- Hide main window to tray on normal close.
- Exit only through the `quit_app` command or tray quit item.
- Provide the `quit_app` command invoked by the custom title bar.

There are no custom Rust file-I/O commands; frontend code uses Tauri plugins directly.

Critical backend details:
- `src-tauri/Cargo.toml` `[lib] name` is `qing_notepad_lib`.
- `src-tauri/src/main.rs` must call `qing_notepad_lib::run()`.
- Tauri v2 permissions live in `src-tauri/capabilities/default.json`, not in `tauri.conf.json`.
- `tauri.conf.json` uses `devUrl` `http://localhost:8787`; Vite is configured with fixed port `8787`.

## Path Alias

`@/` maps to `src/`.

Configured in:
- `vite.config.ts`
- `tsconfig.json`

Prefer `@/...` imports for app source modules where existing code does so.

## Development Guidelines For Agents

- Read the relevant store/component/util before editing; behavior is split between Zustand state, Tauri plugin calls, and React effects.
- Keep changes scoped. Do not refactor unrelated areas while fixing a feature.
- Preserve local user data formats under `%APPDATA%/com.qing-notepad.app/data/`.
- Be careful with note content format: `.md` files are not guaranteed to be Markdown.
- When adding UI text, update both translations and use `t()`/`tWithParams()`.
- When adding Tauri APIs, update capabilities in `src-tauri/capabilities/default.json`.
- When adding new windows, ensure labels are covered by capabilities and route selection in `src/main.tsx`.
- When changing theme behavior, update both CSS variables/classes and `THEME_COLORS` if preset colors are involved.
- For frontend visuals, follow existing compact desktop-app patterns; this is not a landing page.
- Use `lucide-react` icons where applicable.

## Known Pitfalls

- `TextStyle` from `@tiptap/extension-text-style` is a named import.
- Use `readFile` from `@tauri-apps/plugin-fs` for binary files; do not use deprecated `readBinaryFile`.
- `saveNoteContent()` may store HTML in WYSIWYG mode and Markdown in Markdown mode.
- `noteStore.getFilteredNotes()` includes `note.content`, but note list metadata loaded from disk may not contain full content.
- Imported Markdown is converted to HTML before saving for WYSIWYG display.
- Sticky note edits save `innerHTML`, so they generally produce HTML content.
- `Toolbar.tsx` intentionally contains some hardcoded editor color values for text color commands; these are content formatting values, not theme tokens.
- `TodoView.tsx` priority badge colors are hardcoded Tailwind palette classes; update deliberately if theme-aware priority badges are required.
- Normal window close hides the app to tray. Use `quit_app` for true exit.
- Do not change the Tauri library name unless `main.rs` and Cargo config are changed together.

## Quick Mental Model

The renderer is the source of most behavior. `App.tsx` loads persisted JSON/files into Zustand, React components mutate Zustand, effects persist state back through `storage.ts`, and Tauri plugins provide dialogs, filesystem access, windows, tray integration, and global shortcuts. Notes are metadata in Zustand plus content on disk. Extra sticky/tile windows are separate React render paths selected by query parameters and synchronized with events.
