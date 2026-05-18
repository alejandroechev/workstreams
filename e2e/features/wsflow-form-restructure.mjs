// Workstream creation flow: open the form, validate new Repo/Session radio layout,
// and screenshot.

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);

  // Open the workstream-create form. The sidebar exposes a "+" button per project
  // and a global one for standalone WS. We rely on Alt+W or a button click.
  // Simplest: dispatch the keyboard shortcut.
  // The app's keymap should listen for "n" or a button. Fall back to clicking
  // any element with title "New workstream".
  const newBtn = page.locator('[title="New workstream"]').first();
  if (await newBtn.count()) {
    await newBtn.click();
  } else {
    // Try sidebar "+ Workstream" text fallback
    const alt = page.getByText(/\+ workstream/i).first();
    if (await alt.count()) await alt.click();
  }

  // Wait for the form
  await page.locator('[data-testid="ws-create-form"]').waitFor({ timeout: 5000 });

  // Sanity: the new structure has data-testid radios for Repo and Session.
  const repoBaseRepo = page.locator('[data-testid="ws-create-repo-base_repo"]');
  const sessionNew = page.locator('[data-testid="ws-create-session-new"]');
  await repoBaseRepo.waitFor();
  await sessionNew.waitFor();

  await screenshot("ws-create-form-default");

  // Click Import Worktree and confirm session radio gets locked to existing.
  await page.locator('[data-testid="ws-create-repo-import_worktree"] input').click();
  await page.waitForTimeout(150);
  await screenshot("ws-create-form-import-worktree");

  // Switch to New Worktree to see the branch field
  await page.locator('[data-testid="ws-create-repo-worktree"] input').click();
  await page.waitForTimeout(150);
  await screenshot("ws-create-form-new-worktree");

  // Close
  const cancelBtn = page.getByRole("button", { name: /cancel/i }).first();
  if (await cancelBtn.count()) await cancelBtn.click();
}
