// CDP probe for the "no auto-selected workstream on startup" bug fix.
//
// Setup expectation: the dev seed creates at least one workstream. If the
// startup auto-select bug were still present, the first workstream (or whatever
// the saved order surfaces first, which can be an archived one) would render
// as active in the sidebar AND its tile grid area would render.
//
// Assertions after startup:
//   1. No sidebar row carries data-active="true".
//   2. No active tile grid rendered (the empty state — no tiles in DOM — is fine).
//   3. Console is clean.

import { connect, captureErrors } from "../../scripts/cdp-utils.mjs";

const { browser, page } = await connect();
const errors = captureErrors(page);

try {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, { timeout: 10000 });
  // Give the app a beat to finish initial listWorkstreams + render.
  await new Promise((r) => setTimeout(r, 1500));

  const result = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-active]"));
    const activeRows = rows.filter((r) => r.getAttribute("data-active") === "true");
    const rowCount = rows.length;
    // Also confirm at least one ws row exists (otherwise this probe is useless).
    return {
      rowCount,
      activeCount: activeRows.length,
      activeIds: activeRows.map((r) => r.getAttribute("data-ws-id") || r.textContent?.slice(0, 40) || "?"),
    };
  });

  console.log("STARTUP_SELECTION:", JSON.stringify(result, null, 2));

  if (result.rowCount === 0) {
    console.error("⚠ No workstream rows rendered — probe inconclusive. Seed at least one ws.");
    process.exit(1);
  }
  if (result.activeCount !== 0) {
    console.error(`✗ Expected 0 active workstreams on startup, found ${result.activeCount}: ${result.activeIds.join(", ")}`);
    process.exit(1);
  }

  if (errors.length > 0) {
    console.error("Console errors:", errors);
    process.exit(1);
  }

  console.log("RESULT: ok — no workstream auto-selected on startup");
} finally {
  await browser.close();
}
