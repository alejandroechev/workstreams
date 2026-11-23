import { describe, expect, it, vi } from "vitest";
import { createScheduleRunner, OBSERVE_MS, type ScheduleRunnerDeps, type ScheduleRunnerOptions } from "../schedule-runner";
import { MemoryBackend } from "../../backend/memory-backend";
import { INBOX_INSTRUCTION, PHONE_INSTRUCTION, RUN_REQUEST_TTL_MS, RUN_TIMEOUT_MS, type ScheduleFrequency } from "../periodic-schedules";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const MIN = 60_000;
const NINE = at(2026, 11, 23, 9, 0);

async function setup(opts: { frequency?: ScheduleFrequency; prompt?: string; created?: number; runner?: ScheduleRunnerOptions } = {}) {
  const backend = new MemoryBackend();
  const ws = await backend.createWorkstream("Courses", "/c");
  const tile = await backend.createTile(ws.id, "copilot_session", "Videos", JSON.stringify({ copilot_session_id: "S" }));
  const created = opts.created ?? at(2026, 11, 23, 8, 0);
  const schedule = await backend.createSchedule({
    tileId: tile.id, workstreamId: ws.id, prompt: opts.prompt ?? "Check for new videos", frequency: opts.frequency ?? { kind: "daily", time: "09:00" },
    notifyInbox: false, notifyPhone: false, nextRunAt: null, createdAt: created,
  });
  const busy = new Set<string>();
  const archived = new Set<string>();
  const generations = new Map<string, number>();
  const turns = new Map<string, number>();
  const spawns: Array<{ tileId: string; prompt: string }> = [];
  const interrupts: string[] = [];
  let failResume: string | null = null;
  let duringResume: (() => Promise<void>) | null = null;
  const deps: ScheduleRunnerDeps = {
    list: () => backend.listSchedules(),
    update: (id, patch, expected) => backend.updateSchedule(id, patch, expected),
    postInbox: vi.fn((wsId, tileId, title, body) => backend.postAppInboxMessage(wsId, tileId, "error", title, body)),
    workstreamName: (id) => (id === ws.id ? "Courses" : undefined),
    isArchived: (id) => archived.has(id),
    isBusy: (tileId) => busy.has(tileId),
    turnCount: (tileId) => turns.get(tileId),
    generation: (tileId) => generations.get(tileId) ?? 0,
    // Like resumeScheduledSession: revalidate before the stop and before the spawn.
    resume: vi.fn(async (s, prompt, revalidate) => {
      if (failResume) throw new Error(failResume);
      await revalidate();
      await duringResume?.();
      await revalidate();
      generations.set(s.tile_id, (generations.get(s.tile_id) ?? 0) + 1);
      spawns.push({ tileId: s.tile_id, prompt });
    }),
    interrupt: vi.fn(async (tileId) => { interrupts.push(tileId); }),
    onChange: vi.fn(),
  };
  // Most cases tick far apart; the gap rule has its own cases.
  const runner = createScheduleRunner(deps, { maxGapMs: Infinity, ...opts.runner });
  const read = async () => (await backend.listSchedules()).find((s) => s.id === schedule.id)!;
  return {
    backend, ws, tile, schedule, busy, archived, generations, turns, spawns, interrupts, deps, runner, read,
    failWith: (e: string | null) => { failResume = e; },
    whileResuming: (fn: (() => Promise<void>) | null) => { duringResume = fn; },
  };
}

/** The resumed turn runs and ends, as the poller would report it. */
function turn(env: { busy: Set<string>; tile: { id: string } }) {
  return { start: () => env.busy.add(env.tile.id), end: () => env.busy.delete(env.tile.id) };
}

describe("schedule runner", () => {
  it("plans a new schedule's first run at its first scheduled time, without running it now (AT-1)", async () => {
    const { runner, read, spawns } = await setup();
    await runner.tick(at(2026, 11, 23, 16, 42));
    expect((await read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
    expect(spawns).toEqual([]);
  });

  it("resumes the session once with exactly the prompt when due, and records ok after the turn starts then ends (AT-3, finding 7)", async () => {
    const env = await setup();
    const { runner, read, spawns, deps } = env;
    await runner.tick(at(2026, 11, 23, 8, 30));
    await runner.tick(NINE + 10_000);
    await runner.tick(NINE + 20_000);
    expect(spawns).toEqual([{ tileId: expect.any(String), prompt: "Check for new videos" }]);
    expect(deps.resume).toHaveBeenCalledTimes(1);
    expect(await read()).toMatchObject({ last_result: "running", last_run_at: NINE + 10_000, next_run_at: at(2026, 11, 24, 9, 0) });
    turn(env).start();
    await runner.tick(NINE + MIN);
    expect((await read()).last_result).toBe("running");
    turn(env).end();
    await runner.tick(NINE + 2 * MIN);
    expect(await read()).toMatchObject({ last_result: "ok", failures: 0 });
    expect(deps.onChange).toHaveBeenCalled();
  });

  it("(finding 7) takes a turn too short to be seen busy from the turn count rising", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    env.turns.set(env.tile.id, 4);
    await env.runner.tick(NINE);
    await env.runner.tick(NINE + 10_000);
    expect((await env.read()).last_result).toBe("running");
    env.turns.set(env.tile.id, 5);
    await env.runner.tick(NINE + 20_000);
    expect((await env.read()).last_result).toBe("ok");
  });

  it("(finding 7) never takes the first count reported after a background mount as a turn", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    await env.runner.tick(NINE);
    env.turns.set(env.tile.id, 12);
    await env.runner.tick(NINE + 10_000);
    expect((await env.read()).last_result).toBe("running");
  });

  it("(finding 7) a run whose turn never starts is a failure, not ok", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    await env.runner.tick(NINE);
    await env.runner.tick(NINE + 2 * MIN);
    expect((await env.read()).last_result).toBe("running");
    await env.runner.tick(NINE + OBSERVE_MS);
    expect(await env.read()).toMatchObject({ last_result: "could not start", failures: 1, last_error: expect.stringContaining("never started") });
  });

  it("(finding 7) a run left 'running' by a previous app instance becomes interrupted, not ok, and doesn't count", async () => {
    const { backend, schedule, deps, read } = await setup();
    await backend.updateSchedule(schedule.id, { last_result: "running", failures: 2, next_run_at: at(2026, 11, 24, 9, 0) });
    await createScheduleRunner(deps).tick(at(2026, 11, 23, 10, 0));
    expect(await read()).toMatchObject({ last_result: "interrupted", failures: 2, paused: false });
  });

  it("(AT-4.1) skips a run due while the agent is mid-turn, without interrupting", async () => {
    const { runner, read, spawns, busy, tile, interrupts } = await setup();
    await runner.tick(at(2026, 11, 23, 8, 30));
    busy.add(tile.id);
    await runner.tick(NINE);
    expect(spawns).toEqual([]);
    expect(interrupts).toEqual([]);
    expect(await read()).toMatchObject({ last_result: "skipped", failures: 0, next_run_at: at(2026, 11, 24, 9, 0) });
  });

  it("(AT-4.2) runs even though the user typed in the tile a minute ago (typing isn't mid-turn)", async () => {
    const { runner, spawns } = await setup();
    await runner.tick(at(2026, 11, 23, 8, 30));
    await runner.tick(NINE);
    expect(spawns).toHaveLength(1);
  });

  it("(AT-4.3) runs nothing at startup after the app was closed over the due time; next run is tomorrow 09:00", async () => {
    const { backend, schedule, deps, read, spawns } = await setup();
    await backend.updateSchedule(schedule.id, { next_run_at: NINE });
    await createScheduleRunner(deps).tick(at(2026, 11, 23, 10, 0));
    expect(spawns).toEqual([]);
    expect((await read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
  });

  it("(finding 8) skips a slot due on the first tick after start, even seconds late", async () => {
    const { backend, schedule, deps, read, spawns } = await setup();
    await backend.updateSchedule(schedule.id, { next_run_at: NINE });
    await createScheduleRunner(deps).tick(NINE + 30_000);
    expect(spawns).toEqual([]);
    expect((await read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
  });

  it("(finding 8) skips a slot that fell while the laptop slept between two ticks", async () => {
    const { runner, read, spawns } = await setup({ runner: { maxGapMs: 2 * MIN } });
    await runner.tick(NINE - 30_000);
    await runner.tick(NINE + 20 * MIN);
    expect(spawns).toEqual([]);
    expect((await read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
    // While awake the next slot runs.
    await runner.tick(at(2026, 11, 24, 9, 0) - 10_000);
    await runner.tick(at(2026, 11, 24, 9, 0) + 5_000);
    expect(spawns).toHaveLength(1);
  });

  it("(finding 8) a Run now asked before this app started, or long ago, expires instead of running", async () => {
    const { backend, schedule, deps, read, spawns } = await setup();
    const started = at(2026, 11, 23, 8, 0);
    const runner = createScheduleRunner(deps, { startedAt: started, maxGapMs: Infinity });
    await backend.updateSchedule(schedule.id, { run_requested: true, run_requested_at: started - 1 });
    await runner.tick(started + 1_000);
    expect(spawns).toEqual([]);
    expect(await read()).toMatchObject({ run_requested: false, run_requested_at: null });
    await backend.updateSchedule(schedule.id, { run_requested: true, run_requested_at: started + 2_000 });
    await runner.tick(started + 2_000 + RUN_REQUEST_TTL_MS + 1);
    expect(spawns).toEqual([]);
    expect((await read()).run_requested).toBe(false);
    await backend.updateSchedule(schedule.id, { run_requested: true, run_requested_at: started + 3 * RUN_REQUEST_TTL_MS });
    await runner.tick(started + 3 * RUN_REQUEST_TTL_MS + 1_000);
    expect(spawns).toHaveLength(1);
  });

  it("(AT-6) sends the prompt verbatim, then with the Inbox, then with the phone instruction", async () => {
    const prompt = "  Check  the course\n\tfor new videos ";
    const env = await setup({ prompt, frequency: { kind: "interval", minutes: 60 }, created: 0 });
    const { backend, schedule, runner, spawns } = env;
    expect(schedule.notify_inbox).toBe(false);
    expect(schedule.notify_phone).toBe(false);
    const runNow = async (now: number) => {
      await runner.runNow(schedule.id, now);
      turn(env).start();
      await runner.tick(now + MIN);
      turn(env).end();
      await runner.tick(now + 2 * MIN);
    };
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
    await runner.tick(due(1));
    busy.add(tile.id);
    await runner.tick(due(1) + 30 * MIN);
    expect(interrupts).toEqual([]);
    await runner.tick(due(1) + RUN_TIMEOUT_MS);
    expect(interrupts).toEqual([tile.id]);
    expect(await read()).toMatchObject({ last_result: "timed out", failures: 1, paused: false });
    busy.delete(tile.id);
    expect((await backend.listTiles(schedule.workstream_id)).map((t) => t.id)).toEqual([tile.id]);
    failWith("This tile isn't linked to a Copilot session yet");
    await runner.tick(due(2));
    expect(await read()).toMatchObject({ last_result: "could not start", failures: 2, last_error: expect.stringContaining("isn't linked") });
    busy.add(tile.id);
    await runner.tick(due(3));
    busy.delete(tile.id);
    expect(await read()).toMatchObject({ last_result: "skipped", failures: 2, paused: false });
    await runner.tick(due(4));
    expect(await read()).toMatchObject({ failures: 3, paused: true });
    const messages = (await backend.getPrInbox()).agent_messages!;
    expect(messages).toHaveLength(1);
    expect(messages[0].title).toContain("Check for new videos");
    expect(messages[0].body).toContain("could not start");
    expect(messages[0].body).toContain("Courses");
    failWith(null);
    await runner.tick(due(5));
    expect(spawns).toHaveLength(1);
    expect((await backend.getPrInbox()).agent_messages).toHaveLength(1);
  });

  it("(finding 5) the timeout never interrupts a process the schedule didn't launch", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    await env.runner.tick(NINE);
    // A phone message restarted the tile; its own turn runs past the hour.
    env.generations.set(env.tile.id, (env.generations.get(env.tile.id) ?? 0) + 2);
    env.busy.add(env.tile.id);
    await env.runner.tick(NINE + RUN_TIMEOUT_MS + 1);
    expect(env.interrupts).toEqual([]);
    expect(await env.read()).toMatchObject({ last_result: "interrupted", failures: 0 });
  });

  it("(finding 11) bounds the auto-pause alert whatever the prompt, and retries it if posting fails", async () => {
    const long = "x".repeat(19_999);
    const env = await setup({ prompt: long, frequency: { kind: "interval", minutes: 60 }, created: 0 });
    await env.backend.updateSchedule(env.schedule.id, { failures: 2, next_run_at: 60 * MIN });
    env.failWith("y".repeat(30_000));
    vi.mocked(env.deps.postInbox).mockRejectedValueOnce(new Error("db locked"));
    await env.runner.tick(60 * MIN - 1);
    await env.runner.tick(60 * MIN);
    expect((await env.read()).paused).toBe(true);
    expect((await env.backend.getPrInbox()).agent_messages).toHaveLength(0);
    await env.runner.tick(61 * MIN);
    const [message] = (await env.backend.getPrInbox()).agent_messages!;
    expect(message.title.length).toBeLessThanOrEqual(120);
    expect(message.body.length).toBeLessThan(2_000);
    await env.runner.tick(62 * MIN);
    expect((await env.backend.getPrInbox()).agent_messages).toHaveLength(1);
  });

  it("(AT-5) Run now resumes at once; a paused schedule doesn't run at its due time; the edit is used next", async () => {
    const env = await setup();
    const { backend, runner, schedule, spawns, read } = env;
    await runner.tick(at(2026, 11, 23, 8, 30));
    await runner.runNow(schedule.id, at(2026, 11, 23, 8, 31));
    expect(spawns).toHaveLength(1);
    expect((await read()).next_run_at).toBe(NINE);
    turn(env).start();
    await runner.tick(at(2026, 11, 23, 8, 35));
    turn(env).end();
    await runner.tick(at(2026, 11, 23, 8, 40));
    await backend.updateSchedule(schedule.id, { paused: true });
    await runner.tick(NINE);
    expect(spawns).toHaveLength(1);
    await backend.updateSchedule(schedule.id, { paused: false, prompt: "Edited", frequency: { kind: "daily", time: "10:00" }, next_run_at: null });
    await runner.tick(at(2026, 11, 23, 9, 1));
    expect((await read()).next_run_at).toBe(at(2026, 11, 23, 10, 0));
    await runner.tick(at(2026, 11, 23, 10, 0));
    expect(spawns.map((s) => s.prompt)).toEqual(["Check for new videos", "Edited"]);
  });

  it("(finding 4) a pause between the runner's read and its claim wins: nothing launches", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    const list = env.deps.list;
    env.deps.list = async () => {
      const rows = await list();
      await env.backend.updateSchedule(env.schedule.id, { paused: true });
      env.deps.list = list;
      return rows;
    };
    await env.runner.tick(NINE);
    expect(env.spawns).toEqual([]);
    expect(await env.read()).toMatchObject({ paused: true, last_result: null });
  });

  it("(finding 4) an edit, pause, delete or archive while resuming cancels the run before the spawn, with no failure", async () => {
    for (const change of ["edit", "delete", "archive"] as const) {
      const env = await setup();
      await env.runner.tick(at(2026, 11, 23, 8, 30));
      env.whileResuming(async () => {
        if (change === "edit") await env.backend.updateSchedule(env.schedule.id, { prompt: "Edited" });
        if (change === "delete") await env.backend.deleteSchedule(env.schedule.id);
        if (change === "archive") env.archived.add(env.ws.id);
      });
      await env.runner.tick(NINE);
      expect(env.spawns, change).toEqual([]);
      const row = (await env.backend.listSchedules())[0];
      if (change === "delete") expect(row).toBeUndefined();
      else expect(row, change).toMatchObject({ failures: 0, last_result: null });
    }
  });

  it("(finding 4) an archived workstream's schedule neither runs when due nor on Run now", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    env.archived.add(env.ws.id);
    await expect(env.runner.runNow(env.schedule.id, at(2026, 11, 23, 8, 31))).rejects.toThrow("archived");
    // An agent's request is dropped too.
    await env.backend.updateSchedule(env.schedule.id, { run_requested: true, run_requested_at: at(2026, 11, 23, 8, 32) });
    await env.runner.tick(NINE);
    expect(env.spawns).toEqual([]);
    expect((await env.read()).run_requested).toBe(false);
  });

  it("Run now runs a paused schedule once and leaves it paused", async () => {
    const env = await setup();
    await env.backend.updateSchedule(env.schedule.id, { paused: true });
    await env.runner.runNow(env.schedule.id, at(2026, 11, 23, 8, 31));
    expect(env.spawns).toHaveLength(1);
    expect((await env.read()).paused).toBe(true);
  });

  it("picks up a run an agent asked for (schedule.run) on its next tick", async () => {
    const { backend, runner, schedule, spawns, read } = await setup();
    await backend.updateSchedule(schedule.id, { run_requested: true, run_requested_at: at(2026, 11, 23, 8, 29) });
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
    await runner.runNow(schedule.id, at(2026, 11, 23, 8, 31));
    expect(spawns).toHaveLength(1);
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
    expect(runner.tick(at(2026, 11, 23, 8, 30))).toBe(first);
    await first;
    const busyTick = runner.tick(at(2026, 11, 23, 8, 31));
    await runner.runNow((await deps.list())[0].id, at(2026, 11, 23, 8, 31));
    await busyTick;
    expect(deps.resume).toHaveBeenCalledTimes(1);
    const list = vi.spyOn(deps, "list").mockRejectedValueOnce(new Error("db locked"));
    await expect(runner.tick(at(2026, 11, 23, 8, 40))).resolves.toBeUndefined();
    expect(list).toHaveBeenCalled();
  });

  it("says when Run now names a schedule that is gone", async () => {
    const { runner } = await setup();
    await expect(runner.runNow("nope", 1)).rejects.toThrow("No schedule");
  });
});
