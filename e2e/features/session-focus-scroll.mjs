// Repro for COPILOT SESSION TILES (not plain terminals).
//
// Sessions use the alternate buffer (TUI rendered by agency/ink). Behavior
// expected:
//   - On workstream switch, the helper textarea inside the visible session
//     tile should regain focus so typing reaches the PTY/agency input.
//   - Mouse wheel over the conversation log should scroll through history,
//     matching what PgUp/PgDn already do (user confirmed those work).
//
// We probe both, with sessions in two workstreams (Showcase + Sandbox).

import fs from "node:fs";
import path from "node:path";

function snapshot(page) {
  return page.evaluate(() => {
    const ae = document.activeElement;
    const tiles = Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => ({
      id: t.getAttribute('data-tile-id'),
      rect: (() => { const r = t.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    }));
    return {
      active: {
        tag: ae?.tagName,
        cls: ae?.className?.toString?.()?.slice(0, 60) ?? '',
        closestTile: ae?.closest?.('[data-tile-id]')?.getAttribute?.('data-tile-id') ?? null,
      },
      tiles,
      txtCount: document.querySelectorAll('.xterm-helper-textarea').length,
    };
  });
}

function readRows(page, tileId) {
  return page.evaluate((id) => {
    const tile = document.querySelector(`[data-tile-id="${id}"]`);
    if (!tile) return null;
    const rows = Array.from(tile.querySelectorAll('.xterm-rows > div'));
    return {
      count: rows.length,
      first: rows[0]?.textContent ?? '',
      last: rows[rows.length - 1]?.textContent ?? '',
      slice5: rows.slice(0, 5).map((r) => r.textContent ?? '').join(' | '),
    };
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

async function waitForSessionReady(page, tileId, timeoutMs = 30_000) {
  // agency copilot prints a welcome banner with "Copilot" somewhere.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await readRows(page, tileId);
    const text = (rows?.first ?? '') + ' ' + (rows?.last ?? '') + ' ' + (rows?.slice5 ?? '');
    if (/Copilot|copilot|github\.com|>/i.test(text)) return rows;
    await page.waitForTimeout(500);
  }
  return null;
}

async function ensureSessionTile(page, wsName) {
  await clickWorkstreamByName(page, wsName);
  await page.waitForTimeout(800);
  let tiles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'))
  );
  if (tiles.length === 0) {
    // Click "+ Session" — this may open a SessionPicker modal asking
    // "Open existing" vs "New session". Click + Session, then if a modal
    // appears with "New Session", click that.
    await page.locator('button', { hasText: /\+\s*Session/i }).first().click({ force: true });
    await page.waitForTimeout(700);
    const newSessionBtn = page.locator('button', { hasText: /New Session/i }).first();
    if (await newSessionBtn.count()) {
      await newSessionBtn.click({ force: true });
      await page.waitForTimeout(1500);
    }
    tiles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'))
    );
  }
  return tiles[0];
}

export async function run({ page, screenshot }) {
  const report = { steps: [], summary: {} };
  const log = (event, data = {}) => {
    report.steps.push({ t: new Date().toISOString(), event, ...data });
    console.log(`[probe] ${event}`, JSON.stringify(data));
  };

  await page.waitForLoadState('domcontentloaded');
  // Reload to ensure any DB seeding done after page load is reflected.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  log('page-loaded');

  // Wait until at least one workstream item appears (up to 10s).
  for (let i = 0; i < 20; i++) {
    const count = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="workstream-item"]').length
    );
    if (count >= 2) break;
    await page.waitForTimeout(500);
  }

  // STEP 1: Showcase session
  const showcaseSession = await ensureSessionTile(page, 'Showcase');
  log('showcase-session-tile', { id: showcaseSession });
  const showcaseReady = await waitForSessionReady(page, showcaseSession);
  log('showcase-session-ready', { ready: !!showcaseReady, lastRow: showcaseReady?.last ?? null });
  await screenshot('01-showcase-session-ready');

  // STEP 2: Baseline type — does the session receive keystrokes?
  const beforeBaseline = await readRows(page, showcaseSession);
  await page.keyboard.type('hello from probe', { delay: 30 });
  await page.waitForTimeout(800);
  const afterBaseline = await readRows(page, showcaseSession);
  const baselineEchoed =
    (afterBaseline?.last ?? '').includes('hello from probe') ||
    (afterBaseline?.slice5 ?? '').includes('hello from probe');
  log('baseline-typed', {
    baselineEchoed,
    beforeLast: beforeBaseline?.last,
    afterLast: afterBaseline?.last,
  });
  await screenshot('02-baseline-typed');

  // Clear via Ctrl+U / Backspace so we don't accidentally submit.
  for (let i = 0; i < 30; i++) await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);

  // STEP 3: Wheel diagnostics. Sessions are in alternate-buffer mode, so
  // .xterm-rows scrollback is empty — visible row text should change as the
  // app re-renders its TUI when we scroll. We compare row snapshots.
  const rowsBeforeWheel = await readRows(page, showcaseSession);
  // Try wheel on each candidate target.
  const wheelResults = [];
  for (const sel of [
    `[data-tile-id="${showcaseSession}"]`,
    `[data-tile-id="${showcaseSession}"] .xterm-scrollable-element`,
    `[data-tile-id="${showcaseSession}"] .xterm-screen`,
  ]) {
    const before = await readRows(page, showcaseSession);
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
    }, sel);
    await page.waitForTimeout(400);
    const after = await readRows(page, showcaseSession);
    wheelResults.push({
      target: sel,
      firstChanged: before?.first !== after?.first,
      lastChanged: before?.last !== after?.last,
      slice5Changed: before?.slice5 !== after?.slice5,
      after: after?.slice5?.slice(0, 200),
    });
  }
  log('wheel-results', { rowsBeforeWheel: rowsBeforeWheel?.slice5?.slice(0, 200), wheelResults });

  // Also: real PgUp/PgDn (user says these work) — verify our baseline.
  const beforePg = await readRows(page, showcaseSession);
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(400);
  const afterPgUp = await readRows(page, showcaseSession);
  const pgUpChangedRows = beforePg?.slice5 !== afterPgUp?.slice5;
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(400);
  log('pgup-baseline', {
    pgUpChangedRows,
    beforePg5: beforePg?.slice5?.slice(0, 150),
    afterPgUp5: afterPgUp?.slice5?.slice(0, 150),
  });
  await screenshot('03-after-wheel-tests');

  // STEP 4: Switch to Sandbox + ensure a session tile there.
  const sandboxSession = await ensureSessionTile(page, 'Sandbox');
  log('sandbox-session-tile', { id: sandboxSession });
  await waitForSessionReady(page, sandboxSession);
  await page.waitForTimeout(800);
  await screenshot('04-sandbox-session');

  // STEP 5: Switch back to Showcase — focus should restore to session textarea.
  await clickWorkstreamByName(page, 'Showcase');
  const focusTimeline = [];
  for (const ms of [50, 200, 500, 1000, 1500, 2500, 4000]) {
    await page.waitForTimeout(ms - (focusTimeline.at(-1)?._ms ?? 0));
    const s = await snapshot(page);
    focusTimeline.push({ _ms: ms, ...s.active, tiles: s.tiles.length, txt: s.txtCount });
  }
  log('focus-timeline-after-switch', focusTimeline);
  await screenshot('05-after-switch-back');

  // STEP 6: Try typing — does it reach the session PTY?
  const beforeSwitchType = await readRows(page, showcaseSession);
  await page.keyboard.type('after_switch_probe', { delay: 30 });
  await page.waitForTimeout(900);
  const afterSwitchType = await readRows(page, showcaseSession);
  const switchEchoed =
    (afterSwitchType?.last ?? '').includes('after_switch_probe') ||
    (afterSwitchType?.slice5 ?? '').includes('after_switch_probe');
  log('switch-back-type', {
    switchEchoed,
    beforeLast: beforeSwitchType?.last,
    afterLast: afterSwitchType?.last,
  });
  await screenshot('06-after-switch-type');

  // Clear input
  for (let i = 0; i < 30; i++) await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);

  // STEP 7: Click recovery
  await page.locator(`[data-tile-id="${showcaseSession}"]`).click();
  await page.waitForTimeout(400);
  await page.keyboard.type('after_click_probe', { delay: 30 });
  await page.waitForTimeout(800);
  const afterClick = await readRows(page, showcaseSession);
  const clickEchoed =
    (afterClick?.last ?? '').includes('after_click_probe') ||
    (afterClick?.slice5 ?? '').includes('after_click_probe');
  log('after-click', { clickEchoed });
  for (let i = 0; i < 30; i++) await page.keyboard.press('Backspace');

  await screenshot('99-final');

  report.summary = {
    session_baseline_typing_works: baselineEchoed,
    session_after_switch_typing_works: switchEchoed,
    session_click_recovers: clickEchoed,
    wheel_changed_rows: wheelResults.some((r) => r.firstChanged || r.lastChanged || r.slice5Changed),
    pgup_changed_rows: pgUpChangedRows,
  };
  log('summary', report.summary);

  const reportDir = path.join('screenshots', 'session-focus-scroll');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`[probe] wrote ${path.join(reportDir, 'report.json')}`);
}
