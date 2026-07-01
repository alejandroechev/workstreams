/**
 * E2E for the Local Agent Review tile (ADR 013). Runs against the dev server
 * with the in-memory backend, driving the reviewer↔agent loop: add a comment,
 * resolve it, then complete the review and see the exported summary path.
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    type Args = Record<string, unknown>;
    const handlers: Record<string, (a: Args) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      list_git_hooks: () => [],
      git_current_branch: () => "main",
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
  });
}

async function ensureWorkstreamWithAgentReview(page: Page, name: string) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await page.locator('[data-testid="ws-create-form"]').waitFor();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill(name);
  await page.locator('[data-testid="ws-create-submit"]').click();
  await page.locator('[data-testid="ws-create-form"]').waitFor({ state: "detached" });
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-agent-review"]').click();
  await expect(page.locator('[data-testid="agent-review-tile"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
});

test.describe("Local Agent Review", () => {
  test("reviewer comments, resolves, and completes the review", async ({ page }) => {
    await ensureWorkstreamWithAgentReview(page, "ReviewWS");

    // Starts empty at round 1.
    await expect(page.getByText("round 1")).toBeVisible();
    await expect(page.getByText("No review comments yet.")).toBeVisible();

    // Add a comment.
    await page.getByRole("button", { name: "Comment" }).click();
    await page.getByPlaceholder("absolute file path").fill("C:/repo/auth.js");
    await page.getByPlaceholder("line", { exact: true }).fill("4");
    await page.getByPlaceholder("comment (markdown)").fill("remove the console.log");
    await page.getByRole("button", { name: "Add comment" }).click();

    // Thread appears at auth.js:4, status Open.
    const thread = page.locator('[data-testid="review-thread"]');
    await expect(thread).toBeVisible();
    await expect(page.getByText("auth.js:4")).toBeVisible();
    await expect(page.locator('[data-testid="thread-status"]')).toHaveText("Open");

    // Complete is not offered while the thread is open.
    await expect(page.locator('[data-testid="complete-review"]')).toHaveCount(0);

    // Resolve, then complete.
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(page.locator('[data-testid="thread-status"]')).toHaveText("Resolved");
    await page.locator('[data-testid="complete-review"]').click();

    await expect(page.locator('[data-testid="exported-path"]')).toContainText("review.md");
  });
});
