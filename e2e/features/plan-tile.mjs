// CDP visual probe for the Plan tile feature.
//
// Activates the seeded Showcase workstream and adds a Plan tile via the
// AddTile menu, then screenshots each of the 4 tabs.
export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  // Activate first workstream.
  const ws = page.locator('[data-testid="workstream-item"]').first();
  if (await ws.count()) {
    await ws.click();
    await page.waitForTimeout(500);
  }

  // Add a Plan tile.
  const addBtn = page.locator('[data-testid="add-tile-button"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(200);
    const planItem = page.locator('[data-testid="add-tile-item-plan"]').first();
    if (await planItem.count()) {
      await planItem.click();
    } else {
      // Fallback: use keyboard shortcut Alt+P
      await page.keyboard.press("Alt+P");
    }
    await page.waitForTimeout(1200);
  }

  await screenshot("plan-tab");

  // Switch to Todos tab.
  const todos = page.locator('[data-testid="plan-tab-todos"]').first();
  if (await todos.count()) {
    await todos.click();
    await page.waitForTimeout(500);
    await screenshot("todos-tab");
  }

  // Switch to Graph tab.
  const graph = page.locator('[data-testid="plan-tab-graph"]').first();
  if (await graph.count()) {
    await graph.click();
    await page.waitForTimeout(1500);
    await screenshot("graph-tab");
  }

  // Switch to History tab.
  const hist = page.locator('[data-testid="plan-tab-history"]').first();
  if (await hist.count()) {
    await hist.click();
    await page.waitForTimeout(500);
    await screenshot("history-tab");
  }
}
