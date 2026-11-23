import { describe, expect, it, vi } from "vitest";
import { createScheduleRunner, type ScheduleRunnerDeps } from "../schedule-runner";
import { MemoryBackend } from "../../backend/memory-backend";
import { INBOX_INSTRUCTION, PHONE_INSTRUCTION, RUN_TIMEOUT_MS, type ScheduleFrequency } from "../periodic-schedules";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const MIN = 60_000;

async function setup(opts: { frequency?: ScheduleFrequency; prompt?: string; created?: number } = {}) {
  const backend = new MemoryBackend();
  const ws = await backend.createWorkstream("Courses", "/c");
  const tile = await backend.createTile(ws.id, "copilot_session", "Videos", JSON.stringify({ copilot_session_id: "S" }));
  const created = opts.created ?? at(2026, 11, 23, 8, 0);
  const schedule = await backend.createSchedule({
    tileId: tile.id, workstreamId: ws.id, prompt: opts.prompt ?? "Check for new videos", frequency: opts.frequency ?? { kind: "daily", time: "09:00" },
    notifyInbox: false, notifyPhone: false, nextRunAt: null, createdAt: created,
  });
  const busy = new Set<string>();
  const spawns: Array<{ tileId: string; prompt: string }> = [];
  const interrupts: string[] = [];
  let failResume: string | null = null;
  const deps: ScheduleRunnerDeps = {
    list: () => backend.listSchedules(),
    update: (id, patch) => backend.updateSchedule(id, patch),
    postInbox: (wsId, tileId, title, body) => backend.postAppInboxMessage(wsId, tileId, "error", title, body),
    workstreamName: (id) => (id === ws.id ? "Courses" : undefined),
    isBusy: (tileId) => busy.has(tileId),
    resume: vi.fn(async (s, prompt) => {
      if (failResume) throw new Error(failResume);
      spawns.push({ tileId: s.tile_id, prompt });
    }),
    interrupt: vi.fn(async (tileId) => { interrupts.push(tileId); }),
    onChange: vi.fn(),
  };
  const runner = createScheduleRunner(deps);
  const read = async () => (await backend.listSchedules()).find((s) => s.id === schedule.id)!;
  return { backend, ws, tile, schedule, busy, spawns, interrupts, deps, runner, read, failWith: (e: string | null) => { failResume = e; } };
}

describe("schedule runner", () => {
  it("plans a new schedule's first run at its first scheduled time, without running it now (AT-1)", async () => {
    const { runner, read, spawns } = await setup();
    await runner.tick(at(2026, 11, 23, 16, 42));
    expect((await read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
    expect(spawns).toEqual([]);
  });

  it("resumes the session once with exactly the prompt when due, and records the result (AT-3)", async () => {
    const { runner, read, spawns, deps } = await setup();
    await runner.tick(at(2026, 11, 23, 8, 30));
    await runner.tick(at(2026, 11, 23, 9, 0) + 10_000);
    await runner.tick(at(2026, 11, 23, 9, 0) + 20_000);
    expect(spawns).toEqual([{ tileId: expect.any(String), prompt: "Check for new videos" }]);
    expect(deps.resume).toHaveBeenCalledTimes(1);
    const s = await read();
    expect(s).toMatchObject({ last_result: "running", last_run_at: at(2026, 11, 23, 9, 0) + 10_000, next_run_at: at(2026, 11, 24, 9, 0) });
    expect(deps.onChange).toHaveBeenCalled();
  });

  it("records ok once the turn ends", async () => {
    const { runner, read, busy, tile } = await setup();
    await runner.tick(at(2026, 11, 23, 8, 30));
    await runner.tick(at(2026, 11, 23, 9, 0));
    busy.add(tile.id);
    await runner.tick(at(2026, 11, 23, 9, 1));
    expect((await read()).last_result).toBe("running");
    busy.delete(tile.id);
    await runner.tick(at(2026, 11, 23, 9, 5));
    expect((await read())).toMatchObject({ last_result: "ok", failures: 0 });
  });

  it("records ok for a turn too short to be seen busy, after a settling time", async () => {
    const { runner, read } = await setup();
    await runner.tick(at(2026, 11, 23, 8, 30));
    await runner.tick(at(2026, 11, 23, 9, 0));
    await runner.tick(at(2026, 11, 23, 9, 1));
    expect((await read()).last_result).toBe("running");
    await runner.tick(at(2026, 11, 23, 9, 3));
    expect((await read()).last_result).toBe("ok");
  });

  it("(AT-4.1) skips a run due while the agent is mid-turn, without interrupting", async () => {
    const { runner, read, spawns, busy, tile, interrupts } = await setup();
    await runner.tick(at(2026, 11, 23, 8, 30));
    busy.add(tile.id);
    await runner.tick(at(2026, 11, 23, 9, 0));
    expect(spawns).toEqual([]);
    expect(interrupts).toEqual([]);
    expect(await read()).toMatchObject({ last_result: "skipped", failures: 0, next_run_at: at(2026, 11, 24, 9, 0) });
  });

  it("(AT-4.2) runs even though the user typed in the tile a minute ago (typing isn't mid-turn)", async () => {
    const { runner, spawns } = await setup();
    await runner.tick(at(2026, 11, 23, 8, 30));
    await runner.tick(at(2026, 11, 23, 9, 0));
    expect(spawns).toHaveLength(1);
  });

  it("(AT-4.3) runs nothing at startup after the app was closed over the due time; next run is tomorrow 09:00", async () => {
    const { backend, schedule, deps, read, spawns } = await setup();
    await backend.updateSchedule(schedule.id, { next_run_at: at(2026, 11, 23, 9, 0) });
    // A fresh runner: the app started at 10:00.
    const runner = createScheduleRunner(deps);
    await runner.tick(at(2026, 11, 23, 10, 0));
    expect(spawns).toEqual([]);
    expect((await read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
  });

  it("(AT-6) sends the prompt verbatim, then with the Inbox, then with the phone instruction", async () => {
    const prompt = "  Check  the course\n\tfor new videos ";
    const { backend, schedule, runner, spawns } = await setup({ prompt, frequency: { kind: "interval", minutes: 60 }, created: 0 });
    expect(schedule.notify_inbox).toBe(false);
    expect(schedule.notify_phone).toBe(false);
    const runNow = async (now: number) => { await runner.runNow(schedule.id, now); await runner.tick(now + 5 * MIN); };
    await runNow(1_000_000);
    await backend.updateSchedule(schedule.id, { notify_inbox: true });
    await runNow(2_000_000);
    await backend.updateSchedule(schedule.id, { notify_inbox: false, notify_phone: true });
    await runNow(3_000_000);
    expect(spawns.map((s) => s.prompt)).toEqual([prompt, `${prompt}\n\n${INBOX_INSTRUCTION}`, `${prompt}\n\n${PHONE_INSTRUCTION}`]);
  });

  it("(AT-9) interrupts a run still going after 60 minutes, then auto-pauses after 3 consecutive failures, ignoring a skip", async () => {
    const { backend, runner, read, busy, tile, interrupts, failWith, spawns, schedule } = await setup({ frequency: { kind: "interval", minutes: 120 }, created: 0 });
    const due = (n: number) => n * 120 * MIN;
    await runner.tick(0);
    // Run 1: busy for over an hour → timed out.
    await runner.tick(due(1));
    busy.add(tile.id);
    await runner.tick(due(1) + 30 * MIN);
    expect(interrupts).toEqual([]);
    await runner.tick(due(1) + RUN_TIMEOUT_MS);
    expect(interrupts).toEqual([tile.id]);
    expect(await read()).toMatchObject({ last_result: "timed out", failures: 1, paused: false });
    // Interrupted: the session is left idle, the tile still there.
    busy.delete(tile.id);
    expect((await backend.listTiles(schedule.workstream_id)).map((t) => t.id)).toEqual([tile.id]);
    // Run 2: could not start (unlinked).
    failWith("This tile isn't linked to a Copilot session yet");
    await runner.tick(due(2));
    expect(await read()).toMatchObject({ last_result: "could not start", failures: 2, last_error: expect.stringContaining("isn't linked") });
    // A skip in between doesn't count, or reset.
    busy.add(tile.id);
    await runner.tick(due(3));
    busy.delete(tile.id);
    expect(await read()).toMatchObject({ last_result: "skipped", failures: 2, paused: false });
    // Run 3: could not start → paused, one Inbox entry naming the schedule and reason.
    await runner.tick(due(4));
    expect(await read()).toMatchObject({ failures: 3, paused: true });
    const messages = (await backend.getPrInbox()).agent_messages!;
    expect(messages).toHaveLength(1);
    expect(messages[0].title).toContain("Check for new videos");
    expect(messages[0].body).toContain("could not start");
    expect(messages[0].body).toContain("Courses");
    // Paused: nothing runs at later due times.
    failWith(null);
    await runner.tick(due(5));
    expect(spawns).toHaveLength(1);
    expect((await backend.getPrInbox()).agent_messages).toHaveLength(1);
  });

  it("(AT-5) Run now resumes at once; a paused schedule doesn't run at its due time; the edit is used next", async () => {
    const { backend, runner, schedule, spawns, read } = await setup();
    await runner.tick(at(2026, 11, 23, 8, 30));
    await runner.runNow(schedule.id, at(2026, 11, 23, 8, 31));
    expect(spawns).toHaveLength(1);
    // Run now leaves the planned time alone.
    expect((await read()).next_run_at).toBe(at(2026, 11, 23, 9, 0));
    await runner.tick(at(2026, 11, 23, 8, 40));
    await backend.updateSchedule(schedule.id, { paused: true });
    await runner.tick(at(2026, 11, 23, 9, 0));
    expect(spawns).toHaveLength(1);
    await backend.updateSchedule(schedule.id, { paused: false, prompt: "Edited", frequency: { kind: "daily", time: "10:00" }, next_run_at: null });
    await runner.tick(at(2026, 11, 23, 9, 1));
    expect((await read()).next_run_at).toBe(at(2026, 11, 23, 10, 0));
    await runner.tick(at(2026, 11, 23, 10, 0));
    expect(spawns.map((s) => s.prompt)).toEqual(["Check for new videos", "Edited"]);
  });

  it("picks up a run an agent asked for (schedule.run) on its next tick", async () => {
    const { backend, runner, schedule, spawns, read } = await setup();
    await backend.updateSchedule(schedule.id, { run_requested: true });
    await runner.tick(at(2026, 11, 23, 8, 30));
    expect(spawns).toHaveLength(1);
    expect((await read()).run_requested).toBe(false);
  });

  it("skips a run asked for while the agent is mid-turn, or while a run is in flight", async () => {
    const { runner, schedule, spawns, busy, tile, read } = await setup();
    busy.add(tile.id);
    await runner.runNow(schedule.id, at(2026, 11, 23, 8, 30));
    expect(spawns).toEqual([]);
    expect(await read()).toMatchObject({ last_result: "skipped", run_requested: false });
    busy.delete(tile.id);
    await runner.runNow(schedule.id, at(2026, 11, 23, 8, 31));
    await runner.runNow(schedule.id, at(2026, 11, 23, 8, 31, ));
    expect(spawns).toHaveLength(1);
  });

  it("finishes a run left 'running' by a previous app instance", async () => {
    const { backend, schedule, deps, read } = await setup();
    await backend.updateSchedule(schedule.id, { last_result: "running", next_run_at: at(2026, 11, 24, 9, 0) });
    await createScheduleRunner(deps).tick(at(2026, 11, 23, 10, 0));
    expect((await read()).last_result).toBe("ok");
  });

  it("forgets an in-flight run whose schedule was deleted", async () => {
    const { backend, runner, schedule, deps } = await setup();
    await runner.runNow(schedule.id, 1);
    await backend.deleteSchedule(schedule.id);
    await runner.tick(RUN_TIMEOUT_MS + 2);
    expect(deps.interrupt).not.toHaveBeenCalled();
  });

  it("never overlaps ticks, and survives a store failure", async () => {
    const { runner, deps } = await setup();
    const first = runner.tick(at(2026, 11, 23, 8, 30));
    await runner.tick(at(2026, 11, 23, 8, 30));
    await first;
    const list = vi.spyOn(deps, "list").mockRejectedValueOnce(new Error("db locked"));
    await expect(runner.tick(at(2026, 11, 23, 8, 31))).resolves.toBeUndefined();
    expect(list).toHaveBeenCalled();
  });

  it("says when Run now names a schedule that is gone", async () => {
    const { runner } = await setup();
    await expect(runner.runNow("nope", 1)).rejects.toThrow("No schedule");
  });
});
