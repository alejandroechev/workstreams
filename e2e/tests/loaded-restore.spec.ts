/**
 * Restoring the loaded set across a restart.
 *
 * The distinction this spec exists to pin down: **the set is restored, the
 * tiles are not.** A workstream left open comes back marked loaded in the
 * sidebar, and mounts its tiles on first visit. Restoring the tiles instead
 * would spawn every terminal and Copilot session in the set at once — with 23
 * active workstreams that is a very expensive way to open an app.
 *
 * jsdom cannot show this: "the tiles did not mount" is only meaningful against
 * a real render, where a mounted terminal is a visible thing.
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

/**
 * Stage "the app was closed with `left-open` open, and `left-closed` not".
 * Seeding is the only way to reach this: a reload throws the in-memory backend
 * away, so the state has to exist before the app mounts.
 */
async function seedLoadedSet(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __WS_DEMO_SEED__?: unknown }).__WS_DEMO_SEED__ = {
      projects: [{ name: "Demo", directory: "/demo" }],
      workstreams: [
        {
          name: "left-open",
          directory: "/demo/left-open",
          project: "Demo",
          loaded: true,
          tiles: [{ type: "terminal", title: "shell" }],
        },
        {
          name: "left-closed",
          directory: "/demo/left-closed",
          project: "Demo",
          tiles: [{ type: "terminal", title: "shell" }],
        },
      ],
    };
  });
}

function row(page: Page, name: string) {
  return page.locator('[data-testid="workstream-item"]', { hasText: name });
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await seedLoadedSet(page);
  await page.goto("/");
  await expect(page.locator('[data-testid="new-workstream-button"]')).toBeVisible();
});

test("a workstream left open comes back marked loaded", async ({ page }) => {
  // The moon is the "stopped (not loaded)" indicator. Its absence on a
  // workstream nobody has clicked this session is the whole feature.
  await expect(row(page, "left-open")).toBeVisible();
  await expect(
    row(page, "left-open").locator('[data-testid="ws-indicator-stopped"]'),
  ).toHaveCount(0);
});

test("a workstream that was closed still shows as stopped", async ({ page }) => {
  // Without this the first assertion would pass just as well if every row were
  // marked loaded regardless of the flag.
  await expect(
    row(page, "left-closed").locator('[data-testid="ws-indicator-stopped"]'),
  ).toHaveCount(1);
});

test("restoring the set does not mount the tiles", async ({ page }) => {
  // The load-bearing half. `left-open` is loaded, but nothing has been
  // selected, so no tile grid should exist yet -- had the restore mounted
  // tiles, the seeded terminal would be on screen.
  await expect(row(page, "left-open")).toBeVisible();
  await expect(page.locator('[data-testid^="tile-close-"]')).toHaveCount(0);
});

test("visiting a restored workstream mounts its tiles then", async ({ page }) => {
  // Lazy, not never: the tiles must still arrive on first visit, or the
  // restored rows would be decorative.
  await row(page, "left-open").click();
  await expect(page.locator('[data-testid^="tile-close-"]').first()).toBeVisible();
});
