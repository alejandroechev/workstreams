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

  test("multi-reply comment thread does not overlap the following code lines", async ({ page }) => {
    await openCase(page, "comment-zone");
    // The harness thread has a root + two replies; its view zone must reserve
    // enough vertical space that no code line renders on top of it (regression
    // guard for the height under-estimate that put replies over the code).
    await expect(page.locator('[data-testid="comment-entry-a2"]')).toContainText("looks good");

    // Poll until the async height-measurement pass has settled (rAF), then
    // assert no code line overlaps the zone.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const zone = document.querySelector('[data-testid="comment-zone-c1"]');
            if (!zone) return ["<no-zone>"];
            const z = zone.getBoundingClientRect();
            return [...document.querySelectorAll(".view-line")]
              .map((l) => ({ t: (l.textContent || "").trim(), r: l.getBoundingClientRect() }))
              .filter((l) => l.t.length > 0)
              // A code line overlaps if its vertical span intersects the zone's.
              .filter((l) => l.r.bottom > z.top + 2 && l.r.top < z.bottom - 2)
              .map((l) => l.t);
          }),
        { timeout: 5_000 },
      )
      .toEqual([]);
  });

  test("Repo Explorer file-comment Reply button opens the composer and adds a threaded reply", async ({ page }) => {
    await openCase(page, "comment-zone");

    const reply = page.locator('[data-testid="comment-reply-c1"]');
    await expect(reply).toBeVisible();
    // Not occluded by a Monaco layer.
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-reply-c1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Reply button is occluded by a Monaco layer").toBe(false);

    await reply.click({ timeout: 5_000 });
    const composer = page.locator('[data-testid="comment-composer"]');
    await expect(composer).toBeVisible();
    await expect(composer).toContainText("Replying to comment");

    await page.locator('[data-testid="comment-composer-textarea"]').fill("Looks good, thanks!");
    await page.locator('[data-testid="comment-composer-save"]').click();

    // The new reviewer reply renders inside the same thread zone.
    await expect(
      page.locator('[data-testid="comment-zone-c1"]'),
    ).toContainText("Looks good, thanks!");
  });

  test("Repo Explorer file-comment Copy button is present and clickable", async ({ page }) => {
    await openCase(page, "comment-zone");
    const copy = page.locator('[data-testid="comment-copy-c1"]');
    await expect(copy).toBeVisible();
    const covered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="comment-copy-c1"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !(top && (el === top || el.contains(top) || top.contains(el)));
    });
    expect(covered, "Copy button is occluded by a Monaco layer").toBe(false);
    // Clicking must not throw (clipboard write is best-effort in the shim).
    await copy.click({ timeout: 5_000 });
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

  test("Repo Explorer Unstaged diff renders editable file-comment threads", async ({ page }) => {
    await page.goto("/?harness=diff-comment-zone", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
    await page.locator('[data-testid="repo-explorer-tab-diff"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll(".monaco-diff-editor").length > 0,
      null,
      { timeout: 30_000 },
    );

    const toggle = page.locator('[data-testid="repo-explorer-diff-comments-toggle"]');
    await expect(toggle).toBeEnabled();
    await toggle.click();

    const edit = page.locator('[data-testid^="comment-edit-"]');
    await expect(edit).toBeVisible();
    await expect(page.locator('[data-testid^="comment-zone-"]')).toContainText(
      "This comment came from the working file.",
    );
    await edit.click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="comment-composer"]')).toBeVisible();
  });

  test("Repo Explorer selects a custom target branch for historical diff", async ({ page }) => {
    await page.goto("/?harness=diff-comment-zone", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
    await page.locator('[data-testid="repo-explorer-tab-diff"]').click();

    const picker = page.getByLabel("Custom diff target branch");
    await expect(picker).toContainText("release/1.0");
    await picker.selectOption("release/1.0");

    await expect(picker).toHaveValue("release/1.0");
    await expect(page.locator('[data-testid="diff-current-file"]')).toHaveText("example.ts");
    await expect(page.getByLabel("Save diff edit")).toHaveCount(0);
    await expect(
      page.locator('[data-testid="repo-explorer-diff-comments-toggle"]'),
    ).toHaveCount(0);
  });
});
