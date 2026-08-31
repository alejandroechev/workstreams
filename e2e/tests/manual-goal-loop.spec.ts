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

async function seedLoopDefinition(page: Page) {
  await page.evaluate(async () => {
    const backend = (window as unknown as {
      __WS_BACKEND__?: {
        listWorkstreams: () => Promise<Array<{ id: string; directory: string }>>;
        seedLoopDefinition: (
          definition: Record<string, unknown>,
          spec: Record<string, unknown>,
        ) => void;
      };
    }).__WS_BACKEND__;
    if (!backend) throw new Error("Memory backend is unavailable");
    const workstream = (await backend.listWorkstreams()).find(
      (candidate) => candidate.id,
    );
    if (!workstream) throw new Error("Goal Loop Demo workstream was not created");
    const path = `${workstream.directory}/.workstreams/loops/frontend.loop.yaml`;
    backend.seedLoopDefinition(
      {
        id: "frontend-loop",
        name: "Frontend verification loop",
        description: "Implements and verifies one frontend task.",
        tags: ["frontend", "demo"],
        path,
        hash: "sha256:e2e-frontend-loop",
        portable: true,
        objective: "Deliver a verified frontend change",
        hasVerification: true,
        hasEvaluator: true,
      },
      {
        orchestrator: { prompt: "Discover one coding task", model: "" },
        worker: { prompt: "Implement the coding task", model: "" },
        evaluator: { prompt: "Independently evaluate the result", model: "" },
        verifier: { program: "npm", args: ["test"], cwd: workstream.directory },
        runTimeoutMs: 5 * 60_000,
        maxTaskIterations: 2,
      },
    );
  });
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
  await seedLoopDefinition(page);
  await addLoopTile(page);
});

test("selects, pauses, resumes, verifies, and evaluates a YAML loop", async ({
  page,
}) => {
  await expect(page.locator('[data-testid="loop-definition-frontend-loop"]')).toContainText(
    "Verification + Evaluator",
  );
  await expect(page.locator('[data-testid="loop-definition-selected"]')).toContainText(
    "Frontend verification loop",
  );
  await page.locator('[data-testid="loop-run-selected"]').click();
  await expect(page.locator('[data-testid="running-loop-count"]')).toContainText(
    "1 running",
  );
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toBeVisible();

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
  await page.locator('[data-testid="loop-run-selected"]').click();
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toBeVisible();

  await page.locator('[data-testid="loop-kill"]').click();

  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Killed",
  );
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toContainText(
    "interrupted",
  );
});
