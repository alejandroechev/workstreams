/**
 * Resolve/Reopen through a real async round-trip (bug reproduction).
 *
 * The pre-existing `comment-zone` case flips state synchronously inside the
 * callback, which is not what the app does: the tile awaits a backend call and
 * only then sets state, while the surrounding component keeps re-rendering and
 * rebuilding view zones. This spec drives that shape.
 */
import { test, expect, type Page } from "@playwright/test";

async function openCase(page: Page, id: string) {
  await page.goto(`/?harness=${id}`, { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
  await page.waitForFunction(
    () => document.querySelectorAll(".monaco-editor").length > 0,
    null,
    { timeout: 30_000 },
  );
}

test("Resolve survives an async backend hop and a re-rendering parent", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCase(page, "async-resolve");

  await page.locator('[data-testid="comment-resolve-c1"]').click({ timeout: 5_000 });

  // The flip must land and STAY landed: a zone rebuilt from stale state would
  // revert the button moments later.
  await expect(page.locator('[data-testid="comment-reopen-c1"]')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(600);
  await expect(page.locator('[data-testid="comment-reopen-c1"]')).toBeVisible();
  await expect(page.locator('[data-testid="comment-resolve-c1"]')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("Reopen flips it back", async ({ page }) => {
  await openCase(page, "async-resolve");

  await page.locator('[data-testid="comment-resolve-c1"]').click({ timeout: 5_000 });
  await expect(page.locator('[data-testid="comment-reopen-c1"]')).toBeVisible({ timeout: 5_000 });

  await page.locator('[data-testid="comment-reopen-c1"]').click({ timeout: 5_000 });
  await expect(page.locator('[data-testid="comment-resolve-c1"]')).toBeVisible({ timeout: 5_000 });
});
