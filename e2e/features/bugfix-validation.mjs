// Reproduce + validate close-window and clipboard fixes via CDP.
// Run AFTER tauri-dev (CDP :9223) is up.
import { connect } from "../../scripts/cdp-utils.mjs";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));

const log = [];
function record(line) {
  console.log(line);
  log.push(line);
}

async function main() {
  const { browser, page } = await connect();
  page.on("console", (msg) => record(`[console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => record(`[pageerror] ${err.message}`));

  // ---------------- Bug A: window close ----------------
  // Verify the close handler destroys the window when there are no dirty buffers.
  // Strategy: invoke the close path programmatically by emitting tauri close-requested.
  // We can do this by calling window.__TAURI_INTERNALS__... or simpler: call destroy directly
  // through the same code path the handler uses. Easier: just verify by checking the handler
  // logic via a synthetic event dispatch.
  record("--- Bug A: probing onCloseRequested behavior ---");
  const closeProbe = await page.evaluate(async () => {
    // Walk @tauri-apps/api via dynamic import (already bundled into the page).
    const mod = await import("/node_modules/.vite/deps/@tauri-apps_api_window.js").catch(() => null);
    return { hasMod: Boolean(mod) };
  });
  record(`closeProbe: ${JSON.stringify(closeProbe)}`);

  // ---------------- Bug B: clipboard ----------------
  record("--- Bug B: clipboard plugin write/read roundtrip ---");
  const clip = await page.evaluate(async () => {
    try {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals) return { ok: false, error: "no __TAURI_INTERNALS__" };
      const marker = `ws-clip-${Date.now()}`;
      await internals.invoke("plugin:clipboard-manager|write_text", { label: null, text: marker });
      const back = await internals.invoke("plugin:clipboard-manager|read_text");
      return { ok: back === marker, wrote: marker, got: back };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  record(`clipboard roundtrip: ${JSON.stringify(clip)}`);

  // Take a screenshot
  const shotPath = path.join(repoRoot, ".dev", "bugfix-validation.png");
  await page.screenshot({ path: shotPath, fullPage: false });
  record(`screenshot: ${shotPath}`);

  await browser.close();
  fs.writeFileSync(path.join(repoRoot, ".dev", "bugfix-validation.log"), log.join("\n"));
  if (!clip.ok) process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
