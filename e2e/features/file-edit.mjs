// CDP visual probe for editable text files in tile file-detail panes.
//
// Uses the seeded Showcase workstream, creates a plain-text fixture in the
// showcase folder, opens it through Repo Explorer, edits it in Monaco, saves,
// and verifies the on-disk file contains the typed text.
import fs from "node:fs";
import path from "node:path";

const fixtureName = "cdp-edit.txt";
const initialText = "Editable text file CDP fixture\n";

function ensureFixture() {
  const showcaseDir = path.resolve(process.cwd(), ".dev", "showcase");
  fs.mkdirSync(showcaseDir, { recursive: true });
  const fixturePath = path.join(showcaseDir, fixtureName);
  fs.writeFileSync(fixturePath, initialText, "utf8");
  return fixturePath;
}

async function ensureRepoExplorerTile(page) {
  let explorerTile = page.locator('[data-testid="tile-explorer"]').first();
  if (await explorerTile.count()) return explorerTile;

  await page.keyboard.press("Alt+R");
  await page.waitForTimeout(1000);
  explorerTile = page.locator('[data-testid="tile-explorer"]').first();
  if (await explorerTile.count()) return explorerTile;

  const addBtn = page.locator('[data-testid="add-tile-button"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(200);
    const explorer = page.locator('[data-testid="add-tile-item-explorer"]').first();
    if (await explorer.count()) {
      await explorer.click();
      await page.waitForTimeout(1000);
    }
  }

  explorerTile = page.locator('[data-testid="tile-explorer"]').first();
  await explorerTile.waitFor({ timeout: 10000 });
  return explorerTile;
}

async function openShowcaseWorkstream(page) {
  const showcase = page.locator('[data-testid="workstream-item"]', { hasText: "Showcase" }).first();
  if (await showcase.count()) {
    await showcase.click();
    await page.waitForTimeout(600);
    return;
  }

  const firstWorkstream = page.locator('[data-testid="workstream-item"]').first();
  await firstWorkstream.waitFor({ timeout: 10000 });
  await firstWorkstream.click();
  await page.waitForTimeout(600);
}

async function verifyNoConsoleErrors(page) {
  const errors = await page.evaluate(() =>
    (window.__workstreamsConsoleErrors ?? []).map((entry) => String(entry)),
  ).catch(() => []);
  if (errors.length > 0) {
    throw new Error(`Console errors detected during file-edit probe:\n${errors.join("\n")}`);
  }
}

export async function run({ page, screenshot }) {
  const fixturePath = ensureFixture();
  const typedText = `CDP typed edit ${Date.now()}`;

  await page.waitForLoadState("domcontentloaded");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  await openShowcaseWorkstream(page);
  const explorerTile = await ensureRepoExplorerTile(page);

  const refresh = explorerTile.locator('button[title="Refresh"]').first();
  if (await refresh.count()) {
    await refresh.click();
    await page.waitForTimeout(600);
  }

  const fixtureItem = page
    .locator('[data-testid="file-tree-item"]', { hasText: fixtureName })
    .first();
  await fixtureItem.waitFor({ timeout: 10000 });
  const treePath = await fixtureItem.getAttribute("data-path");
  if (!treePath || !treePath.toLowerCase().endsWith(fixtureName)) {
    throw new Error(`Expected file-tree-item data-path for ${fixtureName}, got ${treePath}`);
  }
  await fixtureItem.click();

  const editorRoot = page.locator('[data-file-editor-root="true"]').first();
  await editorRoot.waitFor({ timeout: 30000 });
  const monaco = editorRoot.locator(".monaco-editor").first();
  await monaco.waitFor({ timeout: 30000 });
  await screenshot("editor-open");

  await monaco.click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`\n${typedText}`);

  const title = page.locator('[data-testid="repo-explorer-file-title"]').first();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.textContent?.includes("*") ?? false,
    '[data-testid="repo-explorer-file-title"]',
    { timeout: 10000 },
  );
  if (!((await title.textContent()) ?? "").includes("*")) {
    throw new Error("Dirty indicator did not appear after typing in Monaco");
  }
  await screenshot("dirty-state");

  await page.keyboard.press("Control+S");
  await page.waitForTimeout(1000);
  await page.waitForFunction(
    (selector) => !(document.querySelector(selector)?.textContent?.includes("*") ?? false),
    '[data-testid="repo-explorer-file-title"]',
    { timeout: 10000 },
  );
  if (((await title.textContent()) ?? "").includes("*")) {
    throw new Error("Dirty indicator did not clear after Ctrl+S save");
  }
  await screenshot("saved-state");

  const diskText = fs.readFileSync(fixturePath, "utf8");
  if (!diskText.includes(typedText)) {
    throw new Error(`Saved file does not contain typed text: ${fixturePath}`);
  }

  await verifyNoConsoleErrors(page);
}
