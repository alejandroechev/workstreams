import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";

import { BackendProvider } from "../../backend/context";
import type { Backend } from "../../backend/types";
import RepoExplorerTile from "../RepoExplorerTile";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
const fileEditorMock = vi.hoisted(() => vi.fn());
let editorMountCounter = 0;

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
  FileEditorView: (props: ComponentProps<typeof import("../../files/FileEditorView").FileEditorView>) => {
    const [mountId] = useState(() => ++editorMountCounter);
    fileEditorMock(props);
    return (
      <div data-testid="file-editor-view" data-path={props.path} data-mount-id={mountId}>
        <button onClick={props.onBack}>back</button>
        <button
          onClick={() => props.onSnapshotChange?.({
            path: props.path,
            state: "dirty",
            dirty: true,
            lineEnding: "lf",
            hasTrailingNewline: true,
            sniffedBinary: false,
            sizeBytes: 10,
          })}
        >
          dirty
        </button>
      </div>
    );
  },
}));

function createBackend(): Backend {
  const entries = [
    { name: "app.ts", is_dir: false, modified_epoch: 1, size: 12 },
    { name: "other.ts", is_dir: false, modified_epoch: 1, size: 12 },
    { name: "README.md", is_dir: false, modified_epoch: 1, size: 12 },
    { name: "tone.wav", is_dir: false, modified_epoch: 1, size: 12 },
    { name: "logo.png", is_dir: false, modified_epoch: 1, size: 12 },
  ];

  return {
    listDirectory: vi.fn().mockResolvedValue(entries),
    readFile: vi.fn().mockResolvedValue("readonly content"),
    gitCurrentBranch: vi.fn().mockResolvedValue("master"),
    searchFiles: vi.fn().mockResolvedValue([]),
    searchInFiles: vi.fn().mockResolvedValue([]),
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

function renderTile(backend = createBackend()) {
  render(
    <BackendProvider backend={backend}>
      <RepoExplorerTile tileId="tile-1" isFocused rootDir={"C:\\repo"} />
    </BackendProvider>,
  );
  return backend;
}

async function openFile(name: string) {
  const item = await screen.findByText(name);
  fireEvent.click(item);
}

describe("RepoExplorerTile editor wiring", () => {
  beforeEach(() => {
    editorMountCounter = 0;
    fileEditorMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_file_base64") return Promise.resolve("UklGRgAAAAAA");
      return Promise.resolve(undefined);
    });
    listenMock.mockResolvedValue(vi.fn());
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:audio"), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens TypeScript files in FileEditorView with the selected path", async () => {
    renderTile();
    await openFile("app.ts");
    expect(await screen.findByTestId("file-editor-view")).toHaveAttribute("data-path", "C:\\repo\\app.ts");
  });

  it("does not render FileEditorView for wav audio files", async () => {
    renderTile();
    await openFile("tone.wav");
    expect(await screen.findByTestId("audio-player")).toHaveAttribute("data-path", "C:\\repo\\tone.wav");
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });

  it("does not render FileEditorView for png image files", async () => {
    renderTile();
    await openFile("logo.png");
    await waitFor(() => expect(screen.queryByTestId("file-editor-view")).toBeNull());
    expect(screen.getByText(/Preview not supported/i)).toBeInTheDocument();
  });

  it("opens Markdown files in FileEditorView so the editor owns preview rendering", async () => {
    renderTile();
    await openFile("README.md");
    expect(await screen.findByTestId("file-editor-view")).toHaveAttribute("data-path", "C:\\repo\\README.md");
    const lastCall = fileEditorMock.mock.calls[fileEditorMock.mock.calls.length - 1];
    expect(lastCall[0].renderMarkdownPreview).toEqual(expect.any(Function));
  });

  it("shows a dirty dot and star in the tile file title when the editor snapshot is dirty", async () => {
    renderTile();
    await openFile("app.ts");
    fireEvent.click(await screen.findByText("dirty"));
    const title = screen.getByTestId("repo-explorer-file-title");
    expect(title).toHaveTextContent("C:\\repo\\app.ts*");
    expect(screen.getByTestId("repo-explorer-dirty-dot")).toBeInTheDocument();
  });

  it("remounts FileEditorView when switching between editable files", async () => {
    renderTile();
    await openFile("app.ts");
    const firstMountId = (await screen.findByTestId("file-editor-view")).getAttribute("data-mount-id");
    fireEvent.click(screen.getByTestId("repo-explorer-tab-files"));
    await openFile("other.ts");
    expect(await screen.findByTestId("file-editor-view")).toHaveAttribute("data-path", "C:\\repo\\other.ts");
    expect(screen.getByTestId("file-editor-view").getAttribute("data-mount-id")).not.toBe(firstMountId);
  });

  it("returns to the file list when FileEditorView invokes the back handler", async () => {
    renderTile();
    await openFile("app.ts");
    fireEvent.click(await screen.findByText("back"));
    expect(await screen.findByText("other.ts")).toBeInTheDocument();
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });
});
