import {
  type EvaluatorVerdict,
  type LoopEvaluationRecord,
  type LoopApprovalRecord,
  type LoopEventRecord,
  type LoopRun,
  type LoopRunState,
  type LoopSpec,
  type LoopSpecDraft,
  type LoopStageRecord,
  type LoopSummary,
  type LoopTask,
  type LoopTaskState,
  type LoopVerificationRecord,
  type PersistedLoopSnapshot,
} from "../domain/loop";

export interface LoopSpecWire {
  id: string;
  workstream_id: string;
  orchestrator_prompt: string;
  worker_prompt: string;
  evaluator_prompt: string | null;
  orchestrator_model: string | null;
  worker_model: string | null;
  evaluator_model: string | null;
  human_approval_prompt: string | null;
  verifier_program: string | null;
  verifier_args: string[];
  verifier_cwd: string | null;
  verifier_timeout_seconds?: number | null;
  run_timeout_seconds: number;
  max_task_iterations: number;
  max_tasks_per_cycle?: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  definition_id?: string | null;
  definition_path?: string | null;
  definition_hash?: string | null;
  definition_name?: string | null;
  objective?: string | null;
  portable?: boolean | null;
}

export interface LoopSpecInputWire {
  orchestrator_prompt: string;
  worker_prompt: string;
  evaluator_prompt: string | null;
  orchestrator_model: string | null;
  worker_model: string | null;
  evaluator_model: string | null;
  human_approval_prompt: string | null;
  verifier_program: string | null;
  verifier_args: string[];
  verifier_cwd: string | null;
  verifier_timeout_seconds: number | null;
  run_timeout_seconds: number;
  max_task_iterations: number;
  max_tasks_per_cycle?: number;
}

export interface LoopRunWire {
  id: string;
  loop_spec_id: string;
  state: LoopRunState;
  current_task_id: string | null;
  control_requested: "none" | "pause" | "stop" | "kill";
  error: string | null;
  started_at: string;
  finished_at: string | null;
  deadline_at: string;
  definition_hash?: string | null;
}

export interface LoopTaskWire {
  id: string;
  loop_run_id: string;
  loop_spec_id: string;
  key: string;
  title: string;
  objective: string;
  state: LoopTaskState;
  worker_session_id: string | null;
  revision_count: number;
  worker_result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoopVerificationWire {
  id: string;
  loop_task_id: string;
  attempt: number;
  status: LoopVerificationRecord["status"];
  program: string;
  args: string[];
  cwd: string | null;
  program_hash: string | null;
  exit_code: number | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  created_at: string;
}

export interface LoopEvaluationWire {
  id: string;
  loop_task_id: string;
  attempt: number;
  session_id: string | null;
  verdict: EvaluatorVerdict;
  summary: string;
  feedback: string | null;
  evidence: string[];
  created_at: string;
}

export interface LoopApprovalWire {
  id: string;
  loop_task_id: string;
  attempt: number;
  status: LoopApprovalRecord["status"];
  prompt: string;
  feedback: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface LoopStageWire {
  id: string;
  loop_run_id: string;
  loop_task_id: string | null;
  role: string;
  attempt: number;
  status: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface LoopEventWire {
  id: number;
  loop_spec_id: string;
  loop_run_id: string | null;
  loop_task_id: string | null;
  event_type: string;
  payload: unknown;
  created_at: string;
}

export interface LoopSnapshotWire {
  spec: LoopSpecWire | null;
  latest_run: LoopRunWire | null;
  tasks: LoopTaskWire[];
  verifications: LoopVerificationWire[];
  evaluations: LoopEvaluationWire[];
  approvals: LoopApprovalWire[];
  stages?: LoopStageWire[];
  events: LoopEventWire[];
}

export interface LoopSummaryWire {
  workstream_id: string;
  loop_spec_id: string;
  enabled: boolean;
  run_id: string | null;
  run_state: LoopRunState | null;
  control_requested: "none" | "pause" | "stop" | "kill" | null;
  current_task_id: string | null;
  started_at: string | null;
}

function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

function timestamp(value: string): string {
  return /^\d+$/.test(value)
    ? new Date(Number(value) * 1000).toISOString()
    : value;
}

function optionalTimestamp(value: string | null): string | undefined {
  return value === null ? undefined : timestamp(value);
}

function model(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeSpec(spec: LoopSpecWire): LoopSpec {
  if (!Number.isInteger(spec.max_task_iterations) || spec.max_task_iterations < 1) {
    throw new Error(`Invalid max task iterations: ${spec.max_task_iterations}`);
  }
  return {
    id: spec.id,
    workstreamId: spec.workstream_id,
    orchestrator: {
      prompt: spec.orchestrator_prompt,
      model: spec.orchestrator_model ?? "",
    },
    worker: {
      prompt: spec.worker_prompt,
      model: spec.worker_model ?? "",
    },
    evaluator: spec.evaluator_prompt
      ? {
          prompt: spec.evaluator_prompt,
          model: spec.evaluator_model ?? "",
        }
      : undefined,
    humanApproval: spec.human_approval_prompt
      ? { prompt: spec.human_approval_prompt }
      : undefined,
    verifier: spec.verifier_program
      ? {
          program: spec.verifier_program,
          args: spec.verifier_args,
          ...(spec.verifier_cwd ? { cwd: spec.verifier_cwd } : {}),
        }
      : undefined,
    runTimeoutMs: spec.run_timeout_seconds * 1000,
    maxTaskIterations: spec.max_task_iterations,
    maxTasksPerCycle: spec.max_tasks_per_cycle ?? 1,
    enabled: spec.enabled,
    createdAt: timestamp(spec.created_at),
    updatedAt: timestamp(spec.updated_at),
    definitionId: optional(spec.definition_id ?? null),
    definitionPath: optional(spec.definition_path ?? null),
    definitionHash: optional(spec.definition_hash ?? null),
    definitionName: optional(spec.definition_name ?? null),
    objective: optional(spec.objective ?? null),
    portable: spec.portable ?? undefined,
  };
}

function decodeRun(run: LoopRunWire): LoopRun {
  return {
    id: run.id,
    loopSpecId: run.loop_spec_id,
    state: run.state,
    activeTaskId: run.current_task_id,
    pauseRequested: run.control_requested === "pause",
    stopRequested: run.control_requested === "stop",
    pendingAction: null,
    controlRequested: run.control_requested,
    error: optional(run.error),
    startedAt: timestamp(run.started_at),
    finishedAt: optionalTimestamp(run.finished_at),
    deadlineAt: timestamp(run.deadline_at),
    definitionHash: optional(run.definition_hash ?? null),
  };
}

function decodeTask(task: LoopTaskWire): LoopTask {
  return {
    id: task.id,
    loopRunId: task.loop_run_id,
    loopSpecId: task.loop_spec_id,
    key: task.key,
    title: task.title,
    objective: task.objective,
    state: task.state,
    workerSessionId: optional(task.worker_session_id),
    revisionCount: task.revision_count,
    workerResult: optional(task.worker_result),
    error: optional(task.error),
    createdAt: timestamp(task.created_at),
    updatedAt: timestamp(task.updated_at),
  };
}

function decodeVerification(
  verification: LoopVerificationWire,
): LoopVerificationRecord {
  return {
    id: verification.id,
    loopTaskId: verification.loop_task_id,
    attempt: verification.attempt,
    status: verification.status,
    program: verification.program,
    args: verification.args,
    cwd: optional(verification.cwd),
    programHash: optional(verification.program_hash),
    exitCode: verification.exit_code ?? undefined,
    durationMs: verification.duration_ms,
    stdout: verification.stdout,
    stderr: verification.stderr,
    truncated: verification.truncated,
    createdAt: timestamp(verification.created_at),
  };
}

function decodeEvaluation(evaluation: LoopEvaluationWire): LoopEvaluationRecord {
  return {
    id: evaluation.id,
    loopTaskId: evaluation.loop_task_id,
    attempt: evaluation.attempt,
    sessionId: optional(evaluation.session_id),
    verdict: evaluation.verdict,
    summary: evaluation.summary,
    feedback: optional(evaluation.feedback),
    evidence: evaluation.evidence,
    createdAt: timestamp(evaluation.created_at),
  };
}

function decodeApproval(approval: LoopApprovalWire): LoopApprovalRecord {
  return {
    id: approval.id,
    loopTaskId: approval.loop_task_id,
    attempt: approval.attempt,
    status: approval.status,
    prompt: approval.prompt,
    feedback: optional(approval.feedback),
    createdAt: timestamp(approval.created_at),
    decidedAt: optionalTimestamp(approval.decided_at),
  };
}

function decodeEvent(event: LoopEventWire): LoopEventRecord {
  return {
    id: event.id,
    loopSpecId: event.loop_spec_id,
    loopRunId: optional(event.loop_run_id),
    loopTaskId: optional(event.loop_task_id),
    eventType: event.event_type,
    payload: event.payload,
    createdAt: timestamp(event.created_at),
  };
}

export function encodeLoopSpecDraft(input: LoopSpecDraft): LoopSpecInputWire {
  return {
    orchestrator_prompt: input.orchestrator.prompt.trim(),
    worker_prompt: input.worker.prompt.trim(),
    evaluator_prompt: input.evaluator?.prompt.trim() || null,
    orchestrator_model: model(input.orchestrator.model),
    worker_model: model(input.worker.model),
    evaluator_model: input.evaluator ? model(input.evaluator.model) : null,
    human_approval_prompt: input.humanApproval?.prompt.trim() || null,
    verifier_program: input.verifier?.program.trim() || null,
    verifier_args: input.verifier ? [...input.verifier.args] : [],
    verifier_cwd: input.verifier?.cwd?.trim() || null,
    verifier_timeout_seconds: null,
    run_timeout_seconds: Math.max(1, Math.ceil(input.runTimeoutMs / 1000)),
    max_task_iterations: input.maxTaskIterations,
    max_tasks_per_cycle: input.maxTasksPerCycle ?? 1,
  };
}

function decodeStage(stage: LoopStageWire): LoopStageRecord {
  return {
    id: stage.id,
    loopRunId: stage.loop_run_id,
    loopTaskId: optional(stage.loop_task_id),
    role: stage.role,
    attempt: stage.attempt,
    status: stage.status,
    startedAt: timestamp(stage.started_at),
    finishedAt: timestamp(stage.finished_at),
    durationMs: stage.duration_ms,
  };
}

export function decodeLoopSnapshot(
  snapshot: LoopSnapshotWire,
): PersistedLoopSnapshot {
  return {
    spec: snapshot.spec ? decodeSpec(snapshot.spec) : null,
    latestRun: snapshot.latest_run ? decodeRun(snapshot.latest_run) : null,
    tasks: snapshot.tasks.map(decodeTask),
    verifications: snapshot.verifications.map(decodeVerification),
    evaluations: snapshot.evaluations.map(decodeEvaluation),
    approvals: snapshot.approvals.map(decodeApproval),
    stages: (snapshot.stages ?? []).map(decodeStage),
    events: snapshot.events.map(decodeEvent),
  };
}

export function decodeLoopRun(run: LoopRunWire): LoopRun {
  return decodeRun(run);
}

export function decodeLoopSpec(spec: LoopSpecWire): LoopSpec {
  return decodeSpec(spec);
}

export function decodeLoopSummaries(
  summaries: LoopSummaryWire[],
): LoopSummary[] {
  return summaries.map((summary) => ({
    workstreamId: summary.workstream_id,
    loopSpecId: summary.loop_spec_id,
    enabled: summary.enabled,
    runId: optional(summary.run_id),
    runState: summary.run_state ?? undefined,
    controlRequested: summary.control_requested ?? undefined,
    currentTaskId: optional(summary.current_task_id),
    startedAt: optionalTimestamp(summary.started_at),
  }));
}
