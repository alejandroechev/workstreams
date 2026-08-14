import { expect, test } from "@playwright/test";

async function openNearBottom(page: import("@playwright/test").Page) {
  await expect(page.locator('[data-testid="file-tree-item"]').first()).toBeVisible();
  const viewport = page.viewportSize()!;
  await page.mouse.click(viewport.width - 20, viewport.height - 20, { button: "right" });
  return page.locator('[data-testid="file-context-menu"]');
}

test.describe("Repo Explorer context menu", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?harness=repo-context-menu", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="harness-case"]')).toBeVisible();
  });

  test("stays inside the viewport when opened near the bottom-right", async ({ page }) => {
    const menu = await openNearBottom(page);
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - 8 + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 8 + 1);
  });

  test("closes on outside pointer and consumes Escape", async ({ page }) => {
    let menu = await openNearBottom(page);
    expect(await page.evaluate(
      () => (document.elementFromPoint(10, 10) as HTMLElement | null)?.dataset.testid,
    )).toBe("file-context-menu-backdrop");
    await page.mouse.click(10, 10);
    await expect(menu).toHaveCount(0);

    menu = await openNearBottom(page);
    const prevented = await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);
    await expect(menu).toHaveCount(0);
  });

  test("creates a file with the in-app name composer", async ({ page }) => {
    const menu = await openNearBottom(page);
    await menu.locator('[data-testid="ctx-new-file"]').click();
    await menu.locator('[data-testid="ctx-create-name"]').fill("created-on-mac.txt");
    await menu.locator('[data-testid="ctx-create-save"]').click();

    await expect(menu).toHaveCount(0);
    await expect(page.getByText(/created-on-mac\.txt$/)).toBeVisible();
  });
});
