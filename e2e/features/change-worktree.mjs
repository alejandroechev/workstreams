// CDP probe for the change-worktree feature.
//
// Strategy:
//   1. Verify the kebab "Change worktree…" button exists for an active workstream
//      row in the sidebar.
//   2. Click it → the modal appears (form with switch_existing / create_new
//      radios + the current directory hint).
//   3. Without actually mutating the filesystem (no real worktree dir), validate
//      the pure-domain layer round-trips through the running app: dynamically
//      import worktree-change.ts and assert rewriteTileCwd + summarizeTilesToRestart
//      behave the same as in unit tests, executed inside the live page.
//   4. Close the modal (Esc / Cancel) and confirm clean console.
//
// This stays defensive — no real PTY restart attempted in CDP (requires a real
// worktree dir on the host). The integration is exercised in the form + backend
// vitests; this probe proves the wiring is live in the running app.

import { connect, captureErrors } from "../../scripts/cdp-utils.mjs";

const { browser, page } = await connect();
const errors = captureErrors(page);

try {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, { timeout: 10000 });

  const domainCheck = await page.evaluate(async () => {
    const mod = await import("/src/domain/worktree-change.ts");
    const config = JSON.stringify({ cwd: "C:/old", command: "pwsh" });
    const rewritten = mod.rewriteTileCwd(config, "C:/new", "terminal");
    const parsed = JSON.parse(rewritten);
    const skipped = mod.rewriteTileCwd(JSON.stringify({ foo: 1 }), "C:/new", "file_explorer");
    const summary = mod.summarizeTilesToRestart([
      { id: "a", tile_type: "terminal", config_json: "{}" },
      { id: "b", tile_type: "copilot_session", config_json: "{}" },
      { id: "c", tile_type: "file_explorer", config_json: "{}" },
    ]);
    return {
      rewrote: parsed.cwd === "C:/new" && parsed.command === "pwsh",
      preservedOthers: skipped === JSON.stringify({ foo: 1 }),
      summaryCount: summary.count,
    };
  });

  console.log("DOMAIN_IN_PAGE:", JSON.stringify(domainCheck, null, 2));
  if (!domainCheck.rewrote || !domainCheck.preservedOthers || domainCheck.summaryCount !== 2) {
    console.error("domain layer mismatch in live page");
    process.exit(1);
  }

  const buttonCheck = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[aria-label="Change worktree…"]'));
    return { count: btns.length };
  });
  console.log("BUTTON_CHECK:", JSON.stringify(buttonCheck));
  if (buttonCheck.count < 1) {
    console.error("No Change worktree… button rendered in sidebar (need at least one workstream).");
    process.exit(1);
  }

  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Change worktree…"]');
    if (btn) btn.click();
  });

  await new Promise((r) => setTimeout(r, 300));

  const modalCheck = await page.evaluate(() => {
    const hasSwitchRadio = !!Array.from(document.querySelectorAll("*")).find(
      (n) => n.textContent && n.textContent.includes("Switch Existing")
    );
    const hasCreateRadio = !!Array.from(document.querySelectorAll("*")).find(
      (n) => n.textContent && n.textContent.includes("Create new") || (n.textContent && n.textContent.includes("Create New"))
    );
    return { hasSwitchRadio, hasCreateRadio };
  });
  console.log("MODAL_CHECK:", JSON.stringify(modalCheck));
  if (!modalCheck.hasSwitchRadio || !modalCheck.hasCreateRadio) {
    console.error("Change worktree modal missing expected mode radios");
    process.exit(1);
  }

  // Close with Escape.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 200));

  if (errors.length > 0) {
    console.error("Console errors:", errors);
    process.exit(1);
  }

  console.log("RESULT: ok");
} finally {
  await browser.close();
}
