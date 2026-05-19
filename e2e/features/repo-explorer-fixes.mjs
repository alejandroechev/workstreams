// Repo Explorer fixes — drives the tile to validate:
//  - Font-size widget alignment in the tab bar
//  - No "Back to Browse" buttons (tab nav only)
//  - Diff / Log / Hooks tabs render cleanly without back buttons

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  // Reload so the app picks up any seeded workstreams that were inserted
  // after the dev exe booted (the React app loads workstreams once on mount).
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  // Activate the first workstream if any exist.
  const ws = page.locator('[data-testid="workstream-item"]').first();
  if (await ws.count()) {
    await ws.click();
    await page.waitForTimeout(500);
  }

  // Add a Repo Explorer tile via the Add Tile menu.
  const addBtn = page.locator('[data-testid="add-tile-button"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(300);
    const explorer = page.locator('[data-testid="add-tile-item-explorer"]').first();
    if (await explorer.count()) await explorer.click();
    await page.waitForTimeout(1000);
  }

  await screenshot("files-tab-default");

  for (const tabId of ["diff", "log", "hooks", "files"]) {
    const tab = page.locator(`[data-testid="repo-explorer-tab-${tabId}"]`).first();
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(500);
      await screenshot(`tab-${tabId}`);
    }
  }

  const fontInc = page.locator('[data-testid="repo-explorer-font-inc"]').first();
  if (await fontInc.count()) {
    await fontInc.click();
    await fontInc.click();
    await page.waitForTimeout(200);
    await screenshot("font-increased");
  }
}
