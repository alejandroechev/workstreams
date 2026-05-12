#!/usr/bin/env node
/**
 * cdp-validate.mjs
 *
 * Connect to the running Tauri app via Chrome DevTools Protocol,
 * take a screenshot, and verify the console is free of errors.
 *
 * Usage:
 *   node scripts/cdp-validate.mjs [feature-name]
 *
 * Exit codes:
 *   0 — Validation passed
 *   1 — CDP not reachable (Tauri not running)
 *   2 — Console errors found
 *   3 — Screenshot failed
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CDP_URL = "http://localhost:9222";
const SCREENSHOT_DIR = "screenshots";
const featureName = process.argv[2] || "validation";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const screenshotPath = join(SCREENSHOT_DIR, `${featureName}-${timestamp}.png`);

mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`❌ Could not connect to CDP at ${CDP_URL}`);
    console.error(`   Make sure 'cargo tauri dev' or the built app is running.`);
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error("❌ No browser contexts found");
    process.exit(1);
  }
  const pages = contexts[0].pages();
  if (pages.length === 0) {
    console.error("❌ No pages found in context");
    process.exit(1);
  }
  const page = pages[0];

  // Collect console errors
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });

  // Wait briefly to collect any pending console output
  await page.waitForTimeout(1000);

  // Take screenshot
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`✅ Screenshot saved: ${screenshotPath}`);
  } catch (err) {
    console.error(`❌ Screenshot failed: ${err.message}`);
    await browser.close();
    process.exit(3);
  }

  // Save metadata
  const metadataPath = screenshotPath.replace(/\.png$/, ".meta.json");
  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        feature: featureName,
        timestamp,
        consoleErrors,
        passed: consoleErrors.length === 0,
      },
      null,
      2
    )
  );

  await browser.close();

  if (consoleErrors.length > 0) {
    console.error(`❌ ${consoleErrors.length} console error(s) found:`);
    for (const err of consoleErrors) {
      console.error(`   ${err}`);
    }
    process.exit(2);
  }

  console.log(`✅ Validation passed (0 console errors)`);
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
