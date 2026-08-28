import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import type {
  LoopEvaluationRecord,
  LoopEventRecord,
  LoopRun,
  LoopSpec,
  LoopTask,
  LoopVerificationRecord,
  PersistedLoopSnapshot,
} from "../../domain/loop";
import LoopControlTile from "../LoopControlTile";

const listenMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

function loopSpec(overrides: Partial<LoopSpec> = {}): LoopSpec {
  return {
    id: "loop-1",
    workstreamId: "ws-1",
    orchestrator: { prompt: "Plan work", model: "planner" },
    worker: { prompt: "Implement work", model: "worker" },
    evaluator: { prompt: "Review work", model: "reviewer" },
    verifier: { program: "npm", args: ["test"], cwd: "/repo" },
    runTimeoutMs: 30 * 60_000,
    maxTaskIterations: 2,
    enabled: true,
    ...overrides,
  };
}

function run(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: "run-1",
    loopSpecId: "loop-1",
    state: "working",
    activeTaskId: "task-1",
    pauseRequested: false,
    stopRequested: false,
    pendingAction: null,
    controlRequested: "none",
    startedAt: "2026-08-28T18:00:00.000Z",
    deadlineAt: "2026-08-28T18:30:00.000Z",
    ...overrides,
  };
}

function task(overrides: Partial<LoopTask> = {}): LoopTask {
  return {
    id: "task-1",
    loopRunId: "run-1",
    loopSpecId: "loop-1",
    key: "domain",
    title: "Implement the domain",
    objective: "Build the requested behavior",
    state: "working",
    workerSessionId: "session-1",
    revisionCount: 0,
    workerResult: "Implemented the state machine",
    ...overrides,
  };
}

function snapshot(overrides: Partial<PersistedLoopSnapshot> = {}): PersistedLoopSnapshot {
  return {
    spec: null,
    latestRun: null,
    tasks: [],
    verifications: [],
    evaluations: [],
    events: [],
    ...overrides,
  };
}

function setup(initial: PersistedLoopSnapshot) {
  const backend = new MemoryBackend();
  let current = initial;
  const getSnapshot = vi
    .spyOn(backend, "getWorkstreamLoopSnapshot")
    .mockImplementation(async () => current);
  const setSnapshot = (next: PersistedLoopSnapshot) => {
    current = next;
  };

  render(
    <BackendProvider backend={backend}>
      <LoopControlTile
        tileId="tile-1"
        workstreamId="ws-1"
        workstreamDir="/repo"
        isFocused
      />
    </BackendProvider>,
  );

  return { backend, getSnapshot, setSnapshot };
}

beforeEach(() => {
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LoopControlTile configuration", () => {
  it("creates and enables a new loop from the setup form", async () => {
    const { backend } = setup(snapshot());
    const saved = loopSpec({ enabled: false });
    const save = vi.spyOn(backend, "saveWorkstreamLoop").mockResolvedValue(saved);
    const enable = vi.spyOn(backend, "setWorkstreamLoopEnabled").mockResolvedValue();

    await screen.findByTestId("loop-setup-form");
    fireEvent.change(screen.getByLabelText("Orchestrator prompt"), {
      target: { value: "Break the goal into tasks" },
    });
    fireEvent.change(screen.getByLabelText("Orchestrator model"), {
      target: { value: "model-plan" },
    });
    fireEvent.change(screen.getByLabelText("Worker prompt"), {
      target: { value: "Implement one task" },
    });
    fireEvent.change(screen.getByLabelText("Worker model"), {
      target: { value: "model-work" },
    });
    fireEvent.change(screen.getByLabelText("Evaluator prompt"), {
      target: { value: "Judge the evidence" },
    });
    fireEvent.change(screen.getByLabelText("Evaluator model"), {
      target: { value: "model-eval" },
    });
    fireEvent.change(screen.getByLabelText("Run timeout minutes"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("Verifier program"), {
      target: { value: "cargo" },
    });
    fireEvent.change(screen.getByLabelText("Verifier arguments"), {
      target: { value: "test\n--lib" },
    });
    fireEvent.change(screen.getByLabelText("Verifier working directory"), {
      target: { value: "/repo/crate" },
    });
    fireEvent.click(screen.getByTestId("loop-save-enable"));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("ws-1", {
        orchestrator: { prompt: "Break the goal into tasks", model: "model-plan" },
        worker: { prompt: "Implement one task", model: "model-work" },
        evaluator: { prompt: "Judge the evidence", model: "model-eval" },
        verifier: {
          program: "cargo",
          args: ["test", "--lib"],
          cwd: "/repo/crate",
        },
        runTimeoutMs: 45 * 60_000,
        maxTaskIterations: 2,
      }),
    );
    expect(enable).toHaveBeenCalledWith("loop-1", true);
  });

  it("prefills a disabled spec and offers separate Save and Enable actions", async () => {
    const disabled = loopSpec({ enabled: false });
    const { backend } = setup(snapshot({ spec: disabled }));
    const save = vi.spyOn(backend, "saveWorkstreamLoop").mockResolvedValue(disabled);
    const enable = vi.spyOn(backend, "setWorkstreamLoopEnabled").mockResolvedValue();

    expect(
      (await screen.findByLabelText("Orchestrator prompt") as HTMLTextAreaElement).value,
    ).toBe("Plan work");
    expect((screen.getByLabelText("Run timeout minutes") as HTMLInputElement).value).toBe(
      "30",
    );

    fireEvent.change(screen.getByLabelText("Worker prompt"), {
      target: { value: "Implement carefully" },
    });
    fireEvent.click(screen.getByTestId("loop-save"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(enable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("loop-enable"));
    await waitFor(() => expect(enable).toHaveBeenCalledWith("loop-1", true));
  });

  it("renders enabled configuration read-only until Disable is clicked", async () => {
    const { backend } = setup(snapshot({ spec: loopSpec() }));
    const disable = vi.spyOn(backend, "setWorkstreamLoopEnabled").mockResolvedValue();

    await screen.findByTestId("loop-config-readonly");
    expect(screen.queryByLabelText("Orchestrator prompt")).toBeNull();
    expect(screen.getByTestId("loop-config-readonly").textContent).toContain("Plan work");
    expect(screen.getByTestId("loop-config-readonly").textContent).toContain("npm test");

    fireEvent.click(screen.getByTestId("loop-disable"));
    await waitFor(() => expect(disable).toHaveBeenCalledWith("loop-1", false));
  });

  it("surfaces configuration errors visibly", async () => {
    const { backend } = setup(snapshot());
    vi.spyOn(backend, "saveWorkstreamLoop").mockRejectedValue(new Error("Database unavailable"));

    await screen.findByTestId("loop-setup-form");
    fireEvent.change(screen.getByLabelText("Orchestrator prompt"), {
      target: { value: "Plan" },
    });
    fireEvent.change(screen.getByLabelText("Worker prompt"), {
      target: { value: "Work" },
    });
    fireEvent.change(screen.getByLabelText("Evaluator prompt"), {
      target: { value: "Evaluate" },
    });
    fireEvent.click(screen.getByTestId("loop-save-enable"));

    expect((await screen.findByTestId("loop-error")).textContent).toContain(
      "Database unavailable",
    );
  });
});

describe("LoopControlTile run monitoring", () => {
  it("starts an enabled loop on demand", async () => {
    const configured = snapshot({ spec: loopSpec() });
    const { backend } = setup(configured);
    const start = vi.spyOn(backend, "runWorkstreamLoopNow").mockResolvedValue(run());

    fireEvent.click(await screen.findByTestId("loop-run-now"));
    await waitFor(() => expect(start).toHaveBeenCalledWith("ws-1"));
  });

  it("leads with state and renders current task, evidence, and timeline", async () => {
    const verification: LoopVerificationRecord = {
      id: "verify-1",
      loopTaskId: "task-1",
      attempt: 1,
      status: "nonzero",
      program: "npm",
      args: ["test"],
      cwd: "/repo",
      exitCode: 1,
      durationMs: 1200,
      stdout: "12 tests passed",
      stderr: "1 test failed",
      truncated: false,
      createdAt: "2026-08-28T18:05:00.000Z",
    };
    const evaluation: LoopEvaluationRecord = {
      id: "evaluation-1",
      loopTaskId: "task-1",
      attempt: 1,
      verdict: "revise",
      summary: "Needs another pass",
      feedback: "Handle the timeout branch",
      evidence: ["unit tests", "verifier output"],
      createdAt: "2026-08-28T18:06:00.000Z",
    };
    const event: LoopEventRecord = {
      id: 7,
      loopSpecId: "loop-1",
      loopRunId: "run-1",
      loopTaskId: "task-1",
      eventType: "verification.finished",
      payload: { status: "nonzero" },
      createdAt: "2026-08-28T18:05:00.000Z",
    };
    setup(
      snapshot({
        spec: loopSpec(),
        latestRun: run(),
        tasks: [task()],
        verifications: [verification],
        evaluations: [evaluation],
        events: [event],
      }),
    );

    expect((await screen.findByTestId("loop-run-state")).textContent).toContain("Working");
    expect(screen.getByTestId("loop-elapsed").textContent).toMatch(/Elapsed/);
    expect(screen.getByTestId("loop-next-evidence").textContent).toContain("Verifier");
    expect(screen.getByTestId("loop-current-task").textContent).toContain(
      "Implement the domain",
    );
    expect(screen.getByTestId("loop-worker-result-task-1").textContent).toContain(
      "Implemented the state machine",
    );
    expect(screen.getByTestId("loop-verification-verify-1").textContent).toContain(
      "12 tests passed",
    );
    expect(screen.getByTestId("loop-verification-verify-1").textContent).toContain(
      "1 test failed",
    );
    expect(screen.getByTestId("loop-evaluation-evaluation-1").textContent).toContain(
      "Needs another pass",
    );
    expect(screen.getByTestId("loop-evaluation-evaluation-1").textContent).toContain(
      "Handle the timeout branch",
    );
    expect(screen.getByTestId("loop-event-7").textContent).toContain(
      "verification.finished",
    );
  });

  it("exposes distinct pause, stop, and kill controls", async () => {
    const running = snapshot({
      spec: loopSpec(),
      latestRun: run(),
      tasks: [task()],
    });
    const { backend } = setup(running);
    const control = vi.spyOn(backend, "controlWorkstreamLoop").mockResolvedValue();

    fireEvent.click(await screen.findByTestId("loop-pause"));
    await waitFor(() => expect(control).toHaveBeenCalledWith("run-1", "pause"));
    fireEvent.click(screen.getByTestId("loop-stop"));
    await waitFor(() => expect(control).toHaveBeenCalledWith("run-1", "stop"));
    fireEvent.click(screen.getByTestId("loop-kill"));
    await waitFor(() => expect(control).toHaveBeenCalledWith("run-1", "kill"));
  });

  it("resumes a paused run through the dedicated backend method", async () => {
    const pausedRun = run({ state: "paused" });
    const { backend } = setup(
      snapshot({ spec: loopSpec(), latestRun: pausedRun, tasks: [task()] }),
    );
    const resume = vi
      .spyOn(backend, "resumeWorkstreamLoop")
      .mockResolvedValue(run({ state: "working" }));

    fireEvent.click(await screen.findByTestId("loop-resume"));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("run-1"));
    expect(screen.queryByTestId("loop-pause")).toBeNull();
  });

  it("refreshes for matching memory and Tauri loop events", async () => {
    const { getSnapshot } = setup(snapshot({ spec: loopSpec() }));
    await screen.findByTestId("loop-config-readonly");
    const initialCalls = getSnapshot.mock.calls.length;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("memory-loop-updated", {
          detail: { workstreamId: "other" },
        }),
      );
    });
    expect(getSnapshot).toHaveBeenCalledTimes(initialCalls);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("memory-loop-updated", {
          detail: { workstreamId: "ws-1" },
        }),
      );
    });
    await waitFor(() => expect(getSnapshot.mock.calls.length).toBeGreaterThan(initialCalls));

    const tauriCall = listenMock.mock.calls.find(([name]) => name === "loop-updated");
    expect(tauriCall).toBeTruthy();
    const listener = tauriCall?.[1] as (event: {
      payload: { workstreamId: string };
    }) => void;
    const beforeTauri = getSnapshot.mock.calls.length;
    act(() => listener({ payload: { workstreamId: "ws-1" } }));
    await waitFor(() => expect(getSnapshot.mock.calls.length).toBeGreaterThan(beforeTauri));
  });

  it("polls snapshots while a run is nonterminal", async () => {
    const interval = vi.spyOn(window, "setInterval");
    setup(snapshot({ spec: loopSpec(), latestRun: run(), tasks: [task()] }));

    await screen.findByTestId("loop-run-state");
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it("surfaces run-control errors visibly", async () => {
    const { backend } = setup(
      snapshot({ spec: loopSpec(), latestRun: run(), tasks: [task()] }),
    );
    vi.spyOn(backend, "controlWorkstreamLoop").mockRejectedValue(
      new Error("Control rejected"),
    );

    fireEvent.click(await screen.findByTestId("loop-stop"));
    expect((await screen.findByTestId("loop-error")).textContent).toContain(
      "Control rejected",
    );
  });
});
