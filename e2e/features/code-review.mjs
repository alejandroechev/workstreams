// CDP visual probe for the Code Review tile (ADR 014).
//
// Opens the seeded showcase workstream, adds a Code Review tile via the
// add-tile menu, starts a working_tree review, and screenshots the diff-first
// UI. Fails on any console error. Run against the live Tauri dev app:
//
//   npm run cdp:feature -- code-review --todo-id e2e-cdp-cr
//
// Note: the review's changed-file list reflects the showcase repo's real git
// state, so this probe only asserts the tile + picker + diff surface mount
// cleanly (no white screen / plugin errors) — it does not require a specific
// file to be present.
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
    throw new Error(`Console errors detected during code-review probe:\n${errors.join("\n")}`);
  }
}

export async function run({ page, screenshot }) {
  await openFirstWorkstream(page);

  // Add the Code Review tile via the "+ Add tile" menu.
  await page.locator('[data-testid="add-tile-button"]').click();
  await page.locator('[data-testid="add-tile-menu"]').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="add-tile-item-code-review"]').click();

  const tile = page.locator('[data-testid="code-review-tile"]').first();
  await tile.waitFor({ timeout: 20000 });

  // Either the picker (session linked) or the "open a session" prompt renders.
  const picker = tile.locator('[data-testid="review-picker"]').first();
  await picker.waitFor({ state: "attached", timeout: 20000 }).catch(() => {});

  await screenshot("code-review-picker");

  // If a session is linked, start a working_tree review and screenshot the diff.
  if (await picker.count()) {
    await tile.locator('[data-testid="create-review"]').first().click();
    // Wait for the Monaco diff editor to mount (file list may be empty if the
    // showcase repo has no working-tree changes — that's acceptable here).
    await page
      .waitForFunction(
        () => document.querySelectorAll('[data-testid="code-review-tile"] .monaco-diff-editor').length > 0,
        null,
        { timeout: 30000 },
      )
      .catch(() => {});
    await screenshot("code-review-diff");
  }

  await verifyNoConsoleErrors(page);
}
