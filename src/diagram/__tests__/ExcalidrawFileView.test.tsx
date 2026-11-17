import { useEffect, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, canvases } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  canvases: [] as Array<ComponentProps<typeof import("../DiagramCanvas").DiagramCanvas>>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../DiagramCanvas", () => ({
  DiagramCanvas: (props: ComponentProps<typeof import("../DiagramCanvas").DiagramCanvas>) => {
    useEffect(() => { canvases.push(props); }, [props]);
    return <div data-testid="fake-canvas" data-count={sceneOf(props.initialScene).elements.length} />;
  },
}));

import { ExcalidrawFileView } from "../ExcalidrawFileView";
import type { DiagramScene } from "../scene";

const sceneOf = (s: DiagramScene | (() => DiagramScene)): DiagramScene => (typeof s === "function" ? s() : s);

const FILE = JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 1, height: 1 }], appState: { viewBackgroundColor: "#fff" }, files: {} });

describe("ExcalidrawFileView", () => {
  beforeEach(() => {
    canvases.length = 0;
    invokeMock.mockReset();
  });
  afterEach(() => cleanup());

  it("shows the file as a canvas and writes edits back, keeping the file's own fields and checking the hash", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "read_text_file" ? { content: FILE, hash_hex: "h1" } : { hash_hex: "h2" }));
    render(<ExcalidrawFileView path="/r/flow.excalidraw" />);
    expect((await screen.findByTestId("fake-canvas")).getAttribute("data-count")).toBe("1");
    const props = canvases[canvases.length - 1];
    act(() => props.onSceneChange({ elements: [...sceneOf(props.initialScene).elements, { id: "t", type: "text", x: 0, y: 0, width: 1, height: 1, text: "label" }], files: {} }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("write_text_file", expect.anything()));
    const { args } = invokeMock.mock.calls.find(([cmd]) => cmd === "write_text_file")![1];
    expect(args.expected_hash_hex).toBe("h1");
    const written = JSON.parse(args.content);
    expect(written).toMatchObject({ type: "excalidraw", source: "https://excalidraw.com", appState: { viewBackgroundColor: "#fff" } });
    expect(written.elements.map((e: { id: string }) => e.id)).toEqual(["a", "t"]);

    act(() => props.onSceneChange({ elements: [], files: {} }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "write_text_file")).toHaveLength(2));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "write_text_file")[1][1].args.expected_hash_hex).toBe("h2");
  });

  it("drops edits queued before a reload, so they cannot overwrite the reloaded file", async () => {
    let releaseWrite!: () => void;
    let writes = 0;
    const writtenContent: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, payload: { args?: { content: string; expected_hash_hex: string } }) => {
      if (cmd === "read_text_file") return { content: FILE, hash_hex: `read-${writes}` };
      writes += 1;
      if (writes === 1) throw JSON.stringify({ kind: "ExternalModified" });
      if (writes === 2) await new Promise<void>((r) => { releaseWrite = r; });
      writtenContent.push(payload.args!.content);
      return { hash_hex: "after" };
    });
    render(<ExcalidrawFileView path="/r/flow.excalidraw" />);
    await screen.findByTestId("fake-canvas");
    const props = canvases[canvases.length - 1];
    act(() => props.onSceneChange({ elements: [], files: {} }));
    await screen.findByTestId("excalidraw-file-save-error");
    act(() => props.onSceneChange({ elements: [], files: {} }));
    act(() => props.onSceneChange({ elements: [], files: {} }));
    await waitFor(() => expect(writes).toBe(2));
    fireEvent.click(screen.getByText("Reload from disk"));
    await act(async () => { releaseWrite(); await new Promise((r) => setTimeout(r, 20)); });
    // The write in flight finished; the third (queued before the reload) never ran.
    expect(writes).toBe(2);
  });

  it("refuses a file that is not an Excalidraw drawing", async () => {
    invokeMock.mockResolvedValue({ content: '{"hello":1}', hash_hex: "h" });
    render(<ExcalidrawFileView path="/r/x.excalidraw" />);
    expect((await screen.findByTestId("excalidraw-file-error")).textContent).toContain("Not an Excalidraw file");
  });

  it("does not overwrite a file changed on disk, and offers to reload it", async () => {
    let reads = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_text_file") { reads += 1; return { content: FILE, hash_hex: "h1" }; }
      throw JSON.stringify({ kind: "ExternalModified", current_hash_hex: "zz" });
    });
    render(<ExcalidrawFileView path="/r/flow.excalidraw" />);
    await screen.findByTestId("fake-canvas");
    act(() => canvases[canvases.length - 1].onSceneChange({ elements: [], files: {} }));
    expect((await screen.findByTestId("excalidraw-file-save-error")).textContent).toContain("changed on disk");
    fireEvent.click(screen.getByText("Reload from disk"));
    await waitFor(() => expect(reads).toBe(2));
  });
});
