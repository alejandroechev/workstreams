// Repo Explorer fixes — drives the tile to validate:
//  - Font-size widget alignment in the tab bar
//  - No "Back to Browse" buttons (tab nav only)
//  - Diff / Log / Hooks tabs render cleanly without back buttons

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);

  // Try to add a Repo Explorer tile via the Add Tile menu.
  const addBtn = page.locator('[data-testid="add-tile-button"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(200);
    const explorer = page.locator('[data-testid="add-tile-item-explorer"]').first();
    if (await explorer.count()) await explorer.click();
    await page.waitForTimeout(800);
  }

  // Screenshot 1: default Files tab — tab bar should show aligned font widget.
  await screenshot("files-tab-default");

  // Click each tab in sequence and screenshot — confirms no Back button shown.
  for (const tabId of ["diff", "log", "hooks", "files"]) {
    const tab = page.locator(`[data-testid="repo-explorer-tab-${tabId}"]`).first();
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(400);
      await screenshot(`tab-${tabId}`);
    }
  }

  // Test font-size buttons exist and are aligned (a-b sequence)
  const fontInc = page.locator('[data-testid="repo-explorer-font-inc"]').first();
  if (await fontInc.count()) {
    await fontInc.click();
    await fontInc.click();
    await page.waitForTimeout(200);
    await screenshot("font-increased");
  }
}
