# Workstreams — Beginner's Tutorial

Welcome. This tutorial walks a brand-new user from **first launch** to
**productive use** of Workstreams: a desktop tiling shell for Copilot CLI
with persistent per-project workspaces, terminal tiles, code/diff browsers,
and a few opinionated keyboard shortcuts.

If you only have 30 seconds, here's the mental model:

> **Project** → has many → **Workstreams** → each has many → **Tiles**.
> A *workstream* is "this branch / this worktree / this session". A *tile*
> is a Copilot CLI session, a terminal, a repo explorer, a plan viewer, a
> diff review, or a doc/code viewer. The compositor lays them out for you;
> all state survives crashes and restarts.

---

## 0. Prerequisites

- Node.js 18+
- Rust toolchain (`cargo`)
- Tauri CLI v2 (`cargo install tauri-cli`)
- Windows 10/11 (primary platform — macOS / Linux untested)
- The GitHub Copilot CLI installed and authenticated (for Copilot session
  tiles; the rest works without it)

## 1. Install and Launch

```bash
git clone https://github.com/alejandroechev/workstreams.git
cd workstreams
npm install
cargo tauri dev      # ~5 minutes on first build, ~20 s subsequently
```

For a release build:

```bash
cargo tauri build
```

The first time you open the app you'll see a sidebar with no workstreams
selected and an empty tile grid. Workstreams persists everything in a
SQLite database under your app-data folder; nothing is auto-selected so
you're never dropped into "whatever was last archived".

![Startup screen — sidebar populated, no workstream auto-selected](images/01-startup.png)

> 💡 **Bug fix lineage**: earlier versions would auto-select the first row,
> which sometimes surfaced an archived workstream. Now you click in
> explicitly — see the workstream list, pick one.

---

## 2. Concepts

### Workspaces vs. Projects vs. Workstreams

| Concept | What it is | Example |
|---|---|---|
| **Project** | A logical product / repo group with a color tag in the sidebar. Optional — workstreams can live without one. | "Workstreams app", "Side-quest" |
| **Workstream** | One *piece of work*: a specific branch + working directory + saved tile layout + linked Copilot session. | "fix login bug", "refactor router on `feat/router-v2` worktree" |
| **Tile** | One pane inside the workstream's grid. | a PowerShell, a Copilot session, a Repo Explorer |

The big insight: a **workstream is the unit of context-switching**, not
a tile. When you switch workstreams, the entire tile grid is replaced
atomically with the persisted layout for the new one. Tile PTYs stay
alive in the background so switching back is instant.

### Workstream types

- **base_repo** — points directly at a git repo root (no worktrees).
- **worktree** — created via `git worktree add`; the workstream tracks
  branch + folder pair. Multiple workstreams can share a parent repo
  with different branches.
- **import_worktree** — same idea but the worktree already existed and
  you imported it.

---

## 3. Add a Repo (Project)

Click the **`+`** next to the **REPOS** header in the bottom of the
sidebar. You'll get two choices:

- **Import existing repo** — pick any folder on disk that already has
  `.git/`. The app auto-detects the remote, branch, and uses the parent
  folder name as the project name.
- **Create new repo** — scaffolds a fresh folder with `README.md` and
  `.gitignore`, runs `git init -b master`, makes the initial commit,
  and optionally creates a private/public GitHub remote via `gh repo
  create` (requires `gh` CLI authenticated).

The new project shows up in the sidebar with a colored stripe. Right-click
the stripe to edit its name or color.

---

## 4. Create your First Workstream

Click the **`+`** next to the **WORKSTREAMS** header. The Create
Workstream form lets you:

1. Give it a name (e.g. "auth refactor").
2. Optionally assign it to a project (you'll see the color stripe in the
   sidebar).
3. Pick the workstream **type**:
   - **Base repo** → the workstream points at the existing repo dir as-is.
   - **New worktree** → enter a branch name; the form previews the
     sibling folder path (`../<repo>-<branch>`). Submitting will run
     `git worktree add` and switch you there.
   - **Import worktree** → pick a pre-existing worktree folder.
4. Choose how Copilot sessions link: start a fresh `copilot --resume new`
   or attach to an existing session by id.

Once created the workstream appears in the sidebar. **Click it** to load
it as the active workstream.

![Workstream selected with its tile grid visible](images/02-workstream-selected.png)

---

## 5. Tiles — the Building Blocks

The bottom-right status bar has an **`+ Add tile`** button (also `Alt+`
keyboard shortcuts). Here's the full menu:

![Add Tile menu with all tile types and keyboard shortcuts](images/03-add-tile-menu.png)

| Tile | Shortcut | What it does |
|---|---|---|
| **Copilot Session** | `Alt+S` | Embedded Copilot CLI session (xterm.js + PTY). Persistent scrollback, picks up the workstream's `cwd`, injects `WORKSTREAMS_ACTIVE_WS` / `WORKSTREAMS_ACTIVE_TILE` env vars so skills / MCP servers know where they are. |
| **PowerShell** | `Alt+T` | Plain PowerShell terminal in the workstream's `cwd`. |
| **WSL Terminal** | `Alt+W` | Same but spawning WSL. |
| **Repo Explorer** | `Alt+R` | Multi-tab repo browser: Files / Diff / Log / Hooks. Ctrl+P filename search, Ctrl+Shift+F content search, Monaco viewer, file-edit support. The Diff tab's **Unstaged** view shows both modified tracked files *and* new (untracked) files — see [ADR 004](../adrs/004-repo-explorer-tile.md). |
| **Session Meta** | `Alt+M` | Sidebar of the active Copilot session: turn history, plan, context %. |
| **Workbench** | `Alt+B` | Catch-all editor pane for inbox / scratch files. |
| **Plan** | `Alt+P` | Renders `plan.md`, the current-plan todos (grouped by status), a Mermaid dependency graph of `todo_deps`, and plan-history snapshots from the `plans` table. |
| **Diff Review** | `Alt+G` | The `diff-grok` agent tile (see §8). |

Tile management:

| Shortcut | Action |
|---|---|
| `Alt+Q` | Close the focused tile |
| `Alt+F` | Toggle fullscreen (yellow border indicates fullscreen) |
| `Alt+←/↑/→/↓` | Navigate between tiles |
| `Alt+1`–`Alt+9` | Switch workstream by index |
| Double-click tile title | Rename inline |

### Adaptive tiling

You don't pick a layout — the compositor picks one for you based on tile
count:

- **1 tile** → fullscreen
- **2** → vertical split
- **3** → focused tile + stacked sidebar
- **4** → 2×2 grid
- **5+** → focused tile + grid of the rest

Whichever tile is "focused" (the one with the yellow / accent border)
gets the biggest cell. Use `Alt+Arrows` to move focus around.

---

## 6. Persistence

Everything saves automatically:

- Workstream list + order
- Per-workstream tile layout + focus
- Terminal scrollback (replayed on restart)
- Open Copilot session ids (re-attached via `copilot --resume <id>`)
- Linked plan / review state

Crash the app, kill the process, restart your machine — when you launch
again, your workstreams are still there. Click one, and the tiles
respawn against the same `cwd` with the same scrollback.

The data lives in:

- `%APPDATA%\com.workstreams.app\workstreams.db` (production)
- `.dev\workstreams-dev.db` (dev mode — isolated)

---

## 7. Switching Branches / Worktrees

You don't have to make a new workstream every time you want to look at a
different branch. Hover a workstream row — you'll see action icons
appear (fork ⑂, status, change worktree ⇄, archive ✕). Click the
**⇄ Change worktree…** icon:

![Change Worktree modal](images/05-change-worktree-modal.png)

Two modes:

1. **Switch Existing** — pick any folder on disk; the workstream now
   points there. Useful when you have many parallel worktrees already.
2. **Create New** — enter a branch name; the app creates a new worktree
   in a sibling folder (`../<repo>-<branch>`) and switches the
   workstream to it.

In both cases, every running terminal / Copilot session tile in that
workstream is killed and respawned against the new `cwd` — no need to
manually relaunch.

---

## 8. Diff Reviews (the `diff-grok` skill)

The **Diff Review** tile pairs with the user-level [`diff-grok`
skill](https://github.com/alejandroechev/diff-grok). The flow:

1. In a Copilot session tile, run `/diff-grok <base-ref-or-PR>`.
2. The skill plans semantic chunks from `git diff <base>...HEAD`.
3. A Diff Review tile auto-opens beside the session. It has three
   panes: Monaco diff (left), the agent's question (top-right), and
   your comments (bottom-right).
4. For each chunk: read the agent's question, click **Approve** /
   **Done with comments**, type a comment if you have feedback, repeat.
5. When the last chunk is acknowledged, the skill exports
   `review.json` + `action-plan.md` under
   `.copilot-reviews/<review-id>/` and the tile closes.

You can also list active reviews with `Alt+G`. If there are multiple, a
picker modal opens.

See [ADR 007](../adrs/007-diff-grok-integration.md) for the architecture
and [ADR 008](../adrs/008-mcp-bridge-for-skills.md) for the MCP bridge
that exposes Workstreams tile operations to the skill.

---

## 9. Settings

Click the gear icon in the status bar (bottom-right) for app preferences:

![Settings modal](images/06-settings-modal.png)

- **Terminal scroll speed** (0.1×–5×, default 0.5×) — mouse-wheel
  multiplier for terminal + Copilot session tiles. Lower for fine
  control, higher to skim long log output.
- **Mermaid font size** (8–24 px, default 12 px) — text size inside
  rendered Mermaid diagrams in doc viewers and the Plan tile.

Settings persist in `localStorage` and apply immediately.

---

## 10. Common Workflows

### "I want to review a PR"

1. New workstream pointing at the repo (or reuse one).
2. Open a Copilot session tile (`Alt+S`).
3. In it: `/diff-grok pull/1234`.
4. Walk through the auto-opened Diff Review tile.

### "I want to try a fix on a new branch without losing my current work"

1. On the current workstream row, click **⇄ Change worktree → Create
   New**, give it a branch name.
2. Open a terminal tile (`Alt+T`); you're already in the new worktree
   folder.

### "I'm context-switching between two features all day"

1. Make a workstream per feature.
2. `Alt+1` / `Alt+2` to jump between them. Tiles + scrollback are
   preserved.

### "I want to see all unstaged changes including new files"

Open a Repo Explorer tile (`Alt+R`), click the **Diff** tab, switch to
**Unstaged**. New (untracked) files now show up alongside modified
tracked ones, rendered as full-file diffs.

---

## 11. Where to go next

- **Architecture overview** → [`docs/system-diagram.md`](system-diagram.md)
- **All ADRs** → [`docs/adrs/`](adrs/)
- **Feature catalog + shortcut reference** → [README](../README.md)
- **Issues / feature requests** → https://github.com/alejandroechev/workstreams

Happy tiling.
