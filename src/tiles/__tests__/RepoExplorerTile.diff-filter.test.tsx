import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
import { fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";

import RepoExplorerTile from "../RepoExplorerTile";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";

const h = vi.hoisted(() => ({
  lastOptions: null as null | { renderSideBySide?: boolean },
  hiddenAreas: [] as Array<Array<{ startLineNumber: number; endLineNumber: number }>>,
  lineCount: 100,
  originalOptions: [] as Array<{ lineNumbers?: string }>,
}));

// Monaco stand-in: records options and the hidden line ranges the tile asks for.
vi.mock("@monaco-editor/react", () => ({
  Editor: () => <div data-testid="editor-stub" />,
  DiffEditor: (props: {
    onMount?: (editor: unknown, monaco: unknown) => void;
    options?: { renderSideBySide?: boolean };
  }) => {
    const modifiedRef = useRef<Record<string, unknown> | null>(null);
    const mountedRef = useRef(false);
    h.lastOptions = props.options ?? null;
    if (!modifiedRef.current) {
      modifiedRef.current = {
        onDidChangeModelContent: () => {},
        onDidChangeCursorSelection: () => ({ dispose: () => {} }),
        addCommand: () => {},
        getModel: () => ({ getValue: () => "", setValue: () => {}, getLineCount: () => h.lineCount }),
        hasTextFocus: () => false,
        changeViewZones: () => {},
        getContainerDomNode: () => document.createElement("div"),
        revealLineInCenter: () => {},
        setPosition: () => {},
        setHiddenAreas: (ranges: Array<{ startLineNumber: number; endLineNumber: number }>) => {
          h.hiddenAreas.push(ranges);
        },
      };
    }
    const modified = modifiedRef.current;
    if (!mountedRef.current) {
      mountedRef.current = true;
      props.onMount?.(
        {
          getModifiedEditor: () => modified,
          getOriginalEditor: () => ({
            updateOptions: (options: { lineNumbers?: string }) => h.originalOptions.push(options),
          }),
        },
        { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } },
      );
    }
    return <div data-testid="diff-editor-stub" />;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

async function setup(paths = ["src/tiles/deep/a.ts", "README.md", "src/b.ts"]) {
  const backend = new MemoryBackend();
  backend.gitDiffFilesWithStatus = async () => paths.map((path) => ({ path, status: "M" as const }));
  backend.gitDiffFileSides = async () => ({ before: "old\n", after: "new\n" });
  backend.seedBoundSession("ws-1", "session-1");
  render(
    <BackendProvider backend={backend}>
      <RepoExplorerTile tileId="t1" isFocused rootDir="/repo" workstreamId="ws-1" />
    </BackendProvider>,
  );
  fireEvent.click(await screen.findByTestId("repo-explorer-tab-diff"));
  await screen.findByTestId("diff-editor-stub");
  await waitFor(() => expect(screen.getAllByTestId("diff-file-item")).toHaveLength(paths.length));
  return backend;
}

const rows = () => screen.getAllByTestId("diff-file-item");

describe("Repo Explorer diff file list", () => {
  beforeEach(() => {
    h.lastOptions = null;
    h.hiddenAreas.length = 0;
    h.lineCount = 100;
    h.originalOptions.length = 0;
  });
  afterEach(cleanup);

  it("leads each row with the file name and follows it with the directory", async () => {
    await setup();
    const first = rows()[0];
    expect(within(first).getByTestId("diff-file-name")).toHaveTextContent("a.ts");
    expect(within(first).getByTestId("diff-file-dir")).toHaveTextContent("- src/tiles/deep");
    expect(first).toHaveAttribute("title", "src/tiles/deep/a.ts");
    const root = rows()[1];
    expect(within(root).getByTestId("diff-file-name")).toHaveTextContent("README.md");
    expect(within(root).queryByTestId("diff-file-dir")).not.toBeInTheDocument();
  });
});

describe("Repo Explorer diff: comments only", () => {
  beforeEach(() => {
    h.lastOptions = null;
    h.hiddenAreas.length = 0;
    h.lineCount = 100;
    h.originalOptions.length = 0;
  });
  afterEach(cleanup);

  it("lists only the changed files that carry comments, with their thread counts", async () => {
    const backend = await setup();
    await backend.addSessionFileComment("ws-1", "src/b.ts", 40, 40, null, "why?");
    await backend.addSessionFileComment("ws-1", "src/b.ts", 70, 70, null, "and this?");
    const toggle = screen.getByTestId("repo-explorer-diff-comments-only");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]).getByTestId("diff-file-name")).toHaveTextContent("b.ts");
    expect(within(rows()[0]).getByTestId("diff-file-comment-count")).toHaveTextContent("2");
    // The selected file had no comments, so the view moves to one that does.
    await waitFor(() => expect(screen.getByTestId("diff-current-file")).toHaveTextContent("b.ts"));
    fireEvent.click(toggle);
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it("says so when no changed file has comments", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("repo-explorer-diff-comments-only"));
    expect(await screen.findByText("No changed files have comments")).toBeInTheDocument();
  });

  it("collapses the code around comments and restores it when switched off", async () => {
    const backend = await setup(["src/b.ts"]);
    await backend.addSessionFileComment("ws-1", "src/b.ts", 40, 40, null, "why?");
    fireEvent.click(screen.getByTestId("repo-explorer-diff-comments-only"));
    await waitFor(() => expect(h.hiddenAreas[h.hiddenAreas.length - 1]).toEqual([
      { startLineNumber: 1, endLineNumber: 36 },
      { startLineNumber: 44, endLineNumber: 100 },
    ]));
    // The old-line column cannot collapse in step, so it is hidden meanwhile.
    expect(h.originalOptions[h.originalOptions.length - 1]).toEqual({ lineNumbers: "off" });
    fireEvent.click(screen.getByTestId("repo-explorer-diff-comments-only"));
    await waitFor(() => expect(h.hiddenAreas[h.hiddenAreas.length - 1]).toEqual([]));
    expect(h.originalOptions[h.originalOptions.length - 1]).toEqual({ lineNumbers: "on" });
  });

  // Hiding lines in one pane of a side-by-side diff would misalign the panes.
  it("shows the diff unified while filtering, and restores the chosen layout after", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("diff-layout-split"));
    await waitFor(() => expect(h.lastOptions?.renderSideBySide).toBe(true));
    fireEvent.click(screen.getByTestId("repo-explorer-diff-comments-only"));
    await waitFor(() => expect(h.lastOptions?.renderSideBySide).toBe(false));
    expect(screen.getByTestId("diff-layout-split")).toBeDisabled();
    fireEvent.click(screen.getByTestId("repo-explorer-diff-comments-only"));
    await waitFor(() => expect(h.lastOptions?.renderSideBySide).toBe(true));
  });
});
