import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

import RepoExplorerTile from "../RepoExplorerTile";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";

const h = vi.hoisted(() => ({
  contentHandlers: [] as Array<() => void>,
  commands: [] as Array<() => void>,
  liveBuffer: null as null | { current: string },
  lastOptions: null as null | { readOnly?: boolean; originalEditable?: boolean },
  saved: [] as Array<{ path: string; content: string }>,
  modelValue: "",
}));

// Stand in for Monaco's DiffEditor: expose the modified buffer and capture the
// options + handlers, so in-place editing is exercisable without a browser.
vi.mock("@monaco-editor/react", () => ({
  Editor: () => <div data-testid="editor-stub" />,
  DiffEditor: (props: {
    onMount?: (editor: unknown, monaco: unknown) => void;
    modified: string;
    options?: { readOnly?: boolean; originalEditable?: boolean };
  }) => {
    const bufRef = useRef(props.modified);
    h.liveBuffer = bufRef;
    h.lastOptions = props.options ?? null;
    const modified = {
      onDidChangeModelContent: (cb: () => void) => h.contentHandlers.push(cb),
      onDidChangeCursorSelection: () => {},
      addCommand: (_key: number, cb: () => void) => h.commands.push(cb),
      getModel: () => ({
        getValue: () => bufRef.current,
        setValue: (v: string) => { bufRef.current = v; },
      }),
      changeViewZones: () => {},
      getContainerDomNode: () => document.createElement("div"),
      revealLineInCenter: () => {},
      setPosition: () => {},
    };
    props.onMount?.(
      { getModifiedEditor: () => modified, getOriginalEditor: () => modified },
      { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } },
    );
    return <div data-testid="diff-editor-stub" />;
  },
}));

vi.mock("../../files/FileBufferRegistry", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../files/FileBufferRegistry");
  return {
    ...actual,
    fileBufferRegistry: {
      acquire: vi.fn(async (path: string) => ({ path, dirty: false })),
      release: vi.fn(),
      getModel: vi.fn(() => ({
        getValue: () => h.modelValue,
        setValue: (v: string) => { h.modelValue = v; },
      })),
      save: vi.fn(async (path: string) => {
        h.saved.push({ path, content: h.modelValue });
      }),
      subscribe: vi.fn(() => () => {}),
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

async function setup(mode: "unstaged" | "last_commit" | "branch_vs_master") {
  const backend = new MemoryBackend();
  backend.gitDiffFilesWithStatus = async () => [{ path: "src/a.ts", status: "M" as const }];
  backend.gitDiffFileSides = async () => ({ before: "old\n", after: "new\n" });

  render(
    <BackendProvider backend={backend}>
      <RepoExplorerTile tileId="t1" isFocused rootDir="/repo" workstreamId="ws-1" />
    </BackendProvider>,
  );

  // The Diff tab activates "unstaged" itself; other modes need an extra click
  // on their button in the mode bar.
  fireEvent.click(await screen.findByTestId("repo-explorer-tab-diff"));
  await screen.findByTestId("diff-editor-stub");
  if (mode !== "unstaged") {
    const label = mode === "last_commit" ? "Last Commit" : "vs Master";
    fireEvent.click(screen.getByText(label));
    await waitFor(() => expect(h.lastOptions?.readOnly).toBe(true));
  }
  return backend;
}

describe("Repo Explorer diff editing", () => {
  beforeEach(() => {
    h.contentHandlers.length = 0;
    h.commands.length = 0;
    h.saved.length = 0;
    h.liveBuffer = null;
    h.lastOptions = null;
    h.modelValue = "";
  });

  afterEach(cleanup);

  it("makes the unstaged diff editable, since its modified side is the working file", async () => {
    await setup("unstaged");
    expect(h.lastOptions?.readOnly).toBe(false);
  });

  it("never makes the original side editable", async () => {
    // The left side is always a git object; editing it could not be saved.
    await setup("unstaged");
    expect(h.lastOptions?.originalEditable).toBe(false);
  });

  it("keeps historical diffs read-only", async () => {
    // last_commit compares HEAD~1 to HEAD, so the modified side is a git
    // object with nothing on disk to write back to.
    await setup("last_commit");
    expect(h.lastOptions?.readOnly).toBe(true);

    cleanup();
    await setup("branch_vs_master");
    expect(h.lastOptions?.readOnly).toBe(true);
  });

  it("marks the diff dirty once edited", async () => {
    await setup("unstaged");
    expect(screen.queryByTestId("diff-dirty-dot")).toBeNull();

    h.liveBuffer!.current = "edited\n";
    h.contentHandlers.forEach((cb) => cb());

    expect(await screen.findByTestId("diff-dirty-dot")).toBeTruthy();
  });

  it("does not mark dirty when the content matches what was loaded", async () => {
    // Monaco fires change events for non-edits too (e.g. a programmatic
    // setValue); treating those as dirty would show a false unsaved marker.
    await setup("unstaged");
    h.contentHandlers.forEach((cb) => cb());
    expect(screen.queryByTestId("diff-dirty-dot")).toBeNull();
  });

  it("saves through the shared buffer registry so edits use one save path", async () => {
    // Writing the file directly here would create a second save path in a tile
    // that already saves via the registry in view mode — they would diverge on
    // EOL handling and external-change conflicts.
    await setup("unstaged");
    h.liveBuffer!.current = "edited\n";
    h.contentHandlers.forEach((cb) => cb());

    fireEvent.click(await screen.findByLabelText("Save diff edit"));

    await waitFor(() => expect(h.saved.length).toBe(1));
    expect(h.saved[0].content).toBe("edited\n");
    expect(h.saved[0].path).toContain("a.ts");
  });

  it("clears the dirty marker after a save", async () => {
    await setup("unstaged");
    h.liveBuffer!.current = "edited\n";
    h.contentHandlers.forEach((cb) => cb());
    await screen.findByTestId("diff-dirty-dot");

    fireEvent.click(screen.getByLabelText("Save diff edit"));

    await waitFor(() => expect(screen.queryByTestId("diff-dirty-dot")).toBeNull());
  });

  it("saves with Ctrl+S as well as the button", async () => {
    await setup("unstaged");
    h.liveBuffer!.current = "edited\n";
    h.contentHandlers.forEach((cb) => cb());

    expect(h.commands.length).toBeGreaterThan(0);
    h.commands.forEach((cb) => cb());

    await waitFor(() => expect(h.saved.length).toBe(1));
  });

  it("offers no save control for a read-only diff", async () => {
    await setup("last_commit");
    expect(screen.queryByLabelText("Save diff edit")).toBeNull();
  });

  it("re-reads the diff after saving so the view reflects the new state", async () => {
    // An edit can change the diff itself — removing an added line makes a hunk
    // disappear — so a stale view would misrepresent the file.
    const backend = await setup("unstaged");
    const sides = vi.spyOn(backend, "gitDiffFileSides");

    h.liveBuffer!.current = "edited\n";
    h.contentHandlers.forEach((cb) => cb());
    fireEvent.click(await screen.findByLabelText("Save diff edit"));

    await waitFor(() => expect(sides).toHaveBeenCalled());
  });
});
