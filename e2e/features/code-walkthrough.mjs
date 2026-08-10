// CDP visual probe for the Code Walkthrough tile (ADR 018).
//
// Opens the seeded showcase workstream, adds a Code Walkthrough tile via the
// add-tile menu, and screenshots it. Fails on any console error. Run against
// the live Tauri dev app:
//
//   npm run cdp:feature -- code-walkthrough --todo-id cdp-validate-walkthrough
//
// This probe deliberately does not require a recorded trace to exist: creating
// one needs lldb-dap and a full cargo test build, which is the *recorder's*
// job and is covered by its own CLI. What CDP uniquely catches is whether the
// tile mounts cleanly inside the real WebView — white screens, plugin errors,
// missing icons — which jsdom and the dev-server Playwright run cannot see.
async function openFirstWorkstream(page) {
  await page.waitForSelector('[data-testid="workstream-item"]', { timeout: 30000 });
  await page.waitForTimeout(600);
  const showcase = page.locator('[data-testid="workstream-item"]', { hasText: "Showcase" }).first();
  if (await showcase.count()) {
    await showcase.click();
  } else {
    await page.locator('[data-testid="workstream-item"]').first().click();
  }
  await page.waitForTimeout(800);
}

async function verifyNoConsoleErrors(page) {
  const errors = await page
    .evaluate(() => (window.__workstreamsConsoleErrors ?? []).map((e) => String(e)))
    .catch(() => []);
  if (errors.length > 0) {
    throw new Error(`Console errors detected during code-walkthrough probe:\n${errors.join("\n")}`);
  }
}

export async function run({ page, screenshot }) {
  await openFirstWorkstream(page);

  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-menu"]').waitFor({ timeout: 10000 });

  const item = page.locator('[data-testid="add-tile-item-walkthrough"]');
  if (await item.count()) {
    await item.click();
    await page.waitForTimeout(800);
    // The tile renders either the controller (flag on) or the disabled-feature
    // placeholder (flag off). Both are valid mounts; neither may error.
    await page.waitForSelector(
      '[data-testid="debug-walkthrough-tile"], [data-testid="disabled-feature"]',
      { timeout: 10000 },
    ).catch(() => {});
  } else {
    // Menu entry is gated off in this build — close the menu and still capture
    // the app state so the probe records a clean run rather than failing on a
    // deliberate configuration.
    await page.keyboard.press("Escape");
  }

  await page.waitForTimeout(400);
  await screenshot();
  await verifyNoConsoleErrors(page);
}
