/**
 * Real-Monaco stability gate for the Comments tab.
 *
 * Reproduces the reported bug class: selecting a comment caused the list to
 * flicker (drift badges appearing/disappearing) and the file to sit on
 * "Loading" forever. Root cause was an unstable `onSnapshotChange` identity
 * re-running FileEditorView's acquire effect in a loop.
 *
 * jsdom cannot see this; these assertions measure real DOM churn over time.
 */
import { test, expect, type Page } from "@playwright/test";

async function openCase(page: Page) {
  await page.goto("/?harness=comments-navigation", { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
}

/** Samples the panel's markup repeatedly; a loop makes these differ. */
async function panelIsStable(page: Page, samples = 6, gapMs = 120): Promise<boolean> {
  const seen: string[] = [];
  for (let i = 0; i < samples; i += 1) {
    seen.push(
      await page.evaluate(
        () => document.querySelector('[data-testid="comments-panel"]')?.innerHTML ?? "",
      ),
    );
    await page.waitForTimeout(gapMs);
  }
  return seen.every((s) => s === seen[0]);
}

test.describe("Comments tab stability", () => {
  test("selecting a drifted comment does not flicker the list", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openCase(page);

    // Drift badge is present before selection (no file loaded yet -> unknown),
    // so assert on the state AFTER the file content is known.
    await page.locator('[data-testid="comments-thread-drifted"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll(".monaco-editor").length > 0,
      null,
      { timeout: 30_000 },
    );

    // The drifted comment must end up badged, and STAY badged.
    const badge = page.locator('[data-testid="comments-drift-drifted"]');
    await expect(badge).toBeVisible({ timeout: 10_000 });

    expect(await panelIsStable(page)).toBe(true);
    await expect(badge).toBeVisible();
    // A fresh anchor must not be badged.
    await expect(page.locator('[data-testid="comments-drift-near-top"]')).toHaveCount(0);
    expect(errors).toEqual([]);

    await page.screenshot({ path: "test-results/comments-tab-drifted.png" });
  });

  test("the file actually finishes loading and renders code", async ({ page }) => {
    await openCase(page);
    await page.locator('[data-testid="comments-thread-far-down"]').click();

    // "Loading file then nothing" = view-lines never appear.
    await expect(page.locator(".view-lines")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="comment-zone-far-down"]')).toHaveAttribute(
      "data-focused",
      "true",
    );
    expect(await panelIsStable(page)).toBe(true);
  });

  test("switching between files stays stable and keeps the list", async ({ page }) => {
    await openCase(page);

    await page.locator('[data-testid="comments-thread-near-top"]').click();
    await expect(page.locator(".view-lines")).toBeVisible({ timeout: 15_000 });

    // Cross-file switch remounts the editor — the loop was worst here.
    await page.locator('[data-testid="comments-thread-other-file"]').click();
    await expect(page.locator('[data-testid="comment-zone-other-file"]')).toBeVisible({
      timeout: 15_000,
    });

    expect(await panelIsStable(page)).toBe(true);
    // The navigation pane must survive the switch.
    await expect(page.locator('[data-testid="comments-thread-near-top"]')).toBeVisible();
    await page.screenshot({ path: "test-results/comments-tab-switched.png" });
  });
});
