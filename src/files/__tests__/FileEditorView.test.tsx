import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileEditorView } from "../FileEditorView";
import type { BufferSnapshot, FileBufferRegistry } from "../FileBufferRegistry";
import { ConflictResolutionModal } from "../ConflictResolutionModal";
import { loadMonaco } from "../loadMonaco";

const conflictModalMock = vi.hoisted(() => vi.fn());
const loadMonacoMock = vi.hoisted(() => vi.fn());
const fakeEditors = vi.hoisted(() => [] as FakeEditor[]);

vi.mock("../ConflictResolutionModal", () => ({
  ConflictResolutionModal: conflictModalMock,
}));

vi.mock("../loadMonaco", () => ({
  loadMonaco: loadMonacoMock,
}));

// Stub SlideDeck so present-mode tests stay focused on FileEditorView wiring
// (real SlideDeck renders MarkdownView). Echo the source + a nav button.
vi.mock("../../ui/components/SlideDeck", () => ({
  SlideDeck: ({ source, slideIndex, onIndexChange }: { source: string; slideIndex: number; onIndexChange: (i: number) => void }) => (
    <div data-testid="slide-deck-stub" data-index={slideIndex}>
      <div data-testid="slide-source">{source}</div>
      <button data-testid="slide-stub-next" onClick={() => onIndexChange(slideIndex + 1)}>next</button>
    </div>
  ),
}));

type SnapshotListener = (snapshot: BufferSnapshot) => void;

type FakeModel = {
  value: string;
  getValue: ReturnType<typeof vi.fn>;
};

type FakeEditor = {
  options: Record<string, unknown>;
  layout: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  revealLineInCenter: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
};

function snapshot(overrides: Partial<BufferSnapshot> = {}): BufferSnapshot {
  return {
    path: "C:\\repo\\src\\file.ts",
    state: "clean",
    dirty: false,
    lineEnding: "lf",
    hasTrailingNewline: true,
    sniffedBinary: false,
    sizeBytes: 12,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRegistryHarness(options: { acquireDeferred?: boolean; initialSnapshot?: BufferSnapshot } = {}) {
  const canonicalPath = options.initialSnapshot?.path ?? "C:\\repo\\src\\file.ts";
  let currentSnapshot = options.initialSnapshot ?? snapshot({ path: canonicalPath });
  const listeners = new Set<SnapshotListener>();
  const unsubscribe = vi.fn(() => undefined);
  const model: FakeModel = {
    value: "initial content",
    getValue: vi.fn(() => model.value),
  };
  const acquireDeferred = deferred<BufferSnapshot>();

  const registry: FileBufferRegistry = {
    acquire: vi.fn(() => (options.acquireDeferred ? acquireDeferred.promise : Promise.resolve(currentSnapshot))),
    release: vi.fn(),
    subscribe: vi.fn((_path: string, listener: SnapshotListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    }),
    getSnapshot: vi.fn(() => currentSnapshot),
    getModel: vi.fn(() => model as never),
    save: vi.fn(() => Promise.resolve()),
    resolveConflict: vi.fn(() => Promise.resolve()),
    retrySave: vi.fn(() => Promise.resolve()),
    setAutoSaveEnabled: vi.fn(),
    listAll: vi.fn(() => [currentSnapshot]),
    _disposeAllForTests: vi.fn(),
  };

  const emit = (next: BufferSnapshot) => {
    currentSnapshot = next;
    for (const listener of listeners) listener(next);
  };

  return { registry, canonicalPath, acquireDeferred, emit, model, unsubscribe };
}

function renderEditor(
  harness = createRegistryHarness(),
  props: Partial<React.ComponentProps<typeof FileEditorView>> = {},
) {
  const onBack = vi.fn();
  const view = render(
    <FileEditorView path="input-path" onBack={onBack} registry={harness.registry} {...props} />,
  );
  return { ...view, onBack, ...harness };
}

beforeEach(() => {
  fakeEditors.length = 0;
  conflictModalMock.mockImplementation((props: React.ComponentProps<typeof ConflictResolutionModal>) => {
    if (!props.open) return null;
    return (
      <div data-testid="conflict-modal">
        <div data-testid="conflict-file-name">{props.fileName}</div>
        <div data-testid="conflict-disk-content">{props.diskContent}</div>
        <div data-testid="conflict-mine-content">{props.mineContent}</div>
        <div data-testid="conflict-language">{props.language}</div>
        <button onClick={props.onKeepMine}>Keep my version</button>
        <button onClick={props.onTakeDisk}>Take disk version</button>
        <button onClick={props.onCancel}>Cancel</button>
      </div>
    );
  });
  loadMonacoMock.mockResolvedValue({
    editor: {
      create: vi.fn((_element: HTMLElement, options: Record<string, unknown>) => {
        const editor: FakeEditor = {
          options,
          layout: vi.fn(),
          dispose: vi.fn(),
          revealLineInCenter: vi.fn(),
          setPosition: vi.fn(),
        };
        fakeEditors.push(editor);
        return editor;
      }),
      setModelLanguage: vi.fn(),
    },
  });
  class ResizeObserverMock {
    observe = vi.fn();
    disconnect = vi.fn();
  }
  class IntersectionObserverMock {
    observe = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("FileEditorView", () => {
  it("renders a loading placeholder before acquire resolves", () => {
    const harness = createRegistryHarness({ acquireDeferred: true });

    renderEditor(harness);

    expect(screen.getByText("Loading file…")).toBeTruthy();
    expect(screen.getByTestId("file-editor-view").dataset.fileEditorRoot).toBe("true");
  });

  it("renders Monaco editor after acquiring a TypeScript file", async () => {
    renderEditor();

    await waitFor(() => expect(loadMonaco).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fakeEditors).toHaveLength(1));

    expect(screen.getByTestId("file-editor-monaco")).toBeTruthy();
    expect(fakeEditors[0].options).toMatchObject({ theme: "vs-dark", readOnly: false });
    expect(fakeEditors[0].options.model).toBeTruthy();
  });

  it("reveals the requested line when initialRevealLine is provided", async () => {
    renderEditor(createRegistryHarness(), { initialRevealLine: 7 });

    await waitFor(() => expect(fakeEditors).toHaveLength(1));
    await waitFor(() => expect(fakeEditors[0].revealLineInCenter).toHaveBeenCalledWith(7));
    expect(fakeEditors[0].setPosition).toHaveBeenCalledWith({ lineNumber: 7, column: 1 });
  });

  it("does not reveal a line when initialRevealLine is omitted", async () => {
    renderEditor();
    await waitFor(() => expect(fakeEditors).toHaveLength(1));
    expect(fakeEditors[0].revealLineInCenter).not.toHaveBeenCalled();
  });

  it("renders markdown preview first when a renderer is provided", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\README.md" }),
    });

    renderEditor(harness, { renderMarkdownPreview: (content: string) => <article>Preview: {content}</article> });

    expect(await screen.findByText("Preview: initial content")).toBeTruthy();
    expect(screen.queryByTestId("file-editor-monaco")).toBeNull();
  });

  it("switches markdown preview to editor when Edit is clicked", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\README.md" }),
    });

    renderEditor(harness, { renderMarkdownPreview: (content: string) => <article>Preview: {content}</article> });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    await waitFor(() => expect(fakeEditors).toHaveLength(1));
    expect(screen.getByTestId("file-editor-monaco")).toBeTruthy();
  });

  it("renders an SVG preview (no markdown renderer needed) for .svg files", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\icon.svg" }),
    });

    renderEditor(harness);

    const preview = await screen.findByTestId("svg-preview");
    expect(preview).toBeTruthy();
    expect(screen.queryByTestId("file-editor-monaco")).toBeNull();
  });

  it("switches SVG preview to the text editor when Edit is clicked", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\icon.svg" }),
    });

    renderEditor(harness);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    await waitFor(() => expect(fakeEditors).toHaveLength(1));
    expect(screen.getByTestId("file-editor-monaco")).toBeTruthy();
  });

  it("enters present mode for a markdown file and renders SlideDeck from the live buffer", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\deck.md" }),
    });
    harness.model.value = "# Slide A\n\n---\n\n# Slide B";
    let latest: { canPresent?: boolean; enterPresent?: () => void } | null = null;
    renderEditor(harness, { onViewStateChange: (s) => { latest = s as typeof latest; } });

    await screen.findByText(/initial|Slide A/, undefined, { timeout: 2000 }).catch(() => {});
    await waitFor(() => expect(latest?.canPresent).toBe(true));
    act(() => { latest!.enterPresent!(); });

    const deck = await screen.findByTestId("slide-deck-stub");
    expect(deck).toBeTruthy();
    expect(screen.getByTestId("slide-source").textContent).toContain("# Slide A");
    expect(screen.queryByTestId("file-editor-monaco")).toBeNull();
  });

  it("does not offer present for SVG files", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\icon.svg" }),
    });
    let latest: { canPresent?: boolean } | null = null;
    renderEditor(harness, { onViewStateChange: (s) => { latest = s as typeof latest; } });

    // SVG emits a view-state (preview/edit) but never canPresent.
    await waitFor(() => expect(latest).not.toBeNull());
    expect(latest!.canPresent ?? false).toBe(false);
  });

  it("exits present back to preview on Escape", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\deck.md" }),
    });
    let latest: { canPresent?: boolean; enterPresent?: () => void; mode?: string } | null = null;
    renderEditor(harness, {
      renderMarkdownPreview: (content: string) => <article>Preview: {content}</article>,
      onViewStateChange: (s) => { latest = s as typeof latest; },
    });

    await waitFor(() => expect(latest?.canPresent).toBe(true));
    act(() => { latest!.enterPresent!(); });
    expect(await screen.findByTestId("slide-deck-stub")).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId("slide-deck-stub").closest("[data-testid='file-editor-view']") ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("slide-deck-stub")).toBeNull());
  });

  it("keeps markdown in preview mode when the buffer becomes dirty (user can manually toggle)", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\README.md" }),
    });

    renderEditor(harness, { renderMarkdownPreview: (content: string) => <article>Preview: {content}</article> });
    expect(await screen.findByText("Preview: initial content")).toBeTruthy();

    act(() => {
      harness.emit(snapshot({ path: "C:\\repo\\README.md", state: "dirty", dirty: true }));
    });

    // Stay in preview — no Monaco editor should be mounted yet.
    expect(screen.queryByTestId("file-editor-monaco")).toBeNull();
    expect(screen.getByText(/Preview:/)).toBeTruthy();
  });

  it("still forces editor mode when the buffer enters conflicted state", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\README.md" }),
    });

    renderEditor(harness, { renderMarkdownPreview: (content: string) => <article>Preview: {content}</article> });
    expect(await screen.findByText("Preview: initial content")).toBeTruthy();

    act(() => {
      harness.emit(snapshot({
        path: "C:\\repo\\README.md",
        state: "conflicted",
        dirty: true,
        conflictingDiskContent: "disk version",
        conflictingDiskHash: "h",
      }));
    });

    await waitFor(() => expect(fakeEditors).toHaveLength(1));
    expect(screen.getByTestId("file-editor-monaco")).toBeTruthy();
  });

  it("emits view state to onViewStateChange so a parent toolbar can render the toggle", async () => {
    const onViewStateChange = vi.fn();
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\README.md" }),
    });
    renderEditor(harness, {
      renderMarkdownPreview: (content: string) => <article>Preview: {content}</article>,
      onViewStateChange,
    });
    await screen.findByText("Preview: initial content");
    // Look at the most recent (non-null) emission.
    const findLastEmission = (): { mode: "preview" | "edit"; toggle: () => void } | undefined => {
      const calls = onViewStateChange.mock.calls as Array<[unknown]>;
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i][0] !== null) return calls[i][0] as { mode: "preview" | "edit"; toggle: () => void };
      }
      return undefined;
    };
    const lastCall = findLastEmission();
    expect(lastCall?.mode).toBe("preview");
    expect(typeof lastCall?.toggle).toBe("function");

    // Calling the emitted toggle flips to edit, which mounts Monaco.
    act(() => { lastCall!.toggle(); });
    await waitFor(() => expect(fakeEditors).toHaveLength(1));

    // And another emission reflects the new mode.
    const afterToggle = findLastEmission();
    expect(afterToggle?.mode).toBe("edit");
  });

  it("renders a too large or binary message with a back button", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ sniffedBinary: true, lastError: "Binary files cannot be edited" }),
    });

    const { onBack } = renderEditor(harness);

    expect(await screen.findByText("This file is too large or appears to be binary. Open in another editor.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Back" })[1]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+S saves the buffer", async () => {
    const { registry } = renderEditor();

    await screen.findByTestId("file-editor-view");
    fireEvent.keyDown(screen.getByTestId("file-editor-view"), { key: "s", ctrlKey: true });

    await waitFor(() => expect(registry.save).toHaveBeenCalledWith("C:\\repo\\src\\file.ts"));
  });

  it("Ctrl+Shift+V toggles preview <-> edit for markdown files", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\README.md" }),
    });
    renderEditor(harness, {
      renderMarkdownPreview: (content: string) => <article>Preview: {content}</article>,
    });
    await screen.findByText("Preview: initial content");
    expect(fakeEditors).toHaveLength(0);

    // Ctrl+Shift+V → edit mode mounts Monaco.
    fireEvent.keyDown(screen.getByTestId("file-editor-view"), { key: "v", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(fakeEditors).toHaveLength(1));

    // Ctrl+Shift+V again → back to preview.
    fireEvent.keyDown(screen.getByTestId("file-editor-view"), { key: "v", ctrlKey: true, shiftKey: true });
    await screen.findByText("Preview: initial content");
  });

  it("Ctrl+Shift+V is a no-op for non-markdown files", async () => {
    const { registry } = renderEditor();
    await screen.findByTestId("file-editor-view");
    // No throw; save not called either.
    fireEvent.keyDown(screen.getByTestId("file-editor-view"), { key: "v", ctrlKey: true, shiftKey: true });
    expect(registry.save).not.toHaveBeenCalled();
  });

  it("opens conflict modal with the current conflict contents", async () => {
    const harness = createRegistryHarness();
    harness.model.value = "mine text";
    renderEditor(harness);
    await waitFor(() => expect(harness.registry.subscribe).toHaveBeenCalledTimes(1));

    act(() => {
      harness.emit(snapshot({
        state: "conflicted",
        dirty: true,
        conflictingDiskContent: "disk text",
      }));
    });

    expect(await screen.findByTestId("conflict-modal")).toBeTruthy();
    expect(screen.getByTestId("conflict-file-name").textContent).toBe("file.ts");
    expect(screen.getByTestId("conflict-disk-content").textContent).toBe("disk text");
    expect(screen.getByTestId("conflict-mine-content").textContent).toBe("mine text");
    expect(screen.getByTestId("conflict-language").textContent).toBe("typescript");
  });

  it("Keep mine resolves the conflict and saves", async () => {
    const { registry, emit } = renderEditor();
    await waitFor(() => expect(registry.subscribe).toHaveBeenCalledTimes(1));
    act(() => {
      emit(snapshot({ state: "conflicted", dirty: true, conflictingDiskContent: "disk" }));
    });

    fireEvent.click(await screen.findByRole("button", { name: "Keep my version" }));

    await waitFor(() => expect(registry.resolveConflict).toHaveBeenCalledWith("C:\\repo\\src\\file.ts", "keep_mine"));
    expect(registry.save).toHaveBeenCalledWith("C:\\repo\\src\\file.ts");
  });

  it("Take disk resolves the conflict without saving", async () => {
    const { registry, emit } = renderEditor();
    await waitFor(() => expect(registry.subscribe).toHaveBeenCalledTimes(1));
    act(() => {
      emit(snapshot({ state: "conflicted", dirty: true, conflictingDiskContent: "disk" }));
    });

    fireEvent.click(await screen.findByRole("button", { name: "Take disk version" }));

    await waitFor(() => expect(registry.resolveConflict).toHaveBeenCalledWith("C:\\repo\\src\\file.ts", "take_disk"));
    expect(registry.save).not.toHaveBeenCalled();
  });

  it("Back button calls onBack", async () => {
    const { onBack } = renderEditor();

    fireEvent.click(await screen.findByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("unmount releases the canonical path", async () => {
    const view = renderEditor();
    await screen.findByTestId("file-editor-view");

    view.unmount();

    expect(view.registry.release).toHaveBeenCalledWith("C:\\repo\\src\\file.ts");
  });

  it("unsubscribes from snapshots on unmount", async () => {
    const view = renderEditor();
    await screen.findByTestId("file-editor-view");

    view.unmount();

    expect(view.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports snapshot changes and null on unmount", async () => {
    const onSnapshotChange = vi.fn();
    const view = renderEditor(undefined, { onSnapshotChange });
    await screen.findByTestId("file-editor-view");
    await waitFor(() => expect(view.registry.subscribe).toHaveBeenCalledTimes(1));

    act(() => {
      view.emit(snapshot({ state: "dirty", dirty: true }));
    });
    view.unmount();

    expect(onSnapshotChange).toHaveBeenCalledWith(expect.objectContaining({ state: "clean" }));
    expect(onSnapshotChange).toHaveBeenCalledWith(expect.objectContaining({ state: "dirty" }));
    expect(onSnapshotChange).toHaveBeenLastCalledWith(null);
  });

  it("does not confirm dangerous paths on open", async () => {
    const showDangerousPathConfirm = vi.fn(() => Promise.resolve(true));
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\.git\\config" }),
    });

    renderEditor(harness, { showDangerousPathConfirm });
    await screen.findByTestId("file-editor-view");

    expect(showDangerousPathConfirm).not.toHaveBeenCalled();
  });

  it("prompts before explicit save on dangerous paths and aborts when canceled", async () => {
    const showDangerousPathConfirm = vi.fn(() => Promise.resolve(false));
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\.git\\hooks\\pre-commit" }),
    });

    renderEditor(harness, { showDangerousPathConfirm });
    await screen.findByTestId("file-editor-view");
    fireEvent.keyDown(screen.getByTestId("file-editor-view"), { key: "s", ctrlKey: true });

    await waitFor(() => expect(showDangerousPathConfirm).toHaveBeenCalledTimes(1));
    expect(harness.registry.save).not.toHaveBeenCalled();
  });

  it("remembers confirmed dangerous warning keys", async () => {
    const showDangerousPathConfirm = vi.fn(() => Promise.resolve(true));
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\other\\.git\\config" }),
    });

    renderEditor(harness, { showDangerousPathConfirm });
    await screen.findByTestId("file-editor-view");
    fireEvent.keyDown(screen.getByTestId("file-editor-view"), { key: "s", ctrlKey: true });
    await waitFor(() => expect(harness.registry.save).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(screen.getByTestId("file-editor-view"), { key: "s", ctrlKey: true });
    await waitFor(() => expect(harness.registry.save).toHaveBeenCalledTimes(2));

    expect(showDangerousPathConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables registry auto-save for dangerous paths", async () => {
    const harness = createRegistryHarness({
      initialSnapshot: snapshot({ path: "C:\\repo\\node_modules\\pkg\\index.js" }),
    });

    renderEditor(harness);
    await screen.findByTestId("file-editor-view");

    expect(harness.registry.setAutoSaveEnabled).toHaveBeenCalledWith(
      "C:\\repo\\node_modules\\pkg\\index.js",
      false,
    );
  });
});
