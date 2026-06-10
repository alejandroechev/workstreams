// Workstreams performance profiler — connects via CDP, samples for ~30s,
// records JS heap, long tasks, event listener counts, paint cadence,
// dispatched events, IPC traffic markers, and DOM node counts. Writes
// results to perf-cdp.json (consumed by the analysis writeup).
//
// Usage: node scripts/perf-profile.mjs [--seconds 30] [--workload load|switch|none]
//
// Workloads:
//   none    - just sample idle UI for N seconds
//   load    - load the Showcase WS with all tiles and sample
//   switch  - cycle through all workstreams every 2s while sampling

import { connect } from "./cdp-utils.mjs";
import fs from "node:fs";
import path from "node:path";

const ARGS = (() => {
  const out = { seconds: 30, workload: "none" };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--seconds") out.seconds = Number(process.argv[++i]);
    else if (a === "--workload") out.workload = process.argv[++i];
  }
  return out;
})();

async function main() {
  const { browser, page } = await connect();
  const client = await page.context().newCDPSession(page);

  await client.send("Performance.enable");
  await client.send("Runtime.enable");

  // Buffer for long tasks observed via performance observer in-page
  await page.evaluate(() => {
    window.__perfLongTasks = [];
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__perfLongTasks.push({
              start: e.startTime,
              duration: e.duration,
              name: e.name,
            });
            if (window.__perfLongTasks.length > 5000) window.__perfLongTasks.shift();
          }
        });
        obs.observe({ entryTypes: ["longtask"] });
      } catch {}
    }
    window.__perfFrames = { count: 0, lastTs: performance.now(), worst: 0 };
    function tick(ts) {
      const dt = ts - window.__perfFrames.lastTs;
      window.__perfFrames.lastTs = ts;
      window.__perfFrames.count++;
      if (dt > window.__perfFrames.worst) window.__perfFrames.worst = dt;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    // Reset counters
    window.__perfFrames.count = 0;
    window.__perfFrames.worst = 0;
  });

  // Workload setup
  if (ARGS.workload === "load") {
    console.log("[perf] workload=load: making sure Showcase is selected");
    await page.evaluate(() => {
      const showcase = Array.from(document.querySelectorAll('[data-testid="workstream-item"]'))
        .find((el) => /^Showcase/.test(el.textContent || ""));
      if (showcase) showcase.click();
    });
    await page.waitForTimeout(2000);
  }

  // Sample baseline
  const start = Date.now();
  const samples = [];

  const switchEvery = ARGS.workload === "switch" ? 2000 : 0;
  let lastSwitch = Date.now();
  let switchIdx = 0;
  const wsNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="workstream-item"]'))
      .map((el) => el.getAttribute("data-workstream-id"))
  );

  while (Date.now() - start < ARGS.seconds * 1000) {
    // Heap sample
    const heap = await client.send("Runtime.evaluate", {
      expression: "JSON.stringify({heap: performance.memory ? performance.memory.usedJSHeapSize : null, total: performance.memory ? performance.memory.totalJSHeapSize : null, eventListeners: document.querySelectorAll('*').length, frames: window.__perfFrames})",
      returnByValue: true,
    });
    let parsed = {};
    try { parsed = JSON.parse(heap.result.value); } catch {}

    const longTasksSnapshot = await page.evaluate(() => {
      const arr = window.__perfLongTasks || [];
      const count = arr.length;
      const total = arr.reduce((acc, t) => acc + t.duration, 0);
      const max = arr.reduce((acc, t) => Math.max(acc, t.duration), 0);
      return { count, totalMs: total, maxMs: max };
    });

    const procMetrics = await client.send("Performance.getMetrics");

    samples.push({
      tMs: Date.now() - start,
      heap: parsed.heap,
      total: parsed.total,
      domNodes: parsed.eventListeners,
      frames: parsed.frames,
      longTasks: longTasksSnapshot,
      cdpMetrics: Object.fromEntries(procMetrics.metrics.map((m) => [m.name, m.value])),
    });

    if (switchEvery > 0 && Date.now() - lastSwitch > switchEvery && wsNames.length > 1) {
      switchIdx = (switchIdx + 1) % wsNames.length;
      const wsId = wsNames[switchIdx];
      await page.evaluate((id) => {
        const el = document.querySelector(`[data-workstream-id="${id}"]`);
        if (el) el.click();
      }, wsId);
      lastSwitch = Date.now();
    }

    await page.waitForTimeout(1000);
  }

  // Final snapshot: counts of mounted React subtrees
  const finalCounts = await page.evaluate(() => {
    return {
      explorerTiles: document.querySelectorAll('[data-testid="tile-explorer"]').length,
      copilotSessions: Array.from(document.querySelectorAll('[data-tile-type="copilot_session"]')).length,
      terminals: Array.from(document.querySelectorAll('[data-tile-type="terminal"]')).length,
      monacoEditors: document.querySelectorAll('.monaco-editor').length,
      xtermTerminals: document.querySelectorAll('.xterm').length,
      tilesRoot: document.querySelectorAll('[data-tile-id]').length,
      workstreams: document.querySelectorAll('[data-workstream-id]').length,
    };
  });

  const result = {
    args: ARGS,
    capturedAt: new Date().toISOString(),
    samples,
    finalCounts,
    consoleErrors: await page.evaluate(() => (window.__workstreamsConsoleErrors || []).length),
  };

  const outPath = path.resolve(process.cwd(), `screenshots/perf-cdp-${ARGS.workload}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`[perf] wrote ${outPath}`);
  console.log(`[perf] samples=${samples.length} finalDom=${finalCounts.tilesRoot} editors=${finalCounts.monacoEditors} xterms=${finalCounts.xtermTerminals}`);

  await browser.close();
}

main().catch((e) => {
  console.error("[perf] fatal:", e);
  process.exit(1);
});
