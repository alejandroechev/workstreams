import { describe, expect, it } from "vitest";
import {
  appendElements,
  emptyScene,
  expandSelection,
  liveElements,
  nextBoardName,
  parseExcalidrawFile,
  parseScene,
  placeBeside,
  sceneBounds,
  serializeScene,
  toExcalidrawClipboard,
  toExcalidrawFile,
  type SceneElement,
} from "../scene";

const rect = (id: string, x: number, y: number, extra: Partial<SceneElement> = {}): SceneElement =>
  ({ id, type: "rectangle", x, y, width: 100, height: 50, ...extra }) as SceneElement;

describe("diagram scenes", () => {
  it("parses stored scenes tolerantly and drops deleted elements when serializing", () => {
    expect(parseScene("not json")).toEqual(emptyScene());
    expect(parseScene('{"elements":"x"}')).toEqual(emptyScene());
    const img = { id: "i", type: "image", x: 0, y: 0, width: 1, height: 1, fileId: "f" } as SceneElement;
    const scene = parseScene(JSON.stringify({ elements: [rect("a", 0, 0), rect("b", 0, 0, { isDeleted: true }), img], files: { f: { id: "f" }, old: { id: "old" } } }));
    expect(liveElements(scene.elements).map((e) => e.id)).toEqual(["a", "i"]);
    const stored = JSON.parse(serializeScene(scene));
    expect(stored.elements.map((e: SceneElement) => e.id)).toEqual(["a", "i"]);
    // Image files no live image uses are not kept.
    expect(stored.files).toEqual({ f: { id: "f" } });
  });

  it("writes and reads Excalidraw's own file format", () => {
    const text = toExcalidrawFile({ elements: [rect("a", 0, 0), rect("gone", 0, 0, { isDeleted: true })], files: {} });
    const json = JSON.parse(text);
    expect(json).toMatchObject({ type: "excalidraw", version: 2, source: "workstreams", appState: { viewBackgroundColor: "#ffffff" } });
    expect(json.elements).toHaveLength(1);
    const back = parseExcalidrawFile(text);
    expect(back.ok && back.scene.elements.map((e) => e.id)).toEqual(["a"]);
    expect(parseExcalidrawFile("{}").ok).toBe(false);
    expect(parseExcalidrawFile("nope").ok).toBe(false);
    const empty = parseExcalidrawFile("");
    expect(empty.ok && empty.scene.elements).toEqual([]);
  });

  it("puts the board (or the selection) on the clipboard as Excalidraw clipboard data", () => {
    const scene = { elements: [rect("a", 0, 0), rect("b", 200, 0)], files: {} };
    expect(JSON.parse(toExcalidrawClipboard(scene))).toMatchObject({ type: "excalidraw/clipboard", elements: [{ id: "a" }, { id: "b" }] });
    expect(JSON.parse(toExcalidrawClipboard(scene, ["b"])).elements.map((e: SceneElement) => e.id)).toEqual(["b"]);
  });

  it("places additions to the right of what is already there", () => {
    expect(sceneBounds([])).toBeNull();
    const existing = [rect("a", 10, 20), rect("b", 300, 100)];
    expect(sceneBounds(existing)).toEqual({ minX: 10, minY: 20, maxX: 400, maxY: 150 });
    const placed = placeBeside(existing, [rect("n", -50, -50), rect("m", 50, 0)]);
    expect(placed.map((e) => [e.x, e.y])).toEqual([[480, 20], [580, 70]]);
    expect(placeBeside([], [rect("n", 5, 5)])[0]).toMatchObject({ x: 5, y: 5 });
  });

  it("appends without ever replacing an existing element, renaming clashing ids everywhere they are referenced", () => {
    const existing = [rect("a", 0, 0), rect("b", 0, 0)];
    const added: SceneElement[] = [
      rect("a", 0, 0, { boundElements: [{ id: "t", type: "text" }, { id: "arr", type: "arrow" }] }),
      { id: "t", type: "text", x: 0, y: 0, width: 1, height: 1, containerId: "a" } as SceneElement,
      { id: "arr", type: "arrow", x: 0, y: 0, width: 1, height: 1, startBinding: { elementId: "a" }, endBinding: { elementId: "c" } } as SceneElement,
      rect("c", 0, 0, { groupIds: ["g"] }),
    ];
    const out = appendElements(existing, added);
    expect(out.slice(0, 2)).toEqual(existing);
    const renamed = out[2];
    expect(renamed.id).not.toBe("a");
    expect(new Set(out.map((e) => e.id)).size).toBe(out.length);
    expect(out[3].containerId).toBe(renamed.id);
    expect((out[4].startBinding as { elementId: string }).elementId).toBe(renamed.id);
    expect((out[4].endBinding as { elementId: string }).elementId).toBe("c");
    expect(out[5].id).toBe("c");
  });

  it("gives every appended batch its own groups, so two imports never join", () => {
    const first = appendElements([], [rect("a", 0, 0, { groupIds: ["subgraph_G"] }), rect("b", 0, 0, { groupIds: ["subgraph_G", "outer"] })]);
    const second = appendElements(first, [rect("c", 0, 0, { groupIds: ["subgraph_G"] })]);
    const groupsOf = (id: string) => second.find((e) => e.id === id)!.groupIds!;
    expect(groupsOf("a")[0]).toBe(groupsOf("b")[0]);
    expect(groupsOf("b")).toHaveLength(2);
    expect(groupsOf("c")[0]).not.toBe(groupsOf("a")[0]);
    expect(second.slice(0, 2)).toEqual(first);
  });

  it("copies a selected shape with its label and a selected frame with its contents", () => {
    const els = [
      rect("box", 0, 0),
      { id: "label", type: "text", x: 0, y: 0, width: 1, height: 1, containerId: "box" } as SceneElement,
      { id: "frame", type: "frame", x: 0, y: 0, width: 1, height: 1 } as SceneElement,
      rect("inside", 0, 0, { frameId: "frame" }),
      rect("other", 0, 0),
    ];
    expect(expandSelection(els, ["box"]).sort()).toEqual(["box", "label"]);
    expect(expandSelection(els, ["frame"]).sort()).toEqual(["frame", "inside"]);
    expect(JSON.parse(toExcalidrawClipboard({ elements: els, files: {} }, ["box"])).elements.map((e: SceneElement) => e.id)).toEqual(["box", "label"]);
  });

  it("names new boards Board N after the highest existing number", () => {
    expect(nextBoardName([])).toBe("Board 1");
    expect(nextBoardName(["Board 1", "Ideas", "Board 4"])).toBe("Board 5");
  });
});
