/**
 * Pipeline → repo association (ADR 038 amendment): the in-memory backend plays
 * Azure DevOps (definitions and runs with their repository) and the native
 * poller (finishPipelineRun). Covers AT-1 to AT-7 of
 * files/features/pipeline-repos/acceptance.md.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { AdoRepoRef } from "../../src/domain/pipeline-inbox";

const repo = (name: string): AdoRepoRef => ({ id: `${name}-guid`, kind: "azure", organization: "skype", project: "SCC", name });
const MC_LINK = "https://dev.azure.com/skype/SCC/_build?definitionId=812";
const ENGAINE_LINK = "https://dev.azure.com/skype/SCC/_build?definitionId=918";

async function start(page: Page, projects: Array<{ name: string; git_remote: string | null }>) {
  await page.addInitScript((projects) => {
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null },
      __WS_DEMO_SEED__: { projects: projects.map((p, i) => ({ ...p, directory: `/demo/${i}` })) },
    });
  }, projects);
  await page.goto("/");
  await page.evaluate(({ mc, engaine }) => {
    const b = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__;
    b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 812, name: "media_components-CI", repository: mc,
      runs: [{ id: 1, number: "1", result: "succeeded", finished_at: "2026-10-26T08:00:00Z", repository: mc }] });
    b.seedPipelineDefinition({ organization: "skype", project: "SCC", definition_id: 918, name: "engaine-watchdog", repository: engaine });
  }, { mc: repo("media_components"), engaine: repo("engaine") });
  await page.getByTestId("pipelines-button").click();
}

const call = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as { __WS_BACKEND__: MemoryBackend }).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

async function add(page: Page, link: string): Promise<string> {
  await page.getByTestId("pipeline-url-input").fill(link);
  await page.getByTestId("pipeline-add").click();
  await expect(page.getByTestId("pipeline-url-input")).toHaveValue("");
  const pipelines = await call<{ pipelines: Array<{ id: string; definition_id: number }> }>(page, "getPrInbox");
  return pipelines.pipelines.find((p) => link.endsWith(`=${p.definition_id}`))!.id;
}

const chip = (page: Page, id: string) => page.getByTestId(`pipeline-repo-${id}`);
/** Changes made in the backend show on the Inbox's next 5-second re-read. */
const SNAPSHOT = { timeout: 12_000 };
const projectId = async (page: Page, name: string) =>
  (await call<Array<{ id: string; name: string }>>(page, "listProjects")).find((p) => p.name === name)!.id;

test("AT-1: a newly added pipeline shows its repo, matched across remote forms", async ({ page }) => {
  await start(page, [{ name: "media_components", git_remote: "git@ssh.dev.azure.com:v3/skype/SCC/media_components" }]);
  const id = await add(page, MC_LINK);
  await expect(chip(page, id)).toContainText("media_components");
  await expect(chip(page, id)).toContainText("auto");
  await expect(chip(page, id)).not.toContainText("not in Workstreams");
});

test("AT-2: a repo not in Workstreams is shown by name, and links once the repo is added", async ({ page }) => {
  await start(page, [{ name: "media_components", git_remote: "https://dev.azure.com/skype/SCC/_git/media_components" }]);
  const id = await add(page, ENGAINE_LINK);
  await expect(chip(page, id)).toContainText("SCC/engaine — not in Workstreams");
  const created = await call<{ id: string }>(page, "createProject", "engaine", "/demo/engaine");
  await call(page, "setProjectRemote", created.id, "https://skype.visualstudio.com/SCC/_git/engaine");
  await page.getByTestId("pipelines-close").click();
  await page.getByTestId("pipelines-button").click();
  await expect(chip(page, id)).toHaveText(/^engaine\s*auto/, SNAPSHOT);
});

test("AT-3: the automatic repo follows the newest run, and a pipeline without one gets it on its next check", async ({ page }) => {
  await start(page, [
    { name: "media_components", git_remote: "https://dev.azure.com/skype/SCC/_git/media_components" },
    { name: "acs_media_sdk", git_remote: "https://dev.azure.com/skype/SCC/_git/acs_media_sdk" },
    { name: "engaine", git_remote: "https://dev.azure.com/skype/SCC/_git/engaine" },
  ]);
  const p1 = await add(page, ENGAINE_LINK);
  const p2 = await add(page, MC_LINK);
  await call(page, "forgetPipelineRepo", p1);
  await page.getByTestId("pipelines-close").click();
  await page.getByTestId("pipelines-button").click();
  await expect(chip(page, p1)).toContainText("No repo", SNAPSHOT);
  await call(page, "finishPipelineRun", p1, { id: 50, number: "50", result: "succeeded", finished_at: "2100-01-01T00:00:00Z" });
  await call(page, "finishPipelineRun", p2, { id: 51, number: "51", result: "failed", finished_at: "2100-01-01T00:00:00Z", repository: { id: "acs-guid", kind: "azure", organization: "skype", project: "SCC", name: "acs_media_sdk" } });
  await expect(chip(page, p1)).toHaveText(/^engaine\s*auto/, SNAPSHOT);
  await expect(chip(page, p2)).toHaveText(/^acs_media_sdk\s*auto/, SNAPSHOT);
});

test("AT-4: a remote shared by two repos links the pipeline to both", async ({ page }) => {
  await start(page, [
    { name: "media_components", git_remote: "https://dev.azure.com/skype/SCC/_git/media_components" },
    { name: "media_components (2nd checkout)", git_remote: "https://skype.visualstudio.com/SCC/_git/media_components" },
  ]);
  const id = await add(page, MC_LINK);
  await expect(chip(page, id)).toContainText("media_components +1");
  const linked = (await call<{ pipelines: Array<{ repos: Array<{ name: string }> }> }>(page, "getPrInbox")).pipelines[0].repos.map((r) => r.name);
  expect(linked.sort()).toEqual(["media_components", "media_components (2nd checkout)"]);
});

test("AT-5: overriding the repo, clearing it, and going back to Automatic", async ({ page }) => {
  await start(page, [
    { name: "media_components", git_remote: "https://dev.azure.com/skype/SCC/_git/media_components" },
    { name: "acs_media_sdk", git_remote: "https://dev.azure.com/skype/SCC/_git/acs_media_sdk" },
  ]);
  const id = await add(page, MC_LINK);
  await chip(page, id).click();
  const options = page.getByTestId(`pipeline-repo-menu-${id}`).getByRole("menuitemradio");
  await expect(options).toHaveText(["Automatic — media_components", "media_components", "acs_media_sdk", "No repo"]);
  await page.getByTestId(`pipeline-repo-option-${id}-${await projectId(page, "acs_media_sdk")}`).click();
  await expect(chip(page, id)).toHaveText(/^acs_media_sdk\s*set by you/, SNAPSHOT);
  await chip(page, id).click();
  await expect(page.getByTestId(`pipeline-repo-option-${id}-auto`)).toHaveText("Automatic — media_components");
  await page.getByTestId(`pipeline-repo-option-${id}-none`).click();
  await expect(chip(page, id)).toHaveText(/^No repo\s*set by you/);
  await chip(page, id).click();
  await page.getByTestId(`pipeline-repo-option-${id}-auto`).click();
  await expect(chip(page, id)).toHaveText(/^media_components\s*auto/);
});

test("AT-6: an override survives reopening and a change in ADO", async ({ page }) => {
  await start(page, [
    { name: "media_components", git_remote: "https://dev.azure.com/skype/SCC/_git/media_components" },
    { name: "acs_media_sdk", git_remote: "https://dev.azure.com/skype/SCC/_git/acs_media_sdk" },
  ]);
  const id = await add(page, MC_LINK);
  await call(page, "setPipelineWatchRepo", id, await projectId(page, "acs_media_sdk"));
  await call(page, "finishPipelineRun", id, { id: 60, number: "60", result: "failed", finished_at: "2100-01-01T00:00:00Z", repository: { id: "e", kind: "azure", organization: "skype", project: "SCC", name: "engaine" } });
  await page.getByTestId("pipelines-close").click();
  await page.getByTestId("pipelines-button").click();
  await expect(chip(page, id)).toHaveText(/^acs_media_sdk\s*set by you/, SNAPSHOT);
  await chip(page, id).click();
  await expect(page.getByTestId(`pipeline-repo-option-${id}-auto`)).toHaveText("Automatic — SCC/engaine (not in Workstreams)");
});

test("AT-7: Inbox pipeline notifications name the repo", async ({ page }) => {
  await start(page, [
    { name: "media_components", git_remote: "https://dev.azure.com/skype/SCC/_git/media_components" },
    { name: "acs_media_sdk", git_remote: "https://dev.azure.com/skype/SCC/_git/acs_media_sdk" },
  ]);
  const auto = await add(page, MC_LINK);
  const manual = await add(page, ENGAINE_LINK);
  await call(page, "setPipelineWatchRepo", manual, await projectId(page, "acs_media_sdk"));
  for (const id of [auto, manual]) {
    await call(page, "finishPipelineRun", id, { id: id === auto ? 70 : 71, number: "7", result: "failed", finished_at: "2100-01-01T00:00:00Z" });
  }
  await page.getByTestId("pipelines-close").click();
  await page.getByTestId("pr-inbox-button").click();
  await expect(page.getByTestId(`pipeline-group-repo-${auto}`)).toContainText("media_components", SNAPSHOT);
  await expect(page.getByTestId(`pipeline-group-repo-${manual}`)).toContainText("acs_media_sdk");
});
