/**
 * E2E for the Code Review tile (ADR 014).
 * Vite dev server with VITE_E2E=1 (MemoryBackend + Tauri invoke shim).
 *
 * Covers the diff-first, session-DB-backed, MCP-free review loop:
 *   - add a Code Review tile
 *   - create a working_tree review, see the changed files + diff
 *   - comment inline on the modified side
 *   - in-place edit → Save affordance appears (working_tree is editable)
 *   - a (stubbed) agent reply written to the store shows up via the poll
 *   - reviewer resolves the thread, then completes the review
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    type Args = Record<string, unknown>;
    const handlers: Record<string, (a: Args) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      spawn_terminal: () => null,
      write_to_pty: () => null,
      resize_pty: () => null,
      close_terminal: () => null,
      load_scrollback: () => null,
      save_scrollback: () => null,
      watch_session: () => null,
      unwatch_session: () => null,
      watch_directory: () => null,
      unwatch_directory: () => null,
      watch_file_changes: () => null,
      unwatch_file_changes: () => null,
      read_text_file: () => ({ content: "", eol: "\n" }),
      write_text_file: () => null,
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
    (window as unknown as { __WS_INVOKE_LOG__: unknown[] }).__WS_INVOKE_LOG__ = [];
  });
}

// Seed the offline review diff before the tile creates a review.
async function seedDiff(page: Page) {
  await page.evaluate(() => {
    const b = (window as unknown as { __WS_BACKEND__?: any }).__WS_BACKEND__;
    b.seedReviewDiff([{ path: "src/a.js", status: "M" }]);
    b.seedReviewDiffSides("src/a.js", { before: "one\n", after: "one\ntwo\n" });
  });
}

async function createWorkstream(page: Page, name: string) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill(name);
  await page.locator('[data-testid="ws-create-submit"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
}

async function addCodeReviewTile(page: Page) {
  await page.locator('[data-testid="add-tile-button"]').click();
  await expect(page.locator('[data-testid="add-tile-menu"]')).toBeVisible();
  await page.locator('[data-testid="add-tile-item-code-review"]').click();
  await expect(page.locator('[data-testid="code-review-tile"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await seedDiff(page);
});

test.describe("Code Review tile", () => {
  test("local review loop: diff renders → editable → comment + agent reply via poll → resolve → complete", async ({
    page,
  }) => {
    await createWorkstream(page, "Review A");
    await addCodeReviewTile(page);

    // Picker → start a working_tree review.
    await expect(page.locator('[data-testid="review-picker"]')).toBeVisible();
    await page.locator('[data-testid="create-review"]').click();

    // Changed files + the REAL Monaco diff editor render (integration: no white
    // screen / plugin errors). Both diff sides mount.
    await expect(page.locator('[data-testid="file-src/a.js"]')).toBeVisible();
    await expect(page.locator(".monaco-diff-editor")).toBeVisible();
    await expect(page.locator(".editor.modified")).toBeVisible();

    // The modified side is editable for working_tree (Save affordance exists).
    await expect(page.locator('[data-testid="save-edit"]')).toBeVisible();

    // Add a reviewer comment + an agent reply straight to the session store,
    // then assert the tile's poll surfaces the thread and reply. (Monaco caret
    // selection + in-place typing are covered by the component test with a
    // mocked editor; here we validate the store⇄poll integration.)
    await page.evaluate(async () => {
      const b = (window as unknown as { __WS_BACKEND__?: any }).__WS_BACKEND__;
      const wss = await b.listWorkstreams();
      const wsId = wss[0].id;
      const review = await b.getActiveReview(wsId);
      const c = await b.addReviewComment(
        wsId,
        review.id,
        "src/a.js",
        2,
        "new",
        "two",
        null,
        "Remove the extra line",
      );
      b.simulateAgentReply(review.id, c.id, "Done — removed it.");
    });

    // The reviewer thread and the agent reply appear via the 1.5s poll.
    await expect(page.locator('[data-testid="comment-thread"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="thread-reply"]')).toBeVisible({ timeout: 8000 });

    // Reviewer resolves the thread, then completes the review.
    await page.locator('[data-testid="resolve"]').first().click();
    await expect(page.locator('[data-testid="thread-status"]').first()).toHaveText("Resolved");
    await page.locator('[data-testid="complete-review"]').click();
    await expect(page.locator('[data-testid="review-completed"]')).toBeVisible();
  });
});
