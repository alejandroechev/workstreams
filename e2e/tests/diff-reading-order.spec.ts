/**
 * Repo Explorer diff sorted by an agent-recommended reading order (ADR 032),
 * against the real tile in the browser build. Storage, validation and
 * fingerprints are proven natively (Rust unit + CLI scenario); this covers
 * what the reviewer sees.
 */
import { test, expect, type Page } from "@playwright/test";

const ORDER = [
  "src/domain/model.ts",
  "src/domain/__tests__/model.test.ts",
  "src/ui/View.tsx",
  "src/ui/__tests__/View.test.tsx",
  "README.md",
];

async function open(page: Page, order: string) {
  await page.goto(`/?harness=diff-reading-order&order=${order}`, { waitUntil: "networkidle" });
  await expect(page.getByTestId("harness-case")).toBeVisible();
  await page.getByTestId("repo-explorer-tab-diff").click();
  await expect(page.getByTestId("diff-file-item").first()).toBeVisible();
}

const rowPaths = (page: Page) =>
  page.getByTestId("diff-file-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("title")));
const positions = (page: Page) =>
  page.getByTestId("diff-file-item").evaluateAll((rows) =>
    rows.map((row) => row.querySelector('[data-testid="diff-file-position"]')?.textContent ?? null),
  );

test("AT-7: opens on the recommended order; Name sorts by path; the choice is not remembered", async ({ page }) => {
  await open(page, "current");
  await expect(page.getByTestId("diff-sort-recommended")).toHaveAttribute("aria-pressed", "true");
  expect(await rowPaths(page)).toEqual(ORDER);
  await expect(page.getByTestId("diff-current-file")).toHaveText("model.ts");

  await page.getByTestId("diff-sort-name").click();
  expect(await rowPaths(page)).toEqual([...ORDER].sort());
  expect(await positions(page)).toEqual(ORDER.map(() => null));

  await page.getByText("Last Commit").click();
  await page.getByText("Unstaged").click();
  await expect(page.getByTestId("diff-sort-recommended")).toHaveAttribute("aria-pressed", "true");
  expect(await rowPaths(page)).toEqual(ORDER);
  await page.screenshot({ path: "test-results/diff-reading-order-current.png" });
});

test("AT-7 / AT-11: with no order, Name is the only sort and the hint names the prompt", async ({ page }) => {
  await open(page, "none");
  await expect(page.getByTestId("diff-sort-name")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("diff-sort-recommended")).toBeDisabled();
  const hint = page.getByTestId("diff-order-hint");
  await expect(hint).toContainText("order my diff");
  // Inline in the diff toolbar, not a banner, and gone from the Files tab.
  const inToolbar = await hint.evaluate((el) => {
    const toolbar = document.querySelector('[data-testid="diff-sort-name"]')?.closest("div[style]")?.parentElement;
    return Boolean(toolbar?.contains(el));
  });
  expect(inToolbar).toBe(true);
  await page.getByTestId("repo-explorer-tab-files").click();
  await expect(page.getByTestId("diff-order-hint")).toHaveCount(0);
});

test("AT-8: rows are numbered and the Code comments filter keeps their numbers", async ({ page }) => {
  await open(page, "current");
  expect(await positions(page)).toEqual(["1", "2", "3", "4", "5"]);
  await page.getByTestId("repo-explorer-diff-code-comments").click();
  await expect(page.getByTestId("diff-file-item")).toHaveCount(2);
  expect(await positions(page)).toEqual(["2", "4"]);
});

test("AT-9: content drift keeps the order with a subtle marker, not the stale chip", async ({ page }) => {
  await open(page, "content_changed");
  expect(await rowPaths(page)).toEqual(ORDER);
  await expect(page.getByTestId("diff-order-edited")).toHaveAttribute("title", /content has changed/i);
  await expect(page.getByTestId("diff-order-stale")).toHaveCount(0);
});

test("AT-10: file drift degrades the order and shows the stale chip", async ({ page }) => {
  await open(page, "files_changed");
  expect(await rowPaths(page)).toEqual([
    "src/domain/model.ts",
    "src/domain/__tests__/model.test.ts",
    "src/ui/__tests__/View.test.tsx",
    "README.md",
    "src/ui/0-added.tsx",
  ]);
  const stale = page.getByTestId("diff-order-stale");
  await expect(stale).toHaveText(/stale/i);
  await expect(stale).toHaveAttribute("title", /added to or removed[\s\S]*order my diff/i);
  await page.screenshot({ path: "test-results/diff-reading-order-stale.png" });
});
