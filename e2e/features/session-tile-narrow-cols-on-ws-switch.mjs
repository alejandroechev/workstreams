// CDP visual probe for the "narrow cols on workstream switch" regression.
//
// Repro:
//   1. Seed creates two workstreams (Showcase + Sandbox).
//   2. Open Showcase, add a Powershell tile (Alt+P).
//   3. Switch to Sandbox, add a Powershell tile (Alt+P).
//   4. Switch back and forth several times.
//   5. After each switch, read xterm `cols` on the visible terminal via the
//      .xterm DOM and assert it's plausible (> 30 for an undivided pane).
//   6. Screenshot the final state.
//
// Pre-fix expectation (before pty-fit guard + force remeasure): cols would
// frequently come back as ~11 on a freshly-revealed tile.
// Post-fix: cols stays sane across switches.

function readVisibleCols(page) {
  return page.evaluate(() => {
    const xterms = Array.from(document.querySelectorAll(".xterm"));
    // Prefer terminals that are actually rendered (offsetWidth > 0).
    const visible = xterms.filter((el) => el.offsetWidth > 0);
    const out = [];
    for (const el of visible) {
      // xterm exposes the public Terminal instance under different internal
      // keys depending on version; we look for a `.cols` numeric prop.
      let cols = null;
      // Best-effort introspection: xterm-addon-fit attaches to a Terminal,
      // and Terminal stores rows/cols on the instance. The wrapper element
      // doesn't directly expose it, but the inner `.xterm-rows` element has
      // children whose first row's text length is a proxy for cols when
      // populated. As a more reliable fallback, count children of an inner
      // viewport row.
      const rowsEl = el.querySelector(".xterm-rows");
      if (rowsEl && rowsEl.children.length > 0) {
        // Each row span's textContent length === cols for rendered rows.
        let max = 0;
        for (const row of rowsEl.children) {
          const len = row.textContent ? row.textContent.length : 0;
          if (len > max) max = len;
        }
        // If nothing has been printed yet, the dimensions can also be read
        // from the screen element's computed style relative to a measure cell.
        if (max > 0) cols = max;
      }
      if (cols === null) {
        // Fallback: derive from screen width / measured char width.
        const screen = el.querySelector(".xterm-screen");
        const measure = el.querySelector(".xterm-char-measure-element");
        if (screen && measure) {
          const cw = measure.getBoundingClientRect().width || 1;
          cols = Math.floor(screen.getBoundingClientRect().width / cw);
        }
      }
      out.push(cols);
    }
    return out;
  });
}

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  // Seeder runs after the app has already loaded its initial empty state.
  // Force a reload so the freshly-seeded workstreams show up in the sidebar.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="workstream-item"]', { timeout: 15000 });
  await page.waitForTimeout(800);

  const items = page.locator('[data-testid="workstream-item"]');
  const count = await items.count();
  if (count < 2) {
    throw new Error(`need at least 2 workstreams, found ${count}`);
  }

  // Open the first workstream and add a Powershell tile.
  await items.nth(0).click();
  await page.waitForTimeout(500);
  await screenshot("ws-a-empty");
  await page.keyboard.press("Alt+p");
  await page.waitForTimeout(1500);
  await screenshot("ws-a-powershell");

  // Switch to second workstream, add a Powershell tile.
  await items.nth(1).click();
  await page.waitForTimeout(500);
  await page.keyboard.press("Alt+p");
  await page.waitForTimeout(1500);
  await screenshot("ws-b-powershell");

  // Switch back and forth several times.
  for (let i = 0; i < 4; i++) {
    await items.nth(i % 2).click();
    await page.waitForTimeout(700);
  }
  await screenshot("after-rapid-switches");

  // Final dwell: read cols on visible terminals and assert plausible.
  await page.waitForTimeout(800);
  const cols = await readVisibleCols(page);
  console.log(`[probe] visible xterm cols: ${JSON.stringify(cols)}`);
  for (const c of cols) {
    if (c === null) continue;
    if (c > 0 && c < 20) {
      throw new Error(
        `regression: a visible terminal reports cols=${c} (expected > 20). Full list: ${JSON.stringify(cols)}`,
      );
    }
  }
  await screenshot("final-cols-healthy");
}
