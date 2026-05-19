// CDP visual probe for the audio playback feature.
//
// Activates the seeded Showcase workstream, adds a Repo Explorer tile,
// drops the e2e/fixtures/tiny.wav into the showcase directory (the dev
// runner already mounts that directory), opens the file, and screenshots
// the player.
import fs from "node:fs";
import path from "node:path";

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  // Copy the WAV fixture into the showcase directory so the explorer
  // listing picks it up alongside the existing markdown.
  const showcaseDir = path.resolve(process.cwd(), ".dev", "showcase");
  const wavDst = path.join(showcaseDir, "tiny.wav");
  if (!fs.existsSync(wavDst)) {
    const src = path.resolve(process.cwd(), "e2e", "fixtures", "tiny.wav");
    if (fs.existsSync(src)) {
      fs.mkdirSync(showcaseDir, { recursive: true });
      fs.copyFileSync(src, wavDst);
    }
  }

  // Activate Showcase WS.
  const ws = page.locator('[data-testid="workstream-item"]').first();
  if (await ws.count()) {
    await ws.click();
    await page.waitForTimeout(500);
  }

  // Add an explorer tile.
  const addBtn = page.locator('[data-testid="add-tile-button"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(200);
    const explorer = page.locator('[data-testid="add-tile-item-explorer"]').first();
    if (await explorer.count()) await explorer.click();
    await page.waitForTimeout(1000);
  }

  await screenshot("explorer-with-audio-file");

  // Click the wav file
  const wavLink = page.getByText("tiny.wav").first();
  if (await wavLink.count()) {
    await wavLink.click();
    await page.waitForTimeout(1000);
    await screenshot("audio-player-loaded");
  } else {
    await screenshot("audio-file-not-found");
  }
}
