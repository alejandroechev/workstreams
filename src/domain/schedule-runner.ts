/**
 * Runs periodic schedules (ADR 044). The app calls `tick(now)` on a timer;
 * each tick reads the stored schedules, finishes runs in flight (ok, or
 * interrupted after 60 minutes), and starts, skips or re-plans due ones with
 * the rules in `periodic-schedules.ts`. Ticks never overlap, so a due run is
 * started at most once. Everything outside — the store, the tile's activity,
 * resuming the session — comes in through `deps`, so the runner is driven
 * with a fake clock in tests.
 */
import type { PeriodicSchedulePatch } from "../backend/types";
import {
  applyRunResult,
  composeRunPrompt,
  decideDue,
  nextRunAfter,
  promptFirstLine,
  RUN_TIMEOUT_MS,
  type PeriodicSchedule,
  type RunOutcome,
} from "./periodic-schedules";

/** A run whose turn was never seen busy is taken as done after this long. */
export const SETTLE_MS = 2 * 60 * 1000;

export interface ScheduleRunnerDeps {
  list(): Promise<PeriodicSchedule[]>;
  update(id: string, patch: PeriodicSchedulePatch): Promise<PeriodicSchedule>;
  /** One Inbox entry when a schedule pauses itself. */
  postInbox(workstreamId: string, tileId: string, title: string, body: string): Promise<void>;
  workstreamName(workstreamId: string): string | undefined;
  /** The tile's agent is mid-turn (its session's activity), not merely typed into. */
  isBusy(tileId: string): boolean;
  /** Resumes the tile's session with `prompt`; rejects when the run could not start. */
  resume(schedule: PeriodicSchedule, prompt: string): Promise<void>;
  /** Interrupts the tile's current turn (Ctrl+C), leaving the session idle. */
  interrupt(tileId: string): Promise<void>;
  /** Stored schedules changed. */
  onChange(): void;
}

interface InFlight {
  tileId: string;
  startedAt: number;
  sawBusy: boolean;
}

export interface ScheduleRunner {
  tick(now: number): Promise<void>;
  /** Asks for a run now and ticks; a run that's mid-turn is skipped. */
  runNow(id: string, now: number): Promise<void>;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createScheduleRunner(deps: ScheduleRunnerDeps): ScheduleRunner {
  const inFlight = new Map<string, InFlight>();
  let current: Promise<void> | null = null;

  async function finish(schedule: PeriodicSchedule, outcome: RunOutcome, now: number, extra: PeriodicSchedulePatch = {}): Promise<void> {
    const { patch, autoPaused } = applyRunResult(schedule, outcome, now);
    await deps.update(schedule.id, { ...patch, ...extra });
    if (!autoPaused) return;
    const name = promptFirstLine(schedule.prompt);
    const where = deps.workstreamName(schedule.workstream_id) ?? "its workstream";
    await deps.postInbox(
      schedule.workstream_id,
      schedule.tile_id,
      clip(`Schedule paused: ${name}`, 120),
      `The periodic run **${name}** in ${where} failed ${patch.failures} times in a row, so it was paused.\n\n` +
        `Last failure: ${patch.last_result}: ${patch.last_error}\n\nResume it from **Schedules** once the tile is ready.`,
    );
  }

  async function start(schedule: PeriodicSchedule, manual: boolean, now: number): Promise<void> {
    const nextRun = manual
      ? (schedule.next_run_at ?? nextRunAfter(schedule.frequency, now, now))
      : nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now);
    const running = await deps.update(schedule.id, {
      last_result: "running", last_run_at: now, next_run_at: nextRun, run_requested: false,
    });
    try {
      await deps.resume(running, composeRunPrompt(running));
      inFlight.set(schedule.id, { tileId: schedule.tile_id, startedAt: now, sawBusy: false });
    } catch (error) {
      await finish(running, { result: "could not start", error: error instanceof Error ? error.message : String(error) }, now);
    }
  }

  async function monitor(schedules: Map<string, PeriodicSchedule>, now: number): Promise<void> {
    for (const [id, run] of [...inFlight]) {
      const schedule = schedules.get(id);
      if (!schedule) {
        inFlight.delete(id);
        continue;
      }
      const busy = deps.isBusy(run.tileId);
      if (busy) run.sawBusy = true;
      if (now - run.startedAt >= RUN_TIMEOUT_MS && busy) {
        inFlight.delete(id);
        await deps.interrupt(run.tileId).catch((error) => console.error("Failed to interrupt a timed-out run:", error));
        await finish(schedule, { result: "timed out" }, now);
      } else if (!busy && (run.sawBusy || now - run.startedAt >= SETTLE_MS)) {
        inFlight.delete(id);
        await finish(schedule, { result: "ok" }, now);
      }
    }
  }

  async function step(schedule: PeriodicSchedule, now: number): Promise<void> {
    const flying = inFlight.has(schedule.id);
    if (!flying && schedule.last_result === "running") {
      // Left by a previous app instance: the session ran; it isn't watched any more.
      schedule = await deps.update(schedule.id, applyRunResult(schedule, { result: "ok" }, now).patch);
    }
    const decision = decideDue(schedule, { now, busy: flying || deps.isBusy(schedule.tile_id) });
    switch (decision.action) {
      case "wait":
        return;
      case "plan":
        await deps.update(schedule.id, { next_run_at: nextRunAfter(schedule.frequency, now, now) });
        return;
      case "missed":
        await deps.update(schedule.id, { next_run_at: nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now) });
        return;
      case "skip": {
        const next = decision.manual ? {} : { next_run_at: nextRunAfter(schedule.frequency, schedule.next_run_at ?? now, now) };
        // A run in flight keeps showing as running; the skip only moves the plan on.
        if (flying) await deps.update(schedule.id, { ...next, run_requested: false });
        else await finish(schedule, { result: "skipped" }, now, { ...next, run_requested: false });
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
    let changed = false;
    try {
      const schedules = await deps.list();
      const byId = new Map(schedules.map((s) => [s.id, s]));
      const before = JSON.stringify(schedules);
      await monitor(byId, now);
      for (const schedule of await deps.list()) {
        await step(schedule, now).catch((error) => console.error(`Schedule ${schedule.id} failed to run:`, error));
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
      const schedules = await deps.list();
      if (!schedules.some((s) => s.id === id)) throw new Error(`No schedule ${id}`);
      await deps.update(id, { run_requested: true });
      // A tick already under way may have read the schedules before the request.
      if (current) await current;
      await tick(now);
    },
  };
}
