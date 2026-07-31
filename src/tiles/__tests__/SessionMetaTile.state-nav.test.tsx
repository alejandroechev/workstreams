import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import type { Backend } from "../../backend/types";
import SessionMetaTile from "../SessionMetaTile";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../../files/FileEditorView", () => ({
  FileEditorView: (props: { path: string }) => <div data-testid="file-editor-view">{props.path}</div>,
}));

const STATE_ROOT = "C:\\Users\\me\\.copilot\\session-state\\session-1";

function entry(name: string, is_dir: boolean) {
  return { name, is_dir, modified_epoch: 0, size: 0 };
}

/**
 * Directory tree used by the navigation test:
 *   <root>/features/code-review-tile/spikes/FINDINGS.md
 */
const TREE: Record<string, Array<{ name: string; is_dir: boolean }>> = {
  [STATE_ROOT]: [entry("features", true), entry("root-note.md", false)],
  [`${STATE_ROOT}\\features`]: [entry("code-review-tile", true), entry("features-note.md", false)],
  [`${STATE_ROOT}\\features\\code-review-tile`]: [entry("spikes", true), entry("plan.md", false)],
  [`${STATE_ROOT}\\features\\code-review-tile\\spikes`]: [entry("FINDINGS.md", false)],
};

function createBackend(): Backend {
  return {
    discoverCopilotConfig: vi.fn().mockResolvedValue([]),
    listDirectory: vi.fn().mockImplementation(async (path: string) => {
      const found = TREE[path];
      if (!found) throw new Error("not a directory");
      return found;
    }),
    readFile: vi.fn().mockResolvedValue("file contents"),
  } as unknown as Backend;
}

function renderTile() {
  invokeMock.mockImplementation((command: string) => {
    if (command === "session_state_dir") return Promise.resolve(STATE_ROOT);
    if (command === "watch_directory" || command === "unwatch_directory") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected invoke ${command}`));
  });
  return render(
    <BackendProvider backend={createBackend()}>
      <SessionMetaTile tileId="meta" isFocused={false} linkedSessionIds={["session-1"]} />
    </BackendProvider>,
  );
}

async function enterFolder(name: string) {
  const row = await screen.findByText(name);
  fireEvent.click(row);
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionMetaTile State tab folder navigation", () => {
  it("the up arrow goes up exactly ONE level, not all the way to the root", async () => {
    renderTile();
    fireEvent.click(screen.getByRole("button", { name: /State/i }));

    // Descend three levels: features → code-review-tile → spikes.
    await enterFolder("features");
    await enterFolder("code-review-tile");
    await enterFolder("spikes");
    expect(await screen.findByText("FINDINGS.md")).toBeInTheDocument();

    const up = screen.getByTestId("meta-state-up");

    // One level up → .../features/code-review-tile (NOT the root).
    fireEvent.click(up);
    await waitFor(() => expect(screen.getByText("plan.md")).toBeInTheDocument());
    expect(screen.queryByText("root-note.md")).toBeNull();

    // Another level up → .../features.
    fireEvent.click(up);
    await waitFor(() => expect(screen.getByText("features-note.md")).toBeInTheDocument());
    expect(screen.queryByText("root-note.md")).toBeNull();

    // Final level up → the root.
    fireEvent.click(up);
    await waitFor(() => expect(screen.getByText("root-note.md")).toBeInTheDocument());
  });

  it("disables the up arrow at the session state root", async () => {
    renderTile();
    fireEvent.click(screen.getByRole("button", { name: /State/i }));
    await screen.findByText("root-note.md");
    expect(screen.getByTestId("meta-state-up")).toBeDisabled();
  });
});
