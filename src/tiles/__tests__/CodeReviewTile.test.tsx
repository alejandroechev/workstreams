// NOTE: jsdom + mocked Monaco → logic/state coverage only. The inline thread
// view-zone buttons being *actually clickable* (not occluded by Monaco's text
// layer) is covered by the Playwright harness — `npm run harness -- review-thread`
// and e2e/tests/comment-interactivity.spec.ts — NOT here.
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import CodeReviewTile from "../CodeReviewTile";

// Shared mock state, hoisted so it's reachable from the vi.mock factory below.
type SelEvent = {
  selection: {
    startLineNumber: number;
    endLineNumber: number;
    startColumn: number;
    endColumn: number;
  };
};
const h = vi.hoisted(() => ({
  selectionHandlers: [] as Array<(e: unknown) => void>,
  // The live modified buffer of the currently-mounted DiffEditor (per-mount ref).
  liveBuffer: null as null | { current: string },
  contentHandlers: [] as Array<() => void>,
  savedFiles: [] as Array<{ path: string; content: string }>,
  registryModelValue: "",
  // View-zone DOM nodes, attached to document.body so their testids are queryable.
  zoneNodes: new Map<string, HTMLElement>(),
  zoneSeq: 0,
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
      onDidChangeCursorSelection: (cb: (e: unknown) => void) => {
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
      // Attach view-zone DOM nodes to the document so their testids/buttons are
      // queryable + clickable (mirrors Monaco attaching them to the overlay).
      changeViewZones: (
        fn: (accessor: {
          addZone: (z: { domNode: HTMLElement }) => string;
          removeZone: (id: string) => void;
        }) => void,
      ) => {
        fn({
          addZone: (z) => {
            const id = `z${h.zoneSeq++}`;
            document.body.appendChild(z.domNode);
            h.zoneNodes.set(id, z.domNode);
            return id;
          },
          removeZone: (id) => {
            const n = h.zoneNodes.get(id);
            if (n) n.remove();
            h.zoneNodes.delete(id);
          },
        });
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

const savedFiles = h.savedFiles;

// MarkdownView stub (avoids react-markdown heavy render).
vi.mock("../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <span data-testid="md">{children}</span>,
}));

function selectLine(line: number) {
  act(() => {
    const e: SelEvent = {
      selection: { startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: 6 },
    };
    for (const cb of h.selectionHandlers) cb(e);
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
  for (const n of h.zoneNodes.values()) n.remove();
  h.zoneNodes.clear();
  h.zoneSeq = 0;
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

    // Select new-side line 2 → floating "+ Comment" button → open composer → add.
    selectLine(2);
    await waitFor(() => expect(screen.getByTestId("add-comment-floating")).toBeTruthy());
    fireEvent.click(screen.getByTestId("add-comment-floating"));
    await waitFor(() => expect(screen.getByTestId("comment-composer")).toBeTruthy());
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "remove line two" } });
    fireEvent.click(screen.getByTestId("add-comment"));

    // Thread renders inline as a view zone (status Open); header shows the count.
    await waitFor(() => expect(screen.getByTestId("thread-status")).toBeTruthy());
    expect(screen.getByTestId("thread-status").textContent).toBe("Open");
    expect(screen.getByTestId("open-count").textContent).toContain("1 open");
    // No bottom composer stays open and no right-hand comments panel exists.
    expect(screen.queryByTestId("comment-composer")).toBeNull();
    expect(screen.queryByTestId("comments-panel")).toBeNull();
  });

  it("surfaces an agent reply after clicking Sync, then resolve + complete", async () => {
    const backend = new MemoryBackend();
    backend.seedReviewDiff([{ path: "a.js", status: "M" }]);
    backend.seedReviewDiffSides("a.js", { before: "x\n", after: "x\ny\n" });
    renderTile(backend);

    await screen.findByTestId("review-picker");
    fireEvent.click(screen.getByTestId("create-review"));
    await waitFor(() => expect(screen.getByTestId("diff-editor")).toBeTruthy());

    selectLine(2);
    await screen.findByTestId("add-comment-floating");
    fireEvent.click(screen.getByTestId("add-comment-floating"));
    await screen.findByTestId("comment-composer");
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "fix this" } });
    fireEvent.click(screen.getByTestId("add-comment"));
    await waitFor(() => expect(screen.getByTestId("thread-status")).toBeTruthy());

    // Agent replies out-of-band. With polling removed, the reply only appears
    // after the reviewer clicks the manual Sync button.
    const review = await backend.getActiveReview("ws-1");
    const comments = await backend.listReviewComments("ws-1", review!.id);
    backend.simulateAgentReply(review!.id, comments[0].id, "done");
    expect(screen.queryByTestId("thread-reply")).toBeNull();
    fireEvent.click(screen.getByTestId("sync-review"));
    await waitFor(() => expect(screen.getByTestId("thread-reply")).toBeTruthy());
    expect(screen.getByTestId("attention-badge")).toBeTruthy(); // open + addressed

    // Resolve (inline in the view zone) → Complete becomes available → complete.
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
