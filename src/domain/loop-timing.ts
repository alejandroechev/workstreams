import type {
  LoopRun,
  LoopStageRecord,
  LoopTask,
} from "./loop";

/**
 * Aggregated stage timing used by the Goal Loop overview.
 *
 * The controller records one durable `loop_stages` row per orchestrator,
 * worker, evaluator, and verifier episode, so "why is this slow" is answered
 * from measured evidence rather than inferred gaps between record timestamps.
 */
export interface LoopRoleTotal {
  role: string;
  totalMs: number;
  count: number;
}

export interface LoopRunTiming {
  /** Wall-clock elapsed time for the run. */
  elapsedMs: number;
  /** Time attributed to completed stages. */
  measuredMs: number;
  /** Per-role totals, slowest first. */
  roles: LoopRoleTotal[];
  /** Single slowest stage in the run, when any stage has completed. */
  slowest: LoopStageRecord | null;
}

export interface LoopTaskTiming {
  totalMs: number;
  roles: LoopRoleTotal[];
  stages: LoopStageRecord[];
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function accumulate(stages: readonly LoopStageRecord[]): LoopRoleTotal[] {
  const totals = new Map<string, LoopRoleTotal>();
  for (const stage of stages) {
    const existing = totals.get(stage.role);
    if (existing) {
      existing.totalMs += stage.durationMs;
      existing.count += 1;
    } else {
      totals.set(stage.role, {
        role: stage.role,
        totalMs: stage.durationMs,
        count: 1,
      });
    }
  }
  return [...totals.values()].sort(
    (left, right) => right.totalMs - left.totalMs || left.role.localeCompare(right.role),
  );
}

/** Stages belonging to one task, in execution order. */
export function stagesForTask(
  stages: readonly LoopStageRecord[],
  taskId: string,
): LoopStageRecord[] {
  return stages.filter((stage) => stage.loopTaskId === taskId);
}

export function summarizeTaskTiming(
  stages: readonly LoopStageRecord[],
  taskId: string,
): LoopTaskTiming {
  const taskStages = stagesForTask(stages, taskId);
  return {
    totalMs: taskStages.reduce((total, stage) => total + stage.durationMs, 0),
    roles: accumulate(taskStages),
    stages: taskStages,
  };
}

export function summarizeRunTiming(input: {
  run: LoopRun | null;
  stages: readonly LoopStageRecord[];
  now: number;
}): LoopRunTiming {
  const { run, stages, now } = input;
  const startedAt = parseTime(run?.startedAt);
  const finishedAt = parseTime(run?.finishedAt);
  const elapsedMs =
    startedAt === null ? 0 : Math.max(0, (finishedAt ?? now) - startedAt);
  const measuredMs = stages.reduce((total, stage) => total + stage.durationMs, 0);
  const slowest = stages.reduce<LoopStageRecord | null>(
    (slowestSoFar, stage) =>
      slowestSoFar === null || stage.durationMs > slowestSoFar.durationMs
        ? stage
        : slowestSoFar,
    null,
  );
  return {
    elapsedMs,
    measuredMs,
    roles: accumulate(stages),
    slowest,
  };
}

/**
 * One-line description of where a task currently stands, used as the collapsed
 * summary so the overview never requires opening details to be useful.
 */
export function taskHeadline(task: LoopTask): string {
  switch (task.state) {
    case "queued":
      return "Waiting to start";
    case "working":
      return "Worker running";
    case "verifying":
      return "Verifier running";
    case "evaluating":
      return "Evaluator running";
    case "awaiting_approval":
      return "Waiting for your approval";
    case "accepted":
      return "Accepted";
    case "blocked":
      return "Blocked";
    case "attention":
      return "Needs attention";
    case "interrupted":
      return "Interrupted";
  }
}
