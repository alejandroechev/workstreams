/**
 * Planning (ADR 039) in the browser build: the in-memory backend plays an ADO
 * team (src/planning/__tests__/fixtures.ts). Covers AT-1 to AT-7 of
 * files/features/ado-planning/acceptance.md. The page clock is fixed at
 * 2026-10-30, inside sprint S22.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { PlanItem } from "../../src/domain/planning";
import { BACKLOG_LINK, ITERATIONS, TEAM_LINK, featureTeam, planSprintTeam, sprintTeam } from "../../src/planning/__tests__/fixtures";

type W = { __WS_BACKEND__: MemoryBackend };

async function start(page: Page, items: PlanItem[], options: { connect?: boolean; sprint?: string } = {}) {
  await page.clock.install({ time: new Date("2026-10-30T12:00:00Z") });
  await page.addInitScript(() => {
    Object.assign(window, { __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null } });
  });
  await page.goto("/");
  await page.evaluate(async ({ items, iterations, link, connect, sprint }) => {
    const b = (window as unknown as W).__WS_BACKEND__;
    b.seedPlanningAdo({ iterations, items });
    if (connect) await b.planningConnect(link);
    if (sprint) await b.planningSelectSprint(sprint);
  }, { items, iterations: ITERATIONS, link: TEAM_LINK, connect: options.connect !== false, sprint: options.sprint ?? null });
  await page.getByTestId("planning-button").click();
  await expect(page.getByTestId("planning-view")).toBeVisible();
}

const backend = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as W).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

async function reopen(page: Page) {
  await page.getByTestId("planning-close").click();
  await page.getByTestId("planning-button").click();
}

test("AT-1: a pasted team link connects Planning; bad input is refused visibly and changes nothing", async ({ page }) => {
  await start(page, sprintTeam(), { connect: false });
  const input = page.getByTestId("planning-connect-input");
  for (const [link, message] of [
    ["https://github.com/org/repo", "team sprint or backlog link"],
    ["https://dev.azure.com/skype/OneWork/_workitems/edit/4579097", "team sprint or backlog link"],
    ["https://dev.azure.com/skype/OneWork/_backlogs/backlog/Nope/Features", "wasn't found"],
  ] as const) {
    await input.fill(link);
    await page.getByTestId("planning-connect-submit").click();
    await expect(page.getByTestId("planning-connect-error")).toContainText(message);
  }
  await backend(page, "setPlanningAuthError", true);
  await input.fill(TEAM_LINK);
  await page.getByTestId("planning-connect-submit").click();
  await expect(page.getByTestId("planning-connect-error")).toContainText("az login");
  expect((await backend<{ connection: unknown }>(page, "planningState")).connection).toBeNull();
  await backend(page, "setPlanningAuthError", false);

  await input.fill(BACKLOG_LINK);
  await page.getByTestId("planning-connect-submit").click();
  await expect(page.getByTestId("planning-team")).toHaveText("Waimea Bay · OneWork");
  await expect(page.getByTestId("planning-sprint-header")).toBeVisible();
  await reopen(page);
  await expect(page.getByTestId("planning-team")).toHaveText("Waimea Bay · OneWork");
});

test("AT-2: you choose the sprint; a finished one offers to switch; both tabs follow the choice", async ({ page }) => {
  await start(page, sprintTeam(), { sprint: "OneWork\\S21" });
  await expect(page.getByTestId("planning-ended-banner")).toContainText("S21 (Oct 25) has finished");
  await expect(page.getByTestId("planning-sprint-select")).toHaveValue("OneWork\\S21");
  await page.getByTestId("planning-switch-current").click();
  await expect(page.getByTestId("planning-sprint-select")).toHaveValue("OneWork\\S22");
  await expect(page.getByTestId("planning-ended-banner")).toHaveCount(0);

  await page.getByTestId("planning-sprint-select").selectOption("OneWork\\S23");
  await expect(page.getByTestId("planning-sprint-select")).toHaveValue("OneWork\\S23");
  await page.getByTestId("planning-tab-plan-sprint").click();
  await expect(page.getByTestId("planning-sprint-column")).toContainText("S23 (Nov 22)");
  await reopen(page);
  await expect(page.getByTestId("planning-sprint-select")).toHaveValue("OneWork\\S23");
});

test("AT-3: the sprint shows only my stories, by state or by feature, with the header", async ({ page }) => {
  await start(page, sprintTeam());
  await expect(page.getByTestId("planning-sprint-header")).toContainText("7 / 8 SP committed · 1 done · 6 to go");
  await expect(page.getByTestId("planning-sprint-header")).toContainText("1 not estimated");
  await expect(page.locator('[data-testid^="planning-story-"]')).toHaveCount(4);
  await expect(page.getByTestId("planning-column-New").locator('[data-testid^="planning-story-"]')).toHaveCount(2);
  await expect(page.getByTestId("planning-column-Active").getByTestId("planning-story-3")).toBeVisible();
  await expect(page.getByTestId("planning-column-Closed").getByTestId("planning-story-1")).toBeVisible();
  await expect(page.getByTestId("planning-tasks-2")).toHaveText("· 0/3 tasks");
  await expect(page.getByTestId("planning-tasks-3")).toHaveText("· 2/4 tasks");
  await expect(page.getByTestId("planning-story-5")).toHaveCount(0);
  await expect(page.getByTestId("planning-story-6")).toHaveCount(0);
  await page.getByTestId("planning-layout-feature").click();
  await expect(page.getByTestId("planning-feature-group")).toContainText("Audio Transcoding");
  await reopen(page);
  await expect(page.getByTestId("planning-layout-feature")).toHaveAttribute("aria-pressed", "true");
});

test("AT-4: features show done vs pending, target, risk and others' stories; Removed left out", async ({ page }) => {
  await start(page, featureTeam());
  await page.getByTestId("planning-tab-features").click();
  await expect(page.locator('section[data-testid^="planning-feature-"]')).toHaveCount(2);
  await expect(page.getByTestId("planning-feature-400")).toHaveCount(0);
  await expect(page.getByTestId("planning-feature-100")).toContainText("2 sprints left");
  await expect(page.getByTestId("planning-feature-numbers-100")).toHaveText("5 SP done · 21 SP pending (13 yours) · 1 not estimated");
  await expect(page.getByTestId("planning-feature-story-16")).toContainText("Erwin Alvarez");
  await expect(page.getByTestId("planning-feature-story-17")).toHaveCount(0);
  await expect(page.getByTestId("planning-feature-risk-100")).toHaveCount(0);

  await backend(page, "changePlanningItemInAdo", 100, { target_date: "2026-11-10T00:00:00Z" });
  await page.getByTestId("planning-refresh").click();
  await expect(page.getByTestId("planning-feature-risk-100")).toHaveText("at risk");
  await expect(page.getByTestId("planning-feature-100")).toContainText("1 sprint left");
});

/** A real pointer drag (HTML5 drag-and-drop), not a click on the arrow button. */
async function drag(page: Page, from: string, to: string) {
  await page.getByTestId(from).dragTo(page.getByTestId(to));
}

test("AT-5: planning a sprint follows the 8-SP gauge, never blocks, and writes nothing", async ({ page }) => {
  await start(page, planSprintTeam(), { sprint: "OneWork\\S23" });
  await page.getByTestId("planning-tab-plan-sprint").click();
  const groups = page.locator('[data-testid^="planning-candidate-group-"]');
  await expect(groups.first()).toHaveAttribute("data-carry", "true");
  await expect(groups.first()).toContainText("Carried over");
  await expect(groups.first().getByTestId("planning-candidate-42")).toBeVisible();
  await expect(page.getByTestId("planning-candidate-45")).toContainText("unassigned");
  const gauge = page.getByTestId("planning-gauge");
  await expect(gauge).toHaveAttribute("data-state", "under");
  await expect(page.getByTestId("planning-gauge-total")).toHaveText("3 / 8 SP");
  await expect(page.getByTestId("planning-gauge-text")).toHaveText("5 to go");

  await drag(page, "planning-candidate-42", "planning-sprint-column");
  await drag(page, "planning-candidate-43", "planning-sprint-column");
  await expect(page.getByTestId("planning-gauge-total")).toHaveText("8 / 8 SP");
  await expect(gauge).toHaveAttribute("data-state", "on");
  await expect(page.getByTestId("planning-gauge-text")).toHaveText("On target");

  await drag(page, "planning-candidate-45", "planning-sprint-column");
  await drag(page, "planning-candidate-44", "planning-sprint-column");
  await expect(page.getByTestId("planning-gauge-total")).toHaveText("13 / 8 SP");
  await expect(gauge).toHaveAttribute("data-state", "over");
  await expect(page.getByTestId("planning-gauge-text")).toHaveText("5 over the goal · 1 not estimated");
  expect(await backend<number>(page, "planningWrites")).toBe(0);
  const s22 = (await backend<PlanItem[]>(page, "planningAdoItems")).find((i) => i.id === 42);
  expect(s22?.iteration_path).toBe("OneWork\\S22");
});

test("AT-6: planning a feature creates it and its estimated stories only when published", async ({ page }) => {
  await start(page, featureTeam());
  await page.getByTestId("planning-tab-plan-feature").click();
  await page.getByTestId("planning-new-feature").click();
  await page.getByTestId("planning-new-feature-title").fill("Media_Store Write support");
  await page.getByTestId("planning-new-feature-target").fill("2027-01-15");
  await page.getByTestId("planning-create-feature").click();
  for (const [title, points] of [["Write Frontend", "5"], ["FileSystem backend", "3"]]) {
    await page.getByTestId("planning-new-story-title").fill(title);
    await page.getByTestId("planning-new-story-points").fill(points);
    await page.getByTestId("planning-add-story").click();
    await expect(page.getByTestId("planning-new-story-title")).toHaveValue("");
  }
  await page.getByTestId("planning-new-story-title").fill("Half");
  await page.getByTestId("planning-new-story-points").fill("2.5");
  await expect(page.getByTestId("planning-feature-total")).toHaveText("10.5 SP");
  await page.getByTestId("planning-add-story").click();

  await page.getByTestId("planning-feature-select").selectOption("300");
  await page.getByTestId("planning-pf-points-31").fill("2");
  await page.getByTestId("planning-pf-points-31").blur();
  await page.getByTestId("planning-feature-select").selectOption("100");
  await page.getByTestId("planning-pf-down-11").click();
  await expect(page.locator('[data-testid^="planning-pf-story-"]').first()).toHaveAttribute("data-testid", "planning-pf-story-12");
  await page.getByTestId("planning-pf-remove-13").click();
  await expect(page.getByTestId("planning-pf-story-13")).toHaveCount(0);
  expect(await backend<number>(page, "planningWrites")).toBe(0);

  await page.getByTestId("planning-publish").click();
  await expect(page.getByTestId("planning-publish-result")).toContainText("published");
  const ado = await backend<PlanItem[]>(page, "planningAdoItems");
  const created = ado.find((i) => i.title === "Media_Store Write support")!;
  expect(created).toMatchObject({ kind: "Feature", target_date: "2027-01-15", assigned_to_me: true });
  expect(ado.filter((i) => i.parent_id === created.id).map((i) => [i.title, i.story_points, i.state, i.assigned_to_me]))
    .toEqual([["Write Frontend", 5, "New", true], ["FileSystem backend", 3, "New", true], ["Half", 2.5, "New", true]]);
  expect(ado.find((i) => i.id === 31)?.story_points).toBe(2);
  expect(ado.find((i) => i.id === 13)?.state).toBe("Removed");
  expect(ado.some((i) => i.id === 13)).toBe(true);
  expect(ado.find((i) => i.id === 11)?.order).toBe(2000);
});

test("AT-7: nothing reaches ADO until published; a conflict holds back only its item; Discard writes nothing", async ({ page }) => {
  await start(page, planSprintTeam(), { sprint: "OneWork\\S23" });
  await page.getByTestId("planning-tab-plan-sprint").click();
  for (const id of [42, 43, 44]) await page.getByTestId(`planning-add-${id}`).click();
  await expect(page.getByTestId("planning-draft-count")).toHaveText("3 changes not published");
  await reopen(page);
  await expect(page.getByTestId("planning-draft-count")).toHaveText("3 changes not published");
  expect(await backend<number>(page, "planningWrites")).toBe(0);

  await backend(page, "changePlanningItemInAdo", 43, { iteration_path: "OneWork\\S24" });
  await page.getByTestId("planning-publish").click();
  await expect(page.getByTestId("planning-conflict-43")).toContainText("now OneWork\\S24");
  await expect(page.getByTestId("planning-publish-result")).toContainText("2 published · 1 changed in ADO");
  await expect(page.getByTestId("planning-draft-count")).toHaveText("1 change not published");
  const ado = await backend<PlanItem[]>(page, "planningAdoItems");
  expect(ado.find((i) => i.id === 42)?.iteration_path).toBe("OneWork\\S23");
  expect(ado.find((i) => i.id === 44)?.iteration_path).toBe("OneWork\\S23");
  expect(ado.find((i) => i.id === 43)?.iteration_path).toBe("OneWork\\S24");

  const writes = await backend<number>(page, "planningWrites");
  await page.getByTestId("planning-discard").click();
  await expect(page.getByTestId("planning-draft-count")).toHaveCount(0);
  expect(await backend<number>(page, "planningWrites")).toBe(writes);
});
