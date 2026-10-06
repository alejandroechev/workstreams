import { describe, it, expect, vi } from "vitest";
import { startPhoneSession, type StartSessionDeps } from "../start-session";
import { MemoryBackend } from "../../backend/memory-backend";

async function setup(guardFailsAt: "never" | "after-record" | "before-record" = "never") {
  const backend = new MemoryBackend();
  const ws = await backend.createWorkstream("Alpha", "/repo/alpha");
  const spawned: string[] = [];
  const events: string[] = [];
  const deps: StartSessionDeps = {
    backend,
    mount: vi.fn(async () => {}),
    workstream: (id) => (id === ws.id ? ws : undefined),
    defaultCwd: () => "/home",
    onTileCreated: (tile) => events.push(`tile:${tile.id}`),
    onRecorded: () => events.push("recorded"),
    markSpawned: (id) => spawned.push(id),
    spawn: vi.fn(async () => {}),
  };
  let recorded = false;
  const record = backend.companionRecordSession.bind(backend);
  backend.companionRecordSession = async (s) => { await record(s); recorded = true; };
  const guard = () => {
    if (guardFailsAt === "after-record" && recorded) throw new Error("expired");
    if (guardFailsAt === "before-record" && events.length === 0 && (backend as unknown as { tiles: Map<string, unknown> }).tiles.size > 0) throw new Error("stopped");
  };
  return { backend, ws, deps, guard, spawned, events };
}

describe("starting a phone session", () => {
  it("creates the tile, records it as a phone session, then spawns the agent on the prompt", async () => {
    const { backend, ws, deps, guard, spawned, events } = await setup();
    await startPhoneSession(deps, { workstreamId: ws.id, command: "copilot", prompt: "Do x", guard, requestId: "r1", now: 5 });
    const [tile] = (await backend.listTiles(ws.id)).filter((t) => t.tile_type === "copilot_session");
    expect(await backend.companionListSessions()).toMatchObject([{ tileId: tile.id, workstreamId: ws.id, requestId: "r1", prompt: "Do x", createdAt: 5 }]);
    expect(JSON.parse((await backend.getLayout(ws.id)).tile_order_json)).toContain(tile.id);
    expect(deps.spawn).toHaveBeenCalledWith(tile.id, "/repo/alpha", "copilot", "Do x");
    expect(spawned).toEqual([tile.id]);
    expect(events).toEqual(["recorded", `tile:${tile.id}`]);
  });

  it("checks the guard after recording: a refused launch leaves no tile, no layout entry and no phone session", async () => {
    const { backend, ws, deps, guard, spawned } = await setup("after-record");
    await expect(startPhoneSession(deps, { workstreamId: ws.id, command: "c", prompt: "p", guard, requestId: "r", now: 1 })).rejects.toThrow("expired");
    expect((await backend.listTiles(ws.id)).filter((t) => t.tile_type === "copilot_session")).toEqual([]);
    expect(JSON.parse((await backend.getLayout(ws.id)).tile_order_json || "[]")).toEqual([]);
    expect(await backend.companionListSessions()).toEqual([]);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
  });

  it("cleans up when recording itself fails", async () => {
    const { backend, ws, deps, guard } = await setup();
    backend.companionRecordSession = async () => { throw new Error("db locked"); };
    await expect(startPhoneSession(deps, { workstreamId: ws.id, command: "c", prompt: "p", guard, requestId: "r", now: 1 })).rejects.toThrow("db locked");
    expect((await backend.listTiles(ws.id)).filter((t) => t.tile_type === "copilot_session")).toEqual([]);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("checks the guard after creating the tile, before recording", async () => {
    const { backend, ws, deps, guard } = await setup("before-record");
    await expect(startPhoneSession(deps, { workstreamId: ws.id, command: "c", prompt: "p", guard, requestId: "r", now: 1 })).rejects.toThrow("stopped");
    expect((await backend.listTiles(ws.id)).filter((t) => t.tile_type === "copilot_session")).toEqual([]);
    expect(await backend.companionListSessions()).toEqual([]);
  });
});
