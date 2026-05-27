// CDP probe for OSC 52 → clipboard.
// Strategy: we don't need a real PTY. We grab any rendered xterm Terminal
// instance and call term.write("\x1b]52;c;<base64>\x07") — that's exactly
// what a TUI like Copilot CLI emits to copy to the host clipboard. If our
// registered OSC 52 handler works, the clipboard should contain the
// decoded text after a short flush delay.

import { connect, captureErrors } from "../../scripts/cdp-utils.mjs";

const MARKER = `ws-osc52-${Date.now()}`;
const b64 = Buffer.from(MARKER, "utf-8").toString("base64");

const { browser, page } = await connect();
const errors = captureErrors(page);

try {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, { timeout: 10000 });

  // Find an xterm Terminal instance hanging off any xterm-screen DOM node.
  // xterm.js stores the Terminal reference on the helper element, but easier:
  // we can intercept the global by patching window.Terminal. Instead, the
  // simplest reliable path is to query the xterm DOM and call writeToPty?
  // Actually: we created the Terminal in CopilotSessionTile/TerminalTile but
  // didn't expose it. Cleanest workaround: temporarily monkey-patch the
  // xterm parser registration so we can probe handleOsc52 directly via the
  // imported module.

  const result = await page.evaluate(async ({ marker, b64 }) => {
    // Locate at least one xterm screen to confirm we're in the app.
    const xtermNodes = document.querySelectorAll(".xterm");
    if (xtermNodes.length === 0) {
      return { ok: false, reason: "no .xterm in DOM — open a tile first" };
    }

    // Pull the Terminal instance off the first xterm.
    // xterm.js attaches its core to the element; we read via the addon registry.
    // Easier: each xterm node has a private _core reference via the writable
    // property "terminal" on its dataset? Not reliable. So: dynamically import
    // the OSC52 handler module and call it directly to verify the round-trip.
    const mod = await import("/src/domain/osc52.ts");

    try {
      const ok = await mod.handleOsc52(`c;${b64}`);
      if (!ok) return { ok: false, reason: "handleOsc52 returned false" };
    } catch (e) {
      return { ok: false, reason: "handleOsc52 threw: " + String(e) };
    }

    const got = await window.__TAURI_INTERNALS__.invoke(
      "plugin:clipboard-manager|read_text"
    );

    return { ok: got === marker, marker, got };
  }, { marker: MARKER, b64 });

  console.log("RESULT:", JSON.stringify(result, null, 2));
  if (errors.length > 0) {
    console.log("Console errors:", errors);
  }
  if (!result.ok) {
    process.exit(1);
  }
} finally {
  await browser.close();
}
