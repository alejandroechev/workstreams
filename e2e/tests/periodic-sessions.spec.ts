/**
 * Periodic Copilot sessions (ADR 044), in the real app on the in-memory
 * backend. The scheduler's timer is off (__WS_SCHEDULER_MANUAL__); the spec
 * drives it with a fake clock through __WS_SCHEDULER__.tick(now) (awake just
 * before each slot, as the runner requires), and reads
 * what it spawned from __WS_INVOKE_LOG__. Covers AT-1, AT-2 (UI half), AT-3,
 * AT-4 (busy), AT-5 and AT-10 (UI half) of
 * files/features/periodic-sessions/acceptance.md; the rest are unit and
 * native tests (see the ADR).
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { PeriodicSchedule } from "../../src/domain/periodic-schedules";

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
        projects: [{ name: "Repo", directory: "/repo", copilot_command: "repo-copilot --model x" }],
        workstreams: [
          { name: "Courses", directory: "/courses", project: "Repo",
            tiles: [{ type: "copilot_session", title: "Videos", config: { copilot_session_id: "s-videos", cwd: "/courses" } }] },
          { name: "Infra", directory: "/infra", project: "Repo",
            tiles: [{ type: "copilot_session", title: "CI", config: { copilot_session_id: "s-ci", cwd: "/infra" } }] },
          { name: "Scratch", directory: "/scratch" },
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

async function target(page: Page, wsName: string) {
  const ws = (await call<Array<{ id: string; name: string; is_loaded?: boolean }>>(page, "listWorkstreams")).find((w) => w.name === wsName)!;
  const tile = (await call<Array<{ id: string; tile_type: string; title: string }>>(page, "listTiles", ws.id)).find((t) => t.tile_type === "copilot_session")!;
  return { ws, tile };
}

const schedules = (page: Page) => call<PeriodicSchedule[]>(page, "listSchedules");
const tick = (page: Page, now: number) => page.evaluate((at) => (window as unknown as SpecWindow).__WS_SCHEDULER__.tick(at), now);
const spawns = (page: Page, tileId?: string) =>
  page.evaluate((id) => ((window as unknown as SpecWindow).__WS_INVOKE_LOG__ ?? [])
    .filter((e) => e.cmd === "spawn_copilot_session" && (!id || e.args.tileId === id) && e.args.initialPrompt !== null)
    .map((e) => ({ tileId: e.args.tileId as string, command: e.args.command as string, session: e.args.resumeSessionId as string, prompt: e.args.initialPrompt as string })), tileId);
/** The scheduler is awake just before `due`, then reaches it: only then does a slot run (finding 8). */
async function tickThrough(page: Page, due: number) {
  await tick(page, due - 1_000);
  await tick(page, due + 1_000);
}
/** The run's turn starts and ends, as the session poller reports it (finding 7). */
async function finishTurn(page: Page, tileId: string, at: number) {
  const emit = (status: string) => page.evaluate(({ id, status }) => (window as unknown as SpecWindow).__WS_EMIT__(`copilot-stats-${id}`, { activity_status: status }), { id: tileId, status });
  await emit("thinking");
  await tick(page, at);
  await emit("idle");
  await tick(page, at + 1_000);
}
const row = (page: Page, id: string) => page.locator(`[data-testid="workstream-item"][data-workstream-id="${id}"]`);

async function schedule(page: Page, wsName: string, prompt: string, nextRunAt: number) {
  const { ws, tile } = await target(page, wsName);
  const created = await call<PeriodicSchedule>(page, "createSchedule", {
    tileId: tile.id, workstreamId: ws.id, prompt, frequency: { kind: "interval", minutes: 60 }, notifyInbox: false, notifyPhone: false, nextRunAt, createdAt: nextRunAt - 3_600_000,
  });
  return { ws, tile, created };
}

function nextNineLabel(): string {
  return new Date().getHours() < 9 ? "today 09:00" : "tomorrow 09:00";
}

test("AT-1: converting a session tile into a periodic one shows the badge and the Schedules row, without running", async ({ page }) => {
  const { ws, tile } = await target(page, "Courses");
  await row(page, ws.id).click();
  await page.getByTestId(`tile-menu-${tile.id}`).click();
  await page.getByTestId("tile-menu-run-periodically").click();
  await page.getByTestId("schedule-prompt").fill("Check the course for new videos\nand update the summary");
  await expect(page.getByTestId("schedule-frequency")).toHaveValue("daily");
  await expect(page.getByTestId("schedule-time")).toHaveValue("09:00");
  await page.getByTestId("schedule-save").click();
  await expect(page.getByTestId("schedule-editor")).toHaveCount(0);

  await expect(page.getByTestId(`tile-schedule-badge-${tile.id}`)).toContainText(`next: ${nextNineLabel()}`);
  const [stored] = await schedules(page);
  const next = new Date(stored.next_run_at!);
  expect([next.getHours(), next.getMinutes()]).toEqual([9, 0]);
  expect(stored.next_run_at!).toBeGreaterThan(Date.now());

  await page.getByTestId("schedules-button").click();
  const modalRow = page.getByTestId(`schedule-row-${stored.id}`);
  await expect(modalRow.getByTestId("schedule-row-workstream")).toHaveText("Courses");
  await expect(modalRow.getByTestId("schedule-row-prompt")).toHaveText("Check the course for new videos");
  expect(await spawns(page)).toEqual([]);
});

test("AT-2: adding a Periodic Copilot session tile stores its schedule; under 5 minutes is refused", async ({ page }) => {
  const { ws } = await target(page, "Scratch");
  await row(page, ws.id).click();
  await page.getByTestId("add-tile-button").click();
  await page.getByTestId("add-tile-item-periodic-session").click();
  await page.getByTestId("schedule-prompt").fill("Check CI health");
  await page.getByTestId("schedule-frequency").selectOption("minutes");
  await page.getByTestId("schedule-every").fill("1");
  await page.getByTestId("schedule-save").click();
  await expect(page.getByTestId("schedule-error")).toContainText("5 minutes");
  expect(await schedules(page)).toEqual([]);

  await page.getByTestId("schedule-frequency").selectOption("hours");
  await page.getByTestId("schedule-every").fill("2");
  await page.getByTestId("schedule-save").click();
  await expect(page.getByTestId("schedule-editor")).toHaveCount(0);
  const stored = await schedules(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ workstream_id: ws.id, frequency: { kind: "interval", minutes: 120 }, prompt: "Check CI health" });
  await expect(page.getByTestId(`tile-schedule-badge-${stored[0].tile_id}`)).toBeVisible();
  // A fresh session tile, started without the prompt.
  expect(await spawns(page)).toEqual([]);
});

test("AT-3: a due run mounts the workstream in the background and resumes its session with exactly the prompt", async ({ page }) => {
  const due = Date.now() + 3_600_000;
  const { ws, tile } = await schedule(page, "Infra", "Check CI health\nand report", due);
  await tick(page, due - 1);
  expect(await spawns(page)).toEqual([]);
  await tick(page, due + 5_000);
  await expect.poll(() => spawns(page, tile.id)).toEqual([
    { tileId: tile.id, command: "repo-copilot --model x", session: "s-ci", prompt: "Check CI health\nand report" },
  ]);
  await tick(page, due + 10_000);
  expect(await spawns(page, tile.id)).toHaveLength(1);
  // Mounted in the background (and kept loaded), the active workstream untouched.
  await expect.poll(async () => (await target(page, "Infra")).ws.is_loaded).toBe(true);
  await expect(row(page, ws.id)).toHaveAttribute("data-active", "false");
  expect((await schedules(page))[0]).toMatchObject({ last_result: "running", last_run_at: due + 5_000 });
});

test("AT-4: a run due while the agent is mid-turn is skipped without interrupting", async ({ page }) => {
  const due = Date.now() + 3_600_000;
  const { ws, tile } = await schedule(page, "Infra", "Check CI health", due);
  await row(page, ws.id).click();
  await expect(page.locator(`[data-tile-id="${tile.id}"]`)).toBeVisible();
  await tick(page, due - 1_000);
  await page.evaluate((id) => (window as unknown as SpecWindow).__WS_EMIT__(`copilot-stats-${id}`, { activity_status: "thinking" }), tile.id);
  await tick(page, due + 1_000);
  expect(await spawns(page, tile.id)).toEqual([]);
  const writes = await page.evaluate((id) => ((window as unknown as SpecWindow).__WS_INVOKE_LOG__ ?? []).filter((e) => e.cmd === "write_to_pty" && e.args.tileId === id).length, tile.id);
  expect(writes).toBe(0);
  expect((await schedules(page))[0]).toMatchObject({ last_result: "skipped", failures: 0 });
  await expect(page.getByTestId(`tile-schedule-badge-${tile.id}`)).toContainText("last: skipped");
});

test("AT-5: Run now, Pause, Edit and Delete from the Schedules modal; clock icons mark scheduled workstreams", async ({ page }) => {
  const due = Date.now() + 3_600_000;
  const courses = await schedule(page, "Courses", "Check for new videos", due + 7_200_000);
  const infra = await schedule(page, "Infra", "Check CI health", due);
  const scratch = await target(page, "Scratch");
  await page.getByTestId("schedules-button").click();
  await expect(page.locator('[data-testid^="schedule-row-"][data-paused]')).toHaveCount(2);
  for (const id of [courses.ws.id, infra.ws.id]) await expect(page.getByTestId(`ws-schedules-${id}`)).toBeVisible();
  await expect(page.getByTestId(`ws-schedules-${scratch.ws.id}`)).toHaveCount(0);

  await page.getByTestId(`schedule-run-${courses.created.id}`).click();
  await expect.poll(() => spawns(page, courses.tile.id)).toEqual([expect.objectContaining({ session: "s-videos", prompt: "Check for new videos" })]);
  await finishTurn(page, courses.tile.id, Date.now() + 60_000);

  await page.getByTestId(`schedule-pause-${infra.created.id}`).click();
  await expect(page.getByTestId(`schedule-row-${infra.created.id}`)).toHaveAttribute("data-paused", "true");
  await expect(page.getByTestId(`schedule-row-${infra.created.id}`).getByTestId("schedule-row-next")).toHaveText("paused");
  await tickThrough(page, due);
  expect(await spawns(page, infra.tile.id)).toEqual([]);

  await page.getByTestId(`schedule-edit-${courses.created.id}`).click();
  await page.getByTestId("schedule-prompt").fill("Check for new videos and summarise");
  await page.getByTestId("schedule-frequency").selectOption("hours");
  await page.getByTestId("schedule-every").fill("3");
  await page.getByTestId("schedule-save").click();
  const edited = (await schedules(page)).find((s) => s.id === courses.created.id)!;
  expect(edited.frequency).toEqual({ kind: "interval", minutes: 180 });
  await tickThrough(page, edited.next_run_at!);
  await expect.poll(async () => (await spawns(page, courses.tile.id)).map((s) => s.prompt))
    .toEqual(["Check for new videos", "Check for new videos and summarise"]);

  await page.getByTestId(`schedule-delete-${infra.created.id}`).click();
  await expect(page.getByTestId(`schedule-row-${infra.created.id}`)).toHaveCount(0);
  expect((await call<unknown[]>(page, "listTiles", infra.ws.id))).toHaveLength(1);
  await expect(page.getByTestId(`ws-schedules-${infra.ws.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`ws-schedules-${courses.ws.id}`)).toBeVisible();
});

test("AT-10: closing the tile deletes its schedule; a re-linked tile's next run resumes the new session", async ({ page }) => {
  const due = Date.now() + 3_600_000;
  const courses = await schedule(page, "Courses", "Check for new videos", due);
  const infra = await schedule(page, "Infra", "Check CI health", due);
  await call(page, "updateTileConfig", infra.tile.id, JSON.stringify({ copilot_session_id: "s-ci-2", cwd: "/infra" }));
  await tickThrough(page, due);
  await expect.poll(() => spawns(page, infra.tile.id)).toEqual([expect.objectContaining({ session: "s-ci-2" })]);

  await row(page, courses.ws.id).click();
  await page.getByTestId(`tile-close-${courses.tile.id}`).click();
  await expect.poll(async () => (await schedules(page)).map((s) => s.id)).toEqual([infra.created.id]);
  await expect(page.getByTestId(`ws-schedules-${courses.ws.id}`)).toHaveCount(0);

  await call(page, "updateWorkstream", infra.ws.id, { status: "archived" });
  await call(page, "updateWorkstream", infra.ws.id, { status: "active" });
  expect((await schedules(page))[0].paused).toBe(true);
});
