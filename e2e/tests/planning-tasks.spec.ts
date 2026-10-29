/**
 * Tasks under sprint stories in Planning (ADR 039): the in-memory backend plays
 * an ADO team with tasks (src/planning/__tests__/fixtures.ts `taskTeam`).
 * Covers AT-1 to AT-5 of files/features/planning-tasks/acceptance.md. The page
 * clock is fixed at 2026-10-30, inside sprint S22.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { Change, PlanItem } from "../../src/domain/planning";
import { ITERATIONS, TEAM_LINK, taskTeam } from "../../src/planning/__tests__/fixtures";

type W = { __WS_BACKEND__: MemoryBackend };

async function start(page: Page, items: PlanItem[] = taskTeam()) {
  await page.clock.install({ time: new Date("2026-10-30T12:00:00Z") });
  await page.addInitScript(() => {
    Object.assign(window, { __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null } });
  });
  await page.goto("/");
  await page.evaluate(async ({ items, iterations, link }) => {
    const b = (window as unknown as W).__WS_BACKEND__;
    b.seedPlanningAdo({ iterations, items });
    await b.planningConnect(link);
  }, { items, iterations: ITERATIONS, link: TEAM_LINK });
  await page.getByTestId("planning-button").click();
  await expect(page.getByTestId("planning-view")).toBeVisible();
}

const backend = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as W).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

const taskIds = (page: Page, story: number) =>
  page.getByTestId(`planning-story-${story}`).locator("[data-testid^='planning-task-']:not([data-testid*='-state-']):not([data-testid*='-pending-'])")
    .evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-testid")!.split("-").pop())));

async function reopen(page: Page) {
  await page.getByTestId("planning-close").click();
  await page.getByTestId("planning-button").click();
}

const draft = async (page: Page) => (await backend<{ draft: Change[] }>(page, "planningState")).draft;

test("AT-1: a story's tasks are listed under its card, in both layouts; no Removed task or Bug", async ({ page }) => {
  await start(page);
  expect(await taskIds(page, 3)).toEqual([33, 32, 34, 31]);
  await expect(page.getByTestId("planning-task-33")).toContainText("Write tests");
  await expect(page.getByTestId("planning-task-33")).toContainText("Erwin Alvarez");
  for (const id of [31, 32, 34]) await expect(page.getByTestId(`planning-task-${id}`)).not.toContainText("Erwin");
  await expect(page.getByTestId("planning-task-33").getByRole("link")).toHaveAttribute("href", "https://dev.azure.com/skype/OneWork/_workitems/edit/33");
  await expect(page.getByText("Old idea")).toHaveCount(0);
  await expect(page.getByText("A bug")).toHaveCount(0);
  await page.getByTestId("planning-layout-feature").click();
  expect(await taskIds(page, 3)).toEqual([33, 32, 34, 31]);
  for (const tab of ["features", "plan-sprint", "plan-feature"]) {
    await page.getByTestId(`planning-tab-${tab}`).click();
    await expect(page.locator("[data-testid^='planning-task-state-']")).toHaveCount(0);
  }
});

test("AT-2: tasks can be hidden, the choice is remembered, and a card expands on its own", async ({ page }) => {
  await start(page);
  await expect(page.getByTestId("planning-show-tasks")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("planning-show-tasks").click();
  await expect(page.locator("[data-testid^='planning-task-state-']")).toHaveCount(0);
  await reopen(page);
  await expect(page.getByTestId("planning-show-tasks")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-testid^='planning-task-state-']")).toHaveCount(0);
  await page.getByTestId("planning-tasks-3").click();
  expect(await taskIds(page, 3)).toEqual([33, 32, 34, 31]);
  expect(await taskIds(page, 7)).toEqual([]);
});

test("AT-3: changing a task's state goes into the draft, and back again drops it", async ({ page }) => {
  await start(page);
  const header = await page.getByTestId("planning-sprint-header").textContent();
  expect(await page.getByTestId("planning-task-state-32").locator("option").allTextContents()).toEqual(["New", "Active", "Blocked", "Resolved", "Closed"]);
  await expect(page.getByTestId("planning-tasks-3")).toContainText("2/4 tasks");
  await page.getByTestId("planning-task-state-32").selectOption("Closed");
  await expect(page.getByTestId("planning-task-pending-32")).toBeVisible();
  await expect(page.getByTestId("planning-tasks-3")).toContainText("3/4 tasks");
  await expect(page.getByTestId("planning-column-Active").getByTestId("planning-story-3")).toBeVisible();
  await expect(page.getByTestId("planning-sprint-header")).toHaveText(header!);
  await expect(page.getByTestId("planning-draft-count")).toHaveText("1 change not published");
  expect(await backend<number>(page, "planningWrites")).toBe(0);
  await reopen(page);
  await expect(page.getByTestId("planning-task-state-32")).toHaveValue("Closed");
  await expect(page.getByTestId("planning-task-pending-32")).toBeVisible();
  expect(await backend<number>(page, "planningWrites")).toBe(0);
  await page.getByTestId("planning-task-state-32").selectOption("Active");
  await expect(page.getByTestId("planning-task-pending-32")).toHaveCount(0);
  await expect(page.getByTestId("planning-tasks-3")).toContainText("2/4 tasks");
  expect(await draft(page)).toEqual([]);
});

test("AT-4: publishing writes task states and holds back one a teammate changed", async ({ page }) => {
  await start(page);
  await page.getByTestId("planning-task-state-32").selectOption("Closed");
  await expect(page.getByTestId("planning-task-pending-32")).toBeVisible();
  await page.getByTestId("planning-task-state-33").selectOption("Active");
  await expect(page.getByTestId("planning-draft-count")).toHaveText("2 changes not published");
  await backend(page, "changePlanningItemInAdo", 33, { state: "Blocked" });
  await page.getByTestId("planning-publish").click();
  await expect(page.getByTestId("planning-conflict-33")).toContainText("now Blocked");
  await expect(page.getByTestId("planning-publish-result")).toContainText("1 published · 1 changed in ADO");
  await expect(page.getByTestId("planning-draft-count")).toHaveText("1 change not published");
  const ado = await backend<PlanItem[]>(page, "planningAdoItems");
  expect(ado.find((i) => i.id === 32)?.state).toBe("Closed");
  expect(ado.find((i) => i.id === 33)?.state).toBe("Blocked");
});

test("AT-5: a story whose tasks are done offers to be resolved, through the draft", async ({ page }) => {
  await start(page);
  await expect(page.locator("[data-testid^='planning-resolve-offer-']")).toHaveCount(0);
  await page.getByTestId("planning-task-state-32").selectOption("Closed");
  await expect(page.getByTestId("planning-task-pending-32")).toBeVisible();
  await page.getByTestId("planning-task-state-33").selectOption("Closed");
  await expect(page.getByTestId("planning-resolve-offer-3")).toBeVisible();
  await expect(page.locator("[data-testid^='planning-resolve-offer-']")).toHaveCount(1);
  await page.getByTestId("planning-resolve-dismiss-3").click();
  await expect(page.getByTestId("planning-resolve-offer-3")).toHaveCount(0);
  await page.getByTestId("planning-task-state-33").selectOption("Resolved");
  await expect(page.getByTestId("planning-resolve-offer-3")).toBeVisible();
  await page.getByTestId("planning-resolve-3").click();
  await expect(page.getByTestId("planning-resolve-pending-3")).toBeVisible();
  await expect(page.getByTestId("planning-column-Active").getByTestId("planning-story-3")).toBeVisible();
  await expect(page.getByTestId("planning-draft-count")).toHaveText("3 changes not published");
  expect(await backend<number>(page, "planningWrites")).toBe(0);
  await page.getByTestId("planning-publish").click();
  await expect(page.getByTestId("planning-publish-result")).toContainText("3 published");
  const ado = await backend<PlanItem[]>(page, "planningAdoItems");
  expect(ado.find((i) => i.id === 3)?.state).toBe("Resolved");
  await expect(page.locator("[data-testid^='planning-resolve-offer-']")).toHaveCount(0);
});

test("long task names wrap inside the card instead of overflowing it", async ({ page }) => {
  const long = " — implement the very long named media store chunk reader with retries and_a_really_long_identifier_without_spaces";
  await start(page, taskTeam().map((i) => (i.kind === "Task" ? { ...i, title: i.title + long } : i)));
  await page.getByTestId("planning-task-state-32").selectOption("Closed");
  await expect(page.getByTestId("planning-task-pending-32")).toBeVisible();
  for (const layout of ["board", "feature"]) {
    await page.getByTestId(`planning-layout-${layout}`).click();
    const overflowing = await page.locator("[data-testid^='planning-story-']").evaluateAll((cards) =>
      cards.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.getAttribute("data-testid")));
    expect(overflowing, layout).toEqual([]);
    await expect(page.getByTestId("planning-task-state-32")).toBeInViewport();
  }
});
