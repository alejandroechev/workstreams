// Diff view unification — validates the unified diff layout:
//  - Single file list with status badges (A/M/D/R)
//  - Mode toggle row with file count
//  - DiffEditor on the right showing real before/after

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

  const diffTab = page.locator('[data-testid="repo-explorer-tab-diff"]').first();
  if (await diffTab.count()) {
    await diffTab.click();
    await page.waitForTimeout(800);
  }

  // Try each diff mode and capture a screenshot.
  for (const mode of ["unstaged", "last_commit", "branch_vs_master"]) {
    const btn = page.locator(`[data-testid="diff-btn-${mode}"]`).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(1200);
      await screenshot(`diff-${mode}`);
    }
  }

  // Final screenshot capturing the unified layout with the file list visible.
  await screenshot();
}
