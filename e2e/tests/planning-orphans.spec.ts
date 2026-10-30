/**
 * The Orphaned PRs tab in Planning (ADR 039): the in-memory backend plays an
 * ADO organization with your PRs. Covers AT-1 to AT-5 of
 * files/features/orphan-prs/acceptance.md. The page clock is fixed at
 * 2026-10-30T12:00Z.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend, MemoryPlanningPr } from "../../src/backend/memory-backend";
import type { Change, PlanItem } from "../../src/domain/planning";
import { ITERATIONS, TEAM_LINK, orphanPrs, taskTeam } from "../../src/planning/__tests__/fixtures";

type W = { __WS_BACKEND__: MemoryBackend };

async function start(page: Page, prs: MemoryPlanningPr[], items: PlanItem[] = taskTeam()) {
  await page.clock.install({ time: new Date("2026-10-30T12:00:00Z") });
  await page.addInitScript(() => {
    Object.assign(window, { __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null } });
  });
  await page.goto("/");
  await page.evaluate(async ({ items, prs, iterations, link }) => {
    const b = (window as unknown as W).__WS_BACKEND__;
    b.seedPlanningAdo({ iterations, items });
    b.seedPlanningPrs(prs);
    await b.planningConnect(link);
  }, { items, prs, iterations: ITERATIONS, link: TEAM_LINK });
  await page.getByTestId("planning-button").click();
  await page.getByTestId("planning-tab-orphans").click();
  await expect(page.getByTestId("planning-orphan-days")).toBeVisible();
}

const backend = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as W).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

const rows = (page: Page) =>
  page.locator("[data-testid^='planning-orphan-row-']").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-testid")!.split("-").pop())));

async function reopen(page: Page) {
  await page.getByTestId("planning-close").click();
  await page.getByTestId("planning-button").click();
  await page.getByTestId("planning-tab-orphans").click();
}

const pr = (id: number, repo: string, daysAgo: number, over: Partial<MemoryPlanningPr> = {}): MemoryPlanningPr => ({
  id, title: `PR ${id}`, project: "SCC", project_id: "scc-id", repo: `SCC/${repo}`, repo_id: `${repo}-id`,
  status: "completed", draft: false, mine: true,
  created: new Date(Date.parse("2026-10-30T12:00:00Z") - daysAgo * 86_400_000).toISOString(), ...over,
});

test("AT-1: the tab lists my unlinked PRs from every repo", async ({ page }) => {
  await start(page, orphanPrs());
  await expect.poll(() => rows(page)).toEqual([103, 101, 102, 104]);
  await expect(page.getByTestId("planning-tab-orphans")).toHaveText("Orphaned PRs · 4");
  const draft = page.getByTestId("planning-orphan-row-102");
  await expect(draft).toContainText("SCC/acs_media_sdk");
  await expect(draft).toContainText("draft");
  await expect(draft).toContainText("2026-10-27");
  await expect(page.getByTestId("planning-orphan-row-101")).toContainText("active");
  await expect(page.getByTestId("planning-orphan-row-104")).toContainText("OneWork/other-repo");
  await expect(page.getByTestId("planning-orphan-row-104")).toContainText("completed");
  await expect(draft.getByRole("link")).toHaveAttribute("href", "https://dev.azure.com/skype/SCC/_git/acs_media_sdk/pullrequest/102");
});

test("AT-2: the range is a remembered 7 / 30 / 90-day choice", async ({ page }) => {
  await start(page, [pr(1, "a", 3), pr(2, "a", 20), pr(3, "a", 60)]);
  expect(await page.getByTestId("planning-orphan-days").locator("option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).toEqual(["7", "30", "90"]);
  await expect(page.getByTestId("planning-orphan-days")).toHaveValue("30");
  await expect.poll(() => rows(page)).toHaveLength(2);
  await page.getByTestId("planning-orphan-days").selectOption("90");
  await expect.poll(() => rows(page)).toHaveLength(3);
  await reopen(page);
  await expect(page.getByTestId("planning-orphan-days")).toHaveValue("90");
  await expect.poll(() => rows(page)).toHaveLength(3);
  await page.getByTestId("planning-orphan-days").selectOption("7");
  await expect.poll(() => rows(page)).toHaveLength(1);
});

test("AT-3: hiding a PR or a whole repo, and undoing it", async ({ page }) => {
  await start(page, [pr(1, "engaine", 1), pr(2, "engaine", 2), pr(3, "media_components", 3)]);
  const label = page.getByTestId("planning-tab-orphans");
  await expect.poll(() => rows(page)).toHaveLength(3);
  await page.getByTestId("planning-orphan-hide-3").click();
  await expect(label).toHaveText("Orphaned PRs · 2");
  await page.getByTestId("planning-orphan-hide-repo-1").click();
  await expect(label).toHaveText("Orphaned PRs · 0");
  expect(await rows(page)).toEqual([]);
  await reopen(page);
  await expect(label).toHaveText("Orphaned PRs · 0");
  await page.getByTestId("planning-orphan-show-hidden").click();
  await expect(page.getByTestId("planning-orphan-show-hidden")).toHaveText("Show hidden (2)");
  await expect(page.getByTestId("planning-orphan-hidden-list")).toContainText("PR 3");
  await expect(page.getByTestId("planning-orphan-hidden-list")).toContainText("SCC/engaine");
  await page.getByTestId("planning-orphan-unhide-repo-engaine-id").click();
  await expect(label).toHaveText("Orphaned PRs · 2");
  expect(await rows(page)).toEqual([1, 2]);
});

test("AT-4: linking an orphan goes through the draft", async ({ page }) => {
  // Story 7 is outside the sprint here, standing in for a story of one of your features.
  await start(page, orphanPrs(), taskTeam().map((i) => (i.id === 7 ? { ...i, iteration_path: "OneWork\\Q4", title: "Feature story" } : i)));
  await expect.poll(() => rows(page)).toHaveLength(4);
  const labels = await page.getByTestId("planning-orphan-link-103").locator("option").allTextContents();
  expect(labels).toEqual(expect.arrayContaining(["AMS Application State", "— Implement handler", "No tasks yet", "Feature story"]));
  expect(labels.indexOf("— Implement handler")).toBeGreaterThan(labels.indexOf("AMS Application State"));
  await page.getByTestId("planning-orphan-link-103").selectOption("32");
  await page.getByTestId("planning-orphan-link-101").selectOption("7");
  await expect(page.getByTestId("planning-orphan-pending-103")).toContainText("Implement handler");
  await expect(page.getByTestId("planning-orphan-pending-101")).toContainText("Feature story");
  await expect(page.getByTestId("planning-draft-count")).toHaveText("2 changes not published");
  expect(await backend<number>(page, "planningWrites")).toBe(0);
  await page.getByTestId("planning-publish").click();
  await expect(page.getByTestId("planning-publish-result")).toContainText("2 published");
  expect(await backend<number[]>(page, "planningPrLinks", 103)).toEqual([32]);
  expect(await backend<number[]>(page, "planningPrLinks", 101)).toEqual([7]);
  await expect.poll(() => rows(page)).toEqual([102, 104]);
});

test("AT-5: a link to a work item changed meanwhile is held back", async ({ page }) => {
  await start(page, orphanPrs());
  await expect.poll(() => rows(page)).toHaveLength(4);
  await page.getByTestId("planning-orphan-link-103").selectOption("3");
  await expect(page.getByTestId("planning-draft-count")).toHaveText("1 change not published");
  await backend(page, "changePlanningItemInAdo", 3, { title: "AMS Application State (edited)" });
  await page.getByTestId("planning-publish").click();
  await expect(page.getByTestId("planning-conflict-3")).toContainText("changed in ADO");
  await expect(page.getByTestId("planning-draft-count")).toHaveText("1 change not published");
  expect(await backend<number[]>(page, "planningPrLinks", 103)).toEqual([]);
  expect(await rows(page)).toContain(103);
  expect((await backend<{ draft: Change[] }>(page, "planningState")).draft).toHaveLength(1);
});
