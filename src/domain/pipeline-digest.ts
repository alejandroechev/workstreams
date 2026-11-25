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
