import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import CodeReviewTile from "../CodeReviewTile";

// Shared mock state, hoisted so it's reachable from the vi.mock factory below.
const h = vi.hoisted(() => ({
  selectionHandlers: [] as Array<(e: { selection: { positionLineNumber: number } }) => void>,
  // The live modified buffer of the currently-mounted DiffEditor (per-mount ref).
  liveBuffer: null as null | { current: string },
  contentHandlers: [] as Array<() => void>,
  savedFiles: [] as Array<{ path: string; content: string }>,
  registryModelValue: "",
}));

// ── Mock the Monaco DiffEditor: capture onMount, expose a fake modified editor
// so we can simulate a new-side line selection + in-place edits without a real
// browser. The buffer lives in a per-mount useRef (like the real uncontrolled
// editor), so edits survive re-renders and never leak across tests/retries. ──
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: {
    onMount?: (editor: unknown, monaco: unknown) => void;
    original: string;
    modified: string;
    options?: { readOnly?: boolean };
  }) => {
    // useRef initial value is only used on first render of this mount; when the
    // parent changes `key` (new file), React remounts → fresh buffer from props.
    const bufRef = useRef(props.modified);
    h.liveBuffer = bufRef;
    const modified = {
      onDidChangeCursorSelection: (cb: (e: { selection: { positionLineNumber: number } }) => void) => {
        h.selectionHandlers.push(cb);
      },
      onDidChangeModelContent: (cb: () => void) => {
        h.contentHandlers.push(cb);
      },
      addCommand: () => {},
      getModel: () => ({
        getLineContent: (n: number) => `line ${n} content`,
        getValue: () => bufRef.current,
        setValue: (v: string) => {
          bufRef.current = v;
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
vi.mock("../../files/FileBufferRegistry", () => ({
  fileBufferRegistry: {
    acquire: vi.fn(async (path: string) => ({ path, content: "", eol: "\n" })),
    getModel: vi.fn(() => ({ setValue: (v: string) => { h.registryModelValue = v; } })),
    save: vi.fn(async (path: string) => { h.savedFiles.push({ path, content: h.registryModelValue }); }),
  },
}));

const selectionHandlers = h.selectionHandlers;
const savedFiles = h.savedFiles;

// MarkdownView stub (avoids react-markdown heavy render).
vi.mock("../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <span data-testid="md">{children}</span>,
}));

function selectLine(line: number) {
  act(() => {
    for (const cb of selectionHandlers) cb({ selection: { positionLineNumber: line } });
  });
}

function editContent(value: string) {
  act(() => {
    if (h.liveBuffer) h.liveBuffer.current = value;
    for (const cb of h.contentHandlers) cb();
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
  h.selectionHandlers.length = 0;
  h.contentHandlers.length = 0;
  h.savedFiles.length = 0;
  h.liveBuffer = null;
  h.registryModelValue = "";
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
    fireEvent.click(screen.getByTestId("create-review"));
    await waitFor(() => expect(screen.getByTestId("diff-editor")).toBeTruthy(), { timeout: 4000 });

    // Modified side is editable; Save is disabled until dirty.
    expect(screen.getByTestId("diff-editor").getAttribute("data-readonly")).toBe("false");
    expect((screen.getByTestId("save-edit") as HTMLButtonElement).disabled).toBe(true);

    // Edit the modified content → dirty dot + Save enabled.
    editContent("one\nchanged\n");
    await waitFor(() => expect(screen.getByTestId("edit-dirty-dot")).toBeTruthy(), { timeout: 4000 });
    expect((screen.getByTestId("save-edit") as HTMLButtonElement).disabled).toBe(false);

    // Save persists through the file buffer registry.
    fireEvent.click(screen.getByTestId("save-edit"));
    await waitFor(() => expect(savedFiles.length).toBe(1), { timeout: 4000 });
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
    await waitFor(() => expect(screen.getByTestId("diff-editor")).toBeTruthy(), { timeout: 4000 });

    expect(screen.getByTestId("diff-editor").getAttribute("data-readonly")).toBe("true");
    expect(screen.queryByTestId("save-edit")).toBeNull();
  });
});
