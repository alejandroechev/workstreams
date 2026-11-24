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
  /** Each session's turn cursor (its events file), by session id. */
  const cursor = new Map<string, { starts: number; ends: number; open: boolean }>();
  /** The session the tile is linked to when a run resumes it. */
  let linked = "S";
  const spawns: Array<{ tileId: string; prompt: string }> = [];
  const interrupts: string[] = [];
  let failResume: string | null = null;
  let duringResume: (() => Promise<void>) | null = null;
  let beforeLock: (() => Promise<void>) | null = null;
  const deps: ScheduleRunnerDeps = {
    list: () => backend.listSchedules(),
    update: vi.fn((id, patch, expected, alert) => backend.updateSchedule(id, patch, expected, alert)),
    workstreamName: (id) => (id === ws.id ? "Courses" : undefined),
    isArchived: (id) => archived.has(id),
    isBusy: (tileId) => busy.has(tileId),
    turnState: async (sessionId) => ({ ...(cursor.get(sessionId) ?? { starts: 0, ends: 0, open: false }) }),
    generation: (tileId) => generations.get(tileId) ?? 0,
    // Like resumeScheduledSession: wait for the tile, revalidate before the stop and before the spawn.
    resume: vi.fn(async (s, prompt, revalidate) => {
      await beforeLock?.();
      if (failResume) throw new Error(failResume);
      const sessionId = linked;
      await revalidate("before-stop", sessionId);
      await duringResume?.();
      await revalidate("before-spawn", sessionId);
      generations.set(s.tile_id, (generations.get(s.tile_id) ?? 0) + 1);
      spawns.push({ tileId: s.tile_id, prompt });
      return { sessionId };
    }),
    interrupt: vi.fn(async (tileId) => { interrupts.push(tileId); }),
    onChange: vi.fn(),
  };
  // Most cases tick far apart; the gap rule has its own cases.
  const runner = createScheduleRunner(deps, { maxGapMs: Infinity, ...opts.runner });
  const read = async () => (await backend.listSchedules()).find((s) => s.id === schedule.id)!;
  return {
    backend, ws, tile, schedule, busy, archived, generations, cursor, spawns, interrupts, deps, runner, read,
    failWith: (e: string | null) => { failResume = e; },
    whileResuming: (fn: (() => Promise<void>) | null) => { duringResume = fn; },
    beforeTheLock: (fn: (() => Promise<void>) | null) => { beforeLock = fn; },
    relinkTo: (sessionId: string) => { linked = sessionId; },
  };
}

type Cursor = { starts: number; ends: number; open: boolean };
/** A turn runs and ends in session S (the tile's): its events file and the poller's activity. */
function turn(env: { busy: Set<string>; tile: { id: string }; cursor: Map<string, Cursor> }, session = "S") {
  const at = () => env.cursor.get(session) ?? { starts: 0, ends: 0, open: false };
  return {
    start: () => { env.busy.add(env.tile.id); env.cursor.set(session, { starts: at().starts + 1, ends: at().ends, open: true }); },
    end: () => { env.busy.delete(env.tile.id); env.cursor.set(session, { starts: at().starts, ends: at().ends + 1, open: false }); },
  };
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

  it("(round 2, finding 2) sees a turn that finished before the first poll, from the cursor read before launching", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    // The session already had 5 turns; nothing about it was polled before (background mount).
    env.cursor.set("S", { starts: 5, ends: 5, open: false });
    await env.runner.tick(NINE);
    env.cursor.set("S", { starts: 6, ends: 6, open: false });
    await env.runner.tick(NINE + 10_000);
    expect(await env.read()).toMatchObject({ last_result: "ok", failures: 0 });
  });

  it("(round 2, finding 1) once the scheduled turn ended, a manual turn after it is never interrupted", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    await env.runner.tick(NINE);
    // Between two ticks the scheduled turn ends and the user starts another.
    turn(env).start();
    turn(env).end();
    turn(env).start();
    await env.runner.tick(NINE + RUN_TIMEOUT_MS + 1);
    await env.runner.tick(NINE + 2 * RUN_TIMEOUT_MS);
    expect(env.interrupts).toEqual([]);
    expect(await env.read()).toMatchObject({ last_result: "ok", failures: 0 });
  });

  it("(round 2, finding 3) skips the slot when the tile was relaunched or became busy while the run waited for it", async () => {
    for (const what of ["relaunched", "busy"] as const) {
      const env = await setup();
      await env.runner.tick(at(2026, 11, 23, 8, 30));
      env.beforeTheLock(async () => {
        // A phone message holds the tile, and launches its own turn.
        if (what === "relaunched") env.generations.set(env.tile.id, 7);
        else env.busy.add(env.tile.id);
      });
      await env.runner.tick(NINE);
      expect(env.spawns, what).toEqual([]);
      expect(await env.read(), what).toMatchObject({ last_result: "skipped", failures: 0, next_run_at: at(2026, 11, 24, 9, 0) });
    }
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
    const { backend, runner, read, busy, tile, interrupts, failWith, spawns, schedule, cursor } = await setup({ frequency: { kind: "interval", minutes: 120 }, created: 0 });
    const due = (n: number) => n * 120 * MIN;
    await runner.tick(0);
    await runner.tick(due(1));
    turn({ busy, tile, cursor }).start();
    await runner.tick(due(1) + 30 * MIN);
    expect(interrupts).toEqual([]);
    await runner.tick(due(1) + RUN_TIMEOUT_MS);
    expect(interrupts).toEqual([tile.id]);
    expect(await read()).toMatchObject({ last_result: "timed out", failures: 1, paused: false });
    turn({ busy, tile, cursor }).end();
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
    turn(env).start();
    env.generations.set(env.tile.id, (env.generations.get(env.tile.id) ?? 0) + 2);
    await env.runner.tick(NINE + RUN_TIMEOUT_MS + 1);
    expect(env.interrupts).toEqual([]);
    expect(await env.read()).toMatchObject({ last_result: "interrupted", failures: 0 });
  });

  it("(finding 11) bounds the auto-pause alert whatever the prompt", async () => {
    const long = "x".repeat(19_999);
    const env = await setup({ prompt: long, frequency: { kind: "interval", minutes: 60 }, created: 0 });
    await env.backend.updateSchedule(env.schedule.id, { failures: 2, next_run_at: 60 * MIN });
    env.failWith("y".repeat(30_000));
    await env.runner.tick(60 * MIN - 1);
    await env.runner.tick(60 * MIN);
    expect((await env.read()).paused).toBe(true);
    const [message] = (await env.backend.getPrInbox()).agent_messages!;
    expect(message.title.length).toBeLessThanOrEqual(120);
    expect(message.body.length).toBeLessThan(2_000);
  });

  it("(round 3, finding 4) stores the auto-pause and its Inbox entry together, retrying both if that fails", async () => {
    const env = await setup({ frequency: { kind: "interval", minutes: 60 }, created: 0 });
    await env.backend.updateSchedule(env.schedule.id, { failures: 2, next_run_at: 60 * MIN });
    env.failWith("tile gone");
    const update = env.deps.update;
    let failed = false;
    env.deps.update = async (id, patch, expected, alert) => {
      if (alert && !failed) { failed = true; throw new Error("app quit"); }
      return update(id, patch, expected, alert);
    };
    await env.runner.tick(60 * MIN - 1);
    await env.runner.tick(60 * MIN);
    expect((await env.read()).paused).toBe(false);
    expect((await env.backend.getPrInbox()).agent_messages).toHaveLength(0);
    await env.runner.tick(60 * MIN + 15_000);
    expect(await env.read()).toMatchObject({ paused: true, failures: 3, last_result: "could not start" });
    expect((await env.backend.getPrInbox()).agent_messages).toHaveLength(1);
  });

  it("(round 3, finding 1) skips the slot when the session's turn is open, whatever the poller last said", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    // A sub-agent is running inside a turn the poller reported as idle a moment ago.
    env.cursor.set("S", { starts: 3, ends: 2, open: true });
    await env.runner.tick(NINE);
    expect(env.spawns).toEqual([]);
    expect(await env.read()).toMatchObject({ last_result: "skipped", failures: 0 });
  });

  it("(round 3, finding 2) a phone turn that replaced the scheduled process is not the run's success", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    await env.runner.tick(NINE);
    // Before the scheduled turn ended, a phone message restarted the tile and its turn ended.
    env.generations.set(env.tile.id, 99);
    turn(env).start();
    turn(env).end();
    await env.runner.tick(NINE + MIN);
    expect(await env.read()).toMatchObject({ last_result: "interrupted", failures: 0 });
  });

  it("(round 3, finding 2) follows the session it launched, not the tile's current link", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    await env.runner.tick(NINE);
    // A turn ending in another session the tile is linked to later doesn't count...
    turn(env, "OTHER").start();
    turn(env, "OTHER").end();
    await env.runner.tick(NINE + MIN);
    expect((await env.read()).last_result).toBe("running");
    // ...the launched session's own turn does.
    turn(env).start();
    turn(env).end();
    await env.runner.tick(NINE + 2 * MIN);
    expect((await env.read()).last_result).toBe("ok");
  });

  it("(round 2, finding 6) a slow tick keeps the heartbeat, so a slot that fell during it still runs", async () => {
    const env = await setup({ frequency: { kind: "interval", minutes: 60 }, created: NINE - 60 * MIN, runner: { maxGapMs: 2 * MIN } });
    const other = await env.backend.createTile(env.ws.id, "copilot_session", "Other", JSON.stringify({ copilot_session_id: "O" }));
    const second = await env.backend.createSchedule({
      tileId: other.id, workstreamId: env.ws.id, prompt: "Other chore", frequency: { kind: "interval", minutes: 60 },
      notifyInbox: false, notifyPhone: false, nextRunAt: NINE + MIN, createdAt: 0,
    });
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    env.whileResuming(async () => { env.whileResuming(null); await held; });
    await env.runner.tick(NINE - 10_000);
    const slow = env.runner.tick(NINE + 1_000);
    // The timer keeps firing while the first run waits for its tile.
    for (let t = NINE + 15_000; t < NINE + 3 * MIN; t += 15_000) void env.runner.tick(t);
    await new Promise((r) => setTimeout(r, 5));
    release();
    await slow;
    await env.runner.tick(NINE + 3 * MIN);
    expect(env.spawns.map((x) => x.prompt)).toEqual(["Check for new videos", "Other chore"]);
    expect((await env.backend.listSchedules()).find((x) => x.id === second.id)?.last_result).toBe("running");
  });

  it("(round 2, finding 6) one tile's slow resume doesn't hold back another schedule due at the same tick", async () => {
    const env = await setup({ frequency: { kind: "interval", minutes: 60 }, created: 0 });
    const other = await env.backend.createTile(env.ws.id, "copilot_session", "Other", "{}");
    await env.backend.createSchedule({
      tileId: other.id, workstreamId: env.ws.id, prompt: "Other chore", frequency: { kind: "interval", minutes: 60 },
      notifyInbox: false, notifyPhone: false, nextRunAt: NINE, createdAt: 0,
    });
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    env.whileResuming(async () => { env.whileResuming(null); await held; });
    await env.runner.tick(NINE - 10_000);
    const slow = env.runner.tick(NINE);
    await vi.waitFor(() => expect(env.spawns.map((x) => x.prompt)).toContain("Other chore"));
    release();
    await slow;
    expect(env.spawns).toHaveLength(2);
  });

  it("(round 2, finding 7) keeps an outcome until it is stored, without repeating its side effects", async () => {
    const env = await setup();
    await env.runner.tick(at(2026, 11, 23, 8, 30));
    await env.runner.tick(NINE);
    turn(env).start();
    const update = env.deps.update;
    let failed = false;
    env.deps.update = async (id, patch, expected) => {
      if (!failed && patch.last_result === "timed out") { failed = true; throw new Error("db locked"); }
      return update(id, patch, expected);
    };
    await env.runner.tick(NINE + RUN_TIMEOUT_MS);
    expect((await env.read()).last_result).toBe("running");
    await env.runner.tick(NINE + RUN_TIMEOUT_MS + 15_000);
    expect(await env.read()).toMatchObject({ last_result: "timed out", failures: 1 });
    expect(env.interrupts).toHaveLength(1);
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
