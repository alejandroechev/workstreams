import { describe, expect, it } from "vitest";
import {
  decodeLoopSnapshot,
  decodeLoopSpec,
  decodeLoopSummaries,
  encodeLoopSpecDraft,
  type LoopSpecWire,
} from "../loop-wire";

function specWire(overrides: Partial<LoopSpecWire> = {}): LoopSpecWire {
  return {
    id: "spec-1",
    workstream_id: "ws-1",
    orchestrator_prompt: "discover",
    worker_prompt: "work",
    evaluator_prompt: "judge",
    orchestrator_model: null,
    worker_model: null,
    evaluator_model: null,
    human_approval_prompt: null,
    verifier_program: null,
    verifier_args: [],
    verifier_cwd: null,
    run_timeout_seconds: 60,
    max_task_iterations: 2,
    enabled: false,
    created_at: "100",
    updated_at: "101",
    ...overrides,
  };
}

describe("loop wire mapping", () => {
  it("encodes the nested frontend spec for the flat Rust command", () => {
    expect(
      encodeLoopSpecDraft({
        orchestrator: { prompt: "discover", model: "" },
        worker: { prompt: "work", model: "worker-model" },
        evaluator: { prompt: "judge", model: "judge-model" },
        humanApproval: { prompt: "Human review" },
        verifier: { program: "npm", args: ["test"], cwd: "/repo" },
        runTimeoutMs: 90_000,
        maxTaskIterations: 2,
      }),
    ).toEqual({
      orchestrator_prompt: "discover",
      worker_prompt: "work",
      evaluator_prompt: "judge",
      orchestrator_model: null,
      worker_model: "worker-model",
      evaluator_model: "judge-model",
      human_approval_prompt: "Human review",
      verifier_program: "npm",
      verifier_args: ["test"],
      verifier_cwd: "/repo",
      verifier_timeout_seconds: null,
      run_timeout_seconds: 90,
      max_task_iterations: 2,
    });
  });

  it("decodes a persisted run with tasks, checks, verdicts, and events", () => {
    const decoded = decodeLoopSnapshot({
      spec: {
        id: "spec-1",
        workstream_id: "ws-1",
        orchestrator_prompt: "discover",
        worker_prompt: "work",
        evaluator_prompt: "judge",
        orchestrator_model: null,
        worker_model: "worker-model",
        evaluator_model: null,
        human_approval_prompt: "Human review",
        verifier_program: "npm",
        verifier_args: ["test"],
        verifier_cwd: "/repo",
        run_timeout_seconds: 90,
        max_task_iterations: 2,
        enabled: true,
        created_at: "created",
        updated_at: "updated",
      },
      latest_run: {
        id: "run-1",
        loop_spec_id: "spec-1",
        state: "evaluating",
        current_task_id: "task-1",
        control_requested: "none",
        error: null,
        started_at: "started",
        finished_at: null,
        deadline_at: "deadline",
      },
      tasks: [{
        id: "task-1",
        loop_run_id: "run-1",
        loop_spec_id: "spec-1",
        key: "key-1",
        title: "Task",
        objective: "Do it",
        state: "evaluating",
        worker_session_id: "session-1",
        revision_count: 0,
        worker_result: "{}",
        error: null,
        created_at: "created",
        updated_at: "updated",
      }],
      verifications: [{
        id: "verify-1",
        loop_task_id: "task-1",
        attempt: 1,
        status: "passed",
        program: "npm",
        args: ["test"],
        cwd: "/repo",
        program_hash: "abc",
        exit_code: 0,
        duration_ms: 12,
        stdout: "ok",
        stderr: "",
        truncated: false,
        created_at: "created",
      }],
      evaluations: [{
        id: "evaluation-1",
        loop_task_id: "task-1",
        attempt: 1,
        session_id: "evaluator-1",
        verdict: "accepted",
        summary: "good",
        feedback: null,
        evidence: ["tests"],
        created_at: "created",
      }],
      approvals: [{
        id: "approval-1",
        loop_task_id: "task-1",
        attempt: 1,
        status: "pending",
        prompt: "Human review",
        feedback: null,
        created_at: "created",
        decided_at: null,
      }],
      events: [{
        id: 1,
        loop_spec_id: "spec-1",
        loop_run_id: "run-1",
        loop_task_id: "task-1",
        event_type: "assistant.message",
        payload: { content: "working" },
        created_at: "created",
      }],
    });

    expect(decoded.spec?.orchestrator).toEqual({ prompt: "discover", model: "" });
    expect(decoded.latestRun).toMatchObject({
      loopSpecId: "spec-1",
      activeTaskId: "task-1",
      controlRequested: "none",
    });
    expect(decoded.tasks[0]).toMatchObject({
      loopRunId: "run-1",
      workerSessionId: "session-1",
    });
    expect(decoded.verifications[0]).toMatchObject({
      loopTaskId: "task-1",
      exitCode: 0,
    });
    expect(decoded.evaluations[0].sessionId).toBe("evaluator-1");
    expect(decoded.spec?.humanApproval?.prompt).toBe("Human review");
    expect(decoded.approvals[0]).toMatchObject({
      status: "pending",
      prompt: "Human review",
    });
    expect(decoded.events[0].eventType).toBe("assistant.message");
  });

  it("decodes sidebar summaries", () => {
    expect(
      decodeLoopSummaries([{
        workstream_id: "ws-1",
        loop_spec_id: "spec-1",
        enabled: true,
        run_id: "run-1",
        run_state: "working",
        control_requested: "none",
        current_task_id: "task-1",
        started_at: "started",
      }]),
    ).toEqual([{
      workstreamId: "ws-1",
      loopSpecId: "spec-1",
      enabled: true,
      runId: "run-1",
      runState: "working",
      controlRequested: "none",
      currentTaskId: "task-1",
      startedAt: "started",
    }]);
  });

  it("normalizes epoch timestamps and supports a verifier without a cwd", () => {
    const decoded = decodeLoopSpec(specWire({
      verifier_program: "npm",
      verifier_args: ["test"],
    }));

    expect(decoded.createdAt).toBe("1970-01-01T00:01:40.000Z");
    expect(decoded.updatedAt).toBe("1970-01-01T00:01:41.000Z");
    expect(decoded.verifier).toEqual({
      program: "npm",
      args: ["test"],
    });
  });

  it("supports a verification-only loop with no evaluator", () => {
    const decoded = decodeLoopSpec(specWire({
      evaluator_prompt: null,
      evaluator_model: null,
      verifier_program: "scripts/verify.sh",
      verifier_args: [],
    }));

    expect(decoded.evaluator).toBeUndefined();
    expect(decoded.verifier?.program).toBe("scripts/verify.sh");
  });

  it("rejects unsupported iteration contracts", () => {
    expect(() =>
      decodeLoopSpec(specWire({ max_task_iterations: 3 })),
    ).toThrow("Unsupported max task iterations");
  });

  it("decodes an unconfigured workstream and nullable sidebar run fields", () => {
    expect(
      decodeLoopSnapshot({
        spec: null,
        latest_run: null,
        tasks: [],
        verifications: [],
        evaluations: [],
        approvals: [],
        events: [],
      }),
    ).toEqual({
      spec: null,
      latestRun: null,
      tasks: [],
      verifications: [],
      evaluations: [],
      approvals: [],
      events: [],
    });

    expect(
      decodeLoopSummaries([{
        workstream_id: "ws-1",
        loop_spec_id: "spec-1",
        enabled: false,
        run_id: null,
        run_state: null,
        control_requested: null,
        current_task_id: null,
        started_at: null,
      }]),
    ).toEqual([{
      workstreamId: "ws-1",
      loopSpecId: "spec-1",
      enabled: false,
      runId: undefined,
      runState: undefined,
      controlRequested: undefined,
      currentTaskId: undefined,
      startedAt: undefined,
    }]);
  });
});
