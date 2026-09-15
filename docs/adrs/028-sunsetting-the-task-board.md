---
id: "028"
status: Accepted
date: 2026-09-15
---

# ADR 028: Sunsetting the task board

## Status

Accepted (2026-09-15). Hidden, not deleted — see Consequences.

## Context

The task board was built to replace a hand-written devlog: a board with seven
columns, subtasks, labels, links, a notes scratchpad, and an append-only event
log per task, plus a generated devlog export. Roughly 7,700 lines across
`src/tasks`, `src/domain/task-*`, and `src-tauri/src/tasks.rs`.

It did not work, in the only sense that matters: the user reported losing track
of work in it and wanted to go back to free-form text files.

The database says the same thing more precisely. At the time of this decision:

| | |
| --- | --- |
| Tasks | 26 |
| `task_events` rows | 213 |
| — auto `status` (a card moved) | 113 |
| — auto `workstream` (a link changed) | 13 |
| — **manual notes** | **87** |
| Active workstreams with any manual note | 10 of 23 |

The manual notes were written on a near-daily cadence and were still being
written the day this was decided. **The quick-note bar survived; the board did
not.** `WorkstreamQuickNote.tsx` predicted exactly this in its own header
comment — that logging has to be faster than opening a file or the wiki wins.

The board is the part that asks you to find it, open it, and file work into the
right column. The note bar sits in the status bar and commits on Enter.

## Decision

**Hide the board, the in-progress miniview, and every entry point to them,
behind a `tasks` feature flag. Keep the code and the data.**

### Sunset flags are not optional-feature flags

The existing flag mechanism reads one build-time variable,
`VITE_ENABLE_OPTIONAL_FEATURES`, which enables *every* optional feature at
once. Hanging `tasks` off it does not work, and the failure is instructive:
that variable means "I am the maintainer, show me the unfinished things", and
it is set in the maintainer's `.env.local` to get the Plan tile. A retirement
folded into it stays **enabled on the one machine trying to stop using it**.

This was not theoretical — it was the first implementation, and every unit test
passed while the board remained on screen.

So `FeatureDescriptor` gains `sunset: true`, and sunset features read their own
variable (`VITE_ENABLE_TASKS`), defaulting off everywhere including dev builds.

### What stays visible

**The quick-note bar.** It is the part that works, it is still in daily use, and
its 87 notes are the seed corpus for the per-workstream activity log that
replaces the board. Breaking that habit to tidy up the feature it outlived
would be exactly backwards.

It renders only when a workstream has a bound task, so it is quiet by default
and no new tasks can be created with the board hidden.

## Consequences

**The data is untouched, and that is deliberate.** `task_events.task_id` is
`ON DELETE CASCADE`: deleting the 26 tasks destroys all 213 events, including
the 87 manual notes. Any future cleanup must re-key the log to `workstream_id`
**first**. This is the single most important constraint this ADR records.

**15 manual notes belong to tasks with no workstream.** In a workstream-keyed
log they have no home. That needs a decision, not a default, before migration.

**59% of the log stops being produced.** The 126 auto events are task-state
transitions; with no board there are no transitions. The log becomes purely
manual unless workstream-level events (created, archived, lane moved, session
spawned) are introduced to replace the free signal.

**The board code is still tested.** `task-board.spec.ts` forces the flag on and
still drives the real UI, because untested hidden code rots quietly and this is
meant to be reversible. `tasks-hidden.spec.ts` covers the shipped default, in a
real browser, with no flag override — that is the spec that would have caught
the `.env.local` mistake above.

**Reversal is one variable.** `VITE_ENABLE_TASKS=1`.

## Alternatives considered

**Delete it outright.** Rejected: it takes the note history with it (see the
cascade above), and the replacement log does not exist yet. Deleting the old
thing before the new thing works is how you end up with neither.

**Leave it visible but stop using it.** Rejected by the evidence — it was
already being ignored, and an ignored board still costs sidebar space and still
appears in every screenshot as a thing that might be authoritative.
