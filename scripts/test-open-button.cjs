const { chromium } = require("@playwright/test");

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const tauriPage = contexts[0].pages()[0];
  console.log("Title:", await tauriPage.title());

  // Collect console errors
  const errors = [];
  tauriPage.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  // Create a workstream
  await tauriPage.click('button:text("+ New Workstream")');
  await tauriPage.waitForTimeout(500);
  await tauriPage.fill('input[placeholder="Workstream name"]', "test-ws");
  await tauriPage.click('button:text("Create")');
  await tauriPage.waitForTimeout(1000);
  console.log("Workstream created");

  // Add code viewer tile
  await tauriPage.click("body", { position: { x: 700, y: 400 } });
  await tauriPage.waitForTimeout(300);
  await tauriPage.keyboard.press("c");
  await tauriPage.waitForTimeout(1000);
  console.log("Code viewer tile added");

  // Fill path
  const input = tauriPage.locator('input[placeholder*="path"]').first();
  await input.click();
  await input.fill("C:\\Local\\Code\\ai-tools\\agent-manager\\README.md");
  await tauriPage.waitForTimeout(500);
  console.log("Path filled");

  // Debug: check the current state of the tile
  const tileHTML = await tauriPage.evaluate(() => {
    // Find the code viewer tile content area
    const forms = document.querySelectorAll("form");
    return Array.from(forms).map(f => ({
      action: f.action,
      innerHTML: f.innerHTML.substring(0, 200),
      parentHTML: f.parentElement?.className || "no-parent",
    }));
  });
  console.log("Forms found:", JSON.stringify(tileHTML, null, 2));

  // Try clicking the button and capture what happens
  errors.length = 0;
  const openBtn = tauriPage.locator('button:text("Open")').first();
  console.log("Button boundingBox:", JSON.stringify(await openBtn.boundingBox()));
  
  // Click it
  await openBtn.click({ force: true });
  await tauriPage.waitForTimeout(3000);

  console.log("Errors after click:", errors);

  // Check page state
  const pageState = await tauriPage.evaluate(() => {
    const monaco = document.querySelector(".monaco-editor");
    const errorEl = document.querySelector('[style*="f38ba8"]');
    const inputs = document.querySelectorAll('input[type="text"]');
    return {
      monacoExists: !!monaco,
      errorText: errorEl?.textContent || null,
      inputCount: inputs.length,
      inputValues: Array.from(inputs).map(i => i.value),
    };
  });
  console.log("Page state after click:", JSON.stringify(pageState, null, 2));

  await tauriPage.screenshot({ path: "screenshots/debug-after-open.png" });

  await browser.close();
  console.log("Done");
})().catch(e => {
  console.error("Test failed:", e.message);
  process.exit(1);
});
