import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

async function seed() {
  const backend = new MemoryBackend();
  const ws = await backend.createWorkstream("Courses", "/c");
  const other = await backend.createWorkstream("Infra", "/i");
  const tile = await backend.createTile(ws.id, "periodic_session", "Videos", "{}");
  const second = await backend.createTile(other.id, "periodic_session", "CI", "{}");
  const terminal = await backend.createTile(ws.id, "terminal", "Shell", "{}");
  const chat = await backend.createTile(ws.id, "copilot_session", "Chat", JSON.stringify({ copilot_session_id: "s1" }));
  return { backend, ws, other, tile, second, terminal, chat };
}

const daily = { kind: "daily", time: "09:00" } as const;
const input = (tileId: string, workstreamId: string) => ({
  tileId, workstreamId, prompt: "Check for new videos", frequency: daily, notifyInbox: false, notifyPhone: false, nextRunAt: null, createdAt: 1,
});

describe("periodic schedules in the in-memory backend (mirror of periodic_schedules.rs)", () => {
  it("creates one schedule per Periodic session tile, on its session, with the native refusals", async () => {
    const { backend, ws, other, tile, second, terminal, chat } = await seed();
    const created = await backend.createSchedule({ ...input(tile.id, ws.id), sessionId: "s1" });
    expect(created).toMatchObject({ tile_id: tile.id, workstream_id: ws.id, paused: false, failures: 0, next_run_at: null, notify_inbox: false, notify_phone: false });
    expect(created).toMatchObject({ session_id: "s1", session_started: false, interactive_tile_id: chat.id });
    await expect(backend.createSchedule(input(tile.id, ws.id))).rejects.toThrow("already has a schedule");
    await expect(backend.createSchedule(input(terminal.id, ws.id))).rejects.toThrow("Periodic session");
    await expect(backend.createSchedule(input(chat.id, ws.id))).rejects.toThrow("Periodic session");
    await expect(backend.createSchedule(input(second.id, ws.id))).rejects.toThrow("not in workstream");
    await expect(backend.createSchedule(input("nope", ws.id))).rejects.toThrow("No tile");
    await expect(backend.createSchedule({ ...input(second.id, other.id), frequency: { kind: "interval", minutes: 1 } })).rejects.toThrow("5 minutes");
    await expect(backend.createSchedule({ ...input(second.id, other.id), prompt: " " })).rejects.toThrow("empty");
    expect(await backend.listSchedules()).toHaveLength(1);
  });

  it("updates state and edits, validating like the native side", async () => {
    const { backend, ws, tile } = await seed();
    const { id } = await backend.createSchedule(input(tile.id, ws.id));
    const updated = await backend.updateSchedule(id, { prompt: "New", paused: true, failures: 2, next_run_at: 5, last_result: "timed_out" });
    expect(updated).toMatchObject({ prompt: "New", paused: true, failures: 2, next_run_at: 5, last_result: "timed_out" });
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

  it("follows its tile and workstream: close deletes, archive pauses, delete removes the tile", async () => {
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
    expect(await backend.listTiles(other.id)).toEqual([]);
    const third = await backend.createTile(other.id, "periodic_session", "CI", "{}");
    await backend.createSchedule(input(third.id, other.id));
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

  it("runs headless: argv as the native runner builds it, one per tile, refused while open interactively (ADR 046)", async () => {
    const { backend, ws, tile, chat } = await seed();
    await backend.createSchedule({ ...input(tile.id, ws.id), sessionId: "S" });
    const start = { tileId: tile.id, kind: "scheduled" as const, prompt: "P", command: "my-copilot --yolo", cwd: "/c", startedAt: 10 };
    const first = await backend.startPeriodicRun(start);
    expect(first).toMatchObject({ status: "running", kind: "scheduled", prompt: "P" });
    await expect(backend.startPeriodicRun(start)).rejects.toThrow("already going");
    backend.periodicRunEventForTests(tile.id, { tool: { id: "c1", name: "bash", status: "running" } });
    const done = backend.finishPeriodicRunForTests(tile.id, { exitCode: 0, answer: "NEEDS INPUT: Which?" });
    expect(done).toMatchObject({ status: "needs_input", question: "Which?", tools: [{ id: "c1", name: "bash", status: "failed" }] });
    expect((await backend.listSchedules())[0].session_started).toBe(true);
    await backend.startPeriodicRun({ ...start, startedAt: 20 });
    backend.finishPeriodicRunForTests(tile.id, { exitCode: 1 });
    await backend.recordPeriodicSkip(tile.id, "manual", "P", 30);
    expect((await backend.listPeriodicRuns(tile.id)).map((r) => r.status)).toEqual(["skipped", "failed", "needs_input"]);
    expect(await backend.getPeriodicRun(first.id)).toMatchObject({ status: "needs_input" });
    await backend.updateTileConfig(chat.id, JSON.stringify({ copilot_session_id: "S" }));
    await expect(backend.startPeriodicRun({ ...start, startedAt: 40 })).rejects.toThrow("open interactively");
    backend.seedPeriodicRunsForTests(tile.id, 55, 100);
    expect(await backend.listPeriodicRuns(tile.id)).toHaveLength(50);
  });

  it("posts the app's own messages to a tile's phone thread, opening it once", async () => {
    const { backend, ws, tile } = await seed();
    await backend.companionPostAppMessage(tile.id, ws.id, "prompt", "Check", 1);
    await backend.companionPostAppMessage(tile.id, ws.id, "result", "All green", 2);
    const [thread] = await backend.companionListSessions();
    expect(thread).toMatchObject({ tileId: tile.id, prompt: "Videos" });
    expect(thread.messages.map((m) => [m.kind, m.text])).toEqual([["prompt", "Check"], ["result", "All green"]]);
  });
});
