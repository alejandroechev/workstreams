/**
 * Code Review, Code Walkthrough and Goal Loop are hidden by default (sunset
 * flags, ADR 035): not offered in the add-tile menu, their shortcuts add
 * nothing, and a tile of theirs already saved in a layout shows why it is empty
 * instead of mounting. No flag override here: this is the shipped default.
 */
import { test, expect, type Page } from "@playwright/test";

async function configure(page: Page, tiles: Array<{ type: string; title: string }> = []) {
  await page.addInitScript((tiles) => {
    const handlers: Record<string, () => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      set_workstream_loaded: () => null,
      spawn_terminal: () => null,
      get_copilot_sessions: () => [],
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
    (window as unknown as { __WS_DEMO_SEED__?: unknown }).__WS_DEMO_SEED__ = {
      projects: [{ name: "Demo", directory: "/repos/demo" }],
      workstreams: [{ name: "Hidden demo", directory: "/repos/demo", project: "Demo", tiles: tiles.map((t) => ({ ...t, config: {} })) }],
    };
  }, tiles);
  await page.goto("/");
  await page.locator('[data-testid="workstream-item"]').first().click();
}

test("the add-tile menu does not offer the hidden tiles", async ({ page }) => {
  await configure(page);
  await page.locator('[data-testid="add-tile-button"]').click();
  await expect(page.locator('[data-testid="add-tile-item-explorer"]')).toBeVisible();
  for (const key of ["code-review", "walkthrough", "loop"]) {
    await expect(page.locator(`[data-testid="add-tile-item-${key}"]`)).toHaveCount(0);
  }
});

test("their shortcuts add nothing", async ({ page }) => {
  await configure(page);
  await expect(page.locator('[data-testid="status-bar"]')).toBeVisible();
  const before = await page.locator("[data-tile-id]").count();
  await page.locator("body").click();
  for (const key of ["a", "d", "l"]) await page.keyboard.press(`Alt+${key}`);
  await page.waitForTimeout(500);
  expect(await page.locator("[data-tile-id]").count()).toBe(before);
  // Control: the same keyboard path still adds a visible tile type.
  await page.keyboard.press("Alt+b");
  await expect(page.locator("[data-tile-id]")).toHaveCount(before + 1);
});

test("a hidden tile already in a layout explains itself instead of mounting", async ({ page }) => {
  await configure(page, [{ type: "loop_control", title: "Old loop" }, { type: "code_review", title: "Old review" }]);
  await expect(page.getByText("Hidden because it is not in use.").first()).toBeVisible();
  await expect(page.getByText("VITE_ENABLE_GOAL_LOOP=1")).toBeVisible();
  await expect(page.getByText("VITE_ENABLE_CODE_REVIEW=1")).toBeVisible();
});
