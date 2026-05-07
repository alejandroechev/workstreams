const { chromium } = require("@playwright/test");

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = browser.contexts()[0].pages()[0];

  await page.waitForTimeout(2000);

  const state = await page.evaluate(() => {
    return {
      bodyText: document.body.innerText.substring(0, 500),
    };
  });
  console.log("Body text:", state.bodyText);

  // Check console errors
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  await page.waitForTimeout(1000);
  if (logs.length) console.log("Console:", logs);

  // Take screenshot
  await page.screenshot({ path: "screenshots/debug-projects.png" });
  console.log("Screenshot saved");

  await browser.close();
})().catch((e) => console.error(e.message));
