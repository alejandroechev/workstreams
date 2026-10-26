/**
 * Pipeline notifications in the Inbox (ADR 038), in the browser build: the
 * in-memory backend plays Azure DevOps (pipeline fixtures) and the native
 * poller (finishPipelineRun). Covers AT-1, AT-2, AT-3, AT-6, AT-8 and AT-9.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";

const WATCHDOG_RUN = "https://dev.azure.com/skype/SCC/_build/results?buildId=81723251&view=logs&j=8d02&t=d781";
const NGC_RUN = "https://skype.visualstudio.com/SCC/_build/results?buildId=81724709&view=logs";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: { projects: [{ name: "ADO repo", directory: "/demo/ado", git_remote: "https://dev.azure.com/o/p/_git/r" }] },
    });
  });
  await page.goto("/");
  await page.evaluate(() => {
    const backend = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__;
    backend.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 33770, name: "agency_pipeline_watchdog",
      runs: [5, 4, 3, 2, 1].map((n) => ({ id: 81723251 - n + 1, number: String(81723251 - n + 1), result: "failed", finished_at: `2026-10-2${6 - n}T07:06:15Z` })) });
    backend.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 33995, name: "Agency NgcServer Update",
      runs: [{ id: 81724709, number: "81724709", result: "failed", finished_at: "2026-10-26T08:10:44Z" }] });
  });
});

const backendCall = <T>(page: Page, fn: (b: MemoryBackend, arg: string) => T, arg = "") =>
  page.evaluate(([source, a]) => {
    const backend = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__;
    return (new Function("b", "a", `return (${source})(b, a);`))(backend, a);
  }, [fn.toString(), arg] as const) as Promise<T>;

async function addPipeline(page: Page, url: string) {
  await page.getByTestId("pipeline-url-input").fill(url);
  await page.getByTestId("pipeline-add").click();
}

const rows = (page: Page) => page.locator('[data-testid^="pipeline-row-"]');

test("AT-1/AT-2/AT-3: add by link in either host form, refuse bad links, change the mode and remove", async ({ page }) => {
  await page.getByTestId("pipelines-button").click();
  await expect(page.getByTestId("pipelines-empty")).toBeVisible();

  // AT-1: a run link resolves to its pipeline, with Failures mode and its last result.
  await addPipeline(page, WATCHDOG_RUN);
  await expect(page.getByTestId("pipeline-url-input")).toHaveValue("");
  await expect(rows(page)).toHaveCount(1);
  await addPipeline(page, NGC_RUN);
  await expect(rows(page)).toHaveCount(2);
  const watchdog = rows(page).filter({ hasText: "agency_pipeline_watchdog" });
  await expect(watchdog).toContainText("SCC");
  await expect(watchdog.locator('[data-testid^="pipeline-mode-"]')).toHaveValue("failures");
  await expect(watchdog.locator('[data-testid^="pipeline-last-"]')).toHaveText("Failed · #81723251");
  // Another run of the same pipeline adds nothing.
  await addPipeline(page, "https://dev.azure.com/skype/SCC/_build/results?buildId=81723250");
  await expect(page.getByTestId("pipeline-add-error")).toContainText("Already watching");
  await expect(rows(page)).toHaveCount(2);

  // AT-2: every bad link is refused visibly, and nothing is added.
  for (const [link, message] of [
    ["https://github.com/org/repo/actions/runs/1", "pipeline or run link"],
    ["https://dev.azure.com/skype/SCC/_git/repo/pullrequest/5", "pipeline or run link"],
    ["https://dev.azure.com/skype/SCC/_build/results?buildId=1", "wasn't found"],
  ] as const) {
    await addPipeline(page, link);
    await expect(page.getByTestId("pipeline-add-error")).toContainText(message);
  }
  await backendCall(page, (b) => b.setPipelineAuthError(true));
  await addPipeline(page, "https://dev.azure.com/skype/SCC/_build?definitionId=12");
  await expect(page.getByTestId("pipeline-add-error")).toContainText("az login");
  await expect(rows(page)).toHaveCount(2);

  // AT-3: set one Off, remove the other (and its notification).
  const ngcId = (await rows(page).filter({ hasText: "Agency NgcServer Update" }).getAttribute("data-testid"))!.replace("pipeline-row-", "");
  const watchdogId = (await watchdog.getAttribute("data-testid"))!.replace("pipeline-row-", "");
  await backendCall(page, (b, id) => b.finishPipelineRun(id, { id: 9, number: "9", result: "failed", finished_at: "2100-01-01T00:00:00Z" }), ngcId);
  await page.getByTestId(`pipeline-mode-${watchdogId}`).selectOption("off");
  await page.getByTestId(`pipeline-remove-${ngcId}`).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId(`pipeline-mode-${watchdogId}`)).toHaveValue("off");
  await expect(page.getByTestId(`pipeline-last-${watchdogId}`)).toHaveText("Failed · #81723251");
  await page.getByTestId("pipelines-close").click();
  await page.getByTestId("pr-inbox-button").click();
  await page.getByTestId("inbox-kind-pipelines").click();
  await expect(page.locator('[data-testid^="pipeline-notification-"]')).toHaveCount(0);
});

test("AT-6/AT-8/AT-9: no history replay; one Inbox with PRs and pipelines; opening a run reads it", async ({ page }) => {
  await page.getByTestId("pipelines-button").click();
  await addPipeline(page, WATCHDOG_RUN);
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId("pipelines-close").click();

  // AT-6: the watchdog's five past failures don't notify.
  await page.getByTestId("pr-inbox-button").click();
  await expect(page.getByTestId("pr-inbox-panel")).toBeVisible();
  await page.getByTestId("inbox-kind-pipelines").click();
  await expect(page.getByTestId("inbox-pipelines-empty")).toBeVisible();
  await page.getByTestId("pr-inbox-close").click();

  // Runs that finish afterwards notify (AT-6), next to an unread PR.
  await page.evaluate(async () => {
    const backend = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__;
    const repo = (await backend.listProjects()).find((p) => p.name === "ADO repo")!;
    await backend.configurePrInbox(repo.id, "both");
    backend.seedPrInboxItems([{ id: "c1", project_id: repo.id, repo_name: repo.name, pr_id: 412, kind: "comment",
      title: "Add lane toggle", author: "Maria", summary: "Maria: nice", url: "https://dev.azure.com/o/p/_git/r/pullrequest/412",
      is_read: false, discovered_at: new Date().toISOString(), subject: "Maria", outcome: "" }]);
    const id = (await backend.getPrInbox()).pipelines![0].id;
    backend.finishPipelineRun(id, { id: 90001, number: "90001", result: "failed", branch: "main", trigger: "Scheduled", finished_at: "2100-01-01T07:06:00Z" });
    backend.finishPipelineRun(id, { id: 90002, number: "90002", result: "failed", branch: "feature/x", trigger: "Manual · Ana", finished_at: "2100-01-01T19:08:00Z" });
  });
  // One PR + two runs.
  await expect(page.getByTestId("pr-inbox-unread")).toHaveText("3", { timeout: 10_000 });
  await expect(page.getByTestId("pr-inbox-button")).toHaveText(/^Inbox/);

  // AT-8: the Inbox, two sections, filters.
  await page.getByTestId("pr-inbox-button").click();
  const panel = page.getByRole("dialog", { name: "Inbox" });
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText("PR inbox");
  await expect(page.getByTestId("inbox-section-prs")).toContainText("Pull requests");
  await expect(page.getByTestId("inbox-section-pipelines")).toContainText("Pipelines");
  const runs = page.locator('[data-testid^="pipeline-notification-"]');
  await expect(runs).toHaveCount(2);
  await expect(runs.nth(0)).toContainText("#90002");
  await expect(runs.nth(0)).toContainText("feature/x");
  await expect(runs.nth(0)).toContainText("Manual · Ana");
  await expect(runs.nth(0)).toContainText("Failed");
  await expect(runs.nth(1)).toContainText("#90001");
  await page.getByTestId("inbox-kind-pipelines").click();
  await expect(page.getByTestId("inbox-section-prs")).toHaveCount(0);
  await expect(runs).toHaveCount(2);
  await page.getByTestId("inbox-kind-prs").click();
  await expect(page.getByTestId("inbox-section-pipelines")).toHaveCount(0);
  await expect(page.locator('[data-testid^="pr-notification-"]')).toHaveCount(1);
  await page.getByTestId("inbox-kind-all").click();

  // AT-9: opening the newest run opens it in ADO, reads it, and the badge drops.
  await page.evaluate(() => { (window as unknown as { __WS_INVOKE_LOG__: unknown[] }).__WS_INVOKE_LOG__ = []; });
  await runs.nth(0).locator('[data-testid^="pipeline-open-"]').click();
  await expect(page.getByTestId("pr-inbox-unread")).toHaveText("2", { timeout: 10_000 });
  const opened = await page.evaluate(() => (window as unknown as { __WS_INVOKE_LOG__: Array<{ cmd: string; args: { url?: string } }> })
    .__WS_INVOKE_LOG__.filter((e) => e.cmd === "open_url").map((e) => e.args.url));
  expect(opened).toEqual(["https://dev.azure.com/skype/SCC/_build/results?buildId=90002"]);
  // Unread is the default view, so the read run is gone from it.
  await expect(runs).toHaveCount(1);
  await page.getByTestId("pr-inbox-filter-all").click();
  await expect(page.locator('[data-testid^="pipeline-notification-"][data-read="true"]')).toHaveCount(1);
});
