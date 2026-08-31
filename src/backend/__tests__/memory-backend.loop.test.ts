import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("MemoryBackend manual coding loops", () => {
  let backend: MemoryBackend;
  let workstreamId: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    backend = new MemoryBackend();
    workstreamId = (await backend.createWorkstream("Loop", "/repo")).id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function configure() {
    const spec = await backend.saveWorkstreamLoop(workstreamId, {
      orchestrator: { prompt: "Discover work", model: "" },
      worker: { prompt: "Do the work", model: "" },
      evaluator: { prompt: "Judge the work", model: "" },
      verifier: { program: "npm", args: ["test"], cwd: "/repo" },
      runTimeoutMs: 60_000,
      maxTaskIterations: 2,
    });
    await backend.setWorkstreamLoopEnabled(spec.id, true);
    return spec;
  }

  it("freezes configuration while enabled", async () => {
    const spec = await configure();

    await expect(
      backend.saveWorkstreamLoop(workstreamId, {
        orchestrator: { prompt: "Different", model: "" },
        worker: { prompt: "Work", model: "" },
        evaluator: { prompt: "Judge", model: "" },
        runTimeoutMs: 60_000,
        maxTaskIterations: 2,
      }),
    ).rejects.toThrow("Disable");

    await backend.setWorkstreamLoopEnabled(spec.id, false);
    await expect(
      backend.saveWorkstreamLoop(workstreamId, {
        orchestrator: { prompt: "Different", model: "" },
        worker: { prompt: "Work", model: "" },
        evaluator: { prompt: "Judge", model: "" },
        runTimeoutMs: 60_000,
        maxTaskIterations: 2,
      }),
    ).resolves.toMatchObject({ enabled: false });
  });

  it("projects the complete manual pipeline", async () => {
    await configure();
    const run = await backend.runWorkstreamLoopNow(workstreamId);
    expect(run.state).toBe("starting");

    await vi.advanceTimersByTimeAsync(320);
    expect((await backend.getWorkstreamLoopSnapshot(workstreamId)).latestRun)
      .toMatchObject({ state: "working" });

    await vi.advanceTimersByTimeAsync(1_200);
    const snapshot = await backend.getWorkstreamLoopSnapshot(workstreamId);
    expect(snapshot.latestRun?.state).toBe("completed");
    expect(snapshot.tasks[0].state).toBe("accepted");
    expect(snapshot.verifications[0].status).toBe("passed");
    expect(snapshot.evaluations[0].verdict).toBe("accepted");
  });

  it("kills an active run and preserves interrupted task evidence", async () => {
    await configure();
    const run = await backend.runWorkstreamLoopNow(workstreamId);
    await vi.advanceTimersByTimeAsync(320);

    await backend.controlWorkstreamLoop(run.id, "kill");
    await vi.advanceTimersByTimeAsync(1_000);

    const snapshot = await backend.getWorkstreamLoopSnapshot(workstreamId);
    expect(snapshot.latestRun?.state).toBe("killed");
    expect(snapshot.tasks[0]).toMatchObject({
      state: "interrupted",
      error: "Loop killed",
    });
  });

  it("rejects invalid setup and lifecycle requests", async () => {
    await expect(backend.runWorkstreamLoopNow(workstreamId)).rejects.toThrow(
      "Configure",
    );
    const spec = await backend.saveWorkstreamLoop(workstreamId, {
      orchestrator: { prompt: "Discover", model: "" },
      worker: { prompt: "Work", model: "" },
      evaluator: { prompt: "Evaluate", model: "" },
      runTimeoutMs: 60_000,
      maxTaskIterations: 2,
    });
    await expect(backend.runWorkstreamLoopNow(workstreamId)).rejects.toThrow(
      "Enable",
    );
    await expect(
      backend.setWorkstreamLoopEnabled("missing", true),
    ).rejects.toThrow("not found");
    await expect(backend.resumeWorkstreamLoop("missing")).rejects.toThrow(
      "not found",
    );
    await expect(
      backend.controlWorkstreamLoop("missing", "kill"),
    ).rejects.toThrow("not found");
    await backend.setWorkstreamLoopEnabled(spec.id, true);
    await backend.runWorkstreamLoopNow(workstreamId);
    await expect(backend.runWorkstreamLoopNow(workstreamId)).rejects.toThrow(
      "active run",
    );
  });

  it("uses domain safe boundaries for pause, resume, and stop", async () => {
    await configure();
    const run = await backend.runWorkstreamLoopNow(workstreamId);
    await vi.advanceTimersByTimeAsync(320);

    await backend.controlWorkstreamLoop(run.id, "pause");
    expect(
      (await backend.getWorkstreamLoopSnapshot(workstreamId)).latestRun,
    ).toMatchObject({ state: "working", pauseRequested: true });

    await vi.advanceTimersByTimeAsync(400);
    expect(
      (await backend.getWorkstreamLoopSnapshot(workstreamId)).latestRun?.state,
    ).toBe("paused");

    await backend.resumeWorkstreamLoop(run.id);
    await backend.controlWorkstreamLoop(run.id, "stop");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(
      (await backend.getWorkstreamLoopSnapshot(workstreamId)).latestRun?.state,
    ).toBe("attention");
  });

  it("discovers and runs a seeded YAML definition", async () => {
    backend.seedLoopDefinition(
      {
        id: "simple-loop",
        name: "Simple loop",
        tags: ["demo"],
        path: "/repo/.workstreams/loops/simple.loop.yaml",
        hash: "hash-1",
        portable: true,
        objective: "Create output",
        hasVerification: true,
        hasEvaluator: false,
      },
      {
        orchestrator: { prompt: "Plan", model: "" },
        worker: { prompt: "Work", model: "" },
        verifier: { program: "verify", args: [] },
        runTimeoutMs: 60_000,
        maxTaskIterations: 2,
      },
    );

    await expect(backend.listLoopDefinitions("/repo")).resolves.toMatchObject({
      definitions: [{ id: "simple-loop" }],
    });
    const run = await backend.runLoopDefinitionNow(
      workstreamId,
      "/repo/.workstreams/loops/simple.loop.yaml",
    );
    expect(run.state).toBe("starting");
    const snapshot = await backend.getWorkstreamLoopSnapshot(workstreamId);
    expect(snapshot.spec).toMatchObject({
      definitionId: "simple-loop",
      definitionHash: "hash-1",
    });
    expect(snapshot.spec?.evaluator).toBeUndefined();
  });
});
