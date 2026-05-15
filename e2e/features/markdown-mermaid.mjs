// Feature protocol for: markdown-mermaid (VS Code-style markdown + mermaid).
// Selects the Showcase workstream, adds an Explorer tile if none exists,
// opens README.md, and screenshots the rendered markdown including the
// mermaid diagram.

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);

  // 1. Select the Showcase workstream.
  const showcase = page.locator('[data-testid="workstream-item"]', { hasText: "Showcase" }).first();
  if (await showcase.count()) {
    await showcase.click();
    await page.waitForTimeout(400);
  }

  // 2. If no Explorer tile yet, add one via the "+ Explorer" footer button.
  let explorerTile = page.locator('[data-testid="tile-explorer"]').first();
  if (!(await explorerTile.count())) {
    const addExplorer = page.locator("button", { hasText: /\+\s*Explorer/i }).first();
    if (await addExplorer.count()) {
      await addExplorer.click();
      await page.waitForTimeout(800);
    } else {
      // Fallback: keyboard shortcut (e maps to explorer in some keymaps).
      await page.keyboard.press("e");
      await page.waitForTimeout(600);
    }
    explorerTile = page.locator('[data-testid="tile-explorer"]').first();
  }
  // Snapshot regardless of next outcome — useful for diagnosis.
  await screenshot("after-create-tile");
  await explorerTile.waitFor({ timeout: 8000 });

  // 3. Find and click README.md in the file tree.
  const readme = page
    .locator('[data-testid="file-tree-item"]', { hasText: "README.md" })
    .first();
  await readme.waitFor({ timeout: 5000 });
  await readme.click();

  // 4. Wait for MarkdownView and the mermaid lazy script to render.
  const md = page.locator('[data-testid="markdown-content"]').first();
  await md.waitFor({ timeout: 5000 });
  const mermaid = page.locator('[data-testid="mermaid-diagram"]').first();
  await mermaid.waitFor({ timeout: 15000 });
  await page.locator('[data-testid="mermaid-diagram"] svg').first().waitFor({ timeout: 15000 });
  // Scroll the mermaid diagram into view before screenshotting.
  await mermaid.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);

  await screenshot("markdown-mermaid");
}
