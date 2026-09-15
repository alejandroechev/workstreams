---
id: "029"
status: Accepted
date: 2026-09-15
---

# ADR 029: The loaded set survives a restart; the tiles do not

## Status

Accepted (2026-09-15). Amends the premise of [ADR 027](027-work-lanes.md).

## Context

"Loaded" was runtime-only state: a key in App's `wsStates` map, which is
`useState(new Map())`. Nothing was persisted, so every launch began with an
empty desk and the workstreams representing in-progress work had to be found
and reopened by hand before the app reflected reality.

That matters more than it sounds, because of how the sidebar is actually used:
the loaded set **is** the user's in-progress list. Re-deriving it by hand every
morning is re-doing the only piece of tracking that survived the task board
(ADR 028).

### This changes something ADR 027 relied on

ADR 027 justified the filter stops **Loaded / Not archived / All** by arguing
the two axes are different in kind:

> Loaded is a runtime question; archived is a stored status.

and, as evidence that they are not one scale:

> restarting the app makes everything idle and archives nothing.

The second sentence is now false. The first is *weakened* — both are persisted
— but the distinction it protects is unchanged and still worth the awkward
labels: loaded is about what you have open, archived is about what you have put
away. A workstream can be either, both or neither. The filter names stay.

## Decision

**Persist the set of open workstreams. Do not persist the tiles.**

`workstreams.is_loaded INTEGER NOT NULL DEFAULT 0`, read as part of the normal
workstream row, so restoring the set at startup needs no extra query and cannot
disagree with the list it would have been joined against. A deleted workstream
takes its flag with it.

### Restoring the set is not restoring the session

This is the whole decision. With 23 active workstreams carrying 65 tiles — 23
Copilot sessions and 12 terminals — mounting everything at startup would spawn
every one of those at once. "Leave my desk as I left it" should not cost a
thundering herd of PTYs.

So there are two sets, and they are different things:

| | |
| --- | --- |
| `restoredLoadedIds` | ids the user had open. Restored at startup. Cheap. |
| `wsStates` | workstreams with **mounted tiles and live PTYs**. Built lazily. |

The sidebar shows the **union**. A restored workstream reads as loaded
immediately and mounts its tiles on first visit, exactly as a freshly opened
one does. `domain/loaded-workstreams.ts` owns both rules.

### What is not restorable

`archived`, `archiving`, `creating`, `create_failed`. Archiving is how you put
something away, and a workstream that reappears loaded next launch has not been
put away — the flag can legitimately still be set, since archiving something
you had open is normal, so this is a filter rather than an invariant. The
provisioning states are excluded because their directory may not exist yet, or
any more.

### `is_loaded` does not move `updated_at`

Opening a window is bookkeeping about the app, not an edit to the workstream.
Letting it bump the timestamp would reorder every recently-touched view for a
reason the user would not recognise. Hence a dedicated `set_workstream_loaded`
command rather than a field on `update_workstream`.

## Consequences

**Close had to learn about the new state.** `handleCloseWorkstream` guarded on
`wsStates.has(id)` — "only a loaded workstream can be closed". A restored,
never-visited workstream now shows as loaded with no `wsStates` entry, so that
guard made Close a silent no-op on exactly the rows this feature lights up. It
now accepts either, and skips the dirty-buffer prompt when nothing is mounted,
because there is no buffer to lose.

**Closing clears both halves.** The persisted flag for the next launch, and the
restored set for this one. Clearing only the flag would leave the row lit until
restart.

**The set can grow without bound.** Nothing prunes it; a workstream stays
loaded until explicitly closed. That is the intent — it is a to-do list, and
an entry disappearing on its own would be worse than a long list. If it becomes
unwieldy the answer is a UI affordance, not an eviction policy.

**No CLI verb was added.** Open and close had no agent-CLI equivalent before
this change and still do not, so parity is unchanged: this adds persistence to
an existing action rather than a new action. Exposing `is_loaded` on `ws.list`
is an obvious future addition — an agent asking "what is the user working on"
is a real question — but it is a separate decision.

## Alternatives considered

**A JSON blob in `settings`.** Fewer moving parts, but it drifts: a deleted
workstream leaves its id behind, so every read needs a liveness filter anyway.
The column gets that for free.

**Restore the tiles too.** Rejected on cost — see the thundering herd above.
Worth revisiting only if "loaded" ever comes to mean "my terminals are warm"
rather than "this is what I am working on", which is a different feature with a
different name.
