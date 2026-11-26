/**
 * Phone messages from any agent (ADR 044), and headless periodic runs
 * delivered to the Inbox and the phone thread by Workstreams itself (ADR 046),
 * in the real app: the spec plays the paired phone through the in-memory hub
 * (the VITE_E2E seam in main.tsx), reads what the laptop publishes and
 * verifies it as the phone would. Covers AT-7 of
 * files/features/headless-periodic-sessions/acceptance.md, and the laptop
 * thread of ADR 044's phone messages (its 20/hour cap and companion-off
 * refusal through the real CLI are in agent_cli_scenario.rs).
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readSessions, verifySessions, type CompanionDocument } from "../../src/companion/protocol";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import { NEEDS_INPUT_INSTRUCTION, type PeriodicSchedule } from "../../src/domain/periodic-schedules";

const SECRET: string = JSON.parse(
  readFileSync(new URL("../../src/companion/protocol/fixtures.json", import.meta.url), "utf8"),
).secret;

type PhoneWindow = {
  __WS_COMPANION_PHONE__: {
    read(): CompanionDocument & { laptop: { tiles?: Array<{ tileId: string; title: string; linkRevision: string | null }> }; requests: Record<string, { outcome?: { status: string; error?: string } }> };
    change(fn: (d: { requests: Record<string, unknown> }) => void): void;
  };
  __WS_COMPANION_SIGN__: (secret: string, request: unknown) => Promise<string>;
  __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }>;
  __WS_BACKEND__: MemoryBackend;
  __WS_SCHEDULER__: { tick(now: number): Promise<void> };
  __WS_EMIT__: (event: string, payload?: unknown) => void;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((secret) => {
    Object.assign(window, {
      __WS_SCHEDULER_MANUAL__: true,
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: {
        workstreams: [{
          name: "Courses", directory: "/courses",
          tiles: [
            { type: "copilot_session", title: "Videos", config: { copilot_session_id: "s-videos", cwd: "/courses" } },
            { type: "copilot_session", title: "Notes", config: { copilot_session_id: "s-notes", cwd: "/courses" } },
          ],
        }],
      },
      __WS_COMPANION_E2E__: {
        "companion.enabled": "1",
        "companion.doc_url": "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh",
        "companion.secret": secret,
        "companion.folder_root": "/phone",
      },
    });
  }, SECRET);
  await page.goto("/");
  await expect(page.getByTestId("workstream-item").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as PhoneWindow).__WS_SCHEDULER__)).toBe("object");
});

const phone = (page: Page) => page.evaluate(() => (window as unknown as PhoneWindow).__WS_COMPANION_PHONE__.read());
const verified = async (page: Page) => verifySessions(readSessions(await phone(page)), SECRET);

async function tiles(page: Page) {
  return page.evaluate(async () => {
    const b = (window as unknown as PhoneWindow).__WS_BACKEND__;
    const [ws] = await b.listWorkstreams();
    return { ws, tiles: await b.listTiles(ws.id) };
  });
}

/** What the agent's `companion.send` does, then the event it raises. */
const agentReplies = (page: Page, tileId: string, text: string) =>
  page.evaluate(({ tileId, text }) => {
    const w = window as unknown as PhoneWindow;
    w.__WS_BACKEND__.companionSendForTests(tileId, "result", text);
    w.__WS_EMIT__("state-changed", { entity: "companion_message", id: tileId, action: "added" });
  }, { tileId, text });

const runs = (page: Page, tileId: string) =>
  page.evaluate((id) => ((window as unknown as PhoneWindow).__WS_INVOKE_LOG__ ?? [])
    .filter((e) => e.cmd === "periodic_run_start" && e.args.tileId === id)
    .map((e) => ({ kind: e.args.kind as string, prompt: e.args.prompt as string, args: e.args.args as string[] })), tileId);
const finish = (page: Page, tileId: string, answer: string) =>
  page.evaluate(({ tileId, answer }) => { (window as unknown as PhoneWindow).__WS_BACKEND__.finishPeriodicRunForTests(tileId, { exitCode: 0, answer }); }, { tileId, answer });
const inbox = (page: Page) => page.evaluate(async () => ((await (window as unknown as PhoneWindow).__WS_BACKEND__.getPrInbox()).agent_messages ?? []).map((m) => [m.title, m.body, m.tile_id]));

test("a laptop tile's first phone message opens a verified thread named after the tile (ADR 044)", async ({ page }) => {
  const { tiles: all } = await tiles(page);
  const notes = all.find((t) => t.title === "Notes")!;
  await agentReplies(page, notes.id, "## Summary\n3 new videos");
  await expect.poll(async () => (await verified(page)).map((s) => s.title)).toEqual(["Notes"]);
  const [session] = await verified(page);
  expect(session.messages.map((m) => [m.kind, m.text])).toEqual([["result", "## Summary\n3 new videos"]]);
  // The Inbox is unchanged by companion-reply.
  expect(await inbox(page)).toEqual([]);
});

test("AT-7: Workstreams posts a run's answer to the Inbox and the phone thread; a phone reply runs a headless turn", async ({ page }) => {
  const { ws } = await tiles(page);
  const made = await page.evaluate(async ({ wsId }) => {
    const b = (window as unknown as PhoneWindow).__WS_BACKEND__;
    const tile = await b.createTile(wsId, "periodic_session", "CI health", "{}");
    const schedule = await b.createSchedule({
      tileId: tile.id, workstreamId: wsId, prompt: "Check CI health", frequency: { kind: "interval", minutes: 60 },
      notifyInbox: true, notifyPhone: true, nextRunAt: Date.now() + 3_600_000, createdAt: Date.now(), sessionId: "S",
    });
    (window as unknown as PhoneWindow).__WS_EMIT__("tile-created", tile);
    return { tile, schedule };
  }, { wsId: ws.id }) as { tile: { id: string }; schedule: PeriodicSchedule };
  const view = page.locator(`[data-tile-id="${made.tile.id}"]`);
  await page.locator(`[data-testid="workstream-item"][data-workstream-id="${ws.id}"]`).click();
  await view.getByTestId("periodic-run-now").click();
  await expect.poll(async () => (await runs(page, made.tile.id)).length).toBe(1);
  const [run] = await runs(page, made.tile.id);
  // The prompt carries only the needs-input instruction: no "post to Inbox/phone" ones.
  expect(run.args[run.args.indexOf("-p") + 1]).toBe(`Check CI health\n\n${NEEDS_INPUT_INSTRUCTION}`);
  expect(run.args.join(" ")).not.toMatch(/ws-message|companion-reply/);
  await finish(page, made.tile.id, "All green");

  await expect.poll(() => inbox(page)).toEqual([["Check CI health", "All green", made.tile.id]]);
  await expect.poll(async () => (await verified(page)).find((s) => s.title === "CI health")?.messages.map((m) => [m.kind, m.text]))
    .toEqual([["prompt", "Check CI health"], ["result", "All green"]]);

  // The phone replies in the tile's thread: one headless turn, its answer appended.
  await expect.poll(async () => (await phone(page)).laptop.tiles?.find((t) => t.tileId === made.tile.id)?.linkRevision ?? null).not.toBeNull();
  const linkRevision = (await phone(page)).laptop.tiles!.find((t) => t.tileId === made.tile.id)!.linkRevision!;
  await page.evaluate(async ({ secret, request }) => {
    const w = window as unknown as PhoneWindow;
    const full = { ...request, createdAt: Date.now() };
    const signature = await w.__WS_COMPANION_SIGN__(secret, full);
    w.__WS_COMPANION_PHONE__.change((d) => { d.requests[full.id] = { ...full, signature }; });
  }, { secret: SECRET, request: { id: "m1", kind: "message", args: { workstreamId: ws.id, tileId: made.tile.id, linkRevision, prompt: "Check again" } } });
  await expect.poll(async () => (await phone(page)).requests.m1?.outcome?.status ?? "pending", { timeout: 15_000 }).toBe("done");
  const phoneRun = (await runs(page, made.tile.id))[1];
  expect(phoneRun.kind).toBe("phone");
  expect(phoneRun.prompt).toBe("Check again");
  expect(phoneRun.args).toContain("--resume=S");
  await finish(page, made.tile.id, "Checked again: still green");
  await expect.poll(async () => (await verified(page)).find((s) => s.title === "CI health")?.messages.map((m) => m.text))
    .toEqual(["Check CI health", "All green", "Check again", "Checked again: still green"]);
  expect(await runs(page, made.tile.id)).toHaveLength(2);

  // With both toggles off, an ok run posts nothing.
  await page.evaluate((id) => (window as unknown as PhoneWindow).__WS_BACKEND__.updateSchedule(id, { notify_inbox: false, notify_phone: false }), made.schedule.id);
  await page.evaluate(() => (window as unknown as PhoneWindow).__WS_SCHEDULER__.tick(Date.now()));
  const before = (await inbox(page)).length;
  const thread = (await verified(page)).find((s) => s.title === "CI health")!.messages.length;
  await view.getByTestId("periodic-run-now").click();
  await expect.poll(async () => (await runs(page, made.tile.id)).length).toBe(3);
  await finish(page, made.tile.id, "Quiet");
  await expect(view.locator('[data-testid^="periodic-run-row-"]').first()).toHaveAttribute("data-status", "ok");
  expect((await inbox(page)).length).toBe(before);
  expect((await verified(page)).find((s) => s.title === "CI health")!.messages.length).toBe(thread);
});
