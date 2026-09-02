import { describe, expect, it } from "vitest";

import type { LoopRun, LoopStageRecord, LoopTask } from "../loop";
import {
  matchesTaskFilter,
  orderTasks,
  stagesForTask,
  summarizeRunTiming,
  summarizeTaskTiming,
  taskHeadline,
  type LoopTaskFilter,
} from "../loop-timing";

function stage(overrides: Partial<LoopStageRecord> = {}): LoopStageRecord {
  return {
    id: "stage-1",
    loopRunId: "run-1",
    loopTaskId: "task-1",
    role: "worker",
    attempt: 1,
    status: "completed",
    startedAt: "2026-09-02T10:00:00.000Z",
    finishedAt: "2026-09-02T10:01:00.000Z",
    durationMs: 60_000,
    ...overrides,
  };
}

function run(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: "run-1",
    loopSpecId: "spec-1",
    state: "working",
    activeTaskId: "task-1",
    pauseRequested: false,
    stopRequested: false,
    pendingAction: null,
    startedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("loop timing summaries", () => {
  it("totals each role and finds the slowest stage", () => {
    const stages = [
      stage({ id: "s1", role: "orchestrator", loopTaskId: undefined, durationMs: 30_000 }),
      stage({ id: "s2", role: "worker", durationMs: 120_000 }),
      stage({ id: "s3", role: "verifier", durationMs: 45_000 }),
      stage({ id: "s4", role: "evaluator", durationMs: 90_000 }),
      stage({ id: "s5", role: "worker", attempt: 2, durationMs: 60_000 }),
    ];

    const timing = summarizeRunTiming({
      run: run(),
      stages,
      now: Date.parse("2026-09-02T10:10:00.000Z"),
    });

    expect(timing.elapsedMs).toBe(600_000);
    expect(timing.measuredMs).toBe(345_000);
    expect(timing.roles.map((role) => [role.role, role.totalMs, role.count])).toEqual([
      ["worker", 180_000, 2],
      ["evaluator", 90_000, 1],
      ["verifier", 45_000, 1],
      ["orchestrator", 30_000, 1],
    ]);
    expect(timing.slowest?.id).toBe("s2");
  });

  it("uses the finished timestamp for a completed run", () => {
    const timing = summarizeRunTiming({
      run: run({
        state: "completed",
        finishedAt: "2026-09-02T10:05:00.000Z",
      }),
      stages: [],
      now: Date.parse("2026-09-02T12:00:00.000Z"),
    });

    expect(timing.elapsedMs).toBe(300_000);
    expect(timing.measuredMs).toBe(0);
    expect(timing.slowest).toBeNull();
  });

  it("reports zero elapsed time when the run has not started", () => {
    const timing = summarizeRunTiming({
      run: null,
      stages: [],
      now: Date.parse("2026-09-02T10:00:00.000Z"),
    });
    expect(timing.elapsedMs).toBe(0);
  });

  it("scopes stage timing to one task", () => {
    const stages = [
      stage({ id: "s1", loopTaskId: "task-1", durationMs: 10_000 }),
      stage({ id: "s2", loopTaskId: "task-2", durationMs: 20_000 }),
      stage({ id: "s3", loopTaskId: "task-1", role: "evaluator", durationMs: 5_000 }),
      stage({ id: "s4", loopTaskId: undefined, role: "orchestrator", durationMs: 1_000 }),
    ];

    expect(stagesForTask(stages, "task-1").map((entry) => entry.id)).toEqual([
      "s1",
      "s3",
    ]);
    const timing = summarizeTaskTiming(stages, "task-1");
    expect(timing.totalMs).toBe(15_000);
    expect(timing.roles).toEqual([
      { role: "worker", totalMs: 10_000, count: 1 },
      { role: "evaluator", totalMs: 5_000, count: 1 },
    ]);
  });

  it("describes every task state in one line", () => {
    const states: LoopTask["state"][] = [
      "queued",
      "working",
      "verifying",
      "evaluating",
      "awaiting_approval",
      "accepted",
      "blocked",
      "attention",
      "interrupted",
    ];
    const task = (state: LoopTask["state"]): LoopTask => ({
      id: "task-1",
      loopRunId: "run-1",
      loopSpecId: "spec-1",
      key: "key",
      title: "Task",
      objective: "Objective",
      state,
      revisionCount: 0,
    });

    for (const state of states) {
      expect(taskHeadline(task(state)).length).toBeGreaterThan(0);
    }
    expect(taskHeadline(task("awaiting_approval"))).toContain("approval");
  });

  it("orders tasks newest first by default and can reverse", () => {
    const make = (id: string, createdAt?: string): LoopTask => ({
      id,
      loopRunId: "run-1",
      loopSpecId: "spec-1",
      key: id,
      title: id,
      objective: "Objective",
      state: "accepted",
      revisionCount: 0,
      createdAt,
    });
    const tasks = [
      make("first", "2026-09-02T10:00:00.000Z"),
      make("second", "2026-09-02T11:00:00.000Z"),
      make("third", "2026-09-02T12:00:00.000Z"),
    ];

    expect(orderTasks(tasks, "newest").map((task) => task.id)).toEqual([
      "third",
      "second",
      "first",
    ]);
    expect(orderTasks(tasks, "oldest").map((task) => task.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(tasks.map((task) => task.id)).toEqual(["first", "second", "third"]);
  });

  it("keeps a stable order when timestamps are missing or identical", () => {
    const make = (id: string, createdAt?: string): LoopTask => ({
      id,
      loopRunId: "run-1",
      loopSpecId: "spec-1",
      key: id,
      title: id,
      objective: "Objective",
      state: "accepted",
      revisionCount: 0,
      createdAt,
    });
    const sameSecond = [
      make("a", "2026-09-02T10:00:00.000Z"),
      make("b", "2026-09-02T10:00:00.000Z"),
      make("c"),
    ];

    expect(orderTasks(sameSecond, "newest").map((task) => task.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(orderTasks(sameSecond, "oldest").map((task) => task.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("filters tasks by lifecycle group", () => {
    const make = (state: LoopTask["state"]): LoopTask => ({
      id: state,
      loopRunId: "run-1",
      loopSpecId: "spec-1",
      key: state,
      title: state,
      objective: "Objective",
      state,
      revisionCount: 0,
    });
    const matching = (filter: LoopTaskFilter) =>
      (
        [
          "queued",
          "working",
          "verifying",
          "evaluating",
          "awaiting_approval",
          "accepted",
          "blocked",
          "attention",
          "interrupted",
        ] as LoopTask["state"][]
      )
        .map(make)
        .filter((task) => matchesTaskFilter(task, filter))
        .map((task) => task.state);

    expect(matching("all")).toHaveLength(9);
    expect(matching("active")).toEqual([
      "queued",
      "working",
      "verifying",
      "evaluating",
      "awaiting_approval",
    ]);
    expect(matching("accepted")).toEqual(["accepted"]);
    expect(matching("attention")).toEqual(["blocked", "attention", "interrupted"]);
  });
});
