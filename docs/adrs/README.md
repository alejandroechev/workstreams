# Architecture Decision Records

The substantial design decisions behind Workstreams live here. They are
**contributor-facing**: they exist to give context to anyone reading the code,
not to document how to use the app. For that, see the
[README](../../README.md) and the [features deep dive](../features-detailed.md).

Records are never deleted. When a decision stops holding, its status changes to
**Retired** or **Superseded by ADR NNN**, and it keeps a link forward to
whatever replaced it — the history is the point.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-workstream-tiling-architecture.md) | Workstream + tiling architecture — the core domain model and count-driven adaptive layout | Accepted |
| [002](002-discipline-enforcement.md) | Discipline enforcement via a 5-layer defense of hooks, CI, and audits | Accepted |
| [003](003-cdp-feature-validation.md) | Per-feature CDP visual validation against the running Tauri app | Accepted |
| [004](004-playwright-e2e.md) | Playwright E2E via the Vite dev server with a Tauri host shim | Accepted |
| [005](005-repo-create-vs-import.md) | Separate repo *create* and *import* flows | Accepted |
| [006](006-editable-text-files.md) | Editable text files in tile file-detail panes, with conflict detection | Accepted |
| [007](007-diff-grok-integration.md) | diff-grok review skill + Diff Review tile | **Retired** (2026-07-08) → [014](014-code-review-tile.md) |
| [008](008-mcp-bridge-for-skills.md) | MCP bridge for Copilot CLI skills | **Retired** (2026-07-08) |
| [009](009-inline-file-comments.md) | Inline file comments in the session DB, with a reviewer↔agent model | Rewritten (2026-07-08) |
| [010](010-feature-flags.md) | Feature flags for optional tiles | Accepted |
| [011](011-nonblocking-worktree-ops.md) | Non-blocking worktree provisioning, with the sidebar row as progress UI | Accepted |
| [012](012-repo-content-search.md) | Repo Explorer content search — off-thread "search all files" | Accepted |
| [013](013-local-agent-review.md) | Local agent review over MCP and the Workstreams DB | **Superseded by [014](014-code-review-tile.md)** |
| [014](014-code-review-tile.md) | Code Review tile — diff-first, session-DB backed, MCP-free | Accepted |
| [015](015-interactive-monaco-zones.md) | Interactive Monaco view zones + a UI-bug reproduction harness | Accepted |
| [016](016-macos-support.md) | macOS support on Apple Silicon, unsigned and un-notarised | Accepted |
| [017](017-macos-gui-launch-path.md) | Repair the GUI-launch environment on macOS (`PATH`, `TERM`) | Accepted |
| [018](018-code-walkthrough-debugger.md) | Code walkthrough — recorded execution traces for reading code | Accepted |
| [019](019-sidebar-status-sections.md) | Sidebar status sections derived from runtime state, not stored status | Accepted |
| [020](020-task-board-devlog-export.md) | Task board, labels, event log, and devlog export | Accepted |
| [021](021-manual-coding-goal-loop.md) | Manual coding goal loop — a bounded orchestrator→worker pipeline | Accepted |
| [022](022-versioned-loop-definitions.md) | Session-stored YAML loop definitions, pinned per run by hash | Accepted |
| [023](023-human-loop-approval.md) | Human approval as a first-class loop sensor | Accepted |
| [024](024-repo-explorer-tile.md) | Repo Explorer tile — multi-tab browsing, search, and font resize | Accepted |

## Writing a new ADR

Write one for a decision that is expensive to reverse, constrains later work, or
that a future reader would otherwise have to reconstruct from the diff. Routine
implementation choices do not need one.

1. Copy the shape of a recent record: **Title**, **Status**, **Context**,
   **Decision**, **Consequences**. Record what you *rejected* and why — that is
   usually the part worth keeping.
2. **Do not assign a number while the work is in flight.** Take the next free
   number when you are ready to commit, so two parallel branches cannot claim
   the same one. (ADRs 004 and 024 collided exactly this way and had to be
   renumbered later.)
3. Add a row to the index above.
4. If it replaces an existing decision, set the old record's status to
   *Superseded by ADR NNN* and link forward to the new one.

Statuses currently in use: **Accepted**, **Retired**, **Rewritten**, and
**Superseded by ADR NNN**. Their formatting is not yet consistent across the
older records; normalising them is tracked separately.
