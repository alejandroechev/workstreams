import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import type { Backend } from "../../backend/types";
import type { BufferSnapshot } from "../../files/FileBufferRegistry";
import SessionMetaTile from "../SessionMetaTile";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
const fileEditorProps = vi.hoisted(() => [] as Array<{
  path: string;
  onBack: () => void;
  renderMarkdownPreview?: (content: string) => React.ReactNode;
  onSnapshotChange?: (snapshot: BufferSnapshot | null) => void;
}>);
const audioPlayerMock = vi.hoisted(() => vi.fn());
const markdownViewMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../../files/FileEditorView", () => ({
  FileEditorView: (props: {
    path: string;
    onBack: () => void;
    renderMarkdownPreview?: (content: string) => React.ReactNode;
    onSnapshotChange?: (snapshot: BufferSnapshot | null) => void;
  }) => {
    fileEditorProps.push(props);
    return <div data-testid="file-editor-view">Editor: {props.path}</div>;
  },
}));
vi.mock("../AudioPlayer", () => ({
  default: (props: { path: string }) => {
    audioPlayerMock(props);
    return <div data-testid="audio-player">Audio: {props.path}</div>;
  },
}));
vi.mock("../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: React.ReactNode }) => {
    markdownViewMock(children);
    return <article data-testid="markdown-view">{children}</article>;
  },
}));

function snapshot(overrides: Partial<BufferSnapshot> = {}): BufferSnapshot {
  return {
    path: "C:\\repo\\src\\file.ts",
    state: "clean",
    dirty: false,
    lineEnding: "lf",
    hasTrailingNewline: true,
    sniffedBinary: false,
    sizeBytes: 10,
    ...overrides,
  };
}

function createBackend(): Backend {
  return {
    discoverCopilotConfig: vi.fn().mockResolvedValue([]),
    listDirectory: vi.fn().mockRejectedValue(new Error("not a directory")),
    readFile: vi.fn().mockResolvedValue("file contents"),
  } as unknown as Backend;
}

function renderTile(backend = createBackend()) {
  return render(
    <BackendProvider backend={backend}>
      <SessionMetaTile tileId="meta" isFocused={false} linkedSessionIds={["session-1"]} />
    </BackendProvider>,
  );
}

function setSessionFiles(paths: string[]) {
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "query_session_files") {
      return Promise.resolve(paths.map((filePath) => ({ file_path: filePath, tool_name: "edit", turn_index: 1 })));
    }
    if (command === "list_session_checkpoints") {
      return Promise.resolve([]);
    }
    if (command === "read_file_base64") {
      return Promise.resolve("AA==");
    }
    if (command === "watch_directory" || command === "unwatch_directory") {
      return Promise.resolve(null);
    }
    return Promise.reject(new Error(`unexpected invoke ${command} ${JSON.stringify(args)}`));
  });
}

async function openFilesTab() {
  fireEvent.click(screen.getByRole("button", { name: /Files/i }));
}

async function openLiveFile(fileName: string) {
  await openFilesTab();
  const row = await screen.findByText(fileName);
  fireEvent.click(row);
}

beforeEach(() => {
  fileEditorProps.length = 0;
  invokeMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
  audioPlayerMock.mockClear();
  markdownViewMock.mockClear();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:audio"),
    revokeObjectURL: vi.fn(),
  });
  setSessionFiles([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SessionMetaTile editable live files", () => {
  it("renders FileEditorView for a live TypeScript file", async () => {
    setSessionFiles(["C:\\repo\\src\\app.ts"]);
    renderTile();

    await openLiveFile("app.ts");

    expect(await screen.findByTestId("file-editor-view")).toHaveTextContent("C:\\repo\\src\\app.ts");
    expect(fileEditorProps[fileEditorProps.length - 1]?.path).toBe("C:\\repo\\src\\app.ts");
  });

  it("renders FileEditorView rather than direct MarkdownView for a live markdown file", async () => {
    setSessionFiles(["C:\\repo\\README.md"]);
    renderTile();

    await openLiveFile("README.md");

    expect(await screen.findByTestId("file-editor-view")).toHaveTextContent("C:\\repo\\README.md");
    expect(screen.queryByTestId("markdown-view")).toBeNull();
  });

  it("keeps audio files on AudioPlayer instead of FileEditorView", async () => {
    setSessionFiles(["C:\\repo\\voice.mp3"]);
    renderTile();

    await openLiveFile("voice.mp3");

    expect(await screen.findByTestId("audio-player")).toHaveTextContent("C:\\repo\\voice.mp3");
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });

  it("keeps checkpoint snapshots on MarkdownView instead of FileEditorView", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "query_session_files") return Promise.resolve([]);
      if (command === "list_session_checkpoints") return Promise.resolve([{ number: 1, title: "Saved state", file_name: "cp.md" }]);
      if (command === "read_session_file") return Promise.resolve("# Frozen checkpoint");
      if (command === "watch_directory" || command === "unwatch_directory") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected invoke ${command}`));
    });
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: /CP/i }));
    fireEvent.click(await screen.findByText("Saved state"));

    expect(await screen.findByTestId("markdown-view")).toHaveTextContent("Frozen checkpoint");
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });

  it("shows a dirty indicator when the editor snapshot is dirty", async () => {
    setSessionFiles(["C:\\repo\\src\\app.ts"]);
    renderTile();
    await openLiveFile("app.ts");
    await screen.findByTestId("file-editor-view");

    act(() => {
      fileEditorProps[fileEditorProps.length - 1]?.onSnapshotChange?.(snapshot({ path: "C:\\repo\\src\\app.ts", state: "dirty", dirty: true }));
    });

    await waitFor(() => expect(screen.getByTestId("meta-file-dirty-indicator")).toHaveTextContent("*"));
  });
});
