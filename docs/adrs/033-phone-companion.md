---
id: "033"
status: Accepted
date: 2026-10-02
---

# ADR 033: A phone companion that drives Workstreams through a shared Automerge document

## Status

Accepted (2026-10-02).

## Context

Workstreams only works from the laptop. The owner wants to act on it from a
phone: see whether it is running, see the workstreams, load one, create one,
and start a Copilot session with a prompt. The phone app is a separate Android
app in its own repository (`workstreams-companion`).

The owner already runs a self-hosted sync server (SyncEngine,
`wss://sync.stormlab.app`) for several local-first apps. It hosts Automerge
documents over WebSocket and relays Automerge Repo ephemeral messages. Every
client must use the server's major `@automerge/automerge-repo` version (2.x).

Two properties make this unusual for a CRDT app:

- The phone does not edit shared data. It asks the laptop to *do* things, and
  some of those things start an agent with `--yolo` on the owner's machine.
  This is remote command execution and has to be treated as such.
- The laptop can be offline, asleep, or minimised for hours, and a request
  must never run long after it stopped making sense.

## Decision

### One dedicated document, two owners

A single Automerge document, registered in `sync-engine/apps.json`, used by
nothing else:

```ts
{
  schemaVersion: 1,                 // major version; see "Versioning"
  laptop: {                         // written ONLY by Workstreams
    workstreams: [{ id, name, laneId | null, loaded, sessionCount }],
    lanes: [{ id, name }],
    lastSeenAt: number,             // ms epoch, updated every few minutes
  },
  requests: {                       // written by the phone; outcome by Workstreams
    [id]: {
      id, kind: "load" | "create" | "session",
      args,                         // load {workstreamId}
                                    // create {name, prompt?}
                                    // session {workstreamId, prompt}
      createdAt: number,            // ms epoch, phone clock
      signature: string,            // HMAC-SHA256, hex
      outcome?: { status: "running" | "done" | "failed", at, error? },
    },
  },
}
```

Each key has exactly one writer, so concurrent edits never conflict and a merge
can never produce a state nobody wrote. `workstreams` is ordered like the
sidebar and excludes archived workstreams. Lane colours are not stored: both
apps derive them from the lane id with the shared `laneColor()`.

### Requests are signed, fresh, and executed once

- **Pairing.** Enabling the companion generates a 32-byte random secret, kept
  only in Workstreams' settings and on the paired phone. It never goes into the
  document. The phone gets it by scanning a QR code with
  `{ v: 1, doc, secret }`.
- **Signature.** `HMAC-SHA256(secret, canonical(request))`, where `canonical`
  is a JSON array of `[schemaVersion, id, kind, args with sorted keys,
  createdAt]`. Anything that can write to the document (any device enrolled with
  the shared SyncEngine registration key, or anyone holding the document ID) can
  therefore only fill the inbox with requests Workstreams refuses.
- **Freshness.** A request is executed only if
  `now − createdAt ≤ 5 min` and `createdAt − now ≤ 1 min` (clock skew). A
  suspended or sleeping laptop runs its backlog the moment it wakes (measured:
  39 minutes late), so this check is load-bearing, not defensive.
- **Once only.** Workstreams writes `outcome.status = "running"` *before*
  acting. A request that already has any outcome is never executed again. A
  request found `running` at start-up (the app died mid-action) is marked
  `failed: interrupted`, not retried.
- Rejected requests are marked `failed` with a reason, never silently dropped,
  so the phone can show what happened.
- Completed requests older than a few days are pruned to bound history.

### What a request does

- **load** loads the workstream in the background. The workstream on screen
  never changes.
- **create** makes a standalone workstream (no repo) whose directory is a new
  folder under a configurable root (default `~/Workstreams/<slug>`), and loads
  it. With a prompt, it also starts a session, all in the same request.
- **session** loads the workstream if needed, then appends a Copilot session
  tile running `resolveCopilotCommand(project)` (the repo's command if set,
  else the global setting) with `-i <prompt>`.

### Presence

Workstreams broadcasts an ephemeral `{ kind: "presence", sentAt }` every ~10 s.
The phone shows the laptop online if one arrived within ~30 s. Ephemeral
messages are relayed by the server but never stored, so presence does not grow
the document. `laptop.lastSeenAt` is written only every few minutes, for the
"last seen" text.

### Where it runs in Workstreams

In the **frontend**, with `@automerge/automerge-repo` 2.x, because loading a
workstream and adding a tile are frontend operations in `App.tsx`. That only
works if the page keeps running while minimised: with WebKit's default policy,
macOS suspended a minimised Workstreams page after ~10–14 minutes. The main
window therefore sets `backgroundThrottling: "disabled"` (pinned by
`src/__tests__/tauri-window-config.test.ts`).

### Versioning and isolation

- `schemaVersion` is a major version. Either side refuses to act on a document
  whose major version it does not know, and says which app to update.
- The companion is **off by default**. Only the production build connects to
  the real document; development builds use no document, or a separate dev
  one, so two instances can never execute the same request.

### Testability

Both sides talk to the document through a `CompanionDoc` interface with an
Automerge implementation and an in-memory one. The request executor is a pure
function from (document, request, now, secret) to (actions, outcome), so the
security checks are unit-tested without Automerge. The shared protocol module
(schema, canonical form, signing, freshness, versioning, `laneColor`) is copied
verbatim into the companion repository, and both repositories test it against
the same fixture file.

## Consequences

- **Not real-time.** A request takes the sync server's round trip (~120 ms
  measured locally) plus whatever the laptop needs to act.
- **Background throttling is off for the whole window.** Terminals, editors and
  polling keep running while minimised. The CPU and battery cost was not
  measured and is a known risk.
- **A leaked document ID or registration key leaks workstream names**, but
  cannot make the laptop act without the pairing secret.
- **Re-pairing** (a new secret) invalidates every unsent request from the old
  phone. Requests in flight fail visibly.
- **Two repositories share one schema.** Drift is caught by `schemaVersion` and
  the shared fixtures, not by a shared package. This is deliberate: a package
  would tie the phone app's release cycle to this repository's hooks.
- No session output reaches the phone; that would mean streaming terminal data
  through a CRDT and is out of scope.

## References

- [ADR 026: agent-driven workstreams](026-agent-driven-workstreams.md)
- [ADR 027: work lanes](027-work-lanes.md)
- [ADR 029: persisted loaded workstreams](029-persisted-loaded-workstreams.md)
- Spike: `files/features/workstreams-companion/spikes/FINDINGS.md` (session
  artifact, not in the repository)
