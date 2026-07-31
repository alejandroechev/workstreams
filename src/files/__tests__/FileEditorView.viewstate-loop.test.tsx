/**
 * Regression test for the markdown CPU burn: FileEditorView's view-state
 * effect used to re-run on every host re-render (because hosts pass an inline
 * `renderMarkdownPreview`), and for markdown it emitted a brand-new
 * MarkdownViewState object each time. Hosts store that object in state, so a
 * new object => re-render => new inline prop => effect re-runs => ... an
 * unbounded render loop that pegged the WebView renderer at ~10% CPU.
 *
 * Non-markdown files were unaffected because the effect emits `null`, and
 * setState(null) when already null makes React bail out of the re-render.
 */
import { render, waitFor, cleanup } from "@testing-library/react";
import { useState, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileEditorView, type MarkdownViewState } from "../FileEditorView";
import type { BufferSnapshot, FileBufferRegistry } from "../FileBufferRegistry";
import { MarkdownView } from "../../ui/MarkdownView";

const loadMonacoMock = vi.hoisted(() => vi.fn());
vi.mock("../loadMonaco", () => ({ loadMonaco: loadMonacoMock }));
vi.mock("../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

type SnapshotListener = (snapshot: BufferSnapshot) => void;

function makeRegistry(path: string) {
  const snap: BufferSnapshot = {
    path,
    state: "clean",
    dirty: false,
    lineEnding: "lf",
    hasTrailingNewline: true,
    sniffedBinary: false,
    sizeBytes: 12,
  };
  const model = { getValue: vi.fn(() => "# hello") };
  return {
    acquire: vi.fn(() => Promise.resolve(snap)),
    release: vi.fn(),
    subscribe: vi.fn((_p: string, _l: SnapshotListener) => () => undefined),
    getSnapshot: vi.fn(() => snap),
    getModel: vi.fn(() => model as never),
    save: vi.fn(() => Promise.resolve()),
    resolveConflict: vi.fn(() => Promise.resolve()),
    retrySave: vi.fn(() => Promise.resolve()),
    setAutoSaveEnabled: vi.fn(),
    listAll: vi.fn(() => [snap]),
    _disposeAllForTests: vi.fn(),
  } as unknown as FileBufferRegistry;
}

/**
 * Mirrors exactly how the real tiles host the editor: an INLINE
 * `renderMarkdownPreview` arrow (new identity every render) plus the
 * `setEditorViewState` state setter, which is what triggered the loop.
 */
function TileHost({ path, onRender, mode }: { path: string; onRender: () => void; mode?: "edit" | "preview" }) {
  const [viewState, setEditorViewState] = useState<MarkdownViewState | null>(null);
  const registryRef = useRef(makeRegistry(path));
  onRender();
  // Mirror the tile toolbars: switch modes through the emitted view state.
  const switchedRef = useRef(false);
  if (mode && viewState && viewState.mode !== mode && !switchedRef.current) {
    switchedRef.current = true;
    queueMicrotask(() => viewState.setMode(mode));
  }
  return (
    <FileEditorView
      path={path}
      onBack={() => undefined}
      registry={registryRef.current}
      renderMarkdownPreview={(content) => <MarkdownView>{content}</MarkdownView>}
      onViewStateChange={setEditorViewState}
    />
  );
}

beforeEach(() => {
  loadMonacoMock.mockResolvedValue({
    editor: {
      create: vi.fn(() => ({
        layout: vi.fn(),
        dispose: vi.fn(),
        revealLineInCenter: vi.fn(),
        setPosition: vi.fn(),
        onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
        onDidScrollChange: vi.fn(() => ({ dispose: vi.fn() })),
        changeViewZones: vi.fn(),
      })),
      setModelLanguage: vi.fn(),
    },
  });
  class ObserverMock {
    observe = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", ObserverMock);
  vi.stubGlobal("IntersectionObserver", ObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("FileEditorView view-state stability (markdown CPU regression)", () => {
  it("settles to a stable render count for a MARKDOWN file (no runaway loop)", async () => {
    let renders = 0;
    render(<TileHost path="C:\\repo\\README.md" onRender={() => { renders += 1; }} />);

    // Let any loop run: wait for the editor to settle, then sample twice.
    await waitFor(() => expect(renders).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 150));
    const settled = renders;
    await new Promise((r) => setTimeout(r, 150));

    // A stable component stops re-rendering once idle. The buggy version kept
    // scheduling renders forever.
    expect(renders).toBe(settled);
    // And the total should be small — not hundreds of loop iterations.
    expect(renders).toBeLessThan(15);
  });

  it("settles for a NON-markdown file too (control)", async () => {
    let renders = 0;
    render(<TileHost path="C:\\repo\\app.ts" onRender={() => { renders += 1; }} />);

    await waitFor(() => expect(renders).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 150));
    const settled = renders;
    await new Promise((r) => setTimeout(r, 150));

    expect(renders).toBe(settled);
    expect(renders).toBeLessThan(15);
  });

  it("settles for a MARKDOWN file in EDIT mode too (user saw the burn in both modes)", async () => {
    let renders = 0;
    render(<TileHost path="C:\\repo\\README.md" mode="edit" onRender={() => { renders += 1; }} />);

    await waitFor(() => expect(renders).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 150));
    const settled = renders;
    await new Promise((r) => setTimeout(r, 150));

    expect(renders).toBe(settled);
    expect(renders).toBeLessThan(15);
  });
});
