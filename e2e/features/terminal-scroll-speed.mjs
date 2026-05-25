// CDP probe: verifies that the terminalScrollSpeed setting actually changes
// how many lines a typical precision-touchpad wheel burst scrolls.
//
// Strategy:
//   1. Open a workstream, add a Powershell tile.
//   2. Use the dev bridge `window.__wsTerm` (set on the tile container after
//      term.open) to install a spy on Terminal.scrollLines that records the
//      sum of |lines| arguments.
//   3. Set speed = 0.1, dispatch N identical small wheel events, read spy.
//   4. Set speed = 5, dispatch the same N wheel events, read spy.
//   5. Assert max-speed sum >> min-speed sum and min-speed sum is small.

const WHEEL_DELTA = 30; // typical precision-touchpad pixel delta per tick
const WHEEL_COUNT = 25; // ticks per run

export async function run({ page, screenshot }) {
  await page.waitForLoadState("domcontentloaded");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="workstream-item"]', { timeout: 15000 });
  await page.waitForTimeout(800);

  await page.locator('[data-testid="workstream-item"]').first().click();
  await page.waitForTimeout(400);
  await page.keyboard.press("Alt+p");
  await page.waitForTimeout(2000);
  await screenshot("powershell-tile-open");

  // Wait for xterm to mount and for the dev bridge to be attached.
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".xterm");
      const wrapper = el && el.parentElement;
      // __wsTerm is set on the container we passed to term.open(), which is
      // the parent of the .xterm root.
      return Boolean(
        (wrapper && wrapper.__wsTerm) ||
          (el && el.__wsTerm) ||
          document.querySelector("[data-tile-id]"),
      );
    },
    { timeout: 8000 },
  );

  // Populate scrollback so scrollLines is meaningful.
  const xterm = page.locator(".xterm").first();
  await xterm.click();
  await page.waitForTimeout(200);
  await page.keyboard.type("1..300");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await screenshot("scrollback-populated");

  // Helper running in-page: install/reset spy, run wheel burst, return spy total.
  async function runBurst(speed, deltaY, count) {
    return page.evaluate(
      async ({ speed, deltaY, count }) => {
        // Set speed via the debug bridge.
        const bridge = window.__wsAppSettings;
        if (!bridge) throw new Error("__wsAppSettings bridge missing");
        bridge.set({ terminalScrollSpeed: speed });

        // Locate the xterm container's stored term instance. We walk up from
        // every .xterm element looking for a parent with __wsTerm.
        function findTerm() {
          const candidates = document.querySelectorAll(".xterm");
          for (const el of candidates) {
            let cur = el;
            for (let i = 0; i < 5 && cur; i++) {
              if (cur.__wsTerm) return cur.__wsTerm;
              cur = cur.parentElement;
            }
          }
          return null;
        }
        const term = findTerm();
        if (!term) throw new Error("term instance not found on container");

        // Install spy on scrollLines.
        let total = 0;
        const orig = term.scrollLines.bind(term);
        term.scrollLines = (n) => {
          total += Math.abs(n);
          return orig(n);
        };

        // Also count alternate-buffer writes (write_to_pty) to capture
        // PgUp/PgDn sequences. Since we can't easily spy invoke from here,
        // we just dispatch wheel events and check term.scrollLines (normal
        // buffer mode for Powershell — alternate buffer is for TUI apps).

        const target =
          document.querySelector(".xterm-scrollable-element") ||
          document.querySelector(".xterm-screen") ||
          document.querySelector(".xterm");
        if (!target) throw new Error("no wheel target");

        for (let i = 0; i < count; i++) {
          const ev = new WheelEvent("wheel", {
            deltaY: -Math.abs(deltaY), // scroll up
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          });
          target.dispatchEvent(ev);
        }

        // Wait a tick for any async work.
        await new Promise((r) => setTimeout(r, 200));

        // Restore.
        term.scrollLines = orig;
        return total;
      },
      { speed, deltaY, count },
    );
  }

  const minTotal = await runBurst(0.1, WHEEL_DELTA, WHEEL_COUNT);
  await screenshot("after-min-speed-burst");
  const maxTotal = await runBurst(5, WHEEL_DELTA, WHEEL_COUNT);
  await screenshot("after-max-speed-burst");

  console.log(
    `[probe] min-speed total scrollLines: ${minTotal} | max-speed total: ${maxTotal} (over ${WHEEL_COUNT} wheel ticks of deltaY=${WHEEL_DELTA})`,
  );

  if (maxTotal <= minTotal) {
    throw new Error(
      `scroll-speed setting has no effect: min=${minTotal}, max=${maxTotal}. Slider must actually change behavior.`,
    );
  }
  if (maxTotal < minTotal * 5) {
    throw new Error(
      `scroll-speed setting effect too weak: min=${minTotal}, max=${maxTotal}. Expected max ≥ 5× min.`,
    );
  }
  if (minTotal >= 15) {
    throw new Error(
      `min-speed still scrolls too aggressively: ${minTotal} lines from ${WHEEL_COUNT} small wheel ticks.`,
    );
  }
  await screenshot("scroll-speed-honored");
}
