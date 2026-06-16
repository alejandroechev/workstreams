import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { BackendProvider } from "../backend/context";
import type { Backend } from "../backend/types";
import type { Project, Tile, Workstream, WorkstreamLayout } from "../domain/types";
import { getCurrentWindow } from "@tauri-apps/api/window";

const mocks = vi.hoisted(() => {
  let closeHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | null = null;
  let tileCreatedHandler: ((event: { payload: unknown }) => void) | null = null;
  const unlisten = vi.fn();
  const destroy = vi.fn();
  const onCloseRequested = vi.fn(async (handler: (event: { preventDefault: () => void }) => void | Promise<void>) => {
    closeHandler = handler;
    return unlisten;
  });
  const eventListen = vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    if (eventName === "tile-created") tileCreatedHandler = handler;
    return () => { if (eventName === "tile-created") tileCreatedHandler = null; };
  });

  return {
    invoke: vi.fn(async (..._args: unknown[]) => null as unknown),
    listAll: vi.fn<() => Array<{ path: string; dirty: boolean }>>(() => []),
    getCloseHandler: () => closeHandler,
    resetCloseHandler: () => { closeHandler = null; },
    emitTileCreated: (tile: unknown) => { tileCreatedHandler?.({ payload: tile }); },
    resetTileCreatedHandler: () => { tileCreatedHandler = null; },
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
  default: ({ workstreams, activeWsId, onSelectWorkstream, onArchiveWorkstream }: {
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
          <button data-testid={`archive-${ws.id}`} onClick={() => onArchiveWorkstream(ws.id)}>
            Archive
          </button>
        </div>
      ))}
    </aside>
  ),
}));
vi.mock("../tiling/TileGrid", () => ({ default: () => <main data-testid="tile-grid" /> }));
vi.mock("../tiling/StatusBar", () => ({ default: () => <div data-testid="status-bar" /> }));
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
  const layouts = new Map<string, WorkstreamLayout>(workstreams.map((ws) => [ws.id, {
    workstream_id: ws.id,
    layout_mode: "auto",
    focused_tile_id: null,
    fullscreen_tile_id: null,
    tile_order_json: "[]",
    updated_at: now,
  }]));

  return {
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
    getLayout: vi.fn(async (workstreamId: string) => layouts.get(workstreamId)!),
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
    gitBranchTrackingInfo: vi.fn(async () => ({ ahead: 0, behind: 0, remoteHeadShort: "" })),
    discoverCopilotConfig: vi.fn(),
    listSessionPlans: vi.fn(),
    getCurrentSessionPlan: vi.fn(),
    listSessionTodoDeps: vi.fn(),
    listSessionTodos: vi.fn(),
    listSessionFeatures: vi.fn(async () => ({ features: [], currentPlanId: null })),
    completeSessionPlan: vi.fn(),
    watchSessionFeatures: vi.fn(),
    unwatchSessionFeatures: vi.fn(),
    createDiffReview: vi.fn(),
    listActiveDiffReviews: vi.fn(async () => []),
    createOrFocusDiffReviewTile: vi.fn(),
    setReviewPlan: vi.fn(),
    getReview: vi.fn(),
    listChunks: vi.fn(),
    getChunkDetails: vi.fn(),
    activateChunk: vi.fn(),
    ackChunk: vi.fn(),
    addComment: vi.fn(),
    completeReview: vi.fn(),
    detectDrift: vi.fn(),
    listFileComments: vi.fn().mockResolvedValue([]),
    addFileComment: vi.fn(),
    updateFileComment: vi.fn(),
    deleteFileComment: vi.fn(),
    importPrComments: vi.fn(),
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
    await waitFor(() => expect(screen.getByText("Two")).toHaveAttribute("data-active", "true"));
  });

  it("confirms and switches workstreams when dirty buffers are discarded", async () => {
    mocks.listAll.mockReturnValue([{ path: "C:\\repo\\one\\file.ts", dirty: true }]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderApp();

    fireEvent.click(screen.getByText("Two"));

    expect(window.confirm).toHaveBeenCalledWith("You have unsaved changes in 1 file(s). Discard and switch workstreams?");
    await waitFor(() => expect(screen.getByText("Two")).toHaveAttribute("data-active", "true"));
  });

  it("blocks workstream switching when dirty buffer discard is canceled", async () => {
    mocks.listAll.mockReturnValue([{ path: "C:\\repo\\one\\file.ts", dirty: true }]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderApp();

    fireEvent.click(screen.getByText("Two"));

    expect(window.confirm).toHaveBeenCalledWith("You have unsaved changes in 1 file(s). Discard and switch workstreams?");
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
    mocks.listAll.mockReturnValue([{ path: "C:\\repo\\one\\file.ts", dirty: true }]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const backend = await renderApp();

    fireEvent.click(screen.getByTestId("archive-ws-1"));

    expect(window.confirm).toHaveBeenCalledWith("You have unsaved changes in 1 file(s). Discard and archive workstream?");
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
      if (cmd === "get_setting" && (args as { key?: string } | undefined)?.key === "app.confirm-close-disabled") {
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
    mocks.listAll.mockReturnValue([{ path: "C:\\repo\\one\\file.ts", dirty: true }]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderApp();
    const preventDefault = vi.fn();

    await mocks.getCloseHandler()?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
});

function makeReview(id: string, ref: string | null = null): import("../domain/diff-review").DiffReview {
  return {
    id,
    workstream_id: "ws-1",
    diff_source: "working_tree",
    source_ref: ref,
    status: "active",
    created_at: now,
    completed_at: null,
    exported_path: null,
  } as import("../domain/diff-review").DiffReview;
}

function makeTile(id: string, wsId = "ws-1"): Tile {
  return {
    id,
    workstream_id: wsId,
    tile_type: "diff_review",
    title: "Review",
    config_json: "{}",
    created_at: now,
    updated_at: now,
  } as Tile;
}

describe("diff-review tile-open paths", () => {
  beforeEach(() => {
    mocks.resetTileCreatedHandler();
  });

  it("Alt+G with 0 active reviews shows the inline hint banner", async () => {
    const backend = createBackend();
    (backend.listActiveDiffReviews as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await renderApp(backend);
    fireEvent.click(screen.getByText("One"));

    fireEvent.keyDown(window, { key: "g", altKey: true });

    expect(backend.listActiveDiffReviews).toHaveBeenCalledWith("ws-1");
    await waitFor(() => expect(screen.getByTestId("no-active-review-hint")).toBeInTheDocument());
    expect(backend.createOrFocusDiffReviewTile).not.toHaveBeenCalled();
  });

  it("Alt+G with 1 active review auto-opens via createOrFocusDiffReviewTile", async () => {
    const backend = createBackend();
    (backend.listActiveDiffReviews as ReturnType<typeof vi.fn>).mockResolvedValue([makeReview("r1")]);
    (backend.createOrFocusDiffReviewTile as ReturnType<typeof vi.fn>).mockResolvedValue(makeTile("t1"));
    await renderApp(backend);
    fireEvent.click(screen.getByText("One"));

    fireEvent.keyDown(window, { key: "g", altKey: true });

    await waitFor(() =>
      expect(backend.createOrFocusDiffReviewTile).toHaveBeenCalledWith("ws-1", "r1"),
    );
  });

  it("Alt+G with >1 active reviews opens the picker modal", async () => {
    const backend = createBackend();
    (backend.listActiveDiffReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeReview("r1"), makeReview("r2"),
    ]);
    await renderApp(backend);
    fireEvent.click(screen.getByText("One"));

    fireEvent.keyDown(window, { key: "g", altKey: true });

    await waitFor(() => expect(screen.getByTestId("diff-review-picker-modal")).toBeInTheDocument());
    expect(backend.createOrFocusDiffReviewTile).not.toHaveBeenCalled();
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

    expect(() => act(() => mocks.emitTileCreated(makeTile("orphan", "ws-99")))).not.toThrow();
    expect(backend.updateLayout).not.toHaveBeenCalled();
  });
});
