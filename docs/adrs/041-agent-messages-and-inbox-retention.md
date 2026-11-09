---
id: "041"
status: Accepted
date: 2026-11-09
---

# ADR 041: Agent messages in the Inbox, and read entries expire

## Status

Accepted (2026-11-09).

## Context

A Copilot session in Workstreams can be asked to watch for something (tests
finishing, a deploy, a long job) but had no way to tell the user except its
own terminal. The Inbox already gathers PR activity (ADR 030/031), pipeline
runs (ADR 038) and sync alerts (ADR 040) behind one unread badge, and agents
already reach the app over the agent socket with a per-tile identity
(`workstreams agent call`). Separately, read Inbox entries were kept forever,
though the user rarely revisits them.

## Decision

**Agents post messages to the Inbox.**

- `workstreams agent call inbox.message level=<info|done|needs-you|error>
  title=<≤120 chars> body=@-` (markdown, ≤20 000 chars, on stdin). Only a
  session tile may send (`NOT_A_SESSION` otherwise); invalid input is
  `BAD_MESSAGE`; a session may send 20 per rolling hour (`RATE_LIMITED`).
- Stored in `agent_messages` with the tile, the workstream, and the
  workstream's name at send time, so a message outlives its workstream.
  `inbox.list` returns them as `agent_messages`; `inbox.read` marks them.
  Sending emits a `state-changed` (`agent_message`) so the Inbox re-reads at
  once.
- The Inbox shows an **Agent messages** section first, with an **Agents**
  filter, grouped by workstream. A row shows level, title, a two-line preview
  and time; an expand button shows the full markdown in place without
  switching or marking it read. Clicking the message marks it read, closes the
  Inbox, switches to the workstream and focuses the sending tile. A message
  whose workstream or tile is gone stays, and can't jump.
- No desktop notification and no phone delivery: the badge is enough, and the
  phone already has `companion-reply`.
- The agent waits by its own means. Workstreams doesn't schedule or watch on
  the agent's behalf: the agent knows what "done" means. The `ws-message`
  skill (`skills/ws-message/`, installed globally by `npm run install-skills`)
  asks for exactly one final message per request — on success, failure, or
  when it stops waiting — and no progress messages.

**Read entries expire.**

- Every Inbox kind (PR events, pipeline runs, sync alerts, agent messages)
  deletes **read** entries 5 days after they arrived; unread entries are never
  expired. The rule runs natively at startup and hourly (`RetentionWorker`),
  in one transaction. 5 days is a constant.
- An expired PR, pipeline or sync event leaves a content-free tombstone
  (`inbox_tombstones`, keyed by each insert path's own dedupe identity) for 30
  days; the insert paths skip tombstoned keys, so a poller that sees the same
  event again doesn't report it as new.
- An expired pipeline run's investigation link (`pipeline_investigations`) is
  removed with it; the investigation workstream itself stays.

## Consequences

- One new agent command, one table each for messages and tombstones.
- Read history beyond 5 days is gone; nothing can bring it back.
- An agent that never sends its final message leaves the user waiting; the
  skill's one rule exists to prevent that, but it's not enforced.

## References

- [ADR 030: ADO PR inbox](030-ado-pr-inbox.md)
- [ADR 038: Pipeline notifications](038-pipeline-notifications.md)
- [ADR 040: Sync server monitoring](040-sync-server-monitoring.md)
