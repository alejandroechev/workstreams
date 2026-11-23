/**
 * Phone messages from any agent, and scheduled runs in the phone thread
 * (ADR 044), in the real app: the spec plays the paired phone through the
 * in-memory hub (the VITE_E2E seam in main.tsx), reads what the laptop
 * publishes and verifies it as the phone would. Covers AT-7 (publishing half;
 * the 20/hour cap and the companion-off refusal through the real CLI are in
 * agent_cli_scenario.rs) and AT-8 of files/features/periodic-sessions/acceptance.md.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readSessions, verifySessions, type CompanionDocument } from "../../src/companion/protocol";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { PeriodicSchedule } from "../../src/domain/periodic-schedules";

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

const spawns = (page: Page, tileId: string) =>
  page.evaluate((id) => ((window as unknown as PhoneWindow).__WS_INVOKE_LOG__ ?? [])
    .filter((e) => e.cmd === "spawn_copilot_session" && e.args.tileId === id && e.args.initialPrompt !== null)
    .map((e) => `${e.args.resumeSessionId}:${e.args.initialPrompt}`), tileId);

test("AT-7: a laptop tile's first phone message opens a verified thread named after the tile", async ({ page }) => {
  const { tiles: all } = await tiles(page);
  const notes = all.find((t) => t.title === "Notes")!;
  await agentReplies(page, notes.id, "## Summary\n3 new videos");
  await expect.poll(async () => (await verified(page)).map((s) => s.title)).toEqual(["Notes"]);
  const [session] = await verified(page);
  expect(session.messages.map((m) => [m.kind, m.text])).toEqual([["result", "## Summary\n3 new videos"]]);
  // The Inbox is unchanged by companion-reply.
  expect((await page.evaluate(() => (window as unknown as PhoneWindow).__WS_BACKEND__.getPrInbox())).agent_messages ?? []).toEqual([]);
});

test("AT-8: a scheduled tile's thread reads prompt, reply, prompt, reply, and the phone's message resumes it", async ({ page }) => {
  const { ws, tiles: all } = await tiles(page);
  const videos = all.find((t) => t.title === "Videos")!;
  const due = Date.now() + 3_600_000;
  const schedule = await page.evaluate(({ tileId, wsId, due }) => (window as unknown as PhoneWindow).__WS_BACKEND__.createSchedule({
    tileId, workstreamId: wsId, prompt: "Check for new videos", frequency: { kind: "interval", minutes: 60 },
    notifyInbox: false, notifyPhone: true, nextRunAt: due, createdAt: due - 3_600_000,
  }), { tileId: videos.id, wsId: ws.id, due }) as PeriodicSchedule;
  const tick = (now: number) => page.evaluate((at) => (window as unknown as PhoneWindow).__WS_SCHEDULER__.tick(at), now);

  await tick(due + 1_000);
  await expect.poll(() => spawns(page, videos.id)).toHaveLength(1);
  await agentReplies(page, videos.id, "Run 1: 2 new videos");
  await tick(due + 5 * 60_000);
  await tick(due + 3_600_000 + 1_000);
  await expect.poll(() => spawns(page, videos.id)).toHaveLength(2);
  await agentReplies(page, videos.id, "Run 2: nothing new");

  await expect.poll(async () => (await verified(page)).find((s) => s.title === "Videos")?.messages.map((m) => m.kind))
    .toEqual(["prompt", "result", "prompt", "result"]);
  const thread = (await verified(page)).find((s) => s.title === "Videos")!;
  expect(thread.messages[0].text).toContain("Check for new videos");
  expect(thread.messages[0].text).toContain("companion-reply");
  expect(thread.messages.map((m) => m.text).filter((_, i) => i % 2 === 1)).toEqual(["Run 1: 2 new videos", "Run 2: nothing new"]);
  expect(schedule.notify_phone).toBe(true);

  // The phone messages the session: it resumes the same session in the same tile.
  await expect.poll(async () => (await phone(page)).laptop.tiles?.find((t) => t.tileId === videos.id)?.linkRevision ?? null).not.toBeNull();
  const linkRevision = (await phone(page)).laptop.tiles!.find((t) => t.tileId === videos.id)!.linkRevision!;
  await page.evaluate(async ({ secret, request }) => {
    const w = window as unknown as PhoneWindow;
    const full = { ...request, createdAt: Date.now() };
    const signature = await w.__WS_COMPANION_SIGN__(secret, full);
    w.__WS_COMPANION_PHONE__.change((d) => { d.requests[full.id] = { ...full, signature }; });
  }, { secret: SECRET, request: { id: "m1", kind: "message", args: { workstreamId: ws.id, tileId: videos.id, linkRevision, prompt: "Summarise the second one" } } });
  await expect.poll(async () => (await phone(page)).requests.m1?.outcome?.status ?? "pending", { timeout: 15_000 }).toBe("done");
  const runs = await spawns(page, videos.id);
  expect(runs).toHaveLength(3);
  expect(runs[2]).toBe("s-videos:Summarise the second one");
});
