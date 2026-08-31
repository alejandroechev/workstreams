// Windows-only CDP visual probe for the YAML loop catalog.
// macOS WKWebView does not expose CDP; see ADR 003 and ADR 018.

async function openFirstWorkstream(page) {
  await page.waitForSelector('[data-testid="workstream-item"]', { timeout: 30000 });
  const showcase = page
    .locator('[data-testid="workstream-item"]', { hasText: "Showcase" })
    .first();
  if (await showcase.count()) {
    await showcase.click();
  } else {
    await page.locator('[data-testid="workstream-item"]').first().click();
  }
  await page.waitForTimeout(800);
}

async function verifyNoConsoleErrors(page) {
  const errors = await page
    .evaluate(() =>
      (window.__workstreamsConsoleErrors ?? []).map((error) => String(error)),
    )
    .catch(() => []);
  if (errors.length > 0) {
    throw new Error(
      `Console errors detected during manual-loop probe:\n${errors.join("\n")}`,
    );
  }
}

export async function run({ page, screenshot }) {
  await openFirstWorkstream(page);
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-item-loop"]').click();
  await page
    .locator('[data-testid="loop-control-tile"]')
    .waitFor({ timeout: 10000 });
  await page
    .locator('[data-testid="loop-catalog"]')
    .waitFor({ timeout: 10000 });
  await page
    .locator('[data-testid="loop-definition-showcase-loop"]')
    .filter({ hasText: "Human approval" })
    .waitFor({ timeout: 10000 });
  await page
    .locator('[data-testid="loop-definition-selected"]')
    .filter({ hasText: "Showcase loop" })
    .waitFor({ timeout: 10000 });

  await screenshot();
  await verifyNoConsoleErrors(page);
}
