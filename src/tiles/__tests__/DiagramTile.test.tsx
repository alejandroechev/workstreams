import { StrictMode, useEffect, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import type { DiagramScene, SceneElement } from "../../diagram/scene";

const sceneOf = (s: DiagramScene | (() => DiagramScene)): DiagramScene => (typeof s === "function" ? s() : s);

const { listeners, mermaidToScene, paletteElements, invokeMock, saveMock, clipboardText } = vi.hoisted(() => ({
  listeners: [] as Array<(e: { payload: unknown }) => void>,
  mermaidToScene: vi.fn(),
  paletteElements: vi.fn(),
  invokeMock: vi.fn(async () => ({ hash_hex: "h" })),
  saveMock: vi.fn(async () => null as string | null),
  clipboardText: { value: "" },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.push(cb);
    return () => { listeners.splice(listeners.indexOf(cb), 1); };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeImage: vi.fn() }));
vi.mock("../../domain/clipboard", () => ({ writeTextToClipboard: vi.fn(async (t: string) => { clipboardText.value = t; }) }));
vi.mock("../../diagram/excalidraw-loader", () => ({
  loadExcalidraw: async () => ({
    CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY" },
    exportToSvg: async () => ({ outerHTML: "<svg/>" }),
    exportToBlob: async () => new Blob(["png"]),
  }),
  mermaidToScene,
  paletteElements,
}));

/** A stand-in Excalidraw: holds elements and exposes the imperative API the tile uses. */
interface FakeApi {
  elements: SceneElement[];
  getSceneElements(): SceneElement[];
  getSceneElementsIncludingDeleted(): SceneElement[];
  getFiles(): Record<string, unknown>;
  getAppState(): Record<string, unknown>;
  updateScene: ReturnType<typeof vi.fn>;
  addFiles: ReturnType<typeof vi.fn>;
}
const canvases: Array<{ props: ComponentProps<typeof import("../../diagram/DiagramCanvas").DiagramCanvas>; api: FakeApi }> = [];
vi.mock("../../diagram/DiagramCanvas", () => ({
  DiagramCanvas: (props: ComponentProps<typeof import("../../diagram/DiagramCanvas").DiagramCanvas>) => {
    useEffect(() => {
      const api: FakeApi = {
        elements: [...(sceneOf(props.initialScene).elements as SceneElement[])],
        getSceneElements() { return this.elements.filter((e) => !e.isDeleted); },
        getSceneElementsIncludingDeleted() { return this.elements; },
        getFiles: () => ({}),
        getAppState: () => ({ selectedElementIds: {}, scrollX: 0, scrollY: 0, width: 800, height: 600, zoom: { value: 1 } }),
        updateScene: vi.fn(),
        addFiles: vi.fn(),
      };
      api.updateScene.mockImplementation((scene: { elements: SceneElement[] }) => { api.elements = scene.elements; });
      canvases.push({ props, api });
      props.onApi?.(api as never);
      return () => props.onApi?.(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="fake-canvas" data-key={props.registryKey} data-count={sceneOf(props.initialScene).elements.length} />;
  },
}));

import DiagramTile from "../DiagramTile";

const rect = (id: string, x = 0): SceneElement => ({ id, type: "rectangle", x, y: 0, width: 100, height: 50 });
const lastCanvas = () => canvases[canvases.length - 1];

async function renderTile(backend: MemoryBackend, tileId = "t1", strict = false) {
  const onConfigChange = vi.fn();
  const tree = (
    <BackendProvider backend={backend}>
      <DiagramTile tileId={tileId} workstreamDir="/ws" configJson="{}" onConfigChange={onConfigChange} />
    </BackendProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  await screen.findAllByTestId("diagram-board-tab");
  await waitFor(() => expect(lastCanvas()).toBeTruthy());
  return { onConfigChange };
}

describe("DiagramTile", () => {
  beforeEach(() => {
    canvases.length = 0;
    listeners.length = 0;
    mermaidToScene.mockReset();
    paletteElements.mockReset();
    invokeMock.mockClear();
    saveMock.mockReset();
  });
  afterEach(() => cleanup());

  it("starts a new tile with exactly one board, even when effects run twice", async () => {
    const backend = new MemoryBackend();
    await renderTile(backend, "t1", true);
    expect((await backend.diagramListBoards("t1")).map((b) => b.name)).toEqual(["Board 1"]);
    expect(screen.getAllByTestId("diagram-board-tab")).toHaveLength(1);
  });

  it("saves the drawing, and keeps each board's own scene through add, rename, switch and delete", async () => {
    const backend = new MemoryBackend();
    const { onConfigChange } = await renderTile(backend);
    const [first] = await backend.diagramListBoards("t1");
    act(() => lastCanvas().props.onSceneChange({ elements: [rect("a")], files: {} }));
    await waitFor(async () => expect(JSON.parse((await backend.diagramListBoards("t1"))[0].scene_json).elements).toHaveLength(1));

    fireEvent.click(screen.getByTestId("diagram-board-add"));
    await waitFor(() => expect(screen.getAllByTestId("diagram-board-tab")).toHaveLength(2));
    await waitFor(() => expect(sceneOf(lastCanvas().props.initialScene).elements).toHaveLength(0));
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.stringContaining('"activeBoardId"'));
    fireEvent.doubleClick(screen.getAllByTestId("diagram-board-tab")[1]);
    fireEvent.change(screen.getByTestId("diagram-board-rename"), { target: { value: "Sequence" } });
    fireEvent.keyDown(screen.getByTestId("diagram-board-rename"), { key: "Enter" });
    await waitFor(async () => expect((await backend.diagramListBoards("t1")).map((b) => b.name)).toEqual(["Board 1", "Sequence"]));

    fireEvent.click(screen.getAllByTestId("diagram-board-tab")[0]);
    await waitFor(() => expect(lastCanvas().props.registryKey).toBe(`t1:${first.id}`));
    expect(sceneOf(lastCanvas().props.initialScene).elements.map((e) => e.id)).toEqual(["a"]);

    fireEvent.click(screen.getAllByTestId("diagram-board-tab")[1]);
    fireEvent.click(await screen.findByTestId("diagram-board-delete"));
    fireEvent.click(screen.getByTestId("diagram-board-delete-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("diagram-board-tab")).toHaveLength(1));
    expect(await backend.diagramListBoards("t1")).toHaveLength(1);
    // The last board cannot be deleted.
    expect(screen.queryByTestId("diagram-board-delete")).toBeNull();
  });

  it("draws an agent's queued Mermaid beside the user's shapes and resolves it; bad Mermaid is marked failed", async () => {
    const backend = new MemoryBackend();
    const board = await backend.diagramCreateBoard("t1", "Ideas");
    await backend.diagramSaveScene(board.id, JSON.stringify({ elements: [rect("mine", 0)], files: {} }));
    await renderTile(backend);
    mermaidToScene.mockImplementation(async (text: string) => {
      if (text === "bad") throw new Error("Parse error on line 1");
      return { elements: [rect("new", -500)], files: {} } satisfies DiagramScene;
    });
    backend.queueDiagramAddition(board.id, "flowchart LR\nA-->B");
    backend.queueDiagramAddition(board.id, "bad");
    act(() => listeners.forEach((l) => l({ payload: { entity: "diagram", id: board.id } })));
    await waitFor(async () => expect((await backend.diagramAdditions(board.id)).map((a) => a.status)).toEqual(["failed"]));
    const api = lastCanvas().api;
    expect(api.elements.map((e) => e.id)).toEqual(["mine", "new"]);
    expect(api.elements[0]).toEqual(rect("mine", 0));
    expect(api.elements[1].x).toBeGreaterThan(100);
    expect(JSON.parse((await backend.diagramListBoards("t1"))[0].scene_json).elements.map((e: SceneElement) => e.id)).toEqual(["mine", "new"]);
  });

  it("adds a queued addition for a board that is not on screen into its stored scene", async () => {
    const backend = new MemoryBackend();
    await backend.diagramCreateBoard("t1", "Shown");
    const hidden = await backend.diagramCreateBoard("t1", "Hidden");
    await backend.diagramSaveScene(hidden.id, JSON.stringify({ elements: [rect("old")], files: {} }));
    mermaidToScene.mockResolvedValue({ elements: [rect("added")], files: {} });
    backend.queueDiagramAddition(hidden.id, "flowchart LR\nA-->B");
    await renderTile(backend);
    await waitFor(async () => expect(await backend.diagramAdditions(hidden.id)).toEqual([]));
    const stored = JSON.parse((await backend.diagramListBoards("t1"))[1].scene_json);
    expect(stored.elements.map((e: SceneElement) => e.id)).toEqual(["old", "added"]);
  });

  it("shows a Mermaid parse error and changes nothing; a valid import lands on the canvas", async () => {
    const backend = new MemoryBackend();
    await renderTile(backend);
    mermaidToScene.mockRejectedValueOnce(new Error("Parse error on line 2"));
    fireEvent.click(screen.getByTestId("diagram-mermaid-open"));
    fireEvent.change(screen.getByTestId("diagram-mermaid-input"), { target: { value: "flowchart LR\n A[[[" } });
    fireEvent.click(screen.getByTestId("diagram-mermaid-import"));
    expect((await screen.findByTestId("diagram-mermaid-error")).textContent).toContain("Parse error on line 2");
    expect(lastCanvas().api.updateScene).not.toHaveBeenCalled();

    mermaidToScene.mockResolvedValueOnce({ elements: [rect("m")], files: {} });
    fireEvent.click(screen.getByTestId("diagram-mermaid-import"));
    await waitFor(() => expect(screen.queryByTestId("diagram-mermaid-dialog")).toBeNull());
    expect(lastCanvas().api.elements.map((e) => e.id)).toEqual(["m"]);
  });

  it("places palette shapes at the middle of the view", async () => {
    const backend = new MemoryBackend();
    await renderTile(backend);
    paletteElements.mockResolvedValue([rect("p", 0)]);
    fireEvent.click(screen.getByTestId("diagram-palette-toggle"));
    expect(screen.getAllByTestId("diagram-palette-group").map((g) => g.getAttribute("data-kind"))).toEqual(["Flow", "Sequence", "Class", "State"]);
    fireEvent.click(screen.getByText("Class box"));
    await waitFor(() => expect(lastCanvas().api.elements).toHaveLength(1));
    expect(lastCanvas().api.elements[0]).toMatchObject({ x: 350, y: 275 });
  });

  it("saves to a file through the system dialog, suggesting the workstream folder", async () => {
    const backend = new MemoryBackend();
    await renderTile(backend);
    lastCanvas().api.elements = [rect("a")];
    saveMock.mockResolvedValueOnce("/Users/me/Desktop/Board 1");
    fireEvent.mouseDown(screen.getByTestId("diagram-menu"));
    fireEvent.click(screen.getByTestId("diagram-menu"));
    fireEvent.click(screen.getByTestId("diagram-save-file"));
    await screen.findByText("Saved /Users/me/Desktop/Board 1.excalidraw");
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expect.stringMatching(/ws[\\/]Board 1\.excalidraw$/) }));
    const [, args] = (invokeMock.mock.calls as unknown as Array<[string, { args: { path: string; content: string } }]>).find(([cmd]) => cmd === "write_text_file")!;
    expect(args.args.path).toBe("/Users/me/Desktop/Board 1.excalidraw");
    expect(JSON.parse(args.args.content)).toMatchObject({ type: "excalidraw", elements: [{ id: "a" }] });

    // Cancelling the dialog writes nothing.
    invokeMock.mockClear();
    fireEvent.click(screen.getByTestId("diagram-menu"));
    fireEvent.click(screen.getByTestId("diagram-export-svg"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("diagram-menu"));
    fireEvent.click(screen.getByTestId("diagram-copy-excalidraw"));
    await waitFor(() => expect(JSON.parse(clipboardText.value).type).toBe("excalidraw/clipboard"));
  });
});
