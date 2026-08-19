/**
 * E2E: per-repo Copilot command override.
 *
 * Sets a project's Copilot command via the project edit modal, then creates a
 * workstream in that project and asserts the session spawn used the override
 * (vs. the global command when no override is set). Runs on the VITE_E2E dev
 * server (MemoryBackend + Tauri invoke shim + invoke log).
 */
import { test, expect, type Page } from "@playwright/test";

const GLOBAL_DEFAULT = "agency copilot --yolo";

async function configureInvokeHandlers(page: Page) {
  await page.addInitScript(() => {
    type Args = Record<string, unknown>;
    const handlers: Record<string, (a: Args) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      detect_worktree_info: () => ({
        is_worktree: true,
        parent_repo_path: "C:\\repos\\demo",
        parent_repo_name: "demo",
        branch: "main",
        git_remote: null,
      }),
      spawn_terminal: () => null,
      spawn_copilot_session: () => null,
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

async function readInvokeLog(page: Page): Promise<Array<{ cmd: string; args: Record<string, unknown> }>> {
  return page.evaluate(
    () =>
      (window as unknown as { __WS_INVOKE_LOG__?: Array<{ cmd: string; args: Record<string, unknown> }> })
        .__WS_INVOKE_LOG__ ?? [],
  );
}

async function createBaseRepoWorkstreamInDemo(page: Page, name: string) {
  await page.locator('[data-testid="new-workstream-button"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toBeVisible();
  await page.locator('[data-testid="ws-create-project"]').selectOption({ label: "Demo" });
  await page.locator('[data-testid="ws-create-repo-base_repo"] input').click();
  await page.locator('[data-testid="ws-create-name"]').fill(name);
  await page.locator('[data-testid="ws-create-submit"]').click();
  await expect(page.locator('[data-testid="ws-create-form"]')).toHaveCount(0);
}

async function spawnCommand(page: Page): Promise<string | null> {
  const log = await readInvokeLog(page);
  const call = log.find((e) => e.cmd === "spawn_copilot_session");
  return call ? ((call.args.command as string | null) ?? null) : null;
}

test.beforeEach(async ({ page }) => {
  await configureInvokeHandlers(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
});

test.describe("Per-repo Copilot command override", () => {
  test("a workstream in a project WITHOUT an override uses the global command", async ({ page }) => {
    await createBaseRepoWorkstreamInDemo(page, "Inherit WS");
    expect(await spawnCommand(page)).toBe(GLOBAL_DEFAULT);
  });

  test("setting a project's command makes its workstreams spawn with the override", async ({ page }) => {
    // Repo editing moved out of the sidebar body into the Repo Manager.
    await page.locator('[data-testid="repo-manager-button"]').click();
    await page.locator('[data-testid^="repo-manager-row-"]').first().click();
    const field = page.locator('[data-testid="repo-manager-command"]');
    await expect(field).toBeVisible();
    // Inherits by default (blank) with the global shown as placeholder.
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("placeholder", GLOBAL_DEFAULT);

    await field.fill("e2e-copilot --marker");
    await page.locator('[data-testid="repo-manager-save"]').click();
    await page.locator('[data-testid="repo-manager-close"]').click();

    await createBaseRepoWorkstreamInDemo(page, "Override WS");
    expect(await spawnCommand(page)).toBe("e2e-copilot --marker");
  });
});
