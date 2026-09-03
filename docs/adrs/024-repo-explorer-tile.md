# ADR 024 — Repo Explorer Tile (multi-tab, search, font-resize)

## Status

Accepted

## Context

The "File Explorer" tile (`ExplorerTile`) had grown from a simple directory browser into a Swiss-army widget covering: file viewing, diff browsing across three diff modes (unstaged / last_commit / branch_vs_master), git log, and git hook inspection. Navigation between these sub-features was done with ad-hoc toolbar buttons (`Log`, `Hooks`, three `Diff:` buttons), driven by a private `mode: "browse" | "view" | "log" | "hooks"` state plus an orthogonal `activeDiffMode` state.

Pain points:
- Mode buttons were inconsistent with the rest of the app — `SessionMetaTile` already standardized on a top **tab bar**.
- The `Ctrl+P` filename search overlay used `position: fixed` semantics and rendered outside the tile bounds.
- That same overlay had no keyboard navigation (no ↑/↓/Enter).
- There was no cross-file content search ("grep in repo").
- File ordering was "folders alphabetical, files by modification time descending", which is surprising — VS Code-style alphabetical-within-group is the established convention.
- Monaco's built-in Ctrl+F find widget worked but had no visible affordance.
- No per-tile font-size control.

## Decision

1. **Rename** the component to `RepoExplorerTile` (file: `src/tiles/RepoExplorerTile.tsx`) and the user-facing label to "Repo Explorer". The tile type id stays `file_explorer` for backwards compatibility with existing persisted layouts.
2. **Adopt MetaTile-style tab bar** with four tabs: **Files / Diff / Log / Hooks**. The active tab is derived from `mode` + `activeDiffMode`. A `selectTab` handler maps tab clicks to the appropriate state transitions, keeping the existing logic intact.
3. **Sort order**: folders alphabetical first, then files alphabetical (changed in Rust's `list_directory`).
4. **Ctrl+P filename search**: fixed positioning by setting `position: relative` on the tile container; added arrow / Enter / Esc keyboard navigation with hover-driven selection state.
5. **Ctrl+Shift+F cross-file content search**: new overlay backed by a new Rust command `search_in_files` that walks the tree natively (no ripgrep dependency). It skips heavy directories (`node_modules`, `target`, `.git`, `dist`, `.next`, `__pycache__`, `.venv`, `venv`), skips files >1 MB to keep latency low, and caps at 5 matches per file / 200 total. Backend abstraction exposes it via `Backend.searchInFiles`, with an in-memory implementation used by tests.
6. **In-file search**: a magnifier toolbar button invokes Monaco's `actions.find` action — no custom find UI.
7. **Font-size**: per-tile state (`fontSize`, default 13). A−/A+ buttons live on the right side of the tab bar and `Ctrl+= / Ctrl+- / Ctrl+0` shortcuts apply when the tile is focused. Applied to Monaco's `fontSize` option and to the directory listing rows.

8. **Custom target branch diff (2026-08).** Alongside Unstaged, Last Commit,
   and vs Master, the Diff toolbar exposes a local-branch picker. Selecting a
   target computes `git diff <target>...HEAD`, matching the existing vs Master
   merge-base semantics while allowing release or sibling feature branches.
   The branch is passed separately as `baseRef` through the Backend/Tauri
   contract rather than encoded into the mode string, validated with
   `rev-parse --verify <target>^{commit}`, and persisted as
   `viewState.customDiffBranch`. Its modified side is `HEAD`, so it remains
   read-only and does not offer working-file comments.

9. **Cross-platform file context menu (2026-08).** The menu portals to
   `document.body`, measures after layout, and clamps inside the viewport so a
   right-click near the bottom/right edge never clips actions. A viewport
   backdrop closes on outside pointer input, while capture-phase Escape
   consumes the key before tile/native fullscreen handlers. New file/folder
   names use an in-app composer rather than `window.prompt` (unreliable in
   WKWebView). "Open in system" uses opener's permitted `revealItemInDir`
   command; the previous `openPath` call was outside `opener:default` scope and
   silently discarded its permission error.

## Consequences

- Users get a consistent tab UI across `SessionMetaTile` and `RepoExplorerTile`.
- Cross-file search works fully offline with no external binaries, but is slower than ripgrep on huge repos — acceptable trade-off given our skip-list and 1 MB cap.
- Font-size lives only in component state — not persisted across tile recreation. If users complain we'll lift it to tile config.
- The custom target picker lists local branches only. Remote-only refs must be
  fetched into a local branch before they appear.
- The tile type id (`file_explorer`) is retained, so existing workstream layouts keep loading without migration.
- All overlays are scoped to the tile container, which means they cannot escape the tile bounds in any tiling mode (fullscreen, split, grid).
