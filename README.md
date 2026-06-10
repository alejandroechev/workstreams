# Workstreams

> **v0.2.0** — Desktop app

Project-aware workstream manager with tiling compositor for Copilot CLI — manage projects, persist sessions, embed terminals with adaptive tiling layouts, code viewers, and doc viewers.

> 📖 **New here?** Start with the [Beginner's Tutorial](docs/tutorial/tutorial.md) — an annotated walkthrough from first launch to productive use, with screenshots.

## Features

- **Workstream management** — Create, switch, and persist project workstreams with git repo detection. Switching or archiving a workstream prompts before discarding unsaved editable file buffers. Each workstream row has a kebab "Change worktree…" action that re-points the workstream at a different worktree directory (switch existing or create a new branch worktree) and respawns affected terminal/copilot session PTYs in the new location. The row's activity slot shows one of four states: gray hollow square (stopped — workstream hasn't been opened yet this session), nothing (loaded + idle), a pulsating blue dot (any linked Copilot session is working), or a bell icon (an agent finished while the workstream was unfocused — clears on focus). A workstream allows at most one linked Copilot session; secondary Copilot session tiles hide the "🔗 Link" button so only the first tile becomes the linked one.
- **Repo creation** — Add repos via two flows: **Import existing repo** (pick an existing directory, auto-detect remote/branch) or **Create new repo** (scaffold a folder with README + .gitignore, run `git init -b master`, make initial commit, optionally create a private/public GitHub remote via `gh repo create`). Surfaced via a dropdown menu under the sidebar `+`.
- **Adaptive tiling** — Tiles auto-arrange: 1=fullscreen, 2=split, 3=focus+stack, 4=grid, 5+=focus+grid. The fullscreen tile has a distinct yellow border to make the mode obvious at a glance. Each tile shows a Heroicon in its header (per-type default, override via config) and a double-click on the title renames it inline.
- **Terminal tiles** — Full interactive terminals via xterm.js + portable-pty (ConPTY on Windows)
- **Code viewer tiles** — Monaco Editor read-only with syntax highlighting for 20+ languages
- **Doc viewer tiles** — VS Code-style markdown renderer with GFM support, syntax-highlighted code blocks, inline **Mermaid diagrams** with zoom/pan, on-disk image rendering (relative `![alt](path/to.png)` references are resolved against the source file's directory and loaded as blob URLs), and inter-document link navigation: clicking `[other](other.md)` opens the target file in the same surface, `#anchor` links scroll within the rendered preview, and `http(s)://` links delegate to the system browser. Repo Explorer hosts a back/forward history for navigating between previewed files.
- **Repo Explorer tile** — Multi-tab repo browser (Files / Diff / Log / Hooks) with alphabetical sort (folders first), Ctrl+P filename search, Monaco find-in-file (Ctrl+F), and inline previews for audio and image files (png, jpg, gif, webp, bmp, ico, svg, avif). Clicking a SQLite database (`.db`, `.sqlite`, `.sqlite3`, `.db3`, or any file matching the `SQLite format 3\0` magic header) opens a read-only table browser instead of the text editor. The Diff tab uses a unified file-list + Monaco diff editor: a sidebar lists changed files with A/M/D/R status badges (Unstaged includes both modified tracked files and untracked files; Last Commit and vs Master mirror their git equivalents), and the right pane renders the real before/after file contents fed from `git show <ref>:<path>` plus the working copy on disk. A **Split / Unified** toggle in the diff toolbar switches between side-by-side and inline Monaco layouts (persisted per tile). Switching diff mode keeps the selected file when it's also changed in the new mode. The Log tab now shows ahead/behind counts against `origin/<current-branch>` and marks the commit that origin's branch tip points at with an `origin/<branch>` badge + accent border. Search overlays are scoped inside the tile and support arrow-key + Enter navigation. A stand-alone CLI scenario (`node scripts/repo-explorer-cli.mjs <dir> <query>`) mirrors the same filename search logic without launching the desktop app.
- **Editable text files** — Repo Explorer / Meta / Workbench file-detail panes use a Monaco-backed editor with explicit Ctrl+S plus 10 s debounced auto-save, conditional writes that detect external modification, read-only side-by-side conflict diffs, and dangerous-path warnings for `.git/`, `node_modules/`, build artifacts, and lockfiles. See [ADR 006](docs/adrs/006-editable-text-files.md).
- **Diff Review tile** *(optional — gated by `VITE_ENABLE_OPTIONAL_FEATURES=1` at build time; hidden in public CI releases)* — Exhaustive agent-driven diff walkthroughs paired with the user-level `diff-grok` skill. The skill (running in an adjacent terminal tile) plans semantic-cluster chunks from `git diff <base>...HEAD`, a GitHub PR, or the working tree, then drives a 3-pane Monaco diff + question + comments tile. The tile opens automatically when the diff-grok skill plans a review, or manually via the Add Tile menu (`Alt+G`) which picks from active reviews. Reviews persist in SQLite (resumable across crashes), drift against re-diffs is detected by hunk hashes, and on completion the review is exported as `review.json` + `action-plan.md` under `.copilot-reviews/<id>/` for handoff to an actioning agent. Offline CLI smoke: `npm run diff-grok:smoke`. See [ADR 007](docs/adrs/007-diff-grok-integration.md).
- **Inline file comments** — Per-workstream comments anchored to line ranges in any file viewable in Repo Explorer. Toolbar toggle (chat-bubble icon) shows/hides them as Monaco view zones below the anchored line. Select lines → click the floating `+ Comment` button → write markdown → Save. User comments get inline Edit/Delete; imported (read-only) comments from ADO PRs show author + PR # + status. Stored in `file_comments` (workstream-scoped SQLite); persistent across app restarts. ADO PR import is agent-driven through the new `import_pr_comments` MCP tool (the app stays ADO-blind — the agent fetches and shapes the data). See [ADR 009](docs/adrs/009-inline-file-comments.md).
- **Session Meta tile** — Inspects the linked Copilot session via three tabs: **Config** (Skills, Extensions, Agents, MCP Servers, Instructions, Plugins — git hooks were removed and stay in the Repo Explorer Hooks tab), **State** (a file browser of `~/.copilot/session-state/<id>` that navigates into subfolders just like Repo Explorer and opens files in the embedded Monaco / image / audio viewer), and **DB**.
- **Plan tile** *(optional — gated by `VITE_ENABLE_OPTIONAL_FEATURES=1` at build time; hidden in public CI releases)* — Per-session viewer (Alt+P) of the linked Copilot session's plan: rendered `plan.md`, current-plan todos grouped by status, mermaid dependency graph of `todo_deps`, and plan/todo history sourced from the `plans` table snapshots.
- **App settings** — Status-bar gear opens a Settings modal. Three global font sizes (code editor, markdown body, terminal cell) plus terminal scroll speed; persisted in the SQLite settings table. A confirm-close dialog asks before the window destroys itself (with a "Don't ask again" checkbox + a Settings toggle to re-enable it); unsaved file changes always trigger their own separate prompt regardless of this setting.
- **Session persistence** — Workstreams, tile layouts, and terminal scrollback survive app restarts
- **Keyboard-driven** — hjkl navigation, n/c/d for new tiles, Ctrl+1-9 for workstream switching
- **Copilot CLI enrichment** — Reads session-store.db for context %, turn count, summaries

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Tauri v2 (Rust backend + WebView2 frontend) |
| Frontend | React 19 + Vite + TypeScript |
| Terminal | xterm.js + portable-pty (ConPTY) |
| Code Viewer | Monaco Editor (read-only) |
| Doc Viewer | react-markdown + remark-gfm + react-syntax-highlighter + Mermaid (vendored) |
| Persistence | SQLite (rusqlite) with WAL |
| Theme | Catppuccin Mocha |

## Requirements

- Node.js 18+
- Rust toolchain (cargo)
- Tauri CLI v2 (`cargo install tauri-cli`)
- Windows 10/11 (primary platform)

## Setup

1. Clone the repository
2. `npm install`
3. `cargo tauri dev` (first build ~5min, subsequent ~20s)

## Commands

```bash
cargo tauri dev      # Development (NO CDP)
npm run tauri:dev    # Development WITH CDP enabled (for visual validation)
cargo tauri build    # Production build (CDP disabled — never shipped)
npm run test         # Unit tests (vitest)
npm run test:e2e     # Playwright E2E tests (Vite dev server + MemoryBackend)
npx tsc --noEmit     # Type check
npm run cdp:feature -- <feature-id>   # Per-feature visual validation (ADR-003)
npm run cdp:seed     # Seed dev DB + showcase markdown
npm run dev:reset    # Reset dev state (.dev/ folder)
```

## E2E tests (Playwright)

`npm run test:e2e` boots Vite with `VITE_E2E=1` (port 5177), which swaps the
Tauri host for an in-memory backend and shimmed `@tauri-apps/api/*`
modules. Tests in `e2e/tests/*.spec.ts` drive the React app via Playwright
and can configure per-test `invoke()` handlers through
`window.__WS_INVOKE_HANDLERS__`. Useful for validating multi-step UI flows
(workstream creation, session linking, etc.) without needing the real Tauri
runtime. See `e2e/tests/ws-create.spec.ts` for the canonical example.

## Per-Feature Visual Validation

Every UI feature is validated by running it against a Tauri dev build via
CDP. **CDP is dev-only** — `tauri.conf.json` ships with no remote-debugging
port; it's enabled only via the `tauri.conf.dev.json` overlay passed to
`tauri dev`. The release binary cannot be inspected via CDP, so dev runs
never conflict with your working production session.

Workflow:
1. The runner uses an isolated dev DB at `.dev/workstreams-dev.db`.
2. Connects Playwright over CDP, navigates, captures console + page errors.
3. Saves a screenshot under `screenshots/<feature-id>/`.
4. Writes a `visual_proofs` row so the discipline gate can verify the run.

See `docs/adrs/003-cdp-feature-validation.md` for the design.

## Keyboard Shortcuts

All app-level commands are prefixed with **Alt** to avoid conflicts with terminal (`Ctrl+C/V/...`) and Monaco (`Ctrl+F/P/...`) shortcuts.

| Key | Action |
|-----|--------|
| `Alt+C` | New Copilot session tile |
| `Alt+T` | New terminal tile (PowerShell) |
| `Alt+W` | New terminal tile (WSL) |
| `Alt+R` | New Repo Explorer tile |
| `Alt+M` | New Session Meta tile |
| `Alt+B` | New Workbench tile |
| `Alt+P` | New Plan tile |
| `Alt+G` | New Diff Review tile (picker if >1 active reviews) |
| `Alt+Q` | Close focused tile |
| `Alt+F` | Toggle fullscreen for focused tile |
| `Alt+S` | Toggle side-by-side (when exactly 2 tiles are selected) |
| `Alt+Arrows` | Navigate between tiles |
| `Ctrl+S` | Save the focused file editor |
| `Ctrl+Shift+V` | Toggle markdown preview / edit in the focused file editor (matches VS Code) |
| `Esc` | Unfocus terminal / close modal |

## Architecture

See `docs/system-diagram.md` for the full architecture diagram and `docs/adrs/` for design decisions.

## License

Private use.
