import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import type {
  LoopDefinition,
  LoopDefinitionCatalog,
  LoopApprovalRecord,
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

function definition(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: "frontend-loop",
    name: "Frontend loop",
    description: "Implements and verifies frontend changes.",
    tags: ["frontend", "fast"],
    path: "/repo/.workstreams/loops/frontend-loop.loop.yaml",
    hash: "sha256:frontend",
    portable: true,
    objective: "Deliver the selected frontend behavior",
    hasVerification: true,
    hasEvaluator: false,
    hasHumanApproval: false,
    ...overrides,
  };
}

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
    approvals: [],
    events: [],
    ...overrides,
  };
}

function approval(overrides: Partial<LoopApprovalRecord> = {}): LoopApprovalRecord {
  return {
    id: "approval-1",
    loopTaskId: "task-1",
    attempt: 1,
    status: "pending",
    prompt: "Review the implementation and evidence.",
    createdAt: "2026-08-28T18:07:00.000Z",
    ...overrides,
  };
}

function setup(
  initialSnapshot: PersistedLoopSnapshot,
  initialCatalog: LoopDefinitionCatalog = { definitions: [], invalid: [] },
) {
  const backend = new MemoryBackend();
  let currentSnapshot = initialSnapshot;
  let currentCatalog = initialCatalog;
  const getSnapshot = vi
    .spyOn(backend, "getWorkstreamLoopSnapshot")
    .mockImplementation(async () => currentSnapshot);
  const listDefinitions = vi
    .spyOn(backend, "listLoopDefinitions")
    .mockImplementation(async () => currentCatalog);

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

  return {
    backend,
    getSnapshot,
    listDefinitions,
    setSnapshot(next: PersistedLoopSnapshot) {
      currentSnapshot = next;
    },
    setCatalog(next: LoopDefinitionCatalog) {
      currentCatalog = next;
    },
  };
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

describe("LoopControlTile catalog", () => {
  it("loads definitions, selects the first, and retains selection on refresh", async () => {
    const evaluator = definition({
      id: "evaluated-loop",
      name: "Evaluated loop",
      path: "/repo/.workstreams/loops/evaluated-loop.loop.yaml",
      hash: "sha256:evaluated",
      tags: ["quality"],
      objective: "Evaluate semantic correctness",
      hasVerification: false,
      hasEvaluator: true,
    });
    const both = definition({
      id: "full-loop",
      name: "Full loop",
      path: "/repo/.workstreams/loops/full-loop.loop.yaml",
      hash: "sha256:full",
      tags: ["frontend", "quality"],
      objective: "Verify and evaluate the result",
      hasEvaluator: true,
    });
    const { listDefinitions, setCatalog } = setup(
      snapshot(),
      { definitions: [evaluator, both], invalid: [] },
    );

    expect((await screen.findByTestId("loop-catalog")).textContent).toContain(
      "Loop catalog",
    );
    expect(listDefinitions).toHaveBeenCalledWith("/repo");
    expect(screen.getByTestId("loop-definition-evaluated-loop").textContent).toContain(
      "Evaluator",
    );
    expect(screen.getByTestId("loop-definition-full-loop").textContent).toContain(
      "Verification + Evaluator",
    );
    expect(screen.getByTestId("loop-definition-selected").textContent).toContain(
      "Evaluated loop",
    );

    fireEvent.click(screen.getByTestId("loop-definition-full-loop"));
    expect(screen.getByTestId("loop-definition-selected").textContent).toContain(
      "Full loop",
    );
    expect(screen.getByTestId("loop-definition-selected").textContent).toContain(
      "/repo/.workstreams/loops/full-loop.loop.yaml",
    );
    expect(screen.getByTestId("loop-definition-selected").textContent).toContain(
      "sha256:full",
    );

    setCatalog({
      definitions: [
        definition({
          id: "new-first",
          name: "New first",
          path: "/repo/.workstreams/loops/new-first.loop.yaml",
        }),
        both,
      ],
      invalid: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(listDefinitions).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("loop-definition-selected").textContent).toContain(
      "Full loop",
    );
  });

  it("runs the selected definition by path instead of using the legacy run method", async () => {
    const first = definition();
    const second = definition({
      id: "backend-loop",
      name: "Backend loop",
      path: "/repo/.workstreams/loops/backend-loop.loop.yaml",
      hash: "sha256:backend",
    });
    const { backend } = setup(
      snapshot(),
      { definitions: [first, second], invalid: [] },
    );
    const runSelected = vi
      .spyOn(backend, "runLoopDefinitionNow")
      .mockResolvedValue(run());
    const legacyRun = vi.spyOn(backend, "runWorkstreamLoopNow");

    await screen.findByTestId("loop-definition-selected");
    fireEvent.click(screen.getByTestId("loop-definition-backend-loop"));
    fireEvent.click(screen.getByTestId("loop-run-selected"));

    await waitFor(() =>
      expect(runSelected).toHaveBeenCalledWith(
        "ws-1",
        "/repo/.workstreams/loops/backend-loop.loop.yaml",
      ),
    );
    expect(legacyRun).not.toHaveBeenCalled();
  });

  it("shows the YAML authoring empty state without form fields", async () => {
    setup(snapshot());

    const empty = await screen.findByTestId("loop-definition-empty");
    expect(empty.textContent).toContain(".workstreams/loops/<id>.loop.yaml");
    expect(empty.textContent).toContain("create-loop");
    expect(screen.queryByTestId("loop-setup-form")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders invalid files separately and warns when a definition is not portable", async () => {
    setup(snapshot(), {
      definitions: [
        definition({
          portable: false,
          objective: "Use machine-specific verifier paths",
        }),
      ],
      invalid: [
        {
          path: "/repo/.workstreams/loops/broken.loop.yaml",
          error: "missing required field objective",
        },
      ],
    });

    expect(
      (await screen.findByTestId("loop-definition-frontend-loop")).textContent,
    ).toContain("Not portable");
    const invalid = screen.getByTestId("loop-invalid-definitions");
    expect(invalid.textContent).toContain(
      "/repo/.workstreams/loops/broken.loop.yaml",
    );
    expect(invalid.textContent).toContain("missing required field objective");
  });

  it("disables running a definition while a nonterminal run exists", async () => {
    setup(
      snapshot({
        spec: loopSpec(),
        latestRun: run(),
        tasks: [task()],
      }),
      { definitions: [definition()], invalid: [] },
    );

    expect(
      (await screen.findByTestId("loop-run-selected") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("LoopControlTile run monitoring", () => {
  it("renders pinned definition evidence, task output, controls, and the timeline", async () => {
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
    const pinnedSpec = loopSpec({
      definitionId: "frontend-loop",
      definitionPath: "/repo/.workstreams/loops/frontend-loop.loop.yaml",
      definitionHash: "sha256:pinned",
      definitionName: "Frontend loop",
      objective: "Deliver the pinned objective",
    });
    const { backend } = setup(
      snapshot({
        spec: pinnedSpec,
        latestRun: run({ definitionHash: "sha256:pinned" }),
        tasks: [task()],
        verifications: [verification],
        evaluations: [evaluation],
        events: [event],
      }),
      { definitions: [definition()], invalid: [] },
    );
    const control = vi.spyOn(backend, "controlWorkstreamLoop").mockResolvedValue();

    expect((await screen.findByTestId("loop-run-state")).textContent).toContain("Working");
    expect(screen.getByTestId("loop-run-definition").textContent).toContain(
      "Frontend loop",
    );
    expect(screen.getByTestId("loop-run-definition").textContent).toContain(
      "sha256:pinned",
    );
    expect(screen.getByTestId("loop-run-definition").textContent).toContain(
      "Deliver the pinned objective",
    );
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
    expect(screen.getByTestId("loop-event-7").textContent).toContain(
      "verification.finished",
    );

    fireEvent.click(screen.getByTestId("loop-pause"));
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
      { definitions: [definition()], invalid: [] },
    );
    const resume = vi
      .spyOn(backend, "resumeWorkstreamLoop")
      .mockResolvedValue(run({ state: "working" }));

    fireEvent.click(await screen.findByTestId("loop-resume"));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("run-1"));
    expect(screen.queryByTestId("loop-pause")).toBeNull();
  });

  it("surfaces pending human approval and sends all three decisions", async () => {
    const awaitingRun = run({ state: "awaiting_approval" });
    const { backend } = setup(
      snapshot({
        spec: loopSpec({
          humanApproval: { prompt: "Review the implementation and evidence." },
        }),
        latestRun: awaitingRun,
        tasks: [task({ state: "awaiting_approval" })],
        approvals: [approval()],
      }),
      {
        definitions: [
          definition({
            hasHumanApproval: true,
          }),
        ],
        invalid: [],
      },
    );
    const decide = vi
      .spyOn(backend, "decideLoopHumanApproval")
      .mockResolvedValue(awaitingRun);

    expect((await screen.findByTestId("loop-human-approval")).textContent).toContain(
      "Review the implementation and evidence.",
    );
    expect(screen.queryByTestId("loop-pause")).toBeNull();
    expect(screen.getByTestId("loop-stop")).toBeTruthy();
    expect(screen.getByTestId("loop-kill")).toBeTruthy();
    fireEvent.click(screen.getByTestId("loop-approval-approve"));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith("run-1", "approve", undefined),
    );

    fireEvent.change(screen.getByLabelText("Human review feedback"), {
      target: { value: "Add the missing timeout case" },
    });
    fireEvent.click(screen.getByTestId("loop-approval-revise"));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        "run-1",
        "revise",
        "Add the missing timeout case",
      ),
    );
    fireEvent.click(screen.getByTestId("loop-approval-reject"));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        "run-1",
        "reject",
        "Add the missing timeout case",
      ),
    );
  });

  it.each([
    {
      label: "verifier",
      spec: loopSpec({ evaluator: undefined }),
      expected: "Verifier is next",
    },
    {
      label: "evaluator",
      spec: loopSpec({ verifier: undefined }),
      expected: "Evaluator is next",
    },
    {
      label: "completion",
      spec: loopSpec({ verifier: undefined, evaluator: undefined }),
      expected: "Completion is next",
    },
  ])("projects the next evidence for $label-only definitions", async ({ spec, expected }) => {
    setup(
      snapshot({ spec, latestRun: run(), tasks: [task()] }),
      { definitions: [definition()], invalid: [] },
    );

    expect((await screen.findByTestId("loop-next-evidence")).textContent).toContain(
      expected,
    );
  });

  it("refreshes the run projection for matching memory and Tauri events", async () => {
    const { getSnapshot } = setup(
      snapshot({ spec: loopSpec() }),
      { definitions: [definition()], invalid: [] },
    );
    await screen.findByTestId("loop-catalog");
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

  it("polls a lightweight version and reloads evidence only when it changes", async () => {
    vi.useFakeTimers();
    const { backend, getSnapshot, listDefinitions } = setup(
      snapshot({ spec: loopSpec(), latestRun: run(), tasks: [task()] }),
      { definitions: [definition()], invalid: [] },
    );
    const progress = vi
      .spyOn(backend, "getWorkstreamLoopProgressVersion")
      .mockResolvedValue("version-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initialLoads = getSnapshot.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(getSnapshot.mock.calls.length).toBe(initialLoads + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(getSnapshot.mock.calls.length).toBe(initialLoads + 1);
    expect(listDefinitions).toHaveBeenCalledTimes(1);
  });
});
