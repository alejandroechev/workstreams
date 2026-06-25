import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { BackendProvider } from "../../backend/context";
import type { Backend, FileSearchMatch } from "../../backend/types";
import RepoExplorerTile from "../RepoExplorerTile";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="monaco-editor" />,
  DiffEditor: () => <div data-testid="diff-editor" />,
}));
vi.mock("../AudioPlayer", () => ({
  default: ({ path }: { path: string }) => <div data-testid="audio-player" data-path={path} />,
}));
vi.mock("../../files/FileEditorView", () => ({
  FileEditorView: (props: ComponentProps<typeof import("../../files/FileEditorView").FileEditorView>) => (
    <div data-testid="file-editor-view" data-path={props.path} />
  ),
}));

function createBackend(matches: FileSearchMatch[]): Backend {
  const entries = [{ name: "app.ts", is_dir: false, modified_epoch: 1, size: 12 }];
  return {
    listDirectory: vi.fn().mockResolvedValue(entries),
    readFile: vi.fn().mockResolvedValue("content"),
    gitCurrentBranch: vi.fn().mockResolvedValue("master"),
    searchFiles: vi.fn().mockResolvedValue([]),
    searchInFiles: vi.fn().mockResolvedValue(matches),
    cancelSearches: vi.fn().mockResolvedValue(undefined),
    gitDiffFiles: vi.fn().mockResolvedValue([]),
    gitDiffFile: vi.fn().mockResolvedValue(""),
    gitLog: vi.fn().mockResolvedValue([]),
    gitShowCommit: vi.fn().mockResolvedValue(""),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    listWorkstreams: vi.fn(),
    createWorkstream: vi.fn(),
    updateWorkstream: vi.fn(),
    deleteWorkstream: vi.fn(),
    listTiles: vi.fn(),
    createTile: vi.fn(),
    deleteTile: vi.fn(),
    updateTileConfig: vi.fn(),
    getLayout: vi.fn(),
    updateLayout: vi.fn(),
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
    discoverCopilotConfig: vi.fn(),
    listSessionPlans: vi.fn(),
    getCurrentSessionPlan: vi.fn(),
    listSessionTodoDeps: vi.fn(),
    listSessionTodos: vi.fn(),
  } as unknown as Backend;
}

function renderTile(backend: Backend) {
  render(
    <BackendProvider backend={backend}>
      <RepoExplorerTile tileId="tile-1" isFocused rootDir={"C:\\repo"} />
    </BackendProvider>,
  );
}

describe("RepoExplorerTile — content Search tab", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_file_base64") return Promise.resolve("UklGRgAAAAAA");
      return Promise.resolve(undefined);
    });
    listenMock.mockResolvedValue(vi.fn());
  });

  afterEach(() => cleanup());

  it("switches to the Search tab and runs a content search", async () => {
    const backend = createBackend([
      { path: "C:\\repo\\app.ts", line_number: 3, line_text: "const needle = 1;" },
    ]);
    renderTile(backend);

    fireEvent.click(await screen.findByTestId("repo-explorer-tab-search"));
    const input = await screen.findByTestId("content-search-input");
    fireEvent.change(input, { target: { value: "needle" } });

    await waitFor(() => expect(screen.getByTestId("content-search-match-C:\\repo\\app.ts-3")).toBeInTheDocument());
    expect(backend.searchInFiles).toHaveBeenCalled();
  });

  it("opens the file when a content-search result is clicked", async () => {
    const backend = createBackend([
      { path: "C:\\repo\\app.ts", line_number: 3, line_text: "const needle = 1;" },
    ]);
    renderTile(backend);

    fireEvent.click(await screen.findByTestId("repo-explorer-tab-search"));
    fireEvent.change(await screen.findByTestId("content-search-input"), { target: { value: "needle" } });
    const row = await screen.findByTestId("content-search-match-C:\\repo\\app.ts-3");
    fireEvent.click(row);

    await waitFor(() =>
      expect(screen.getByTestId("file-editor-view")).toHaveAttribute("data-path", "C:\\repo\\app.ts"),
    );
  });

  it("opens the Search tab via Ctrl+Shift+F", async () => {
    const backend = createBackend([]);
    renderTile(backend);
    // Wait for the tile to settle on the Files tab.
    await screen.findByTestId("repo-explorer-tab-search");

    fireEvent.keyDown(window, { key: "F", ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(screen.getByTestId("content-search-input")).toBeInTheDocument());
  });
});
