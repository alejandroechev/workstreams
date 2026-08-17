# ADR 009: Inline file comments (session.db, reviewer↔agent)

## Status

**Rewritten (2026-07-08, unify-commenting).** The original v1 design (a
`file_comments` table in `workstreams.db`, hardcoded `author='me'`, and
agent-driven **ADO PR import** via the `import_pr_comments` MCP tool) has been
retired. Inline file comments now live in the **bound Copilot session's
`session.db`** and use the same **reviewer↔agent reply/status model** as the
Code Review tile (ADR 014), read/written by the agent with its built-in `sql`
tool — **no MCP, no ADO import**. This ADR describes the current design; the
"## Superseded v1" section at the end preserves the original for history.

## Context

Within a Workstreams workstream we want a place to jot inline notes on any file
the Repo Explorer shows, anchored next to the lines they reference, and — the
new part — to let the **Copilot agent running in the bound session reply to
those notes and mark them addressed**, exactly like the Code Review tile does
for diff comments. Previously the two features diverged: Code Review stored its
comments in the session.db with an agent reply loop, while Repo Explorer stored
private notes in `workstreams.db` with an ADO-import path and no agent
interaction. unify-commenting collapses that divergence.

## Decision

1. **Storage** — a `file_comments` table in the **bound session's `session.db`**
   (the same DB the Code Review tile uses), *not* `workstreams.db`. A linked
   Copilot session is a prerequisite: with no bound session the Repo Explorer
   comment toggle is disabled with a prompt, mirroring the Code Review tile.
   Comments are keyed by **repo-relative `file`** + line range so they are
   portable and match what the agent sees. Columns carry the reviewer↔agent
   model: `author`, `parent_id` (reply threading),
   `status` (`open` | `addressed` | `resolved` | `wontfix`), plus `anchor_text`
   for future drift detection.

   **`author` is an open string, not an enum.** `reviewer` (this user, the only
   mutable/deletable case) and `agent` are well-known aliases; importers such as
   the `ado-file-comments` skill store the external reviewer's **display name**
   (e.g. `Eduardo Fernandez`), which the UI renders verbatim. Treating the
   column as `reviewer | agent` attributed every imported comment to this user.

   **Timestamps are ISO-8601 UTC** (`YYYY-MM-DDTHH:MM:SSZ`) across every writer.
   The tile previously wrote Unix seconds while agents and importers wrote
   ISO-8601; because both `ORDER BY created_at` (TEXT) and the UI's string
   compare are lexicographic, every epoch row sorted before every ISO row and a
   tile-written reply rendered above the earlier agent reply it answered. Rows
   predating this fix keep the legacy format, so ordering normalizes both shapes
   on **both** sides: `list_file_comments_rows` casts each row to epoch seconds
   in SQL (so the agent's own `sql` reads are ordered too), and
   `src/domain/comment-order.ts` does the same in TS (shared by the editor layer
   and the in-memory backend). `npm run file-comments:smoke` is the CLI-parity
   check for this loop.

2. **Comments tab (cross-file navigation)** — a fifth Repo Explorer tab lists
   **every** comment in the workstream, grouped by file, one row per thread root
   (author, line, snippet, reply count). Clicking a row opens that file in the
   right pane with comments on and reveals the anchor line, reusing the same
   `initialRevealLine` channel the Search tab and code walkthrough already use;
   the clicked thread's view zone is marked `data-focused`. The left pane is
   deliberately **navigation-only** — reply/resolve/edit stay in the view zone
   so there is one code path for mutations. Resolved/wontfix threads remain
   listed (dimmed, struck through); the status filter decides visibility.
   Drifted anchors (where `anchor_text` no longer matches the file at the stored
   line) are **badged but still navigable** — re-anchoring is out of scope.
   Backed by `list_session_file_comments_all(workstream_id)`, which mirrors the
   per-file query including its `CREATED_AT_ORDER` key. Comments are always on
   inside this tab, and it never mutates the show/hide preference the
   Files/Diff tabs share.

3. **In-app UI** — both the Repo Explorer file viewer (`FileEditorView`) and
   the **modified side of its Unstaged diff** render each reviewer note as a
   Monaco view zone below its anchor, with threaded replies nested inside the
   same zone. `FileCommentsLayer` owns this shared Monaco interaction so the two
   surfaces cannot drift. The reviewer's own note gets inline **Edit / Delete**
   buttons, a **Resolve / Reopen** toggle, a **Reply** button (adds a reviewer
   reply through an inline composer), and a **Copy** button (copies the whole
   thread as text — a reliable fallback since view-zone text can be awkward to
   drag-select). Resolved / wontfix notes are struck through. New comments are
   selection-based: select lines → floating `+ Comment` → inline composer.
   Because both surfaces use the same repo-relative file key, a comment created
   in the diff also appears when that file is opened normally.

   Diff comments are deliberately limited to non-deleted files in `unstaged`.
   Last Commit and Branch vs master show historical blobs rather than a working
   file, while a deleted file has no modified-side lines to anchor. The toggle
   state persists per workstream via the `settings` table. No polling — the tile
   reloads from session.db when the file is (re)opened, the selected diff file
   changes, or the toggle is turned on.

   Comment mutations expose pending and error state in the composer. A list
   request that started before an INSERT is invalidated so its stale response
   cannot erase the newly created thread from the UI.

4. **Agent loop** — the agent reads and writes `file_comments` directly with its
   built-in `sql` tool, guided by the **`file-comments` companion skill**
   (sibling of `code-review`). Role rule: the agent never edits reviewer notes;
   it replies as `author='agent'` with `parent_id`, and marks the reviewer note
   `addressed` or `wontfix` (never `resolved` — that is reviewer-only). The
   in-app **Reply** UI is the reviewer's side of the same thread: it authors
   `reviewer` replies (editable/deletable like any reviewer comment), so the
   `reply_session_file_comment` command is reviewer-only; the agent never uses
   it (it inserts `agent` rows via raw SQL).

### Why these choices

| Choice | Rationale |
|---|---|
| session.db, not workstreams.db | Unifies with Code Review (ADR 014); lets the agent read/reply with its own `sql` tool, no cross-DB plumbing. |
| Repo-relative `file` key | Portable across machines/worktrees and matches what the agent edits; the tile converts absolute paths via `toRepoRelative(rootDir, path)`. |
| One `FileCommentsLayer` for file + diff editors | Keeps view zones, composers, thread actions, height measurement, and interactive-zone behavior identical while allowing each host to own its Monaco instance. |
| Reviewer↔agent columns (author/parent_id/status) | Same model as `review_comments`; enables the reply/resolve loop and a shared mental model across both features. |
| No polling — reload on open/toggle | unify-commenting removed background polling everywhere; the reviewer refreshes on demand (Repo Explorer by reopening; Code Review via a Sync button). |
| No ADO import, no MCP | The `import_pr_comments` MCP tool + `workstreams-mcp` bridge were removed; the agent's native `sql` access replaces them. |
| Linked-session prerequisite | Comments are agent-collaborative; without a bound session there is no agent to reply, so the toggle is disabled with a prompt. |

### Schema (session.db)

```sql
CREATE TABLE file_comments (
  id TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL,
  file TEXT NOT NULL,                  -- repo-relative path
  anchor_line_start INTEGER NOT NULL,
  anchor_line_end INTEGER NOT NULL,
  anchor_text TEXT,                    -- drift snapshot of the anchored lines
  body TEXT NOT NULL,                  -- markdown
  author TEXT NOT NULL,                -- 'reviewer' | 'agent' | imported display name
  parent_id TEXT,                      -- reply threading
  status TEXT NOT NULL DEFAULT 'open', -- open | addressed | resolved | wontfix
  created_at TEXT NOT NULL,            -- ISO-8601 UTC (legacy rows: epoch seconds)
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_file_comments_ws_file
  ON file_comments(workstream_id, file, anchor_line_start);
```

### Tauri commands

Implemented in `code_review::file_comments` (opens the bound session.db RW and
ensures the `file_comments` schema on each call):

- `list_session_file_comments(workstream_id, file) -> FileComment[]`
- `list_session_file_comments_all(workstream_id) -> FileComment[]` (Comments
  tab; every file, replies included, same ordering key)
- `add_session_file_comment(workstream_id, file, anchor_line_start,
  anchor_line_end, anchor_text?, body) -> FileComment` (author=`reviewer`,
  status=`open`)
- `reply_session_file_comment(workstream_id, parent_id, body) -> FileComment`
  (author=`reviewer` — backs the in-file Reply UI; the agent inserts `agent`
  replies via raw SQL, not this command)
- `update_session_file_comment(workstream_id, id, body) -> FileComment`
  (reviewer-authored comments only — notes and reviewer replies)
- `set_session_file_comment_status(workstream_id, id, status) -> FileComment`
- `delete_session_file_comment(workstream_id, id)` (reviewer note + cascade its
  replies; reviewer replies also deletable individually). Gated on the **root**
  being reviewer-authored, so an imported third-party thread is never partially
  deleted — the earlier predicate removed a non-reviewer root's replies while
  keeping the root itself.

## Consequences

**Positive**
- One coherent reviewer↔agent commenting model across Code Review (diffs) and
  Repo Explorer (whole files); one mental model, one companion-skill pattern.
- The agent participates directly via `sql` — no MCP server to install or keep
  in sync, no ADO PAT storage in the app.
- Repo-relative keys make comments portable.

**Negative**
- A linked Copilot session is now required to comment (previously notes worked
  standalone). Acceptable: the feature's value is the agent loop.
- Naive line-number anchoring still drifts when files are edited above the
  anchor; `anchor_text` remains groundwork for drift detection.
- Bodies render as plaintext (`textContent`) inside the Monaco view zone to
  avoid React rendering there; a future upgrade can portal `MarkdownView` in.

## Validation

- **Unit (Rust)**: `code_review::file_comments::tests` cover ordering, workstream
  isolation, reply threading, reviewer-only edit, and delete cascade.
- **Unit (TS)**: MemoryBackend session-file-comment cases, `useFileComments`
  hook cases (incl. repo-relative keying + session-required error),
  `comments-layer` thread/height/status helpers, `toRepoRelative` cases, and a
  session-gated RepoExplorer toggle test.
- **Integration**: TauriBackend invoke-shape test for the 6 session commands.
- **E2E (real Monaco)**: the `comment-zone` and `diff-comment-zone` harness
  cases + `comment-interactivity` spec assert file and Unstaged-diff threads
  render and that Edit / Resolve are clickable (not occluded by Monaco layers).

---

## Superseded v1 (historical)

The original design stored comments in a `file_comments` table in
`workstreams.db` keyed by **absolute path**, hardcoded `author='me'`, marked
comments `origin_type` `user` | `ado-pr`, and imported Azure DevOps PR comments
through an `import_pr_comments` MCP tool exposed by `workstreams-mcp` (the ADR
008 bridge), deduped via a partial unique index on
`(origin_type='ado-pr', origin_pr_id, origin_comment_id)`. Imported comments
were read-only with an "open in ADO" link. That whole surface — the
workstreams.db table, the 5 Tauri commands, the MCP tool, and the ADO-import UI
— was removed by unify-commenting (2026-07-08). Existing `workstreams.db`
`file_comments` tables are left in place non-destructively on already-migrated
DBs but are no longer created or read.
