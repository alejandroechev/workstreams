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
   model: `author` (`reviewer` | `agent`), `parent_id` (reply threading),
   `status` (`open` | `addressed` | `resolved` | `wontfix`), plus `anchor_text`
   for future drift detection.

2. **In-app UI** — the Repo Explorer file viewer (`FileEditorView`) renders each
   reviewer note as a Monaco view zone below its anchor, with the threaded
   **agent replies** nested inside the same zone. The reviewer's own note gets
   inline **Edit / Delete** buttons and a **Resolve / Reopen** toggle; resolved
   / wontfix notes are struck through. Add is selection-based: select lines →
   floating `+ Comment` → inline composer. The toggle state persists per
   workstream via the `settings` table. No polling — the tile reloads from
   session.db when the file is (re)opened or the toggle is turned on.

3. **Agent loop** — the agent reads and writes `file_comments` directly with its
   built-in `sql` tool, guided by the **`file-comments` companion skill**
   (sibling of `code-review`). Role rule: the agent never edits reviewer notes;
   it replies as `author='agent'` with `parent_id`, and marks the reviewer note
   `addressed` or `wontfix` (never `resolved` — that is reviewer-only).

### Why these choices

| Choice | Rationale |
|---|---|
| session.db, not workstreams.db | Unifies with Code Review (ADR 014); lets the agent read/reply with its own `sql` tool, no cross-DB plumbing. |
| Repo-relative `file` key | Portable across machines/worktrees and matches what the agent edits; the tile converts absolute paths via `toRepoRelative(rootDir, path)`. |
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
  author TEXT NOT NULL,                -- 'reviewer' | 'agent'
  parent_id TEXT,                      -- reply threading
  status TEXT NOT NULL DEFAULT 'open', -- open | addressed | resolved | wontfix
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_file_comments_ws_file
  ON file_comments(workstream_id, file, anchor_line_start);
```

### Tauri commands

Implemented in `code_review::file_comments` (opens the bound session.db RW and
ensures the `file_comments` schema on each call):

- `list_session_file_comments(workstream_id, file) -> FileComment[]`
- `add_session_file_comment(workstream_id, file, anchor_line_start,
  anchor_line_end, anchor_text?, body) -> FileComment` (author=`reviewer`,
  status=`open`)
- `reply_session_file_comment(workstream_id, parent_id, body) -> FileComment`
  (author=`agent`)
- `update_session_file_comment(workstream_id, id, body) -> FileComment`
  (reviewer notes only)
- `set_session_file_comment_status(workstream_id, id, status) -> FileComment`
- `delete_session_file_comment(workstream_id, id)` (reviewer note + cascade its
  agent replies)

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
- **E2E (real Monaco)**: the `comment-zone` harness case + `comment-interactivity`
  spec assert the reviewer note + threaded agent reply render and that Edit /
  Resolve are clickable (not occluded by Monaco layers).

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
