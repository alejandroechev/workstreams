import { describe, expect, it, vi } from "vitest";
import { createScheduleRunner, type ScheduleRunnerDeps, type ScheduleRunnerOptions } from "../schedule-runner";
import { MemoryBackend } from "../../backend/memory-backend";
import { RUN_REQUEST_TTL_MS, type PeriodicRun, type ScheduleFrequency } from "../periodic-schedules";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const MIN = 60_000;
const NINE = at(2026, 11, 23, 9, 0);

async function setup(opts: { frequency?: ScheduleFrequency; prompt?: string; created?: number; runner?: ScheduleRunnerOptions } = {}) {
  const backend = new MemoryBackend();
  const ws = await backend.createWorkstream("Courses", "/c");
  const tile = await backend.createTile(ws.id, "periodic_session", "Videos", "{}");
  const created = opts.created ?? at(2026, 11, 23, 8, 0);
  const schedule = await backend.createSchedule({
    tileId: tile.id, workstreamId: ws.id, prompt: opts.prompt ?? "Check for new videos", frequency: opts.frequency ?? { kind: "daily", time: "09:00" },
    notifyInbox: false, notifyPhone: false, nextRunAt: null, createdAt: created, sessionId: "S",
  });
  const archived = new Set<string>();
  const notified: Array<{ run: PeriodicRun; autoPaused: boolean }> = [];
  let failStart: string | null = null;
  const deps: ScheduleRunnerDeps = {
    list: () => backend.listSchedules(),
    update: vi.fn((id, patch, expected, alert) => backend.updateSchedule(id, patch, expected, alert)),
    workstreamName: (id) => (id === ws.id ? "Courses" : undefined),
    isArchived: (id) => archived.has(id),
    start: vi.fn(async (s, prompt, kind, now) => {
      if (failStart) throw new Error(failStart);
      return backend.startPeriodicRun({ tileId: s.tile_id, kind, prompt, command: "my-copilot --yolo", cwd: "/c", startedAt: now });
    }),
    getRun: (id) => backend.getPeriodicRun(id),
    latestRun: async (tileId) => (await backend.listPeriodicRuns(tileId))[0] ?? null,
    recordSkip: vi.fn(async (s, kind, prompt, now) => { await backend.recordPeriodicSkip(s.tile_id, kind, prompt, now); }),
    notify: vi.fn(async (_s, run, autoPaused) => { notified.push({ run, autoPaused }); }),
    onChange: vi.fn(),
  };
  // Most cases tick far apart; the gap rule has its own cases.
  const runner = createScheduleRunner(deps, { maxGapMs: Infinity, ...opts.runner });
  const read = async () => (await backend.listSchedules()).find((s) => s.id === schedule.id)!;
  const runs = () => backend.listPeriodicRuns(tile.id);
  const started = () => (deps.start as ReturnType<typeof vi.fn>).mock.calls.map(([, prompt, kind]) => ({ prompt, kind }));
  /** The scheduler is awake just before `due`, then reaches it. */
  const through = async (due: number, after = 1000) => { await runner.tick(due - 1000); await runner.tick(due + after); };
  const finish = (end: Parameters<MemoryBackend["finishPeriodicRunForTests"]>[1]) => backend.finishPeriodicRunForTests(tile.id, end);
  return {
    backend, ws, tile, schedule, archived, deps, runner, read, runs, started, through, finish, notified,
    failWith: (e: string | null) => { failStart = e; },
  };
}

describe("schedule runner (headless, ADR 046)", () => {
  it("plans a new schedule's first run at its first scheduled time, without running it now", async () => {
    const { runner, read, started } = await setup();
    await runner.tick(at(2026, 11, 23, 16, 42));
    expect((await read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
    expect(started()).toEqual([]);
  });

  it("starts one headless run with exactly the prompt when due, and records ok when it ends (AT-2)", async () => {
    const env = await setup({ prompt: "Check CI\nand report" });
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    await env.through(NINE);
    expect(env.started()).toEqual([{ prompt: "Check CI\nand report", kind: "scheduled" }]);
    expect((await env.read()).last_result).toBe("running");
    expect((await env.read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
    // Still going: nothing else starts.
    await env.runner.tick(NINE + 5 * MIN);
    expect(env.started()).toHaveLength(1);
    env.finish({ exitCode: 0, answer: "All green" });
    await env.runner.settle(NINE + 6 * MIN);
    const s = await env.read();
    expect([s.last_result, s.failures]).toEqual(["ok", 0]);
    expect(env.notified.map((n) => [n.run.status, n.run.answer, n.autoPaused])).toEqual([["ok", "All green", false]]);
    expect(env.deps.onChange).toHaveBeenCalled();
  });

  it("a slot due while a run is going is skipped and recorded, and starts nothing (AT-3 e)", async () => {
    const env = await setup({ frequency: { kind: "interval", minutes: 60 } });
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    await env.through(NINE);
    await env.through(NINE + 60 * MIN);
    expect(env.started()).toHaveLength(1);
    const runs = await env.runs();
    expect(runs.map((r) => r.status)).toEqual(["skipped", "running"]);
    expect((await env.read()).last_result).toBe("running");
    expect((await env.read()).next_run_at).toBe(NINE + 120 * MIN);
  });

  it("needs input resets the failures and is notified; it isn't a failure (AT-4)", async () => {
    const env = await setup();
    await env.backend.updateSchedule(env.schedule.id, { failures: 2 });
    await env.runner.runNow(env.schedule.id, NINE);
    env.finish({ exitCode: 0, answer: "NEEDS INPUT: Skip the flaky test or just report it?" });
    await env.runner.settle(NINE + MIN);
    const s = await env.read();
    expect([s.last_result, s.failures, s.paused]).toEqual(["needs_input", 0, false]);
    expect(env.notified[0].run.question).toBe("Skip the flaky test or just report it?");
  });

  it("failed and timed-out runs count; the third in a row pauses with one alert; an ok in between resets (AT-3)", async () => {
    const env = await setup();
    const runOnce = async (at: number, end: Parameters<typeof env.finish>[0]) => {
      await env.runner.runNow(env.schedule.id, at);
      env.finish(end);
      await env.runner.settle(at + MIN);
    };
    await runOnce(NINE, { exitCode: 1 });
    await runOnce(NINE + 2 * MIN, { timedOut: true });
    await runOnce(NINE + 4 * MIN, { exitCode: 0, answer: "fine" });
    expect((await env.read()).failures).toBe(0);
    await runOnce(NINE + 6 * MIN, { exitCode: 1 });
    await runOnce(NINE + 8 * MIN, { spawnError: "No such file" });
    expect((await env.read()).paused).toBe(false);
    await runOnce(NINE + 10 * MIN, { timedOut: true });
    const s = await env.read();
    expect([s.paused, s.failures, s.last_result]).toEqual([true, 3, "timed_out"]);
    const alerts = (await env.backend.getPrInbox()).agent_messages!.filter((m) => m.title.startsWith("Schedule paused"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("3 times in a row");
    expect(env.notified.map((n) => n.autoPaused)).toEqual([false, false, false, false, false, true]);
  });

  it("a run that can't start is failed, and a refusal because one is going is a skip", async () => {
    const env = await setup();
    env.failWith("spawn denied");
    await env.runner.runNow(env.schedule.id, NINE);
    expect(await env.read()).toMatchObject({ last_result: "failed", last_error: "spawn denied", failures: 1 });
    env.failWith("A run is already going in this tile.");
    await env.runner.runNow(env.schedule.id, NINE + MIN);
    expect(await env.read()).toMatchObject({ last_result: "skipped", failures: 1 });
  });

  it("runs nothing at startup after the app was closed over the due time, nor for a slot missed while asleep", async () => {
    const env = await setup({ runner: { maxGapMs: 2 * MIN } });
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    await env.runner.tick(NINE + 30_000);
    expect(env.started()).toEqual([]);
    expect((await env.read()).next_run_at).toBe(at(2026, 11, 24, 9, 0));
    await env.runner.tick(at(2026, 11, 24, 8, 0));
    await env.runner.tick(at(2026, 11, 24, 9, 30)); // asleep from 08:00 to 09:30
    expect(env.started()).toEqual([]);
  });

  it("while a tile is open interactively on the session, nothing starts and due slots pass; then it runs again (AT-6)", async () => {
    const env = await setup({ frequency: { kind: "interval", minutes: 60 } });
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    const open = await env.backend.createTile(env.ws.id, "copilot_session", "Interactive", JSON.stringify({ resume_by_id: "S" }));
    await env.through(NINE);
    expect(env.started()).toEqual([]);
    expect((await env.read()).next_run_at).toBe(NINE + 60 * MIN);
    await env.runner.runNow(env.schedule.id, NINE + 2 * MIN).catch(() => {});
    await expect(env.runner.reply(env.schedule.id, "Just report it", "reply", NINE + 3 * MIN)).rejects.toThrow(/open interactively/);
    expect(env.started()).toEqual([]);
    await env.backend.deleteTile(open.id);
    await env.runner.runNow(env.schedule.id, NINE + 4 * MIN);
    expect(env.started()).toHaveLength(1);
  });

  it("a slot that fell while the tile was open interactively is passed over once it closes, never caught up (AT-6)", async () => {
    const env = await setup({ frequency: { kind: "interval", minutes: 60 } });
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    const open = await env.backend.createTile(env.ws.id, "copilot_session", "Interactive", JSON.stringify({ copilot_session_id: "S" }));
    await env.runner.tick(NINE - 30_000);
    // Closed after the slot fell, before any tick saw it due.
    await env.backend.deleteTile(open.id);
    await env.runner.tick(NINE + 10_000);
    expect(env.started()).toEqual([]);
    expect((await env.read()).next_run_at).toBe(NINE + 60 * MIN);
    await env.through(NINE + 60 * MIN);
    expect(env.started()).toHaveLength(1);
  });

  it("a reply runs the next turn at once, as a run with the same rules, and is skipped while one is going (AT-4)", async () => {
    const env = await setup();
    await env.backend.updateSchedule(env.schedule.id, { paused: true, next_run_at: NINE + 99 * MIN });
    const run = await env.runner.reply(env.schedule.id, "Just report it", "reply", NINE);
    expect(run).toMatchObject({ kind: "reply", prompt: "Just report it", status: "running" });
    expect(env.started()).toEqual([{ prompt: "Just report it", kind: "reply" }]);
    // A reply doesn't move the plan, nor resume a paused schedule.
    expect(await env.read()).toMatchObject({ next_run_at: NINE + 99 * MIN, paused: true, last_result: "running" });
    await expect(env.runner.reply(env.schedule.id, "again", "phone", NINE + MIN)).rejects.toThrow(/already going/);
    expect((await env.runs()).map((r) => [r.kind, r.status])).toEqual([["phone", "skipped"], ["reply", "running"]]);
    env.finish({ exitCode: 0, answer: "Reported." });
    await env.runner.settle(NINE + 2 * MIN);
    expect((await env.read()).last_result).toBe("ok");
  });

  it("a run left 'running' is followed after a restart: still going, finished, or gone", async () => {
    const env = await setup();
    await env.runner.runNow(env.schedule.id, NINE);
    // A new runner (the app restarted, or its hook remounted) adopts the native run still going.
    const again = createScheduleRunner(env.deps, { maxGapMs: Infinity });
    await again.tick(NINE + MIN);
    expect((await env.read()).last_result).toBe("running");
    env.finish({ exitCode: 0, answer: "done" });
    const third = createScheduleRunner(env.deps, { maxGapMs: Infinity });
    await third.tick(NINE + 2 * MIN);
    expect((await env.read()).last_result).toBe("ok");
    expect(env.notified).toHaveLength(1);
    // No run at all behind it: interrupted, not a failure.
    await env.backend.updateSchedule(env.schedule.id, { last_result: "running", last_run_at: NINE + 3 * MIN });
    await createScheduleRunner(env.deps, { maxGapMs: Infinity }).tick(NINE + 4 * MIN);
    expect(await env.read()).toMatchObject({ last_result: "interrupted", failures: 0 });
  });

  it("keeps an outcome until it is stored, notifying once", async () => {
    const env = await setup();
    await env.runner.runNow(env.schedule.id, NINE);
    env.finish({ exitCode: 1 });
    const update = env.deps.update as ReturnType<typeof vi.fn>;
    const real = update.getMockImplementation()!;
    update.mockImplementationOnce(async () => { throw new Error("db locked"); });
    await env.runner.settle(NINE + MIN);
    expect((await env.read()).last_result).toBe("running");
    update.mockImplementation(real);
    await env.runner.settle(NINE + 2 * MIN);
    expect((await env.read()).last_result).toBe("failed");
    expect(env.notified).toHaveLength(1);
  });

  it("a pause between the runner's read and its claim wins: nothing starts", async () => {
    const env = await setup();
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    await env.runner.tick(NINE - 1000);
    const list = env.deps.list;
    let first = true;
    env.deps.list = async () => {
      const rows = await list();
      if (first) { first = false; await env.backend.updateSchedule(env.schedule.id, { paused: true }); }
      return rows;
    };
    await env.runner.tick(NINE + 1000);
    expect(env.started()).toEqual([]);
  });

  it("an archived workstream's schedule neither runs when due nor on Run now or a reply", async () => {
    const env = await setup();
    await env.backend.updateSchedule(env.schedule.id, { next_run_at: NINE });
    env.archived.add(env.ws.id);
    await env.through(NINE);
    await expect(env.runner.runNow(env.schedule.id, NINE)).rejects.toThrow(/archived/);
    await expect(env.runner.reply(env.schedule.id, "x", "reply", NINE)).rejects.toThrow(/archived/);
    expect(env.started()).toEqual([]);
  });

  it("Run now runs a paused schedule once and leaves it paused; an expired request doesn't run", async () => {
    const env = await setup({ runner: { startedAt: NINE } });
    await env.backend.updateSchedule(env.schedule.id, { paused: true });
    await env.runner.runNow(env.schedule.id, NINE + MIN);
    expect(env.started()).toEqual([{ prompt: "Check for new videos", kind: "manual" }]);
    expect((await env.read()).paused).toBe(true);
    env.finish({ exitCode: 0 });
    await env.runner.settle(NINE + 2 * MIN);
    await env.backend.updateSchedule(env.schedule.id, { run_requested: true, run_requested_at: NINE - RUN_REQUEST_TTL_MS });
    await env.runner.tick(NINE + 3 * MIN);
    expect(env.started()).toHaveLength(1);
    expect((await env.read()).run_requested).toBe(false);
  });

  it("forgets a run whose schedule was deleted, never overlaps ticks, and says when Run now names nothing", async () => {
    const env = await setup();
    await env.runner.runNow(env.schedule.id, NINE);
    await env.backend.deleteSchedule(env.schedule.id);
    await env.runner.settle(NINE + MIN);
    const a = env.runner.tick(NINE + 2 * MIN);
    const b = env.runner.tick(NINE + 2 * MIN);
    expect(a).toBe(b);
    await a;
    await expect(env.runner.runNow("nope", NINE)).rejects.toThrow(/No schedule/);
  });
});
