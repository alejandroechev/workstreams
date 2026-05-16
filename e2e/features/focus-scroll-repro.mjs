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

// Read xterm's internal buffer scroll position via .xterm-rows content snapshot.
// In v6 the .xterm-screen content REPLACES (not scrolls) so we sample what's
// rendered before and after wheel to detect a real scroll.
function readVisibleRows(page, tileId) {
  return page.evaluate((id) => {
    const tile = document.querySelector(`[data-tile-id="${id}"]`);
    if (!tile) return null;
    const rows = Array.from(tile.querySelectorAll('.xterm-rows > div'));
    const first = rows[0]?.textContent ?? '';
    const last = rows[rows.length - 1]?.textContent ?? '';
    return { count: rows.length, first, last };
  }, tileId);
}

async function clickWorkstreamByName(page, name) {
  const coords = await page.evaluate((n) => {
    const el = Array.from(document.querySelectorAll('[data-testid="workstream-item"]'))
      .find((e) => new RegExp(n).test(e.textContent ?? ''));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + 20, y: r.y + 20, id: el.getAttribute('data-workstream-id') };
  }, name);
  if (!coords) throw new Error(`Workstream '${name}' not found`);
  await page.mouse.click(coords.x, coords.y);
  return coords.id;
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
  await clickWorkstreamByName(page, 'Showcase');
  await page.waitForTimeout(800);
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

  // STEP 3: Wheel diagnostics — measure by rendered-rows change, not by
  // scrollHeight/scrollTop (xterm v6 uses virtual scroll so those are static).
  const rowsBefore = await readVisibleRows(page, showcaseTermId);
  const wheelTargets = [
    `[data-tile-id="${showcaseTermId}"]`,
    `[data-tile-id="${showcaseTermId}"] .xterm-scrollable-element`,
    `[data-tile-id="${showcaseTermId}"] .xterm-screen`,
  ];
  const wheelResults = [];
  for (const sel of wheelTargets) {
    const before = await readVisibleRows(page, showcaseTermId);
    await dispatchWheel(page, sel, -240);
    await page.waitForTimeout(300);
    const after = await readVisibleRows(page, showcaseTermId);
    wheelResults.push({
      target: sel,
      firstRowChanged: before?.first !== after?.first,
      lastRowChanged: before?.last !== after?.last,
      before, after,
    });
  }
  const tileRect = await page.evaluate((id) => {
    const r = document.querySelector(`[data-tile-id="${id}"]`)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, showcaseTermId);
  let mouseWheelChange = null;
  if (tileRect) {
    const before = await readVisibleRows(page, showcaseTermId);
    await page.mouse.move(tileRect.x + tileRect.w / 2, tileRect.y + tileRect.h / 2);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(400);
    const after = await readVisibleRows(page, showcaseTermId);
    mouseWheelChange = { firstRowChanged: before?.first !== after?.first, before, after };
  }
  log('wheel-results', { rowsBefore, wheelResults, mouseWheelChange });
  await screenshot('04-after-wheel-tests');

  // STEP 4: Switch to Sandbox via sidebar click (matches user workflow).
  const sandboxWsId = await clickWorkstreamByName(page, 'Sandbox');
  await page.waitForTimeout(1500);
  const stateAfterSandbox = await probeFocusState(page);
  log('after-click-sandbox', { sandboxWsId, ...stateAfterSandbox });
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
  const showcaseBackId = await clickWorkstreamByName(page, 'Showcase');
  log('clicked-showcase-back', { showcaseBackId });
  // Poll focus state over the next second to see if/when focus lands on textarea.
  const focusTimeline = [];
  for (const ms of [50, 200, 500, 1000, 1500, 2000]) {
    await page.waitForTimeout(ms - (focusTimeline.at(-1)?._ms ?? 0));
    const snap = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      cls: document.activeElement?.className?.toString?.(),
      tileCount: document.querySelectorAll('[data-tile-id]').length,
      txtCount: document.querySelectorAll('.xterm-helper-textarea').length,
    }));
    focusTimeline.push({ _ms: ms, ...snap });
  }
  log('focus-timeline-after-switch', focusTimeline);
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
    issue2_wheel_changed_visible_rows: wheelResults.some((r) => r.firstRowChanged || r.lastRowChanged),
    issue2_mouse_wheel_changed_rows: mouseWheelChange?.firstRowChanged ?? null,
  };
  log('summary', report.summary);

  const reportDir = path.join('screenshots', 'focus-scroll-repro');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`[probe] wrote ${path.join(reportDir, 'report.json')}`);
  await screenshot('99-final');
}
