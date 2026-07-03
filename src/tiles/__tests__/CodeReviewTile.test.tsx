import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import CodeReviewTile from "../CodeReviewTile";

// ── Mock the Monaco DiffEditor: capture onMount, expose a fake modified editor
// so we can simulate a new-side line selection + in-place edits without a real
// browser. ──
const selectionHandlers: Array<(e: { selection: { positionLineNumber: number } }) => void> = [];
const contentHandlers: Array<() => void> = [];
let modelValue = "";
let lastModifiedProp: string | undefined;
const setModelValue = (v: string) => {
  modelValue = v;
  for (const h of contentHandlers) h();
};
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: {
    onMount?: (editor: unknown, monaco: unknown) => void;
    original: string;
    modified: string;
    options?: { readOnly?: boolean };
  }) => {
    // Uncontrolled like the real editor: only (re)seed the buffer when the
    // modified prop actually changes, so in-place edits survive re-renders.
    if (props.modified !== lastModifiedProp) {
      modelValue = props.modified;
      lastModifiedProp = props.modified;
    }
    const modified = {
      onDidChangeCursorSelection: (cb: (e: { selection: { positionLineNumber: number } }) => void) => {
        selectionHandlers.push(cb);
      },
      onDidChangeModelContent: (cb: () => void) => {
        contentHandlers.push(cb);
      },
      addCommand: () => {},
      getModel: () => ({
        getLineContent: (n: number) => `line ${n} content`,
        getValue: () => modelValue,
        setValue: (v: string) => {
          modelValue = v;
        },
      }),
      changeViewZones: (fn: (accessor: { addZone: () => string; removeZone: () => void }) => void) => {
        fn({ addZone: () => "z1", removeZone: () => {} });
      },
    };
    const editor = { getModifiedEditor: () => modified };
    const monaco = { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } };
    props.onMount?.(editor, monaco);
    return <div data-testid="diff-editor" data-modified={props.modified} data-readonly={String(props.options?.readOnly)} />;
  },
}));

// Mock the shared file buffer registry used by in-place save.
const savedFiles: Array<{ path: string; content: string }> = [];
let registryModelValue = "";
vi.mock("../../files/FileBufferRegistry", () => ({
  fileBufferRegistry: {
    acquire: vi.fn(async (path: string) => ({ path, content: "", eol: "\n" })),
    getModel: vi.fn(() => ({ setValue: (v: string) => { registryModelValue = v; } })),
    save: vi.fn(async (path: string) => { savedFiles.push({ path, content: registryModelValue }); }),
  },
}));

// MarkdownView stub (avoids react-markdown heavy render).
vi.mock("../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <span data-testid="md">{children}</span>,
}));

function selectLine(line: number) {
  act(() => {
    for (const h of selectionHandlers) h({ selection: { positionLineNumber: line } });
  });
}

function editContent(value: string) {
  act(() => {
    setModelValue(value);
  });
}

function renderTile(backend: MemoryBackend) {
  return render(
    <BackendProvider backend={backend}>
      <CodeReviewTile tileId="t1" isFocused workstreamId="ws-1" workstreamDir="C:/repo" />
    </BackendProvider>,
  );
}

afterEach(() => {
  cleanup();
  selectionHandlers.length = 0;
  contentHandlers.length = 0;
  savedFiles.length = 0;
  lastModifiedProp = undefined;
  vi.clearAllTimers();
});

describe("CodeReviewTile", () => {
  it("prompts to open a session when none is linked", async () => {
    const backend = new MemoryBackend();
    backend.seedBoundSession("ws-1", null);
    renderTile(backend);
    expect(await screen.findByText(/Open a Copilot session/)).toBeTruthy();
  });

  it("creates a review, lists files, and comments on a selected diff line", async () => {
    const backend = new MemoryBackend();
    backend.seedReviewDiff([{ path: "src/a.js", status: "M" }]);
    backend.seedReviewDiffSides("src/a.js", { before: "one\n", after: "one\ntwo\n" });
    renderTile(backend);

    // Picker shows (no active review yet). Start a working-tree review.
    await screen.findByTestId("review-picker");
    fireEvent.click(screen.getByTestId("create-review"));

    // File list renders from the seeded diff; file auto-selected → DiffEditor mounts.
    await waitFor(() => expect(screen.getByTestId("file-src/a.js")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("diff-editor")).toBeTruthy());

    // Select new-side line 2 → composer appears → add a comment.
    selectLine(2);
    await waitFor(() => expect(screen.getByTestId("comment-composer")).toBeTruthy());
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "remove line two" } });
    fireEvent.click(screen.getByTestId("add-comment"));

    // Thread appears in the comments panel, anchored at a.js:2, status Open.
    await waitFor(() => expect(screen.getByTestId("comment-thread")).toBeTruthy());
    expect(screen.getByText("a.js:2")).toBeTruthy();
    expect(screen.getByTestId("thread-status").textContent).toBe("Open");
    expect(screen.getByTestId("open-count").textContent).toContain("1 open");
  });

  it("polls up an agent reply and lets the reviewer resolve then complete", async () => {
    const backend = new MemoryBackend();
    backend.seedReviewDiff([{ path: "a.js", status: "M" }]);
    backend.seedReviewDiffSides("a.js", { before: "x\n", after: "x\ny\n" });
    renderTile(backend);

    await screen.findByTestId("review-picker");
    fireEvent.click(screen.getByTestId("create-review"));
    await waitFor(() => expect(screen.getByTestId("diff-editor")).toBeTruthy());

    selectLine(2);
    await screen.findByTestId("comment-composer");
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "fix this" } });
    fireEvent.click(screen.getByTestId("add-comment"));
    await waitFor(() => expect(screen.getByTestId("comment-thread")).toBeTruthy());

    // Agent replies out-of-band; the 1.5s poll should pick it up (real timers).
    const review = await backend.getActiveReview("ws-1");
    const comments = await backend.listReviewComments("ws-1", review!.id);
    backend.simulateAgentReply(review!.id, comments[0].id, "done");
    await waitFor(() => expect(screen.getByTestId("thread-reply")).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByTestId("attention-badge")).toBeTruthy(); // open + addressed

    // Resolve → Complete becomes available → complete.
    fireEvent.click(screen.getByTestId("resolve"));
    await waitFor(() => expect(screen.getByTestId("thread-status").textContent).toBe("Resolved"));
    await waitFor(() => expect(screen.getByTestId("complete-review")).toBeTruthy());
    fireEvent.click(screen.getByTestId("complete-review"));
    await waitFor(() => expect(screen.getByTestId("review-completed")).toBeTruthy());
  });

  it("makes the modified side editable for working_tree and saves in place", async () => {
    const backend = new MemoryBackend();
    backend.seedReviewDiff([{ path: "src/a.js", status: "M" }]);
    backend.seedReviewDiffSides("src/a.js", { before: "one\n", after: "one\ntwo\n" });
    renderTile(backend);

    await screen.findByTestId("review-picker");
    fireEvent.click(screen.getByTestId("create-review")); // working_tree by default
    await waitFor(() => expect(screen.getByTestId("diff-editor")).toBeTruthy());

    // Modified side is editable; Save is disabled until dirty.
    expect(screen.getByTestId("diff-editor").getAttribute("data-readonly")).toBe("false");
    expect((screen.getByTestId("save-edit") as HTMLButtonElement).disabled).toBe(true);

    // Edit the modified content → dirty dot + Save enabled.
    editContent("one\nchanged\n");
    await waitFor(() => expect(screen.getByTestId("edit-dirty-dot")).toBeTruthy());
    expect((screen.getByTestId("save-edit") as HTMLButtonElement).disabled).toBe(false);

    // Save persists through the file buffer registry.
    fireEvent.click(screen.getByTestId("save-edit"));
    await waitFor(() => expect(savedFiles.length).toBe(1));
    expect(savedFiles[0].path).toContain("src/a.js");
    expect(savedFiles[0].content).toBe("one\nchanged\n");
  });

  it("keeps the modified side read-only for non-working_tree sources", async () => {
    const backend = new MemoryBackend();
    backend.seedReviewDiff([{ path: "a.js", status: "M" }]);
    backend.seedReviewDiffSides("a.js", { before: "x\n", after: "x\ny\n" });
    renderTile(backend);

    await screen.findByTestId("review-picker");
    fireEvent.change(screen.getByTestId("diff-source-select"), { target: { value: "last_commit" } });
    fireEvent.click(screen.getByTestId("create-review"));
    await waitFor(() => expect(screen.getByTestId("diff-editor")).toBeTruthy());

    expect(screen.getByTestId("diff-editor").getAttribute("data-readonly")).toBe("true");
    expect(screen.queryByTestId("save-edit")).toBeNull();
  });
});
