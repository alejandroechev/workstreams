// CDP visual probe for syntax highlighting in the Repo Explorer file view.
//
// Regression: FileEditorView used to ship its own ~10-extension inferLanguage()
// switch which silently fell back to "plaintext" for .cs / .go / .java / .c /
// .cpp / .sh / .php / .rb / .swift / .kt / .sql / .xml. This probe writes a
// tiny .cs file into the showcase folder, opens it through Repo Explorer, and
// asserts the live Monaco model's language id is "csharp".
import fs from "node:fs";
import path from "node:path";

const fixtureName = "cdp-syntax.cs";
const initialText = "namespace CdpProbe;\npublic class Hello { public static void Main() {} }\n";

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
  }
}

export async function run({ page, screenshot }) {
  ensureFixture();

  await page.waitForSelector('[data-testid="workstream-item"]', { timeout: 30000 });
  await page.waitForTimeout(800);

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
  await fixtureItem.click();

  const editorRoot = page.locator('[data-file-editor-root="true"]').first();
  await editorRoot.waitFor({ timeout: 30000 });
  const monaco = editorRoot.locator(".monaco-editor").first();
  await monaco.waitFor({ timeout: 30000 });
  await screenshot("cs-file-open");

  // Read the actual Monaco model's language id straight from the buffer registry.
  const languageId = await page.evaluate((name) => {
    const reg = window.__wsFileBufferRegistry;
    const target = reg.listAll().find((s) => s.path.toLowerCase().endsWith(name.toLowerCase()));
    if (!target) throw new Error("buffer not registered for fixture");
    const model = reg.getModel(target.path);
    if (!model) throw new Error("no Monaco model");
    return model.getLanguageId?.() ?? null;
  }, fixtureName);

  if (languageId !== "csharp") {
    throw new Error(`Expected Monaco language id 'csharp' for .cs file, got '${languageId}'`);
  }

  const errors = await page.evaluate(() =>
    (window.__workstreamsConsoleErrors ?? []).map((entry) => String(entry)),
  ).catch(() => []);
  if (errors.length > 0) {
    throw new Error(`Console errors during syntax-highlight probe:\n${errors.join("\n")}`);
  }
}
