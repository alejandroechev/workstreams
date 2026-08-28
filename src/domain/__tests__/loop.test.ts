import { describe, expect, it } from "vitest";
import {
  LOOP_RUN_STATES,
  LOOP_TASK_STATES,
  MAX_TASK_ITERATIONS,
  addLoopSpec,
  dedupeTaskKeys,
  makeLoopRun,
  transitionLoop,
} from "../loop";
import type {
  LoopSnapshot,
  LoopSpec,
  LoopTask,
  VerificationResult,
} from "../loop";

function spec(overrides: Partial<LoopSpec> = {}): LoopSpec {
  return {
    id: "loop-1",
    workstreamId: "ws-1",
    orchestrator: { prompt: "Plan the next batch.", model: "orchestrator-model" },
    worker: { prompt: "Implement one task.", model: "worker-model" },
    evaluator: { prompt: "Evaluate the result.", model: "evaluator-model" },
    verifier: {
      program: "npm",
      args: ["test", "--", "loop.test.ts"],
      cwd: "/repo",
    },
    runTimeoutMs: 60_000,
    maxTaskIterations: MAX_TASK_ITERATIONS,
    enabled: true,
    ...overrides,
  };
}

function task(overrides: Partial<LoopTask> = {}): LoopTask {
  return {
    id: "task-1",
    loopRunId: "run-1",
    loopSpecId: "loop-1",
    key: "domain-loop",
    title: "Implement loop domain",
    objective: "Provide deterministic loop transitions.",
    state: "queued",
    revisionCount: 0,
    ...overrides,
  };
}

function snapshot(
  state: LoopSnapshot["run"]["state"],
  tasks: LoopTask[] = [],
  overrides: Partial<LoopSnapshot> = {},
): LoopSnapshot {
  return {
    spec: spec(),
    run: makeLoopRun({ id: "run-1", loopSpecId: "loop-1", state }),
    tasks,
    ...overrides,
  };
}

describe("loop contracts", () => {
  it("exposes the exact run and task state vocabularies", () => {
    expect([...LOOP_RUN_STATES]).toEqual([
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
    ]);
    expect([...LOOP_TASK_STATES]).toEqual([
      "queued",
      "working",
      "verifying",
      "evaluating",
      "accepted",
      "blocked",
      "attention",
      "interrupted",
    ]);
    expect(MAX_TASK_ITERATIONS).toBe(2);
  });

  it("registers at most one manual loop spec per workstream", () => {
    const first = spec();
    expect(addLoopSpec([], first)).toEqual({ ok: true, specs: [first] });

    const duplicate = addLoopSpec([first], spec({ id: "loop-2" }));
    expect(duplicate).toEqual({
      ok: false,
      reason: "Workstream ws-1 already has a loop spec",
    });
  });
});

describe("task-key dedupe", () => {
  it("rejects keys already completed or in flight", () => {
    const existing = [
      task({ id: "accepted", key: "done-key", state: "accepted" }),
      task({ id: "working", key: "live-key", state: "working" }),
    ];

    expect(dedupeTaskKeys([task({ key: "done-key" })], existing)).toEqual({
      ok: false,
      duplicateKeys: ["done-key"],
    });
    expect(dedupeTaskKeys([task({ key: "live-key" })], existing)).toEqual({
      ok: false,
      duplicateKeys: ["live-key"],
    });
  });

  it("rejects duplicate keys inside a proposed batch", () => {
    const proposed = [
      task({ id: "a", key: "same" }),
      task({ id: "b", key: "same" }),
    ];
    expect(dedupeTaskKeys(proposed, [])).toEqual({
      ok: false,
      duplicateKeys: ["same"],
    });
  });

  it("permits retrying a previously interrupted key", () => {
    const existing = [task({ id: "old", key: "retry", state: "interrupted" })];
    expect(dedupeTaskKeys([task({ id: "new", key: "retry" })], existing)).toEqual({
      ok: true,
    });
  });
});

describe("transitionLoop", () => {
  it("starts an enabled loop by invoking the orchestrator", () => {
    const result = transitionLoop(snapshot("starting"), { type: "run_started" });
    expect(result.snapshot.run.state).toBe("orchestrating");
    expect(result.action).toEqual({ type: "orchestrate" });
  });

  it("fails visibly instead of starting a disabled loop", () => {
    const current = snapshot("starting", [], { spec: spec({ enabled: false }) });
    const result = transitionLoop(current, { type: "run_started" });
    expect(result.snapshot.run.state).toBe("attention");
    expect(result.action).toEqual({
      type: "attention",
      reason: "Loop spec loop-1 is disabled",
    });
  });

  it("accepts a well-formed batch and starts its first task", () => {
    const queued = [task(), task({ id: "task-2", key: "tests", title: "Add tests" })];
    const result = transitionLoop(snapshot("orchestrating"), {
      type: "tasks_proposed",
      tasks: queued,
    });

    expect(result.snapshot.run).toMatchObject({
      state: "working",
      activeTaskId: "task-1",
    });
    expect(result.snapshot.tasks.map((candidate) => candidate.state)).toEqual([
      "working",
      "queued",
    ]);
    expect(result.action).toEqual({ type: "start_worker", taskId: "task-1" });
  });

  it("completes successfully when the orchestrator finds no work", () => {
    const result = transitionLoop(snapshot("orchestrating"), {
      type: "tasks_proposed",
      tasks: [],
    });
    expect(result.snapshot.run.state).toBe("completed");
    expect(result.action).toEqual({ type: "none" });
  });

  it.each([
    ["a task for another run", [task({ loopRunId: "run-2" })]],
    ["a task for another spec", [task({ loopSpecId: "loop-2" })]],
    ["a task with a blank objective", [task({ objective: " " })]],
    [
      "duplicate task ids",
      [task({ id: "same", key: "a" }), task({ id: "same", key: "b" })],
    ],
  ])("fails visibly for malformed batches: %s", (_label, tasks) => {
    const result = transitionLoop(snapshot("orchestrating"), {
      type: "tasks_proposed",
      tasks,
    });
    expect(result.snapshot.run.state).toBe("attention");
    expect(result.action.type).toBe("attention");
  });

  it("moves worker output through deterministic verification", () => {
    const current = snapshot("working", [task({ state: "working" })]);
    current.run.activeTaskId = "task-1";

    const result = transitionLoop(current, {
      type: "worker_completed",
      workerSessionId: "session-1",
    });
    expect(result.snapshot.run.state).toBe("verifying");
    expect(result.snapshot.tasks[0]).toMatchObject({
      state: "verifying",
      workerSessionId: "session-1",
    });
    expect(result.action).toEqual({ type: "run_verifier", taskId: "task-1" });
  });

  it("goes directly from worker to evaluator when no verifier is configured", () => {
    const current = snapshot("working", [task({ state: "working" })], {
      spec: spec({ verifier: undefined }),
    });
    current.run.activeTaskId = "task-1";

    const result = transitionLoop(current, {
      type: "worker_completed",
      workerSessionId: "session-1",
    });
    expect(result.snapshot.run.state).toBe("evaluating");
    expect(result.snapshot.tasks[0].state).toBe("evaluating");
    expect(result.action).toEqual({ type: "evaluate", taskId: "task-1" });
  });

  it("sends only passed deterministic verification to the evaluator", () => {
    const current = snapshot("verifying", [task({ state: "verifying" })]);
    current.run.activeTaskId = "task-1";

    const result = transitionLoop(current, {
      type: "verification_completed",
      result: { kind: "passed" },
    });
    expect(result.snapshot.run.state).toBe("evaluating");
    expect(result.snapshot.tasks[0].state).toBe("evaluating");
    expect(result.action).toEqual({ type: "evaluate", taskId: "task-1" });
  });

  it.each<VerificationResult>([
    { kind: "nonzero", exitCode: 1 },
    { kind: "timeout" },
    { kind: "spawn_error", message: "program not found" },
  ])("blocks failed deterministic verification: $kind", (verification) => {
    const current = snapshot("verifying", [task({ state: "verifying" })]);
    current.run.activeTaskId = "task-1";

    const failed = transitionLoop(current, {
      type: "verification_completed",
      result: verification,
    });
    expect(failed.snapshot.run.state).toBe("attention");
    expect(failed.snapshot.tasks[0].state).toBe("blocked");
    expect(failed.action.type).toBe("attention");

    const attemptedAcceptance = transitionLoop(failed.snapshot, {
      type: "evaluation_completed",
      verdict: "accepted",
    });
    expect(attemptedAcceptance.snapshot.tasks[0].state).toBe("blocked");
  });

  it("accepts a task and starts the next queued task", () => {
    const tasks = [
      task({ state: "evaluating" }),
      task({ id: "task-2", key: "tests", title: "Add tests" }),
    ];
    const current = snapshot("evaluating", tasks);
    current.run.activeTaskId = "task-1";

    const result = transitionLoop(current, {
      type: "evaluation_completed",
      verdict: "accepted",
    });
    expect(result.snapshot.tasks.map((candidate) => candidate.state)).toEqual([
      "accepted",
      "working",
    ]);
    expect(result.snapshot.run).toMatchObject({
      state: "working",
      activeTaskId: "task-2",
    });
    expect(result.action).toEqual({ type: "start_worker", taskId: "task-2" });
  });

  it("completes the run after its last task is accepted", () => {
    const current = snapshot("evaluating", [task({ state: "evaluating" })]);
    current.run.activeTaskId = "task-1";

    const result = transitionLoop(current, {
      type: "evaluation_completed",
      verdict: "accepted",
    });
    expect(result.snapshot.tasks[0].state).toBe("accepted");
    expect(result.snapshot.run).toMatchObject({
      state: "completed",
      activeTaskId: null,
    });
    expect(result.action).toEqual({ type: "none" });
  });

  it("allows exactly one evaluator-driven revision", () => {
    const first = snapshot("evaluating", [task({ state: "evaluating" })]);
    first.run.activeTaskId = "task-1";
    const revised = transitionLoop(first, {
      type: "evaluation_completed",
      verdict: "revise",
    });
    expect(revised.snapshot.tasks[0]).toMatchObject({
      state: "working",
      revisionCount: 1,
    });
    expect(revised.action).toEqual({ type: "start_worker", taskId: "task-1" });

    const second = snapshot("evaluating", [
      task({ state: "evaluating", revisionCount: 1 }),
    ]);
    second.run.activeTaskId = "task-1";
    const exhausted = transitionLoop(second, {
      type: "evaluation_completed",
      verdict: "revise",
    });
    expect(exhausted.snapshot.run.state).toBe("attention");
    expect(exhausted.snapshot.tasks[0].state).toBe("attention");
  });

  it.each(["blocked", "invalid"] as const)(
    "surfaces an evaluator %s verdict as attention",
    (verdict) => {
      const current = snapshot("evaluating", [task({ state: "evaluating" })]);
      current.run.activeTaskId = "task-1";
      const result = transitionLoop(current, {
        type: "evaluation_completed",
        verdict,
      });
      expect(result.snapshot.run.state).toBe("attention");
      expect(result.snapshot.tasks[0].state).toBe(
        verdict === "blocked" ? "blocked" : "attention",
      );
    },
  );

  it("pauses only after the current stage reaches a safe boundary", () => {
    const current = snapshot("working", [task({ state: "working" })]);
    current.run.activeTaskId = "task-1";

    const requested = transitionLoop(current, { type: "pause_requested" });
    expect(requested.snapshot.run).toMatchObject({
      state: "working",
      pauseRequested: true,
    });
    expect(requested.action).toEqual({ type: "none" });

    const paused = transitionLoop(requested.snapshot, {
      type: "worker_completed",
      workerSessionId: "session-1",
    });
    expect(paused.snapshot.run.state).toBe("paused");
    expect(paused.snapshot.tasks[0].state).toBe("verifying");
    expect(paused.snapshot.run.pendingAction).toEqual({
      type: "run_verifier",
      taskId: "task-1",
    });
    expect(paused.action).toEqual({ type: "none" });

    const resumed = transitionLoop(paused.snapshot, { type: "resume_requested" });
    expect(resumed.snapshot.run.state).toBe("verifying");
    expect(resumed.action).toEqual({ type: "run_verifier", taskId: "task-1" });
  });

  it("stops at the current safe boundary and never starts future work", () => {
    const tasks = [
      task({ state: "working" }),
      task({ id: "task-2", key: "later", state: "queued" }),
    ];
    const current = snapshot("working", tasks);
    current.run.activeTaskId = "task-1";

    const requested = transitionLoop(current, { type: "stop_requested" });
    expect(requested.snapshot.run).toMatchObject({
      state: "working",
      stopRequested: true,
    });

    const stopping = transitionLoop(requested.snapshot, {
      type: "worker_completed",
      workerSessionId: "session-1",
    });
    expect(stopping.snapshot.run.state).toBe("stopping");
    expect(stopping.snapshot.tasks.map((candidate) => candidate.state)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(stopping.action).toEqual({ type: "stop" });

    const ignored = transitionLoop(stopping.snapshot, {
      type: "tasks_proposed",
      tasks: [task({ id: "future", key: "future" })],
    });
    expect(ignored.snapshot.tasks).toHaveLength(2);
    expect(ignored.action).toEqual({ type: "none" });

    const completed = transitionLoop(ignored.snapshot, { type: "stop_completed" });
    expect(completed.snapshot.run.state).toBe("completed");
  });

  it("honors a graceful stop even when the current stage fails", () => {
    const current = snapshot("verifying", [task({ state: "verifying" })]);
    current.run.activeTaskId = "task-1";
    const requested = transitionLoop(current, { type: "stop_requested" });

    const stopping = transitionLoop(requested.snapshot, {
      type: "verification_completed",
      result: { kind: "nonzero", exitCode: 1 },
    });
    expect(stopping.snapshot.run.state).toBe("stopping");
    expect(stopping.snapshot.tasks[0].state).toBe("blocked");
    expect(stopping.action).toEqual({ type: "stop" });
  });

  it("kills immediately, interrupts unfinished tasks, and stays terminal", () => {
    const current = snapshot("working", [task({ state: "working" })]);
    current.run.activeTaskId = "task-1";

    const killed = transitionLoop(current, { type: "kill_requested" });
    expect(killed.snapshot.run.state).toBe("killed");
    expect(killed.snapshot.tasks[0].state).toBe("interrupted");
    expect(killed.action).toEqual({ type: "kill" });

    const later = transitionLoop(killed.snapshot, {
      type: "worker_completed",
      workerSessionId: "too-late",
    });
    expect(later).toEqual({
      snapshot: killed.snapshot,
      action: { type: "none" },
    });
  });

  it("surfaces a run timeout and interrupts unfinished work", () => {
    const current = snapshot("working", [task({ state: "working" })]);
    current.run.activeTaskId = "task-1";
    const result = transitionLoop(current, { type: "run_timed_out" });
    expect(result.snapshot.run.state).toBe("attention");
    expect(result.snapshot.tasks[0].state).toBe("interrupted");
    expect(result.action).toEqual({
      type: "attention",
      reason: "Loop run exceeded its timeout",
    });
  });
});
