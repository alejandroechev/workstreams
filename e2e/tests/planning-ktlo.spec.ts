/**
 * KTLO stories from the Orphaned PRs tab (ADR 039, amendment 2026-11-02): the
 * in-memory backend plays ADO, with this semester's KTLO feature #4533022.
 * Covers AT-1 to AT-7 of files/features/ktlo-stories/acceptance.md. The page
 * clock is fixed at 2026-10-30T12:00Z, inside S22 (ADO's current sprint).
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { Change, PlanItem } from "../../src/domain/planning";
import { ITERATIONS, KTLO_LINK, TEAM_LINK, ktloTeam, orphanPrs } from "../../src/planning/__tests__/fixtures";

type W = { __WS_BACKEND__: MemoryBackend };

async function start(page: Page, options: { ktlo?: boolean } = {}) {
  await page.clock.install({ time: new Date("2026-10-30T12:00:00Z") });
  await page.addInitScript(() => {
    Object.assign(window, { __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null } });
  });
  await page.goto("/");
  await page.evaluate(async ({ items, prs, iterations, link, ktlo }) => {
    const b = (window as unknown as W).__WS_BACKEND__;
    b.seedPlanningAdo({ iterations, items });
    b.seedPlanningPrs(prs);
    await b.planningConnect(link);
    if (ktlo) await b.planningSetKtlo(ktlo);
  }, { items: ktloTeam(), prs: orphanPrs(), iterations: ITERATIONS, link: TEAM_LINK, ktlo: options.ktlo === false ? null : KTLO_LINK });
  await page.getByTestId("planning-button").click();
  await page.getByTestId("planning-tab-orphans").click();
  await expect(page.getByTestId("planning-orphan-row-101")).toBeVisible();
}

const backend = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as W).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

const draft = async (page: Page) => (await backend<{ draft: Change[] }>(page, "planningState")).draft;
const ktloLine = (page: Page) => page.getByTestId("planning-ktlo");

async function setKtlo(page: Page, link: string) {
  if (await page.getByTestId("planning-ktlo-change").isVisible()) await page.getByTestId("planning-ktlo-change").click();
  await page.getByTestId("planning-ktlo-input").fill(link);
  await page.getByTestId("planning-ktlo-set").click();
}

async function newKtloStory(page: Page, pr: number, fields: { name?: string; points?: string } = {}) {
  await page.getByTestId(`planning-orphan-link-${pr}`).selectOption("new-ktlo");
  const form = page.getByTestId(`planning-ktlo-form-${pr}`);
  await expect(form).toBeVisible();
  if (fields.name !== undefined) await form.getByTestId("planning-ktlo-name").fill(fields.name);
  if (fields.points !== undefined) await form.getByTestId("planning-ktlo-points").fill(fields.points);
  await form.getByTestId("planning-ktlo-add").click();
  await expect(form).toHaveCount(0);
}

async function reopen(page: Page) {
  await page.getByTestId("planning-close").click();
  await page.getByTestId("planning-button").click();
  await page.getByTestId("planning-tab-orphans").click();
}

test("AT-1: setting the KTLO feature by pasting its link, in either host form", async ({ page }) => {
  await start(page, { ktlo: false });
  await expect(ktloLine(page)).toContainText("Set the KTLO feature");
  await setKtlo(page, KTLO_LINK);
  await expect(ktloLine(page)).toContainText("KTLO — H2 2026");
  await expect(ktloLine(page)).toContainText("#4533022");
  await reopen(page);
  await expect(ktloLine(page)).toContainText("KTLO — H2 2026");

  await setKtlo(page, "https://dev.azure.com/skype/OneWork/_workitems/edit/4533022");
  await expect(page.getByTestId("planning-ktlo-change")).toBeVisible();
  await reopen(page);
  await expect(ktloLine(page)).toContainText("KTLO — H2 2026");
  await expect(ktloLine(page)).toContainText("4533022");
});

test("AT-2: a link that isn't an open Feature in this project is refused", async ({ page }) => {
  await start(page);
  await expect(ktloLine(page)).toContainText("#4533022");
  for (const [link, reason] of [
    ["https://skype.visualstudio.com/OneWork/_workitems/edit/7001", "not a Feature"],
    ["https://skype.visualstudio.com/OtherProject/_workitems/edit/7002", "another project"],
    ["https://skype.visualstudio.com/OneWork/_workitems/edit/7003", "Closed"],
    ["https://skype.visualstudio.com/OneWork/_sprints/taskboard/Waimea%20Bay", "work item link"],
  ]) {
    await setKtlo(page, link);
    await expect(page.getByTestId("planning-ktlo-error")).toContainText(reason);
    await expect(ktloLine(page)).toContainText("#4533022");
    await page.getByRole("button", { name: "Cancel" }).click();
  }
  expect((await backend<{ id: number } | null>(page, "planningKtlo"))?.id).toBe(4533022);
});

test("AT-3: a KTLO feature closed in ADO disables new KTLO stories", async ({ page }) => {
  await start(page);
  const option = (pr: number) => page.getByTestId(`planning-orphan-link-${pr}`).locator('option[value="new-ktlo"]');
  await expect(option(101)).toBeEnabled();
  await backend(page, "changePlanningItemInAdo", 4533022, { state: "Closed" });
  await page.getByTestId("planning-refresh").click();
  await expect(page.getByTestId("planning-ktlo-problem")).toContainText("Closed");
  for (const pr of [101, 102, 103, 104]) await expect(option(pr)).toBeDisabled();
});

test("AT-4: drafting a new KTLO story from a PR row, with its defaults", async ({ page }) => {
  await start(page);
  await page.getByTestId("planning-sprint-select").selectOption("OneWork\\S21");
  await expect(page.getByTestId("planning-orphan-row-101")).toBeVisible();
  await page.getByTestId("planning-orphan-link-101").selectOption("new-ktlo");
  const form = page.getByTestId("planning-ktlo-form-101");
  await expect(form.getByTestId("planning-ktlo-name")).toHaveValue("Fix chunk reader retries");
  await expect(form.getByTestId("planning-ktlo-points")).toHaveValue("1");
  const sprint = form.getByTestId("planning-ktlo-sprint");
  await expect(sprint).toHaveValue("OneWork\\S23");
  expect(await sprint.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)))
    .toEqual(["OneWork\\S22", "OneWork\\S23", "OneWork\\S24"]);
  const writes = await backend<number>(page, "planningWrites");
  await form.getByTestId("planning-ktlo-add").click();

  await expect(page.getByTestId("planning-orphan-pending-101"))
    .toHaveText("● → New KTLO story “Fix chunk reader retries” (1 pt, S23 (Nov 22)), not published");
  expect(await draft(page)).toEqual([
    { kind: "create_story", temp_id: -1, parent: 4533022, title: "Fix chunk reader retries", points: 1, description: null, iteration: "OneWork\\S23", order: null },
    { kind: "link_pr", id: -1, rev: 0, pr: { id: 101, project_id: "SCC-id", repo_id: "acs_media_sdk-id", title: "Fix chunk reader retries" } },
  ]);
  expect(await backend<number>(page, "planningWrites")).toBe(writes);
});

test("AT-5: publishing creates the KTLO story and links the PR", async ({ page }) => {
  await start(page);
  const before = (await backend<PlanItem[]>(page, "planningAdoItems")).map((i) => i.id);
  await newKtloStory(page, 101, { name: "OpenSSL bump", points: "2" });
  await page.getByTestId("planning-publish").click();
  await expect(page.getByTestId("planning-orphan-row-101")).toHaveCount(0);

  const created = (await backend<PlanItem[]>(page, "planningAdoItems")).filter((i) => !before.includes(i.id));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    kind: "User Story", title: "OpenSSL bump", state: "New", assigned_to_me: true,
    iteration_path: "OneWork\\S23", story_points: 2, parent_id: 4533022,
  });
  expect(await backend<number[]>(page, "planningPrLinks", 101)).toEqual([created[0].id]);
  expect(await draft(page)).toEqual([]);

  await page.getByTestId("planning-sprint-select").selectOption("OneWork\\S23");
  await page.getByTestId("planning-tab-sprint").click();
  await expect(page.getByTestId("planning-view")).toContainText("OpenSSL bump");
  await page.getByTestId("planning-tab-features").click();
  await expect(page.getByTestId("planning-view")).not.toContainText("KTLO — H2 2026");
});

test("AT-6: several PRs go into one new KTLO story", async ({ page }) => {
  await start(page);
  const before = (await backend<PlanItem[]>(page, "planningAdoItems")).map((i) => i.id);
  await newKtloStory(page, 101, { name: "Dependency bumps" });
  const offered = page.getByTestId("planning-orphan-link-103").locator('option[value="-1"]');
  await expect(offered).toHaveText("New: Dependency bumps (not published)");
  await page.getByTestId("planning-orphan-link-103").selectOption("-1");
  await expect(page.getByTestId("planning-orphan-pending-103")).toContainText("Dependency bumps, not published");

  await page.getByTestId("planning-publish").click();
  await expect(page.getByTestId("planning-orphan-row-101")).toHaveCount(0);
  await expect(page.getByTestId("planning-orphan-row-103")).toHaveCount(0);
  const created = (await backend<PlanItem[]>(page, "planningAdoItems")).filter((i) => !before.includes(i.id));
  expect(created.map((i) => i.title)).toEqual(["Dependency bumps"]);
  expect(await backend<number[]>(page, "planningPrLinks", 101)).toEqual([created[0].id]);
  expect(await backend<number[]>(page, "planningPrLinks", 103)).toEqual([created[0].id]);
});

test("AT-7: removing the drafted story cancels it and its links", async ({ page }) => {
  await start(page);
  await newKtloStory(page, 101, { name: "Dependency bumps" });
  await page.getByTestId("planning-orphan-link-103").selectOption("-1");
  await expect(page.getByTestId("planning-orphan-pending-103")).toBeVisible();

  await page.getByTestId("planning-orphan-link-101").selectOption("");
  await expect(page.getByTestId("planning-orphan-pending-101")).toHaveCount(0);
  await expect(page.getByTestId("planning-orphan-pending-103")).toHaveCount(0);
  expect(await draft(page)).toEqual([]);
  const writes = await backend<number>(page, "planningWrites");
  await backend(page, "planningPublish");
  expect(await backend<number>(page, "planningWrites")).toBe(writes);
});
