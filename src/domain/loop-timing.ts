import type {
  LoopRun,
  LoopRunState,
  LoopRunSummary,
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

export const LOOP_TASK_FILTERS = ["all", "active", "accepted", "attention"] as const;

export type LoopTaskFilter = (typeof LOOP_TASK_FILTERS)[number];

export type LoopTaskSort = "newest" | "oldest";

export const LOOP_RUN_FILTERS = [
  "all",
  "running",
  "completed",
  "attention",
] as const;

export type LoopRunFilter = (typeof LOOP_RUN_FILTERS)[number];

/**
 * Run states that are still in flight.
 *
 * Derived by exclusion rather than enumeration so a newly added state is
 * treated as running — visible and controllable — instead of silently
 * disappearing from every filter.
 */
const TERMINAL_RUN_STATES: ReadonlySet<LoopRunState> = new Set<LoopRunState>([
  "completed",
  "attention",
  "killed",
]);

/**
 * `killed` groups with `attention` because both mean the run stopped without
 * reaching its goal, which is the distinction an operator scanning the list
 * actually cares about.
 */
export function matchesRunFilter(
  run: LoopRunSummary,
  filter: LoopRunFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return !TERMINAL_RUN_STATES.has(run.state);
    case "completed":
      return run.state === "completed";
    case "attention":
      return run.state === "attention" || run.state === "killed";
  }
}

export function countRunsByFilter(
  runs: readonly LoopRunSummary[],
): Record<LoopRunFilter, number> {
  return LOOP_RUN_FILTERS.reduce(
    (counts, filter) => {
      counts[filter] = runs.filter((run) => matchesRunFilter(run, filter)).length;
      return counts;
    },
    {} as Record<LoopRunFilter, number>,
  );
}

/**
 * Newest run first. Stable: runs started within the same second keep their
 * backend order rather than shuffling between refreshes.
 */
export function orderRuns(runs: readonly LoopRunSummary[]): LoopRunSummary[] {
  return runs
    .map((run, index) => ({ run, index }))
    .sort((left, right) => {
      const leftTime = parseTime(left.run.startedAt);
      const rightTime = parseTime(right.run.startedAt);
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.run);
}

/** Secondary line for a run row, summarising progress without its evidence. */
export function describeRun(run: LoopRunSummary): string {
  if (run.taskTotal === 0) return "No tasks yet";
  const tasks = `${run.taskTotal} task${run.taskTotal === 1 ? "" : "s"}`;
  return run.taskAttention > 0
    ? `${tasks} · ${run.taskAttention} need attention`
    : tasks;
}

const ACTIVE_STATES: ReadonlySet<LoopTask["state"]> = new Set([
  "queued",
  "working",
  "verifying",
  "evaluating",
  "awaiting_approval",
]);

const ATTENTION_STATES: ReadonlySet<LoopTask["state"]> = new Set([
  "attention",
  "blocked",
  "interrupted",
]);

export function matchesTaskFilter(task: LoopTask, filter: LoopTaskFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return ACTIVE_STATES.has(task.state);
    case "accepted":
      return task.state === "accepted";
    case "attention":
      return ATTENTION_STATES.has(task.state);
  }
}

/**
 * Orders tasks for display. The backend returns creation order; the UI defaults
 * to newest-first so the task the loop is working on right now is at the top,
 * without losing the ability to read the run as a chronological story.
 *
 * Sorting is stable and falls back to the original index when timestamps are
 * missing or equal, so tasks created within the same second keep a predictable
 * order instead of shuffling between refreshes.
 */
export function orderTasks(
  tasks: readonly LoopTask[],
  sort: LoopTaskSort,
): LoopTask[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const leftTime = parseTime(left.task.createdAt);
      const rightTime = parseTime(right.task.createdAt);
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
        return sort === "newest" ? rightTime - leftTime : leftTime - rightTime;
      }
      return sort === "newest" ? right.index - left.index : left.index - right.index;
    })
    .map((entry) => entry.task);
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
