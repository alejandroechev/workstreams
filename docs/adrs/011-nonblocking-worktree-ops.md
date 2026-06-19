# ADR 011 — Non-blocking worktree provisioning with the sidebar row as progress UI

## Status

Accepted (2026-06-19).

## Context

Creating a workstream pulls latest `master` and runs `git worktree add`;
archiving removes the worktree with `git worktree remove`. These commands were
exposed as synchronous `#[tauri::command]` functions. On Tauri v2 a sync
command runs on the **main thread**, which is also the WebView's UI thread — so
while git ran, the entire app froze. The create path was worse: it showed a
blocking loading overlay, so the user could not touch any *other* workstream
while one was provisioning, and a slow/stuck pull hung the whole window.

We wanted:

- git work to never block the UI thread,
- provisioning of one workstream not to block work on any other,
- progress and failures to be visible without a modal, and
- no permanently-stuck "ghost" rows if the app dies mid-operation.

## Decision

**Run the git work on a background thread and drive a per-row state machine
from id-keyed Tauri events. The sidebar row itself is the progress UI.**

### Backend (`src-tauri/src/lib.rs`)

- `create_worktree` / `remove_worktree` are now fire-and-forget: they
  `std::thread::spawn` with an owned `AppHandle` clone and return immediately.
  The real work lives in `create_worktree_inner` / `remove_worktree_inner`
  (also reused by `change_workstream_worktree`).
- The worker emits `worktree-progress` events carrying
  `{ workstreamId, op: "create" | "archive", phase, detail, status:
  "running" | "done" | "error" }`. A terminal (`done` / `error`) event is
  **always** emitted, even on error paths.
- `derive_worktree_path` is a fast, pure command (shares
  `derive_worktree_folder_name`) so the frontend can compute the target path
  up front and create the DB row *before* any git runs.

### Frontend

- The path is derived up front; the workstream row is inserted immediately in a
  `creating` state, then the background op is fired.
- A pure, total reducer (`src/domain/worktree-provisioning.ts`,
  `applyWorktreeEvent`) maps events to lifecycle states:
  `creating → active` (done) or `create_failed` (error);
  `archiving → archived` (done; archive-delete error still archives, with a
  retryable warning). Terminal states ignore further events.
- `WorkstreamStatus` gains `creating | create_failed | archiving`.
  `workstreams.status` is free-text (no CHECK constraint), so no DB migration
  is needed.

### The row is the UI

- A `creating` row shows a spinner + current phase and is **not selectable**
  (click is a no-op); there is **no auto-select** when it becomes ready.
- A `create_failed` row stays in the active list with inline Retry / Discard.
- An `archiving` row lives in the archived list with a spinner; a failed
  worktree delete shows a warning + Retry.
- No blocking overlay or alert anywhere in these flows.

### Robustness

- A per-workstream in-flight guard prevents duplicate/concurrent fire of the
  same op.
- On startup, transient states left by a previous run are reconciled: a
  `creating` row is promoted to `active` if its directory is now a valid
  worktree (`detect_worktree_info`), else marked `create_failed`; an
  `archiving` row re-attempts the background removal.

## Consequences

- The UI never freezes during git; other workstreams remain fully usable while
  one provisions or archives.
- Status transitions are unit-testable in isolation (the reducer and path
  deriver are pure); E2E uses an in-memory event-bus shim
  (`src/test-shims/tauri-event-shim.ts`) to exercise the emit→listen contract.
- **Retry-after-restart caveat**: provisioning parameters are not persisted, so
  a reconciled `create_failed` row can only be *Discarded* — Retry no-ops and
  the message says so. Acceptable because the worktree dir either exists (then
  it reconciles to `active`) or it doesn't (Discard and re-create).
- New states are free-text only; any code that pattern-matches
  `WorkstreamStatus` must handle the three new variants (selection gating, list
  partitioning, sidebar rendering already do).
