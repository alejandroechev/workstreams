# Features (deep dive)

> A long-form reference for every feature in Workstreams. The [README](../README.md)
> has the elevator pitch; this file is the deep dive.

## Workstream management

Create, switch, and persist project workstreams with git repo detection.
Switching or archiving a workstream prompts before discarding unsaved
editable file buffers.

Each workstream row has a kebab "Change worktree…" action that re-points the
workstream at a different worktree directory (switch existing or create a new
branch worktree) and respawns affected terminal / Copilot session PTYs in the
new location.

The row's activity slot shows one of four states:

- gray hollow square — stopped (workstream hasn't been opened this session)
- nothing — loaded + idle
- pulsating blue dot — any linked Copilot session is working
- bell icon — an agent finished while the workstream was unfocused (clears on focus)

A workstream allows at most one linked Copilot session; secondary Copilot
session tiles hide the "🔗 Link" button so only the first tile becomes the
linked one.

## Repo creation

Add repos via two flows, both surfaced via a dropdown menu under the sidebar `+`:

- **Import existing repo** — pick an existing directory, auto-detect remote
  and branch.
- **Create new repo** — scaffold a folder with README + .gitignore, run
  `git init -b master`, make initial commit, and optionally create a private
  or public GitHub remote via `gh repo create`.

## Adaptive tiling

Tiles auto-arrange:

- 1 tile → fullscreen
- 2 tiles → 50/50 split
- 3 tiles → focus + stack
- 4 tiles → 2x2 grid
- 5+ tiles → focus + grid

The fullscreen tile has a distinct yellow border to make the mode obvious at
a glance. Each tile shows a Heroicon in its header (per-type default,
override via config) and a double-click on the title renames it inline.

## Terminal tiles

Full interactive terminals via xterm.js + portable-pty (ConPTY on Windows).

## Code viewer tiles

Monaco Editor with syntax highlighting for 20+ languages, plus the editable
behaviour described under "Editable text files".

## Doc viewer tiles

VS Code-style markdown renderer with:

- GFM support and syntax-highlighted code blocks
- Inline **Mermaid diagrams** with zoom / pan
- On-disk image rendering — relative `![alt](path/to.png)` references are
  resolved against the source file's directory and loaded as blob URLs
- Inter-document link navigation: clicking `[other](other.md)` opens the
  target file in the same surface, `#anchor` links scroll within the rendered
  preview, and `http(s)://` links delegate to the system browser
- Repo Explorer hosts a back / forward history for navigating between
  previewed files

## Repo Explorer tile

Multi-tab repo browser (Files / Diff / Log / Hooks):

- Alphabetical sort with folders first
- Ctrl+P filename search, Monaco find-in-file (Ctrl+F)
- Inline previews for audio and image files (png, jpg, gif, webp, bmp, ico,
  svg, avif)
- SQLite databases (`.db`, `.sqlite`, `.sqlite3`, `.db3`, or any file with
  the `SQLite format 3\0` magic header) open in a read-only table browser
- **Diff** tab: unified file-list + Monaco diff editor with A/M/D/R status
  badges. Unstaged includes both modified tracked files and untracked files.
  A **Split / Unified** toggle in the diff toolbar switches between
  side-by-side and inline layouts (persisted per tile)
- **Log** tab: ahead / behind counts against `origin/<current-branch>`, with
  an `origin/<branch>` badge + accent border on the matching commit
- Search overlays are scoped inside the tile with arrow-key + Enter
  navigation

A stand-alone CLI scenario (`node scripts/repo-explorer-cli.mjs <dir>
<query>`) mirrors the same filename search logic without launching the
desktop app.

## Editable text files

Repo Explorer / Session Meta / Workbench file-detail panes use a
Monaco-backed editor with:

- Explicit Ctrl+S plus 10 s debounced auto-save
- Conditional writes that detect external modification
- Read-only side-by-side conflict diffs
- Dangerous-path warnings for `.git/`, `node_modules/`, build artifacts, and
  lockfiles

See [ADR 006](adrs/006-editable-text-files.md).

## Inline file comments

Per-workstream comments anchored to line ranges in any file viewable in Repo
Explorer.

Toolbar toggle (chat-bubble icon) shows / hides them as Monaco view zones
below the anchored line. Select lines → click the floating `+ Comment`
button → write markdown → Save. Comments get inline Edit / Delete.

Stored in `file_comments` (workstream-scoped SQLite); persistent across app
restarts. See [ADR 009](adrs/009-inline-file-comments.md).

## Session Meta tile

Inspects the linked Copilot session via three tabs:

- **Config** — Skills, Extensions, Agents, MCP Servers, Instructions, Plugins
  (git hooks were removed and stay in the Repo Explorer Hooks tab)
- **State** — file browser of `~/.copilot/session-state/<id>` that navigates
  into subfolders just like Repo Explorer and opens files in the embedded
  Monaco / image / audio viewer
- **DB** — read-only SQLite table browser scoped to the session DB

## Workbench tile

A per-workstream scratch list of files you're actively working on. Right-click
on file rows or the open-file toolbar gets the shared file context menu (copy
path / copy filename / open in system). The opened file's full path is shown
in the viewer toolbar.

## App settings

Status-bar gear opens a Settings modal:

- Three global font sizes: code editor, markdown body, terminal cell
- Terminal scroll speed
- Configurable Copilot CLI command (default `agency copilot --yolo`; set to
  `copilot --yolo` to use the public GitHub Copilot CLI)
- Confirm-close dialog (with a "Don't ask again" checkbox)

Persisted in the SQLite settings table.

## Session persistence

Workstreams, tile layouts, terminal scrollback, and per-tile view state all
survive app restarts.

## Copilot CLI enrichment

Reads the session-store DB for context %, turn count, summaries. Surfaces
session state per linked tile.
