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
  run still happens then. A due time more than 2 minutes old when first seen
  (the app was closed or the laptop asleep) is skipped silently and the next
  one planned. A new schedule first runs at its first scheduled time, never on
  creation. There is no sleep prevention.
- **The prompt is sent verbatim.** Two per-schedule toggles, **Notify in
  Inbox** and **Notify my phone** (both off by default), append one fixed
  instruction each, naming `ws-message` and `companion-reply`.
- **Runaway protection.** A run whose agent is still mid-turn after **60
  minutes** gets one Ctrl+C (the turn is interrupted, the session left idle)
  and counts as a failure ("timed out"). A run that cannot start (tile gone,
  not linked, spawn error) is a failure ("could not start"); a skip is not.
  After **3 consecutive failures** the schedule pauses itself and posts one
  Inbox entry (an app-raised `agent_messages` row, not rate limited) naming
  the schedule and the reason. Resuming clears the count.
- **Lifecycle.** Closing or deleting the tile deletes its schedule (`ON DELETE
  CASCADE`). Archiving the workstream pauses its schedules; unarchiving leaves
  them paused. Schedules, pause state, last result and failure count live in
  SQLite (`periodic_schedules`) and survive restarts.

**Where it runs.** The rules are a pure TypeScript model
(`src/domain/periodic-schedules.ts`: validation, `nextRunAfter`, the due
decision, failure counting, prompt composition) and a runner
(`src/domain/schedule-runner.ts`) driven by a timer every 15 s next to the
companion runtime (`src/schedules/useSchedules.ts`). Ticks never overlap, so a
due run starts once. Rust stores and validates (`periodic_schedules.rs`).
`next_run_at = NULL` means "the app plans it from now", which is how agent-
created and agent-resumed schedules get their first time without Rust knowing
the calendar rules. No feature flag.

**UI.** A Copilot session tile's header menu has **Run periodically…** (or
**Edit schedule…**); the add-tile menu has **Periodic Copilot Session**. A
periodic tile shows a badge with the next run and last result. A **Schedules**
button in the sidebar footer opens a modal listing every schedule
(workstream, tile, the prompt's first line, frequency, next run, last result)
with Run now, Pause/Resume, Edit and Delete (the tile stays). Workstreams with
schedules show a clock on their sidebar row. Run now is skipped, like a due
run, while the agent is mid-turn.

**Agent commands** (CLI parity): `schedule.create` (`prompt`, `frequency =
hourly | every:<N>h | every:<N>m | daily:HH:MM | weekly:<day>:HH:MM`, optional
`tile` in the caller's workstreams, `notify_inbox`, `notify_phone`),
`schedule.list`, `schedule.run`, `schedule.pause`, `schedule.resume`,
`schedule.delete` (by `id` or `tile`). Each raises `state-changed`
(`schedule`), and the runner acts on it at once; `schedule.run` sets
`run_requested`, which the next tick consumes.

**Phone messages from any session** (amends ADR 033).

- `companion.send` works from any Copilot session tile while the companion is
  on. A tile without a phone thread gets one on its agent's first message,
  titled by the tile (`companion_sessions.prompt` holds the title); the phone
  can then message it like any session. A revoked thread (the tile was
  re-linked) is replaced by a fresh one, as a phone claim already did.
- At most **20 phone messages per tile per rolling hour** (`RATE_LIMITED`),
  counting the agent's `progress`/`result` messages only, separately from the
  Inbox's 20/hour. Refused sends add nothing. Companion off is unchanged
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
