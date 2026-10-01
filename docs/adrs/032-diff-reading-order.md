---
id: "032"
status: Accepted
date: 2026-10-01
---

# ADR 032: Agent-recommended reading order for Repo Explorer diffs

## Status

Accepted (2026-10-01).

## Context

The Repo Explorer diff lists changed files in path order. That is rarely the
order that explains a change: a reviewer wants the core idea first, the code
that implements it next, and each test beside the thing it proves. The
workstream's agent knows why the change was made and can say what that order
is. What was missing was somewhere to put the order, a way to know whether it
still matches the diff, and a way to sort by it.

Two existing patterns could carry agent output into the app:

- **Tables in the agent's own `session.db`**, which the agent writes with its
  `sql` tool (file comments, ADR 009; code review, ADR 014). Works on every
  platform, but the app cannot validate what the agent writes.
- **The agent channel** (`workstreams agent call`, ADR 026), where the app owns
  the schema and validates every write. Unix-socket only today.

## Decision

**The app owns the order; the agent proposes it.** A new `diff_orders` table in
the Workstreams DB, written only by the agent-channel command
`diff.order.set mode=<mode> [target=<branch>] paths=a,b,c`.

- **Keyed by (workstream, mode, target)**, latest only. The four diff modes
  are independent; Custom branch is keyed by its target. A workstream rather
  than a repo, because every diff mode is computed in the workstream's own
  working directory.
- **The app computes the diff itself on save**, using the same git queries as
  the diff view (`git_diff_files_with_status`, `git_diff_file_sides`), so the
  saved order and the list on screen agree on what "the diff" is. Untracked
  files, renames and `HEAD~1`-against-the-working-tree all come along for free.
- **The order must be exactly the changed files.** A save with unknown,
  missing or duplicated paths is rejected with an error naming each one. A
  partial order looks like a full one in the UI, and nobody would notice the
  skipped file.
- **Two fingerprints, both app-computed**: the file set (sorted path + status)
  and the content (both sides of every file). The agent never supplies them; a
  value computed by a different recipe would read as stale forever.
- **Only the workstream's own session can save.** The workstream comes from the
  caller's session token; there is no `ws=` override.
- **`diff.order.get` always returns `changed_files`**, the exact set a save is
  validated against, so the agent never reconstructs it from `git diff`.

**The diff view sorts; it never discards.** On each diff load the tile reads
the order and its freshness:

- `current` → sorted by the order.
- `content_changed` (same files, edited since) → still sorted by it, with a
  subtle marker. On the Unstaged diff any save would otherwise make the order
  vanish.
- `files_changed` → degraded, not dropped: surviving files keep their order,
  new files follow by path, removed files are gone, and an amber **stale** chip
  explains how to regenerate.

A **Recommended / Name** toggle defaults to Recommended whenever an order
exists. The choice is not persisted: a remembered "Name" would silently hide a
new order. Rows carry their 1-based position; the Code comments filter hides
rows without renumbering them. With no order, the toolbar names the prompt to
give the agent. An order saved while the diff is open applies at once through
the existing `state-changed` event.

The agent side is a user-level skill, `~/.copilot/skills/diff-order`, beside
`ws` and `file-comments`. The CLI scenario's drift checks now cover every
skill that uses the CLI, so a renamed command breaks a test rather than an
agent.

## Consequences

- **Not available on Windows** until the agent channel gets a Windows
  transport. Windows users see Name sort only. Accepted at design time with no
  requirement objecting.
- Saving and reading an order re-reads every changed file. Reads happen only
  when an order exists for that diff, and the UI read releases the DB lock
  before running git. A save runs inside the agent-channel dispatch, which
  holds the DB lock for its duration; a very large diff will briefly stall
  other commands.
- The order carries no rationale or grouping and keeps no history. Both were
  explicitly out of scope; adding them later means a new column or table, not
  a change to the fingerprint contract.
- The skill teaches a default heuristic (core, implementation, callers, each
  test after its subject, housekeeping last). The app does not enforce it; the
  agent may depart from it and say why.

## References

- [ADR 009: inline file comments](009-inline-file-comments.md)
- [ADR 014: Code Review tile](014-code-review-tile.md)
- [ADR 026: agent-driven workstreams and the agent channel](026-agent-driven-workstreams.md)
