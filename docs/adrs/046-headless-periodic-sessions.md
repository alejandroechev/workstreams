---
id: "046"
status: Accepted
date: 2026-11-26
---

# ADR 046: Headless periodic sessions

## Status

Accepted (2026-11-26). Supersedes the runner and tile parts of
[ADR 044](044-periodic-sessions.md): how a scheduled run starts, ends and is
judged, and where a schedule lives. ADR 044's scheduling rules (presets, the
5-minute minimum, no pile-up, no catch-up, auto-pause, revisions, archive and
lifecycle) and its "any session may message the phone" part still hold.

## Context

ADR 044 ran each scheduled run by resuming the tile's interactive terminal
session with `-i <prompt>`. A question from the agent, or a permission prompt,
left the run waiting for a person forever: the turn never ended, so the run
was killed after 60 minutes and counted as a failure, and three of those paused
the schedule. A run's success was read back from the session's `events.jsonl`
turn cursor, with Ctrl+C for timeouts and process generations to tell a run's
turn from a phone message's. A new periodic tile needed a setup prompt because
Copilot only assigned a session id once a prompt was sent. Notifications
depended on the agent remembering to call `ws-message` or `companion-reply`.

The Copilot CLI has a non-interactive mode: `-p <prompt>` runs one turn and
exits, `--no-ask-user` removes the question form, `--output-format json` prints
JSONL events, and `--session-id=<uuid>` creates a session with a chosen id
(`--resume=<id>` continues it; `--resume` of an unknown id exits 1).

## Decision

**Every schedule runs headless, in a Periodic session tile.**

- **A new tile type, `periodic_session`**, with no terminal. One schedule per
  tile, and one Copilot session per tile: its id is assigned when the tile is
  made (no setup prompt, nothing starts). Add tile → **Periodic session** asks
  for the prompt, frequency and notify toggles. **Run periodically…** is gone
  from ordinary Copilot tiles. Deleting a schedule removes its tile; closing
  the tile deletes its schedule.
- **A run is one plain child process** (no PTY), in the workstream's
  directory, with the workstream's environment (agent socket and token): the
  workspace's configured Copilot command as it is (the user owns permissions,
  e.g. `--yolo`), plus `-p <prompt + instruction> --session-id=<S>` on the
  first run and `--resume=<S>` afterwards, `--no-ask-user --output-format json`.
  The first run flips `session_started` once the CLI reports the session
  (`session.start`), so a run that failed before creating it retries with
  `--session-id`. The native runner (`periodic_runner.rs`) is one thread per
  run; `RunManager` allows one run per tile and kills every run's process group
  when the app exits.
- **Every run ends with exactly one result.** `ok` (exit 0), `failed` (non-zero
  exit, killed, or the command can't start), `timed_out` (still going after 60
  minutes: its own process group is killed by PID, never by name), or
  `needs_input` (exit 0 and the final answer starts with `NEEDS INPUT:`, after
  any whitespace or markdown emphasis). Every run prompt ends with one
  instruction: begin the final reply with `NEEDS INPUT:` when a decision from
  the user is needed. The ADR 044 Inbox and phone instructions are gone.
- **Reading the output.** The CLI's JSONL (probed on 1.0.117) has one event per
  line with a `type` and `data`: `session.start`,
  `tool.execution_start` (`toolCallId`, `toolName`),
  `tool.execution_complete` (`toolCallId`, `success`), `assistant.message`
  (`content`, and `phase: "final_answer"` on the last one), deltas, and a final
  `result` line (`sessionId`, `exitCode`). The parser folds tool calls and the
  final answer (the final-answer phase wins, otherwise the last non-empty
  message) and ignores everything else, so a new event can only add; output
  that is not JSON at all is taken as the answer.
- **The run log.** `periodic_runs` keeps, per tile, the newest 50 runs and
  skips: kind (scheduled, manual, reply, phone), status, start and end, exit
  code, prompt, answer, question, error, tool calls and the path of its JSONL
  events file (next to the database, `periodic-runs/<run>.jsonl`, deleted with
  the row). The runner emits `periodic-run` events while a run streams and once
  it ends. A run still marked running at start is `interrupted`.
- **Scheduling (ADR 044 rules, frontend).** The 15-second runner keeps the due,
  skip, no-catch-up, revision and auto-pause rules. A slot due while a run goes
  is **skipped** and recorded in the run log; nothing starts. `failed` and
  `timed_out` count towards the 3-in-a-row auto-pause; `ok` and `needs_input`
  reset it. **Run now**, the tile's **reply box** and a **phone reply** are
  immediate runs with the same rules (a reply's text is the prompt), skipped
  while one is going. The runner applies a run's result when its `periodic-run`
  event says it ended, and on every tick from the stored run, so a run that
  ended while the app was busy (or before a remount) is never lost.
- **Open interactively.** The tile's **Open interactively** opens an ordinary
  Copilot tile in the same workstream resuming S (offered once the first run
  created the session, and not while a run goes). While **any** ordinary
  Copilot tile, open in a workstream that isn't archived, is linked to S
  (`interactive_tile_id`, computed by the store), the schedule is paused: the
  tile says *Paused while open interactively*, due slots pass without running,
  and Run now, replies and the native runner itself refuse. Closing it resumes
  the schedule; a slot that came due meanwhile is passed over, never caught up.
- **Results are delivered by Workstreams.** With **Notify in Inbox** on, an ok
  run's final answer becomes an Inbox entry from the tile. `needs_input`,
  `failed` and `timed_out` runs always create one (the auto-pause's own alert
  stands for the failure that caused it, so a pause adds exactly one entry).
  With **Notify my phone** on and the companion on, the run's prompt and final
  answer go to the tile's phone thread (opened, named after the tile, on first
  use; not counted against an agent's 20/hour). Periodic tiles are published to
  the phone; a phone reply in their thread is recorded there and runs as the
  next headless turn, whose answer goes back to the thread. Every Inbox write
  goes through the Inbox mute gate ([ADR 045](045-pipeline-digest-and-inbox-mute.md)).
- **Migration, once.** On start, each schedule still on an ordinary Copilot
  tile becomes a new Periodic session tile in the same workstream on the
  **same** session id (the old tile's `copilot_session_id` / `resume_by_id`; a
  fresh one if it had none), keeping prompt, frequency, toggles, paused state
  and history (old result names are normalised). The old tile stays an ordinary
  Copilot tile and shows a one-time notice (`pending_notice` in its config,
  shown and cleared by the app) that its schedule moved; while it is open on
  the session, the pause above applies. Idempotent: a migrated schedule is on a
  Periodic session tile.
- **Agent commands.** `schedule.create` makes a new Periodic session tile on a
  fresh session in the caller's workstream (the caller's tile is untouched;
  `tile=` is refused with `BAD_SCHEDULE`). `schedule.list` reports each
  schedule's session and last result (`needs_input` included); `run`, `pause`,
  `resume` and `delete` (which removes the tile) keep working with the same
  error codes.

Pipeline-investigation follow-ups (ADR 045) still resume an interactive tile;
moving them to the headless runner is a later change.

## Rejected

- **Keeping the resumed terminal and detecting questions heuristically**: a
  run could still stall on a permission prompt, and a heuristic misreads.
- **The Copilot SDK or a Node sidecar**: the CLI's non-interactive mode does
  what is needed with no new runtime.
- **A new session per run**: the agent would forget earlier runs.
- **Forcing permission flags**: the configured command is the user's choice;
  a denied tool fails the turn, it never waits.
- **Running alongside the old interactive schedules**: two ways to schedule
  the same thing, and the stalls stay.
- **A per-run cost cap**: out of scope; the 60-minute timeout bounds a run.

## Consequences

- No run can block on input: each ends with a result within 60 minutes.
- A schedule's session can be watched or taken over in an ordinary tile, but
  not while the schedule runs it; an old tile left open after the migration
  keeps its schedule paused until it is closed (its notice says so).
- Open interactively is unavailable until the first run created the session.
- The run log costs one row and one JSONL file per run, 50 per tile.

## References

- [ADR 044: Periodic Copilot sessions](044-periodic-sessions.md)
- [ADR 033: Phone companion](033-phone-companion.md)
- [ADR 041: Agent messages in the Inbox](041-agent-messages-and-inbox-retention.md)
- [ADR 045: Daily failure digest and Mute all](045-pipeline-digest-and-inbox-mute.md)
