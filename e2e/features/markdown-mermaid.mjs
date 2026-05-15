// Feature protocol for: markdown-mermaid (VS Code-style markdown + mermaid).
// Opens the Showcase workstream's README.md in the file explorer tile and
// screenshots the rendered markdown (including the mermaid block).

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);

  const showcase = page.locator('[data-testid="workstream-item"]', { hasText: "Showcase" }).first();
  if (await showcase.count()) {
    await showcase.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  const explorerTile = page.locator('[data-testid="tile-explorer"]').first();
  await explorerTile.waitFor({ timeout: 5000 }).catch(() => {});

  const readme = page
    .locator('[data-testid="file-tree-item"]', { hasText: "README.md" })
    .first();
  if (await readme.count()) {
    await readme.click();
    await page.waitForTimeout(800);
  }

  const md = page.locator('[data-testid="markdown-content"]').first();
  await md.waitFor({ timeout: 5000 }).catch(() => {});

  // Wait for lazy mermaid script + SVG render.
  await page.waitForTimeout(2500);

  await screenshot("markdown-mermaid");
}
