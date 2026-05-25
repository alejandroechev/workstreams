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
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <BackendProvider backend={backend}>{children}</BackendProvider>
  );

  const view = render(
    <WorkbenchTile
      tileId="tile-1"
      isFocused={false}
      configJson={JSON.stringify({ files })}
      onConfigChange={vi.fn()}
    />,
    { wrapper: Wrapper },
  );

  return { ...view, backend };
}

beforeEach(() => {
  invokeMock.mockResolvedValue("AA==");
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

    fireEvent.click(screen.getByText("file.ts"));

    const editor = await screen.findByTestId("file-editor-view");
    expect(editor.getAttribute("data-path")).toBe("C:\\repo\\src\\file.ts");
    expect(screen.queryByTestId("monaco-readonly")).toBeNull();
  });

  it("opens Markdown files in FileEditorView and wires the preview renderer", async () => {
    renderWorkbench(["C:\\repo\\README.md"]);

    fireEvent.click(screen.getByText("README.md"));

    await screen.findByTestId("file-editor-view");
    await waitFor(() => expect(fileEditorRenderMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "C:\\repo\\README.md", hasPreview: true }),
    ));
    expect(screen.getByText("Preview")).toBeTruthy();
  });

  it("keeps audio files on AudioPlayer instead of FileEditorView", async () => {
    renderWorkbench(["C:\\repo\\clip.mp3"]);

    fireEvent.click(screen.getByText("clip.mp3"));

    expect(await screen.findByTestId("audio-player")).toBeTruthy();
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });

  it("keeps image files on the image preview branch instead of FileEditorView", async () => {
    renderWorkbench(["C:\\repo\\image.png"]);

    fireEvent.click(screen.getByText("image.png"));

    const image = await screen.findByTestId("workbench-image-preview") as HTMLImageElement;
    expect(image.src).toBe("data:image/png;base64,AA==");
    expect(screen.queryByTestId("file-editor-view")).toBeNull();
  });

  it("shows a dirty indicator when the editor snapshot becomes dirty", async () => {
    renderWorkbench(["C:\\repo\\src\\file.ts"]);

    fireEvent.click(screen.getByText("file.ts"));
    fireEvent.click(await screen.findByText("Make dirty"));

    expect((await screen.findByTestId("workbench-dirty-indicator")).textContent).toContain("*");
  });

  it("remounts FileEditorView when switching files", async () => {
    renderWorkbench(["C:\\repo\\src\\first.ts", "C:\\repo\\src\\second.ts"]);

    fireEvent.click(screen.getByText("first.ts"));
    const firstEditor = await screen.findByTestId("file-editor-view");
    const firstInstanceId = firstEditor.getAttribute("data-instance-id");

    fireEvent.click(screen.getByText("Back"));
    fireEvent.click(screen.getByText("second.ts"));
    const secondEditor = await screen.findByTestId("file-editor-view");

    expect(secondEditor.getAttribute("data-path")).toBe("C:\\repo\\src\\second.ts");
    expect(secondEditor.getAttribute("data-instance-id")).not.toBe(firstInstanceId);
  });
});
