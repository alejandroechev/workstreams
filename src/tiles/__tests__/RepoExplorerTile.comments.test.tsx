import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { BackendProvider } from "../../backend/context";
import type { Backend } from "../../backend/types";
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
    />
  ),
}));

function createBackend(session: string | null): Backend {
  const entries = [{ name: "app.ts", is_dir: false, modified_epoch: 1, size: 12 }];
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
    resolveWorkstreamSession: vi.fn().mockResolvedValue(session),
    listSessionFileComments: vi.fn().mockResolvedValue([]),
    listSessionPlans: vi.fn(),
    getCurrentSessionPlan: vi.fn(),
    listSessionTodoDeps: vi.fn(),
    listSessionTodos: vi.fn(),
  } as unknown as Backend;
}

function renderTile(session: string | null) {
  const backend = createBackend(session);
  render(
    <BackendProvider backend={backend}>
      <RepoExplorerTile tileId="tile-1" isFocused rootDir={"C:\\repo"} workstreamId="ws-1" />
    </BackendProvider>,
  );
  return backend;
}

async function openFile(name: string) {
  const item = await screen.findByText(name);
  fireEvent.click(item);
}

describe("RepoExplorerTile inline comments (session-gated)", () => {
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

  it("disables the comment toggle when no Copilot session is linked", async () => {
    renderTile(null);
    await openFile("app.ts");
    const toggle = await screen.findByTestId("repo-explorer-comments-toggle");
    expect(toggle).toBeDisabled();
    expect(toggle.getAttribute("title")).toMatch(/Open a Copilot session/i);
  });

  it("enables the comment toggle when a session is linked", async () => {
    renderTile("sess-1");
    await openFile("app.ts");
    const toggle = await screen.findByTestId("repo-explorer-comments-toggle");
    await waitFor(() => expect(toggle).not.toBeDisabled());
  });
});
