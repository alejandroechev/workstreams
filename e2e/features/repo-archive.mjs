// Repository archive/filter visual proof against the isolated dev database.
// Restores the repository before returning so repeated runs stay idempotent.
export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  await page.locator('[data-testid="repo-manager-button"]').click();
  const panel = page.locator('[data-testid="repo-manager-panel"]');
  await panel.waitFor();
  await screenshot("not-archived-default");

  const row = panel.locator('[data-testid^="repo-manager-row-"]').first();
  if (!(await row.count())) {
    throw new Error("The seeded dev database has no repository to archive");
  }
  await row.click();
  await panel.locator('[data-testid="repo-manager-archive"]').click();
  await page.waitForTimeout(300);
  await screenshot("archived-hidden");

  await panel.locator('[data-testid="repo-manager-filter"]').selectOption("all");
  const archivedRow = panel.locator('[data-testid^="repo-manager-row-"]').first();
  await archivedRow.waitFor();
  await archivedRow.click();
  await screenshot("all-shows-archived");

  await panel.locator('[data-testid="repo-manager-archive"]').click();
}
