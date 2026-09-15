/**
 * Filtering the workstream list by text.
 *
 * Two of these need a real browser. The empty-lane collapse is a layout claim —
 * "the result is readable" — which a jsdom assertion about node counts does not
 * actually test. And the filter box has to be reachable and typable at a real
 * sidebar width, which is exactly the class of bug the sidebar prototypes
 * shipped twice.
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    type Args = Record<string, unknown>;
    const handlers: Record<string, (a: Args) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      set_workstream_loaded: () => null,
      path_exists: () => true,
      get_copilot_sessions: () => [],
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ =
      handlers;
  });
}

async function seed(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __WS_DEMO_SEED__?: unknown }).__WS_DEMO_SEED__ = {
      projects: [{ name: "waimea", directory: "/demo/waimea" }],
      workstreams: [
        { name: "media store upload", directory: "/demo/a", project: "waimea" },
        { name: "media store fetch", directory: "/demo/b", project: "waimea" },
        { name: "encoder bitrate", directory: "/demo/c", project: "waimea" },
      ],
    };
  });
}

const search = (page: Page) => page.locator('[data-testid="ws-search-input"]');
const rows = (page: Page) => page.locator('[data-testid="workstream-item"]');

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await seed(page);
  await page.goto("/");
  await expect(page.locator('[data-testid="new-workstream-button"]')).toBeVisible();
});

test("the filter box is reachable and typable at a real sidebar width", async ({ page }) => {
  // Reachability, not presence: a box pushed out of the sidebar still exists.
  await expect(search(page)).toBeVisible();
  await search(page).click();
  await search(page).fill("media");
  await expect(search(page)).toHaveValue("media");
});

test("typing narrows the list to matching workstreams", async ({ page }) => {
  await expect(rows(page)).toHaveCount(3);
  await search(page).fill("media");
  await expect(rows(page)).toHaveCount(2);
  await search(page).fill("encoder");
  await expect(rows(page)).toHaveCount(1);
});

test("matching on the repo name finds workstreams the name does not mention", async ({ page }) => {
  // None of the three has "waimea" in its own name.
  await search(page).fill("waimea");
  await expect(rows(page)).toHaveCount(3);
});

test("clearing the box restores the full list", async ({ page }) => {
  await search(page).fill("encoder");
  await expect(rows(page)).toHaveCount(1);
  await search(page).fill("");
  await expect(rows(page)).toHaveCount(3);
});

test("Escape clears the filter", async ({ page }) => {
  await search(page).fill("encoder");
  await expect(rows(page)).toHaveCount(1);
  await search(page).press("Escape");
  await expect(search(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(3);
});

test("the clear button clears the filter", async ({ page }) => {
  await search(page).fill("encoder");
  await page.locator('[data-testid="ws-search-clear"]').click();
  await expect(search(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(3);
});

test("Alt+K focuses the filter box from anywhere", async ({ page }) => {
  // Not Alt+F -- that is toggleFullscreen, and the first attempt at this
  // binding silently stole it.
  await page.locator("body").click();
  await page.keyboard.press("Alt+k");
  await expect(search(page)).toBeFocused();
});

test("a search that matches nothing shows an empty list, not an error", async ({ page }) => {
  await search(page).fill("zzzzz");
  await expect(rows(page)).toHaveCount(0);
});
