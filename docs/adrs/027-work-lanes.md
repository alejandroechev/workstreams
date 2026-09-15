---
id: "027"
status: Accepted
date: 2026-09-14
---

# ADR 027: Work lanes, and one workstream list

## Status

Accepted (2026-09-14).

## Context

The sidebar showed workstreams in three places — a Live section, an Idle
section, and a separately collapsed Archived list — with no way to say that
several workstreams belong to the same piece of work. A feature, the fix that
followed it, and the workstream reviewing its PR sat apart from each other,
ordered by a manual drag order nobody used any more.

Two problems underneath:

**The three sections were not three of the same thing.** `bucketWorkstreams`
decided live-vs-idle from `loadedWsIds` — a *runtime* fact about whether a
workstream's tiles are open — but decided archived from `status`, which is
persisted. Presenting them as one progression implied a scale that does not
exist: restarting the app makes everything idle and archives nothing.

> **Amended by [ADR 029](029-persisted-loaded-workstreams.md) (2026-09-15).**
> The loaded set is now persisted, so "restarting the app makes everything
> idle" is no longer true. The decision below is unaffected: loaded and
> archived remain different questions — what you have open versus what you have
> put away — and the filter names still say so.

**Manual ordering was dead weight.** `workstream_order` was written from four
places in `App.tsx`, and `domain/reorder.ts` existed to serve exactly one
caller, yet nobody deliberately ordered anything. It also occupied the drag
gesture, which is the natural way to express membership.

## Decision

### A lane is a container, not a repository

A **work lane** is a named folder for related workstreams: one lane per
workstream, optional. It is deliberately *not* a repository — `project_id`
already carries that — so a lane can span several repos or split one.

The term is identical in the UI, the CLI (`ws.lane`) and the schema
(`work_lanes`). The `ws` skill documents CLI verbs verbatim, so a mismatch
would mean an agent reading "group" while the operator says "lane" — a
translation tax with no upside.

Two storage rules carry weight:

- **Lane names are unique case-insensitively.** Two folders both reading "Media
  Store" make the list unreadable and a drop target ambiguous.
- **`lane_id` is `ON DELETE SET NULL`.** Deleting a lane re-files its members as
  "No lane" rather than deleting them. Reorganising should never lose work, and
  a taxonomy change that can destroy a workstream is one nobody will risk using.

### The filter names its axis honestly

One list, filtered by **Loaded / Not archived / All**.

The obvious labels would have been "Live / Live + Idle / All", and they would
have lied. Loaded is a runtime question; archived is a stored status. Naming the
stops after what they actually select keeps the two legible as different things
even though they sit on one control.

> **Amended by [ADR 029](029-persisted-loaded-workstreams.md).** Loaded is now
> persisted too, so the two are no longer runtime-versus-stored. They are still
> different questions — open versus put away — which is what the labels
> protect, so the stops are unchanged.

**`creating` and `create_failed` are visible under every filter.** A failed
creation has no other signal in the UI, so a filter that could hide it would
make a broken workstream silently disappear at the moment it most needs
attention.

A lane whose rows are all filtered out keeps its folder and shows a hidden
count, so a lane never looks deleted.

### Ordering is removed, so drag can mean one thing

Manual ordering is deleted outright — the setting, its four writers,
`domain/reorder.ts`, and the four tests whose only subject was reordering.
Dormant code that used to drive the sidebar is the kind a later change
re-enables by accident. Existing `workstream_order` rows become harmless dead
data.

Everything sorts by `localeCompare` with numeric collation and case-insensitive
comparison. Case-sensitive sorting files every lowercase repo name
(`media_components`) in a second alphabet after the capitalised ones, and
non-numeric collation puts `PR 10` before `PR 9`.

Drag now means exactly one thing: **which lane a workstream belongs to.**

### "No lane" always renders

The unfiled group is always present, even when empty, because it is the drop
target for taking a workstream *out* of a lane. Hiding it when empty would make
removal impossible at precisely the moment every workstream has a lane.

Empty lanes render too, for the same class of reason: a lane you have just
created would otherwise be impossible to drag into.

### Unarchiving is guarded twice

Clicking an archived workstream confirms, then unarchives and opens it.

The confirmation is the undo-guard for a misclick in a list you are scanning.
The **directory check** is the more important half: archiving offers to delete
the worktree, so unarchiving without checking can open a workstream pointing at
a path that no longer exists — the same empty-workspace failure that ADR 026's
correction section records for `ws.create`. When the directory is gone, the app
says so instead of opening. An unreadable path counts as missing, because
offering to recreate is recoverable and opening onto nothing is not.

The explicit Unarchive menu action routes through the same guard, rather than
leaving a second unguarded path to the same state.

### The agent may file, not define

`ws.lane` assigns a workstream to a lane, or clears it with `lane=none`.
Creating and deleting lanes as a taxonomy stays a human action in the app:
filing is the useful agent verb, while deciding what the folders *are* is a
judgement about how someone wants to see their own work.

## Consequences

- Run disposition for the sidebar is now derived rather than stored, so there is
  no ordering state to migrate, corrupt, or keep in sync.
- A workstream pointing at a deleted lane is treated as unfiled rather than
  dropped: losing a row from the sidebar is far worse than filing it in the
  wrong place.
- Dropping a workstream onto another row joins that row's lane instead of doing
  nothing. Ordering is gone, so a drop on a row would otherwise be inert, which
  reads as broken.
- Archived workstreams are now reachable in one click from the main list, where
  before they were behind a separate collapsed section.

## Alternatives considered

**Keep ordering and add lanes on top.** Rejected: one flat id array cannot
express group order *and* order within a group, and drag would have had two
meanings distinguished only by where you released the mouse — making every
reorder near a lane header a possible accidental re-filing.

**Make a lane a repository.** Rejected: `project_id` already does that, and the
cases that motivated lanes (a feature plus its fix plus its review) frequently
span repos.

**Many lanes per workstream.** Rejected: a folder tree with multi-membership
renders the same workstream more than once, and "collapse the folder" stops
having a single meaning.

**Hide empty lanes.** Rejected after it broke drag-to-assign in testing — a lane
with no members is exactly the one you most need to drop into.
