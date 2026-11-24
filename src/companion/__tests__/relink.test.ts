import { describe, it, expect, vi } from "vitest";
import { relinkTile } from "../relink";
import { MemoryBackend } from "../../backend/memory-backend";

describe("re-linking a tile to another Copilot session", () => {
  it("changes the link and revokes the phone thread in one call (round 3, finding 3)", async () => {
    const backend = new MemoryBackend();
    const ws = await backend.createWorkstream("W", "/w");
    const tile = await backend.createTile(ws.id, "copilot_session", "T", JSON.stringify({ copilot_session_id: "s-old" }));
    await backend.companionRecordSession({ tileId: tile.id, workstreamId: ws.id, requestId: "r", prompt: "p", createdAt: 0 });
    const revoke = vi.spyOn(backend, "companionRevokeSession");
    const tell = vi.fn();
    expect(await relinkTile(backend, tile.id, JSON.stringify({ copilot_session_id: "s-new" }), "New", tell)).toBe(true);
    expect(revoke).not.toHaveBeenCalledWith(tile.id);
    const [stored] = await backend.listTiles(ws.id);
    expect(stored).toMatchObject({ title: "New", config_json: JSON.stringify({ copilot_session_id: "s-new" }) });
    expect((await backend.companionListSessions())[0].canSend).toBe(false);
    // A resume of the old session can't claim it or start it now.
    await expect(backend.companionClaimSession({ tileId: tile.id, workstreamId: ws.id, requestId: "r2", prompt: "p", createdAt: 1 }, "s-old"))
      .rejects.toThrow("different Copilot session");
    await expect(backend.spawnCopilotSession(tile.id, "/w", "s-old")).rejects.toThrow("different Copilot session");
    await backend.spawnCopilotSession(tile.id, "/w", "s-new");
    expect(tell).not.toHaveBeenCalled();
  });

  it("leaves the tile as it was and says why when the re-link fails", async () => {
    const backend = { relinkTileSession: vi.fn(async () => { throw new Error("database is locked"); }) };
    const tell = vi.fn();
    expect(await relinkTile(backend, "t1", "{}", undefined, tell)).toBe(false);
    expect(tell).toHaveBeenCalledWith("The session was not linked: database is locked");
  });
});
