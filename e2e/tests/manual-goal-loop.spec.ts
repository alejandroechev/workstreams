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
          workstreamId?: string,
        ) => void;
        seedFile: (path: string, content: string) => void;
      };
    }).__WS_BACKEND__;
    if (!backend) throw new Error("Memory backend is unavailable");
    const workstream = (await backend.listWorkstreams()).find(
      (candidate) => candidate.id,
    );
    if (!workstream) throw new Error("Goal Loop Demo workstream was not created");
    const path = `/sessions/e2e-loop-session/files/loops/frontend.loop.yaml`;
    backend.seedFile(
      path,
      `apiVersion: workstreams.dev/v1alpha1
kind: Loop
metadata:
  id: frontend-loop
  name: Frontend verification loop
spec:
  objective: Deliver a verified frontend change
`,
    );
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
        hasHumanApproval: true,
      },
      {
        orchestrator: { prompt: "Discover one coding task", model: "" },
        worker: { prompt: "Implement the coding task", model: "" },
        evaluator: { prompt: "Independently evaluate the result", model: "" },
        humanApproval: { prompt: "Review the completed task and its evidence" },
        verifier: { program: "npm", args: ["test"], cwd: workstream.directory },
        runTimeoutMs: 5 * 60_000,
        maxTaskIterations: 2,
      },
      workstream.id,
    );
    const handlers = (window as unknown as {
      __WS_INVOKE_HANDLERS__?: Record<string, (args?: any) => unknown>;
    }).__WS_INVOKE_HANDLERS__;
    if (!handlers) throw new Error("Invoke handlers are unavailable");
    handlers.canonicalize_path = ({ path: requestedPath }) => requestedPath;
    handlers.read_text_file = async ({ path: requestedPath }) => {
      const content = await (backend as any).readFile(requestedPath);
      return {
        content,
        mtime_unix_ms: 1,
        hash_hex: `hash-${content.length}`,
        line_ending: "lf",
        has_trailing_newline: content.endsWith("\n"),
        sniffed_binary: false,
        size_bytes: content.length,
      };
    };
    handlers.write_text_file = ({ args }) => {
      backend.seedFile(args.path, args.content);
      return {
        mtime_unix_ms: 2,
        hash_hex: `hash-${args.content.length}`,
      };
    };
    handlers.watch_file_changes = () => null;
    handlers.unwatch_file_changes = () => null;
  });
}

async function addLoopTile(page: Page) {
  await page.keyboard.press("Alt+l");
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
  await page.locator('[data-testid="loop-tab-definitions"]').click();
  await expect(page.locator('[data-testid="loop-definitions-tab"]')).toBeVisible();
  await expect(page.locator('[data-testid="loop-definition-editor-header"]')).toContainText(
    "frontend.loop.yaml",
  );
  await page.waitForFunction(
    () => {
      const registry = (window as unknown as {
        __wsFileBufferRegistry?: {
          listAll: () => Array<{ path: string }>;
          getModel: (path: string) => unknown;
        };
      }).__wsFileBufferRegistry;
      const target = registry
        ?.listAll()
        .find((snapshot) => snapshot.path.endsWith("frontend.loop.yaml"));
      return target ? registry?.getModel(target.path) !== null : false;
    },
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(async () => {
    const registry = (window as unknown as {
      __wsFileBufferRegistry?: {
        listAll: () => Array<{ path: string }>;
        getModel: (path: string) => { getValue: () => string; setValue: (value: string) => void };
        save: (path: string) => Promise<void>;
      };
    }).__wsFileBufferRegistry;
    if (!registry) throw new Error("File buffer registry is unavailable");
    const target = registry
      .listAll()
      .find((snapshot) => snapshot.path.endsWith("frontend.loop.yaml"));
    if (!target) throw new Error("Loop YAML buffer is unavailable");
    const model = registry.getModel(target.path);
    model.setValue(`${model.getValue()}\n# edited from Goal Loop\n`);
    await registry.save(target.path);
  });
  const edited = await page.evaluate(async () => {
    const backend = (window as unknown as {
      __WS_BACKEND__?: {
        listWorkstreams: () => Promise<Array<{ name: string; directory: string }>>;
        readFile: (path: string) => Promise<string>;
      };
    }).__WS_BACKEND__;
    if (!backend) throw new Error("Memory backend is unavailable");
    const workstream = (await backend.listWorkstreams()).find(
      (candidate) => candidate.name === "Goal Loop Demo",
    );
    if (!workstream) throw new Error("Goal Loop Demo workstream is unavailable");
    return backend.readFile(
      "/sessions/e2e-loop-session/files/loops/frontend.loop.yaml",
    );
  });
  expect(edited).toContain("# edited from Goal Loop");
  await page.locator('[data-testid="loop-tab-run"]').click();

  await expect(page.locator('[data-testid="loop-definition-frontend-loop"]')).toContainText(
    "Verification + Evaluator + Human approval",
  );
  await expect(page.locator('[data-testid="loop-definition-selected"]')).toContainText(
    "Frontend verification loop",
  );
  await page.locator('[data-testid="loop-run-selected"]').click();
  await expect(page.locator('[data-testid="running-loop-count"]')).toContainText(
    "1 running",
  );
  await expect(page.locator('[data-testid="loop-task-list"]')).not.toHaveAttribute(
    "open",
    "",
  );
  await page
    .locator('[data-testid="loop-task-list"] > summary')
    .click();
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toBeVisible();

  await page.locator('[data-testid="loop-pause"]').click();
  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Paused",
  );
  await page.locator('[data-testid="loop-resume"]').click();

  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Awaiting approval",
    { timeout: 5_000 },
  );
  await expect(page.locator('[data-testid="pending-loop-approval-count"]')).toContainText(
    "1 approval",
  );
  await page.getByLabel("Human review feedback").fill("Add one final edge case");
  await page.locator('[data-testid="loop-approval-revise"]').click();
  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Awaiting approval",
    { timeout: 5_000 },
  );
  await page.locator('[data-testid="loop-approval-approve"]').click();
  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Orchestrating",
  );
  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText("Completed");
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toContainText(
    "accepted",
  );
  await expect(page.locator('[data-testid="loop-event-timeline"]')).not.toHaveAttribute(
    "open",
    "",
  );
  await page.locator('summary', { hasText: "Details" }).first().click();
  await expect(
    page.locator('[data-testid^="loop-verification-"]').first(),
  ).toContainText("passed");
  await expect(
    page.locator('[data-testid^="loop-evaluation-"]').first(),
  ).toContainText("accepted");
  await expect(page.locator('[data-testid="running-loop-count"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="pending-loop-approval-count"]')).toHaveCount(0);
});

test("kills an active loop and preserves an interrupted task", async ({ page }) => {
  await page.locator('[data-testid="loop-run-selected"]').click();
  await page.locator('[data-testid="loop-task-list"] > summary').click();
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toBeVisible();

  await page.locator('[data-testid="loop-kill"]').click();

  await expect(page.locator('[data-testid="loop-run-state"]')).toContainText(
    "Killed",
  );
  await expect(page.locator('article[data-testid^="loop-task-"]').first()).toContainText(
    "interrupted",
  );
});
