import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import WorkbenchTile from "../WorkbenchTile";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
const fileEditorRenderMock = vi.hoisted(() => vi.fn());
const fileEditorState = vi.hoisted(() => ({ nextInstanceId: 0 }));

// Per-test in-memory Workbench store. Seeded by renderWorkbench(files).
const workbenchBacking = vi.hoisted(() => new Map<string, string>());
vi.mock("../../domain/workbench-store-instance", async () => {
  const { createWorkbenchStore } = await import("../../domain/workbench-store");
  return {
    workbenchStore: createWorkbenchStore({
      getSetting: async (key: string) => workbenchBacking.get(key) ?? null,
      setSetting: async (key: string, value: string) => { workbenchBacking.set(key, value); },
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value: string }) => <div data-testid="monaco-readonly">{value}</div>,
}));

vi.mock("../AudioPlayer", () => ({
  default: ({ path }: { path: string }) => <div data-testid="audio-player">{path}</div>,
}));

vi.mock("../../files/FileEditorView", async () => {
  const React = await import("react");
  return {
    FileEditorView: (props: {
      path: string;
      onSnapshotChange?: (snapshot: unknown) => void;
      renderMarkdownPreview?: (content: string) => ReactNode;
    }) => {
      const [instanceId] = React.useState(() => {
        fileEditorState.nextInstanceId += 1;
        return fileEditorState.nextInstanceId;
      });

      React.useEffect(() => {
        fileEditorRenderMock({ path: props.path, instanceId, hasPreview: Boolean(props.renderMarkdownPreview) });
      }, [instanceId, props.path, props.renderMarkdownPreview]);

      return (
        <div data-testid="file-editor-view" data-path={props.path} data-instance-id={instanceId}>
          <button
            type="button"
            onClick={() => props.onSnapshotChange?.({ path: props.path, dirty: true, state: "dirty" })}
          >
            Make dirty
          </button>
          <div data-testid="markdown-preview-probe">{props.renderMarkdownPreview?.("# Preview")}</div>
        </div>
      );
    },
  };
});

function renderWorkbench(files: string[], backend = new MemoryBackend()) {
  // Seed the per-workstream persisted file list.
  workbenchBacking.set("workbench:ws-1", JSON.stringify(files));

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <BackendProvider backend={backend}>{children}</BackendProvider>
  );

  const view = render(
    <WorkbenchTile
      tileId="tile-1"
      isFocused={false}
      configJson="{}"
      onConfigChange={vi.fn()}
      workstreamId="ws-1"
    />,
    { wrapper: Wrapper },
  );

  return { ...view, backend };
}

beforeEach(() => {
  workbenchBacking.clear();
  // The path_exists check fires once per file; default to "exists" so the
  // existing assertions don't trip the stale-warning UI.
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "path_exists") return true;
    return "AA==";
  });
  listenMock.mockResolvedValue(vi.fn());
  fileEditorRenderMock.mockClear();
  fileEditorState.nextInstanceId = 0;
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:workbench-media");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkbenchTile editable files", () => {
  it("opens TypeScript files in FileEditorView", async () => {
    renderWorkbench(["C:\\repo\\src\\file.ts"]);

    fireEvent.click(await screen.findByText("file.ts"));

    const editor = await screen.findByTestId("file-editor-view");
    expect(editor.getAttribute("data-path")).toBe("C:\\repo\\src\\file.ts");
    expect(screen.queryByTestId("monaco-readonly")).toBeNull();
  });

  it("opens Markdown files in FileEditorView and wires the preview renderer", async () => {
    renderWorkbench(["C:\\repo\\README.md"]);

    fireEvent.click(await screen.findByText("README.md"));

    await screen.findByTestId("file-editor-view");
    await waitFor(() => expect(fileEditorRenderMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "C:\\repo\\README.md", hasPreview: true }),
    ));
    expect(screen.getByText("Preview")).toBeTruthy();
  });

  it("keeps audio files on AudioPlayer instead of FileEditorView", async () => {
    renderWorkbench(["C:\\repo\\clip.mp3"]);

    fireEvent.click(await screen.findByText("clip.mp3"));

    expect(await screen.findByTestId("audio-player")).toBeTruthy();
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });

  it("keeps image files on the image preview branch instead of FileEditorView", async () => {
    renderWorkbench(["C:\\repo\\image.png"]);

    fireEvent.click(await screen.findByText("image.png"));

    const image = await screen.findByTestId("workbench-image-preview") as HTMLImageElement;
    expect(image.src).toBe("data:image/png;base64,AA==");
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });

  it("shows a dirty indicator when the editor snapshot becomes dirty", async () => {
    renderWorkbench(["C:\\repo\\src\\file.ts"]);

    fireEvent.click(await screen.findByText("file.ts"));
    fireEvent.click(await screen.findByText("Make dirty"));

    expect((await screen.findByTestId("workbench-dirty-indicator")).textContent).toContain("*");
  });

  it("remounts FileEditorView when switching files", async () => {
    renderWorkbench(["C:\\repo\\src\\first.ts", "C:\\repo\\src\\second.ts"]);

    fireEvent.click(await screen.findByText("first.ts"));
    const firstEditor = await screen.findByTestId("file-editor-view");
    const firstInstanceId = firstEditor.getAttribute("data-instance-id");

    fireEvent.click(screen.getByTestId("workbench-go-to-list"));
    fireEvent.click(screen.getByText("second.ts"));
    const secondEditor = await screen.findByTestId("file-editor-view");

    expect(secondEditor.getAttribute("data-path")).toBe("C:\\repo\\src\\second.ts");
    expect(secondEditor.getAttribute("data-instance-id")).not.toBe(firstInstanceId);
  });

  it("persists files across tile close + reopen (per workstream)", async () => {
    const { unmount } = renderWorkbench(["C:\\repo\\persisted.ts"]);
    expect(await screen.findByText("persisted.ts")).toBeTruthy();
    // Simulate the user closing the Workbench tile.
    unmount();

    // Reopen a brand-new Workbench tile in the same workstream.
    render(
      <BackendProvider backend={new MemoryBackend()}>
        <WorkbenchTile
          tileId="tile-2"
          isFocused={false}
          configJson="{}"
          onConfigChange={vi.fn()}
          workstreamId="ws-1"
        />
      </BackendProvider>,
    );

    // The persisted file is restored from the store.
    expect(await screen.findByText("persisted.ts")).toBeTruthy();
  });

  it("renders a stale-warning icon when a persisted file is missing on disk", async () => {
    // Override the default 'exists' mock for this test only.
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "path_exists") {
        return args?.path !== "C:\\repo\\missing.ts";
      }
      return "AA==";
    });
    renderWorkbench(["C:\\repo\\ok.ts", "C:\\repo\\missing.ts"]);

    const rows = await screen.findAllByTestId("workbench-file-row");
    expect(rows).toHaveLength(2);
    await waitFor(() => {
      const missingRow = rows.find((r) => r.getAttribute("data-path") === "C:\\repo\\missing.ts");
      expect(missingRow?.getAttribute("data-stale")).toBe("true");
    });
    expect(screen.getAllByTestId("workbench-file-stale-icon")).toHaveLength(1);
  });
});
