/**
 * Mute all (ADR 045), in the browser build: the in-memory backend plays every
 * Inbox source (PR poll, pipeline poller, digest, agent and app messages,
 * sync alerts) on a clock the spec drives. Covers AT-9 and the UI half of
 * AT-10 of files/features/pipeline-digest-and-inbox-mute/acceptance.md; the
 * agent CLI half is agent_cli_scenario.rs and each native writer's gate has
 * its own unit test.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";

const SNAPSHOT = { timeout: 12_000 };
type SpecWindow = { __WS_BACKEND__: MemoryBackend; __DIGEST_NOW__: number };

async function start(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: {
        projects: [{ name: "Repo", directory: "/demo/repo", git_remote: "https://dev.azure.com/o/p/_git/r" }],
        workstreams: [{ name: "Read chunks", directory: "/demo/read-chunks", loaded: true }],
      },
    });
  });
  await page.goto("/");
  await page.getByTestId("workstream-item").filter({ hasText: "Read chunks" }).click();
  await useClock(page, 1, 9, 30);
}

/** The backend's clock follows __DIGEST_NOW__ (local time on day `d` of March 2100). */
async function useClock(page: Page, d: number, h: number, m = 0) {
  await page.evaluate(([d, h, m]) => {
    const w = window as unknown as SpecWindow;
    w.__DIGEST_NOW__ = new Date(2100, 2, d, h, m).getTime();
    w.__WS_BACKEND__.setDigestClock(() => new Date(w.__DIGEST_NOW__));
  }, [d, h, m]);
}

const setNow = (page: Page, d: number, h: number, m = 0) =>
  page.evaluate(([d, h, m]) => { (window as unknown as SpecWindow).__DIGEST_NOW__ = new Date(2100, 2, d, h, m).getTime(); }, [d, h, m]);

const call = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as SpecWindow).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

const inboxCount = async (page: Page) => {
  const s = await call<{ items: unknown[]; pipeline_items: unknown[]; pipeline_digests: unknown[]; agent_messages: unknown[] }>(page, "getPrInbox");
  const sync = (await call<{ events: unknown[] }>(page, "syncMonitorState")).events.length;
  return s.items.length + s.pipeline_items.length + s.pipeline_digests.length + s.agent_messages.length + sync;
};

async function session(page: Page) {
  const ws = (await call<Array<{ id: string; name: string }>>(page, "listWorkstreams")).find((w) => w.name === "Read chunks")!;
  const tile = await call<{ id: string }>(page, "createTile", ws.id, "copilot_session", "Agent", "{}");
  return { ws, tile };
}

const comment = (projectId: string, summary: string) => ({
  id: `c-${summary}`, project_id: projectId, repo_name: "Repo", pr_id: 42, kind: "comment", title: "Fix race", author: "Ana",
  summary, url: "https://dev.azure.com/o/p/_git/r/pullrequest/42", is_read: false, discovered_at: new Date().toISOString(), subject: "Dev", outcome: "",
});

test("AT-9: Mute all drops every source, keeps the old entries, and nothing replays", async ({ page }) => {
  await start(page);
  const { ws, tile } = await session(page);
  for (const title of ["One", "Two", "Three"]) await call(page, "postAgentMessage", ws.id, tile.id, "info", title, "");
  await expect(page.getByTestId("pr-inbox-unread")).toHaveText("3", SNAPSHOT);
  const repo = (await call<Array<{ id: string }>>(page, "listProjects"))[0];
  await call(page, "configurePrInbox", repo.id, "both");
  await call(page, "seedPipelineDefinition", { organization: "skype", project: "SCC", definition_id: 1, name: "CI", default_branch: "main" });
  await call(page, "seedPipelineDefinition", { organization: "skype", project: "SCC", definition_id: 2, name: "Daily", default_branch: "main" });
  const ci = (await call<{ id: string }>(page, "addPipelineWatch", "https://dev.azure.com/skype/SCC/_build?definitionId=1", "failures")).id;
  const daily = (await call<{ id: string }>(page, "addPipelineWatch", "https://dev.azure.com/skype/SCC/_build?definitionId=2", "daily_failures")).id;
  await call(page, "setPipelineAutoInvestigate", daily, "digest");
  const schedule = await call<{ id: string; revision: number }>(page, "createSchedule", {
    tileId: tile.id, workstreamId: ws.id, prompt: "Check", frequency: { kind: "interval", minutes: 30 }, notifyInbox: true, notifyPhone: false, nextRunAt: null, createdAt: 1,
  });

  // Mute all from the Inbox header.
  await page.getByTestId("pr-inbox-button").click();
  await page.getByTestId("inbox-mute-all").click();
  await page.getByTestId("inbox-mute-confirm").click();
  await expect(page.getByTestId("inbox-muted-banner")).toContainText("Muted until you turn it off");
  await expect(page.getByTestId("pr-inbox-muted-bell")).toBeVisible();
  await expect(page.getByTestId("pr-inbox-unread")).toHaveCount(0);

  // While muted, every source fires.
  await call(page, "recordPrInboxEvent", comment(repo.id, "Dev commented: while you were away"));
  await call(page, "finishPipelineRun", ci, { id: 1, number: "1", result: "failed", branch: "main", finished_at: new Date(2100, 2, 1, 10).toISOString() });
  await call(page, "finishPipelineRun", daily, { id: 2, number: "2", result: "failed", branch: "main", finished_at: new Date(2100, 2, 1, 10).toISOString() });
  await setNow(page, 2, 9, 0);
  expect(await call<string[]>(page, "runDigestPass")).toEqual([]);
  expect(await call(page, "postAgentMessage", ws.id, tile.id, "done", "ws-message while muted", "")).toBeNull();
  await call(page, "updateSchedule", schedule.id, { paused: true }, schedule.revision, { title: "Schedule paused: Check", body: "3 failures" });
  await call(page, "syncMonitorApply", [], [{ id: "cpu-1", kind: "cpu", event: "started", at: 1, message: "CPU high", hint: "h", is_read: false }], []);
  await call(page, "companionSendForTests", tile.id, "result", "Done, sent to the phone");

  expect(await inboxCount(page)).toBe(3);
  expect(await call<number>(page, "runAutoInvestigations")).toBe(0);
  expect((await call<Array<{ name: string }>>(page, "listWorkstreams")).filter((w) => w.name.startsWith("Investigate "))).toEqual([]);
  const phone = await call<Array<{ messages: Array<{ text: string }> }>>(page, "companionListSessions");
  expect(phone.flatMap((s) => s.messages.map((m) => m.text))).toContain("Done, sent to the phone");
  await expect(page.getByTestId("pr-inbox-summary")).toHaveText("3 unread of 3 notifications");

  // Unmute: the 3 old ones are back on the badge; nothing from the muted time appears.
  await page.getByTestId("inbox-mute-all").click();
  await expect(page.getByTestId("inbox-muted-banner")).toHaveCount(0, SNAPSHOT);
  await expect(page.getByTestId("pr-inbox-unread")).toHaveText("3", SNAPSHOT);
  await call(page, "recordPrInboxEvent", comment(repo.id, "Dev commented: while you were away"));
  await call(page, "finishPipelineRun", ci, { id: 1, number: "1", result: "failed", branch: "main", finished_at: new Date(2100, 2, 1, 10).toISOString() });
  await setNow(page, 3, 9, 0);
  await call(page, "runDigestPass");
  expect(await inboxCount(page)).toBe(3);
});

test("AT-10: Mute until a time lasts across a reload and ends by itself", async ({ page }) => {
  await start(page);
  await setNow(page, 1, 22, 0);
  await page.getByTestId("pr-inbox-button").click();
  await page.getByTestId("inbox-mute-all").click();
  await page.getByTestId("inbox-mute-until").check();
  await page.getByTestId("inbox-mute-until-input").fill("2100-03-02T08:00");
  await page.getByTestId("inbox-mute-confirm").click();
  const until = new Date(2100, 2, 2, 8, 0);
  await expect(page.getByTestId("inbox-muted-banner")).toContainText(`Muted until ${await page.evaluate((t) => new Date(t).toLocaleString(), until.getTime())}`);

  await page.reload();
  await useClock(page, 1, 23, 0);
  expect((await call<{ mute: unknown }>(page, "getPrInbox")).mute).toEqual({ muted: true, until: until.toISOString() });
  await expect(page.getByTestId("pr-inbox-muted-bell")).toBeVisible(SNAPSHOT);
  await page.getByTestId("pr-inbox-button").click();
  await expect(page.getByTestId("inbox-muted-banner")).toContainText("Muted until");

  // Past 08:00 it unmutes with no action, and new events record again.
  await setNow(page, 2, 8, 1);
  await expect(page.getByTestId("inbox-muted-banner")).toHaveCount(0, SNAPSHOT);
  const { ws, tile } = await session(page);
  await call(page, "postAgentMessage", ws.id, tile.id, "done", "After the mute", "");
  await expect(page.getByTestId("pr-inbox-unread")).toHaveText("1", SNAPSHOT);
  expect(await inboxCount(page)).toBe(1);
});
