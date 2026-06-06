/**
 * E2E tests for the workstream creation flow.
 * Vite dev server with VITE_E2E=1 (MemoryBackend + Tauri invoke shim).
 */
import { test, expect, type Page } from "@playwright/test";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    type Args = Record<string, unknown>;
    const handlers: Record<string, (a: Args) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      create_worktree: (a: Args) =>
        `C:\\worktrees\\${String((a.branchName as string) ?? "branch").replace(/[^a-z0-9-]/gi, "-")}`,
      detect_worktree_info: () => ({
        is_worktree: true,
        parent_repo_path: "C:\\repos\\demo",
        parent_repo_name: "demo",
        branch: "main",
        git_remote: null,
      }),
      get_copilot_sessions: () => [
        {
          session_id: "11111111-2222-3333-4444-555555555555",
          summary: "Existing demo session",
          cwd: "C:\\repos\\demo",
          updated_at: new Date().toISOString(),
          turn_count: 3,
        },
      ],
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
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
    (window as unknown as { __WS_INVOKE_LOG__: unknown[] }).__WS_INVOKE_LOG__ = [];
  });
}

async function openWsCreateForm(page: Page) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  // Select the seeded Demo project so base_repo/worktree have a directory.
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
}

async function readInvokeLog(page: Page): Promise<Array<{ cmd: string; args: Record<string, unknown> }>> {
  return page.evaluate(
    () =>
      (window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> })
        .__WS_INVOKE_LOG__ ?? [],
  );
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
});

test.describe("Workstream creation flow", () => {
  test("base_repo + new session creates a pinned session tile", async ({ page }) => {
    await openWsCreateForm(page);
    // Demo project auto-selects worktree; switch to base_repo
    await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
    await page.locator('[data-testid="ws-create-name"]').fill("Feature A");
    await page.locator('[data-testid="ws-create-submit"]').click();

    await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
    const item = page.locator('[data-testid="workstream-item"]', { hasText: "Feature A" });
    await expect(item).toBeVisible();
    await expect(page.locator('[data-testid^="tile-pinned-"]')).toBeVisible();
    await expect(page.locator('[data-testid^="tile-close-"]')).toHaveCount(0);
  });

  test("base_repo + existing session opens the SessionPicker after submit", async ({ page }) => {
    await openWsCreateForm(page);
    await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
    await page.locator('[data-testid="ws-create-name"]').fill("Feature B");
    await page.locator('[data-testid="ws-create-session-existing"] input').click();
    await page.locator('[data-testid="ws-create-submit"]').click();
    await expect(page.getByText("Existing demo session")).toBeVisible();
  });

  test("import_worktree allows both existing and new session", async ({ page }) => {
    await openWsCreateForm(page);
    await page.locator('[data-testid="ws-create-repo-import_worktree"] input').click();
    await expect(page.locator('[data-testid="ws-create-session-existing"] input')).toBeEnabled();
    await expect(page.locator('[data-testid="ws-create-session-new"] input')).toBeEnabled();
  });

  test("new worktree shows the branch field with the derived branch name", async ({ page }) => {
    await openWsCreateForm(page);
    await page.locator('[data-testid="ws-create-name"]').fill("Feature C");
    // Demo project → defaults to worktree already; explicitly click anyway
    await page.locator('[data-testid="ws-create-repo-worktree"] input').click();
    await expect(page.locator('[data-testid="ws-create-branch"]')).toBeVisible();
    const branch = await page.locator('[data-testid="ws-create-branch"]').inputValue();
    expect(branch).toBe("alejandroe/feature-c");
  });

  test("new worktree submit invokes create_worktree with the derived branch", async ({ page }) => {
    await openWsCreateForm(page);
    await page.locator('[data-testid="ws-create-name"]').fill("Feature D");
    await page.locator('[data-testid="ws-create-repo-worktree"] input').click();
    await page.locator('[data-testid="ws-create-submit"]').click();
    await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
    // The flow should have invoked create_worktree with the right args
    const log = await readInvokeLog(page);
    const call = log.find((e) => e.cmd === "create_worktree");
    expect(call, "create_worktree should be invoked").toBeTruthy();
    expect(call!.args.projectDirectory).toBe("C:\\repos\\demo");
    expect(call!.args.branchName).toBe("alejandroe/feature-d");
    // Pinned tile is present with the cwd from create_worktree's return value
    await expect(page.locator('[data-testid^="tile-pinned-"]')).toBeVisible();
  });

  test("pinned tile cannot be closed (X hidden)", async ({ page }) => {
    await openWsCreateForm(page);
    await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
    await page.locator('[data-testid="ws-create-name"]').fill("Pinned Test");
    await page.locator('[data-testid="ws-create-submit"]').click();
    await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="tile-pinned-"]')).toBeVisible();
    await expect(page.locator('[data-testid^="tile-close-"]')).toHaveCount(0);
  });

  test("new workstreams accumulate and remain visible in the sidebar", async ({ page }) => {
    await openWsCreateForm(page);
    await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
    await page.locator('[data-testid="ws-create-name"]').fill("First");
    await page.locator('[data-testid="ws-create-submit"]').click();
    await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);

    await openWsCreateForm(page);
    await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
    await page.locator('[data-testid="ws-create-name"]').fill("Second");
    await page.locator('[data-testid="ws-create-submit"]').click();
    await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);

    await expect(page.locator('[data-testid="workstream-item"]', { hasText: "First" })).toBeVisible();
    await expect(page.locator('[data-testid="workstream-item"]', { hasText: "Second" })).toBeVisible();
  });

  test("invoke log records get_setting on app load (shim active)", async ({ page }) => {
    const log = await readInvokeLog(page);
    expect(log.some((e) => e.cmd === "get_setting")).toBe(true);
  });
});
