---
id: "036"
status: Accepted
date: 2026-10-14
---

# ADR 036: Muting kinds of PR inbox events, globally

## Status

Accepted (2026-10-14). Extends [ADR 031](031-pr-inbox-event-stream.md).

## Context

The PR inbox reports every settled build gate, vote, comment, assignment and
closure on watched pull requests. Some of these are routine for the owner. For
example, "Comment requirements passed" fires on nearly every PR and buries the
events that matter. The owner wants to say once "don't track events like this"
and have it hold for every repo from then on.

## Decision

- **A mute rule is (kind, subject, outcome)**, stored in a global
  `pr_inbox_mutes` table, not per repo:

  | Kind | Subject | Outcome |
  |---|---|---|
  | Build gate (`policy`) | policy name | `approved` / `rejected` / `broken` |
  | Vote | reviewer | the vote value (`10`, `5`, `-5`, `-10`) |
  | Comment | comment author | — |
  | Assigned | PR author | — |
  | Closed | PR author | `completed` / `abandoned` |

  Muting is **by outcome**. Muting "Comment requirements passed" keeps
  "Comment requirements failed". The subject is matched case-insensitively.
- **Muted events are never recorded.** `record_event` checks the rules before it
  inserts. The PR's watermarks (comment time, votes, gate states) still advance,
  so lifting a mute later does not replay what was skipped.
- **Muting marks the existing matching events read**, in every repo. They stay
  in history under **All**.
- **Each event carries its rule key.** `pr_inbox_events` gains `subject` and
  `outcome` columns. Events recorded before this change are backfilled at
  startup from their summaries, which were always written from fixed templates.
- **Surfaces, with CLI parity:**
  - a "Stop tracking" button on each inbox event;
  - a **Muted (n)** toggle in the inbox listing the rules, with **Reset all**;
  - `inbox.mute id=<notification-id>` and `inbox.unmute_all` on the agent CLI.

  `inbox.list` returns the rules under `mutes`.

## Consequences

- There is no per-rule unmute yet; Reset all is the only way back. Adding a
  per-rule unmute later is a small change, since rules are plain rows.
- A mute matches by display name (gate name, reviewer, author). If ADO renames a
  policy or a person's display name changes, the rule stops matching and the
  events come back, which is safe.
- A legacy event whose summary cannot be parsed keeps an empty subject and
  simply offers no Stop tracking button.
