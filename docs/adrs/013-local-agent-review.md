---
id: "013"
status: Superseded
date: 2026-07-01
superseded_by: "014"
---

# ADR 013: Local Agent Review (reviewer↔agent loop)

## Status
**Superseded by ADR 014 (Code Review Tile).** The MCP-based, Workstreams-DB
storage design and the round/anchor trackability engine described here were
retired before general use in favour of a diff-first, session-DB-backed,
MCP-free design. This ADR is retained for historical context only; its schema
(`agent_reviews`, the `file_comments` review columns) and code
(`agent_review` module, `AgentReviewTile`, the 3 MCP tools) have been removed.

## Date
2026-07-01

## Context

Reviewing code an AI agent writes is a routine, high-frequency activity in this
project. Today that review happens through an Azure DevOps **draft PR**, which
has two concrete costs:

1. **Slow.** The agent must round-trip to ADO to *read* review comments and
   *post* replies. Each exchange is a network hop through a portal.
2. **Dirty.** The back-and-forth conversation between the developer and the
   agent pollutes the real PR. Because both sides are driven by the same
   person, ADO renders it as a self-conversation, which is noise for anyone
   who later reads the PR.

We already ship most of the machinery to do this **locally**, inside the
workstream:

- **ADR 007 (diff-grok / Diff Review tile)** — chunked Monaco diff rendering,
  per-hunk `content_hash` drift detection, SQLite-as-truth + Tauri-event
  nudges, export-on-complete. Its *direction is inverted* though: the agent
  quizzes the developer to test comprehension.
- **ADR 009 (inline file comments)** — anchored markdown comments on files,
  with threading columns (`origin_parent_id`, `origin_thread_id`), a `status`
  column, and an `anchor_text` groundwork column. An agent can *import* ADO PR
  comments via the `import_pr_comments` MCP tool (ADR 008 bridge pattern). But
  there is **no drift tracking**, imported comments are read-only, and **no
  MCP tool lets an agent *read* local comments** — the "author half" of a
  review loop does not exist.

This ADR introduces the missing piece: a **local reviewer↔agent loop**, where
the developer comments on a diff, the agent reads those comments instantly from
local SQLite, fixes the code + replies, and the developer re-reviews — without
touching ADO until (optionally) a clean summary at the very end.

## De-risking spike

The riskiest question — *can we keep comments anchored across the agent's edits
and mechanically show what changed?* — was validated with a throwaway spike
(`features/local-agent-review/prototypes/trackability/`, verdict **GO**). It
built a real git repo, anchored a comment, and applied three realistic round-2
edits. Two design corrections came out of it and are baked into this ADR:

1. **Anchor state is binary, not four-state.** The grill originally proposed
   `code-changed` vs `obsolete`. The spike proved that split is mechanically
   unreliable — deleting the exact line you flagged (the *ideal* fix) was
   misclassified as `obsolete`. A deletion is usually the fix, not an obsolete
   comment. We therefore use **`unchanged`** (re-anchor to the new line) vs
   **`changed`** (the commented code was edited/deleted → surface it). A
   "code removed" hint is informational only, never a gate.
2. **`git log -L` is the wrong tool for the fixing commit.** It aborts when the
   file shrinks (base line range points past EOF) and returned the base commit.
   Use **`git log <base>..<head> -- <file>`** and take the most recent commit.

## Decision

1. **New first-class feature "Agent Review"** with a dedicated `agent_review`
   tile. It renders the *diff* (base..head) with anchored comment threads. It
   is **not** built on diff-grok's chunk/quiz machinery (opposite direction);
   it reuses the ADR 009 comment store and the Monaco diff/comment UI.

2. **Coexists with ADO import.** ADR 009's ADO import path
   (`origin_type='ado-pr'`) is untouched. Local-review comments use a new
   `origin_type='local-review'`, so the two never tangle.

3. **Direction / roles.**
   - Developer (`author='me'`): create root comments, reply,
     `resolve`/`reopen`, edit/delete own comments.
   - Agent (`author='agent'`, via MCP): reply, set `addressed`/`wontfix`,
     attach the fixing commit. The agent **cannot** resolve a thread or edit
     the developer's comments — only the developer closes the loop.

4. **Pull, not push (v1).** The developer kicks the agent off ("address the
   review"). Auto-notifying a specific CLI session is deferred to keep the tile
   decoupled from any one session. The MCP tools are workstream-scoped, so any
   session in the workstream sees the same comments.

5. **Diff source + rounds.** Diff source is the branch's changes vs a base ref
   (default: merge-base with `master`) or the plain working tree. The agent
   **commits each round** (WIP commits fine; squash later) so each snapshot has
   stable content to hash/diff. A **round** is the diff snapshot at the moment a
   batch of comments is submitted; rounds are numbered.

6. **One active review per workstream** (matches ADR 007 and the
   one-branch-per-workstream model). Closed reviews stay queryable.

7. **Trackability engine (spike-proven).** Text-first: each comment stores
   `anchor_text` + a content hash (`anchor_hash`). On each new snapshot we
   re-locate the anchor by matching `anchor_text` (preferring the match nearest
   the original line). `git diff <base>..<head> -- <file>` hunks whose
   **old-side** range intersects the anchor decide the binary `anchor_state`:
   - **`unchanged`** — exact block still present and its old range untouched →
     re-anchor to the new line, comment still valid.
   - **`changed`** — commented lines were edited or deleted → the touching
     hunk *is* the per-comment before/after; the fixing commit comes from
     `git log <base>..<head> -- <file>`.

8. **Non-blocking discipline.** The anchor/diff/classify engine is a **pure,
   synchronous, unit-tested** function, but every `git` invocation and the
   per-snapshot re-anchor sweep run **off the UI/command thread** (background
   thread + Tauri events), never blocking the webview. (Direct application of
   the "search once killed the app" lesson.)

9. **Completion + export.** A review completes when every thread is `resolved`
   or `wontfix`. On completion a **clean summary** (what was raised, how it was
   addressed, per-comment before/after, fixing commits — no chatter) is written
   to the **session-state folder**, not the repo. It is suitable as
   PR-description fodder.

10. **v1 never writes back to ADO/GitHub.** Keeping the PR clean is the whole
    point. Bi-directional sync is explicitly out.

11. **Out of scope for v1:** auto-notifying the agent session; ADO/GitHub
    write-back; multi-reviewer; multiple concurrent reviews per workstream;
    security/perf review presets; screenshots in comments; @mentions;
    auto-dispatch of a fixing agent; review templates; cross-file
    rename/move anchor following (`git diff -M`).

## Schema

New parent table + five columns added to `file_comments` (via the `db.rs`
migrations array so existing production DBs upgrade transparently). ADO-import
and scratchpad rows are unaffected.

```sql
CREATE TABLE agent_reviews (
    id TEXT PRIMARY KEY,
    workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    base_ref TEXT,                 -- e.g. merge-base with master
    head_ref TEXT,                 -- e.g. HEAD / working tree marker
    round INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',   -- active | completed
    exported_path TEXT,            -- session-state summary path on completion
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

-- file_comments additions (local-review rows use origin_type='local-review'):
ALTER TABLE file_comments ADD COLUMN review_id TEXT;       -- FK -> agent_reviews.id (logical)
ALTER TABLE file_comments ADD COLUMN round INTEGER;        -- round the comment was raised in
ALTER TABLE file_comments ADD COLUMN anchor_hash TEXT;     -- sha256 of anchor_text
ALTER TABLE file_comments ADD COLUMN anchor_state TEXT;    -- 'unchanged' | 'changed' | NULL
ALTER TABLE file_comments ADD COLUMN fixing_commit TEXT;   -- commit that changed the anchored code

CREATE INDEX idx_file_comments_review ON file_comments(review_id, round);
CREATE INDEX idx_agent_reviews_ws ON agent_reviews(workstream_id, status);
```

Reused `file_comments` columns:
- `status` — thread lifecycle: `open | addressed | resolved | wontfix`.
- `author` — `me` | `agent`.
- `origin_parent_id` — threading (agent reply / developer counter-reply).
- `anchor_text`, `anchor_line_start/end` — the anchor.

## Tauri commands (planned)

- `create_agent_review(workstream_id, base_ref?, head_ref?) -> AgentReview`
- `submit_review_round(review_id)` — snapshot diff + re-anchor OPEN threads
  (background thread), bump `round`, emit `review:round-ready`.
- `list_review_comments(review_id) -> ReviewComment[]` — threads with computed
  `anchor_state`, fixing hunk, `fixing_commit`.
- `add_review_comment(review_id, absolute_path, start, end, anchor_text, body_md)`
- `reply_review_comment(parent_id, body_md, author)`
- `set_comment_resolution(comment_id, status, actor)` — role-guarded.
- `complete_agent_review(review_id) -> exported_path`

## Event contracts

| Event                    | Direction      | Payload                          |
|--------------------------|----------------|----------------------------------|
| `review:round-ready`     | backend → tile | `{ reviewId, round }`            |
| `review:comment-updated` | backend → tile | `{ reviewId, commentId }`        |

Sanitized identically on both sides (ADR 006 event-name rules).

## MCP tools (implemented in `~/.copilot/mcp-servers/workstreams-mcp/server.mjs`, ADR 008 bridge)

The reviewer↔agent loop's "author half". These write to the same SQLite DB as
the Tauri app (agent_reviews + file_comments, `origin_type='local-review'`):

- `get_review_comments(include_resolved?)` — open threads for the active
  workstream's active review, each with anchor, note, status,
  `code_changed_since_raised`, `fixing_commit`, and replies.
- `reply_review_comment(comment_id, body_md)` — posts an `author='agent'`
  reply, inheriting the thread from the parent.
- `resolve_review_comment(comment_id, state, fixing_commit?)` — agent states
  limited by the tool's enum to `addressed`/`wontfix` (only the human reviewer
  can `resolve`).

Validated end-to-end over the real MCP stdio protocol against a temp DB
(`.dev/mcp-review-smoke.mjs`, 8/8).

## Consequences

**Positive**
- Tight local loop: no ADO round-trip for the conversation; the PR stays clean.
- **Per-comment before/after is free** — it is just the touching hunk from a
  diff we already compute. This is the headline advantage over an ADO PR, where
  you must hunt the whole new diff to see whether a comment was addressed.
- Reuses ADR 009 storage + Monaco UI and the ADR 007/008 event/MCP patterns —
  little new surface area.

**Negative**
- Absolute-path anchors don't follow cross-file renames in v1 (inherited from
  ADR 009). Documented limitation.
- Whitespace-only re-indentation of an anchored line reads as `changed`
  (acceptable — the developer just resolves it).
- Requires the agent to commit each round; a developer who never commits until
  the end gets weaker trackability.

## Alternatives considered

- **Extend diff-grok** to run "in reverse." Rejected: the chunk/question/quiz
  model is comprehension-shaped, the wrong direction, and coupling the two
  would muddy both.
- **Reuse the Repo Explorer file viewer** (ADR 009 surface) directly. Rejected:
  review is change-centric and needs the diff + round tracking that a
  file-tree-first viewer doesn't provide.
- **Keep using the ADO draft PR** but strip the conversation before merge.
  Rejected: still slow (network round-trips) and error-prone.
