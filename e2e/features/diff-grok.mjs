// CDP visual probe for the Diff Review tile (ADR 007).
//
// Seeds a fresh diff review + tile via the App's __wsSeedDiffReviewTile
// debug bridge, then verifies the tile renders the Monaco diff pane, the
// question pane, and the active chunk title.
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
    throw new Error(`Console errors detected during diff-grok probe:\n${errors.join("\n")}`);
  }
}

export async function run({ page, screenshot }) {
  await openFirstWorkstream(page);

  await page.waitForFunction(() => typeof window.__wsSeedDiffReviewTile === "function", null, {
    timeout: 20000,
  });

  const result = await page.evaluate(async () => {
    return await window.__wsSeedDiffReviewTile();
  });
  if (!result?.reviewId || !result?.tileId) {
    throw new Error(`Seed bridge returned unexpected shape: ${JSON.stringify(result)}`);
  }

  const tile = page.locator('[data-testid="diff-review-tile"]').first();
  await tile.waitFor({ timeout: 20000 });

  const monaco = tile.locator('[data-testid="diff-review-monaco"] .monaco-editor').first();
  await monaco.waitFor({ timeout: 30000 });

  const title = tile.locator('[data-testid="diff-review-chunk-title"]').first();
  await title.waitFor({ timeout: 10000 });
  const titleText = (await title.textContent()) ?? "";
  if (!titleText.toLowerCase().includes("retry") && !titleText.toLowerCase().includes("jwt")) {
    throw new Error(`Expected the first chunk title to include retry/JWT, got: ${titleText}`);
  }

  const counter = tile.locator('[data-testid="diff-review-counter"]').first();
  await counter.waitFor({ timeout: 5000 });

  await screenshot("diff-review-active-chunk");

  // Add a comment via the input + button so the comments pane proves out.
  const input = tile.locator('[data-testid="diff-review-comment-input"]').first();
  await input.fill("CDP probe: consider exposing the retry budget via config.");
  await tile.locator('[data-testid="diff-review-add-comment"]').first().click();
  await page.waitForTimeout(400);
  const commentsList = tile.locator('[data-testid="diff-review-comments-list"]').first();
  const commentCount = await commentsList.locator("li, > div").count().catch(() => 0);
  if (commentCount === 0) {
    // Fallback selector — comments-list children
    const anyComment = await tile.locator('[data-testid^="diff-review-comment-"]').count();
    if (anyComment === 0) throw new Error("Comment was not rendered in the comments list");
  }

  await screenshot("diff-review-with-comment");

  await verifyNoConsoleErrors(page);
}
