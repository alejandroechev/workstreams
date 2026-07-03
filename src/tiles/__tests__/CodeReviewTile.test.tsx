import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import CodeReviewTile from "../CodeReviewTile";

// ── Mock the Monaco DiffEditor: capture onMount, expose a fake modified editor
// so we can simulate a new-side line selection without a real browser. ──
const selectionHandlers: Array<(e: { selection: { positionLineNumber: number } }) => void> = [];
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: { onMount?: (editor: unknown) => void; original: string; modified: string }) => {
    const modified = {
      onDidChangeCursorSelection: (cb: (e: { selection: { positionLineNumber: number } }) => void) => {
        selectionHandlers.push(cb);
      },
      getModel: () => ({ getLineContent: (n: number) => `line ${n} content` }),
      changeViewZones: (fn: (accessor: { addZone: () => string; removeZone: () => void }) => void) => {
        fn({ addZone: () => "z1", removeZone: () => {} });
      },
    };
    const editor = { getModifiedEditor: () => modified };
    props.onMount?.(editor);
    return <div data-testid="diff-editor" data-modified={props.modified} />;
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
});
