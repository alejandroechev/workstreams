# ADR 014: Code Review Tile (diff-first, session-DB backed, MCP-free)

## Status
Accepted. **Supersedes ADR 013 (Local Agent Review).**

## Date
2026-07-03

## Context

Reviewing code — whether an AI agent wrote it or a human did — should feel like
a **local PR review**: pick what to review, see the real diff, comment inline on
the diff, hand the comments to the agent, see its replies — and often **edit the
code in place** ("I just saw this added line, delete it") without leaving the
diff. ADR 013's first attempt (`local-agent-review`) missed this: it was
**ungrounded** (hand-typed file/line/body, no diff) and **overcomplicated** (MCP
tools + Workstreams-DB storage, a round/anchor trackability engine). It has been
**retired** before general use.

Two load-bearing unknowns were spiked to **GO**
(`session-state/.../files/features/code-review-tile/spikes/FINDINGS.md`):
1. The app (rusqlite) can `CREATE`/`INSERT`/`UPDATE` in the **live CLI-owned
   `session.db`** under write contention — `busy_timeout` blocked 846 ms then
   succeeded (no `SQLITE_BUSY`); writes are visible both directions; the CLI's
   own tables are untouched.
2. Monaco's `DiffEditor` supports inline comment **view zones** + a "＋ Comment"
   content widget on the **modified** side, anchored to new-side lines.

## Decision

1. **New `code_review` tile** ("Code Review", `Alt+A`). Works for **any** diff,
   human- or agent-written. A first-class diff + inline-comments viewer even
   with no agent involved.

2. **Reuse the existing diff stack.** `git_diff_files` / `git_diff_file` /
   `git_diff_file_sides` / `git_diff_files_with_status` (the Repo Explorer Diff
   tab), extended to accept an **arbitrary base ref**. Diff sources:
   `working_tree` | `last_commit` | `branch` (vs a chosen base). The diff is
   **recomputed live from git on open** (no snapshot).

3. **Render** with a side-by-side Monaco `DiffEditor` (`parseDiffToSides`).
   Inline comment threads are **view zones** on `getModifiedEditor()`, anchored
   to the **new-side line** (old-side for pure deletions), with a "＋ Comment"
   affordance on line selection — the ADR 009 view-zone technique retargeted to
   the diff editor.

4. **In-place editing (v1 core).** When the modified side maps to the on-disk
   **working file**, the modified editor is **editable** and backed by the
   shared `FileBufferRegistry` buffer, so edits save through the same
   Ctrl+S / autosave / dirty-`*` path as any file, and Monaco re-diffs live as
   you type. Read-only when the modified side is historical (not the working
   file). `originalEditable` stays false.

5. **Storage in the bound session's `session.db` — no MCP.** Two tables,
   `reviews` and `review_comments`, are created **in the Copilot session's
   `~/.copilot/session-state/<session-id>/session.db`** (schema below). The app
   opens it **read-write** with a busy timeout and only ever touches these two
   tables. The **agent reads/replies with its own native `sql` tool**; the tile
   **polls** the tables for the agent's writes. This is why there is no MCP and
   no Workstreams-DB round-trip for the conversation.

6. **Session binding.** A review targets the workstream's bound Copilot
   session, read from the `copilot_session` tile's `config_json`
   (`copilot_session_id`, or legacy `resume_by_id`) — the same source that
   drives the tile's "Linked" badge — preferring the **pinned** session tile,
   then the most-recently-updated one (falling back to the
   `copilot_session_links` enrichment table). A linked session is a
   **prerequisite**; with none, the tile disables commenting and prompts the
   user to open a session. Choosing among multiple sessions is v2.

7. **Active review.** On open, the tile loads the **latest-created** `reviews`
   row for the bound session + its comments. "New review" creates another.
   Multi-review browsing is v2.

8. **Roles.** Reviewer creates comments and `resolve`/`reopen`s; the agent
   replies and sets `addressed`/`wontfix`. Soft enforcement (no MCP boundary —
   it's the user's own agent). The tile only writes reviewer rows and reads
   agent rows.

9. **Completion.** A review's `status` flips `open` → `completed` via a
   **Complete** button (state + visual only). No summary/export in v1.

10. **Dispatch via a user-level skill.** A small skill teaches the agent the
    `review_comments` SQL contract (select open reviewer comments, edit code,
    insert a reply row + update status).

11. **Out of scope for v1:** round-to-round trackability / surviving-edits;
    cross-file rename following; ADO/GitHub write-back; multiple concurrent
    reviews per tile; templates; @mentions; hard role enforcement; export/summary;
    unified (vs side-by-side) diff toggle; old-side commenting except pure
    deletions.

## Schema (created in the bound session's `session.db`)

```sql
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    workstream_id TEXT NOT NULL,
    diff_source TEXT NOT NULL,             -- 'working_tree' | 'last_commit' | 'branch'
    base_ref TEXT,                         -- e.g. 'master' (null for working_tree/last_commit)
    title TEXT,
    status TEXT NOT NULL DEFAULT 'open',    -- 'open' | 'completed'
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS review_comments (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    file TEXT NOT NULL,                    -- repo-relative path
    line INTEGER NOT NULL,                 -- new-side line (old-side for pure deletions)
    side TEXT NOT NULL DEFAULT 'new',
    code TEXT,                             -- anchored line text (context)
    hunk_header TEXT,                      -- '@@ -a,b +c,d @@' for agent locatability
    body TEXT NOT NULL,                    -- markdown
    author TEXT NOT NULL,                  -- 'reviewer' | 'agent'
    parent_id TEXT,                        -- reply threading
    status TEXT NOT NULL DEFAULT 'open',   -- open | addressed | resolved | wontfix
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_comments_review
    ON review_comments(review_id, file, line);
```

Access is via `src-tauri/src/code_review`:
`open_session_db_rw(session_id)` opens the session DB read-write with a 5 s
`busy_timeout` and calls `ensure_review_schema` (idempotent). We never create or
mutate the Copilot CLI's own tables (`todos`, `plans`, etc.).

## The agent contract (no MCP)

The agent uses its built-in `sql` tool against its own `session.db`:

```sql
-- see what to address
SELECT id, file, line, code, hunk_header, body FROM review_comments
WHERE status = 'open' AND author = 'reviewer' ORDER BY file, line;
-- reply + mark addressed
INSERT INTO review_comments (id, review_id, file, line, side, body, author, parent_id, status, created_at, updated_at)
VALUES (...,'agent',<parent_id>,'open', ...);
UPDATE review_comments SET status='addressed', updated_at=... WHERE id=<parent_id>;
```

A user-level skill packages this contract. The agent never sets `resolved`
(reviewer-only).

## Consequences

**Positive**
- Real PR-review UX locally; no ADO round-trips, no PR chatter, no MCP.
- The agent reaches comments natively via `sql`; the tile just polls.
- In-place edit closes the "review → open file → hunt for the line" gap.
- Reuses the diff stack + `FileBufferRegistry` + view-zone rendering.

**Negative**
- Comments live in one session's DB (scoped to that agent run); a new session =
  a new review. Acceptable for v1.
- In-place edit only valid when the modified side is the working file; historical
  diffs are read-only.
- Editing shifts line numbers → view-zone anchors can drift (fine for a snapshot
  review; re-anchor by eye / resolve).
- Writing into a CLL-owned DB needs discipline (busy_timeout, own tables only) —
  de-risked by the spike.

## Alternatives considered

- **Keep ADR 013's MCP + Workstreams-DB design.** Rejected: the MCP layer only
  existed because the agent couldn't reach the Workstreams DB; storing in the
  session DB removes the need entirely.
- **A separate `review.db` per session** the agent opens via shell `sqlite3`.
  Rejected: the agent's native `sql` tool already points at `session.db`, so a
  separate file is strictly more friction.
