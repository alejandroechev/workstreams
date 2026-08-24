/**
 * Deleting a thread from the Comments tab list, in real Monaco.
 *
 * The delete button sits inside a row that itself navigates, which is exactly
 * the shape that has bitten this codebase before: without stopPropagation the
 * click also opens the file being deleted from. jsdom cannot show that the
 * button is reachable rather than merely present, either.
 */
import { test, expect, type Page } from "@playwright/test";

async function openCase(page: Page) {
  await page.goto("/?harness=comments-navigation", { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
}

test("a thread can be deleted straight from the list", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCase(page);

  const row = page.locator('[data-testid="comments-thread-near-top"]');
  await expect(row).toBeVisible();

  const del = page.locator('[data-testid="comments-delete-near-top"]');
  // Reachable, not merely present: the row is dense and the button is small.
  const covered = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="comments-delete-near-top"]');
    if (!el) return true;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2),
    );
    return !(top && (el === top || el.contains(top) || top.contains(el)));
  });
  expect(covered, "delete button is occluded").toBe(false);

  await del.click({ timeout: 5_000 });
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("deleting does not also navigate to the file", async ({ page }) => {
  await openCase(page);

  // Nothing is open yet; deleting must not open anything.
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await page.locator('[data-testid="comments-delete-near-top"]').click();

  await expect(page.locator('[data-testid="comments-thread-near-top"]')).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
});

test("deleting a root takes its replies with it", async ({ page }) => {
  await openCase(page);

  const root = page.locator('[data-testid="comments-thread-far-down"]');
  await expect(root).toContainText("1");
  await expect(page.locator('[data-testid="comments-delete-far-down"]')).toHaveAttribute(
    "title",
    /1 repl/,
  );

  await page.locator('[data-testid="comments-delete-far-down"]').click();
  await expect(root).toHaveCount(0);
  // The reply had no row of its own, and must not gain one by being orphaned.
  await expect(page.locator('[data-testid="comments-thread-far-down-reply"]')).toHaveCount(0);
});

test("deleting the open thread clears the editor pane", async ({ page }) => {
  await openCase(page);

  await page.locator('[data-testid="comments-thread-near-top"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".monaco-editor").length > 0, null, {
    timeout: 30_000,
  });

  await page.locator('[data-testid="comments-delete-near-top"]').click();
  // Leaving the file up would show a comment that no longer exists.
  await expect(page.locator('[data-testid="comments-thread-near-top"]')).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
});
