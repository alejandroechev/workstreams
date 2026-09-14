import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { BackendProvider } from "../backend/context";
import type { Backend } from "../backend/types";
import type {
  Project,
  Tile,
  Workstream,
  WorkstreamLayout,
} from "../domain/types";
import { getCurrentWindow } from "@tauri-apps/api/window";

const mocks = vi.hoisted(() => {
  let closeHandler:
    ((event: { preventDefault: () => void }) => void | Promise<void>) | null =
    null;
  let tileCreatedHandler: ((event: { payload: unknown }) => void) | null = null;
  const unlisten = vi.fn();
  const destroy = vi.fn();
  const onCloseRequested = vi.fn(
    async (
      handler: (event: { preventDefault: () => void }) => void | Promise<void>,
    ) => {
      closeHandler = handler;
      return unlisten;
    },
  );
  let stateChangedHandler: ((event: { payload: unknown }) => void) | null =
    null;
  const eventListen = vi.fn(
    async (
      eventName: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      if (eventName === "tile-created") tileCreatedHandler = handler;
      if (eventName === "state-changed") stateChangedHandler = handler;
      return () => {
        if (eventName === "tile-created") tileCreatedHandler = null;
      };
    },
  );

  return {
    invoke: vi.fn(async (..._args: unknown[]) => null as unknown),
    listAll: vi.fn<() => Array<{ path: string; dirty: boolean }>>(() => []),
    getCloseHandler: () => closeHandler,
    resetCloseHandler: () => {
      closeHandler = null;
    },
    emitTileCreated: (tile: unknown) => {
      tileCreatedHandler?.({ payload: tile });
    },
    emitStateChanged: (change: unknown) => {
      stateChangedHandler?.({ payload: change });
    },
    hasStateChangedListener: () => stateChangedHandler !== null,
    resetTileCreatedHandler: () => {
      tileCreatedHandler = null;
    },
    unlisten,
    destroy,
    onCloseRequested,
    eventListen,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onCloseRequested: mocks.onCloseRequested,
    destroy: mocks.destroy,
  })),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.eventListen }));
vi.mock("../files/FileBufferRegistry", () => ({
  fileBufferRegistry: { listAll: mocks.listAll },
}));

vi.mock("../workstream/WorkstreamSidebar", () => ({
  default: ({
    workstreams,
    activeWsId,
    onSelectWorkstream,
    onArchiveWorkstream,
  }: {
    workstreams: Workstream[];
    activeWsId: string | null;
    onSelectWorkstream: (id: string) => void;
    onArchiveWorkstream: (id: string) => void;
  }) => (
    <aside>
      {workstreams.map((ws) => (
        <div key={ws.id}>
          <button
            data-testid="workstream-item"
            data-workstream-id={ws.id}
            data-active={ws.id === activeWsId ? "true" : "false"}
            onClick={() => onSelectWorkstream(ws.id)}
          >
            {ws.name}
          </button>
          <button
            data-testid={`archive-${ws.id}`}
            onClick={() => onArchiveWorkstream(ws.id)}
          >
            Archive
          </button>
        </div>
      ))}
    </aside>
  ),
}));
vi.mock("../tiling/TileGrid", () => ({
  default: () => <main data-testid="tile-grid" />,
}));
vi.mock("../tiling/StatusBar", () => ({
  default: () => <div data-testid="status-bar" />,
}));
vi.mock("../tiles/SessionPicker", () => ({ default: () => null }));
vi.mock("../ui/SettingsModal", () => ({ default: () => null }));
vi.mock("../workstream/ProjectCreateForm", () => ({ default: () => null }));
vi.mock("../workstream/RepoCreateForm", () => ({ default: () => null }));
vi.mock("../workstream/WorkstreamCreateForm", () => ({ default: () => null }));
vi.mock("../workstream/ForkWorkstreamForm", () => ({ default: () => null }));

const now = "2026-05-25T00:00:00.000Z";
const workstreams: Workstream[] = [
  {
    id: "ws-1",
    name: "One",
    description: null,
    directory: "C:\\repo\\one",
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: null,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: now,
    updated_at: now,
  },
  {
    id: "ws-2",
    name: "Two",
    description: null,
    directory: "C:\\repo\\two",
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: null,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: now,
    updated_at: now,
  },
];

function createBackend(): Backend {
  const layouts = new Map<string, WorkstreamLayout>(
    workstreams.map((ws) => [
      ws.id,
      {
        workstream_id: ws.id,
        layout_mode: "auto",
        focused_tile_id: null,
        fullscreen_tile_id: null,
        tile_order_json: "[]",
        updated_at: now,
      },
    ]),
  );

  return {
    exportDevlogDay: vi.fn(),
    listTasks: vi.fn(async () => []),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    listLabels: vi.fn(async () => []),
    setTaskLabels: vi.fn(async () => []),
    createSubtask: vi.fn(),
    updateSubtask: vi.fn(),
    deleteSubtask: vi.fn(),
    listTaskEvents: vi.fn(async () => []),
    addTaskEvent: vi.fn(),
    deleteTaskEvent: vi.fn(),
    listProjects: vi.fn(async (): Promise<Project[]> => []),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    listWorkstreams: vi.fn(async () => workstreams),
    createWorkstream: vi.fn(),
    updateWorkstream: vi.fn(async () => undefined),
    deleteWorkstream: vi.fn(),
    changeWorkstreamWorktree: vi.fn(),
    listTiles: vi.fn(async (): Promise<Tile[]> => []),
    createTile: vi.fn(),
    deleteTile: vi.fn(),
    updateTileConfig: vi.fn(),
    // Falls back to an empty layout rather than undefined: a workstream the
    // fixture never registered (an archived one being opened, say) would
    // otherwise crash the caller on `layout.tile_order_json`.
    getLayout: vi.fn(async (workstreamId: string) =>
      layouts.get(workstreamId) ?? {
        workstream_id: workstreamId,
        layout_mode: "adaptive",
        focused_tile_id: null,
        fullscreen_tile_id: null,
        tile_order_json: "[]",
        updated_at: now,
      },
    ),
    updateLayout: vi.fn(),
    readFile: vi.fn(),
    listDirectory: vi.fn(),
    createFile: vi.fn(),
    createDirectory: vi.fn(),
    detectGitInfo: vi.fn(),
    spawnTerminal: vi.fn(),
    spawnCopilotSession: vi.fn(),
    writeToTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    getWorkstreamLoopSnapshot: vi.fn(async () => ({
      spec: null,
      latestRun: null,
      tasks: [],
      verifications: [],
      evaluations: [],
      approvals: [],
      stages: [],
      events: [],
    })),
    getWorkstreamLoopProgressVersion: vi.fn(async () => "unconfigured"),
    listWorkstreamLoopRuns: vi.fn(async () => []),
    getLoopRunSnapshot: vi.fn(async () => ({
      spec: null,
      latestRun: null,
      tasks: [],
      verifications: [],
      evaluations: [],
      approvals: [],
      stages: [],
      events: [],
    })),
    listLoopDefinitions: vi.fn(async () => ({ definitions: [], invalid: [] })),
    saveWorkstreamLoop: vi.fn(),
    setWorkstreamLoopEnabled: vi.fn(),
    listWorkstreamLoopSummaries: vi.fn(async () => []),
    runWorkstreamLoopNow: vi.fn(),
    runLoopDefinitionNow: vi.fn(),
    decideLoopHumanApproval: vi.fn(),
    resumeWorkstreamLoop: vi.fn(),
    controlWorkstreamLoop: vi.fn(),
    saveScrollback: vi.fn(),
    loadScrollback: vi.fn(),
    watchSession: vi.fn(),
    unwatchSession: vi.fn(),
    searchFiles: vi.fn(),
    searchInFiles: vi.fn(),
    cancelSearches: vi.fn(),
    gitDiffFiles: vi.fn(),
    gitDiffFile: vi.fn(),
    gitDiffFilesWithStatus: vi.fn(async () => []),
    gitDiffFileSides: vi.fn(async () => ({ before: "", after: "" })),
    gitLog: vi.fn(),
    gitShowCommit: vi.fn(),
    gitCurrentBranch: vi.fn(),
    gitListBranches: vi.fn(async () => ["main"]),
    gitBranchTrackingInfo: vi.fn(async () => ({
      ahead: 0,
      behind: 0,
      remoteHeadShort: "",
    })),
    discoverCopilotConfig: vi.fn(),
    listSessionPlans: vi.fn(),
    getCurrentSessionPlan: vi.fn(),
    listSessionTodoDeps: vi.fn(),
    listSessionTodos: vi.fn(),
    listSessionFeatures: vi.fn(async () => ({
      features: [],
      currentPlanId: null,
    })),
    completeSessionPlan: vi.fn(),
    watchSessionFeatures: vi.fn(),
    unwatchSessionFeatures: vi.fn(),
    listSessionFileComments: vi.fn(async () => []),
    listAllSessionFileComments: vi.fn(async () => []),
    addSessionFileComment: vi.fn(),
    replySessionFileComment: vi.fn(),
    updateSessionFileComment: vi.fn(),
    setSessionFileCommentStatus: vi.fn(),
    deleteSessionFileCommentThread: vi.fn(),
    deleteSessionFileComment: vi.fn(),
    resolveWorkstreamSession: vi.fn().mockResolvedValue(null),
    codeReviewDiffFiles: vi.fn().mockResolvedValue([]),
    codeReviewDiffFileSides: vi
      .fn()
      .mockResolvedValue({ before: "", after: "" }),
    createReview: vi.fn(),
    getActiveReview: vi.fn().mockResolvedValue(null),
    listReviews: vi.fn().mockResolvedValue([]),
    addReviewComment: vi.fn(),
    listReviewComments: vi.fn().mockResolvedValue([]),
    setReviewCommentStatus: vi.fn(),
    completeCodeReview: vi.fn(),
    listCodeTraces: vi.fn(async () => []),
    getCodeTrace: vi.fn(async () => null),
    deleteCodeTrace: vi.fn(),
    indexCodeTrace: vi.fn(),
    readCodeTraceFile: vi.fn(),
    traceStaleness: vi.fn(async () => "fresh" as const),
    listRustTests: vi.fn(async () => []),
    recordCodeTrace: vi.fn(async () => "/t.json"),
    listWorkLanes: vi.fn(async () => []),
    createWorkLane: vi.fn(),
    renameWorkLane: vi.fn(),
    deleteWorkLane: vi.fn(),
    assignWorkstreamLane: vi.fn(),
  } as Backend;
}

async function renderApp(backend = createBackend()) {
  render(
    <BackendProvider backend={backend}>
      <App />
    </BackendProvider>,
  );
  await screen.findByText("One");
  return backend;
}

beforeEach(() => {
  mocks.listAll.mockReturnValue([]);
  mocks.invoke.mockResolvedValue(null);
  mocks.destroy.mockClear();
  mocks.onCloseRequested.mockClear();
  mocks.unlisten.mockClear();
  mocks.resetCloseHandler();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dirty file buffer close confirmations", () => {
  it("switches workstreams without confirming when no buffers are dirty", async () => {
    await renderApp();

    fireEvent.click(screen.getByText("Two"));

    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText("Two")).toHaveAttribute("data-active", "true"),
    );
  });

  it("confirms and switches workstreams when dirty buffers are discarded", async () => {
    mocks.listAll.mockReturnValue([
      { path: "C:\\repo\\one\\file.ts", dirty: true },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderApp();

    fireEvent.click(screen.getByText("Two"));

    expect(window.confirm).toHaveBeenCalledWith(
      "You have unsaved changes in 1 file(s). Discard and switch workstreams?",
    );
    await waitFor(() =>
      expect(screen.getByText("Two")).toHaveAttribute("data-active", "true"),
    );
  });

  it("blocks workstream switching when dirty buffer discard is canceled", async () => {
    mocks.listAll.mockReturnValue([
      { path: "C:\\repo\\one\\file.ts", dirty: true },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderApp();

    fireEvent.click(screen.getByText("Two"));

    expect(window.confirm).toHaveBeenCalledWith(
      "You have unsaved changes in 1 file(s). Discard and switch workstreams?",
    );
    expect(screen.getByText("One")).toHaveAttribute("data-active", "false");
    expect(screen.getByText("Two")).toHaveAttribute("data-active", "false");
  });

  it("does not auto-select any workstream on startup", async () => {
    await renderApp();
    await screen.findByText("One");
    expect(screen.getByText("One")).toHaveAttribute("data-active", "false");
    expect(screen.getByText("Two")).toHaveAttribute("data-active", "false");
  });

  it("confirms before archiving a workstream when buffers are dirty", async () => {
    mocks.listAll.mockReturnValue([
      { path: "C:\\repo\\one\\file.ts", dirty: true },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const backend = await renderApp();

    fireEvent.click(screen.getByTestId("archive-ws-1"));

    expect(window.confirm).toHaveBeenCalledWith(
      "You have unsaved changes in 1 file(s). Discard and archive workstream?",
    );
    expect(backend.updateWorkstream).not.toHaveBeenCalled();
  });

  it("opens the confirm-close dialog on close when no buffers are dirty and the pref is not disabled", async () => {
    await renderApp();
    const preventDefault = vi.fn();

    await mocks.getCloseHandler()?.({ preventDefault });

    expect(getCurrentWindow).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.confirm).not.toHaveBeenCalled();
    // The dialog is opened; destroy fires only after user confirms it.
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(await screen.findByTestId("confirm-close-dialog")).toBeTruthy();
    // User confirms.
    fireEvent.click(screen.getByTestId("confirm-close-confirm"));
    await waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce());
  });

  it("skips the confirm-close dialog and destroys immediately when the pref is disabled", async () => {
    mocks.invoke.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (
        cmd === "get_setting" &&
        (args as { key?: string } | undefined)?.key ===
          "app.confirm-close-disabled"
      ) {
        return "1";
      }
      return null;
    });
    await renderApp();
    const preventDefault = vi.fn();

    await mocks.getCloseHandler()?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-close-dialog")).toBeNull();
    await waitFor(() => expect(mocks.destroy).toHaveBeenCalledOnce());
  });

  it("prevents app quit and destroys the window when dirty buffers are discarded", async () => {
    mocks.listAll.mockReturnValue([
      { path: "C:\\repo\\one\\file.ts", dirty: true },
      { path: "C:\\repo\\one\\other.ts", dirty: true },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderApp();
    const preventDefault = vi.fn();

    await mocks.getCloseHandler()?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledWith(
      "You have unsaved changes in 2 file(s):\n\n  • C:\\repo\\one\\file.ts\n  • C:\\repo\\one\\other.ts\n\nClose anyway and discard?",
    );
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("prevents app quit without destroying the window when dirty buffer discard is canceled", async () => {
    mocks.listAll.mockReturnValue([
      { path: "C:\\repo\\one\\file.ts", dirty: true },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderApp();
    const preventDefault = vi.fn();

    await mocks.getCloseHandler()?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
});

function makeTile(id: string, wsId = "ws-1"): Tile {
  return {
    id,
    workstream_id: wsId,
    tile_type: "terminal",
    title: "Term",
    config_json: "{}",
    created_at: now,
    updated_at: now,
  } as Tile;
}

describe("tile-created event paths", () => {
  beforeEach(() => {
    mocks.resetTileCreatedHandler();
  });

  it("tile-created event upserts the tile in the matching workstream", async () => {
    const backend = createBackend();
    await renderApp(backend);

    act(() => mocks.emitTileCreated(makeTile("evt-tile")));
    act(() => mocks.emitTileCreated(makeTile("evt-tile")));
    expect(backend.updateLayout).not.toHaveBeenCalled();
  });

  it("tile-created event for an unloaded workstream is a no-op", async () => {
    const backend = createBackend();
    await renderApp(backend);

    expect(() =>
      act(() => mocks.emitTileCreated(makeTile("orphan", "ws-99"))),
    ).not.toThrow();
    expect(backend.updateLayout).not.toHaveBeenCalled();
  });
});

describe("clicking an archived workstream", () => {
  const archivedWorkstream = (directory: string): Workstream => ({
    id: "ws-archived",
    name: "Old work",
    description: null,
    directory,
    git_repo: null,
    git_branch: null,
    status: "archived",
    project_id: null,
    workstream_type: "worktree",
    worktree_branch: "feature/x",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  });

  /**
   * The guard that matters: archiving offers to delete the worktree, so
   * unarchiving without checking can open a workspace pointing at nothing.
   */
  it("refuses to open one whose worktree is gone, and offers a recreate instead", async () => {
    const backend = createBackend();
    vi.mocked(backend.listWorkstreams).mockResolvedValue([
      ...workstreams,
      archivedWorkstream("/gone"),
    ]);
    mocks.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "path_exists" ? false : null,
    );
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderApp(backend);
    const row = await screen.findByText("Old work");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith(expect.stringContaining("/gone"));
    expect(confirm).not.toHaveBeenCalled();
    expect(backend.updateWorkstream).not.toHaveBeenCalledWith(
      "ws-archived",
      expect.objectContaining({ status: "active" }),
    );
    alert.mockRestore();
    confirm.mockRestore();
  });

  it("confirms, then unarchives when the worktree is still there", async () => {
    const backend = createBackend();
    vi.mocked(backend.listWorkstreams).mockResolvedValue([
      ...workstreams,
      archivedWorkstream("/still-here"),
    ]);
    mocks.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "path_exists" ? true : null,
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderApp(backend);
    const row = await screen.findByText("Old work");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Unarchive"));
    expect(backend.updateWorkstream).toHaveBeenCalledWith("ws-archived", {
      status: "active",
    });
    confirm.mockRestore();
  });

  /**
   * The status write used to happen before the dirty-buffer prompt, so
   * cancelling that second dialog left the workstream unarchived but unopened
   * — a state the user never asked for.
   */
  it("writes nothing when the dirty-buffer prompt is cancelled", async () => {
    const backend = createBackend();
    vi.mocked(backend.listWorkstreams).mockResolvedValue([
      ...workstreams,
      archivedWorkstream("/still-here"),
    ]);
    mocks.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "path_exists" ? true : null,
    );
    mocks.listAll.mockReturnValue([{ path: "/a.ts", dirty: true }]);
    // First confirm = "unarchive and open" (yes), second = discard buffers (no).
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await renderApp(backend);
    const row = await screen.findByText("Old work");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(backend.updateWorkstream).not.toHaveBeenCalled();
    confirm.mockRestore();
    mocks.listAll.mockReturnValue([]);
  });

  /**
   * There are two ways in — the row click and the Unarchive menu action — so
   * the guard lives inside unarchiveAndOpen rather than at one call site.
   */
  it("refuses while the worktree is still being removed", async () => {
    const backend = createBackend();
    vi.mocked(backend.listWorkstreams).mockResolvedValue([
      ...workstreams,
      { ...archivedWorkstream("/still-here"), status: "archiving" },
    ]);
    mocks.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "path_exists" ? true : null,
    );
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderApp(backend);
    const row = await screen.findByText("Old work");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alert).toHaveBeenCalledWith(expect.stringContaining("still being archived"));
    expect(backend.updateWorkstream).not.toHaveBeenCalled();
    alert.mockRestore();
    confirm.mockRestore();
  });

  /**
   * The window round three found: a Retry could start a removal while the
   * unarchive write was still pending, and the continuation would then open a
   * workstream mid-deletion. Unarchiving now claims the same per-workstream
   * slot a removal uses, so the two cannot overlap in either direction.
   */
  it("holds the workstream's operation slot for the whole unarchive", async () => {
    const backend = createBackend();
    vi.mocked(backend.listWorkstreams).mockResolvedValue([
      ...workstreams,
      archivedWorkstream("/still-here"),
    ]);
    mocks.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "path_exists" ? true : null,
    );
    // Hold the persistence open so a second action can race it.
    let releaseWrite: () => void = () => {};
    vi.mocked(backend.updateWorkstream).mockImplementation(
      () => new Promise<void>((resolve) => { releaseWrite = () => resolve(); }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});

    await renderApp(backend);
    const row = await screen.findByText("Old work");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Mid-write, a second unarchive must be refused rather than queued.
    await act(async () => {
      fireEvent.click(screen.getByText("Old work"));
      await Promise.resolve();
    });
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("still being archived"));
    expect(backend.updateWorkstream).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseWrite();
      await Promise.resolve();
    });
    confirm.mockRestore();
    alert.mockRestore();
  });

  it("does nothing when the confirmation is declined", async () => {
    const backend = createBackend();
    vi.mocked(backend.listWorkstreams).mockResolvedValue([
      ...workstreams,
      archivedWorkstream("/still-here"),
    ]);
    mocks.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "path_exists" ? true : null,
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await renderApp(backend);
    const row = await screen.findByText("Old work");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backend.updateWorkstream).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("state-changed from an agent", () => {
  it("reloads workstreams so an agent's write is not invisible until the next click", async () => {
    const backend = createBackend();
    await renderApp(backend);
    expect(mocks.hasStateChangedListener()).toBe(true);

    const before = vi.mocked(backend.listWorkstreams).mock.calls.length;
    await act(async () => {
      mocks.emitStateChanged({
        entity: "workstream",
        id: "ws-new",
        action: "created",
      });
      await Promise.resolve();
    });
    expect(vi.mocked(backend.listWorkstreams).mock.calls.length).toBeGreaterThan(before);
  });

  it("ignores changes to entities the sidebar does not show", async () => {
    const backend = createBackend();
    await renderApp(backend);

    const before = vi.mocked(backend.listWorkstreams).mock.calls.length;
    await act(async () => {
      mocks.emitStateChanged({ entity: "task", id: "t-1", action: "created" });
      await Promise.resolve();
    });
    expect(vi.mocked(backend.listWorkstreams).mock.calls.length).toBe(before);
  });
});
