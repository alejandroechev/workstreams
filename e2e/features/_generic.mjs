// Generic feature protocol: connects to the running app and screenshots whatever
// page is currently shown. Used when a feature does not define its own protocol.

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(500);
  await screenshot();
}
