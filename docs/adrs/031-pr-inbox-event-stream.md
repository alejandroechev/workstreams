---
id: "031"
status: Accepted
date: 2026-10-02
---

# ADR 031: The PR inbox becomes a per-pull-request event stream

## Status

Accepted (2026-10-02). Extends [ADR 030](030-ado-pr-inbox.md), which stays in
force for polling cadence, account scoping, the `az` token path and the strict
ADO host allow-list.

## Context

ADR 030 delivered one notification per pull request: *you were added as a
reviewer*. That answers "is there something new waiting for me?" but not "what
happened on the work I care about?" The review assignment is the least
interesting moment of a pull request's life — the comment that blocks a merge,
the approval that unblocks one, and the build gate that turns red all arrive
afterwards, and all of them were invisible.

Following pull requests the user *authored* has the same shape but a different
list query, and it is where the demand for comment and gate notifications is
strongest.

The obvious extension — "also notify on comments" — does not fit the ADR 030
data model. That model stores one boolean per (repo, account, PR): notified or
not. Comments, votes and gates are not one-shot facts; they are sequences that
must be diffed against what was already reported, per pull request, forever.

Two further constraints shaped the design:

- A completed or abandoned PR **disappears** from the active-PR search, so
  closure is unobservable from the list query alone.
- Threads, votes and policy evaluations each need a **per-PR** request. A repo
  with hundreds of active PRs would mean hundreds of requests per pass.

## Decision

**Per-repo watch mode replaces the opt-in boolean.** `off`, `reviewer`,
`author`, `both`. Widening the mode is a normal, expected operation, so it must
not dump a back catalogue into the inbox (see silence, below).

**Notifications become events, not PRs.** A new `pr_inbox_events` table holds
`(kind, summary, dedupe_key)` rows scoped by project, source, account and PR id,
with a uniqueness constraint that makes re-reporting impossible even if a poll
pass runs twice. `pr_inbox_seen` keeps the per-PR *sub-state* the diff runs
against: comment watermark, last known votes, last known gate outcomes, PR
status, and whether the PR has been read in depth yet. The UI groups events back
under their pull request, so the reading experience stays PR-shaped.

Five kinds: `assigned`, `comment`, `vote`, `policy`, `closed`.

**Silence has two independent layers.** A baseline keyed by
`(project, source, account, role)` makes the first pass for *each role* silent —
so switching `reviewer` → `both` does not announce every PR the user ever
opened. A per-PR `deep_synced` flag makes the first read of a PR's threads,
votes and gates a recording, not a report. Without the second layer, a PR that
becomes watched a year into its life would fire a dozen stale events at once.

**Depth is capped at 25 pull requests per repo**, ranked by descending PR id as
a proxy for recency (the list payload has no dependable `updatedDate`). Beyond
the cap, a PR is still followed for assignment and closure, which cost nothing
extra — only its discussion goes unwatched.

**Closure is detected by absence.** PRs recorded as watched but missing from
this pass's search are fetched individually; a non-active status emits `closed`.

**Only meaningful transitions notify.** System-generated comments
(`commentType != "text"`) are suppressed, because ADO writes them on the user's
behalf and they duplicate the vote and gate events. The user's own comments are
suppressed. Vote `0` (reset) does not notify. Gate statuses `queued`, `running`
and `notApplicable` do not notify; only `approved`, `rejected` and `broken` do.
Authored PRs never emit `assigned` — the user opened them. When a PR matches
both searches, the **author** role wins.

**A failed thread or policy fetch sinks the whole pass.** Treating a failure as
"no comments" would advance the watermark past unread discussion and lose it
permanently. Correctness beats liveness here; the next pass retries.

## Consequences

Polling cost per repo goes from one request to roughly `1 + 2N` where `N` is the
watched depth, bounded at 25 — about 51 requests per repo per two-minute pass in
the worst case. This is why the cap exists and why it is not configurable yet.

The comment watermark is `publishedDate`, not comment id: ADO comment ids
restart at 1 **inside every thread**, so they are not globally ordered. The
`dedupe_key` (`threadId:commentId`) remains the uniqueness backstop, and the
watermark comparison is strictly `>` so the boundary comment is not re-announced
immediately after a baseline.

Existing ADR 030 notifications are migrated into `pr_inbox_events` as
`kind='assigned'`, preserving their original id and read state, so upgrading
does not appear to lose or re-ring anything.

The depth cap and the two silence layers mean the inbox is explicitly **not** a
complete audit log. Activity on a PR before it was watched, or beyond the cap,
or between the last poll and app shutdown, is not recoverable. ADR 030's
snapshot limitation still applies and is now broader in surface.

**Validation boundary:** unchanged from ADR 030. The diff engine, role
precedence, suppression rules and migration are covered by native unit tests;
grouping and the watch-mode selector by Vitest and browser E2E; the live ADO
response shapes only by the opt-in ignored `inbox_live_provider` test.

## References

- [ADR 030: the original reviewer inbox](030-ado-pr-inbox.md)
- [ADO pull request threads API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1)
- [ADO policy evaluations API](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1)
