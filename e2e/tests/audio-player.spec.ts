/**
 * E2E for the Repo Explorer audio playback feature.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(__dirname, "..", "fixtures", "tiny.wav");

async function configureInvokeHandlers(page: Page, audioB64: string) {
  await page.addInitScript(({ b64 }) => {
    type Args = Record<string, unknown>;
    const handlers: Record<string, (a: Args) => unknown> = {
      get_setting: () => null,
      set_setting: () => null,
      read_file_base64: () => b64,
      watch_directory: () => null,
      unwatch_directory: () => null,
      list_git_hooks: () => [],
      git_current_branch: () => "main",
      cancel_searches: () => null,
      search_files: () => [],
      search_in_files: () => [],
    };
    (window as unknown as { __WS_INVOKE_HANDLERS__: typeof handlers }).__WS_INVOKE_HANDLERS__ = handlers;
  }, { b64: audioB64 });
}

async function seedAudioFile(page: Page) {
  await page.evaluate(() => {
    const b = (window as unknown as {
      __WS_BACKEND__: { seedFile?: (path: string, content: string) => void };
    }).__WS_BACKEND__;
    b.seedFile?.("/audio/tiny.wav", "x".repeat(3244));
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
  const audioB64 = fs.readFileSync(FIXTURE_PATH).toString("base64");
  await configureInvokeHandlers(page, audioB64);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await seedAudioFile(page);
});

test.describe("Repo Explorer audio playback", () => {
  test("opening a .wav file renders the AudioPlayer with a non-empty src", async ({ page }) => {
    await ensureWorkstreamWithExplorer(page, "AudioTestWS");
    await page.getByText("tiny.wav").first().click();

    await expect(page.locator('[data-testid="audio-player"]')).toBeVisible();
    const audio = page.locator('[data-testid="audio-element"]');
    await expect(audio).toBeVisible();
    const src = await audio.getAttribute("src");
    expect(src).toBeTruthy();
    expect(src!.startsWith("blob:")).toBe(true);

    await expect(page.locator('[data-testid="audio-size"]')).toBeVisible();
    await expect(page.locator('[data-testid="audio-speed-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="audio-loop-btn"]')).toBeVisible();
  });

  test("speed cycle and loop toggle work end-to-end", async ({ page }) => {
    await ensureWorkstreamWithExplorer(page, "AudioCtrlWS");
    await page.getByText("tiny.wav").first().click();
    await expect(page.locator('[data-testid="audio-player"]')).toBeVisible();

    const speedBtn = page.locator('[data-testid="audio-speed-btn"]');
    await expect(speedBtn).toContainText("1x");
    await speedBtn.click();
    await expect(speedBtn).toContainText("1.5x");
    await speedBtn.click();
    await expect(speedBtn).toContainText("2x");

    const loopBtn = page.locator('[data-testid="audio-loop-btn"]');
    await expect(loopBtn).toHaveAttribute("aria-pressed", "false");
    await loopBtn.click();
    await expect(loopBtn).toHaveAttribute("aria-pressed", "true");
  });
});
