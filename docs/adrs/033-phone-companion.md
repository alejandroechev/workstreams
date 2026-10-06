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
- **Once only.** After its signature checks out, a request's id is
  *reserved* in a ledger in Workstreams' own SQLite settings
  (`companion.consumed`); only the first reservation ever authorises running
  it. Then it is claimed with `outcome.status = "running"`. The ledger, not the
  document, is the authority: anyone who can write to the document can delete
  an outcome and replay a still-fresh signed request, and the ledger refuses
  it. There is one ledger per process, shared by every generation of the
  service (turning the companion off and on, a new secret). Its map is never
  replaced or cleared, and its writes are serialised, so no two generations can
  both reserve an id or overwrite each other's. It fails closed: an unreadable
  ledger stops the companion. **Pair a new phone** repairs unreadable storage
  (a ledger that loaded fine is left alone) before rotating the secret, which
  voids every signature the lost ids could replay. Ids are kept for the
  freshness window plus a margin. A request found `running` at start-up (the app died mid-action) is
  marked `failed: interrupted`, not retried.
- **Re-checked after every wait.** A stopped runtime acts on nothing and writes
  nothing. Freshness is checked again after the reservation, and a guard
  (stopped, newer document, expired) runs before each action and is handed to
  the create and session operations, which call it after each of their own
  waits and last right before the agent is launched. A laptop that stalls
  mid-request never starts an agent on a request it may no longer run; a
  session tile created just before such a refusal is removed again.
- **Untrusted inbox.** An entry must be filed under its own signed `id`;
  anything else, or anything malformed, is failed as invalid. Entries that are
  not even objects are deleted. One bad entry never stops the others.
- **No writes to a newer document.** The schema version is re-checked after
  every await, before claiming, before each outcome and on every presence
  tick.
- **Not before the app is ready.** Nothing is published or executed until the
  app has loaded its workstreams and settings, so a request is never failed
  for naming a workstream that has not loaded yet.
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

### Messages from phone-started sessions

An agent running in a session the phone started can send messages back to the phone. One-way, agent →
phone; the phone cannot reply.

- **Asking for a result.** The phone's prompt and create sheets have a "Send me the result" toggle, on by
  default. It appends the fixed `RESULT_SUFFIX` from the shared protocol, which names the
  `companion-reply` skill. The laptop never rewrites prompts.
- **Phone sessions.** When the executor creates a Copilot tile for a phone request (a session, or a
  create with a prompt), Workstreams records `{ tileId, workstreamId, requestId, prompt, createdAt }` in
  SQLite (`companion_sessions`). Only these tiles may send. Nothing else records one.
- **Sending.** The agent runs `workstreams agent call companion.send kind=<progress|result> text=…` over
  the existing local agent channel. The app knows the calling tile from the channel's token; the agent
  never names its session and holds no document URL, token or secret. Workstreams refuses (and queues
  nothing) when the tile is not a phone session, when the companion is off, for an unknown kind, an empty
  text or more than 20 000 characters. Accepted messages are stored in SQLite (`companion_messages`).
- **Publishing.** The laptop publishes sessions and their messages into an optional top-level `sessions`
  map (keyed by tile id, title = the prompt's first line). It is additive at `schemaVersion` 1: older
  phones never read it. As everywhere else, the laptop is its only writer and writes nothing into a
  document from a newer version.
- **Authenticity.** Anyone holding the document URL could write a well-formed session, so the laptop
  signs each session header and each message with the pairing secret (HMAC-SHA256 over
  `[1, "session", id, workstreamId, workstreamName, requestId, title, createdAt]` and
  `[1, "message", sessionId, id, kind, text, at]`). The phone shows only what verifies. Pairing a new
  phone re-signs everything with the new secret.
- **Re-linking.** A tile's permission to send is revoked (its history kept) when the user links it to
  another Copilot session: that session was not started from the phone.
- **Launching.** The session is recorded before the agent starts, and the request's guard is checked
  again after recording; a refusal removes the tile, its layout entry and the record.
- **Retention.** A session is pruned 3 days after its last message (or its start), and keeps at most its
  latest 50 messages; pruning runs in SQLite and the published copy follows.
- **On the phone.** A Messages view lists the sessions newest first, with unread counts; read state lives
  only on the phone. Message text is markdown rendered as text, never as HTML.

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
