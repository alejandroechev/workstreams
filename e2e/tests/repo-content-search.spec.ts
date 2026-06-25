/**
 * E2E for the Repo Explorer content-search ("search all files") Search tab.
 * Runs against the dev server with the in-memory backend; the search_in_files
 * Tauri command is stubbed to return a deterministic match.
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    type Args = Record<string, unknown>;
    const handlers: Record<string, (a: Args) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      read_file_base64: () => "",
      read_text_file: () => ({ content: "line one\nconst needle = 42;\nline three", line_ending: "lf", has_trailing_newline: true }),
      watch_directory: () => null,
      unwatch_directory: () => null,
      list_git_hooks: () => [],
      git_current_branch: () => "main",
      cancel_searches: () => null,
      search_files: () => [],
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
  });
}

async function seedSearchFile(page: Page) {
  // The dev server uses the in-memory backend, whose searchInFiles scans seeded
  // files (not the invoke stub). Seed a file with "needle" on line 2.
  await page.evaluate(() => {
    const b = (window as unknown as {
      __WS_BACKEND__: { seedFile?: (path: string, content: string) => void };
    }).__WS_BACKEND__;
    b.seedFile?.("/demo/app.ts", "line one\nconst needle = 42;\nline three");
  });
}

async function ensureWorkstreamWithExplorer(page: Page, name: string) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await page.locator('[data-testid="ws-create-form"]').waitFor();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill(name);
  await page.locator('[data-testid="ws-create-submit"]').click();
  await page.locator('[data-testid="ws-create-form"]').waitFor({ state: "detached" });
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-explorer"]').click();
  await page.waitForTimeout(500);
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await seedSearchFile(page);
});

test.describe("Repo Explorer content search", () => {
  test("Search tab runs a content search and renders a highlighted match", async ({ page }) => {
    await ensureWorkstreamWithExplorer(page, "SearchWS");

    await page.locator('[data-testid="repo-explorer-tab-search"]').click();
    const input = page.locator('[data-testid="content-search-input"]');
    await expect(input).toBeVisible();
    await input.fill("needle");

    const row = page.locator('[data-testid="content-search-match-/demo/app.ts-2"]');
    await expect(row).toBeVisible();
    // The matched substring is highlighted via <mark>.
    await expect(row.locator("mark")).toHaveText("needle");
  });

  test("clicking a result opens the file in the editor", async ({ page }) => {
    await ensureWorkstreamWithExplorer(page, "SearchOpenWS");

    await page.locator('[data-testid="repo-explorer-tab-search"]').click();
    await page.locator('[data-testid="content-search-input"]').fill("needle");
    await page.locator('[data-testid="content-search-match-/demo/app.ts-2"]').click();

    await expect(page.locator('[data-testid="file-editor-view"]')).toBeVisible();
  });

  test("Ctrl+Shift+F opens the Search tab", async ({ page }) => {
    await ensureWorkstreamWithExplorer(page, "SearchHotkeyWS");

    await page.keyboard.press("Control+Shift+F");
    await expect(page.locator('[data-testid="content-search-input"]')).toBeVisible();
  });
});
