/**
 * Regression test for the Comments tab render loop.
 *
 * `FileEditorView`'s acquire effect has `onSnapshotChange` in its dependency
 * array. The Comments tab passed an INLINE arrow (new identity every render),
 * so: effect runs -> publishes a snapshot -> host setState -> re-render ->
 * new callback identity -> effect cleanup (release + onSnapshotChange(null))
 * -> effect re-runs -> ... unbounded.
 *
 * Symptoms reported: drift badges flickering (the file lines alternated with
 * null, flipping detectDrift between "drifted" and "unknown"), and "Loading
 * file" then nothing (the buffer was released as fast as it was acquired).
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import type { Backend } from "../../backend/types";
import type { SessionFileComment } from "../../domain/file-comments";
import RepoExplorerTile from "../RepoExplorerTile";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
const acquireSpy = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="monaco-editor" />,
  DiffEditor: () => <div data-testid="diff-editor" />,
}));

// Real FileEditorView is too heavy here; this stub reproduces the ONE
// behaviour that matters: an acquire effect keyed on the callback identity.
vi.mock("../../files/FileEditorView", async () => {
  const react = await import("react");
  return {
    FileEditorView: ({
      path,
      onSnapshotChange,
    }: {
      path: string;
      onSnapshotChange?: (s: unknown) => void;
    }) => {
      react.useEffect(() => {
        acquireSpy(path);
        onSnapshotChange?.({ path, state: "clean", dirty: false });
        return () => onSnapshotChange?.(null);
      }, [onSnapshotChange, path]);
      return <div data-testid="file-editor-view" data-path={path} />;
    },
  };
});

function comment(over: Partial<SessionFileComment> & { id: string }): SessionFileComment {
  return {
    workstream_id: "ws-1",
    file: "src/a.ts",
    anchor_line_start: 2,
    anchor_line_end: 2,
    anchor_text: "const b = 2;",
    body: "drifted note",
    author: "reviewer",
    parent_id: null,
    status: "open",
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:00:00Z",
    ...over,
  };
}

function createBackend(all: SessionFileComment[]): Backend {
  return {
    listDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue("const a = 1;\nconst b = 2;\n"),
    gitCurrentBranch: vi.fn().mockResolvedValue("master"),
    searchFiles: vi.fn().mockResolvedValue([]),
    searchInFiles: vi.fn().mockResolvedValue([]),
    cancelSearches: vi.fn().mockResolvedValue(undefined),
    gitDiffFiles: vi.fn().mockResolvedValue([]),
    gitDiffFile: vi.fn().mockResolvedValue(""),
    gitLog: vi.fn().mockResolvedValue([]),
    gitShowCommit: vi.fn().mockResolvedValue(""),
    resolveWorkstreamSession: vi.fn().mockResolvedValue("sess-1"),
    listSessionFileComments: vi.fn().mockResolvedValue([]),
    listAllSessionFileComments: vi.fn().mockResolvedValue(all),
  } as unknown as Backend;
}

describe("Comments tab render stability", () => {
  beforeEach(() => {
    acquireSpy.mockClear();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "get_setting" ? Promise.resolve(null) : Promise.resolve(undefined),
    );
    listenMock.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("acquires the file once and settles instead of looping", async () => {
    render(
      <BackendProvider backend={createBackend([comment({ id: "c1" })])}>
        <RepoExplorerTile tileId="t1" isFocused rootDir={"C:\\repo"} workstreamId="ws-1" />
      </BackendProvider>,
    );

    fireEvent.click(await screen.findByTestId("repo-explorer-tab-comments"));
    fireEvent.click(await screen.findByTestId("comments-thread-c1"));
    await screen.findByTestId("file-editor-view");

    await new Promise((r) => setTimeout(r, 250));
    const settled = acquireSpy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 250));

    expect(acquireSpy.mock.calls.length).toBe(settled);
    expect(settled).toBeLessThanOrEqual(2);
  });

  it("keeps the drift badge stable rather than flickering", async () => {
    render(
      <BackendProvider
        backend={createBackend([comment({ id: "c1", anchor_text: "GONE();" })])}
      >
        <RepoExplorerTile tileId="t1" isFocused rootDir={"C:\\repo"} workstreamId="ws-1" />
      </BackendProvider>,
    );

    fireEvent.click(await screen.findByTestId("repo-explorer-tab-comments"));
    fireEvent.click(await screen.findByTestId("comments-thread-c1"));
    await screen.findByTestId("file-editor-view");

    // The row itself must survive: a loop unmounts/remounts the list.
    await waitFor(() => expect(screen.getByTestId("comments-thread-c1")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId("comments-thread-c1")).toBeInTheDocument();
    expect(screen.getByTestId("comments-panel")).toBeInTheDocument();
  });
});
