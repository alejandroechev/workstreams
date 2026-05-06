const { chromium } = require("@playwright/test");

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const tauriPage = browser.contexts()[0].pages()[0];

  // Collect ALL console output
  const logs = [];
  tauriPage.on("console", msg => logs.push(`[${msg.type()}] ${msg.text()}`));

  console.log("=== Connected to Tauri app ===");
  await tauriPage.screenshot({ path: "screenshots/bug-01-initial.png" });

  // Step 1: Create workstream via sidebar
  await tauriPage.click('button:text("+ New Workstream")');
  await tauriPage.waitForTimeout(500);
  await tauriPage.fill('input[placeholder="Workstream name"]', "debug-ws");
  await tauriPage.click('button:text("Create")');
  await tauriPage.waitForTimeout(1000);
  await tauriPage.screenshot({ path: "screenshots/bug-02-ws-created.png" });
  console.log("Step 1: Workstream created");

  // Step 2: Add code viewer tile via keyboard
  await tauriPage.click("body", { position: { x: 700, y: 400 } });
  await tauriPage.waitForTimeout(300);
  await tauriPage.keyboard.press("c");
  await tauriPage.waitForTimeout(1000);
  await tauriPage.screenshot({ path: "screenshots/bug-03-code-tile.png" });
  console.log("Step 2: Code tile added");

  // Step 3: Type file path in the input
  const input = tauriPage.locator('input[placeholder*="path"]').first();
  const inputVisible = await input.isVisible().catch(() => false);
  console.log("Step 3: Input visible:", inputVisible);

  if (!inputVisible) {
    console.log("ABORT: No file path input found");
    await browser.close();
    return;
  }

  await input.click();
  await tauriPage.waitForTimeout(200);

  // Type character by character to see if keys get swallowed
  await input.fill("C:\\Local\\Code\\ai-tools\\agent-manager\\README.md");
  await tauriPage.waitForTimeout(300);

  const inputValue = await input.inputValue();
  console.log("Step 3: Input value after fill:", inputValue);
  await tauriPage.screenshot({ path: "screenshots/bug-04-path-filled.png" });

  // Step 4: Find and examine the Open button
  const allButtons = await tauriPage.locator("button").all();
  console.log("Step 4: Total buttons on page:", allButtons.length);
  for (let i = 0; i < allButtons.length; i++) {
    const text = await allButtons[i].textContent();
    const visible = await allButtons[i].isVisible();
    const box = await allButtons[i].boundingBox().catch(() => null);
    console.log(`  Button ${i}: "${text}" visible=${visible} box=${JSON.stringify(box)}`);
  }

  // Step 5: Click the Open button and watch what happens
  logs.length = 0;
  const openBtn = tauriPage.locator('button:text("Open")').first();
  const btnBox = await openBtn.boundingBox();
  console.log("Step 5: Open button box:", JSON.stringify(btnBox));

  // Try click via coordinates to bypass any event interception
  if (btnBox) {
    await tauriPage.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
  }
  await tauriPage.waitForTimeout(3000);
  
  console.log("Step 5: Console after click:", logs);
  await tauriPage.screenshot({ path: "screenshots/bug-05-after-click.png" });

  // Step 6: Check DOM state
  const state = await tauriPage.evaluate(() => {
    const monaco = document.querySelector(".monaco-editor");
    const errEls = document.querySelectorAll('[style*="f38ba8"]');
    const forms = document.querySelectorAll("form");
    const inputs = document.querySelectorAll('input[type="text"]');
    return {
      monacoExists: !!monaco,
      errorElements: Array.from(errEls).map(e => e.textContent),
      formCount: forms.length,
      inputCount: inputs.length,
      bodyText: document.body.innerText.substring(0, 500),
    };
  });
  console.log("Step 6: DOM state:", JSON.stringify(state, null, 2));

  // Step 7: If button didn't work, try Enter key
  if (!state.monacoExists && state.formCount > 0) {
    console.log("Step 7: Trying Enter key on input...");
    await input.focus();
    await tauriPage.keyboard.press("Enter");
    await tauriPage.waitForTimeout(3000);
    const state2 = await tauriPage.evaluate(() => ({
      monacoExists: !!document.querySelector(".monaco-editor"),
    }));
    console.log("Step 7: Monaco after Enter:", state2.monacoExists);
    await tauriPage.screenshot({ path: "screenshots/bug-06-after-enter.png" });
  }

  await browser.close();
  console.log("=== Done ===");
})().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
