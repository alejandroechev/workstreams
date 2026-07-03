---
name: code-review
description: 'Respond to a local code review from the Workstreams Code Review tile. The reviewer left inline comments on a diff; those comments live in review_comments inside your own Copilot session.db. Use your built-in sql tool (no MCP) to read the open reviewer comments, fix the code, reply, and mark each addressed or wontfix. Trigger phrases - "review the comments", "address the review", "respond to the code review", "look at my review comments", "handle the code review tile comments".'
---

# Code Review (agent side)

The Workstreams **Code Review tile** lets a reviewer look at a git diff and leave
inline comments. Those comments are stored in **your own** Copilot
`session.db` (the SQLite DB you already query with the built-in `sql` tool) — in
two tables, `reviews` and `review_comments`. There is **no MCP**: you read and
write these tables directly with `sql`, and the tile polls the DB to show your
replies. See ADR 014 in the workstreams repo for the full design.

## When to run

Trigger when the user says any of: "review the comments", "address the review",
"respond to the code review", "look at my review comments", "handle the code
review tile comments", or asks you to act on the Code Review tile.

## Schema (already created by the tile — do NOT create or drop these)

```sql
-- one row per review session
reviews(
  id, workstream_id, diff_source,   -- 'working_tree' | 'last_commit' | 'branch'
  base_ref, title,
  status,                            -- 'open' | 'completed'
  created_at, updated_at, completed_at
);

-- inline comments + threaded replies
review_comments(
  id, review_id,
  file,                             -- repo-relative path
  line,                             -- new-side line (old-side for pure deletions)
  side,                             -- 'new' | 'old'
  code,                             -- anchored line text (context)
  hunk_header,                      -- '@@ -a,b +c,d @@' for locating the change
  body,                             -- markdown
  author,                           -- 'reviewer' | 'agent'
  parent_id,                        -- reply threading (points at the comment you answer)
  status,                           -- 'open' | 'addressed' | 'resolved' | 'wontfix'
  created_at, updated_at
);
```

## The contract

You never touch the CLI's own tables (`todos`, `plans`, …). You only read/write
`reviews` and `review_comments`.

### Role rule (important)

- `author = 'reviewer'` rows are the human's comments. **Never edit their body.**
- Your replies are `author = 'agent'` rows with `parent_id` = the reviewer
  comment you are answering.
- You may set a comment's `status` to **`addressed`** (you made the change) or
  **`wontfix`** (you disagree — always leave a reply explaining why).
- You must **never** set `status = 'resolved'`. `resolved` is reviewer-only; it
  means the human accepted your response.

## Workflow

### 1. Find the active review and its open reviewer comments

```sql
-- newest review (the tile shows the latest-created open one)
SELECT id, diff_source, base_ref, status FROM reviews
ORDER BY created_at DESC LIMIT 1;

-- open comments the reviewer is waiting on
SELECT id, review_id, file, line, side, code, hunk_header, body
FROM review_comments
WHERE status = 'open' AND author = 'reviewer'
ORDER BY file, line;
```

If there are zero open reviewer comments, tell the user there is nothing to
address and stop.

### 2. For each open reviewer comment

1. Open `file` and locate `line` (use `hunk_header` + `code` to disambiguate if
   the file shifted since the diff was taken). For `working_tree` reviews the
   modified side **is** the on-disk file, so you can edit it directly; for
   `last_commit` / `branch` reviews the diff is historical — make the equivalent
   change in the current working tree.
2. Make the requested code change (or decide it is a `wontfix`).
3. Insert your reply, threaded under the reviewer comment. Generate a unique id
   (e.g. a uuid or `agent-<timestamp>`), copy `review_id`/`file`/`line`/`side`
   from the parent, and use ISO-8601 timestamps:

```sql
INSERT INTO review_comments
  (id, review_id, file, line, side, code, hunk_header, body, author, parent_id, status, created_at, updated_at)
VALUES
  ('<new-id>', '<review_id>', '<file>', <line>, '<side>', NULL, NULL,
   'Done — removed the leftover debug comment.', 'agent', '<parent_id>', 'open',
   '<now-iso>', '<now-iso>');
```

4. Update the reviewer comment's status (this is the parent row):

```sql
UPDATE review_comments
SET status = 'addressed', updated_at = '<now-iso>'
WHERE id = '<parent_id>';
-- or status = 'wontfix' if you are declining (leave a reply explaining why)
```

### 3. Report

After processing all open comments, summarize to the user: how many you
addressed, how many you marked `wontfix` (with reasons), and which files you
changed. The reviewer will see your replies appear in the tile (it polls) and
will either `resolve` each thread or reopen it with a follow-up comment.

## Notes

- Keep each `sql` write small; the tile may be polling the same DB. The tile
  opens the DB with a busy_timeout, so brief contention is fine.
- Use ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`) for `created_at` / `updated_at`.
- Do not mark a review `completed` — that is the reviewer's action from the tile.
- If a reviewer comment is ambiguous, prefer a `wontfix` reply asking for
  clarification over guessing at a destructive change.
