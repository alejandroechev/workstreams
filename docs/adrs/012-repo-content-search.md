# ADR 012 — Repo Explorer content search ("search all files")

## Status

Accepted (2026-06-25).

## Context

The Repo Explorer could search file *names* (the `Ctrl+P` overlay backed by
`search_files`) but had no way to search file *contents* across a repo. A
content-search backend (`search_in_files` / `searchInFiles`) existed end-to-end
but was wired to no UI, and its engine was a hand-rolled, single-threaded,
byte-by-byte directory walk that did not scale and ignored `.gitignore`.

Two hard requirements shaped the design:

1. **No whole-app hang.** The user's prior experience was that running a search
   made the entire app unusable. The root cause: `search_files` /
   `search_in_files` were *synchronous* `#[tauri::command]` functions, so the
   filesystem walk ran inline on Tauri's main/IPC thread and blocked every other
   tile/workstream command until it finished. (Same class of bug as ADR 011.)
2. **Efficiency.** "Search all files" should be fast on a real repo and respect
   ignore rules so it never scans `node_modules` / build output.

## Decision

Deliver a VS Code-style content search in two phases.

### Execution model — no-hang guarantee

`search_files` and `search_in_files` are now `async` commands that offload the
walk to a blocking worker via `tauri::async_runtime::spawn_blocking`, returning
the result array when done. Invariants:

- The walk never runs on the main/IPC thread, so it cannot freeze other
  operations.
- It holds **no shared lock** during the walk — only the lock-free
  `search_epoch` atomic is read from `State` on the command thread.
- Cancellation is cooperative via `search_epoch` (bumped on every new query /
  tab close / unmount), checked per file *and* per matching line, so a
  superseded search bails promptly.
- Work is bounded (1 MB/file, 240-char lines, per-file + total caps).

Regression tests assert that `spawn_blocking` tasks run concurrently (a long
search does not serialize ahead of another command) and that cancellation is
observed mid-file.

### Engine — ripgrep library crates

`search_in_files_impl` was rewritten on the ripgrep libraries:

- **`ignore`** (`WalkBuilder::build_parallel`) for a `.gitignore`/`.ignore`-aware
  **multi-threaded** walk that also skips hidden entries (covers `.git`) and our
  `SEARCH_SKIP_DIRS` (`node_modules`, `target`, `dist`, …) even when not
  gitignored. Each worker searches a file into a thread-local Vec, then merges
  under a Mutex respecting the total cap; cancellation/total-cap stop the whole
  walk via `WalkState::Quit`. Because parallel traversal yields nondeterministic
  file order, results are sorted by `(path, line)` at the end so they are stable
  and grouped per file.
- **`grep-searcher` + `grep-regex`** for fast line matching.

Default behavior is a **case-insensitive literal substring** (the query is
`regex::escape`-d). `ContentSearchOptions { caseSensitive, regex }` enable
case-sensitive and/or regular-expression matching (`case_insensitive(!caseSensitive)`,
raw pattern in regex mode). The command pre-validates a user regex and returns
`Invalid regex: …` so the UI can surface it. The `FileSearchMatch
{ path, line_number, line_text }` shape is unchanged.

Results are bounded by a **per-file cap** (`CONTENT_SEARCH_MAX_PER_FILE = 50`,
shared with the frontend + the in-memory backend) and a total cap (1000 from the
UI). When a file reaches the per-file cap the grouped header shows a highlighted
`50+` badge so it's clear more matches exist there.

These crates are the standard ripgrep components (pure Rust, widely used). They
add compile time but no external binary to ship.

### UI

- A dedicated **"Search" tab** in the Repo Explorer (alongside
  Files/Diff/Log/Hooks), opened by clicking it or pressing **`Ctrl+Shift+F`**.
- `RepoContentSearch` (component) + `useContentSearch` (hook) own the surface,
  keeping the ~1.8k-line tile from growing: debounce (200 ms), 2-char minimum,
  `cancelSearches()` on each change/unmount, results grouped by file with the
  matched substring highlighted, `Aa` / `.*` toggles for case/regex, an error
  row for invalid regex, and a "results truncated" indicator at the cap.
- Clicking or pressing Enter on a result opens the file and **jumps to the
  matched line** (`FileEditorView` gained an `initialRevealLine` prop that
  reveals + selects the line once Monaco mounts).
- The active Search tab and the last query are persisted in tile view-state and
  re-run on restore.

### CLI parity

`scripts/repo-explorer-cli.mjs` mirrors the search (content + `--names`),
printing `path:line: text`, with its skip-dir list kept in sync with
`SEARCH_SKIP_DIRS`.

## Consequences

- Searches can never hang the app; one tile's search cannot block another.
- Content search respects `.gitignore`, so it is both faster and more correct
  (ignored build output is never scanned).
- Adds the `ignore`, `grep-searcher`, `grep-regex`, `grep-matcher`, and `regex`
  crates (longer Rust builds).
- The Tauri test binary cannot launch on the author's Windows machine (a
  WebView2 entrypoint DLL issue), so the engine was validated via a standalone
  Rust harness and the `#[cfg(test)]` unit tests run authoritatively on CI
  (Linux).

## Future enhancements (deferred)

- **Streaming results via Tauri events.** Phase 2 originally planned to emit
  `search-result` batches keyed by a search id so results render incrementally
  on very large repos. This was **deferred**: the no-hang requirement is already
  met by off-thread execution, results are capped (~1000) and render fine in a
  single batch, and Tauri event emission cannot be validated locally (the same
  WebView2 DLL issue blocks the local Tauri test binary), making the risk/benefit
  unfavorable for now. The blocking-return path is the source of truth; streaming
  can be layered on later behind the same `searchInFiles` surface.
- Include/exclude globs, whole-word matching, and replace-in-files.

## Related

- ADR 004 — Repo Explorer tile.
- ADR 011 — Non-blocking worktree provisioning (same off-the-main-thread
  principle for long-running work).
