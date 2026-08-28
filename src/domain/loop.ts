export const MAX_TASK_ITERATIONS = 2 as const;

export const LOOP_RUN_STATES = [
  "starting",
  "orchestrating",
  "working",
  "verifying",
  "evaluating",
  "paused",
  "stopping",
  "completed",
  "attention",
  "killed",
] as const;

export type LoopRunState = (typeof LOOP_RUN_STATES)[number];

export const LOOP_TASK_STATES = [
  "queued",
  "working",
  "verifying",
  "evaluating",
  "accepted",
  "blocked",
  "attention",
  "interrupted",
] as const;

export type LoopTaskState = (typeof LOOP_TASK_STATES)[number];

export interface LoopRoleSpec {
  prompt: string;
  model: string;
}

export interface LoopVerifierSpec {
  program: string;
  args: readonly string[];
  cwd?: string;
}

export interface LoopSpec {
  id: string;
  workstreamId: string;
  orchestrator: LoopRoleSpec;
  worker: LoopRoleSpec;
  evaluator: LoopRoleSpec;
  verifier?: LoopVerifierSpec;
  runTimeoutMs: number;
  maxTaskIterations: typeof MAX_TASK_ITERATIONS;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type LoopSpecDraft = Omit<
  LoopSpec,
  "id" | "workstreamId" | "enabled" | "createdAt" | "updatedAt"
>;

export interface LoopTask {
  id: string;
  loopRunId: string;
  loopSpecId: string;
  key: string;
  title: string;
  objective: string;
  state: LoopTaskState;
  workerSessionId?: string;
  revisionCount: number;
  workerResult?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type VerificationResult =
  | { kind: "passed" }
  | { kind: "nonzero"; exitCode: number }
  | { kind: "timeout" }
  | { kind: "spawn_error"; message: string };

export type EvaluatorVerdict = "accepted" | "revise" | "blocked" | "invalid";

export type LoopAction =
  | { type: "none" }
  | { type: "orchestrate" }
  | { type: "start_worker"; taskId: string }
  | { type: "run_verifier"; taskId: string }
  | { type: "evaluate"; taskId: string }
  | { type: "stop" }
  | { type: "kill" }
  | { type: "attention"; reason: string };

export interface LoopRun {
  id: string;
  loopSpecId: string;
  state: LoopRunState;
  activeTaskId: string | null;
  pauseRequested: boolean;
  stopRequested: boolean;
  pendingAction: LoopAction | null;
  controlRequested?: "none" | "pause" | "stop" | "kill";
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
}

export interface LoopSnapshot {
  spec: LoopSpec;
  run: LoopRun;
  tasks: LoopTask[];
}

export interface LoopVerificationRecord {
  id: string;
  loopTaskId: string;
  attempt: number;
  status: "passed" | "nonzero" | "timed_out" | "spawn_error" | "cancelled";
  program: string;
  args: string[];
  cwd?: string;
  programHash?: string;
  exitCode?: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  createdAt: string;
}

export interface LoopEvaluationRecord {
  id: string;
  loopTaskId: string;
  attempt: number;
  sessionId?: string;
  verdict: EvaluatorVerdict;
  summary: string;
  feedback?: string;
  evidence: string[];
  createdAt: string;
}

export interface LoopEventRecord {
  id: number;
  loopSpecId: string;
  loopRunId?: string;
  loopTaskId?: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface PersistedLoopSnapshot {
  spec: LoopSpec | null;
  latestRun: LoopRun | null;
  tasks: LoopTask[];
  verifications: LoopVerificationRecord[];
  evaluations: LoopEvaluationRecord[];
  events: LoopEventRecord[];
}

export interface LoopSummary {
  workstreamId: string;
  loopSpecId: string;
  enabled: boolean;
  runId?: string;
  runState?: LoopRunState;
  controlRequested?: "none" | "pause" | "stop" | "kill";
  currentTaskId?: string;
  startedAt?: string;
}

export type LoopObservedOutcome =
  | { type: "run_started" }
  | { type: "tasks_proposed"; tasks: readonly LoopTask[] }
  | { type: "orchestration_completed" }
  | { type: "orchestrator_failed"; reason: string }
  | { type: "worker_completed"; workerSessionId: string }
  | { type: "worker_failed"; reason: string }
  | { type: "verification_completed"; result: VerificationResult }
  | { type: "evaluation_completed"; verdict: EvaluatorVerdict }
  | { type: "pause_requested" }
  | { type: "resume_requested" }
  | { type: "stop_requested" }
  | { type: "stop_completed" }
  | { type: "kill_requested" }
  | { type: "run_timed_out" };

export interface LoopTransition {
  snapshot: LoopSnapshot;
  action: LoopAction;
}

export type AddLoopSpecResult =
  | { ok: true; specs: LoopSpec[] }
  | { ok: false; reason: string };

export function addLoopSpec(
  existing: readonly LoopSpec[],
  candidate: LoopSpec,
): AddLoopSpecResult {
  if (existing.some((item) => item.workstreamId === candidate.workstreamId)) {
    return {
      ok: false,
      reason: `Workstream ${candidate.workstreamId} already has a loop spec`,
    };
  }
  return { ok: true, specs: [...existing, candidate] };
}

export type TaskKeyDedupeResult =
  | { ok: true }
  | { ok: false; duplicateKeys: string[] };

const DEDUPE_OCCUPIED_STATES: ReadonlySet<LoopTaskState> = new Set([
  "queued",
  "working",
  "verifying",
  "evaluating",
  "accepted",
]);

const INTERRUPTIBLE_TASK_STATES: ReadonlySet<LoopTaskState> = new Set([
  "queued",
  "working",
  "verifying",
  "evaluating",
]);

export function dedupeTaskKeys(
  proposed: readonly LoopTask[],
  existing: readonly LoopTask[],
): TaskKeyDedupeResult {
  const occupied = new Set(
    existing
      .filter((candidate) => DEDUPE_OCCUPIED_STATES.has(candidate.state))
      .map((candidate) => candidate.key),
  );
  const proposedKeys = new Set<string>();
  const duplicates = new Set<string>();

  for (const candidate of proposed) {
    if (occupied.has(candidate.key) || proposedKeys.has(candidate.key)) {
      duplicates.add(candidate.key);
    }
    proposedKeys.add(candidate.key);
  }

  return duplicates.size > 0
    ? { ok: false, duplicateKeys: [...duplicates] }
    : { ok: true };
}

export function makeLoopRun(
  input: Pick<LoopRun, "id" | "loopSpecId"> & Partial<Omit<LoopRun, "id" | "loopSpecId">>,
): LoopRun {
  return {
    id: input.id,
    loopSpecId: input.loopSpecId,
    state: input.state ?? "starting",
    activeTaskId: input.activeTaskId ?? null,
    pauseRequested: input.pauseRequested ?? false,
    stopRequested: input.stopRequested ?? false,
    pendingAction: input.pendingAction ?? null,
  };
}

function copySnapshot(snapshot: LoopSnapshot): LoopSnapshot {
  return {
    spec: snapshot.spec,
    run: { ...snapshot.run },
    tasks: snapshot.tasks.map((candidate) => ({ ...candidate })),
  };
}

const noAction = (): LoopAction => ({ type: "none" });

function unchanged(snapshot: LoopSnapshot): LoopTransition {
  return { snapshot, action: noAction() };
}

function attention(
  snapshot: LoopSnapshot,
  reason: string,
  activeTaskState?: "attention" | "blocked" | "interrupted",
): LoopTransition {
  const next = copySnapshot(snapshot);
  if (activeTaskState && next.run.activeTaskId) {
    const task = next.tasks.find((candidate) => candidate.id === next.run.activeTaskId);
    if (task) task.state = activeTaskState;
  }
  next.run.state = "attention";
  next.run.pauseRequested = false;
  next.run.pendingAction = null;
  return { snapshot: next, action: { type: "attention", reason } };
}

function interruptUnfinished(tasks: LoopTask[]): void {
  for (const task of tasks) {
    if (INTERRUPTIBLE_TASK_STATES.has(task.state)) task.state = "interrupted";
  }
}

function activeTask(
  snapshot: LoopSnapshot,
  expectedState: LoopTaskState,
): LoopTask | null {
  if (!snapshot.run.activeTaskId) return null;
  const task = snapshot.tasks.find(
    (candidate) => candidate.id === snapshot.run.activeTaskId,
  );
  return task?.state === expectedState ? task : null;
}

function stateForAction(action: LoopAction): LoopRunState {
  switch (action.type) {
    case "orchestrate":
      return "orchestrating";
    case "start_worker":
      return "working";
    case "run_verifier":
      return "verifying";
    case "evaluate":
      return "evaluating";
    case "stop":
      return "stopping";
    case "kill":
      return "killed";
    case "attention":
      return "attention";
    case "none":
      return "completed";
  }
}

function atSafeBoundary(transition: LoopTransition): LoopTransition {
  const { snapshot, action } = transition;

  if (
    snapshot.run.stopRequested &&
    snapshot.run.state !== "completed" &&
    snapshot.run.state !== "killed"
  ) {
    const next = copySnapshot(snapshot);
    interruptUnfinished(next.tasks);
    next.run.state = "stopping";
    next.run.activeTaskId = null;
    next.run.pauseRequested = false;
    next.run.stopRequested = false;
    next.run.pendingAction = null;
    return { snapshot: next, action: { type: "stop" } };
  }

  if (
    snapshot.run.pauseRequested &&
    snapshot.run.state !== "completed" &&
    snapshot.run.state !== "attention" &&
    snapshot.run.state !== "killed" &&
    action.type !== "none"
  ) {
    const next = copySnapshot(snapshot);
    next.run.state = "paused";
    next.run.pauseRequested = false;
    next.run.pendingAction = action;
    return { snapshot: next, action: noAction() };
  }

  return transition;
}

function malformedBatchReason(
  snapshot: LoopSnapshot,
  proposed: readonly LoopTask[],
): string | null {
  const ids = new Set<string>();
  for (const task of proposed) {
    if (
      !task.id.trim() ||
      !task.key.trim() ||
      !task.title.trim() ||
      !task.objective.trim()
    ) {
      return "Orchestrator returned a task with a blank required field";
    }
    if (task.loopRunId !== snapshot.run.id) {
      return `Task ${task.id} belongs to another loop run`;
    }
    if (task.loopSpecId !== snapshot.spec.id) {
      return `Task ${task.id} belongs to another loop spec`;
    }
    if (task.state !== "queued" || task.revisionCount !== 0) {
      return `Task ${task.id} did not start queued at revision zero`;
    }
    if (ids.has(task.id)) return `Task batch repeats id ${task.id}`;
    ids.add(task.id);
  }

  const dedupe = dedupeTaskKeys(proposed, snapshot.tasks);
  return dedupe.ok
    ? null
    : `Task batch repeats occupied keys: ${dedupe.duplicateKeys.join(", ")}`;
}

function startNextQueued(snapshot: LoopSnapshot): LoopTransition {
  const next = copySnapshot(snapshot);
  const queued = next.tasks.find((candidate) => candidate.state === "queued");
  if (!queued) {
    next.run.state = "completed";
    next.run.activeTaskId = null;
    next.run.pendingAction = null;
    return { snapshot: next, action: noAction() };
  }

  queued.state = "working";
  next.run.state = "working";
  next.run.activeTaskId = queued.id;
  next.run.pendingAction = null;
  return {
    snapshot: next,
    action: { type: "start_worker", taskId: queued.id },
  };
}

function verificationFailureReason(result: Exclude<VerificationResult, { kind: "passed" }>): string {
  switch (result.kind) {
    case "nonzero":
      return `Verifier exited with code ${result.exitCode}`;
    case "timeout":
      return "Verifier timed out";
    case "spawn_error":
      return `Verifier could not start: ${result.message}`;
  }
}

export function transitionLoop(
  current: LoopSnapshot,
  outcome: LoopObservedOutcome,
): LoopTransition {
  if (current.run.state === "completed" || current.run.state === "killed") {
    return unchanged(current);
  }

  if (outcome.type === "kill_requested") {
    const next = copySnapshot(current);
    interruptUnfinished(next.tasks);
    next.run.state = "killed";
    next.run.activeTaskId = null;
    next.run.pauseRequested = false;
    next.run.stopRequested = false;
    next.run.pendingAction = null;
    return { snapshot: next, action: { type: "kill" } };
  }

  if (outcome.type === "run_timed_out") {
    const next = copySnapshot(current);
    interruptUnfinished(next.tasks);
    return attention(next, "Loop run exceeded its timeout");
  }

  if (current.run.state === "stopping") {
    if (outcome.type !== "stop_completed") return unchanged(current);
    const next = copySnapshot(current);
    next.run.state = "completed";
    return { snapshot: next, action: noAction() };
  }

  if (outcome.type === "stop_requested") {
    if (current.run.state === "paused" || current.run.state === "attention") {
      const next = copySnapshot(current);
      interruptUnfinished(next.tasks);
      next.run.state = "stopping";
      next.run.activeTaskId = null;
      next.run.pauseRequested = false;
      next.run.stopRequested = false;
      next.run.pendingAction = null;
      return { snapshot: next, action: { type: "stop" } };
    }
    const next = copySnapshot(current);
    next.run.stopRequested = true;
    return { snapshot: next, action: noAction() };
  }

  if (current.run.state === "paused") {
    const action = current.run.pendingAction;
    if (outcome.type !== "resume_requested" || !action) {
      return unchanged(current);
    }
    const next = copySnapshot(current);
    next.run.state = stateForAction(action);
    next.run.pendingAction = null;
    return { snapshot: next, action };
  }

  if (current.run.state === "attention") return unchanged(current);

  if (outcome.type === "pause_requested") {
    const next = copySnapshot(current);
    if (current.run.state === "starting") {
      next.run.state = "paused";
      next.run.pendingAction = { type: "orchestrate" };
    } else {
      next.run.pauseRequested = true;
    }
    return { snapshot: next, action: noAction() };
  }

  if (current.run.loopSpecId !== current.spec.id) {
    return attention(current, "Loop run and loop spec do not match");
  }

  if (current.run.state === "starting") {
    if (outcome.type !== "run_started") {
      return attention(current, `Unexpected ${outcome.type} while starting`);
    }
    if (!current.spec.enabled) {
      return attention(current, `Loop spec ${current.spec.id} is disabled`);
    }
    const next = copySnapshot(current);
    next.run.state = "orchestrating";
    return atSafeBoundary({
      snapshot: next,
      action: { type: "orchestrate" },
    });
  }

  if (current.run.state === "orchestrating") {
    if (outcome.type === "orchestrator_failed") {
      return atSafeBoundary(attention(current, outcome.reason));
    }
    if (outcome.type === "orchestration_completed") {
      const next = copySnapshot(current);
      next.run.state = "completed";
      return atSafeBoundary({ snapshot: next, action: noAction() });
    }
    if (outcome.type !== "tasks_proposed") {
      return attention(current, `Unexpected ${outcome.type} while orchestrating`);
    }

    const malformed = malformedBatchReason(current, outcome.tasks);
    if (malformed) return atSafeBoundary(attention(current, malformed));

    const next = copySnapshot(current);
    next.tasks.push(...outcome.tasks.map((candidate) => ({ ...candidate })));
    return atSafeBoundary(startNextQueued(next));
  }

  if (current.run.state === "working") {
    const task = activeTask(current, "working");
    if (!task) return attention(current, "Working run has no working active task");
    if (outcome.type === "worker_failed") {
      return atSafeBoundary(attention(current, outcome.reason, "attention"));
    }
    if (outcome.type !== "worker_completed") {
      return attention(current, `Unexpected ${outcome.type} while working`);
    }

    const next = copySnapshot(current);
    const nextTask = activeTask(next, "working");
    if (!nextTask) return attention(current, "Working task disappeared");
    nextTask.workerSessionId = outcome.workerSessionId;
    if (next.spec.verifier) {
      nextTask.state = "verifying";
      next.run.state = "verifying";
      return atSafeBoundary({
        snapshot: next,
        action: { type: "run_verifier", taskId: nextTask.id },
      });
    }
    nextTask.state = "evaluating";
    next.run.state = "evaluating";
    return atSafeBoundary({
      snapshot: next,
      action: { type: "evaluate", taskId: nextTask.id },
    });
  }

  if (current.run.state === "verifying") {
    const task = activeTask(current, "verifying");
    if (!task) return attention(current, "Verifying run has no verifying active task");
    if (outcome.type !== "verification_completed") {
      return attention(current, `Unexpected ${outcome.type} while verifying`);
    }
    if (outcome.result.kind !== "passed") {
      return atSafeBoundary(
        attention(current, verificationFailureReason(outcome.result), "blocked"),
      );
    }

    const next = copySnapshot(current);
    const nextTask = activeTask(next, "verifying");
    if (!nextTask) return attention(current, "Verifying task disappeared");
    nextTask.state = "evaluating";
    next.run.state = "evaluating";
    return atSafeBoundary({
      snapshot: next,
      action: { type: "evaluate", taskId: nextTask.id },
    });
  }

  const task = activeTask(current, "evaluating");
  if (!task) return attention(current, "Evaluating run has no evaluating active task");
  if (outcome.type !== "evaluation_completed") {
    return attention(current, `Unexpected ${outcome.type} while evaluating`);
  }

  if (outcome.verdict === "accepted") {
    const next = copySnapshot(current);
    const nextTask = activeTask(next, "evaluating");
    if (!nextTask) return attention(current, "Evaluating task disappeared");
    nextTask.state = "accepted";
    next.run.activeTaskId = null;
    return atSafeBoundary(startNextQueued(next));
  }

  if (outcome.verdict === "revise") {
    if (task.revisionCount + 1 >= current.spec.maxTaskIterations) {
      return atSafeBoundary(
        attention(current, "Evaluator requested more than one revision", "attention"),
      );
    }
    const next = copySnapshot(current);
    const nextTask = activeTask(next, "evaluating");
    if (!nextTask) return attention(current, "Evaluating task disappeared");
    nextTask.revisionCount += 1;
    nextTask.state = "working";
    next.run.state = "working";
    return atSafeBoundary({
      snapshot: next,
      action: { type: "start_worker", taskId: nextTask.id },
    });
  }

  return atSafeBoundary(
    attention(
      current,
      `Evaluator returned ${outcome.verdict}`,
      outcome.verdict === "blocked" ? "blocked" : "attention",
    ),
  );
}
