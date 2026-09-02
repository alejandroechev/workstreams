import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import {
  fileBufferRegistry,
  type BufferSnapshot,
} from "../../files/FileBufferRegistry";
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
vi.mock("../../files/FileEditorView", () => ({
  FileEditorView: ({
    path,
    onSnapshotChange,
  }: {
    path: string;
    onSnapshotChange?: (snapshot: BufferSnapshot | null) => void;
  }) => (
    <>
      <div data-testid="loop-definition-editor-path">{path}</div>
      <button
        data-testid="loop-definition-mark-dirty"
        onClick={() =>
          onSnapshotChange?.({
            path,
            state: "dirty",
            dirty: true,
            lineEnding: "lf",
            hasTrailingNewline: true,
            sniffedBinary: false,
            sizeBytes: 10,
          })
        }
      >
        Mark dirty
      </button>
    </>
  ),
}));

function definition(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: "frontend-loop",
    name: "Frontend loop",
    description: "Implements and verifies frontend changes.",
    tags: ["frontend", "fast"],
    path: "/sessions/session-1/files/loops/frontend-loop.loop.yaml",
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
    stages: [],
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
  it("switches between Run and Definitions and edits the selected YAML file", async () => {
    const first = definition();
    const second = definition({
      id: "backend-loop",
      name: "Backend loop",
      path: "/sessions/session-1/files/loops/backend-loop.loop.yaml",
    });

    setup(snapshot(), { definitions: [first, second], invalid: [] });

    expect(
      (await screen.findByTestId("loop-tab-run")).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("loop-tab-definitions"));
    expect(screen.getByTestId("loop-definition-editor-path").textContent).toBe(
      first.path,
    );

    fireEvent.click(screen.getByTestId("loop-edit-definition-backend-loop"));
    expect(screen.getByTestId("loop-definition-editor-path").textContent).toBe(
      second.path,
    );

    fireEvent.click(screen.getByTestId("loop-tab-run"));
    await waitFor(() =>
      expect(screen.getByTestId("loop-definition-selected").textContent).toContain(
        "Backend loop",
      ),
    );
  });

  it("saves and reparses dirty YAML before returning to Run", async () => {
    const second = definition({
      id: "second-loop",
      name: "Second loop",
      path: "/sessions/session-1/files/loops/second.loop.yaml",
    });
    const { listDefinitions } = setup(snapshot(), {
      definitions: [definition(), second],
      invalid: [],
    });
    const save = vi.spyOn(fileBufferRegistry, "save").mockResolvedValue();
    vi.spyOn(fileBufferRegistry, "listAll").mockReturnValue([
      {
        path: definition().path,
        state: "dirty",
        dirty: true,
        lineEnding: "lf",
        hasTrailingNewline: true,
        sniffedBinary: false,
        sizeBytes: 10,
      },
    ]);
    vi.spyOn(fileBufferRegistry, "getSnapshot")
      .mockReturnValueOnce({
        path: definition().path,
        state: "dirty",
        dirty: true,
        lineEnding: "lf",
        hasTrailingNewline: true,
        sniffedBinary: false,
        sizeBytes: 10,
      })
      .mockReturnValue({
        path: definition().path,
        state: "clean",
        dirty: false,
        lineEnding: "lf",
        hasTrailingNewline: true,
        sniffedBinary: false,
        sizeBytes: 10,
      });

    await screen.findByTestId("loop-definition-frontend-loop");
    fireEvent.click(screen.getByTestId("loop-tab-definitions"));
    fireEvent.click(screen.getByTestId("loop-definition-mark-dirty"));
    fireEvent.click(screen.getByTestId("loop-edit-definition-second-loop"));
    fireEvent.click(screen.getByTestId("loop-tab-run"));

    await waitFor(() => expect(save).toHaveBeenCalledWith(definition().path));
    await waitFor(() => expect(listDefinitions).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("loop-tab-run").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("loads definitions, selects the first, and retains selection on refresh", async () => {
    const evaluator = definition({
      id: "evaluated-loop",
      name: "Evaluated loop",
      path: "/sessions/session-1/files/loops/evaluated-loop.loop.yaml",
      hash: "sha256:evaluated",
      tags: ["quality"],
      objective: "Evaluate semantic correctness",
      hasVerification: false,
      hasEvaluator: true,
    });
    const both = definition({
      id: "full-loop",
      name: "Full loop",
      path: "/sessions/session-1/files/loops/full-loop.loop.yaml",
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
      "Goal Loop",
    );
    expect(listDefinitions).toHaveBeenCalledWith("ws-1");
    expect((await screen.findByTestId("loop-definition-evaluated-loop")).textContent).toContain(
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
      "/sessions/session-1/files/loops/full-loop.loop.yaml",
    );
    expect(screen.getByTestId("loop-definition-selected").textContent).toContain(
      "sha256:full",
    );

    setCatalog({
      definitions: [
        definition({
          id: "new-first",
          name: "New first",
          path: "/sessions/session-1/files/loops/new-first.loop.yaml",
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

  it("keeps Run selection aligned when the selected file changes definition id", async () => {
    const selectedPath = "/sessions/session-1/files/loops/selected.loop.yaml";
    const selected = definition({
      id: "old-id",
      name: "Selected loop",
      path: selectedPath,
    });
    const first = definition({
      id: "first-loop",
      name: "First loop",
      path: "/sessions/session-1/files/loops/first.loop.yaml",
    });
    const { setCatalog, listDefinitions } = setup(snapshot(), {
      definitions: [first, selected],
      invalid: [],
    });

    await screen.findByTestId("loop-definition-old-id");
    fireEvent.click(screen.getByTestId("loop-definition-old-id"));
    fireEvent.click(screen.getByTestId("loop-tab-definitions"));
    expect(screen.getByTestId("loop-definition-editor-path").textContent).toBe(
      selectedPath,
    );

    setCatalog({
      definitions: [
        first,
        definition({
          id: "new-id",
          name: "Renamed selected loop",
          path: selectedPath,
        }),
      ],
      invalid: [],
    });
    fireEvent.click(screen.getByTestId("loop-refresh"));
    await waitFor(() => expect(listDefinitions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("loop-tab-run"));

    await waitFor(() =>
      expect(screen.getByTestId("loop-definition-selected").textContent).toContain(
        "Renamed selected loop",
      ),
    );
  });

  it("runs the selected definition by path instead of using the legacy run method", async () => {
    const first = definition();
    const second = definition({
      id: "backend-loop",
      name: "Backend loop",
      path: "/sessions/session-1/files/loops/backend-loop.loop.yaml",
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
        "/sessions/session-1/files/loops/backend-loop.loop.yaml",
      ),
    );
    expect(legacyRun).not.toHaveBeenCalled();
  });

  it("shows the YAML authoring empty state without form fields", async () => {
    setup(snapshot());

    const empty = await screen.findByTestId("loop-definition-empty");
    expect(empty.textContent).toContain("files/loops/<id>.loop.yaml");
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
          path: "/sessions/session-1/files/loops/broken.loop.yaml",
          error: "missing required field objective",
        },
      ],
    });

    expect(
      (await screen.findByTestId("loop-definition-frontend-loop")).textContent,
    ).toContain("Not portable");
    const invalid = screen.getByTestId("loop-invalid-definitions");
    expect(invalid.textContent).toContain(
      "/sessions/session-1/files/loops/broken.loop.yaml",
    );
    expect(invalid.textContent).toContain("missing required field objective");

    fireEvent.click(screen.getByTestId("loop-tab-definitions"));
    fireEvent.click(screen.getByTestId("loop-edit-invalid-0"));
    expect(screen.getByTestId("loop-definition-editor-path").textContent).toBe(
      "/sessions/session-1/files/loops/broken.loop.yaml",
    );
    expect(screen.getByTestId("loop-definition-editor-header").textContent).toContain(
      "missing required field objective",
    );
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
      definitionPath: "/sessions/session-1/files/loops/frontend-loop.loop.yaml",
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
        stages: [
          {
            id: "stage-orch",
            loopRunId: "run-1",
            role: "orchestrator",
            attempt: 1,
            status: "completed",
            startedAt: "2026-08-28T18:00:00.000Z",
            finishedAt: "2026-08-28T18:00:30.000Z",
            durationMs: 30_000,
          },
          {
            id: "stage-worker",
            loopRunId: "run-1",
            loopTaskId: "task-1",
            role: "worker",
            attempt: 1,
            status: "completed",
            startedAt: "2026-08-28T18:00:30.000Z",
            finishedAt: "2026-08-28T18:04:30.000Z",
            durationMs: 240_000,
          },
        ],
        events: [event],
      }),
      { definitions: [definition()], invalid: [] },
    );
    const control = vi.spyOn(backend, "controlWorkstreamLoop").mockResolvedValue();

    expect((await screen.findByTestId("loop-run-state")).textContent).toContain("Working");
    const breakdown = screen.getByTestId("loop-time-breakdown");
    expect(breakdown.textContent).toContain("Agent time: 4m 30s");
    expect(breakdown.textContent).toContain("worker 4m 0s");
    expect(breakdown.textContent).toContain("orchestrator 30s");
    expect(screen.getByTestId("loop-slowest-stage").textContent).toContain("worker #1");

    const definitionDisclosure = screen.getByTestId(
      "loop-run-definition",
    ) as HTMLDetailsElement;
    expect(definitionDisclosure.open).toBe(false);
    expect(definitionDisclosure.textContent).toContain("Frontend loop");
    expect(definitionDisclosure.textContent).not.toContain("Deliver the pinned objective");
    fireEvent.click(definitionDisclosure.querySelector("summary")!);
    expect(screen.getByTestId("loop-run-definition").textContent).toContain(
      "sha256:pinned",
    );
    expect(screen.getByTestId("loop-run-definition").textContent).toContain(
      "Deliver the pinned objective",
    );

    const currentTask = screen.getByTestId("loop-current-task");
    expect(currentTask.textContent).toContain("Implement the domain");
    expect(currentTask.textContent).toContain("Worker running");
    expect(screen.getByTestId("loop-current-task-duration").textContent).toContain(
      "4m 0s",
    );
    expect(currentTask.textContent).not.toContain("Build the requested behavior");

    const taskList = screen.getByTestId("loop-task-list") as HTMLDetailsElement;
    expect(taskList.open).toBe(false);
    fireEvent.click(taskList.querySelector("summary")!);
    expect(screen.getByTestId("loop-task-duration-task-1").textContent).toContain(
      "4m 0s",
    );
    const details = screen.getByTestId("loop-task-details-task-1") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByTestId("loop-task-status-task-1").textContent).toContain(
      "Worker is implementing the task",
    );
    expect(screen.queryByTestId("loop-worker-result-task-1")).toBeNull();
    fireEvent.click(screen.getByText("Details"));
    expect(
      screen.getByTestId("loop-task-stage-timings-task-1").textContent,
    ).toContain("worker #1: 4m 0s");
    expect(screen.getByTestId("loop-worker-result-task-1").textContent).toContain(
      "Implemented the state machine",
    );
    expect(screen.getByTestId("loop-verification-verify-1").textContent).toContain(
      "12 tests passed",
    );
    expect(screen.getByTestId("loop-evaluation-evaluation-1").textContent).toContain(
      "Needs another pass",
    );
    const timeline = screen.getByTestId("loop-event-timeline") as HTMLDetailsElement;
    expect(timeline.open).toBe(false);
    expect(screen.queryByTestId("loop-event-7")).toBeNull();
    fireEvent.click(screen.getByTestId("loop-event-timeline").querySelector("summary")!);
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

  it("parses worker JSON and foregrounds only the latest evaluator request", async () => {
    setup(
      snapshot({
        spec: loopSpec(),
        latestRun: run({
          state: "attention",
          activeTaskId: null,
          error: "One or more tasks require human attention",
        }),
        tasks: [
          task({
            state: "attention",
            revisionCount: 1,
            workerResult: JSON.stringify({
              status: "completed",
              summary: "Applied the requested spelling corrections",
              evidence: ["British spelling scan is clean"],
            }),
          }),
        ],
        evaluations: [
          {
            id: "evaluation-1",
            loopTaskId: "task-1",
            attempt: 1,
            verdict: "revise",
            summary: "Several corrections are needed",
            feedback: "Fix many earlier issues",
            evidence: [],
            createdAt: "2026-08-28T18:06:00.000Z",
          },
          {
            id: "evaluation-2",
            loopTaskId: "task-1",
            attempt: 2,
            verdict: "revise",
            summary: "One spelling remains",
            feedback: "Change analysing to analyzing at line 145.",
            evidence: [],
            createdAt: "2026-08-28T18:09:00.000Z",
          },
        ],
      }),
      { definitions: [definition()], invalid: [] },
    );

    const status = await screen.findByTestId("loop-task-status-task-1");
    expect(status.textContent).toContain("Action required");
    expect(status.textContent).toContain("Change analysing to analyzing at line 145.");
    expect(status.textContent).toContain("Automatic revisions exhausted");
    expect(status.textContent).not.toContain("Fix many earlier issues");
    expect(
      screen.queryByText("One or more tasks require human attention"),
    ).toBeNull();
    expect(screen.queryByText("No active task")).toBeNull();

    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByTestId("loop-worker-summary-task-1").textContent).toContain(
      "Applied the requested spelling corrections",
    );
    expect(screen.getByTestId("loop-worker-evidence-task-1").textContent).toContain(
      "British spelling scan is clean",
    );
    expect(screen.getByTestId("loop-evaluation-evaluation-1")).toBeTruthy();
    expect(screen.getByTestId("loop-evaluation-evaluation-2")).toBeTruthy();
  });

  it("foregrounds a newer verifier failure instead of stale evaluator feedback", async () => {
    setup(
      snapshot({
        spec: loopSpec(),
        latestRun: run({
          state: "attention",
          activeTaskId: null,
          error: "One or more tasks require human attention",
        }),
        tasks: [task({ state: "attention", revisionCount: 1 })],
        verifications: [
          {
            id: "verification-2",
            loopTaskId: "task-1",
            attempt: 2,
            status: "nonzero",
            program: "npm",
            args: ["test"],
            exitCode: 1,
            durationMs: 10,
            stdout: "",
            stderr: "Translation validation still fails",
            truncated: false,
            createdAt: "2026-08-28T18:10:00.000Z",
          },
        ],
        evaluations: [
          {
            id: "evaluation-1",
            loopTaskId: "task-1",
            attempt: 1,
            verdict: "revise",
            summary: "Old evaluator summary",
            feedback: "Old evaluator feedback",
            evidence: [],
            createdAt: "2026-08-28T18:06:00.000Z",
          },
        ],
      }),
      { definitions: [definition()], invalid: [] },
    );

    const status = await screen.findByTestId("loop-task-status-task-1");
    expect(status.textContent).toContain("Translation validation still fails");
    expect(status.textContent).not.toContain("Old evaluator feedback");
  });

  it("bounds verifier previews and prioritizes a current task error", async () => {
    const noisy = `First failure line\n${"x".repeat(2_000)}`;
    const { setSnapshot } = setup(
      snapshot({
        spec: loopSpec(),
        latestRun: run({ state: "attention", activeTaskId: null }),
        tasks: [task({ state: "attention", error: "Human reviewer rejected the task" })],
        evaluations: [
          {
            id: "evaluation-1",
            loopTaskId: "task-1",
            attempt: 1,
            verdict: "accepted",
            summary: "Earlier evaluation",
            feedback: "Older evaluator note",
            evidence: [],
            createdAt: "2026-08-28T18:06:00.000Z",
          },
        ],
      }),
      { definitions: [definition()], invalid: [] },
    );

    let status = await screen.findByTestId("loop-task-status-task-1");
    expect(status.textContent).toContain("Human reviewer rejected the task");
    expect(status.textContent).not.toContain("Older evaluator note");

    setSnapshot(
      snapshot({
        spec: loopSpec(),
        latestRun: run({ state: "attention", activeTaskId: null }),
        tasks: [task({ state: "attention", revisionCount: 1, error: undefined })],
        verifications: [
          {
            id: "verification-2",
            loopTaskId: "task-1",
            attempt: 2,
            status: "nonzero",
            program: "npm",
            args: ["test"],
            exitCode: 1,
            durationMs: 10,
            stdout: "",
            stderr: noisy,
            truncated: true,
            createdAt: "2026-08-28T18:10:00.000Z",
          },
        ],
      }),
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("memory-loop-updated", {
          detail: { workstreamId: "ws-1" },
        }),
      );
    });
    status = await screen.findByTestId("loop-task-status-task-1");
    await waitFor(() => expect(status.textContent).toContain("First failure line"));
    expect(status.textContent?.length).toBeLessThan(600);
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

  it("collapses long task results and supports sorting and filtering", async () => {
    const longSummary = `Accepted after independent verification. ${"Detail sentence. ".repeat(
      30,
    )}`;
    setup(
      snapshot({
        spec: loopSpec(),
        latestRun: run({ state: "working", activeTaskId: "task-new" }),
        tasks: [
          task({
            id: "task-old",
            key: "spec:core",
            title: "Older accepted task",
            state: "accepted",
            createdAt: "2026-09-02T10:00:00.000Z",
            workerResult: JSON.stringify({
              status: "completed",
              summary: longSummary,
              evidence: [],
            }),
          }),
          task({
            id: "task-new",
            key: "domain:alu",
            title: "Newer working task",
            state: "working",
            createdAt: "2026-09-02T12:00:00.000Z",
          }),
        ],
      }),
      { definitions: [definition()], invalid: [] },
    );

    const list = (await screen.findByTestId("loop-task-list")) as HTMLDetailsElement;
    fireEvent.click(list.querySelector("summary")!);

    const order = () =>
      Array.from(document.querySelectorAll('article[data-testid^="loop-task-"]')).map(
        (card) => card.getAttribute("data-testid"),
      );
    expect(order()).toEqual(["loop-task-task-new", "loop-task-task-old"]);

    const message = screen.getByTestId("loop-task-message-task-old") as HTMLDetailsElement;
    expect(message.open).toBe(false);
    expect(message.textContent).toContain("…");
    expect(message.textContent!.length).toBeLessThan(longSummary.length);
    fireEvent.click(message.querySelector("summary")!);
    expect(screen.getByTestId("loop-task-message-task-old").textContent).toContain(
      "Detail sentence.",
    );

    fireEvent.click(screen.getByTestId("loop-task-sort"));
    expect(order()).toEqual(["loop-task-task-old", "loop-task-task-new"]);

    fireEvent.change(screen.getByTestId("loop-task-filter"), {
      target: { value: "accepted" },
    });
    expect(order()).toEqual(["loop-task-task-old"]);

    fireEvent.change(screen.getByTestId("loop-task-filter"), {
      target: { value: "attention" },
    });
    expect(order()).toEqual([]);
    expect(screen.getByTestId("loop-task-empty").textContent).toContain(
      "No tasks match this filter",
    );
  });

  it("uses the configured attempt budget for human revision availability", async () => {
    setup(
      snapshot({
        spec: loopSpec({
          maxTaskIterations: 4,
          humanApproval: { prompt: "Review the evidence." },
        }),
        latestRun: run({ state: "awaiting_approval" }),
        tasks: [task({ state: "awaiting_approval", revisionCount: 2 })],
        approvals: [approval({ attempt: 3 })],
      }),
      {
        definitions: [definition({ hasHumanApproval: true })],
        invalid: [],
      },
    );

    expect(await screen.findByTestId("loop-approval-revise")).toBeTruthy();
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
