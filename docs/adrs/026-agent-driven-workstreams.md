---
id: "026"
status: Accepted
date: 2026-09-10
---

# ADR 026: Agents drive the app through a CLI over a local socket

## Status

Accepted (2026-09-10).

## Context

An agent running in a Workstreams session tile can edit code in the worktree but
cannot act on the app hosting it. Creating a workstream, provisioning a repo,
filing a task or handing work off all fall back to the human — at exactly the
moment the agent has the most context.

Two facts make "let the agent write to the database" the wrong answer:

1. **The invariants live in Rust, not in the schema.** Creating a workstream
   with a worktree and a linked session is `create_worktree` + `create_tile` +
   `spawn_copilot_session`. An agent writing rows produces a workstream that
   looks correct and has neither.
2. **The app does not watch its own database.** It listens for one Tauri event
   and polls loop summaries. An external write stays invisible until the user
   happens to click something.

A second goal rides along. There is no usage telemetry, and the honest way to
get it is to route human and agent actions through one named command registry —
which *is* the agent API.

## Decision

### Reads may go direct; writes go through the app

Reading SQLite is harmless and already natural for an agent's `sql` tool. Every
write goes through the running app, so the Rust-side invariants are enforced
exactly once. `ws.create` calls the same `insert_workstream` the UI command
calls, so an agent-made workstream gets the same default layout row as a
person's rather than being a bare row that looks right until something reads it.

### A CLI over a Unix socket, not MCP

MCP was considered twice and declined twice, for different reasons each time.
ADR 013 built MCP tools and ADR 014 retired them as "overcomplicated" for a
conversation already sitting in a database both sides could open. That reasoning
does not transfer here — mutating another process's state is a genuinely
different problem.

The reason MCP loses *this* time is structural: **an MCP server is a child of the
Copilot CLI, not of the app.** It gets typed, discoverable tools for free, which
is a real benefit, but it still needs a channel to the running app underneath —
so it adds a process and a per-session config injection to arrive where the
socket already is. A CLI reaches the same socket, doubles as the human debugging
surface, and satisfies the CLI-parity rule in AGENTS.md that we would be meeting
anyway.

The cost is discoverability: an agent must read a skill rather than see tools in
its schema. The `code-review` and `file-comments` skills already show that works.

### The socket lives in `$TMPDIR`

Not beside the database. A socket under Application Support measures **83 of the
104 available `sun_path` bytes** on a 19-character username, leaving a budget of
**33 characters** once a per-instance suffix is added. A corporate account like
`alejandro.echeverria@microsoft.com` is 34 — it would bind on the developer's
machine and fail on the user's.

The per-user temp directory has no such problem: on macOS it is a fixed-length
hash (`/var/folders/<hash>/T/`) independent of the username, it is already
`0700`, and it is cleared on reboot, which disposes of sockets left by a crash.

Two more things the spike (`spikes/socket/FINDINGS.md`, 19 checks plus a
cross-process round trip) forced into the design:

- **`chmod 0600` happens inside the bind function.** A fresh socket is `0755` and
  world-connectable; a separate initialisation step could be skipped or
  reordered.
- **An empty reply is a failure, `NO_REPLY`.** When the app dies mid-request,
  `read_line` returns `Ok(0)` — EOF reads as success, and a naive client hands
  the agent an empty result to parse.

A stale socket is reclaimed by **connect-then-unlink**. A leftover path is
either a corpse or a live sibling instance, and connecting is the only way to
tell; an unconditional unlink would silently evict a running app.

### Identity is a token the app issues, never a claim

This corrected a hole found during implementation. The socket is per app
*instance*, so every session shares it — meaning a request had no way to prove
which session sent it, and naming a workstream in the request would have made
the scope check decorative.

The app now mints a token when it spawns a session, injects it beside
`WORKSTREAMS_SOCKET`, and keeps the mapping in memory. A request **presents** an
identity rather than naming one. The token is a field on the envelope, not a
parameter, so no command can be written that accepts an identity as an argument.
Respawning a tile retires its previous token.

Resolution is deliberately lenient for commands that declare they do not need
identity: a connectivity check must answer even when the token is stale, or an
agent cannot separate "cannot reach the app" from "the app no longer knows me" —
two problems with different fixes.

### Scope is mechanical; permission to destroy is social

An agent may act on **its own workstream and ones it created**. The second clause
is not generosity: handoff and parallel runs both require an agent to follow up
on what it just provisioned. The check reads `created_by_session` against an
identity resolved from an app-issued token, so it is the app consulting its own
records. Provenance is written from that same resolved identity — a
`createdBySession` parameter is ignored.

**There is no confirmation UI, by decision.** Destructive commands are therefore
*discouraged, not prevented*: the skill and `--help` instruct the agent to ask
the human before deleting a workstream, removing a worktree, or writing to a
workstream it did not create. This is the same soft-enforcement line ADR 014 took
for review roles, and it keeps the socket protocol synchronous and stateless —
no blocked call waiting on a modal, no re-entrancy while a prompt is open.

The split is worth stating plainly: **scope** (which workstreams are reachable at
all) is enforced in code; **permission to destroy within that scope** is not.

#### What the token does not defend against

A cross-model review of the implementation established that a sibling process
under the same user account can read another session's token out of its
environment (`ps eww`) and present it. **The scope fence therefore does not
withstand a hostile local process.**

This is accepted rather than fixed, and the reasoning should be explicit so the
scheme is not mistaken for something stronger: the fence exists to contain
*mistakes* — a confused agent acting on the wrong workstream — and every session
here is the user's own agent running on the user's own machine under the user's
own account. A process that can read another session's environment can already
read the database directly.

Closing it properly means attesting identity from the kernel — the socket peer's
credentials checked against an app-tracked session process tree — rather than
from a bearer token. That is a worthwhile change and a different design.

### One log for humans and agents

Every dispatch is recorded in `command_log`. One table, because "do agents drive
this differently from people?" is unanswerable if the two are recorded
separately. The `actor` is what the app can prove, not what the caller claims: a
command typed by hand inside a session tile records as that session's agent,
because the app genuinely cannot tell and a confident lie in an audit trail is
worse than a coarse truth.

**No caller-supplied bytes are recorded at all.** The row stores which
recognised parameters were *present* — a fact about the shape of the call — plus
a count of unrecognised ones. Everything else in it (command, actor, workstream,
outcome, duration) is derived by the app.

Six rounds of review arrived here, and the path is worth recording because each
step looks reasonable in isolation: check top-level keys; recurse; carry
sensitivity down; bound by length; allowlist the parameter names. The last is the
instructive failure — allowlisting a *name* says nothing about its *value*, and
`branch` is written by a person while a rejected `projectId` is simply whatever
was typed. Every attempt tried to decide which caller data was safe. None of them
could, so none is recorded.

## Consequences

- The app must be running. Commands fail with a distinct `APP_NOT_RUNNING` code
  rather than falling back to direct database writes, so an agent never produces
  a half-built workstream while the app is closed.
- The command surface is curated, not a mirror of the ~120 Tauri commands.
  `resize_pty` and `save_scrollback` would be noise to an agent and public API by
  accident.
- Adding a command means adding a row to one table, which keeps the "unknown
  command" hint from drifting from what is dispatchable.
- A skill in `~/.copilot/skills/workstreams/` documents the surface, and a drift
  test asserts every command and error code it names is real — the two version
  separately and will otherwise diverge silently.
- **The transport is `cfg(unix)`.** The app builds and ships on Windows without
  the agent channel; `workstreams agent` there returns an explanatory error
  rather than failing to compile. Note that CI runs on Linux only, so a
  platform-gating regression would not be caught until a release build.
- **Windows is unimplemented.** Named pipes (`\\.\pipe\…`) are the equivalent and
  have no path-length problem, but a different permission model: a security
  descriptor at creation rather than a `chmod`. Both findings above need a
  Windows-specific answer.
- **A sandboxed `.app` would break this.** `$TMPDIR` resolves inside the
  container, so a separate CLI process would not see the same path. Workstreams
  ships unsandboxed; `WORKSTREAMS_SOCKET` already passes the path explicitly,
  which is the mitigation if that changes.

## Alternatives considered

**Write rows directly.** Rejected: cannot express the app's own examples, since a
workstream with a worktree and a session is three side-effecting calls.

**MCP server.** Rejected as above — it needs this socket underneath anyway.

**A request table in SQLite the app polls.** This is the ADR 014 pattern
inverted, and it works, but it builds a message queue on SQLite and inherits its
latency floor. Since the app must be running regardless, the socket's only
disadvantage disappears.

**Per-session sockets instead of tokens.** Would make identity structural rather
than presented. Rejected for bookkeeping: a listener per tile, created and torn
down as tiles come and go, versus one bind and a map.

## Follow-ups

Not yet implemented, and deliberately out of scope here:

- **Handoff** — create a workstream with a worktree and spawn its session primed
  with context. The mechanism is settled (stage the brief under app data, spawn
  with `copilot -i`, have the agent copy it into its own session `files/`), but
  the spawn plumbing is not built.
- **Moving UI actions onto the registry**, which is what makes the log answer a
  question rather than only describing agents. A UI action should move exactly
  when its CLI equivalent ships.
- **Goal loops provisioning through this substrate** rather than their own path.
