/**
 * Periodic Copilot sessions (ADR 044): the pure model.
 *
 * A schedule belongs to one Copilot session tile. At each due time the app
 * resumes that tile's session with the schedule's prompt. Everything here is
 * free of I/O so the runner (`schedule-runner.ts`) and the UI share one set
 * of rules. Times are ms epoch; calendar presets are in the laptop's local
 * time, so `Date`'s local constructors keep them DST-correct.
 */

export type ScheduleFrequency =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; day: number; time: string };

/**
 * "interrupted": the run was cut short by something else (the app quit, or
 * the tile was restarted by a phone message or by hand). Not a failure.
 */
export type ScheduleResult = "ok" | "running" | "skipped" | "interrupted" | "could not start" | "timed out";

export interface PeriodicSchedule {
  id: string;
  tile_id: string;
  workstream_id: string;
  prompt: string;
  frequency: ScheduleFrequency;
  notify_inbox: boolean;
  notify_phone: boolean;
  paused: boolean;
  /** Null: not planned yet (new from an agent, or just resumed); the runner plans it. */
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: ScheduleResult | null;
  last_error: string | null;
  /** Consecutive failures ("could not start", "timed out"); a skip doesn't count. */
  failures: number;
  /** "Run now" asked for (UI or `schedule.run`); the runner clears it. */
  run_requested: boolean;
  /** When Run now was asked for; an old request, or one from before this app started, expires. */
  run_requested_at: number | null;
  created_at: number;
  /** Bumped on every stored change; the runner claims a run against the revision it read. */
  revision: number;
}

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const RUN_TIMEOUT_MS = 60 * 60 * 1000;
/** Ticks further apart than this mean the scheduler wasn't running in between (laptop asleep). */
export const MAX_TICK_GAP_MS = 2 * 60 * 1000;
/** A Run now not picked up within this long is dropped. */
export const RUN_REQUEST_TTL_MS = 5 * 60 * 1000;

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const INBOX_INSTRUCTION =
  "When you are done, use the ws-message skill to send me one message in the Workstreams Inbox with the result.";
export const PHONE_INSTRUCTION =
  "When you are done, use the companion-reply skill to send the result to my phone.";

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Why a frequency is refused, or null. */
export function validateFrequency(frequency: ScheduleFrequency): string | null {
  switch (frequency.kind) {
    case "interval":
      if (frequency.minutes < MIN_INTERVAL_MINUTES) {
        return `A schedule can't run more often than every ${MIN_INTERVAL_MINUTES} minutes.`;
      }
      return Number.isInteger(frequency.minutes) ? null : "The interval must be a whole number of minutes.";
    case "daily":
      return TIME.test(frequency.time) ? null : "The time must be HH:MM (24-hour).";
    case "weekly":
      if (!Number.isInteger(frequency.day) || frequency.day < 0 || frequency.day > 6) return "The day must be 0 (Sunday) to 6 (Saturday).";
      return TIME.test(frequency.time) ? null : "The time must be HH:MM (24-hour).";
    default:
      return `Unknown frequency: ${(frequency as { kind?: string }).kind}`;
  }
}

/** The interval in minutes, or null for calendar presets. */
export function frequencyMinutes(frequency: ScheduleFrequency): number | null {
  return frequency.kind === "interval" ? frequency.minutes : null;
}

const hm = (time: string) => time.split(":").map(Number) as [number, number];

/**
 * The first run strictly after `now`. Intervals follow the series
 * `anchor + k·interval` (k ≥ 1), so missed slots are skipped rather than
 * caught up; daily and weekly presets use local wall-clock time.
 */
export function nextRunAfter(frequency: ScheduleFrequency, anchor: number, now: number): number {
  if (frequency.kind === "interval") {
    const step = frequency.minutes * 60_000;
    // Floor also extends the series backwards when the clock moved before the anchor.
    const k = Math.floor((now - anchor) / step) + 1;
    return anchor + k * step;
  }
  const [hours, minutes] = hm(frequency.time);
  const today = new Date(now);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, hours, minutes, 0, 0);
    if (frequency.kind === "weekly" && candidate.getDay() !== frequency.day) continue;
    if (candidate.getTime() > now) return candidate.getTime();
  }
  /* c8 ignore next */
  throw new Error("unreachable: a weekly time always occurs within 8 days");
}

export type DueDecision =
  | { action: "wait" }
  | { action: "plan" }
  | { action: "missed" }
  | { action: "expire" }
  | { action: "skip"; manual?: true }
  | { action: "run"; manual: boolean };

export interface DueContext {
  now: number;
  /** The tile's agent is mid-turn; typing in the tile doesn't count. */
  busy: boolean;
  /** The workstream is archived: nothing runs. */
  archived: boolean;
  /**
   * The previous tick, when the scheduler has been running since then; null
   * on the first tick after the app started or after a gap (asleep). Only a
   * slot that fell after it runs; anything older was missed.
   */
  activeSince: number | null;
  /** When this app instance started: older Run now requests expire. */
  startedAt: number;
}

/** What the runner should do with a schedule now. */
export function decideDue(schedule: PeriodicSchedule, context: DueContext): DueDecision {
  if (schedule.run_requested) {
    const at = schedule.run_requested_at;
    const fresh = at !== null && at >= context.startedAt && context.now - at <= RUN_REQUEST_TTL_MS;
    if (!fresh || context.archived) return { action: "expire" };
    // Run now is explicit, so it runs even a paused schedule; a paused one never runs by itself.
    return context.busy ? { action: "skip", manual: true } : { action: "run", manual: true };
  }
  if (schedule.paused || context.archived) return { action: "wait" };
  if (schedule.next_run_at === null) return { action: "plan" };
  if (context.now < schedule.next_run_at) return { action: "wait" };
  if (context.activeSince === null || schedule.next_run_at <= context.activeSince) return { action: "missed" };
  return context.busy ? { action: "skip" } : { action: "run", manual: false };
}

export type RunOutcome =
  | { result: "ok" }
  | { result: "skipped" }
  | { result: "interrupted" }
  | { result: "could not start"; error: string }
  | { result: "timed out" };

/** The state change a run's outcome causes, and whether it paused the schedule. */
export function applyRunResult(
  schedule: PeriodicSchedule,
  outcome: RunOutcome,
  now: number,
): { patch: Partial<PeriodicSchedule>; autoPaused: boolean } {
  if (outcome.result === "skipped") {
    return { patch: { last_result: "skipped", last_run_at: now }, autoPaused: false };
  }
  if (outcome.result === "interrupted") return { patch: { last_result: "interrupted" }, autoPaused: false };
  if (outcome.result === "ok") {
    return { patch: { last_result: "ok", last_error: null, failures: 0 }, autoPaused: false };
  }
  const failures = schedule.failures + 1;
  const error = outcome.result === "could not start" ? outcome.error : "The run was still going after 60 minutes, so it was interrupted.";
  const pause = failures >= MAX_CONSECUTIVE_FAILURES && !schedule.paused;
  return {
    patch: { last_result: outcome.result, last_error: error, failures, ...(pause ? { paused: true } : {}) },
    autoPaused: pause,
  };
}

/** The prompt a run sends: verbatim, plus one instruction per toggle that is on. */
export function composeRunPrompt(schedule: Pick<PeriodicSchedule, "prompt" | "notify_inbox" | "notify_phone">): string {
  const extra = [schedule.notify_inbox ? INBOX_INSTRUCTION : null, schedule.notify_phone ? PHONE_INSTRUCTION : null]
    .filter((line): line is string => line !== null);
  return extra.length === 0 ? schedule.prompt : `${schedule.prompt}\n\n${extra.join("\n")}`;
}

/**
 * The first prompt of a new periodic session tile. Copilot only assigns a
 * session id once a prompt is sent, and scheduled runs resume by that id, so
 * the tile starts on this instead of sitting empty.
 */
export function setupPrompt(draft: { prompt: string; frequency: ScheduleFrequency }): string {
  const quoted = draft.prompt.split("\n").map((line) => `> ${line}`).join("\n");
  return [
    `This is a periodic session created by Workstreams. ${describeFrequency(draft.frequency)}, it will be resumed and sent this prompt:`,
    "",
    quoted,
    "",
    "Do not start on it now. Just reply that you are ready and wait for the first scheduled run.",
  ].join("\n");
}

export function describeFrequency(frequency: ScheduleFrequency): string {
  switch (frequency.kind) {
    case "interval":
      if (frequency.minutes === 60) return "Hourly";
      if (frequency.minutes % 60 === 0) return `Every ${frequency.minutes / 60} hours`;
      return `Every ${frequency.minutes} minutes`;
    case "daily":
      return `Daily at ${frequency.time}`;
    case "weekly":
      return `Weekly on ${DAY_NAMES[frequency.day]} at ${frequency.time}`;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "today 18:05", "tomorrow 09:00", or "Mon 30 Nov 09:00". */
export function formatNextRun(nextRunAt: number | null, now: number): string {
  if (nextRunAt === null) return "not planned";
  const when = new Date(nextRunAt);
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const today = new Date(now);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(when) - dayStart(today)) / 86_400_000);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  return `${DAY_NAMES[when.getDay()].slice(0, 3)} ${when.getDate()} ${MONTHS[when.getMonth()]} ${clock}`;
}

export function describeLastResult(schedule: Pick<PeriodicSchedule, "last_result" | "last_error">): string {
  if (!schedule.last_result) return "never run";
  return schedule.last_error && schedule.last_result !== "ok" ? `${schedule.last_result}: ${schedule.last_error}` : schedule.last_result;
}

export function promptFirstLine(prompt: string): string {
  return prompt.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}
