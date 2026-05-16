// Exploration protocol for issues:
//  (1) After switching workstreams, the session/terminal tile claims focus
//      visually but keystrokes don't reach the PTY.
//  (2) Mouse wheel scrolling on terminal/session history is intermittent.
//
// Produces a diagnostic report at screenshots/focus-scroll-repro/report.json.

import fs from "node:fs";
import path from "node:path";

function probeFocusState(page) {
  return page.evaluate(() => {
    const ae = document.activeElement;
    const focusedTile = document.querySelector('[data-tile-id]:focus-within');
    const xtermTextareas = Array.from(document.querySelectorAll('.xterm-helper-textarea'));
    const xtermViewports = Array.from(document.querySelectorAll('.xterm-viewport'));
    return {
      activeElement: ae ? {
        tagName: ae.tagName,
        className: ae.className?.toString?.() ?? '',
        ariaLabel: ae.getAttribute?.('aria-label') ?? null,
        closestTileId: ae.closest?.('[data-tile-id]')?.getAttribute?.('data-tile-id') ?? null,
      } : null,
      focusedTileId: focusedTile?.getAttribute('data-tile-id') ?? null,
      xtermTextareaCount: xtermTextareas.length,
      xtermTextareaFocused: xtermTextareas.some((el) => document.activeElement === el),
      xtermViewports: xtermViewports.map((v) => ({
        scrollTop: v.scrollTop,
        scrollHeight: v.scrollHeight,
        clientHeight: v.clientHeight,
        canScroll: v.scrollHeight > v.clientHeight,
      })),
      tileIds: Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id')),
    };
  });
}

function readTerminalContent(page, tileId) {
  return page.evaluate((id) => {
    const tile = document.querySelector(`[data-tile-id="${id}"]`);
    if (!tile) return null;
    const rows = Array.from(tile.querySelectorAll('.xterm-rows > div'));
    return rows.map((r) => r.textContent ?? '').join('\n').replace(/\s+$/g, '');
  }, tileId);
}

function getViewport(page, tileId) {
  return page.evaluate((id) => {
    const tile = document.querySelector(`[data-tile-id="${id}"]`);
    if (!tile) return null;
    const v = tile.querySelector('.xterm-viewport');
    if (!v) return null;
    return {
      scrollTop: v.scrollTop,
      scrollHeight: v.scrollHeight,
      clientHeight: v.clientHeight,
    };
  }, tileId);
}

async function dispatchWheel(page, selector, deltaY) {
  return await page.evaluate(
    ({ sel, dy }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
      return true;
    },
    { sel: selector, dy: deltaY },
  );
}

async function waitForPrompt(page, tileId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await readTerminalContent(page, tileId);
    if (content && /\]?>\s*$/m.test(content)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

export async function run({ page, screenshot }) {
  const report = { steps: [], summary: {} };
  const log = (event, data = {}) => {
    report.steps.push({ t: new Date().toISOString(), event, ...data });
    console.log(`[probe] ${event}`, JSON.stringify(data));
  };

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);

  // STEP 1: Select Showcase, add terminal if none, wait for prompt.
  await page.locator('[data-testid="workstream-item"]', { hasText: 'Showcase' }).first().click();
  await page.waitForTimeout(400);
  let tileIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'))
  );
  if (tileIds.length === 0) {
    await page.locator('button', { hasText: /\+\s*Terminal/i }).first().click();
    await page.waitForTimeout(1500);
    tileIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'))
    );
  }
  const showcaseTermId = tileIds[0];
  const promptReady = await waitForPrompt(page, showcaseTermId);
  log('showcase-ready', { showcaseTermId, promptReady });
  await screenshot('01-showcase-ready');

  // STEP 2: Baseline type.
  await page.keyboard.type('echo HELLO_BASELINE', { delay: 30 });
  await page.waitForTimeout(700);
  const afterBaseline = await readTerminalContent(page, showcaseTermId);
  const baselineEchoed = (afterBaseline || '').includes('HELLO_BASELINE');
  log('baseline-typed', { baselineEchoed, afterTail: (afterBaseline || '').slice(-200) });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await screenshot('02-baseline-typed');

  // Generate scrollback.
  await page.keyboard.type('1..80 | % { "scrollback line $_" }');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await screenshot('03-scrollback-generated');

  // STEP 3: Wheel diagnostics.
  const vpBefore = await getViewport(page, showcaseTermId);
  const wheelTargets = [
    `[data-tile-id="${showcaseTermId}"]`,
    `[data-tile-id="${showcaseTermId}"] .xterm-viewport`,
    `[data-tile-id="${showcaseTermId}"] .xterm-screen`,
  ];
  const wheelResults = [];
  for (const sel of wheelTargets) {
    const before = await getViewport(page, showcaseTermId);
    await dispatchWheel(page, sel, -240);
    await page.waitForTimeout(250);
    const after = await getViewport(page, showcaseTermId);
    wheelResults.push({ target: sel, scrollTopDelta: (after?.scrollTop ?? -1) - (before?.scrollTop ?? -1), before, after });
  }
  const tileRect = await page.evaluate((id) => {
    const r = document.querySelector(`[data-tile-id="${id}"]`)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, showcaseTermId);
  let mouseWheelDelta = null;
  if (tileRect) {
    const before = await getViewport(page, showcaseTermId);
    await page.mouse.move(tileRect.x + tileRect.w / 2, tileRect.y + tileRect.h / 2);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(400);
    const after = await getViewport(page, showcaseTermId);
    mouseWheelDelta = (after?.scrollTop ?? -1) - (before?.scrollTop ?? -1);
  }
  // xterm viewport sizer details
  const viewportSizer = await page.evaluate((id) => {
    const v = document.querySelector(`[data-tile-id="${id}"] .xterm-viewport`);
    if (!v) return null;
    const child = v.firstElementChild;
    return child ? {
      childTag: child.tagName,
      childStyleHeight: child.style?.height ?? null,
      childOffsetHeight: child.offsetHeight,
    } : { childTag: null };
  }, showcaseTermId);
  log('wheel-results', { vpBefore, wheelResults, mouseWheelDelta, viewportSizer });
  await screenshot('04-after-wheel-tests');

  // STEP 4: Switch to Sandbox via sidebar click (matches user workflow).
  await page.locator('[data-testid="workstream-item"]', { hasText: 'Sandbox' }).first().click();
  await page.waitForTimeout(1500);
  log('after-click-sandbox', await probeFocusState(page));
  await screenshot('05-after-click-sandbox');

  let sandboxTiles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'))
  );
  if (sandboxTiles.length === 0) {
    await page.locator('button', { hasText: /\+\s*Terminal/i }).first().click();
    await page.waitForTimeout(1500);
    sandboxTiles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'))
    );
  }
  const sandboxTermId = sandboxTiles[0];
  await waitForPrompt(page, sandboxTermId);
  await screenshot('06-sandbox-ready');

  // Type a marker into Sandbox.
  await page.keyboard.type('echo I_AM_SANDBOX', { delay: 30 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);

  // STEP 5: Switch back to Showcase via sidebar — THE BUG SCENARIO.
  await page.locator('[data-testid="workstream-item"]', { hasText: 'Showcase' }).first().click();
  await page.waitForTimeout(1500);
  const stateAfterSwitch = await probeFocusState(page);
  log('after-click-showcase-back', stateAfterSwitch);
  await screenshot('07-after-click-back-to-showcase');

  // Confirm the visible terminal is Showcase's (not Sandbox's).
  const visibleAfterSwitch = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'))
  );
  log('visible-tiles-after-switch', { ids: visibleAfterSwitch, showcaseTermId, sandboxTermId });

  // Now try typing — the bug: cursor visible but input doesn't reach PTY.
  const beforeSwitch = await readTerminalContent(page, showcaseTermId);
  await page.keyboard.type('SWITCH_BACK_MARKER_XYZ', { delay: 30 });
  await page.waitForTimeout(800);
  const afterSwitch = await readTerminalContent(page, showcaseTermId);
  const switchProbeEchoed = (afterSwitch || '').includes('SWITCH_BACK_MARKER_XYZ');
  log('switch-back-type', {
    switchProbeEchoed,
    beforeLen: beforeSwitch?.length ?? 0,
    afterLen: afterSwitch?.length ?? 0,
    afterTail: (afterSwitch || '').slice(-200),
    activeAtType: await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      cls: document.activeElement?.className?.toString?.(),
      closestTileId: document.activeElement?.closest?.('[data-tile-id]')?.getAttribute?.('data-tile-id'),
    })),
  });
  await screenshot('08-after-switch-back-type');

  // STEP 6: Workaround — click the tile and retry.
  await page.locator(`[data-tile-id="${showcaseTermId}"]`).click();
  await page.waitForTimeout(400);
  await page.keyboard.type('AFTER_CLICK_MARKER_XYZ', { delay: 30 });
  await page.waitForTimeout(600);
  const afterClick = await readTerminalContent(page, showcaseTermId);
  const clickEchoed = (afterClick || '').includes('AFTER_CLICK_MARKER_XYZ');
  log('after-click-tile-and-type', { clickEchoed, afterTail: (afterClick || '').slice(-200) });
  await screenshot('09-after-click-and-type');

  report.summary = {
    issue1_baseline_typing_works: baselineEchoed,
    issue1_after_workstream_switch_typing_works: switchProbeEchoed,
    issue1_clicking_recovers: clickEchoed,
    issue2_viewport_can_scroll: (vpBefore?.scrollHeight ?? 0) > (vpBefore?.clientHeight ?? 0),
    issue2_viewport_metrics: vpBefore,
    issue2_wheel_responding_target: wheelResults.find((r) => r.scrollTopDelta < 0)?.target ?? null,
    issue2_mouse_wheel_api_delta: mouseWheelDelta,
  };
  log('summary', report.summary);

  const reportDir = path.join('screenshots', 'focus-scroll-repro');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`[probe] wrote ${path.join(reportDir, 'report.json')}`);
  await screenshot('99-final');
}
