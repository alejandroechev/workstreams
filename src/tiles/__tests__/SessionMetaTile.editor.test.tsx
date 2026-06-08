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

function createBackend(entries: Array<{ name: string; is_dir: boolean }> = []): Backend {
  const dirEntries = entries.map((e) => ({
    name: e.name,
    is_dir: e.is_dir,
    modified_epoch: 0,
    size: 0,
  }));
  return {
    discoverCopilotConfig: vi.fn().mockResolvedValue([]),
    listDirectory: vi.fn().mockImplementation(async (path: string) => {
      if (path === STATE_ROOT) return dirEntries;
      // Per-file viewFile() probes a path with listDirectory to detect dirs;
      // reject for any non-root path so it falls through to file handling.
      throw new Error("not a directory");
    }),
    readFile: vi.fn().mockResolvedValue("file contents"),
  } as unknown as Backend;
}

const STATE_ROOT = "C:\\Users\\me\\.copilot\\session-state\\session-1";

function renderTile(entries: Array<{ name: string; is_dir: boolean }>) {
  invokeMock.mockImplementation((command: string) => {
    if (command === "session_state_dir") return Promise.resolve(STATE_ROOT);
    if (command === "read_file_base64") return Promise.resolve("AA==");
    if (command === "watch_directory" || command === "unwatch_directory") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected invoke ${command}`));
  });
  return render(
    <BackendProvider backend={createBackend(entries)}>
      <SessionMetaTile tileId="meta" isFocused={false} linkedSessionIds={["session-1"]} />
    </BackendProvider>,
  );
}

async function openStateTab() {
  fireEvent.click(screen.getByRole("button", { name: /State/i }));
}

async function openLiveFile(name: string) {
  await openStateTab();
  const row = await screen.findByText(name);
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SessionMetaTile editable live files (State tab)", () => {
  it("renders FileEditorView for a live TypeScript file", async () => {
    renderTile([{ name: "app.ts", is_dir: false }]);
    await openLiveFile("app.ts");
    const expected = `${STATE_ROOT}\\app.ts`;
    expect(await screen.findByTestId("file-editor-view")).toHaveTextContent(expected);
    expect(fileEditorProps[fileEditorProps.length - 1]?.path).toBe(expected);
  });

  it("renders FileEditorView rather than direct MarkdownView for a live markdown file", async () => {
    renderTile([{ name: "README.md", is_dir: false }]);
    await openLiveFile("README.md");
    const expected = `${STATE_ROOT}\\README.md`;
    expect(await screen.findByTestId("file-editor-view")).toHaveTextContent(expected);
    expect(screen.queryByTestId("markdown-view")).toBeNull();
  });

  it("keeps audio files on AudioPlayer instead of FileEditorView", async () => {
    renderTile([{ name: "voice.mp3", is_dir: false }]);
    await openLiveFile("voice.mp3");
    const expected = `${STATE_ROOT}\\voice.mp3`;
    expect(await screen.findByTestId("audio-player")).toHaveTextContent(expected);
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });

  it("shows a dirty indicator when the editor snapshot is dirty", async () => {
    renderTile([{ name: "app.ts", is_dir: false }]);
    await openLiveFile("app.ts");
    await screen.findByTestId("file-editor-view");
    const expected = `${STATE_ROOT}\\app.ts`;
    act(() => {
      fileEditorProps[fileEditorProps.length - 1]?.onSnapshotChange?.(snapshot({ path: expected, state: "dirty", dirty: true }));
    });
    await waitFor(() => expect(screen.getByTestId("meta-file-dirty-indicator")).toHaveTextContent("*"));
  });
});
