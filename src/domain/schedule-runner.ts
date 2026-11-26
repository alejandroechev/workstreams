/**
 * Runs periodic schedules (ADR 044, ADR 046). The app calls `tick(now)` on a
 * timer; each tick reads the stored schedules, settles runs that ended, and
 * starts, skips or re-plans due ones with the rules in `periodic-schedules.ts`.
 *
 * A run is one headless Copilot call the native runner makes and finishes on
 * its own (ok, failed, timed out or needs input); the runner here only starts
 * it and applies its result. Every decision is written back against the
 * revision it was made on, so a pause, edit, delete or archive in between
 * wins. Ticks never overlap, so a due run starts at most once. Everything
 * outside — the store, starting a run, notifications — comes in through
 * `deps`, so the runner is driven with a fake clock in tests.
 */
import type { PeriodicSchedulePatch } from "../backend/types";
import {
  applyRunResult,
  decideDue,
  MAX_TICK_GAP_MS,
  nextRunAfter,
  outcomeOfRun,
  PAUSED_INTERACTIVE,
  promptFirstLine,
  type PeriodicRun,
  type PeriodicRunKind,
  type PeriodicSchedule,
  type RunOutcome,
} from "./periodic-schedules";

/** The Inbox entry stored with an auto-pause, in the same transaction. */
export interface PauseAlert {
  title: string;
  body: string;
}

export interface ScheduleRunnerDeps {
  list(): Promise<PeriodicSchedule[]>;
  /**
   * With `expectedRevision`, rejects unless the row is still that revision.
   * With `alert`, stores it as the tile's Inbox entry in the same transaction.
   */
  update(id: string, patch: PeriodicSchedulePatch, expectedRevision?: number, alert?: PauseAlert): Promise<PeriodicSchedule>;
  workstreamName(workstreamId: string): string | undefined;
  isArchived(workstreamId: string): boolean;
  /** Starts a headless run on the tile's session; rejects when it can't (already going, open interactively, spawn refused). */
  start(schedule: PeriodicSchedule, prompt: string, kind: PeriodicRunKind, now: number): Promise<PeriodicRun>;
  getRun(id: string): Promise<PeriodicRun | null>;
  /** The tile's newest run, or null. */
  latestRun(tileId: string): Promise<PeriodicRun | null>;
  /** Records a slot, Run now or reply skipped because a run was going. */
  recordSkip(schedule: PeriodicSchedule, kind: PeriodicRunKind, prompt: string, now: number): Promise<void>;
  /** Delivers a finished run (Inbox, phone); `autoPaused`: its failure paused the schedule and the alert says so. */
  notify(schedule: PeriodicSchedule, run: PeriodicRun, autoPaused: boolean): Promise<void>;
  /** Stored schedules changed. */
  onChange(): void;
}

export interface ScheduleRunnerOptions {
  /** Ticks further apart than this mean the scheduler wasn't running between them. */
  maxGapMs?: number;
  /** When this app instance started; older Run now requests expire. */
  startedAt?: number;
}

interface InFlight {
  runId: string;
  /** Decided but not stored yet; retried every settle, notified once. */
  outcome?: RunOutcome;
  run?: PeriodicRun;
}

export interface ScheduleRunner {
  tick(now: number): Promise<void>;
  /** Applies the result of runs that ended (a `periodic-run` event said so), without deciding due slots. */
  settle(now: number): Promise<void>;
  /** Asks for a run now and ticks; skipped while a run is going. */
  runNow(id: string, now: number): Promise<void>;
  /**
   * Runs `text` as the session's next turn at once (the tile's reply box, or
   * a phone reply). Rejects, starting nothing, while the tile is open
   * interactively or its workstream is archived; a run going makes it a
   * recorded skip, and rejects.
   */
  reply(id: string, text: string, kind: "reply" | "phone", now: number): Promise<PeriodicRun>;
}

const ARCHIVED = "This schedule's workstream is archived; unarchive it first.";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isBusyError = (error: unknown) => /already going/i.test(error instanceof Error ? error.message : String(error));
const isInteractiveError = (error: unknown) => /open interactively/i.test(error instanceof Error ? error.message : String(error));

export function createScheduleRunner(deps: ScheduleRunnerDeps, options: ScheduleRunnerOptions = {}): ScheduleRunner {
  const maxGapMs = options.maxGapMs ?? MAX_TICK_GAP_MS;
  const startedAt = options.startedAt ?? 0;
  const inFlight = new Map<string, InFlight>();
  let current: Promise<void> | null = null;
  /** The last timer callback, and since when they have come without a gap (awake). */
  let lastBeat: number | null = null;
  let awakeSince = 0;
  /** When the last tick made its decisions. */
  let lastEvaluatedAt: number | null = null;

  function beat(now: number): void {
    if (lastBeat === null || now - lastBeat > maxGapMs) awakeSince = now;
    lastBeat = now;
  }

  /** Stores a run's outcome; an auto-pause and its Inbox entry are stored together. */
  async function store(schedule: PeriodicSchedule, outcome: RunOutcome, now: number): Promise<boolean> {
    const { patch, autoPaused } = applyRunResult(schedule, outcome, now);
    if (!autoPaused) {
      await deps.update(schedule.id, patch);
      return false;
    }
    const name = clip(promptFirstLine(schedule.prompt), 120);
    const where = clip(deps.workstreamName(schedule.workstream_id) ?? "its workstream", 120);
    const title = clip(`Schedule paused: ${name}`, 120);
    const body =
      `The periodic run **${name}** in ${where} failed ${patch.failures} times in a row, so it was paused.\n\n` +
      `Last failure: ${(patch.last_result ?? "").replace(/_/g, " ")}: ${clip(patch.last_error ?? "", 500)}\n\nResume it from the tile or **Schedules** once it's fixed.`;
    await deps.update(schedule.id, patch, undefined, { title, body });
    return true;
  }

  /** Applies an ended run to its schedule, then notifies once; kept to retry when the store fails. */
  async function conclude(schedule: PeriodicSchedule, flight: InFlight, now: number): Promise<boolean> {
    if (!flight.outcome) return false;
    try {
      const autoPaused = await store(schedule, flight.outcome, now);
      inFlight.delete(schedule.id);
      if (flight.run) await deps.notify(schedule, flight.run, autoPaused).catch((error) => console.error("Failed to deliver a periodic run's result:", error));
      return true;
    } catch (error) {
      console.error("Failed to store a periodic run's result; will retry:", error);
      return false;
    }
  }

  async function monitor(schedules: Map<string, PeriodicSchedule>, now: number): Promise<void> {
    for (const [id, flight] of [...inFlight]) {
      const schedule = schedules.get(id);
      if (!schedule) {
        inFlight.delete(id);
        continue;
      }
      if (!flight.outcome) {
        const run = await deps.getRun(flight.runId).catch(() => undefined);
        if (run === undefined) continue;
        if (run === null) flight.outcome = { result: "interrupted" };
        else {
          const outcome = outcomeOfRun(run);
          if (!outcome) continue;
          flight.outcome = outcome;
          flight.run = run;
        }
      }
      await conclude(schedule, flight, now);
    }
  }

  /** Marks the run as started against the row it was decided on; null if that row changed. */
  async function claim(schedule: PeriodicSchedule, plan: PeriodicSchedulePatch, now: number): Promise<PeriodicSchedule | null> {
    try {
      return await deps.update(schedule.id, {
        last_result: "running", last_run_at: now, run_requested: false, run_requested_at: null, ...plan,
      }, schedule.revision);
    } catch {
      return null; // Changed (or deleted) since it was read: decided afresh.
    }
  }

  /** Starts a claimed run; a refusal is a skip, a cancel or a failure, never left "running". */
  async function launch(before: PeriodicSchedule, claimed: PeriodicSchedule, prompt: string, kind: PeriodicRunKind, now: number): Promise<PeriodicRun> {
    try {
      const run = await deps.start(claimed, prompt, kind, now);
      inFlight.set(claimed.id, { runId: run.id });
      return run;
    } catch (error) {
      if (isBusyError(error)) {
        await deps.recordSkip(claimed, kind, prompt, now).catch(() => {});
        await deps.update(claimed.id, applyRunResult(claimed, { result: "skipped" }, now).patch).catch(() => {});
      } else if (isInteractiveError(error)) {
        // Not a run at all: put back what the claim changed, other than the plan.
        await deps.update(claimed.id, { last_result: before.last_result, last_error: before.last_error, last_run_at: before.last_run_at })
          .catch(() => {});
      } else {
        const outcome: RunOutcome = { result: "failed", error: error instanceof Error ? error.message : String(error) };
        const flight: InFlight = { runId: "", outcome };
        inFlight.set(claimed.id, flight);
        await conclude(claimed, flight, now);
      }
      throw error;
    }
  }

  /** A schedule left "running" with no run followed here: adopt the native run, apply its end, or call it interrupted. */
  async function adopt(schedule: PeriodicSchedule, now: number): Promise<PeriodicSchedule> {
    const latest = await deps.latestRun(schedule.tile_id).catch(() => null);
    const mine = latest && latest.status !== "skipped" && latest.started_at >= (schedule.last_run_at ?? 0) ? latest : null;
    if (mine?.status === "running") {
      inFlight.set(schedule.id, { runId: mine.id });
      return schedule;
    }
    const outcome = (mine && outcomeOfRun(mine)) ?? { result: "interrupted" as const };
    const flight: InFlight = { runId: mine?.id ?? "", outcome, run: mine ?? undefined };
    inFlight.set(schedule.id, flight);
    await conclude(schedule, flight, now);
    return (await deps.list()).find((s) => s.id === schedule.id) ?? schedule;
  }

  interface Due { before: PeriodicSchedule; claimed: PeriodicSchedule; kind: PeriodicRunKind }

  /** Decides one schedule; a due run is claimed and returned, to be launched with the others. */
  async function step(schedule: PeriodicSchedule, now: number, activeSince: number | null): Promise<Due | null> {
    if (!inFlight.has(schedule.id) && schedule.last_result === "running") schedule = await adopt(schedule, now);
    const flying = inFlight.has(schedule.id);
    const decision = decideDue(schedule, {
      now, busy: flying, interactive: !!schedule.interactive_tile_id, archived: deps.isArchived(schedule.workstream_id), activeSince, startedAt,
    });
    const write = (patch: PeriodicSchedulePatch) => deps.update(schedule.id, patch, schedule.revision);
    switch (decision.action) {
      case "wait":
        return null;
      case "plan":
        await write({ next_run_at: nextRunAfter(schedule.frequency, now, now) });
        return null;
      case "missed":
        await write({ next_run_at: nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now) });
        return null;
      case "expire":
        await write({ run_requested: false, run_requested_at: null });
        return null;
      case "skip": {
        const next = decision.manual ? {} : { next_run_at: nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now) };
        await deps.recordSkip(schedule, decision.manual ? "manual" : "scheduled", schedule.prompt, now);
        // The run going keeps showing as running; the skip is in its run log.
        await write({ ...next, run_requested: false, run_requested_at: null });
        return null;
      }
      case "run": {
        const plan = decision.manual
          ? { next_run_at: schedule.next_run_at ?? nextRunAfter(schedule.frequency, now, now) }
          : { next_run_at: nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now) };
        const claimed = await claim(schedule, plan, now);
        return claimed ? { before: schedule, claimed, kind: decision.manual ? "manual" : "scheduled" } : null;
      }
    }
  }

  function tick(now: number): Promise<void> {
    // Every timer callback counts as a heartbeat, even one that joins a slow tick.
    beat(now);
    // Joining the tick in progress rather than starting another: a due run starts once.
    if (current) return current;
    current = runTick(now, true).finally(() => { current = null; });
    return current;
  }

  function settle(now: number): Promise<void> {
    if (current) return current.then(() => settle(now));
    current = runTick(now, false).finally(() => { current = null; });
    return current;
  }

  async function runTick(now: number, decide: boolean): Promise<void> {
    // Slots after the last decisions run, unless they fell before the scheduler woke up.
    const activeSince = lastEvaluatedAt === null ? null : Math.max(lastEvaluatedAt, awakeSince);
    if (decide) lastEvaluatedAt = now;
    let changed = false;
    try {
      const schedules = await deps.list();
      const before = JSON.stringify(schedules);
      await monitor(new Map(schedules.map((s) => [s.id, s])), now);
      if (decide) {
        const due: Due[] = [];
        for (const schedule of await deps.list()) {
          const claimed = await step(schedule, now, activeSince).catch((error) => {
            console.error(`Schedule ${schedule.id} failed to run:`, error);
            return null;
          });
          if (claimed) due.push(claimed);
        }
        await Promise.all(due.map((d) => launch(d.before, d.claimed, d.claimed.prompt, d.kind, now)
          .catch((error) => console.error(`Schedule ${d.claimed.id} failed to start:`, error))));
      }
      changed = JSON.stringify(await deps.list()) !== before;
    } catch (error) {
      console.error("Failed to run schedules:", error);
    }
    if (changed) deps.onChange();
  }

  async function find(id: string): Promise<PeriodicSchedule> {
    const schedule = (await deps.list()).find((s) => s.id === id);
    if (!schedule) throw new Error(`No schedule ${id}`);
    if (deps.isArchived(schedule.workstream_id)) throw new Error(ARCHIVED);
    return schedule;
  }

  return {
    tick,
    settle,
    async runNow(id, now) {
      await find(id);
      await deps.update(id, { run_requested: true, run_requested_at: now });
      // A tick already under way may have read the schedules before the request.
      if (current) await current;
      await tick(now);
    },
    async reply(id, text, kind, now) {
      if (current) await current.catch(() => {});
      const schedule = await find(id);
      if (schedule.interactive_tile_id) throw new Error(`${PAUSED_INTERACTIVE}: close the interactive tile first.`);
      if (inFlight.has(id)) {
        await deps.recordSkip(schedule, kind, text, now);
        throw new Error("A run is already going in this tile, so this one was skipped. Send it again when it ends.");
      }
      const claimed = await claim(schedule, {}, now);
      if (!claimed) throw new Error("The schedule changed; try again.");
      try {
        return await launch(schedule, claimed, text, kind, now);
      } finally {
        deps.onChange();
      }
    },
  };
}
