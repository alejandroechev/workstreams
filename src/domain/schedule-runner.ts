/**
 * Runs periodic schedules (ADR 044). The app calls `tick(now)` on a timer;
 * each tick reads the stored schedules, follows runs in flight (ok once their
 * turn started and ended, interrupted after 60 minutes), and starts, skips or
 * re-plans due ones with the rules in `periodic-schedules.ts`.
 *
 * Every decision is written back against the revision it was made on, so a
 * pause, edit, delete or archive in between wins; a run is re-checked before
 * the tile is stopped and before the session is spawned. Ticks never overlap,
 * so a due run starts at most once. Everything outside — the store, the tile's
 * activity, resuming the session — comes in through `deps`, so the runner is
 * driven with a fake clock in tests.
 */
import type { PeriodicSchedulePatch } from "../backend/types";
import {
  applyRunResult,
  composeRunPrompt,
  decideDue,
  MAX_TICK_GAP_MS,
  nextRunAfter,
  promptFirstLine,
  RUN_TIMEOUT_MS,
  type PeriodicSchedule,
  type RunOutcome,
} from "./periodic-schedules";

/** A run whose turn hasn't been seen to start within this long did not start. */
export const OBSERVE_MS = 5 * 60 * 1000;

/** Turns a session's events file has started and ended. */
export interface TurnCursor {
  starts: number;
  ends: number;
}

export type ResumePhase = "before-stop" | "before-spawn";

export interface ScheduleRunnerDeps {
  list(): Promise<PeriodicSchedule[]>;
  /** With `expectedRevision`, rejects unless the row is still that revision. */
  update(id: string, patch: PeriodicSchedulePatch, expectedRevision?: number): Promise<PeriodicSchedule>;
  /** One Inbox entry when a schedule pauses itself. */
  postInbox(workstreamId: string, tileId: string, title: string, body: string): Promise<void>;
  workstreamName(workstreamId: string): string | undefined;
  isArchived(workstreamId: string): boolean;
  /** The tile's agent is mid-turn (its session's activity), not merely typed into. */
  isBusy(tileId: string): boolean;
  /** The tile's linked session's turn cursor, or null when it can't be read. */
  turnState(schedule: PeriodicSchedule): Promise<TurnCursor | null>;
  /** Changes whenever the tile's process is replaced or closed. */
  generation(tileId: string): number;
  /**
   * Resumes the tile's session with `prompt`, one resume per tile at a time;
   * calls `revalidate` under the tile's lock before the stop, and before the
   * spawn. Rejects when the run could not start.
   */
  resume(schedule: PeriodicSchedule, prompt: string, revalidate: (phase: ResumePhase) => Promise<void>): Promise<void>;
  /** Interrupts the tile's current turn (Ctrl+C), leaving the session idle. */
  interrupt(tileId: string): Promise<void>;
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
  tileId: string;
  startedAt: number;
  generation: number;
  /** The session's turns before the launch: the next one to start is this run's. */
  before: TurnCursor | null;
  /** Decided but not stored yet; retried every tick, its side effects done once. */
  outcome?: RunOutcome;
}

export interface ScheduleRunner {
  tick(now: number): Promise<void>;
  /** Asks for a run now and ticks; a run that's mid-turn is skipped. */
  runNow(id: string, now: number): Promise<void>;
}

/** The schedule changed while its run was starting: not a failure. */
class RunCancelled extends Error {}
/** Something else took the tile while the run waited for it: this slot is skipped. */
class RunSkipped extends Error {}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createScheduleRunner(deps: ScheduleRunnerDeps, options: ScheduleRunnerOptions = {}): ScheduleRunner {
  const maxGapMs = options.maxGapMs ?? MAX_TICK_GAP_MS;
  const startedAt = options.startedAt ?? 0;
  const inFlight = new Map<string, InFlight>();
  /** Auto-pause alerts that failed to post, retried on every tick. */
  const pendingAlerts = new Map<string, () => Promise<void>>();
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

  async function alert(id: string, post: () => Promise<void>): Promise<void> {
    try {
      await post();
      pendingAlerts.delete(id);
    } catch (error) {
      console.error("Failed to post the schedule's pause to the Inbox; will retry:", error);
      pendingAlerts.set(id, post);
    }
  }

  async function finish(schedule: PeriodicSchedule, outcome: RunOutcome, now: number, extra: PeriodicSchedulePatch = {}): Promise<void> {
    const { patch, autoPaused } = applyRunResult(schedule, outcome, now);
    await deps.update(schedule.id, { ...patch, ...extra });
    if (!autoPaused) return;
    const name = clip(promptFirstLine(schedule.prompt), 120);
    const where = clip(deps.workstreamName(schedule.workstream_id) ?? "its workstream", 120);
    const title = clip(`Schedule paused: ${name}`, 120);
    const body =
      `The periodic run **${name}** in ${where} failed ${patch.failures} times in a row, so it was paused.\n\n` +
      `Last failure: ${patch.last_result}: ${clip(patch.last_error ?? "", 500)}\n\nResume it from **Schedules** once the tile is ready.`;
    await alert(`${schedule.id}:${now}`, () => deps.postInbox(schedule.workstream_id, schedule.tile_id, title, body));
  }

  interface Claim {
    before: PeriodicSchedule;
    claimed: PeriodicSchedule;
    generation: number;
  }

  /** Marks the run as started against the row it was decided on; null if that row changed. */
  async function claim(schedule: PeriodicSchedule, manual: boolean, now: number): Promise<Claim | null> {
    const generation = deps.generation(schedule.tile_id);
    const nextRun = manual
      ? (schedule.next_run_at ?? nextRunAfter(schedule.frequency, now, now))
      : nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now);
    try {
      const claimed = await deps.update(schedule.id, {
        last_result: "running", last_run_at: now, next_run_at: nextRun, run_requested: false, run_requested_at: null,
      }, schedule.revision);
      return { before: schedule, claimed, generation };
    } catch {
      return null; // Changed (or deleted) since it was read: the next tick decides afresh.
    }
  }

  async function launch({ before: schedule, claimed, generation }: Claim, now: number): Promise<void> {
    const revalidate = async (phase: ResumePhase) => {
      const fresh = (await deps.list()).find((s) => s.id === schedule.id);
      if (!fresh) throw new RunCancelled("The schedule was deleted.");
      if (fresh.revision !== claimed.revision) throw new RunCancelled("The schedule changed.");
      if (deps.isArchived(fresh.workstream_id)) throw new RunCancelled("The workstream was archived.");
      // Under the tile's lock, before stopping it: a phone message may have
      // just launched its own turn there while this run waited.
      if (phase === "before-stop" && (deps.generation(schedule.tile_id) !== generation || deps.isBusy(schedule.tile_id))) {
        throw new RunSkipped("The tile was busy when the run got to it.");
      }
    };
    const before = await deps.turnState(claimed).catch(() => null);
    try {
      await deps.resume(claimed, composeRunPrompt(claimed), revalidate);
      inFlight.set(schedule.id, { tileId: schedule.tile_id, startedAt: now, generation: deps.generation(schedule.tile_id), before });
    } catch (error) {
      if (error instanceof RunSkipped) {
        await deps.update(schedule.id, applyRunResult(claimed, { result: "skipped" }, now).patch).catch(() => {});
        return;
      }
      if (error instanceof RunCancelled) {
        // Put back what the claim changed, other than the plan; a deleted schedule has nothing to put back.
        await deps.update(schedule.id, { last_result: schedule.last_result, last_error: schedule.last_error, last_run_at: schedule.last_run_at })
          .catch(() => {});
        return;
      }
      await finish(claimed, { result: "could not start", error: error instanceof Error ? error.message : String(error) }, now);
    }
  }

  /** What a run in flight has come to, or null while it is still going. */
  async function judge(schedule: PeriodicSchedule, run: InFlight, now: number): Promise<RunOutcome | null> {
    const state = await deps.turnState(schedule).catch(() => null);
    const { before } = run;
    // The first turn to start after the launch is this run's; the first end after it closes it.
    if (before && state && state.ends > before.ends) return { result: "ok" };
    // Something else restarted the tile (a phone message, by hand): not our process any more.
    if (deps.generation(run.tileId) !== run.generation) return { result: "interrupted" };
    const started = !!before && !!state && state.starts > before.starts;
    if (started && now - run.startedAt >= RUN_TIMEOUT_MS) {
      await deps.interrupt(run.tileId).catch((error) => console.error("Failed to interrupt a timed-out run:", error));
      return { result: "timed out" };
    }
    if (!started && now - run.startedAt >= OBSERVE_MS) {
      return { result: "could not start", error: "The session was resumed, but its turn never started." };
    }
    return null;
  }

  async function monitor(schedules: Map<string, PeriodicSchedule>, now: number): Promise<void> {
    for (const [id, run] of [...inFlight]) {
      const schedule = schedules.get(id);
      if (!schedule) {
        inFlight.delete(id);
        continue;
      }
      run.outcome ??= (await judge(schedule, run, now)) ?? undefined;
      if (!run.outcome) continue;
      try {
        await finish(schedule, run.outcome, now);
        inFlight.delete(id);
      } catch (error) {
        console.error("Failed to store a periodic run's result; will retry:", error);
      }
    }
  }

  /** Decides one schedule; a due run is claimed and returned, to be launched with the others. */
  async function step(schedule: PeriodicSchedule, now: number, activeSince: number | null): Promise<Claim | null> {
    const flying = inFlight.has(schedule.id);
    if (!flying && schedule.last_result === "running") {
      // Left by a previous app instance: nothing watches that run any more. Not a failure.
      schedule = await deps.update(schedule.id, applyRunResult(schedule, { result: "interrupted" }, now).patch, schedule.revision);
    }
    const decision = decideDue(schedule, {
      now, busy: flying || deps.isBusy(schedule.tile_id), archived: deps.isArchived(schedule.workstream_id), activeSince, startedAt,
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
        const cleared = { ...next, run_requested: false, run_requested_at: null };
        // A run in flight keeps showing as running; the skip only moves the plan on.
        if (flying) await write(cleared);
        else await write({ ...applyRunResult(schedule, { result: "skipped" }, now).patch, ...cleared });
        return null;
      }
      case "run":
        return claim(schedule, decision.manual, now);
    }
  }

  function tick(now: number): Promise<void> {
    // Every timer callback counts as a heartbeat, even one that joins a slow tick.
    beat(now);
    // Joining the tick in progress rather than starting another: a due run starts once.
    if (current) return current;
    current = runTick(now).finally(() => { current = null; });
    return current;
  }

  async function runTick(now: number): Promise<void> {
    // Slots after the last decisions run, unless they fell before the scheduler woke up.
    const activeSince = lastEvaluatedAt === null ? null : Math.max(lastEvaluatedAt, awakeSince);
    lastEvaluatedAt = now;
    let changed = false;
    try {
      for (const [id, post] of [...pendingAlerts]) await alert(id, post);
      const schedules = await deps.list();
      const before = JSON.stringify(schedules);
      await monitor(new Map(schedules.map((s) => [s.id, s])), now);
      // Every due slot is claimed first, then all launch together: one tile's
      // queue (a phone message holding it) doesn't hold back the others.
      const claims: Claim[] = [];
      for (const schedule of await deps.list()) {
        const claimed = await step(schedule, now, activeSince).catch((error) => {
          console.error(`Schedule ${schedule.id} failed to run:`, error);
          return null;
        });
        if (claimed) claims.push(claimed);
      }
      await Promise.all(claims.map((c) => launch(c, now).catch((error) => console.error(`Schedule ${c.claimed.id} failed to start:`, error))));
      changed = JSON.stringify(await deps.list()) !== before;
    } catch (error) {
      console.error("Failed to run schedules:", error);
    }
    if (changed) deps.onChange();
  }

  return {
    tick,
    async runNow(id, now) {
      const schedule = (await deps.list()).find((s) => s.id === id);
      if (!schedule) throw new Error(`No schedule ${id}`);
      if (deps.isArchived(schedule.workstream_id)) throw new Error("This schedule's workstream is archived; unarchive it first.");
      await deps.update(id, { run_requested: true, run_requested_at: now });
      // A tick already under way may have read the schedules before the request.
      if (current) await current;
      await tick(now);
    },
  };
}
