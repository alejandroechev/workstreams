/**
 * Repo Explorer diff "Comments only" filter over real Monaco.
 *
 * The line ranges are a pure function with unit tests. Only a real browser can
 * show that Monaco actually collapses the uncommented code while the comment's
 * own view zone survives, that the old-line column is hidden meanwhile, and
 * that it all comes back when the filter is switched off.
 */
import { test, expect, type Page } from "@playwright/test";

async function openCase(page: Page) {
  await page.goto("/?harness=diff-comments-only", { waitUntil: "networkidle" });
  await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
  await page.locator('[data-testid="repo-explorer-tab-diff"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll(".monaco-diff-editor").length > 0,
    null,
    { timeout: 30_000 },
  );
}

const renderedLine = (page: Page, text: string) =>
  page.locator(".monaco-diff-editor .view-line", { hasText: text });

test("file rows lead with a fully visible file name", async ({ page }) => {
  await openCase(page);
  const panel = page.getByTestId("diff-file-list");
  const row = page.getByTestId("diff-file-item").filter({ hasText: "uncommented.ts" });
  await expect(row.getByTestId("diff-file-name")).toHaveText("uncommented.ts");
  await expect(row.getByTestId("diff-file-dir")).toHaveText("- src/features/deeply/nested/folder");
  const name = await row.getByTestId("diff-file-name").boundingBox();
  const box = await panel.boundingBox();
  // The name must be readable without scrolling the list sideways.
  expect(name!.x + name!.width).toBeLessThanOrEqual(box!.x + box!.width);
  const scrolls = await panel.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrolls).toBe(false);
});

test("comments only narrows the files and collapses uncommented code, then restores it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCase(page);

  await page.getByTestId("diff-file-item").filter({ hasText: "commented.ts" }).last().click();
  await expect(renderedLine(page, "far-change")).toBeVisible();

  await page.getByTestId("repo-explorer-diff-comments-only").click();

  await expect(page.getByTestId("diff-file-item")).toHaveCount(1);
  await expect(page.getByTestId("diff-file-name")).toHaveText("commented.ts");
  await expect(page.getByTestId("diff-file-comment-count")).toHaveText("1");
  await expect(page.locator('[data-testid^="comment-zone-"]')).toContainText("Why 3000?");
  await expect(renderedLine(page, "near-comment")).toBeVisible();
  // The uncommented change is collapsed away.
  await expect(renderedLine(page, "far-change")).toHaveCount(0);
  // The old-line column cannot collapse in step with it, so it is hidden.
  const oldNumbers = page.locator(".monaco-diff-editor .original-in-monaco-diff-editor .line-numbers");
  await expect(oldNumbers).toHaveCount(0);
  await page.screenshot({ path: "test-results/diff-comments-only-on.png" });

  await page.getByTestId("repo-explorer-diff-comments-only").click();
  await expect(page.getByTestId("diff-file-item")).toHaveCount(2);
  await expect(renderedLine(page, "far-change")).toBeVisible();
  await expect(oldNumbers.first()).toBeVisible();
  await page.screenshot({ path: "test-results/diff-comments-only-off.png" });

  expect(errors).toEqual([]);
});
