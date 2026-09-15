/**
 * The task board is gone by default.
 *
 * Hiding a feature is exactly the kind of change a unit test can pass while
 * the real app still shows it: the sidebar test asserts the component renders
 * nothing without a handler, but whether App *withholds* that handler depends
 * on a build-time flag that jsdom reads from a different env than the browser.
 *
 * The specific bug this guards against is real and was hit while building
 * this: the first attempt hung `tasks` off `VITE_ENABLE_OPTIONAL_FEATURES`,
 * which the maintainer's `.env.local` sets to 1 for the Plan tile. Every unit
 * test passed and the board was still there on the one machine it was supposed
 * to disappear from. So this spec asserts absence in a real browser, with no
 * flag override in sight.
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      set_workstream_loaded: () => null,
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ =
      handlers;
    // Deliberately no __WS_FEATURE_FLAGS__: this is the shipped default.
  });
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
});

test("the sidebar offers no way into the task board", async ({ page }) => {
  // Anchor on a control that is always in the sidebar, so an empty result
  // means "hidden" rather than "the app had not rendered yet".
  await expect(page.locator('[data-testid="new-workstream-button"]')).toBeVisible();
  await expect(page.locator('[data-testid="task-board-button"]')).toHaveCount(0);
});

test("the board itself never mounts", async ({ page }) => {
  await expect(page.locator('[data-testid="new-workstream-button"]')).toBeVisible();
  await expect(page.locator('[data-testid="task-board"]')).toHaveCount(0);
});

test("the in-progress miniview is gone with it", async ({ page }) => {
  // The miniview is a separate node passed into the sidebar; hiding the button
  // without hiding this would leave a list in the footer opening nothing.
  await expect(page.locator('[data-testid="new-workstream-button"]')).toBeVisible();
  await expect(page.locator('[data-testid="in-progress-list"]')).toHaveCount(0);
});
