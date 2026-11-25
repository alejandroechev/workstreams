/**
 * The daily failure digest of Daily-failures pipelines (ADR 045). The native
 * side (`src-tauri/src/pipeline_digest.rs`) is the source of truth; this
 * mirror lets the in-memory backend behave the same in tests and E2E, and
 * holds what the Inbox shows.
 */

/** When digests are posted unless the user picks another time. */
export const DEFAULT_DIGEST_TIME = "09:00";
/** Failed runs per pipeline per local day whose failing step is fetched. */
export const STEP_FETCHES_PER_DAY = 20;
/** The longest gap one digest covers. */
export const MAX_WINDOW_DAYS = 7;
/** New auto-started investigations allowed in any rolling 24 hours. */
export const AUTO_STARTS_PER_DAY = 3;

/** Whether a Daily-failures pipeline's digest also starts its investigation. */
export type AutoInvestigate = "off" | "digest";

export const AUTO_INVESTIGATE_LABELS: Record<AutoInvestigate, string> = { off: "Off", digest: "With digest" };

/** Whether the failing step of a failed run is known, coming, or won't be fetched. */
export type StepState = "none" | "pending" | "fetched" | "not_fetched";

/** A run kept for a digest (every in-scope run, so totals can be counted). */
export interface KeptRun {
  run_id: number;
  run_number: string;
  result: string;
  branch: string;
  trigger: string;
  finished_at: string;
  commit: string;
  step: string | null;
  step_state: StepState;
}

/** `YYYY-MM-DD` of a date in the local time zone. */
export function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A failed run in a digest, newest first. */
export interface DigestRun {
  run_id: number;
  run_number: string;
  branch: string;
  trigger: string;
  finished_at: string;
  commit: string;
  url: string;
  step: string | null;
  step_state: StepState;
  /** The workstream investigating this one run, when there is one. */
  investigation: string | null;
}

/** One digest entry in the Inbox: a failing pipeline's day. */
export interface PipelineDigest {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  project: string;
  organization: string;
  repo: string | null;
  window_start: string;
  window_end: string;
  total: number;
  failed: number;
  state: "still_failing" | "passed_since";
  runs: DigestRun[];
  is_read: boolean;
  created_at: string;
  /** The workstream investigating this digest's failures, when there is one. */
  investigation: string | null;
  /** Auto-investigate will start its investigation on the app's next pass. */
  auto_pending: boolean;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether a digest time is `HH:MM` (24-hour). */
export function isDigestTime(text: string): boolean {
  return TIME.test(text.trim());
}

/**
 * The instant a local wall-clock time names, as pipeline_digest::resolve: the
 * earlier one when the clock is set back, and for a time skipped by a
 * spring-forward the first valid minute after the gap (JS alone would move it
 * forward by the gap's length).
 */
export function localInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  for (let k = 0; k <= 180; k++) {
    const wall = new Date(Date.UTC(year, month, day, hour, minute + k));
    const at = new Date(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes());
    if (at.getHours() === wall.getUTCHours() && at.getMinutes() === wall.getUTCMinutes() && at.getDate() === wall.getUTCDate()) return at;
  }
  return new Date(year, month, day, hour, minute);
}

/**
 * The latest scheduled digest at or before `now`: today's digest time, or
 * yesterday's when today's hasn't come. Local wall-clock time, so a DST change
 * moves it with the clock (a skipped time resolves to the first instant after).
 */
export function lastSlot(now: Date, time: string): Date {
  const match = TIME.exec(time.trim());
  const [h, m] = match ? [Number(match[1]), Number(match[2])] : [9, 0];
  for (let back = 0; back < 3; back++) {
    const at = localInstant(now.getFullYear(), now.getMonth(), now.getDate() - back, h, m);
    if (at.getTime() <= now.getTime()) return at;
  }
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

/** "5 of 12 failed". */
export function digestCounts(digest: Pick<PipelineDigest, "failed" | "total">): string {
  return `${digest.failed} of ${digest.total} failed`;
}

export function digestStateLabel(state: PipelineDigest["state"]): string {
  return state === "passed_since" ? "Passed since" : "Still failing";
}

/** What an expanded run says about its failing step. */
export function stepLabel(run: Pick<DigestRun, "step" | "step_state">): string {
  if (run.step) return run.step;
  if (run.step_state === "not_fetched") return "step not fetched";
  if (run.step_state === "pending") return "step not known yet";
  return "no failing step reported";
}
