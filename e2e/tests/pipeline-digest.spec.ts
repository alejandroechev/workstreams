/**
 * Daily failure digest, batch and auto investigation (ADR 045), in the browser
 * build: the in-memory backend plays Azure DevOps, git and the native poller
 * (finishPipelineRun, runDigestPass) on a clock the spec drives. Covers AT-1
 * to AT-8 of files/features/pipeline-digest-and-inbox-mute/acceptance.md; the
 * native halves (persistence across restarts, the real timeline request
 * count, DST) are pipeline_digest / pipeline_investigate tests, and the agent
 * CLI half is agent_cli_scenario.rs.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { AdoRepoRef } from "../../src/domain/pipeline-inbox";
import type { PipelineDigest } from "../../src/domain/pipeline-digest";

const MC: AdoRepoRef = { id: "mc-guid", kind: "azure", organization: "skype", project: "SCC", name: "media_components" };
const MC_REMOTE = "https://dev.azure.com/skype/SCC/_git/media_components";
const SNAPSHOT = { timeout: 12_000 };
/** The configured Copilot command; investigations must launch with it exactly as it is. */
const CONFIGURED = "my-copilot --yolo --model z";

type SpecWindow = { __WS_BACKEND__: MemoryBackend; __DIGEST_NOW__: number; __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> };

async function start(page: Page, projects: Array<{ name: string; git_remote: string | null }> = []) {
  await page.addInitScript((seed) => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: {
        get_setting: (args: Record<string, unknown>) => (args.key === "app.copilot_command" ? seed.command : null),
        set_setting: () => null,
      },
      __WS_DEMO_SEED__: {
        projects: seed.projects.map((p, i) => ({ ...p, directory: `/demo/${i}` })),
        workstreams: [{ name: "Read chunks", directory: "/demo/read-chunks", loaded: true }],
      },
    });
  }, { projects, command: CONFIGURED });
  await page.goto("/");
  await page.getByTestId("workstream-item").filter({ hasText: "Read chunks" }).click();
  await useClock(page);
  await setNow(page, 1, 9, 30);
}

/** The digest's clock follows __DIGEST_NOW__, which the spec moves. */
async function useClock(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as SpecWindow;
    w.__DIGEST_NOW__ = Date.now();
    w.__WS_BACKEND__.setDigestClock(() => new Date(w.__DIGEST_NOW__));
  });
}

/** Local time on day `d` of March 2100. */
const setNow = (page: Page, d: number, h: number, m = 0) =>
  page.evaluate(([d, h, m]) => { (window as unknown as SpecWindow).__DIGEST_NOW__ = new Date(2100, 2, d, h, m).getTime(); }, [d, h, m]);

const localIso = (page: Page, d: number, h: number, m = 0) =>
  page.evaluate(([d, h, m]) => new Date(2100, 2, d, h, m).toISOString(), [d, h, m]);

const call = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as SpecWindow).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

async function watch(page: Page, id: number, name: string, mode: string, repository: AdoRepoRef | null = null) {
  await call(page, "seedPipelineDefinition", { organization: "skype", project: "SCC", definition_id: id, name, repository, default_branch: "main" });
  return (await call<{ id: string }>(page, "addPipelineWatch", `https://dev.azure.com/skype/SCC/_build?definitionId=${id}`, mode)).id;
}

/** Finishes runs on day `d`, one a minute from 10:00, with commits and steps. */
async function finish(page: Page, watchId: string, d: number, runs: Array<{ id: number; result: string; branch?: string }>) {
  for (const [i, run] of runs.entries()) {
    await call(page, "finishPipelineRun", watchId, {
      id: run.id, number: `2100.${run.id}`, result: run.result, branch: run.branch ?? "main",
      finished_at: await localIso(page, d, 10, i), commit: `sha${run.id}`, step: `Step ${run.id}`,
    });
  }
}

const digests = async (page: Page) => (await call<{ pipeline_digests: PipelineDigest[] }>(page, "getPrInbox")).pipeline_digests;
const snapshotCount = async (page: Page) => {
  const s = await call<{ items: unknown[]; pipeline_items: unknown[]; pipeline_digests: unknown[]; agent_messages: unknown[] }>(page, "getPrInbox");
  return s.items.length + s.pipeline_items.length + s.pipeline_digests.length + s.agent_messages.length;
};
const workstreams = (page: Page) => call<Array<{ id: string; name: string; workstream_type: string; directory: string }>>(page, "listWorkstreams");
const spawns = (page: Page) =>
  page.evaluate(() => ((window as unknown as SpecWindow).__WS_INVOKE_LOG__ ?? [])
    .filter((e) => e.cmd === "spawn_copilot_session" && e.args.initialPrompt)
    .map((e) => e.args as { tileId: string; cwd: string; initialPrompt: string; resumeSessionId: string | null; command: string | null }));
const activeName = (page: Page) => page.locator('[data-testid="workstream-item"][data-active="true"]');

/** CI-Main: 12 runs, 5 failed, newest failed. Deploy-PPE: 6 runs, 1 failed, newest succeeded. Docs: 4 passed. */
async function seedThree(page: Page, repo: AdoRepoRef | null = null) {
  const ci = await watch(page, 1, "CI-Main", "daily_failures", repo);
  const deploy = await watch(page, 2, "Deploy-PPE", "daily_failures");
  const docs = await watch(page, 3, "Docs", "daily_failures");
  await finish(page, ci, 1, Array.from({ length: 12 }, (_, i) => ({ id: i + 1, result: [3, 5, 8, 10, 12].includes(i + 1) ? "failed" : "succeeded" })));
  await finish(page, deploy, 1, Array.from({ length: 6 }, (_, i) => ({ id: 21 + i, result: i === 1 ? "failed" : "succeeded" })));
  await finish(page, docs, 1, Array.from({ length: 4 }, (_, i) => ({ id: 31 + i, result: "succeeded" })));
  return { ci, deploy, docs };
}

test("AT-1: Daily failures stops per-run notifications and never counts runs from before the switch", async ({ page }) => {
  await start(page);
  const ci = await watch(page, 1, "CI-Main", "failures");
  await setNow(page, 1, 9, 55);
  await page.getByTestId("pipelines-button").click();
  await expect(page.getByTestId(`pipeline-row-${ci}`)).toBeVisible(SNAPSHOT);
  const mode = page.getByTestId(`pipeline-mode-${ci}`);
  await expect(mode.locator("option")).toHaveText(["Off", "Failures", "Successes", "Both", "Daily failures"]);
  await mode.selectOption("daily_failures");
  await expect(mode).toHaveValue("daily_failures");
  // One run finished before the switch (seen only now); then the runs after it.
  await call(page, "finishPipelineRun", ci, { id: 1, number: "1", result: "failed", branch: "main", finished_at: await localIso(page, 1, 9, 45) });
  await finish(page, ci, 1, [{ id: 2, result: "failed" }, { id: 3, result: "failed" }, { id: 4, result: "succeeded" }, { id: 5, result: "failed", branch: "feature/x" }]);
  expect(await snapshotCount(page)).toBe(0);
  await expect(page.getByTestId(`pipeline-last-${ci}`)).toHaveText("Failed · #2100.5", SNAPSHOT);
  await expect(page.getByTestId("pr-inbox-unread")).toHaveCount(0);
  // The next digest counts only the in-scope runs after the switch.
  await setNow(page, 2, 9, 0);
  await call(page, "runDigestPass");
  const [digest] = await digests(page);
  expect([digest.failed, digest.total, digest.runs.map((r) => r.run_id)]).toEqual([2, 3, [3, 2]]);
});

test("AT-2: one digest entry per failing pipeline at 09:00, with counts, states, links and steps, once", async ({ page }) => {
  await start(page);
  await seedThree(page);
  await setNow(page, 2, 8, 59);
  await call(page, "runDigestPass");
  expect(await digests(page)).toEqual([]);
  await setNow(page, 2, 9, 0);
  await call(page, "runDigestPass");
  await expect(page.getByTestId("pr-inbox-unread")).toHaveText("2", SNAPSHOT);
  const [ci, deploy] = ["CI-Main", "Deploy-PPE"].map((name) => (async () => (await digests(page)).find((d) => d.pipeline_name === name)!)());
  const ciDigest = await ci;
  const deployDigest = await deploy;
  expect((await digests(page)).map((d) => d.pipeline_name).sort()).toEqual(["CI-Main", "Deploy-PPE"]);

  await page.getByTestId("pr-inbox-button").click();
  await expect(page.getByTestId(`pipeline-digest-counts-${ciDigest.id}`)).toHaveText("5 of 12 failed");
  await expect(page.getByTestId(`pipeline-digest-state-${ciDigest.id}`)).toHaveText("Still failing");
  await expect(page.getByTestId(`pipeline-digest-counts-${deployDigest.id}`)).toHaveText("1 of 6 failed");
  await expect(page.getByTestId(`pipeline-digest-state-${deployDigest.id}`)).toHaveText("Passed since");
  await expect(page.getByTestId(`pipeline-digest-last-${ciDigest.id}`)).toContainText("Last failed: #2100.12");
  await expect(page.getByTestId(`pipeline-digest-last-${deployDigest.id}`)).toContainText("Last failed: #2100.22");
  expect(ciDigest.runs[0].url).toBe("https://dev.azure.com/skype/SCC/_build/results?buildId=12");
  await page.getByTestId(`pipeline-digest-expand-${ciDigest.id}`).click();
  const rows = page.getByTestId(`pipeline-digest-runs-${ciDigest.id}`).getByRole("listitem");
  await expect(rows).toHaveCount(5);
  for (const [i, id] of [12, 10, 8, 5, 3].entries()) {
    await expect(rows.nth(i)).toContainText(`#2100.${id} · main`);
    await expect(rows.nth(i)).toContainText(`Step ${id}`);
  }
  // A second tick the same day adds nothing.
  await setNow(page, 2, 9, 30);
  await call(page, "runDigestPass");
  await setNow(page, 2, 23, 0);
  await call(page, "runDigestPass");
  expect(await digests(page)).toHaveLength(2);
});

test("AT-3: the digest time can be changed and survives a reload", async ({ page }) => {
  await start(page);
  await setNow(page, 1, 18, 0);
  const ci = await watch(page, 1, "CI-Main", "daily_failures");
  await finish(page, ci, 2, [{ id: 1, result: "failed" }]);
  await page.getByTestId("pipelines-button").click();
  const time = page.getByTestId("pipeline-digest-time");
  await expect(time).toHaveValue("09:00");
  await time.fill("17:30");
  await time.press("Enter");
  await expect.poll(async () => (await call<{ digest_time: string }>(page, "getPrInbox")).digest_time).toBe("17:30");
  await setNow(page, 2, 9, 0);
  await call(page, "runDigestPass");
  expect(await digests(page)).toHaveLength(0);
  await setNow(page, 2, 17, 30);
  await call(page, "runDigestPass");
  expect(await digests(page)).toHaveLength(1);
  await page.reload();
  expect((await call<{ digest_time: string }>(page, "getPrInbox")).digest_time).toBe("17:30");
  await page.getByTestId("pipelines-button").click();
  await expect(page.getByTestId("pipeline-digest-time")).toHaveValue("17:30");
});

test("AT-4: a missed digest arrives at the next start, once, covering at most 7 days", async ({ page }) => {
  await start(page);
  // Monday 2100-03-01 is when CI-Main last had a digest (09:00).
  await setNow(page, 1, 8, 0);
  const ci = await watch(page, 1, "CI-Main", "daily_failures");
  await setNow(page, 1, 9, 0);
  await call(page, "runDigestPass");
  await finish(page, ci, 1, [{ id: 1, result: "failed" }]);
  await finish(page, ci, 2, [{ id: 2, result: "failed" }, { id: 3, result: "succeeded" }]);
  // Closed Monday 18:00 → Wednesday 10:00.
  await setNow(page, 3, 10, 0);
  await call(page, "runDigestPass");
  let all = await digests(page);
  expect(all.map((d) => [d.failed, d.total, d.runs.map((r) => r.run_id)])).toEqual([[2, 3, [2, 1]]]);
  await setNow(page, 3, 10, 2);
  await call(page, "runDigestPass");
  await setNow(page, 3, 23, 0);
  await call(page, "runDigestPass");
  expect(await digests(page)).toHaveLength(1);
  await finish(page, ci, 3, [{ id: 4, result: "failed" }]);
  await setNow(page, 4, 9, 0);
  await call(page, "runDigestPass");
  all = await digests(page);
  expect(all.map((d) => d.runs.map((r) => r.run_id))).toEqual([[4], [2, 1]]);

  // A 10-day gap: only the last 7 days count.
  await finish(page, ci, 5, [{ id: 5, result: "failed" }]);
  await finish(page, ci, 10, [{ id: 6, result: "failed" }]);
  await setNow(page, 14, 10, 0);
  await call(page, "runDigestPass");
  expect((await digests(page))[0].runs.map((r) => r.run_id)).toEqual([6]);
});

test("AT-5: only Daily failures fetches steps, one per failed run, 20 a day, retrying an error", async ({ page }) => {
  await start(page);
  const daily = await watch(page, 1, "CI-Main", "daily_failures");
  const failures = await watch(page, 2, "Failures", "failures");
  const both = await watch(page, 3, "Both", "both");
  await finish(page, failures, 1, [{ id: 101, result: "failed" }]);
  await finish(page, both, 1, [{ id: 201, result: "failed" }]);
  await call(page, "failNextTimeline", 3);
  await finish(page, daily, 1, Array.from({ length: 25 }, (_, i) => ({ id: i + 1, result: "failed" })));
  const requests = await call<number[]>(page, "timelineRequests");
  expect(requests).toHaveLength(20);
  expect(requests.every((id) => id <= 25)).toBe(true);
  await call(page, "fetchDigestSteps");
  await call(page, "fetchDigestSteps");
  expect(await call<number[]>(page, "timelineRequests")).toHaveLength(21);
  await setNow(page, 2, 9, 0);
  await call(page, "runDigestPass");
  const [digest] = await digests(page);
  expect(digest.runs.find((r) => r.run_id === 3)!.step).toBe("Step 3");
  expect(digest.runs.filter((r) => r.step_state === "not_fetched").map((r) => r.run_id).sort((a, b) => a - b)).toEqual([21, 22, 23, 24, 25]);
  await page.getByTestId("pr-inbox-button").click();
  await page.getByTestId(`pipeline-digest-expand-${digest.id}`).click();
  await expect(page.getByTestId(`pipeline-digest-run-${digest.id}-25`)).toContainText("step not fetched");
});

test("AT-6: Investigate on a digest makes one worktree workstream for the batch, in the background", async ({ page }) => {
  await start(page, [{ name: "media_components", git_remote: MC_REMOTE }]);
  await seedThree(page, MC);
  await setNow(page, 2, 9, 0);
  await call(page, "runDigestPass");
  const ci = (await digests(page)).find((d) => d.pipeline_name === "CI-Main")!;
  await page.getByTestId("pr-inbox-button").click();
  const button = page.getByTestId(`pipeline-investigate-${ci.id}`);
  await expect(button).toHaveText("Investigate", SNAPSHOT);
  await button.click();
  await expect(button).toHaveText("Open investigation", SNAPSHOT);
  const made = (await workstreams(page)).filter((w) => w.name.startsWith("Investigate "));
  expect(made.map((w) => [w.name, w.workstream_type])).toEqual([["Investigate CI-Main failures 2100-03-02", "worktree"]]);
  expect(await call(page, "investigationWorktreeRequests")).toEqual([
    { directory: "/demo/0", branch: "investigate/CI-Main-failures-21000302", base: "origin/main" },
  ]);
  await expect.poll(async () => (await spawns(page)).length, SNAPSHOT).toBe(1);
  const [spawn] = await spawns(page);
  for (const id of [3, 5, 8, 10, 12]) {
    expect(spawn.initialPrompt).toContain(`https://dev.azure.com/skype/SCC/_build/results?buildId=${id}`);
    expect(spawn.initialPrompt).toContain(`commit sha${id}`);
  }
  for (const text of ["5 of 12 runs failed", "Group the runs by root cause", "flaky", "broken", "Change nothing until I ask", "ws-message skill", "Inbox",
    "Untrusted data from Azure DevOps"]) {
    expect(spawn.initialPrompt).toContain(text);
  }
  // The session runs the configured command exactly as it is; the user owns its permissions.
  expect(spawn.command).toBe(CONFIGURED);
  await expect(activeName(page)).toContainText("Read chunks");
  expect((await digests(page)).find((d) => d.id === ci.id)!.is_read).toBe(false);
  // Expanded runs keep per-run Investigate.
  await page.getByTestId(`pipeline-digest-expand-${ci.id}`).click();
  await expect(page.getByTestId(`pipeline-investigate-drun:${ci.id}:12`)).toHaveText("Investigate");
  // Again: switches to it and makes nothing.
  await button.click();
  await expect(activeName(page)).toContainText("Investigate CI-Main failures");
  expect((await workstreams(page)).filter((w) => w.name.startsWith("Investigate "))).toHaveLength(1);
});

test("AT-7: Auto-investigate starts the batch with the digest, quietly", async ({ page }) => {
  await start(page, [{ name: "media_components", git_remote: MC_REMOTE }]);
  const ci = await watch(page, 1, "CI-Main", "daily_failures", MC);
  const b = await watch(page, 2, "B", "failures");
  await page.getByTestId("pipelines-button").click();
  await expect(page.getByTestId(`pipeline-row-${b}`)).toBeVisible(SNAPSHOT);
  await expect(page.getByTestId(`pipeline-auto-${b}`)).toBeDisabled();
  const auto = page.getByTestId(`pipeline-auto-${ci}`);
  await expect(auto.locator("option")).toHaveText(["Auto-investigate: Off", "Auto-investigate: With digest"]);
  await auto.selectOption("digest");
  await expect(auto).toHaveValue("digest");
  await page.getByTestId("pipelines-close").click();
  await finish(page, ci, 1, [{ id: 1, result: "failed" }, { id: 2, result: "succeeded" }, { id: 3, result: "failed" }]);
  await setNow(page, 2, 9, 0);
  await call(page, "runDigestPass");
  await expect.poll(async () => (await workstreams(page)).filter((w) => w.name.startsWith("Investigate ")).length, SNAPSHOT).toBe(1);
  await expect.poll(async () => (await spawns(page)).length, SNAPSHOT).toBe(1);
  expect((await spawns(page))[0].initialPrompt).toContain("Group the runs by root cause");
  expect((await spawns(page))[0].command).toBe(CONFIGURED);
  expect(await snapshotCount(page)).toBe(1);
  const [digest] = await digests(page);
  await page.getByTestId("pr-inbox-button").click();
  await expect(page.getByTestId(`pipeline-investigate-${digest.id}`)).toHaveText("Open investigation", SNAPSHOT);
  await expect(activeName(page)).toContainText("Read chunks");
});

async function seedFive(page: Page, p1Busy: boolean) {
  await start(page);
  const ids: string[] = [];
  for (let n = 1; n <= 5; n++) ids.push(await watch(page, n, `P${n}`, "daily_failures"));
  // P1 has yesterday's investigation, its session linked and idle.
  await finish(page, ids[0], 1, [{ id: 1, result: "failed" }]);
  await setNow(page, 2, 9, 0);
  await call(page, "runDigestPass");
  const [old] = await digests(page);
  const started = await call<{ workstream_id: string }>(page, "startPipelineInvestigation", old.id);
  await call(page, "markInvestigationSessionStarted", old.id);
  await call(page, "createTile", started.workstream_id, "copilot_session", "Investigate P1", JSON.stringify({ copilot_session_id: "s-p1", investigation: true }));
  if (p1Busy) await call(page, "setSessionTurnsForTests", "s-p1", 1, 0);
  for (const id of ids) await call(page, "setPipelineAutoInvestigate", id, "digest");
  for (const [n, id] of ids.entries()) await finish(page, id, 2, [{ id: 100 + n, result: "failed" }]);
  await setNow(page, 3, 9, 0);
  await call(page, "runDigestPass");
  return { ids, p1Workstream: started.workstream_id };
}

test("AT-8: an existing investigation gets a follow-up, and at most 3 new ones start a day", async ({ page }) => {
  const { ids, p1Workstream } = await seedFive(page, false);
  await expect.poll(async () => (await workstreams(page)).filter((w) => w.name.startsWith("Investigate ")).length, SNAPSHOT).toBe(4);
  const names = (await workstreams(page)).map((w) => w.name).filter((n) => n.startsWith("Investigate ")).sort();
  expect(names).toEqual(["Investigate P1 failures 2100-03-02", "Investigate P2 failures 2100-03-03", "Investigate P3 failures 2100-03-03", "Investigate P4 failures 2100-03-03"].sort());
  await expect.poll(async () => (await spawns(page)).filter((s) => s.resumeSessionId === "s-p1").length, SNAPSHOT).toBe(1);
  const resume = (await spawns(page)).find((s) => s.resumeSessionId === "s-p1")!;
  expect(resume.initialPrompt).toContain("- Pipeline: P1 (project SCC)");
  expect(resume.command).toBe(CONFIGURED);
  // The three new ones start unattended with the configured command too.
  const fresh = (await spawns(page)).filter((s) => !s.resumeSessionId);
  expect(fresh.length).toBeGreaterThanOrEqual(3);
  for (const spawn of fresh) expect(spawn.command).toBe(CONFIGURED);
  expect(resume.initialPrompt).toContain("buildId=100");
  const today = (await digests(page)).filter((d) => d.created_at === new Date(2100, 2, 3, 9, 0).toISOString());
  expect(today.find((d) => d.pipeline_id === ids[0])!.investigation).toBe(p1Workstream);
  const p5 = today.find((d) => d.pipeline_id === ids[4])!;
  expect(p5.investigation).toBeNull();
  // Manual Investigate on P5 still works.
  await page.getByTestId("pr-inbox-button").click();
  await page.getByTestId(`pipeline-investigate-${p5.id}`).click();
  await expect(page.getByTestId(`pipeline-investigate-${p5.id}`)).toHaveText("Open investigation", SNAPSHOT);
  expect((await workstreams(page)).filter((w) => w.name.startsWith("Investigate P5"))).toHaveLength(1);
});

test("AT-8 (mid-turn): a busy investigation gets no follow-up but the digest still links to it", async ({ page }) => {
  const { ids, p1Workstream } = await seedFive(page, true);
  await expect.poll(async () => (await workstreams(page)).filter((w) => w.name.startsWith("Investigate ")).length, SNAPSHOT).toBe(4);
  await expect.poll(async () => (await call<unknown[]>(page, "pendingInvestigationFollowups")).length, SNAPSHOT).toBe(0);
  expect((await spawns(page)).filter((s) => s.resumeSessionId === "s-p1")).toHaveLength(0);
  const today = (await digests(page)).filter((d) => d.created_at === new Date(2100, 2, 3, 9, 0).toISOString());
  expect(today.find((d) => d.pipeline_id === ids[0])!.investigation).toBe(p1Workstream);
});
