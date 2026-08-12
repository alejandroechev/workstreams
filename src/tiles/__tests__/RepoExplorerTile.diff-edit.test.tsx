import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

import RepoExplorerTile from "../RepoExplorerTile";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";

const h = vi.hoisted(() => ({
  contentHandlers: [] as Array<() => void>,
  selectionHandlers: [] as Array<(event: unknown) => void>,
  commands: [] as Array<() => void>,
  liveBuffer: null as null | { current: string },
  lastOptions: null as null | { readOnly?: boolean; originalEditable?: boolean },
  saved: [] as Array<{ path: string; content: string }>,
  modelValue: "",
  hasFocus: true,
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
    const modifiedRef = useRef<Record<string, unknown> | null>(null);
    const mountedRef = useRef(false);
    h.liveBuffer = bufRef;
    h.lastOptions = props.options ?? null;
    if (!modifiedRef.current) {
      modifiedRef.current = {
        onDidChangeModelContent: (cb: () => void) => h.contentHandlers.push(cb),
        onDidChangeCursorSelection: (cb: (event: unknown) => void) => {
          h.selectionHandlers.push(cb);
          return { dispose: vi.fn() };
        },
        addCommand: (_key: number, cb: () => void) => h.commands.push(cb),
        getModel: () => ({
          getValue: () => bufRef.current,
          setValue: (v: string) => { bufRef.current = v; },
        }),
        hasTextFocus: () => h.hasFocus,
        changeViewZones: () => {},
        getContainerDomNode: () => document.createElement("div"),
        revealLineInCenter: () => {},
        setPosition: () => {},
      };
    }
    const modified = modifiedRef.current;
    if (!mountedRef.current) {
      mountedRef.current = true;
      props.onMount?.(
        { getModifiedEditor: () => modified, getOriginalEditor: () => modified },
        { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } },
      );
    }
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

async function setup(
  mode: "unstaged" | "last_commit" | "branch_vs_master",
  status: "A" | "M" | "D" | "R" = "M",
  paths = ["src/a.ts"],
) {
  const backend = new MemoryBackend();
  backend.gitDiffFilesWithStatus = async () => paths.map((path) => ({ path, status }));
  backend.gitDiffFileSides = async () => ({ before: "old\n", after: "new\n" });
  backend.seedBoundSession("ws-1", "session-1");

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
    h.selectionHandlers.length = 0;
    h.commands.length = 0;
    h.saved.length = 0;
    h.liveBuffer = null;
    h.lastOptions = null;
    h.modelValue = "";
    h.hasFocus = true;
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
    act(() => h.contentHandlers.forEach((cb) => cb()));

    expect(await screen.findByTestId("diff-dirty-dot")).toBeTruthy();
  });

  it("does not mark dirty when the content matches what was loaded", async () => {
    // Monaco fires change events for non-edits too (e.g. a programmatic
    // setValue); treating those as dirty would show a false unsaved marker.
    await setup("unstaged");
    act(() => h.contentHandlers.forEach((cb) => cb()));
    expect(screen.queryByTestId("diff-dirty-dot")).toBeNull();
  });

  it("saves through the shared buffer registry so edits use one save path", async () => {
    // Writing the file directly here would create a second save path in a tile
    // that already saves via the registry in view mode — they would diverge on
    // EOL handling and external-change conflicts.
    await setup("unstaged");
    h.liveBuffer!.current = "edited\n";
    act(() => h.contentHandlers.forEach((cb) => cb()));

    fireEvent.click(await screen.findByLabelText("Save diff edit"));

    await waitFor(() => expect(h.saved.length).toBe(1));
    expect(h.saved[0].content).toBe("edited\n");
    expect(h.saved[0].path).toContain("a.ts");
  });

  it("clears the dirty marker after a save", async () => {
    await setup("unstaged");
    h.liveBuffer!.current = "edited\n";
    act(() => h.contentHandlers.forEach((cb) => cb()));
    await screen.findByTestId("diff-dirty-dot");

    fireEvent.click(screen.getByLabelText("Save diff edit"));

    await waitFor(() => expect(screen.queryByTestId("diff-dirty-dot")).toBeNull());
  });

  it("saves with Ctrl+S as well as the button", async () => {
    await setup("unstaged");
    h.liveBuffer!.current = "edited\n";
    act(() => h.contentHandlers.forEach((cb) => cb()));

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() => expect(h.saved.length).toBe(1));
  });

  it("saves with a real Cmd+S keyboard event while the diff editor is focused", async () => {
    await setup("unstaged");
    h.liveBuffer!.current = "edited\n";
    act(() => h.contentHandlers.forEach((cb) => cb()));

    fireEvent.keyDown(window, { key: "s", metaKey: true });

    await waitFor(() => expect(h.saved.length).toBe(1));
  });

  it("does not steal Cmd+S from a comment textarea", async () => {
    await setup("unstaged");
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    fireEvent.keyDown(textarea, { key: "s", metaKey: true });

    expect(h.saved).toEqual([]);
    textarea.remove();
  });

  it("does not save when focus is outside the diff editor", async () => {
    await setup("unstaged");
    h.hasFocus = false;

    fireEvent.keyDown(window, { key: "s", metaKey: true });

    expect(h.saved).toEqual([]);
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
    act(() => h.contentHandlers.forEach((cb) => cb()));
    fireEvent.click(await screen.findByLabelText("Save diff edit"));

    await waitFor(() => expect(sides).toHaveBeenCalled());
  });

  it("adds a file comment from the unstaged diff's modified side", async () => {
    const backend = await setup("unstaged");
    const add = vi.spyOn(backend, "addSessionFileComment");
    const toggle = await screen.findByTestId("repo-explorer-diff-comments-toggle");
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle);

    act(() => {
      h.selectionHandlers.forEach((handler) =>
        handler({
          selection: {
            isEmpty: () => false,
            startLineNumber: 1,
            endLineNumber: 1,
          },
        }),
      );
    });
    fireEvent.click(await screen.findByTestId("add-comment-floating"));
    fireEvent.change(screen.getByTestId("comment-composer-textarea"), {
      target: { value: "Review this change." },
    });
    fireEvent.click(screen.getByTestId("comment-composer-save"));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        "ws-1",
        "src/a.ts",
        1,
        1,
        "new",
        "Review this change.",
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("comment-composer")).toBeNull());
    expect(await backend.listSessionFileComments("ws-1", "src/a.ts")).toEqual([
      expect.objectContaining({ body: "Review this change." }),
    ]);
  });

  it("does not offer file comments for historical diffs", async () => {
    await setup("last_commit");
    expect(screen.queryByTestId("repo-explorer-diff-comments-toggle")).toBeNull();
  });

  it("does not offer working-file comments for deleted files", async () => {
    await setup("unstaged", "D");
    expect(screen.queryByTestId("repo-explorer-diff-comments-toggle")).toBeNull();
  });

  it("closes an in-progress comment composer when the selected diff file changes", async () => {
    await setup("unstaged", "M", ["src/a.ts", "src/b.ts"]);
    const toggle = await screen.findByTestId("repo-explorer-diff-comments-toggle");
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle);
    act(() => {
      h.selectionHandlers.forEach((handler) =>
        handler({
          selection: {
            isEmpty: () => false,
            startLineNumber: 1,
            endLineNumber: 1,
          },
        }),
      );
    });
    fireEvent.click(await screen.findByTestId("add-comment-floating"));
    expect(screen.getByTestId("comment-composer")).toBeTruthy();

    fireEvent.click(screen.getByText("src/b.ts"));

    await waitFor(() => expect(screen.queryByTestId("comment-composer")).toBeNull());
  });

  it("compares HEAD with a selected custom target branch", async () => {
    const backend = new MemoryBackend();
    backend.gitListBranches = vi.fn(async () => ["feature/current", "release/1.0"]);
    backend.gitCurrentBranch = vi.fn(async () => "feature/current");
    backend.gitDiffFilesWithStatus = vi.fn(async () => [
      { path: "src/a.ts", status: "M" as const },
    ]);
    backend.gitDiffFileSides = vi.fn(async () => ({ before: "release\n", after: "head\n" }));

    render(
      <BackendProvider backend={backend}>
        <RepoExplorerTile tileId="t1" isFocused rootDir="/repo" workstreamId="ws-1" />
      </BackendProvider>,
    );
    fireEvent.click(await screen.findByTestId("repo-explorer-tab-diff"));
    const picker = await screen.findByLabelText("Custom diff target branch");
    fireEvent.change(picker, { target: { value: "release/1.0" } });

    await waitFor(() =>
      expect(backend.gitDiffFilesWithStatus).toHaveBeenCalledWith(
        "/repo",
        "custom_branch",
        "release/1.0",
      ),
    );
    await waitFor(() =>
      expect(backend.gitDiffFileSides).toHaveBeenCalledWith(
        "/repo",
        "src/a.ts",
        "custom_branch",
        "release/1.0",
      ),
    );
    expect(screen.queryByLabelText("Save diff edit")).toBeNull();
  });

  it("surfaces an invalid custom target branch in the Diff view", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const backend = new MemoryBackend();
    backend.gitListBranches = vi.fn(async () => ["main", "missing"]);
    backend.gitCurrentBranch = vi.fn(async () => "main");
    backend.gitDiffFilesWithStatus = vi.fn(async (_dir, mode) => {
      if (mode === "custom_branch") {
        throw new Error("Target branch does not exist: missing");
      }
      return [];
    });

    render(
      <BackendProvider backend={backend}>
        <RepoExplorerTile tileId="t1" isFocused rootDir="/repo" workstreamId="ws-1" />
      </BackendProvider>,
    );
    fireEvent.click(await screen.findByTestId("repo-explorer-tab-diff"));
    fireEvent.change(await screen.findByLabelText("Custom diff target branch"), {
      target: { value: "missing" },
    });

    expect((await screen.findByTestId("diff-error")).textContent).toContain(
      "Target branch does not exist: missing",
    );
    consoleError.mockRestore();
  });

  it("keeps the latest custom branch when an older request finishes last", async () => {
    const backend = new MemoryBackend();
    backend.gitListBranches = vi.fn(async () => ["main", "release/old", "release/new"]);
    backend.gitCurrentBranch = vi.fn(async () => "main");
    let resolveOld:
      | ((files: Array<{ path: string; status: "M" }>) => void)
      | undefined;
    let resolveNew:
      | ((files: Array<{ path: string; status: "M" }>) => void)
      | undefined;
    backend.gitDiffFilesWithStatus = vi.fn(async (_dir, mode, baseRef) => {
      if (mode !== "custom_branch") return [];
      return new Promise<Array<{ path: string; status: "M" }>>((resolve) => {
        if (baseRef === "release/old") resolveOld = resolve;
        if (baseRef === "release/new") resolveNew = resolve;
      });
    });
    backend.gitDiffFileSides = vi.fn(async (_dir, file) => ({
      before: `before ${file}`,
      after: `after ${file}`,
    }));

    render(
      <BackendProvider backend={backend}>
        <RepoExplorerTile tileId="t1" isFocused rootDir="/repo" workstreamId="ws-1" />
      </BackendProvider>,
    );
    fireEvent.click(await screen.findByTestId("repo-explorer-tab-diff"));
    const picker = await screen.findByLabelText("Custom diff target branch");
    fireEvent.change(picker, { target: { value: "release/old" } });
    fireEvent.change(picker, { target: { value: "release/new" } });
    await waitFor(() => {
      expect(resolveOld).toBeTypeOf("function");
      expect(resolveNew).toBeTypeOf("function");
    });

    await act(async () => resolveNew?.([{ path: "src/new.ts", status: "M" }]));
    await waitFor(() => expect(screen.getByTestId("diff-current-file").textContent).toBe("new.ts"));
    await act(async () => resolveOld?.([{ path: "src/old.ts", status: "M" }]));

    expect(screen.getByTestId("diff-current-file").textContent).toBe("new.ts");
  });
});
