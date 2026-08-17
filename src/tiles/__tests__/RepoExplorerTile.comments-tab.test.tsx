import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { BackendProvider } from "../../backend/context";
import type { Backend } from "../../backend/types";
import type { SessionFileComment } from "../../domain/file-comments";
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
vi.mock("../../files/FileEditorView", () => ({
  FileEditorView: (
    props: ComponentProps<typeof import("../../files/FileEditorView").FileEditorView>,
  ) => (
    <div
      data-testid="file-editor-view"
      data-path={props.path}
      data-comments-enabled={String(props.commentsEnabled)}
      data-reveal-line={String(props.initialRevealLine ?? "")}
      data-focused-comment={String(props.focusedCommentId ?? "")}
    />
  ),
}));

function comment(over: Partial<SessionFileComment> & { id: string }): SessionFileComment {
  return {
    workstream_id: "ws-1",
    file: "src/a.ts",
    anchor_line_start: 12,
    anchor_line_end: 12,
    anchor_text: null,
    body: "please rename this",
    author: "reviewer",
    parent_id: null,
    status: "open",
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:00:00Z",
    ...over,
  };
}

function createBackend(opts: { session?: string | null; all?: SessionFileComment[]; allError?: Error } = {}) {
  const { session = "sess-1", all = [], allError } = opts;
  return {
    listDirectory: vi.fn().mockResolvedValue([
      { name: "app.ts", is_dir: false, modified_epoch: 1, size: 12 },
    ]),
    readFile: vi.fn().mockResolvedValue("line1\nline2\n"),
    gitCurrentBranch: vi.fn().mockResolvedValue("master"),
    searchFiles: vi.fn().mockResolvedValue([]),
    searchInFiles: vi.fn().mockResolvedValue([]),
    cancelSearches: vi.fn().mockResolvedValue(undefined),
    gitDiffFiles: vi.fn().mockResolvedValue([]),
    gitDiffFile: vi.fn().mockResolvedValue(""),
    gitLog: vi.fn().mockResolvedValue([]),
    gitShowCommit: vi.fn().mockResolvedValue(""),
    resolveWorkstreamSession: vi.fn().mockResolvedValue(session),
    listSessionFileComments: vi.fn().mockResolvedValue([]),
    listAllSessionFileComments: allError
      ? vi.fn().mockRejectedValue(allError)
      : vi.fn().mockResolvedValue(all),
    listSessionPlans: vi.fn(),
    getCurrentSessionPlan: vi.fn(),
    listSessionTodoDeps: vi.fn(),
    listSessionTodos: vi.fn(),
  } as unknown as Backend;
}

function renderTile(backend: Backend) {
  render(
    <BackendProvider backend={backend}>
      <RepoExplorerTile tileId="tile-1" isFocused rootDir={"C:\\repo"} workstreamId="ws-1" />
    </BackendProvider>,
  );
  return backend;
}

async function openCommentsTab() {
  const tab = await screen.findByTestId("repo-explorer-tab-comments");
  fireEvent.click(tab);
  return tab;
}

describe("RepoExplorerTile Comments tab", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_setting") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    listenMock.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists the workstream's comments grouped by file", async () => {
    renderTile(
      createBackend({
        all: [comment({ id: "c1" }), comment({ id: "c2", file: "src/b.ts", body: "second" })],
      }),
    );
    await openCommentsTab();

    expect(await screen.findByTestId("comments-thread-c1")).toBeInTheDocument();
    expect(screen.getByTestId("comments-file-src/b.ts")).toBeInTheDocument();
  });

  it("opens the comment's file with comments on, revealing and focusing the thread", async () => {
    renderTile(createBackend({ all: [comment({ id: "c1", anchor_line_start: 12 })] }));
    await openCommentsTab();

    fireEvent.click(await screen.findByTestId("comments-thread-c1"));

    const editor = await screen.findByTestId("file-editor-view");
    await waitFor(() => expect(editor).toHaveAttribute("data-reveal-line", "12"));
    expect(editor.getAttribute("data-path")).toMatch(/src[\\/]a\.ts$/);
    expect(editor).toHaveAttribute("data-comments-enabled", "true");
    expect(editor).toHaveAttribute("data-focused-comment", "c1");
  });

  it("stays on the Comments tab after opening a file", async () => {
    renderTile(createBackend({ all: [comment({ id: "c1" })] }));
    const tab = await openCommentsTab();

    fireEvent.click(await screen.findByTestId("comments-thread-c1"));
    await screen.findByTestId("file-editor-view");

    expect(tab).toHaveAttribute("data-active", "true");
  });

  it("does not render the shared comments toggle inside the tab", async () => {
    renderTile(createBackend({ all: [comment({ id: "c1" })] }));
    await openCommentsTab();

    await screen.findByTestId("comments-thread-c1");
    expect(screen.queryByTestId("repo-explorer-comments-toggle")).not.toBeInTheDocument();
  });

  it("re-reads comments when Refresh is pressed", async () => {
    const backend = renderTile(createBackend({ all: [comment({ id: "c1" })] }));
    await openCommentsTab();
    await screen.findByTestId("comments-thread-c1");

    const before = (backend.listAllSessionFileComments as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByTestId("comments-refresh"));

    await waitFor(() =>
      expect(
        (backend.listAllSessionFileComments as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(before),
    );
  });

  it("shows the session prompt instead of an empty list when unbound", async () => {
    renderTile(
      createBackend({
        session: null,
        allError: new Error("no Copilot session linked to this workstream"),
      }),
    );
    await openCommentsTab();

    expect(await screen.findByTestId("comments-unbound")).toBeInTheDocument();
  });
});
