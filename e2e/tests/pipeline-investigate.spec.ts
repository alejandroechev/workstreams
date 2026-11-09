/**
 * Investigate a failed pipeline run (ADR 038 amendment): the in-memory backend
 * plays Azure DevOps and git. Covers AT-1 to AT-6 of
 * files/features/pipeline-investigate/acceptance.md; AT-7 (agents) is the
 * native test inbox_investigate_creates_or_reuses_an_investigation, and the
 * persistence half of AT-6 is pipeline_investigate::tests.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { AdoRepoRef } from "../../src/domain/pipeline-inbox";

const MC: AdoRepoRef = { id: "mc-guid", kind: "azure", organization: "skype", project: "SCC", name: "media_components" };
const MC_REMOTE = "https://dev.azure.com/skype/SCC/_git/media_components";
const SNAPSHOT = { timeout: 12_000 };

interface Seed {
  projects?: Array<{ name: string; git_remote: string | null }>;
  /** Linked to media_components when there are projects for it. */
  mcRuns: Array<{ id: number; number: string; result: string; branch?: string }>;
  /** A second pipeline, with no repo. */
  otherRuns?: Array<{ id: number; number: string; result: string }>;
}

async function start(page: Page, seed: Seed) {
  await page.addInitScript((projects) => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: {
        projects: projects.map((p, i) => ({ ...p, directory: `/demo/${i}` })),
        workstreams: [{ name: "Read chunks", directory: "/demo/read-chunks", loaded: true }],
      },
    });
  }, seed.projects ?? []);
  await page.goto("/");
  await page.getByTestId("workstream-item").filter({ hasText: "Read chunks" }).click();
  await page.evaluate(async ({ mc, seed }) => {
    const b = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__;
    b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 812, name: "media_components-CI", repository: mc });
    b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 918, name: "engaine-watchdog", repository: null });
    const mcWatch = await b.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=812", "both");
    const other = await b.addPipelineWatch("https://dev.azure.com/skype/SCC/_build?definitionId=918", "both");
    seed.mcRuns.forEach((r, i) => b.finishPipelineRun(mcWatch.id, { ...r, finished_at: `2100-01-0${i + 1}T08:10:44Z`, trigger: "Scheduled" }));
    (seed.otherRuns ?? []).forEach((r, i) => b.finishPipelineRun(other.id, { ...r, finished_at: `2100-02-0${i + 1}T08:10:44Z` }));
  }, { mc: MC, seed });
  await page.getByTestId("pr-inbox-button").click();
}

const backend = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

const itemId = async (page: Page, runNumber: string) =>
  (await backend<{ pipeline_items: Array<{ id: string; run_number: string }> }>(page, "getPrInbox"))
    .pipeline_items.find((i) => i.run_number === runNumber)!.id;

const workstreams = (page: Page) =>
  backend<Array<{ id: string; name: string; directory: string; workstream_type: string; project_id: string | null; worktree_branch: string | null }>>(page, "listWorkstreams");

const spawns = (page: Page) =>
  page.evaluate(() => ((window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> }).__WS_INVOKE_LOG__ ?? [])
    .filter((e) => e.cmd === "spawn_copilot_session" && e.args.initialPrompt)
    .map((e) => e.args as { tileId: string; cwd: string; initialPrompt: string }));

async function investigate(page: Page, runNumber: string) {
  const id = await itemId(page, runNumber);
  await page.getByTestId(`pipeline-investigate-${id}`).click();
  await expect(page.getByTestId(`pipeline-investigate-${id}`)).toHaveText("Open investigation", SNAPSHOT);
  const ws = (await workstreams(page)).find((w) => w.name.endsWith(`#${runNumber}`))!;
  return { id, ws };
}

const activeName = (page: Page) => page.locator('[data-testid="workstream-item"][data-active="true"]');

test("AT-1: Investigate starts a workstream in the background and the Inbox stays", async ({ page }) => {
  await start(page, { mcRuns: [{ id: 81724709, number: "20261105.3", result: "failed" }], otherRuns: [{ id: 5, number: "5", result: "succeeded" }] });
  await expect(activeName(page)).toContainText("Read chunks");
  await expect(page.getByTestId(`pipeline-investigate-${await itemId(page, "5")}`)).toHaveCount(0);
  const { ws } = await investigate(page, "20261105.3");
  expect(ws.name).toBe("Investigate media_components-CI #20261105.3");
  const tiles = await backend<Array<{ id: string; tile_type: string }>>(page, "listTiles", ws.id);
  expect(tiles.map((t) => t.tile_type)).toEqual(["copilot_session"]);
  expect((await spawns(page)).filter((s) => s.tileId === tiles[0].id)).toHaveLength(1);
  await expect(page.getByRole("dialog", { name: "Inbox" })).toBeVisible();
  await expect(activeName(page)).toContainText("Read chunks");
});

test("AT-2: several failures can be investigated in a row", async ({ page }) => {
  await start(page, { mcRuns: [{ id: 1, number: "1", result: "failed" }], otherRuns: [{ id: 2, number: "2", result: "failed" }] });
  const a = await itemId(page, "1");
  const b = await itemId(page, "2");
  await page.getByTestId(`pipeline-investigate-${a}`).click();
  await page.getByTestId(`pipeline-investigate-${b}`).click();
  await expect(page.getByTestId(`pipeline-investigate-${a}`)).toHaveText("Open investigation", SNAPSHOT);
  await expect(page.getByTestId(`pipeline-investigate-${b}`)).toHaveText("Open investigation", SNAPSHOT);
  const investigations = (await workstreams(page)).filter((w) => w.name.startsWith("Investigate "));
  expect(investigations).toHaveLength(2);
  const spawned = await spawns(page);
  for (const ws of investigations) {
    const tiles = await backend<Array<{ id: string }>>(page, "listTiles", ws.id);
    expect(tiles).toHaveLength(1);
    expect(spawned.filter((s) => s.tileId === tiles[0].id)).toHaveLength(1);
  }
});

test("AT-3: a pipeline with a repo gets a worktree from the failed branch", async ({ page }) => {
  await start(page, {
    projects: [{ name: "media_components", git_remote: MC_REMOTE }, { name: "media_components-2", git_remote: MC_REMOTE }],
    mcRuns: [{ id: 81724709, number: "20261105.3", result: "failed", branch: "release/2.4" }],
  });
  const { ws } = await investigate(page, "20261105.3");
  const first = (await backend<Array<{ id: string; name: string }>>(page, "listProjects")).find((p) => p.name === "media_components")!;
  expect(ws.workstream_type).toBe("worktree");
  expect(ws.project_id).toBe(first.id);
  expect(ws.worktree_branch).toBe("investigate/media_components-CI-20261105.3");
  expect(await backend(page, "investigationWorktreeRequests")).toEqual([
    { directory: "/demo/0", branch: "investigate/media_components-CI-20261105.3", base: "origin/release/2.4" },
  ]);
  expect((await spawns(page)).map((s) => s.cwd)).toEqual([ws.directory]);
  expect(ws.directory).toBe("/demo/0-investigate-media_components-CI-20261105.3");
});

test("AT-4: no repo, or a worktree that can't be made, gives a standalone workstream", async ({ page }) => {
  await start(page, {
    projects: [{ name: "media_components", git_remote: MC_REMOTE }],
    mcRuns: [{ id: 1, number: "1", result: "failed", branch: "gone" }],
    otherRuns: [{ id: 2, number: "2", result: "failed" }],
  });
  await investigate(page, "2");
  await backend(page, "failInvestigationWorktree", "fatal: couldn't find remote ref gone");
  await investigate(page, "1");
  const list = await workstreams(page);
  const noRepo = list.find((w) => w.name.endsWith("#2"))!;
  const fallback = list.find((w) => w.name.endsWith("#1"))!;
  for (const ws of [noRepo, fallback]) {
    expect(ws.workstream_type).toBe("standalone");
    expect(ws.directory).toBe("/Users/demo");
  }
  const prompts = (await spawns(page)).map((s) => s.initialPrompt);
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) expect(prompt).toContain("no local checkout");
  expect(prompts[1]).toContain("fatal: couldn't find remote ref gone");
});

test("AT-5: the prompt carries the run's context and asks for a report, not changes", async ({ page }) => {
  await start(page, {
    projects: [{ name: "media_components", git_remote: MC_REMOTE }],
    mcRuns: [{ id: 81724709, number: "20261105.3", result: "failed", branch: "release/2.4" }],
  });
  const before = await backend<number>(page, "adoRequestCount");
  await investigate(page, "20261105.3");
  const [{ initialPrompt: prompt }] = await spawns(page);
  for (const value of ["media_components-CI", "SCC", "20261105.3", "81724709", "release/2.4", "Scheduled", "2100-01-01T08:10:44Z",
    "media_components", "https://dev.azure.com/skype/SCC/_build/results?buildId=81724709", "az "]) {
    expect(prompt).toContain(value);
  }
  for (const word of ["code", "pipeline", "infrastructure", "flakiness"]) expect(prompt).toContain(word);
  expect(prompt).toContain("Don't change any code");
  expect(await backend<number>(page, "adoRequestCount")).toBe(before);
});

test("AT-6: clicking again opens the existing investigation; a newer failure gets its own", async ({ page }) => {
  await start(page, { mcRuns: [{ id: 1, number: "20261105.3", result: "failed" }, { id: 2, number: "20261106.1", result: "failed" }] });
  const { id, ws } = await investigate(page, "20261105.3");
  // The Inbox re-reads from the backend after being reopened, as after a restart.
  await page.keyboard.press("Escape");
  await page.getByTestId("pr-inbox-button").click();
  const count = (await workstreams(page)).length;
  await expect(page.getByTestId(`pipeline-investigate-${id}`)).toHaveText("Open investigation");
  await page.getByTestId(`pipeline-investigate-${id}`).click();
  await expect(page.locator(`[data-testid="workstream-item"][data-workstream-id="${ws.id}"]`)).toHaveAttribute("data-active", "true");
  expect((await workstreams(page)).length).toBe(count);
  await page.getByTestId("pr-inbox-button").click();
  await investigate(page, "20261106.1");
  expect((await workstreams(page)).length).toBe(count + 1);
});
