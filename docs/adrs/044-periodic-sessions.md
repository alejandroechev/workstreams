---
id: "044"
status: Accepted
date: 2026-11-23
---

# ADR 044: Periodic Copilot sessions, and phone messages from any session

## Status

Accepted (2026-11-23). Amends [ADR 033](033-phone-companion.md): any Copilot
session may now message the phone.

## Context

Recurring agent chores ("check the course for new videos and update the
summary") needed a person to start each run. And only sessions the phone had
started or messaged could reply to the phone, so a laptop or scheduled session
could not report there. Copilot CLI has its own `/every`, but it lives inside
one running CLI process: it dies with the process, can't be seen or controlled
from Workstreams, and can't wake a session whose workstream isn't loaded.

## Decision

**Workstreams owns the schedule, and each run resumes the same session.**

- A schedule belongs to one Copilot session tile (one per tile, many per
  workstream). At each due time the app resumes the tile's linked session in
  the same tile with the schedule's prompt — `<command> --resume=<id> -i
  <prompt>`, the tile's configured Copilot command unchanged (no permission
  flags added) — reusing the phone's resume path (`resumeTileSession` in
  `src/companion/resume-session.ts`: mount in the background if needed, stop,
  clear stale locks, respawn, with the same re-link guards). A workstream
  mounted for a run stays loaded. The session the tile is linked to *at run
  time* is resumed, so re-linking keeps the schedule.
- **Presets only:** hourly, every N hours, every N minutes, daily at HH:MM,
  weekly on DAY at HH:MM — never more often than every **5 minutes**
  (refused in the UI, the backend and the agent command with the same
  message). Daily and weekly times are the laptop's local wall clock, so they
  follow DST; intervals run on the series *anchor + k·interval*. "Every N
  minutes" exists only so that the 5-minute minimum is expressible.
- **Never piled up, never caught up.** A run due while the tile's agent is
  mid-turn (its session's `activity_status` is thinking / tool_use /
  responding, read from a small app-wide registry fed by the session poller)
  is **skipped** and recorded as such; typing in the tile doesn't count, so a
  run still happens then. Only a slot that fell while the scheduler was
  running runs: one due before the first tick after the app starts, or inside
  a gap of more than 2 minutes between timer callbacks (the laptop slept), is
  skipped silently and the next one planned. Every timer callback counts as a
  heartbeat, even one that joins a slow tick. A run that waited for its tile
  (a phone message holding it) is skipped if, by then, the tile was relaunched
  or its agent is busy — read live, under the tile's lock, from the session's
  events (a turn started and not closed, a sub-agent running inside it
  included), not from the poller's last snapshot. A Run now request expires after 5 minutes
  or when it predates this app start. A new schedule first runs at its first
  scheduled time, never on creation. There is no sleep prevention.
- **The prompt is sent verbatim.** Two per-schedule toggles, **Notify in
  Inbox** and **Notify my phone** (both off by default), append one fixed
  instruction each, naming `ws-message` and `companion-reply`.
- **Runaway protection.** Right before the spawn, the runner reads the
  resumed session's turn cursor — how many turns its `events.jsonl` has
  started and ended (`session_turn_state`; resuming appends to the same file)
  — and follows that session, not the tile's current link. The first turn to
  start after the cursor is the run's own, and the first end closes it: the
  run is *ok*, and its timeout is disarmed, whatever turns follow — provided
  the tile still runs the process the run launched; if it was restarted first
  (a phone message), the run is *interrupted*. If that turn is still open after **60
  minutes** it gets one Ctrl+C (interrupted, the session left idle) and counts
  as a failure ("timed out") — but only if the tile still runs the process the
  schedule launched: every spawn and close bumps a per-tile generation, and a
  run whose tile was restarted since (a phone message, by hand) is recorded
  *interrupted* instead. An outcome is kept until it is stored, and retried
  without repeating its Ctrl+C. A run that cannot
  start (tile gone, not linked, spawn error, or no turn seen within 5 minutes)
  is a failure ("could not start"); a skip is not. A run still marked running
  when the app starts is recorded *interrupted*, which is not a failure.
  After **3 consecutive failures** the schedule pauses itself and posts one
  Inbox entry (an app-raised `agent_messages` row, not rate limited) naming
  the schedule and the reason, written in the same transaction as the pause
  (`schedule_update` with an alert), so an exit in between loses neither. Resuming clears the count.
- **Lifecycle.** Closing or deleting the tile deletes its schedule (`ON DELETE
  CASCADE`). Archiving the workstream pauses its schedules; unarchiving leaves
  them paused. Schedules, pause state, last result and failure count live in
  SQLite (`periodic_schedules`) and survive restarts.

**Where it runs.** The rules are a pure TypeScript model
(`src/domain/periodic-schedules.ts`: validation, `nextRunAfter`, the due
decision, failure counting, prompt composition) and a runner
(`src/domain/schedule-runner.ts`) driven by a timer every 15 s next to the
companion runtime (`src/schedules/useSchedules.ts`). Ticks never overlap, so a
due run starts once. Each schedule has a revision bumped on every change; the
runner writes its decisions against the revision it read, so a pause, edit,
delete or archive in between wins, and re-checks the schedule (still there,
same revision, workstream not archived) before stopping the tile and before
spawning. A changed schedule cancels the run without counting a failure.
Phone messages and scheduled runs resume one at a time per tile; all due
slots are claimed first and then launched together, so one tile's queue
doesn't hold back the others. A resume that fails after stopping the tile
relaunches it plainly, except in a workstream being archived. Rust stores and validates (`periodic_schedules.rs`).
`next_run_at = NULL` means "the app plans it from now", which is how agent-
created and agent-resumed schedules get their first time without Rust knowing
the calendar rules. No feature flag.

**UI.** A Copilot session tile's header menu has **Run periodically…** (or
**Edit schedule…**); the add-tile menu has **Periodic Copilot Session**, which
starts the new session on a short setup prompt (quoting the scheduled prompt
and asking it to wait), because Copilot assigns a session id only once a
prompt is sent and scheduled runs resume by that id. A
periodic tile shows a badge with the next run and last result. A **Schedules**
button in the sidebar footer opens a modal listing every schedule
(workstream, tile, the prompt's first line, frequency, next run, last result)
with Run now, Pause/Resume, Edit and Delete (the tile stays). Workstreams with
schedules show a clock on their sidebar row. Run now is skipped, like a due
run, while the agent is mid-turn; it runs a paused schedule once without
resuming it.

**Agent commands** (CLI parity): `schedule.create` (`prompt`, `frequency =
hourly | every:<N>h | every:<N>m | daily:HH:MM | weekly:<day>:HH:MM`, optional
`tile` in the caller's workstreams, `notify_inbox`, `notify_phone`),
`schedule.list` (only the workstreams the caller may act on), `schedule.run`,
`schedule.pause`, `schedule.resume`, `schedule.delete` (by `id` or `tile`).
Run now and Resume are refused for an archived workstream (UI, runner and
`WORKSTREAM_ARCHIVED`). Each raises `state-changed`
(`schedule`), and the runner acts on it at once; `schedule.run` sets
`run_requested`, which the next tick consumes.

**Phone messages from any session** (amends ADR 033).

- `companion.send` works from any Copilot session tile of the caller's
  workstream while the companion is on (terminal tiles, which carry a token
  too, get `NOT_A_SESSION`). Re-linking is one native transaction
  (`relink_tile_session`): the tile's new link, its thread's revocation and
  barring its running processes; a claim and the spawn of a resume (which
  issues its token) both check the tile's current link under the same lock.
  Each token names its process; re-linking a tile
  bars its running processes, which still run the old session, in the
  database (`companion_barred_processes`) under the same lock every agent
  send runs under (`SESSION_RELINKED`); a process spawned since may send. A
  resume rolling back revokes only the thread its own request claimed, and
  never bars a process. A tile without a phone thread gets one on its agent's first message,
  titled by the tile (`companion_sessions.prompt` holds the title); the phone
  can then message it like any session. A revoked thread (the tile was
  re-linked) is replaced by a fresh one, as a phone claim already did.
- At most **20 phone messages per tile per rolling hour** (`RATE_LIMITED`),
  counting the agent's `progress`/`result` messages in a send ledger
  (`companion_send_log`, written in the send's transaction) that thread
  replacement and pruning don't touch, separately from the Inbox's 20/hour. Refused sends add nothing. Companion off is unchanged
  (`COMPANION_OFF`). `NOT_A_PHONE_SESSION` no longer exists.
- For a scheduled tile, with the companion on, each run records its prompt as
  a `prompt` message in the tile's thread before resuming (creating the thread
  if needed), so the phone reads prompt, reply, prompt, reply. A failure to
  record never stops the run. Other laptop tiles show only what their agents
  send.
- The `companion-reply` skill says it works from any Workstreams session;
  `ws-message` stays Inbox-only.

## Rejected

- **Copilot CLI's `/every`**: tied to one live process, invisible to the app,
  can't mount a workstream.
- **Cron expressions and free intervals**: presets cover the asked-for chores
  and are easy to read back.
- **Catching up missed runs**: a laptop that slept all night would fire a
  backlog of stale runs.
- **A new session per run**: the agent would forget earlier runs.
- **Forcing allow-all for scheduled runs**: the configured command is the
  user's choice; a run that stops at a permission prompt times out and
  eventually pauses itself.
- **Scheduler in Rust**: the resume path, the tile activity and the mount all
  live in the frontend; duplicating them natively would split one behaviour
  in two.

## Consequences

- Runs happen only while Workstreams is open; a closed app or sleeping laptop
  loses those runs by design.
- A run interrupts nothing the user typed but may interleave with it if they
  are typing at the due time (accepted).
- Activity status can lag the poller, so a run may be judged idle while a turn
  is finishing; the cost is one interrupted turn, the same as a phone message.
- Every laptop tile that replies once to the phone gets a thread; the 3-day
  retention of ADR 033 bounds them.

## References

- [ADR 033: Phone companion](033-phone-companion.md)
- [ADR 041: Agent messages in the Inbox](041-agent-messages-and-inbox-retention.md)
- [ADR 026: Agent-driven workstreams and the agent channel](026-agent-driven-workstreams.md)
- [ADR 029: Persisted loaded workstreams](029-persisted-loaded-workstreams.md)
