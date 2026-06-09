// Verify Ctrl+Shift+V toggles markdown preview <-> edit in a Repo Explorer
// tile. Uses the showcase seed which always has a README.md at the workstream
// root.

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  const ws = page.locator('[data-testid="workstream-item"]').first();
  if (await ws.count()) {
    await ws.click();
    await page.waitForTimeout(400);
  }

  // Open a Repo Explorer tile.
  const addBtn = page.locator('[data-testid="add-tile-button"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(250);
    const explorer = page.locator('[data-testid="add-tile-item-explorer"]').first();
    if (await explorer.count()) await explorer.click();
    await page.waitForTimeout(800);
  }

  // Find README.md in the tile and click it.
  const readme = page.locator('[data-testid="file-tree-item"][data-path$="README.md"]').first();
  if (!(await readme.count())) {
    await screenshot("no-readme");
    return;
  }
  await readme.click();
  await page.waitForTimeout(800);

  // We should be in preview mode now (markdown default).
  await page.locator('[data-testid="file-editor-view"]').waitFor({ timeout: 5000 });
  await screenshot("preview-initial");

  // Focus the editor root so the global Ctrl+Shift+V handler fires.
  await page.locator('[data-testid="file-editor-view"]').click();
  await page.waitForTimeout(200);

  // Toggle to edit via Ctrl+Shift+V — Monaco should mount.
  await page.keyboard.press("Control+Shift+V");
  await page.waitForTimeout(1000);
  await screenshot("after-toggle-to-edit");

  // Toggle back to preview.
  await page.keyboard.press("Control+Shift+V");
  await page.waitForTimeout(600);
  await screenshot("after-toggle-back-to-preview");
}
