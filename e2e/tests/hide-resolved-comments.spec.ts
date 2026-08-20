/**
 * Hide-resolved filter over real Monaco view zones.
 *
 * The filter itself is a pure function with unit tests. What only a real
 * browser can show is whether the hidden thread's **view zone is torn down**:
 * a stale zone would leave the resolved comment on screen, or leave an empty
 * gap in the code where it used to be.
 */
import { test, expect, type Page } from "@playwright/test";

async function openCase(page: Page) {
  await page.goto("/?harness=hide-resolved", { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
  await page.waitForFunction(
    () => document.querySelectorAll(".monaco-editor").length > 0,
    null,
    { timeout: 30_000 },
  );
}

test("hiding resolved removes its view zone and keeps open ones", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCase(page);

  await expect(page.locator('[data-testid="comment-entry-open1"]')).toBeVisible();
  await expect(page.locator('[data-testid="comment-entry-done1"]')).toBeVisible();

  await page.locator('[data-testid="hide-resolved-toggle"]').click();

  // The resolved thread and its reply must both be gone from the DOM, not
  // merely hidden behind a stale zone.
  await expect(page.locator('[data-testid="comment-entry-done1"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="comment-entry-done1reply"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="comment-entry-open1"]')).toBeVisible();

  expect(errors).toEqual([]);
});

test("showing them again brings the thread back intact", async ({ page }) => {
  await openCase(page);

  await page.locator('[data-testid="hide-resolved-toggle"]').click();
  await expect(page.locator('[data-testid="comment-entry-done1"]')).toHaveCount(0);

  await page.locator('[data-testid="hide-resolved-toggle"]').click();
  await expect(page.locator('[data-testid="comment-entry-done1"]')).toBeVisible();
  // The reply must come back with its root, not be lost on the round trip.
  await expect(page.locator('[data-testid="comment-entry-done1reply"]')).toBeVisible();
});

test("no code line is left overlapping where the hidden zone used to be", async ({ page }) => {
  // A view zone that is removed without the editor re-laying out would leave a
  // gap, or a line rendered on top of the remaining zone.
  await openCase(page);
  await page.locator('[data-testid="hide-resolved-toggle"]').click();
  await expect(page.locator('[data-testid="comment-entry-done1"]')).toHaveCount(0);

  const overlaps = await page.evaluate(() => {
    const zone = document.querySelector('[data-testid="comment-zone-open1"]');
    if (!zone) return ["<no-zone>"];
    const z = zone.getBoundingClientRect();
    return [...document.querySelectorAll(".view-line")]
      .map((l) => ({ t: (l.textContent || "").trim(), r: l.getBoundingClientRect() }))
      .filter((l) => l.t && l.r.height > 0 && l.r.top < z.bottom - 1 && l.r.bottom > z.top + 1)
      .map((l) => l.t);
  });
  expect(overlaps).toEqual([]);
});
