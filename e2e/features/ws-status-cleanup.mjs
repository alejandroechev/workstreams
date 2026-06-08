// Workstream sidebar status cleanup — verifies the kebab action menu no
// longer surfaces status options, and that the activity slot renders the
// new unified indicator (idle in this clean session).

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  // Idle state baseline.
  await screenshot("sidebar-idle");

  // Open the kebab on the first workstream row.
  const row = page.locator('[data-testid="workstream-item"]').first();
  if (await row.count()) {
    const kebab = row.locator('[data-testid^="workstream-kebab-"]').first();
    if (await kebab.count()) {
      await kebab.click();
      await page.waitForTimeout(300);
      await screenshot("action-menu-no-status");
      await page.keyboard.press("Escape");
    }
  }
}
