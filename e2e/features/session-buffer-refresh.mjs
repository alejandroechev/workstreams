// CDP visual probe for the session-buffer-refresh fix.
//
// Simulates the workstream-switch pattern that causes stale terminal buffers:
// 1. Activate the Showcase workstream (which has a session tile).
// 2. Screenshot the session tile.
// 3. Switch to Sandbox workstream (hides the session tile).
// 4. Wait a moment.
// 5. Switch back to Showcase.
// 6. Screenshot — the session tile should show a correct buffer, not blank/stale.
export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  // 1. Activate Showcase workstream (first in the sidebar).
  const wsItems = page.locator('[data-testid="workstream-item"]');
  const wsCount = await wsItems.count();
  if (wsCount < 2) {
    console.log("[cdp] Need at least 2 workstreams to test switching. Skipping.");
    await screenshot("not-enough-workstreams");
    return;
  }

  // Click first workstream.
  await wsItems.nth(0).click();
  await page.waitForTimeout(1000);

  // Add a session tile if there isn't one.
  let sessionTile = page.locator('[data-testid="tile-header"]').first();
  if (!(await sessionTile.count())) {
    // Use keyboard shortcut to add a session tile.
    await page.keyboard.press("Alt+C");
    await page.waitForTimeout(1500);
  }

  await screenshot("ws1-before-switch");

  // 2. Switch to the second workstream.
  await wsItems.nth(1).click();
  await page.waitForTimeout(800);

  await screenshot("ws2-active");

  // 3. Switch back to the first workstream.
  await wsItems.nth(0).click();
  await page.waitForTimeout(1000);

  await screenshot("ws1-after-switch");

  // 4. Do it again more rapidly (2x switch cycle) to stress the visibility path.
  await wsItems.nth(1).click();
  await page.waitForTimeout(300);
  await wsItems.nth(0).click();
  await page.waitForTimeout(300);
  await wsItems.nth(1).click();
  await page.waitForTimeout(300);
  await wsItems.nth(0).click();
  await page.waitForTimeout(1200);

  await screenshot("ws1-after-rapid-switches");
}
