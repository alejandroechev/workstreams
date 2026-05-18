/**
 * E2E for the PID-based session correlation fix:
 *  - For "existing session" the WS is NOT created until the user picks
 *    (or skips creation entirely on cancel by reopening the form).
 *  - For "new session" the picker never opens; the WS is created and
 *    `spawn_copilot_session` is invoked (not `spawn_terminal` with
 *    agency.exe as the command).
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
      detect_worktree_info: () => ({ is_worktree: true, parent_repo_path: "C:\\repos\\demo", parent_repo_name: "demo", branch: "main", git_remote: null }),
      get_copilot_sessions: () => [
        { session_id: "aaaaaaaa-1111-2222-3333-444444444444", summary: "Existing session A", cwd: "C:\\repos\\demo", updated_at: new Date().toISOString(), turn_count: 1 },
      ],
      spawn_terminal: () => 5555,
      spawn_copilot_session: () => 9999,
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

async function waitForInvoke(page: Page, cmd: string, timeoutMs = 4000): Promise<{ cmd: string; args: Record<string, unknown> } | undefined> {
  return page.waitForFunction(
    (c) => {
      const log = (window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> }).__WS_INVOKE_LOG__ ?? [];
      return log.find((e) => e.cmd === c) ?? null;
    },
    cmd,
    { timeout: timeoutMs },
  ).then((h) => h.jsonValue() as Promise<{ cmd: string; args: Record<string, unknown> } | undefined>);
}

async function readInvokeLog(page: Page) {
  return page.evaluate(() => (window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> }).__WS_INVOKE_LOG__ ?? []);
}

async function openWsCreate(page: Page) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
});

test.describe("Session correlation fix", () => {
  test("new session → spawn_copilot_session is invoked (not spawn_terminal-with-agency)", async ({ page }) => {
    await openWsCreate(page);
    await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
    await page.locator('[data-testid="ws-create-name"]').fill("FreshFeature");
    await page.locator('[data-testid="ws-create-submit"]').click();
    await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);

    const spawnCopilot = await waitForInvoke(page, "spawn_copilot_session");
    const log = await readInvokeLog(page);
    const spawnTerminalAgency = log.find(
      (e) => e.cmd === "spawn_terminal" && e.args.command === "agency.exe",
    );
    expect(spawnCopilot, "should call spawn_copilot_session").toBeTruthy();
    expect(spawnTerminalAgency, "should NOT call spawn_terminal with agency.exe").toBeFalsy();
    expect(spawnCopilot!.args.resumeSessionId).toBeNull();
  });

  test("existing session → WS is NOT created until pick", async ({ page }) => {
    await openWsCreate(page);
    await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
    await page.locator('[data-testid="ws-create-name"]').fill("DeferredCreate");
    await page.locator('[data-testid="ws-create-session-existing"] input').click();
    await page.locator('[data-testid="ws-create-submit"]').click();

    await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
    await expect(page.getByText("Existing session A")).toBeVisible();
    await expect(
      page.locator('[data-testid="workstream-item"]', { hasText: "DeferredCreate" }),
    ).toHaveCount(0);

    await page.getByText("Existing session A").click();
    await expect(
      page.locator('[data-testid="workstream-item"]', { hasText: "DeferredCreate" }),
    ).toBeVisible();

    const spawn = await waitForInvoke(page, "spawn_copilot_session");
    expect(spawn).toBeTruthy();
    expect(spawn!.args.resumeSessionId).toBe("aaaaaaaa-1111-2222-3333-444444444444");
  });

  test("existing session → cancel picker reopens the create form", async ({ page }) => {
    await openWsCreate(page);
    await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
    await page.locator('[data-testid="ws-create-name"]').fill("CancelledFlow");
    await page.locator('[data-testid="ws-create-session-existing"] input').click();
    await page.locator('[data-testid="ws-create-submit"]').click();

    // Picker visible, no WS yet
    await expect(page.getByText("Existing session A")).toBeVisible();
    // Press Escape to dismiss (Cancel button has only an "✕" glyph; Esc is reliable)
    await page.keyboard.press("Escape");

    // Form should be visible again, no WS created
    await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="workstream-item"]', { hasText: "CancelledFlow" }),
    ).toHaveCount(0);
  });
});
