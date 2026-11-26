/**
 * Headless periodic sessions (ADR 046), in the real app on the in-memory
 * backend. The scheduler's timer is off (__WS_SCHEDULER_MANUAL__); the spec
 * drives it with a fake clock through __WS_SCHEDULER__.tick(now) (awake just
 * before each slot, as the runner requires), reads the headless runs it
 * started from __WS_INVOKE_LOG__ (`periodic_run_start`, with the argv the
 * native runner would build), and ends or streams runs through the in-memory
 * backend's hooks. Covers AT-1 to AT-6, AT-8 and the UI half of AT-9 of
 * files/features/headless-periodic-sessions/acceptance.md; the native halves
 * (fake launcher, 60-minute kill, 50-run cap across restarts, migration on a
 * seeded old database, the agent CLI) are Rust tests.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import { NEEDS_INPUT_INSTRUCTION, type PeriodicSchedule } from "../../src/domain/periodic-schedules";

type SpecWindow = {
  __WS_BACKEND__: MemoryBackend;
  __WS_SCHEDULER__: { tick(now: number): Promise<void> };
  __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }>;
  __WS_EMIT__: (event: string, payload?: unknown) => void;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __WS_SCHEDULER_MANUAL__: true,
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: {
        projects: [{ name: "Repo", directory: "/repo", copilot_command: "my-copilot --yolo --model x" }],
        workstreams: [
          { name: "Infra", directory: "/infra", project: "Repo",
            tiles: [{ type: "copilot_session", title: "CI", config: { copilot_session_id: "s-ci", cwd: "/infra" } }] },
          { name: "Courses", directory: "/courses", project: "Repo",
            tiles: [
              { type: "copilot_session", title: "Videos", config: { copilot_session_id: "S1", cwd: "/courses" },
                legacySchedule: { prompt: "Check for new videos", frequency: { kind: "daily", time: "09:00" }, notifyInbox: true } },
              { type: "copilot_session", title: "Digest", config: { resume_by_id: "S2", cwd: "/courses" },
                legacySchedule: { prompt: "Digest the week", frequency: { kind: "interval", minutes: 120 }, paused: true } },
            ] },
        ],
      },
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("workstream-item").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as SpecWindow).__WS_SCHEDULER__)).toBe("object");
});

const call = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as SpecWindow).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

type Ws = { id: string; name: string };
type TileRow = { id: string; tile_type: string; title: string; config_json: string };
const workstream = async (page: Page, name: string) => (await call<Ws[]>(page, "listWorkstreams")).find((w) => w.name === name)!;
const tilesOf = (page: Page, wsId: string) => call<TileRow[]>(page, "listTiles", wsId);
const schedules = (page: Page) => call<PeriodicSchedule[]>(page, "listSchedules");
const scheduleOf = async (page: Page, tileId: string) => (await schedules(page)).find((s) => s.tile_id === tileId)!;
const tick = (page: Page, now: number) => page.evaluate((at) => (window as unknown as SpecWindow).__WS_SCHEDULER__.tick(at), now);
const row = (page: Page, id: string) => page.locator(`[data-testid="workstream-item"][data-workstream-id="${id}"]`);
const log = (page: Page) => page.evaluate(() => (window as unknown as SpecWindow).__WS_INVOKE_LOG__ ?? []);
/** Headless runs started for a tile: the argv the native runner builds, its cwd and prompt. */
const runs = async (page: Page, tileId: string) => (await log(page))
  .filter((e) => e.cmd === "periodic_run_start" && e.args.tileId === tileId)
  .map((e) => ({ program: e.args.program as string, args: e.args.args as string[], cwd: e.args.cwd as string, prompt: e.args.prompt as string, kind: e.args.kind as string }));
/** The scheduler is awake just before `due`, then reaches it: only then does a slot run. */
async function tickThrough(page: Page, due: number) {
  await tick(page, due - 1_000);
  await tick(page, due + 1_000);
}
const finish = (page: Page, tileId: string, end: Record<string, unknown>) =>
  page.evaluate(({ tileId, end }) => { (window as unknown as SpecWindow).__WS_BACKEND__.finishPeriodicRunForTests(tileId, end); }, { tileId, end });
const inbox = async (page: Page) => (await call<{ agent_messages?: Array<{ title: string; body: string; level: string; tile_id: string }> }>(page, "getPrInbox")).agent_messages ?? [];

/** A Periodic session tile in `wsName`, made as Add tile → Periodic session makes one, shown in the app. */
async function periodic(page: Page, wsName: string, prompt: string, nextRunAt: number, over: { minutes?: number; notifyInbox?: boolean } = {}) {
  const ws = await workstream(page, wsName);
  const tile = await call<TileRow>(page, "createTile", ws.id, "periodic_session", prompt, "{}");
  const created = await call<PeriodicSchedule>(page, "createSchedule", {
    tileId: tile.id, workstreamId: ws.id, prompt, frequency: { kind: "interval", minutes: over.minutes ?? 60 },
    notifyInbox: over.notifyInbox ?? false, notifyPhone: false, nextRunAt, createdAt: nextRunAt - 3_600_000, sessionId: "S",
  });
  await page.evaluate((t) => (window as unknown as SpecWindow).__WS_EMIT__("tile-created", t), tile);
  await row(page, ws.id).click();
  await expect(page.locator(`[data-tile-id="${tile.id}"]`).getByTestId("periodic-session-tile")).toBeVisible();
  return { ws, tile, created };
}
const inTile = (page: Page, tileId: string) => page.locator(`[data-tile-id="${tileId}"]`);

test("AT-1: Add tile → Periodic session makes a terminal-less tile that runs nothing; ordinary tiles have no Run periodically", async ({ page }) => {
  const ws = await workstream(page, "Infra");
  await row(page, ws.id).click();
  const [ordinary] = await tilesOf(page, ws.id);
  await expect(page.locator(`[data-tile-id="${ordinary.id}"]`)).toBeVisible();
  await expect(page.getByTestId(`tile-menu-${ordinary.id}`)).toHaveCount(0);
  await expect(page.getByTestId("tile-menu-run-periodically")).toHaveCount(0);

  await page.getByTestId("add-tile-button").click();
  await expect(page.getByTestId("add-tile-item-periodic-session")).toContainText("Periodic session");
  await page.getByTestId("add-tile-item-periodic-session").click();
  await page.getByTestId("schedule-prompt").fill("Check CI health");
  await page.getByTestId("schedule-frequency").selectOption("minutes");
  await page.getByTestId("schedule-every").fill("1");
  await page.getByTestId("schedule-save").click();
  await expect(page.getByTestId("schedule-error")).toContainText("5 minutes");
  expect((await schedules(page)).filter((s) => s.workstream_id === ws.id)).toEqual([]);
  expect((await tilesOf(page, ws.id)).map((t) => t.tile_type)).toEqual(["copilot_session"]);

  await page.getByTestId("schedule-frequency").selectOption("hours");
  await page.getByTestId("schedule-every").fill("2");
  const before = Date.now();
  await page.getByTestId("schedule-save").click();
  await expect(page.getByTestId("schedule-editor")).toHaveCount(0);
  const stored = (await schedules(page)).filter((s) => s.workstream_id === ws.id);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ frequency: { kind: "interval", minutes: 120 }, prompt: "Check CI health", session_started: false });
  expect(stored[0].next_run_at! - before).toBeGreaterThan(119 * 60_000);
  const tile = (await tilesOf(page, ws.id)).find((t) => t.id === stored[0].tile_id)!;
  expect(tile.tile_type).toBe("periodic_session");
  const view = inTile(page, tile.id);
  await expect(view.getByTestId("periodic-header")).toContainText("Every 2 hours");
  await expect(view.getByTestId("periodic-next")).toContainText("next:");
  await expect(view.getByTestId("periodic-last")).toHaveText("no runs yet");
  await expect(view.getByTestId("periodic-empty")).toBeVisible();
  for (const id of ["periodic-run-now", "periodic-edit", "periodic-open-interactive"]) await expect(view.getByTestId(id)).toBeVisible();
  await expect(view.locator(".xterm")).toHaveCount(0);
  // No process started: no headless run, no terminal, no Copilot session.
  const started = (await log(page)).filter((e) => e.args.tileId === tile.id);
  expect(started).toEqual([]);
});

test("AT-2: two due slots are two headless calls on one session: --session-id first, then --resume", async ({ page }) => {
  const due = Date.now() + 3_600_000;
  const { tile } = await periodic(page, "Infra", "Check CI health", due);
  await tick(page, due - 30_000);
  expect(await runs(page, tile.id)).toEqual([]);
  await tick(page, due + 1_000);
  await expect.poll(async () => (await runs(page, tile.id)).length).toBe(1);
  await finish(page, tile.id, { exitCode: 0, answer: "All green" });
  await tickThrough(page, due + 3_600_000);
  await expect.poll(async () => (await runs(page, tile.id)).length).toBe(2);
  await finish(page, tile.id, { exitCode: 0, answer: "Still green" });
  const [first, second] = await runs(page, tile.id);
  const prompt = `Check CI health\n\n${NEEDS_INPUT_INSTRUCTION}`;
  expect(first).toEqual({
    program: "my-copilot", cwd: "/infra", prompt: "Check CI health", kind: "scheduled",
    args: ["--yolo", "--model", "x", "-p", prompt, "--session-id=S", "--no-ask-user", "--output-format", "json"],
  });
  expect(second.args).toEqual(["--yolo", "--model", "x", "-p", prompt, "--resume=S", "--no-ask-user", "--output-format", "json"]);
  // No terminal, no setup prompt.
  expect((await log(page)).filter((e) => (e.cmd === "spawn_copilot_session" || e.cmd === "spawn_terminal") && e.args.tileId === tile.id)).toEqual([]);
  await expect(inTile(page, tile.id).locator('[data-testid^="periodic-run-row-"]')).toHaveCount(2);
  await expect(inTile(page, tile.id).locator('[data-testid^="periodic-run-row-"][data-status="ok"]')).toHaveCount(2);
  expect((await scheduleOf(page, tile.id)).last_result).toBe("ok");
});

test("AT-3: a slot due while a run goes is skipped; three failures in a row pause with one Inbox entry, an ok resets", async ({ page }) => {
  const due = Date.now() + 3_600_000;
  const { tile } = await periodic(page, "Infra", "Check CI health", due);
  await tickThrough(page, due);
  await tickThrough(page, due + 3_600_000);
  expect(await runs(page, tile.id)).toHaveLength(1);
  const view = inTile(page, tile.id);
  await expect(view.locator('[data-testid^="periodic-run-row-"]').first()).toHaveAttribute("data-status", "skipped");
  await finish(page, tile.id, { exitCode: 1 });
  await expect.poll(async () => (await scheduleOf(page, tile.id)).failures).toBe(1);

  const runNow = async (end: Record<string, unknown>, count: number) => {
    await view.getByTestId("periodic-run-now").click();
    await expect.poll(async () => (await runs(page, tile.id)).length).toBe(count);
    await finish(page, tile.id, end);
  };
  await runNow({ exitCode: 0, answer: "fine" }, 2);
  await expect.poll(async () => (await scheduleOf(page, tile.id)).failures).toBe(0);
  await runNow({ exitCode: 1 }, 3);
  await runNow({ timedOut: true }, 4);
  await expect.poll(async () => (await scheduleOf(page, tile.id)).failures).toBe(2);
  expect((await scheduleOf(page, tile.id)).paused).toBe(false);
  await runNow({ spawnError: "No such file" }, 5);
  await expect.poll(async () => (await scheduleOf(page, tile.id)).paused).toBe(true);
  expect((await inbox(page)).filter((m) => m.title.startsWith("Schedule paused"))).toHaveLength(1);
  await expect(view.getByTestId("periodic-next")).toHaveText("Paused");
  await expect(view.getByTestId("periodic-last")).toHaveText("last: failed");
});

test("AT-4: a needs-input run is amber with its question and an Inbox entry; the reply runs the next turn on the session", async ({ page }) => {
  const { tile } = await periodic(page, "Infra", "Check CI health", Date.now() + 3_600_000);
  const view = inTile(page, tile.id);
  await view.getByTestId("periodic-run-now").click();
  await expect.poll(async () => (await runs(page, tile.id)).length).toBe(1);
  await finish(page, tile.id, { exitCode: 0, answer: "NEEDS INPUT: Skip the flaky test or just report it?" });
  await expect(view.locator('[data-testid^="periodic-run-row-"]').first()).toHaveAttribute("data-status", "needs_input");
  await expect(view.getByTestId("periodic-run-question")).toContainText("Skip the flaky test or just report it?");
  await expect(view.getByTestId("periodic-last")).toHaveText("last: needs input");
  await expect.poll(async () => (await inbox(page)).map((m) => [m.level, m.title, m.body])).toEqual([
    ["needs-you", "Needs input: Check CI health", "Skip the flaky test or just report it?"],
  ]);
  expect((await scheduleOf(page, tile.id)).failures).toBe(0);

  await view.getByTestId("periodic-reply-input").fill("Just report it");
  await view.getByTestId("periodic-reply-send").click();
  await expect.poll(async () => (await runs(page, tile.id)).length).toBe(2);
  const reply = (await runs(page, tile.id))[1];
  expect(reply.kind).toBe("reply");
  expect(reply.args.slice(reply.args.indexOf("-p"), reply.args.indexOf("-p") + 3)).toEqual(["-p", `Just report it\n\n${NEEDS_INPUT_INSTRUCTION}`, "--resume=S"]);
  await expect(view.locator('[data-testid^="periodic-run-row-"]')).toHaveCount(2);
  await expect(view.locator('[data-testid^="periodic-run-row-"]').first()).toHaveAttribute("data-status", "running");
});

test("AT-5: the run log streams a run live, shows result, start and duration, and keeps the newest 50", async ({ page }) => {
  const { tile, created } = await periodic(page, "Infra", "Check CI health", Date.now() + 3_600_000);
  const view = inTile(page, tile.id);
  await view.getByTestId("periodic-run-now").click();
  await expect.poll(async () => (await runs(page, tile.id)).length).toBe(1);
  await expect(view.locator('[data-testid^="periodic-run-row-"]').first()).toHaveAttribute("data-status", "running");
  await page.evaluate((id) => (window as unknown as SpecWindow).__WS_BACKEND__.periodicRunEventForTests(id, { tool: { id: "c1", name: "bash", status: "running" } }), tile.id);
  await expect(view.getByTestId("periodic-tool")).toHaveText("bash (running)");
  await expect(view.getByTestId("periodic-run-answer")).toHaveCount(0);
  await page.evaluate((id) => (window as unknown as SpecWindow).__WS_BACKEND__.periodicRunEventForTests(id, { tool: { id: "c1", name: "bash", status: "ok" }, answer: "Two pipelines failed." }), tile.id);
  await expect(view.getByTestId("periodic-tool")).toHaveText("bash (ok)");
  await expect(view.getByTestId("periodic-run-answer")).toHaveText("Two pipelines failed.");
  await finish(page, tile.id, { exitCode: 0, at: Date.now() + 192_000 });
  const first = view.locator('[data-testid^="periodic-run-row-"]').first();
  await expect(first).toHaveAttribute("data-status", "ok");
  await expect(first).toContainText("Today");
  await expect(first).toContainText(/\dm \d+s/);

  await page.evaluate((id) => (window as unknown as SpecWindow).__WS_BACKEND__.seedPeriodicRunsForTests(id, 55, Date.now() - 86_400_000), tile.id);
  await call(page, "updateSchedule", created.id, { notify_phone: false });
  await tick(page, Date.now());
  await expect(view.locator('[data-testid^="periodic-run-row-"]')).toHaveCount(50);
});

test("AT-6: Open interactively resumes the session in an ordinary tile and pauses the schedule until it closes", async ({ page }) => {
  const due = Date.now() + 3_600_000;
  const { ws, tile } = await periodic(page, "Infra", "Check CI health", due);
  const view = inTile(page, tile.id);
  // The first run creates the session; only then can it be opened.
  await expect(view.getByTestId("periodic-open-interactive")).toBeDisabled();
  await view.getByTestId("periodic-run-now").click();
  await expect.poll(async () => (await runs(page, tile.id)).length).toBe(1);
  await finish(page, tile.id, { exitCode: 0, answer: "ok" });
  await expect(view.getByTestId("periodic-open-interactive")).toBeEnabled();

  await view.getByTestId("periodic-open-interactive").click();
  await expect.poll(async () => (await tilesOf(page, ws.id)).length).toBe(3);
  const interactive = (await tilesOf(page, ws.id)).find((t) => t.tile_type === "copilot_session" && t.title.endsWith("(interactive)"))!;
  expect(JSON.parse(interactive.config_json)).toMatchObject({ copilot_session_id: "S", resume_by_id: "S" });
  await expect.poll(async () => (await log(page)).filter((e) => e.cmd === "spawn_copilot_session" && e.args.tileId === interactive.id).map((e) => e.args.resumeSessionId)).toEqual(["S"]);
  await expect(view.getByTestId("periodic-next")).toHaveText("Paused while open interactively");
  await expect(view.getByTestId("periodic-run-now")).toBeDisabled();
  await view.getByTestId("periodic-reply-input").fill("Anything new?");
  await expect(view.getByTestId("periodic-reply-send")).toBeDisabled();
  await tickThrough(page, due);
  expect(await runs(page, tile.id)).toHaveLength(1);

  await page.getByTestId(`tile-close-${interactive.id}`).click();
  await expect(view.getByTestId("periodic-next")).toContainText("next:");
  await tick(page, due + 5_000);
  expect((await scheduleOf(page, tile.id)).next_run_at!).toBeGreaterThan(due + 5_000);
  expect(await runs(page, tile.id)).toHaveLength(1);
  await view.getByTestId("periodic-run-now").click();
  await expect.poll(async () => (await runs(page, tile.id)).length).toBe(2);
});

test("AT-8: schedules from before migrate to Periodic session tiles on the same sessions; the old tiles notice it once", async ({ page }) => {
  const ws = await workstream(page, "Courses");
  const all = await tilesOf(page, ws.id);
  const periodicTiles = all.filter((t) => t.tile_type === "periodic_session");
  expect(periodicTiles).toHaveLength(2);
  const stored = (await schedules(page)).filter((s) => s.workstream_id === ws.id);
  expect(stored.map((s) => [s.session_id, s.prompt, s.paused, s.notify_inbox])).toEqual([
    ["S1", "Check for new videos", false, true],
    ["S2", "Digest the week", true, false],
  ]);
  await row(page, ws.id).click();
  const old = all.filter((t) => t.tile_type === "copilot_session");
  for (const tile of old) {
    await expect(page.locator(`[data-tile-id="${tile.id}"] [data-last-notice]`)).toHaveAttribute("data-last-notice", /schedule moved/);
  }
  // Shown once: the notice is gone from the stored config.
  await expect.poll(async () => (await tilesOf(page, ws.id)).filter((t) => t.config_json.includes("pending_notice")).length).toBe(0);
  // The old S1 tile is open on S1: the new S1 tile is paused while it is.
  const s1 = stored[0];
  await expect(inTile(page, s1.tile_id).getByTestId("periodic-next")).toHaveText("Paused while open interactively");
});

test("AT-9 (UI half): closing a Periodic session tile deletes its schedule; deleting a schedule removes its tile", async ({ page }) => {
  const a = await periodic(page, "Infra", "Check CI health", Date.now() + 3_600_000);
  await page.getByTestId(`tile-close-${a.tile.id}`).click();
  await expect.poll(async () => (await schedules(page)).some((s) => s.id === a.created.id)).toBe(false);
  const b = await periodic(page, "Infra", "Digest", Date.now() + 3_600_000);
  await page.getByTestId("schedules-button").click();
  await page.getByTestId(`schedule-delete-${b.created.id}`).click();
  await expect(page.getByTestId(`schedule-row-${b.created.id}`)).toHaveCount(0);
  expect((await tilesOf(page, b.ws.id)).some((t) => t.id === b.tile.id)).toBe(false);
  await expect(page.locator(`[data-tile-id="${b.tile.id}"]`)).toHaveCount(0);
});
