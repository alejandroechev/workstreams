// CDP visual probe for the Repo create-vs-import dropdown feature.
//
// Clicks the sidebar "+" button to reveal the new Import / Create menu,
// then opens the Create New Repo form. Does not submit (would touch FS).
export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  // Screenshot the sidebar before clicking.
  await screenshot("sidebar-before");

  // Find the "+" button next to the "Repos" header. It sits inside the
  // sidebar's Repos section header. We target by title attribute.
  const plusBtn = page.locator('button[title="Add repo"]').first();
  if (!(await plusBtn.count())) {
    // Backward-compat (older builds): old title "New repo".
    const old = page.locator('button[title="New repo"]').first();
    if (await old.count()) {
      await old.click();
      await page.waitForTimeout(400);
      await screenshot("legacy-import-form");
      return;
    }
    throw new Error("Sidebar + button not found");
  }

  await plusBtn.click();
  await page.waitForTimeout(300);
  await screenshot("repo-menu-open");

  // Click "Create new repo".
  const createItem = page.locator('button:has-text("Create new repo")').first();
  if (await createItem.count()) {
    await createItem.click();
    await page.waitForTimeout(500);
    await screenshot("create-form-open");

    // Toggle the GitHub remote checkbox to reveal owner + visibility.
    const remoteCheckbox = page
      .locator('[data-testid="repo-create-form"] input[type="checkbox"]')
      .first();
    if (await remoteCheckbox.count()) {
      await remoteCheckbox.check();
      await page.waitForTimeout(300);
      await screenshot("create-form-with-remote");
    }

    // Cancel out.
    const cancel = page
      .locator('[data-testid="repo-create-form"] button:has-text("Cancel")')
      .first();
    if (await cancel.count()) {
      await cancel.click();
      await page.waitForTimeout(200);
    }
  }

  // Re-open menu and verify Import path still works.
  await plusBtn.click();
  await page.waitForTimeout(300);
  const importItem = page.locator('button:has-text("Import existing repo")').first();
  if (await importItem.count()) {
    await importItem.click();
    await page.waitForTimeout(400);
    await screenshot("import-form-open");
    const cancel = page.locator('button:has-text("Cancel")').first();
    if (await cancel.count()) await cancel.click();
  }
}
