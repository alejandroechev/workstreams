---
name: file-comments
description: 'Respond to inline file comments left in the Workstreams Repo Explorer. The reviewer selected lines in a file and left comments; those comments live in the file_comments table inside your own Copilot session.db. Use your built-in sql tool (no MCP) to read the open reviewer comments, fix the code, reply, and mark each addressed or wontfix. Trigger phrases - "address my file comments", "look at my inline notes", "respond to the repo comments", "handle the file comments", "check my inline comments".'
---

# File Comments (agent side)

The Workstreams **Repo Explorer** lets a reviewer open any file, select one or
more lines, and leave an inline comment. Those comments are stored in **your
own** Copilot `session.db` (the SQLite DB you already query with the built-in
`sql` tool) — in a single table, `file_comments`. There is **no MCP**: you read
and write this table directly with `sql`, and the tile re-reads the DB when the
file is reopened (or the reviewer toggles comments) to show your replies. This
mirrors the Code Review tile's reviewer↔agent model (see ADR 009 / ADR 014 in
the workstreams repo).

## When to run

Trigger when the user says any of: "address my file comments", "look at my
inline notes", "respond to the repo comments", "handle the file comments",
"check my inline comments", or asks you to act on Repo Explorer comments.

## Schema (already created by the tile — do NOT create or drop this)

```sql
file_comments(
  id,                 -- TEXT primary key
  workstream_id,      -- which workstream the note belongs to
  file,               -- repo-relative path (e.g. 'src/app.ts')
  anchor_line_start,  -- 1-based first line of the selection
  anchor_line_end,    -- 1-based last line of the selection
  anchor_text,        -- snapshot of the anchored lines (drift detection)
  body,               -- markdown
  author,             -- 'reviewer' | 'agent'
  parent_id,          -- reply threading (points at the comment you answer)
  status,             -- 'open' | 'addressed' | 'resolved' | 'wontfix'
  created_at, updated_at
);
```

## The contract

You never touch the CLI's own tables (`todos`, `plans`, …) or the Code Review
tables (`reviews`, `review_comments`). You only read/write `file_comments`.

### Role rule (important)

- `author = 'reviewer'` rows are the human's comments. **Never edit their body.**
- Your replies are `author = 'agent'` rows with `parent_id` = the reviewer
  comment you are answering.
- You may set a reviewer comment's `status` to **`addressed`** (you made the
  change) or **`wontfix`** (you disagree — always leave a reply explaining why).
- You must **never** set `status = 'resolved'`. `resolved` is reviewer-only; it
  means the human accepted your response.

## Workflow

### 1. Find the open reviewer comments

```sql
SELECT id, workstream_id, file, anchor_line_start, anchor_line_end, anchor_text, body
FROM file_comments
WHERE status = 'open' AND author = 'reviewer'
ORDER BY file, anchor_line_start;
```

If there are zero open reviewer comments, tell the user there is nothing to
address and stop.

### 2. For each open reviewer comment

1. Open `file` (a repo-relative path — resolve it against the workstream's repo
   root) and locate the lines `anchor_line_start`..`anchor_line_end`. Use
   `anchor_text` to disambiguate if the file shifted since the comment was left.
   The Repo Explorer edits the on-disk working tree, so you edit the file
   directly.
2. Make the requested code change (or decide it is a `wontfix`).
3. Insert your reply, threaded under the reviewer comment. Generate a unique id
   (e.g. a uuid or `agent-<timestamp>`), copy `workstream_id`/`file`/
   `anchor_line_start`/`anchor_line_end` from the parent, and use ISO-8601
   timestamps:

```sql
INSERT INTO file_comments
  (id, workstream_id, file, anchor_line_start, anchor_line_end, anchor_text,
   body, author, parent_id, status, created_at, updated_at)
VALUES
  ('<new-id>', '<workstream_id>', '<file>', <start>, <end>, NULL,
   'Done — renamed `b` to `count`.', 'agent', '<parent_id>', 'open',
   '<now-iso>', '<now-iso>');
```

4. Update the reviewer comment's status (this is the parent row):

```sql
UPDATE file_comments
SET status = 'addressed', updated_at = '<now-iso>'
WHERE id = '<parent_id>';
-- or status = 'wontfix' if you are declining (leave a reply explaining why)
```

### 3. Report

After processing all open comments, summarize to the user: how many you
addressed, how many you marked `wontfix` (with reasons), and which files you
changed. The reviewer will see your replies appear inline the next time they
open the file (or toggle comments) and will either `resolve` each thread or
reopen it with a follow-up comment.

## Notes

- Keep each `sql` write small; the tile may read the same DB. The tile opens the
  DB with a busy_timeout, so brief contention is fine.
- Use ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`) for `created_at` / `updated_at`.
- Comments are keyed by repo-relative `file` + line range — do not rewrite the
  reviewer's `anchor_*` columns.
- If a reviewer comment is ambiguous, prefer a `wontfix` reply asking for
  clarification over guessing at a destructive change.
