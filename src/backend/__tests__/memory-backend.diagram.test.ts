import { afterEach, describe, expect, it } from "vitest";
import { MemoryBackend } from "../memory-backend";
import { applyDemoSeed } from "../demo-seed";

describe("MemoryBackend diagram boards", () => {
  afterEach(() => { delete (window as unknown as { __WS_EMIT__?: unknown }).__WS_EMIT__; });

  it("creates boards in order per tile, renames, saves scenes and deletes", async () => {
    const backend = new MemoryBackend();
    const a = await backend.diagramCreateBoard("t1", "Board 1");
    const b = await backend.diagramCreateBoard("t1", " Ideas ");
    await backend.diagramCreateBoard("t2", "Elsewhere");
    expect((await backend.diagramListBoards("t1")).map((x) => [x.name, x.position])).toEqual([["Board 1", 0], ["Ideas", 1]]);
    await backend.diagramRenameBoard(a.id, "Flow");
    await backend.diagramSaveScene(b.id, '{"elements":[{"id":"x"}],"files":{}}');
    const [first, second] = await backend.diagramListBoards("t1");
    expect(first.name).toBe("Flow");
    expect(second.scene_json).toContain('"x"');
    await expect(backend.diagramSaveScene(b.id, "nope")).rejects.toThrow();
    await expect(backend.diagramCreateBoard("t1", "  ")).rejects.toThrow();
    await backend.diagramDeleteBoard(b.id);
    expect(await backend.diagramListBoards("t1")).toHaveLength(1);
  });

  it("queues agent additions with an announcement, resolves them, and drops boards with their tile", async () => {
    const emitted: Array<[string, unknown]> = [];
    (window as unknown as { __WS_EMIT__: (e: string, p?: unknown) => void }).__WS_EMIT__ = (e, p) => emitted.push([e, p]);
    const backend = new MemoryBackend();
    const ws = await backend.createWorkstream("W", "/w");
    const tile = await backend.createTile(ws.id, "diagram", "Diagram", "{}");
    const board = await backend.diagramCreateBoard(tile.id, "Board 1");
    const one = backend.queueDiagramAddition(board.id, "flowchart LR\nA-->B");
    const two = backend.queueDiagramAddition(board.id, "bad");
    expect(emitted[0]).toEqual(["state-changed", { entity: "diagram", id: board.id, action: "addition_queued" }]);
    await backend.diagramResolveAddition(one.id, null);
    await backend.diagramResolveAddition(two.id, "Parse error");
    expect(await backend.diagramAdditions(board.id)).toEqual([expect.objectContaining({ id: two.id, status: "failed", error: "Parse error" })]);
    await backend.deleteTile(tile.id);
    expect(await backend.diagramListBoards(tile.id)).toEqual([]);
    expect(await backend.diagramAdditions(board.id)).toEqual([]);
  });

  it("seeds Diagram boards with their scenes", async () => {
    const backend = new MemoryBackend();
    await applyDemoSeed(backend, {
      workstreams: [{ name: "W", directory: "/w", tiles: [{ type: "diagram", title: "D", boards: [{ name: "Ideas", scene: { elements: [{ id: "a" }], files: {} } }, { name: "Empty" }] }] }],
    });
    const [ws] = await backend.listWorkstreams();
    const [tile] = await backend.listTiles(ws.id);
    const boards = await backend.diagramListBoards(tile.id);
    expect(boards.map((b) => b.name)).toEqual(["Ideas", "Empty"]);
    expect(JSON.parse(boards[0].scene_json).elements).toEqual([{ id: "a" }]);
  });
});
