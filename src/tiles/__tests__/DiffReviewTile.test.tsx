import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import DiffReviewTile, { parseHunksForDiffEditor } from "../DiffReviewTile";
import {
  DIFF_REVIEW_EVENTS,
  type DiffChunk,
  type DiffHunk,
  type DiffReview,
} from "../../domain/diff-review";

const listenMock = vi.hoisted(() => vi.fn());
const eventHandlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

interface FakeModel {
  value: string;
  setValue: ReturnType<typeof vi.fn>;
  getValue: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeEditor {
  options: Record<string, unknown>;
  setModel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getModifiedEditor: ReturnType<typeof vi.fn>;
  emitCursorSelection: (start: number, end: number) => void;
}

const fakeModels: FakeModel[] = [];
const fakeEditors: FakeEditor[] = [];

function createFakeModel(value: string): FakeModel {
  const m: FakeModel = {
    value,
    setValue: vi.fn((v: string) => { m.value = v; }),
    getValue: vi.fn(() => m.value),
    dispose: vi.fn(),
  };
  fakeModels.push(m);
  return m;
}

function createFakeEditor(options: Record<string, unknown>): FakeEditor {
  let selectionHandler: ((event: { selection: { startLineNumber: number; endLineNumber: number } }) => void) | null = null;
  const modifiedEditor = {
    onDidChangeCursorSelection: vi.fn((cb) => {
      selectionHandler = cb;
    }),
  };
  const editor: FakeEditor = {
    options,
    setModel: vi.fn(),
    dispose: vi.fn(),
    getModifiedEditor: vi.fn(() => modifiedEditor),
    emitCursorSelection: (start, end) => {
      selectionHandler?.({ selection: { startLineNumber: start, endLineNumber: end } });
    },
  };
  fakeEditors.push(editor);
  return editor;
}

const fakeMonaco = {
  editor: {
    createDiffEditor: vi.fn((_c: HTMLElement, opts: Record<string, unknown>) => createFakeEditor(opts)),
    createModel: vi.fn((value: string, _language?: string) => createFakeModel(value)),
    setModelLanguage: vi.fn(),
  },
};

vi.mock("../../files/loadMonaco", () => ({
  loadMonaco: vi.fn(() => Promise.resolve(fakeMonaco)),
  getMonacoIfLoaded: () => fakeMonaco,
}));

function makeReview(id = "rev-1"): DiffReview {
  return {
    id,
    workstream_id: "ws-1",
    diff_source: "branch",
    source_ref: "main",
    status: "active",
    plan_json: null,
    exported_path: null,
    created_at: "t",
    updated_at: "t",
    completed_at: null,
  };
}

function makeChunk(overrides: Partial<DiffChunk> = {}): DiffChunk {
  return {
    id: "c1",
    review_id: "rev-1",
    ordinal: 1,
    title: "Add debug logs",
    summary: "Inserts debug logs in the auth middleware",
    is_trivial: false,
    state: "pending",
    question_text: "Why log here at debug?",
    question_style: "socratic",
    invalidated_at: null,
    created_at: "t",
    updated_at: "t",
    ...overrides,
  };
}

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    id: "h1",
    chunk_id: "c1",
    file_path: "src/auth/mw.ts",
    old_start: 40,
    old_lines: 3,
    new_start: 40,
    new_lines: 5,
    patch_text: [" const x = 1;", "-old", "+new1", "+new2", " trailing"].join("\n"),
    content_hash: "h",
    ...overrides,
  };
}

function seedBackend(backend: MemoryBackend, chunkStates: Array<Partial<DiffChunk>> = [{}]) {
  const review = makeReview();
  const chunks = chunkStates.map((s, i) => makeChunk({ id: `c${i + 1}`, ordinal: i + 1, ...s }));
  const hunks = [makeHunk({ chunk_id: chunks[0].id })];
  backend.seedDiffReview({ review, chunks, hunks });
  return { review, chunks, hunks };
}

function renderTile(backend: MemoryBackend, reviewId = "rev-1") {
  return render(
    <BackendProvider backend={backend}>
      <DiffReviewTile tileId="t1" isFocused={true} reviewId={reviewId} />
    </BackendProvider>,
  );
}

beforeEach(() => {
  fakeModels.length = 0;
  fakeEditors.length = 0;
  eventHandlers.clear();
  listenMock.mockReset();
  listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    eventHandlers.set(eventName, handler);
    return () => {
      eventHandlers.delete(eventName);
    };
  });
  vi.mocked(fakeMonaco.editor.createDiffEditor).mockClear();
  vi.mocked(fakeMonaco.editor.createModel).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("parseHunksForDiffEditor", () => {
  it("builds modified-line refs that map back to file line numbers", () => {
    const hunk = makeHunk({
      patch_text: [" ctx1", "-removed", "+added1", "+added2", " ctx2"].join("\n"),
    });
    const result = parseHunksForDiffEditor([hunk]);
    // Find an entry with file line numbers
    const refs = result.modifiedLineRefs.filter((r): r is { file: string; line: number } => r !== null);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0].file).toBe("src/auth/mw.ts");
    expect(refs[0].line).toBe(40); // ctx1 → first new line
  });

  it("returns empty strings for no hunks", () => {
    const result = parseHunksForDiffEditor([]);
    expect(result.originalText).toBe("");
    expect(result.modifiedText).toBe("");
    expect(result.modifiedLineRefs).toEqual([]);
  });
});

describe("DiffReviewTile", () => {
  it("renders progress, chunk counter, and tallies from backend state", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend, [
      { id: "c1", state: "approved" },
      { id: "c2", state: "pending" },
      { id: "c3", state: "pending" },
    ]);

    renderTile(backend);

    await waitFor(() => expect(screen.getByTestId("diff-review-counter").textContent).toMatch(/chunk \d+\/3/));
    const tallies = screen.getByTestId("diff-review-tallies");
    expect(tallies.textContent).toContain("1"); // approved
    expect(tallies.textContent).toContain("2"); // pending
  });

  it("creates the Monaco diff editor with vs-dark theme, inline mode, and file-detected language", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    renderTile(backend);

    await waitFor(() => expect(fakeMonaco.editor.createDiffEditor).toHaveBeenCalled());
    const opts = fakeMonaco.editor.createDiffEditor.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.theme).toBe("vs-dark");
    expect(opts.renderSideBySide).toBe(false);
    // src/auth/mw.ts → "typescript"
    const createdLanguages = fakeMonaco.editor.createModel.mock.calls.map((c) => c[1]);
    expect(createdLanguages.every((l) => l === "typescript")).toBe(true);
  });

  it("renders the active chunk's question text and style label", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    renderTile(backend);

    await waitFor(() => expect(screen.getByText("Why log here at debug?")).toBeTruthy());
    expect(screen.getByTestId("diff-review-question-style").textContent).toContain("socratic");
  });

  it("calls addComment on submit with the selected line range", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    const spy = vi.spyOn(backend, "addComment");

    renderTile(backend);

    await waitFor(() => expect(fakeEditors.length).toBeGreaterThan(0));

    // Simulate a Monaco selection that maps to a real file line.
    // Header is on line 1, ctx1 on line 2 → maps to file line 40.
    act(() => {
      fakeEditors[0].emitCursorSelection(2, 2);
    });

    fireEvent.change(screen.getByTestId("diff-review-comment-input"), {
      target: { value: "Log level should be info" },
    });

    fireEvent.click(screen.getByTestId("diff-review-add-comment"));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("c1", "src/auth/mw.ts", 40, 40, "Log level should be info");
  });

  it("uses the default anchor (first hunk) when no selection has been made", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    const spy = vi.spyOn(backend, "addComment");

    renderTile(backend);

    await waitFor(() => expect(screen.getByTestId("diff-review-anchor").textContent).toContain("src/auth/mw.ts"));

    fireEvent.change(screen.getByTestId("diff-review-comment-input"), {
      target: { value: "Nit" },
    });
    fireEvent.click(screen.getByTestId("diff-review-add-comment"));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const args = spy.mock.calls[0];
    expect(args[1]).toBe("src/auth/mw.ts");
    expect(args[4]).toBe("Nit");
  });

  it("calls ackChunk('approved') when the approve button is clicked", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    const spy = vi.spyOn(backend, "ackChunk");

    renderTile(backend);

    await waitFor(() => expect(screen.getByTestId("diff-review-approve")).toBeTruthy());
    fireEvent.click(screen.getByTestId("diff-review-approve"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("c1", "approved"));
  });

  it("calls ackChunk('commented') when 'Done with comments' is clicked", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    const spy = vi.spyOn(backend, "ackChunk");

    renderTile(backend);
    await waitFor(() => expect(screen.getByTestId("diff-review-commented-done")).toBeTruthy());
    fireEvent.click(screen.getByTestId("diff-review-commented-done"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("c1", "commented"));
  });

  it("re-renders when a diff-review:chunk-active event fires", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend, [
      { id: "c1", title: "First chunk" },
      { id: "c2", title: "Second chunk" },
    ]);
    // Seed hunks for c2
    backend.seedDiffReview({
      review: makeReview(),
      chunks: [makeChunk({ id: "c2", ordinal: 2, title: "Second chunk", question_text: "Q2" })],
      hunks: [makeHunk({ id: "h2", chunk_id: "c2", file_path: "src/b.ts" })],
    });

    renderTile(backend);
    await waitFor(() => expect(screen.getByTestId("diff-review-chunk-title").textContent).toBe("First chunk"));

    const handler = eventHandlers.get(DIFF_REVIEW_EVENTS.CHUNK_ACTIVE);
    expect(handler).toBeTruthy();
    await act(async () => {
      handler?.({ payload: { reviewId: "rev-1", chunkId: "c2", ordinal: 2 } });
    });

    await waitFor(() =>
      expect(screen.getByTestId("diff-review-chunk-title").textContent).toBe("Second chunk"),
    );
  });

  it("ignores chunk-active events for other reviews", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    renderTile(backend);
    await waitFor(() => expect(screen.getByTestId("diff-review-chunk-title")).toBeTruthy());

    const handler = eventHandlers.get(DIFF_REVIEW_EVENTS.CHUNK_ACTIVE);
    await act(async () => {
      handler?.({ payload: { reviewId: "other", chunkId: "c2", ordinal: 99 } });
    });
    expect(screen.getByTestId("diff-review-chunk-title").textContent).toBe("Add debug logs");
  });

  it("shows the drift banner when a drift-detected event fires", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    renderTile(backend);
    await waitFor(() => expect(screen.getByTestId("diff-review-tile")).toBeTruthy());

    const handler = eventHandlers.get(DIFF_REVIEW_EVENTS.DRIFT_DETECTED);
    await act(async () => {
      handler?.({ payload: { reviewId: "rev-1", chunkIds: ["c1"] } });
    });

    await waitFor(() => expect(screen.getByTestId("diff-review-drift-banner")).toBeTruthy());
    expect(screen.getByTestId("diff-review-drift-banner").textContent).toContain("1 chunk");

    fireEvent.click(screen.getByTestId("diff-review-drift-refetch"));
    await waitFor(() => expect(screen.queryByTestId("diff-review-drift-banner")).toBeNull());
  });

  it("shows the completed overlay when a completed event fires", async () => {
    const backend = new MemoryBackend();
    seedBackend(backend);
    renderTile(backend);
    await waitFor(() => expect(screen.getByTestId("diff-review-tile")).toBeTruthy());

    const handler = eventHandlers.get(DIFF_REVIEW_EVENTS.COMPLETED);
    await act(async () => {
      handler?.({ payload: { reviewId: "rev-1", exportedPath: ".copilot-reviews/rev-1/review.json" } });
    });

    await waitFor(() => expect(screen.getByTestId("diff-review-completed-overlay")).toBeTruthy());
    expect(screen.getByTestId("diff-review-completed-overlay").textContent).toContain(".copilot-reviews/rev-1");
  });

  it("renders existing comments anchored to lines outside the current selection", async () => {
    const backend = new MemoryBackend();
    const review = makeReview();
    const chunk = makeChunk();
    const hunk = makeHunk();
    backend.seedDiffReview({
      review,
      chunks: [chunk],
      hunks: [hunk],
      comments: [
        {
          id: "cm1",
          chunk_id: chunk.id,
          anchor_file: "src/other.ts",
          anchor_line_start: 100,
          anchor_line_end: 101,
          text: "Existing note",
          created_at: "t",
        },
      ],
    });

    renderTile(backend);

    await waitFor(() => expect(screen.getByTestId("diff-review-comment-cm1")).toBeTruthy());
    expect(screen.getByTestId("diff-review-comment-cm1").textContent).toContain("src/other.ts");
    expect(screen.getByTestId("diff-review-comment-cm1").textContent).toContain("Existing note");
  });

  it("surfaces backend errors when refresh fails", async () => {
    const backend = new MemoryBackend();
    // No seeded review → listChunks returns []. Force an error by stubbing listChunks.
    vi.spyOn(backend, "listChunks").mockRejectedValue(new Error("nope"));
    renderTile(backend, "bogus");
    await waitFor(() => expect(screen.getByTestId("diff-review-error")).toBeTruthy());
  });
});
