import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

async function seed() {
  const backend = new MemoryBackend();
  const ws = await backend.createWorkstream("Courses", "/c");
  const other = await backend.createWorkstream("Infra", "/i");
  const tile = await backend.createTile(ws.id, "copilot_session", "Videos", JSON.stringify({ copilot_session_id: "s1" }));
  const second = await backend.createTile(other.id, "copilot_session", "CI", "{}");
  const terminal = await backend.createTile(ws.id, "terminal", "Shell", "{}");
  return { backend, ws, other, tile, second, terminal };
}

const daily = { kind: "daily", time: "09:00" } as const;
const input = (tileId: string, workstreamId: string) => ({
  tileId, workstreamId, prompt: "Check for new videos", frequency: daily, notifyInbox: false, notifyPhone: false, nextRunAt: null, createdAt: 1,
});

describe("periodic schedules in the in-memory backend (mirror of periodic_schedules.rs)", () => {
  it("creates one schedule per Copilot session tile with the native refusals", async () => {
    const { backend, ws, other, tile, second, terminal } = await seed();
    const created = await backend.createSchedule(input(tile.id, ws.id));
    expect(created).toMatchObject({ tile_id: tile.id, workstream_id: ws.id, paused: false, failures: 0, next_run_at: null, notify_inbox: false, notify_phone: false });
    await expect(backend.createSchedule(input(tile.id, ws.id))).rejects.toThrow("already has a schedule");
    await expect(backend.createSchedule(input(terminal.id, ws.id))).rejects.toThrow("Copilot session");
    await expect(backend.createSchedule(input(second.id, ws.id))).rejects.toThrow("not in workstream");
    await expect(backend.createSchedule(input("nope", ws.id))).rejects.toThrow("No tile");
    await expect(backend.createSchedule({ ...input(second.id, other.id), frequency: { kind: "interval", minutes: 1 } })).rejects.toThrow("5 minutes");
    await expect(backend.createSchedule({ ...input(second.id, other.id), prompt: " " })).rejects.toThrow("empty");
    expect(await backend.listSchedules()).toHaveLength(1);
  });

  it("updates state and edits, validating like the native side", async () => {
    const { backend, ws, tile } = await seed();
    const { id } = await backend.createSchedule(input(tile.id, ws.id));
    const updated = await backend.updateSchedule(id, { prompt: "New", paused: true, failures: 2, next_run_at: 5, last_result: "timed out" });
    expect(updated).toMatchObject({ prompt: "New", paused: true, failures: 2, next_run_at: 5, last_result: "timed out" });
    await expect(backend.updateSchedule(id, { frequency: { kind: "interval", minutes: 2 } })).rejects.toThrow("5 minutes");
    await expect(backend.updateSchedule(id, { prompt: "" })).rejects.toThrow("empty");
    await expect(backend.updateSchedule("nope", {})).rejects.toThrow("No schedule");
    // A returned copy can't change the stored one.
    updated.prompt = "mutated";
    expect((await backend.listSchedules())[0].prompt).toBe("New");
  });

  it("bumps a revision on every change and refuses a stale expected one (finding 4)", async () => {
    const { backend, ws, tile } = await seed();
    const { id, revision } = await backend.createSchedule(input(tile.id, ws.id));
    expect(revision).toBe(0);
    const claimed = await backend.updateSchedule(id, { last_result: "running" }, 0);
    expect(claimed.revision).toBe(1);
    await backend.updateSchedule(id, { paused: true });
    await expect(backend.updateSchedule(id, { last_result: "running" }, 1)).rejects.toThrow("changed");
    await backend.updateWorkstream(ws.id, { status: "archived" });
    expect((await backend.listSchedules())[0].revision).toBe(3);
    backend.agentScheduleForTests(id, "run");
    expect((await backend.listSchedules())[0].run_requested_at).toEqual(expect.any(Number));
  });

  it("stores an auto-pause and its Inbox entry together or neither (round 3, finding 4)", async () => {
    const { backend, ws, tile } = await seed();
    const { id } = await backend.createSchedule(input(tile.id, ws.id));
    await expect(backend.updateSchedule(id, { paused: true }, undefined, { title: "x".repeat(200), body: "" })).rejects.toThrow("title");
    expect((await backend.listSchedules())[0].paused).toBe(false);
    await backend.updateSchedule(id, { paused: true }, undefined, { title: "Schedule paused: Check", body: "3 failures" });
    expect((await backend.listSchedules())[0].paused).toBe(true);
    expect((await backend.getPrInbox()).agent_messages!.map((m) => [m.title, m.tile_id])).toEqual([["Schedule paused: Check", tile.id]]);
  });

  it("follows its tile and workstream: close deletes, archive pauses, delete keeps the tile", async () => {
    const { backend, ws, other, tile, second } = await seed();
    await backend.createSchedule(input(tile.id, ws.id));
    const kept = await backend.createSchedule(input(second.id, other.id));
    await backend.updateWorkstream(other.id, { status: "archived" });
    await backend.updateWorkstream(other.id, { status: "active" });
    expect((await backend.listSchedules()).find((s) => s.id === kept.id)?.paused).toBe(true);
    await backend.deleteTile(tile.id);
    expect((await backend.listSchedules()).map((s) => s.tile_id)).toEqual([second.id]);
    await backend.deleteSchedule(kept.id);
    expect(await backend.listSchedules()).toEqual([]);
    expect((await backend.listTiles(other.id)).map((t) => t.id)).toEqual([second.id]);
    await backend.createSchedule(input(second.id, other.id));
    await backend.deleteWorkstream(other.id);
    expect(await backend.listSchedules()).toEqual([]);
  });

  it("posts app Inbox entries past the agent cap", async () => {
    const { backend, ws, tile } = await seed();
    for (let i = 0; i < 20; i++) backend.postAgentMessage(ws.id, tile.id, "info", `m${i}`);
    await backend.postAppInboxMessage(ws.id, tile.id, "error", "Schedule paused", "3 failures");
    expect((await backend.getPrInbox()).agent_messages![0]).toMatchObject({ title: "Schedule paused", level: "error", workstream_name: "Courses" });
    await expect(backend.postAppInboxMessage(ws.id, tile.id, "urgent", "x", "")).rejects.toThrow("info, done");
  });
});
