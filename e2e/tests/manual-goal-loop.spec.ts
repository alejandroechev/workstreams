import { expect, test, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    const handlers: Record<string, () => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers })
      .__WS_INVOKE_HANDLERS__ = handlers;
  });
}

async function createAndOpenWorkstream(page: Page) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill("Goal Loop Demo");
  await page.locator('[data-testid="ws-create-submit"]').click();
  const row = page.locator('[data-testid="workstream-item"]', {
    hasText: "Goal Loop Demo",
  });
  await expect(row).toBeVisible();
  await row.click();
}

async function addLoopTile(page: Page) {
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-loop"]').click();
  await expect(page.locator('[data-testid="loop-control-tile"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await createAndOpenWorkstream(page);
  await addLoopTile(page);
});

test("configures, pauses, resumes, verifies, and evaluates a manual coding loop", async ({
  page,
}) => {
  await page.getByLabel("Orchestrator prompt").fill("Discover one coding task");
  await page.getByLabel("Worker prompt").fill("Implement the coding task");
  await page.getByLabel("Evaluator prompt").fill("Independently evaluate the result");
  await page.getByLabel("Run timeout minutes").fill("5");
  await page.getByLabel("Verifier program").fill("npm");
  await page.getByLabel("Verifier arguments").fill("test");
  await page.getByLabel("Verifier working directory").fill("C:\\repos\\demo");
  await page.locator('[data-testid="loop-save-enable"]').click();

  await expect(page.locator('[data-testid="loop-config-readonly"]')).toBeVisible();
  await page.locator('[data-testid="loop-run-now"]').click();
  await expect(page.locator('[data-testid="running-loop-count"]')).toContainText(
    "1 running",
  );
  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Working",
  );

  await page.locator('[data-testid="loop-pause"]').click();
  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Paused",
  );
  await page.locator('[data-testid="loop-resume"]').click();

  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Completed",
    { timeout: 5_000 },
  );
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toContainText(
    "accepted",
  );
  await expect(
    page.locator('[data-testid^="loop-verification-"]').first(),
  ).toContainText("passed");
  await expect(
    page.locator('[data-testid^="loop-evaluation-"]').first(),
  ).toContainText("accepted");
  await expect(page.locator('[data-testid="running-loop-count"]')).toHaveCount(0);
});

test("kills an active loop and preserves an interrupted task", async ({ page }) => {
  await page.getByLabel("Orchestrator prompt").fill("Discover one coding task");
  await page.getByLabel("Worker prompt").fill("Implement it");
  await page.getByLabel("Evaluator prompt").fill("Evaluate it");
  await page.locator('[data-testid="loop-save-enable"]').click();
  await page.locator('[data-testid="loop-run-now"]').click();
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toBeVisible();

  await page.locator('[data-testid="loop-kill"]').click();

  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Killed",
  );
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toContainText(
    "interrupted",
  );
});
