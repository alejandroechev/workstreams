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
  /** The tile's session turn count as last reported, if any. */
  turnCount(tileId: string): number | undefined;
  /** Changes whenever the tile's process is replaced or closed. */
  generation(tileId: string): number;
  /**
   * Resumes the tile's session with `prompt`; calls `revalidate` before the
   * stop and before the spawn. Rejects when the run could not start.
   */
  resume(schedule: PeriodicSchedule, prompt: string, revalidate: () => Promise<void>): Promise<void>;
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
  /** The turn count when first known after the launch; undefined until then. */
  baseline: number | undefined;
  sawTurn: boolean;
}

export interface ScheduleRunner {
  tick(now: number): Promise<void>;
  /** Asks for a run now and ticks; a run that's mid-turn is skipped. */
  runNow(id: string, now: number): Promise<void>;
}

/** The schedule changed while its run was starting: not a failure. */
class RunCancelled extends Error {}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createScheduleRunner(deps: ScheduleRunnerDeps, options: ScheduleRunnerOptions = {}): ScheduleRunner {
  const maxGapMs = options.maxGapMs ?? MAX_TICK_GAP_MS;
  const startedAt = options.startedAt ?? 0;
  const inFlight = new Map<string, InFlight>();
  /** Auto-pause alerts that failed to post, retried on every tick. */
  const pendingAlerts = new Map<string, () => Promise<void>>();
  let current: Promise<void> | null = null;
  let lastTickAt: number | null = null;

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

  async function start(schedule: PeriodicSchedule, manual: boolean, now: number): Promise<void> {
    const nextRun = manual
      ? (schedule.next_run_at ?? nextRunAfter(schedule.frequency, now, now))
      : nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now);
    let claimed: PeriodicSchedule;
    try {
      claimed = await deps.update(schedule.id, {
        last_result: "running", last_run_at: now, next_run_at: nextRun, run_requested: false, run_requested_at: null,
      }, schedule.revision);
    } catch {
      return; // Changed (or deleted) since it was read: the next tick decides afresh.
    }
    const revalidate = async () => {
      const fresh = (await deps.list()).find((s) => s.id === schedule.id);
      if (!fresh) throw new RunCancelled("The schedule was deleted.");
      if (fresh.revision !== claimed.revision) throw new RunCancelled("The schedule changed.");
      if (deps.isArchived(fresh.workstream_id)) throw new RunCancelled("The workstream was archived.");
    };
    const baseline = deps.turnCount(schedule.tile_id);
    try {
      await deps.resume(claimed, composeRunPrompt(claimed), revalidate);
      inFlight.set(schedule.id, {
        tileId: schedule.tile_id, startedAt: now, generation: deps.generation(schedule.tile_id), baseline, sawTurn: false,
      });
    } catch (error) {
      if (error instanceof RunCancelled) {
        // Put back what the claim changed, other than the plan; a deleted schedule has nothing to put back.
        await deps.update(schedule.id, { last_result: schedule.last_result, last_error: schedule.last_error, last_run_at: schedule.last_run_at })
          .catch(() => {});
        return;
      }
      await finish(claimed, { result: "could not start", error: error instanceof Error ? error.message : String(error) }, now);
    }
  }

  async function monitor(schedules: Map<string, PeriodicSchedule>, now: number): Promise<void> {
    for (const [id, run] of [...inFlight]) {
      const schedule = schedules.get(id);
      if (!schedule) {
        inFlight.delete(id);
        continue;
      }
      if (deps.generation(run.tileId) !== run.generation) {
        // Something else restarted the tile (a phone message, by hand): not our process any more.
        inFlight.delete(id);
        await finish(schedule, { result: "interrupted" }, now);
        continue;
      }
      const busy = deps.isBusy(run.tileId);
      const turns = deps.turnCount(run.tileId);
      if (run.baseline === undefined) run.baseline = turns;
      else if (turns !== undefined && turns > run.baseline) run.sawTurn = true;
      if (busy) run.sawTurn = true;
      if (busy && now - run.startedAt >= RUN_TIMEOUT_MS) {
        inFlight.delete(id);
        await deps.interrupt(run.tileId).catch((error) => console.error("Failed to interrupt a timed-out run:", error));
        await finish(schedule, { result: "timed out" }, now);
      } else if (!busy && run.sawTurn) {
        inFlight.delete(id);
        await finish(schedule, { result: "ok" }, now);
      } else if (!run.sawTurn && now - run.startedAt >= OBSERVE_MS) {
        inFlight.delete(id);
        await finish(schedule, { result: "could not start", error: "The session was resumed, but its turn never started." }, now);
      }
    }
  }

  async function step(schedule: PeriodicSchedule, now: number, activeSince: number | null): Promise<void> {
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
        return;
      case "plan":
        await write({ next_run_at: nextRunAfter(schedule.frequency, now, now) });
        return;
      case "missed":
        await write({ next_run_at: nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now) });
        return;
      case "expire":
        await write({ run_requested: false, run_requested_at: null });
        return;
      case "skip": {
        const next = decision.manual ? {} : { next_run_at: nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now) };
        const cleared = { ...next, run_requested: false, run_requested_at: null };
        // A run in flight keeps showing as running; the skip only moves the plan on.
        if (flying) await write(cleared);
        else await write({ ...applyRunResult(schedule, { result: "skipped" }, now).patch, ...cleared });
        return;
      }
      case "run":
        await start(schedule, decision.manual, now);
        return;
    }
  }

  function tick(now: number): Promise<void> {
    // Joining the tick in progress rather than starting another: a due run starts once.
    if (current) return current;
    current = runTick(now).finally(() => { current = null; });
    return current;
  }

  async function runTick(now: number): Promise<void> {
    const activeSince = lastTickAt !== null && now - lastTickAt <= maxGapMs ? lastTickAt : null;
    lastTickAt = now;
    let changed = false;
    try {
      for (const [id, post] of [...pendingAlerts]) await alert(id, post);
      const schedules = await deps.list();
      const before = JSON.stringify(schedules);
      await monitor(new Map(schedules.map((s) => [s.id, s])), now);
      for (const schedule of await deps.list()) {
        await step(schedule, now, activeSince).catch((error) => console.error(`Schedule ${schedule.id} failed to run:`, error));
      }
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
