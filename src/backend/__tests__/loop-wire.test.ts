import { describe, expect, it } from "vitest";
import { decodeLoopSnapshot, decodeLoopSummaries, encodeLoopSpecDraft } from "../loop-wire";

describe("loop wire mapping", () => {
  it("encodes the nested frontend spec for the flat Rust command", () => {
    expect(
      encodeLoopSpecDraft({
        orchestrator: { prompt: "discover", model: "" },
        worker: { prompt: "work", model: "worker-model" },
        evaluator: { prompt: "judge", model: "judge-model" },
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
      verifier_program: "npm",
      verifier_args: ["test"],
      verifier_cwd: "/repo",
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
});
