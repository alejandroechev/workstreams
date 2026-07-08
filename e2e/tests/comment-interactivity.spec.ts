/**
 * Inline-comment interactivity (regression gate).
 *
 * Reproduces the class of bug that jsdom unit tests cannot see: buttons inside
 * Monaco **view zones** were unclickable because the text layer (`.view-lines`)
 * painted on top of the zone DOM. These specs drive the isolated harness routes
 * (`?harness=<case>`) with REAL Monaco and assert a real click produces a state
 * change — so the fix can't silently regress.
 *
 * Uses the same VITE_E2E dev server as the other e2e specs (see
 * playwright.config.ts webServer).
 */
import { test, expect, type Page } from "@playwright/test";

async function openCase(page: Page, id: string) {
  await page.goto(`/?harness=${id}`, { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
  // Real Monaco must mount (the whole point — not a jsdom mock).
  await page.waitForFunction(
    () => document.querySelectorAll(".monaco-editor").length > 0,
    null,
    { timeout: 30_000 },
  );
}

test.describe("inline comment interactivity", () => {
  test("Repo Explorer file-comment Edit button is clickable and opens the composer", async ({ page }) => {
    await openCase(page, "comment-zone");

    const edit = page.locator('[data-testid="comment-edit-c1"]');
    await expect(edit).toBeVisible();

    // The button center must be the top element (not occluded by a Monaco layer).
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-edit-c1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Edit button is occluded by a Monaco layer").toBe(false);

    // A real click (Playwright fails if occluded) must open the inline composer.
    await edit.click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="comment-composer"]')).toBeVisible();
  });

  test("Repo Explorer file-comment renders the agent reply and Resolve flips the status", async ({ page }) => {
    await openCase(page, "comment-zone");

    // The threaded agent reply renders inside the same view zone as the note.
    await expect(page.locator('[data-testid="comment-entry-a1"]')).toBeVisible();
    await expect(page.locator('[data-testid="comment-entry-a1"]')).toContainText("Renamed");

    // Resolve is the reviewer's own note action; clicking it must not be
    // occluded and must flip the reviewer note's status to resolved (which
    // swaps the button to Reopen).
    const resolve = page.locator('[data-testid="comment-resolve-c1"]');
    await expect(resolve).toBeVisible();
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-resolve-c1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Resolve button is occluded by a Monaco layer").toBe(false);

    await resolve.click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="comment-reopen-c1"]')).toBeVisible();
  });

  test("Code Review thread Resolve button is clickable and flips the status", async ({ page }) => {
    await openCase(page, "review-thread");

    const resolve = page.locator('[data-testid="resolve"]');
    await expect(resolve).toBeVisible();

    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="resolve"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Resolve button is occluded by a Monaco layer").toBe(false);

    await resolve.click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="thread-status"]').first()).toHaveText("Resolved");
  });
});
