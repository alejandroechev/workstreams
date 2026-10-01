/**
 * Repo Explorer diff "Code comments" filter over real Monaco.
 *
 * Comment detection and line ranges are pure functions with unit tests. Only a
 * real browser can show that Monaco actually collapses everything but the
 * changed comment lines, that the old-line column is hidden meanwhile, and
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
  // The modified side only: in a unified diff the original editor still keeps
  // its (clipped) text in the DOM.
  page.locator(".monaco-diff-editor .modified-in-monaco-diff-editor .view-line", { hasText: text });

test("file rows lead with the name and keep the full directory reachable by scrolling", async ({ page }) => {
  await openCase(page);
  const panel = page.getByTestId("diff-file-list");
  const row = page.getByTestId("diff-file-item").filter({ hasText: "uncommented.ts" });
  const dir = row.getByTestId("diff-file-dir");
  await expect(row.getByTestId("diff-file-name")).toHaveText("uncommented.ts");
  await expect(dir).toHaveText("- src/features/deeply/nested/folder");
  // The name is readable without scrolling the list sideways.
  const name = await row.getByTestId("diff-file-name").boundingBox();
  const box = await panel.boundingBox();
  expect(name!.x + name!.width).toBeLessThanOrEqual(box!.x + box!.width);
  // The directory is never cut short: it overflows the panel instead, and
  // scrolling the list sideways brings its end into view.
  expect(await dir.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await panel.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await panel.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  const end = await dir.boundingBox();
  const scrolled = await panel.boundingBox();
  expect(end!.x + end!.width).toBeLessThanOrEqual(scrolled!.x + scrolled!.width + 1);
});

test("code comments narrows the files and collapses the diff to them, then restores it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCase(page);

  await page.locator(`[data-testid="diff-file-item"][title="src/commented.ts"]`).click();
  await expect(renderedLine(page, "farChange")).toBeVisible();

  await page.getByTestId("repo-explorer-diff-code-comments").click();

  await expect(page.getByTestId("diff-file-item")).toHaveCount(1);
  await expect(page.getByTestId("diff-file-name")).toHaveText("commented.ts");
  await expect(page.getByTestId("diff-file-comment-count")).toHaveText("1");
  await expect(renderedLine(page, "Explains why line 30 exists")).toBeVisible();
  // Code changes and unchanged code are collapsed away.
  await expect(renderedLine(page, "farChange")).toHaveCount(0);
  await expect(renderedLine(page, "const line29 = 29;")).toHaveCount(0);
  await expect(renderedLine(page, "const line31 = 31;")).toHaveCount(0);
  // The old-line column cannot collapse in step with it, so it is hidden.
  const oldNumbers = page.locator(".monaco-diff-editor .original-in-monaco-diff-editor .line-numbers");
  await expect(oldNumbers).toHaveCount(0);
  await page.screenshot({ path: "test-results/diff-code-comments-on.png" });

  await page.getByTestId("repo-explorer-diff-code-comments").click();
  await expect(page.getByTestId("diff-file-item")).toHaveCount(2);
  await expect(renderedLine(page, "farChange")).toBeVisible();
  await expect(oldNumbers.first()).toBeVisible();

  expect(errors).toEqual([]);
});
