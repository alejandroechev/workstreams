/**
 * E2E for the unified workstream list: lanes, filtering, and unarchiving.
 *
 * Vite dev server with VITE_E2E=1 (MemoryBackend + Tauri invoke shim). These
 * flows are here rather than in jsdom because drag-and-drop and the dialogs
 * have no meaningful jsdom equivalent.
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page, options: { pathExists?: boolean } = {}) {
  const pathExists = options.pathExists ?? true;
  await page.addInitScript(
    ({ pathExists }) => {
      type Args = Record<string, unknown>;
      const handlers: Record<string, (a: Args) => unknown> = {
        get_setting: () => null,
        set_setting: () => null,
        path_exists: () => pathExists,
        detect_worktree_info: () => ({
          is_worktree: false,
          parent_repo_path: null,
          parent_repo_name: null,
          branch: null,
          git_remote: null,
        }),
        get_copilot_sessions: () => [],
      };
      (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ =
        handlers;
    },
    { pathExists },
  );
}

/** Creates a workstream through the UI so the test exercises the real path. */
async function createWorkstream(page: Page, name: string) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill(name);
  await page.locator('[data-testid="ws-create-submit"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
}

async function addLane(page: Page, name: string) {
  // An inline input, not a dialog: window.prompt does not exist in the Tauri
  // webview, so a prompt-based control is dead in the packaged app while
  // working perfectly here in Chromium.
  await page.locator('[data-testid="ws-add-lane"]').click();
  const input = page.locator('[data-testid="ws-new-lane-input"]');
  await input.fill(name);
  await input.press("Enter");
}

test.describe("workstream lanes", () => {
  test.beforeEach(async ({ page }) => {
    await configureInvokeHandlers(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("a new lane appears as a folder, empty and ready to drop into", async ({ page }) => {
    await addLane(page, "Media Store");

    // Empty lanes must render, or a lane you just made is impossible to use.
    await expect(page.locator('[data-testid="ws-lane-lane-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-lane-toggle-lane-1"]')).toContainText(
      "Media Store",
    );
  });

  test("dragging a workstream into a lane nests it there", async ({ page }) => {
    await createWorkstream(page, "Read chunks");
    await addLane(page, "Media Store");

    const row = page.locator('[data-testid="workstream-item"]', { hasText: "Read chunks" });
    const lane = page.locator('[data-testid="ws-lane-lane-1"]');
    await row.dragTo(lane);

    await expect(lane.locator('[data-testid="workstream-item"]')).toContainText("Read chunks");
  });

  test("collapsing a lane hides its workstreams", async ({ page }) => {
    await createWorkstream(page, "Read chunks");
    await addLane(page, "Media Store");
    const row = page.locator('[data-testid="workstream-item"]', { hasText: "Read chunks" });
    const lane = page.locator('[data-testid="ws-lane-lane-1"]');
    await row.dragTo(lane);

    await page.locator('[data-testid="ws-lane-toggle-lane-1"]').click();
    await expect(
      page.locator('[data-testid="workstream-item"]', { hasText: "Read chunks" }),
    ).toHaveCount(0);
  });

  test("the filter selection sticks and keeps open work visible", async ({ page }) => {
    await createWorkstream(page, "Open one");

    await page.locator('[data-testid="ws-list-filter-loaded"]').click();
    await expect(page.locator('[data-testid="ws-list-filter-loaded"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Creating a workstream opens it, so it survives the narrowest filter.
    await expect(
      page.locator('[data-testid="workstream-item"]', { hasText: "Open one" }),
    ).toBeVisible();

    // The choice persists across a reload, so the list does not silently
    // widen again the next time the app starts.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="ws-list-filter-loaded"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("archived workstreams appear only under All, and look different", async ({ page }) => {
    await createWorkstream(page, "Old work");

    const row = page.locator('[data-testid="workstream-item"]', { hasText: "Old work" });
    await row.hover();
    await row.locator('[data-testid^="ws-actions-"]').click();
    await page.locator('[data-testid="action-archive"]').click();
    await page.locator('[data-testid="archive-confirm"]').click();

    await expect(
      page.locator('[data-testid="workstream-item"]', { hasText: "Old work" }),
    ).toHaveCount(0);

    await page.locator('[data-testid="ws-list-filter-all"]').click();
    const archived = page.locator('[data-testid="workstream-item"]', { hasText: "Old work" });
    await expect(archived).toBeVisible();
    await expect(archived).toHaveAttribute("data-archived", "true");
  });
});
