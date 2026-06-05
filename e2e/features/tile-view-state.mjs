// Tile view-state persistence — opens a Repo Explorer tile, navigates to a
// non-default tab, then reloads the app and verifies the tab is restored.

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  const ws = page.locator('[data-testid="workstream-item"]').first();
  if (await ws.count()) {
    await ws.click();
    await page.waitForTimeout(500);
  }

  const addBtn = page.locator('[data-testid="add-tile-button"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(300);
    const explorer = page.locator('[data-testid="add-tile-item-explorer"]').first();
    if (await explorer.count()) await explorer.click();
    await page.waitForTimeout(1000);
  }

  // Move to the Hooks tab — a non-default selection that would normally be
  // lost on a full reload unless view-state persistence is wired up.
  const hooksTab = page.locator('[data-testid="repo-explorer-tab-hooks"]').first();
  if (await hooksTab.count()) {
    await hooksTab.click();
    await page.waitForTimeout(800);
    await screenshot("hooks-tab-before-reload");
  }

  // Give the 500ms debounced persistence hook time to flush.
  await page.waitForTimeout(1500);

  // Reload and confirm the tile comes back on the Hooks tab.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  const ws2 = page.locator('[data-testid="workstream-item"]').first();
  if (await ws2.count()) {
    await ws2.click();
    await page.waitForTimeout(800);
  }

  await screenshot("after-reload");
}
