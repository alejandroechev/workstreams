// CDP visual probe for inline file comments.
//
// Pragmatic scope: this probe exercises the *backend* + *toolbar* surface
// rather than driving the view-zone render lifecycle through CDP (which
// requires waking the React hook from a foreign mutation). The actual
// view-zone rendering is covered by 12 helper + 7 hook + 11 MemoryBackend
// vitest cases plus the TauriBackend invoke-shape test.
//
// Steps:
// 1. Clear Showcase's fullscreen so its explorer tiles are visible.
// 2. Open the seeded fixture file in a visible explorer tile.
// 3. Verify the comments-toggle button is present in the toolbar.
// 4. Insert a comment via the Tauri command (proves the round-trip).
// 5. Screenshot the editor + toolbar with the toggle visible.
// 6. Verify the comment landed in the workstream's DB.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const fixtureName = "cdp-inline-comments.ts";
const initialText = `// CDP fixture for inline comments
function add(a: number, b: number): number {
  return a + b;
}

function multiply(a: number, b: number): number {
  return a * b;
}

export { add, multiply };
`;

function ensureFixture() {
  const showcaseDir = path.resolve(process.cwd(), ".dev", "showcase");
  fs.mkdirSync(showcaseDir, { recursive: true });
  const p = path.join(showcaseDir, fixtureName);
  fs.writeFileSync(p, initialText, "utf8");
  return p;
}

function clearShowcaseFullscreen() {
  const Database = require("better-sqlite3");
  const dbPath = path.resolve(process.cwd(), ".dev", "workstreams-dev.db");
  const db = new Database(dbPath);
  try {
    db.prepare(
      "UPDATE workstream_layouts SET fullscreen_tile_id = NULL WHERE workstream_id LIKE 'showcase%'",
    ).run();
  } finally {
    db.close();
  }
}

function deleteExistingProbeComments() {
  const Database = require("better-sqlite3");
  const dbPath = path.resolve(process.cwd(), ".dev", "workstreams-dev.db");
  const db = new Database(dbPath);
  try {
    db.prepare("DELETE FROM file_comments WHERE absolute_path LIKE ?")
      .run("%cdp-inline-comments.ts");
  } finally {
    db.close();
  }
}

function readProbeCommentsFromDb() {
  const Database = require("better-sqlite3");
  const dbPath = path.resolve(process.cwd(), ".dev", "workstreams-dev.db");
  const db = new Database(dbPath);
  try {
    return db
      .prepare(
        "SELECT id, body_md, anchor_line_start, anchor_line_end, origin_type, author FROM file_comments WHERE absolute_path LIKE ?",
      )
      .all("%cdp-inline-comments.ts");
  } finally {
    db.close();
  }
}

async function verifyNoConsoleErrors(page) {
  const errors = await page
    .evaluate(() => (window.__workstreamsConsoleErrors ?? []).map((e) => String(e)))
    .catch(() => []);
  if (errors.length > 0) {
    throw new Error(`Console errors during inline-comments probe:\n${errors.join("\n")}`);
  }
}

export async function run({ page, screenshot }) {
  ensureFixture();
  clearShowcaseFullscreen();
  deleteExistingProbeComments();

  await page.reload();
  await page.waitForSelector('[data-testid="workstream-item"]', { timeout: 30000 });
  await page.waitForTimeout(1200);

  // Select Showcase (it has many seeded explorer tiles we can reuse)
  const showcaseItem = page
    .locator('[data-testid="workstream-item"]')
    .filter({ hasText: "Showcase" })
    .first();
  await showcaseItem.waitFor({ timeout: 10000 });
  await showcaseItem.click();
  await page.waitForTimeout(1500);

  // Pick the first explorer tile that has a non-zero bounding box.
  const explorerTiles = page.locator('[data-testid="tile-explorer"]');
  const tileCount = await explorerTiles.count();
  let activeExplorer = null;
  for (let i = 0; i < tileCount; i++) {
    const t = explorerTiles.nth(i);
    if (await t.isVisible().catch(() => false)) {
      activeExplorer = t;
      break;
    }
  }
  if (!activeExplorer) throw new Error("No visible explorer tile in Showcase WS");
  await activeExplorer.click({ position: { x: 100, y: 100 } }).catch(() => {});
  await page.waitForTimeout(300);

  const fixtureItem = activeExplorer
    .locator('[data-testid="file-tree-item"]', { hasText: fixtureName })
    .first();
  await fixtureItem.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await fixtureItem.click({ force: true });

  const editorRoot = page.locator('[data-file-editor-root="true"]').first();
  await editorRoot.waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await screenshot("editor-open");

  // Find the comments toggle in the toolbar
  const toggle = page.locator('[data-testid="repo-explorer-comments-toggle"]').first();
  await toggle.waitFor({ timeout: 10000 });
  await toggle.click();
  await page.waitForTimeout(400);
  await screenshot("toggle-on");

  // Discover the active workstream id and the registered file path
  const wsId = await page.evaluate(() => {
    const el = document.querySelector('[data-workstream-id][data-active="true"]');
    return el ? el.getAttribute("data-workstream-id") : null;
  });
  if (!wsId) throw new Error("Could not find active workstream id from DOM");

  const filePath = await page.evaluate(() => {
    const reg = window.__wsFileBufferRegistry;
    if (!reg) return null;
    const target = reg
      .listAll()
      .find((s) => s.path.toLowerCase().endsWith("cdp-inline-comments.ts"));
    return target ? target.path : null;
  });
  if (!filePath) throw new Error("FileBufferRegistry did not register the fixture path");

  // Round-trip through the Tauri command (this is the same path
  // useFileComments.add takes from the UI).
  const created = await page.evaluate(
    async ({ wsId, filePath }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      return invoke("add_file_comment", {
        workstreamId: wsId,
        absolutePath: filePath,
        anchorLineStart: 2,
        anchorLineEnd: 4,
        anchorText:
          "function add(a: number, b: number): number {\n  return a + b;\n}",
        bodyMd: "CDP probe note: this function should also validate inputs.",
      });
    },
    { wsId, filePath },
  );
  if (!created || !created.id) {
    throw new Error(`add_file_comment returned unexpected: ${JSON.stringify(created)}`);
  }

  // Verify it landed in the DB
  const dbRows = readProbeCommentsFromDb();
  const matching = dbRows.find((r) => r.id === created.id);
  if (!matching) {
    throw new Error(
      `Comment was not persisted to DB (have ${dbRows.length} rows total for fixture)`,
    );
  }
  if (matching.author !== "me" || matching.origin_type !== "user") {
    throw new Error(
      `Wrong author/origin: author=${matching.author}, origin_type=${matching.origin_type}`,
    );
  }

  await screenshot("comment-persisted");

  // Cleanup so the probe is re-runnable
  await page.evaluate(
    async ({ id }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      return invoke("delete_file_comment", { id });
    },
    { id: created.id },
  );

  await verifyNoConsoleErrors(page);
}
