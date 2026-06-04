# ADR 009: Inline file comments + agent-driven ADO PR import

## Status

Accepted (v1 — user comments + agent-driven import via MCP)

## Context

Code review feedback often lives outside the working tree: in PR comments,
chat threads, doc reviews, or just the reviewer's head. When the developer
finally sits down to address them, the comments are spread across several
tabs and there's no anchored view next to the actual lines being changed.

Within a Workstreams workstream we want a place to (a) jot inline notes on
any file the user views, (b) pull in PR review comments from Azure DevOps
PRs so they sit visually next to the code they reference, and (c) edit /
delete user notes as work progresses. Comments are private to the
workstream and never written back upstream — this isn't a PR client, it's
a scratchpad for the developer's own reading of code.

## Decision

Three layers:

1. **Storage** — `file_comments` table in the workstreams SQLite DB.
   Workstream-scoped, anchored to absolute path + line range (start..end).
   Origin column distinguishes user comments from imported ones; a partial
   `UNIQUE INDEX` on `(origin_type='ado-pr', origin_pr_id, origin_comment_id)`
   makes re-import idempotent for free, without blocking multiple user
   comments at the same anchor.

2. **In-app UI** — Repo Explorer file viewer renders comments as Monaco
   view zones below each comment's anchor line, when a toolbar icon (next
   to Edit/View) is toggled on. Selection-based add: the user selects one
   or more lines, a floating `+ Comment` button appears at the top-right
   of the editor host, click opens an inline composer (markdown textarea
   + Save / Cancel). User comments get inline Edit / Delete buttons;
   imported ones are read-only with an "open in ADO" link when a URL is
   present, and `fixed` / `closed` statuses are visually struck through.
   Toggle state persists per workstream via the `settings` table.

3. **ADO import** — handled entirely by the agent through a new MCP tool
   `import_pr_comments` exposed by `workstreams-mcp` (diff-grok pattern,
   ADR 008). The Workstreams app stays ADO-blind: the agent uses whatever
   tool it has (an ADO skill, MCP, gh-az, manual paste, etc.), shapes the
   result into the tool's `items[]` schema, and invokes the tool. The
   tool inserts via `INSERT OR IGNORE` against the partial unique index,
   returning `{inserted, skipped}`. Threaded replies are represented as
   separate items with `origin_parent_id` set.

### Why these choices

| Choice | Rationale |
|---|---|
| Naive line-number anchoring (no drift detection v1) | User chose simplicity (`a` answer on Q2). `anchor_text` column captures the line snippet at create time so drift detection can be added later as a non-breaking enhancement. |
| Absolute path key, not repo-relative | User preference (Q3). Trade-off: comments don't follow worktree moves. Acceptable for v1; can be migrated later. |
| Inline view zones, no gutter glyphs / sidebar | User chose `a` on Q6. Simpler render path; comments are always visible when the toggle is on. |
| Selection-based add, not gutter-click | User chose `selection based` on Q7. Naturally gives line *ranges* (matches ADO comment shape). |
| Hardcoded `"me"` author for user comments | User-confirmed (FQ2). Avoids OS-user dependency; no plumbing needed. |
| MCP tool instead of in-app ADO client | User chose `mcp, follow diff-grok pattern` on FQ1. Keeps the Tauri app free of HTTP clients and ADO PAT storage; the agent's own tooling handles auth. |
| Dedup via partial unique index | Re-import is a one-shot snapshot (Q17). Index gives idempotency without per-row "have we seen this?" lookups. |

### Schema

```sql
CREATE TABLE file_comments (
  id TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  anchor_line_start INTEGER NOT NULL,
  anchor_line_end INTEGER NOT NULL,
  anchor_text TEXT,
  body_md TEXT NOT NULL,
  author TEXT NOT NULL,
  origin_type TEXT NOT NULL,    -- 'user' | 'ado-pr'
  origin_pr_id TEXT,
  origin_comment_id TEXT,
  origin_thread_id TEXT,
  origin_parent_id TEXT,
  origin_url TEXT,
  status TEXT,                  -- 'active'|'fixed'|'wontfix'|'closed' for ado-pr
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_file_comments_ws_path
  ON file_comments(workstream_id, absolute_path);
CREATE UNIQUE INDEX idx_file_comments_origin
  ON file_comments(origin_type, origin_pr_id, origin_comment_id)
  WHERE origin_type = 'ado-pr';
```

### Tauri commands

- `list_file_comments(workstream_id, absolute_path) -> FileComment[]`
- `add_file_comment(workstream_id, absolute_path, anchor_line_start,
  anchor_line_end, anchor_text?, body_md) -> FileComment` (hard-codes
  `author='me'`, `origin_type='user'`)
- `update_file_comment(id, body_md) -> FileComment` (user-comments only;
  blocked by `WHERE origin_type='user'` guard)
- `delete_file_comment(id)` (same guard)
- `import_pr_comments(workstream_id, items) -> {inserted, skipped}`

### MCP tool (workstreams-mcp)

`import_pr_comments` mirrors the Rust command and is the only path
agents have to inject ADO comments. Schema-validated input; per-item
anchor validation; transactional insert; returns `{inserted, skipped}`.

## Consequences

**Positive**
- Comments live where the user reads code, no separate tab/portal.
- ADO import is decoupled from the app: any ADO tooling change is
  irrelevant to Workstreams. New origins (GitHub PRs, manual paste)
  can be added by exposing more MCP tools or just by writing JSON-shaped
  items into the same tool.
- Idempotent re-import via partial unique index — agents can re-run on
  demand without bookkeeping.

**Negative**
- Absolute-path key fragile across worktree moves. Acceptable for v1;
  could be migrated to repo-relative later.
- Naive line numbers drift when files are edited above the anchor. The
  `anchor_text` column is groundwork for drift detection, but v1 just
  shows the comment at the original line number regardless.
- Imported comments are markdown but rendered as plaintext in v1
  (`textContent`) to avoid running React rendering inside Monaco view
  zones. Easy upgrade: portal a React `MarkdownView` into the zone DOM
  node.

## Validation

- **Unit (Rust)**: 4 tests covering ordering, isolation, dedup, and
  user-comment escape from the partial unique index (`file_comments::tests`).
- **Unit (TS)**: 11 MemoryBackend cases + 7 `useFileComments` hook cases
  + 12 `comments-layer` helper cases.
- **Integration**: TauriBackend invoke-shape test verifying snake_case
  arg mapping for all 5 commands.
- **CDP**: open a file in Repo Explorer, toggle the comments icon,
  select 2 lines, click `+ Comment`, type, save, verify view zone
  appears with body + Edit/Delete buttons; reload to verify persistence.
