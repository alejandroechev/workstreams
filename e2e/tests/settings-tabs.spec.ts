/**
 * Settings is split into one tab per section, so the modal stays a fixed,
 * window-bounded size however much a section holds.
 */
import { test, expect } from "@playwright/test";

const TABS = ["fonts", "terminal", "copilot", "devlog", "rendering", "app", "companion"];

test("every settings tab fits inside a small window", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  const dialog = page.getByTestId("settings-modal").locator("> div");
  await expect(page.getByTestId("settings-tab-fonts")).toHaveAttribute("aria-selected", "true");

  for (const id of TABS) {
    await page.getByTestId(`settings-tab-${id}`).click();
    await expect(page.getByTestId(`settings-tab-${id}`)).toHaveAttribute("aria-selected", "true");
    const box = (await dialog.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    await expect(page.getByTestId("settings-reset")).toBeInViewport();
    await expect(page.getByTestId("settings-modal-close")).toBeInViewport();
  }
  await expect(page.getByTestId("companion-settings")).toBeVisible();
});
