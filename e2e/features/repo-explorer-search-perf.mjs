// Search performance probe — drives the backend at full tilt against a
// LARGE directory and pings on a separate IPC channel to measure RTT.
import fs from "node:fs";
import path from "node:path";

const SEARCH_ROOT = "C:\\Local\\Code\\ai-tools\\workstreams";
const QUERY_PREFIXES = ["i", "in", "int", "inte", "inter", "interf", "interfa", "interfac", "interface"];
const PING_INTERVAL_MS = 50;
const KEY_INTERVAL_MS = 80;
const POST_HOLD_MS = 2000;

export async function run({ page, screenshot, featureDir }) {
  await page.waitForLoadState("domcontentloaded");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);

  await page.evaluate((interval) => {
    const w = window;
    w.__PING_LOG__ = [];
    w.__PING_RUNNING__ = true;
    const tick = async () => {
      if (!w.__PING_RUNNING__) return;
      const t0 = performance.now();
      try { await w.__TAURI_INTERNALS__.invoke("ping"); } catch { /* ignore */ }
      const rtt = performance.now() - t0;
      w.__PING_LOG__.push({ t: t0, rtt });
      setTimeout(tick, interval);
    };
    setTimeout(tick, 0);
  }, PING_INTERVAL_MS);

  await page.waitForTimeout(800);
  const baselineSplit = await page.evaluate(() => performance.now());

  const driveStart = await page.evaluate(() => performance.now());
  for (const q of QUERY_PREFIXES) {
    await page.evaluate(async ({ root, query }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      try { await invoke("cancel_searches"); } catch { /* may not exist */ }
      invoke("search_in_files", { directory: root, query, limit: 200 }).catch(() => {});
    }, { root: SEARCH_ROOT, query: q });
    await page.waitForTimeout(KEY_INTERVAL_MS);
  }
  const driveEnd = await page.evaluate(() => performance.now());

  await page.waitForTimeout(POST_HOLD_MS);

  const report = await page.evaluate((bsplit) => {
    const w = window;
    w.__PING_RUNNING__ = false;
    const all = w.__PING_LOG__ || [];
    const baseline = all.filter((s) => s.t < bsplit).map((s) => s.rtt);
    const during = all.filter((s) => s.t >= bsplit).map((s) => s.rtt);
    const stats = (arr) => {
      if (!arr.length) return { n: 0 };
      const sorted = [...arr].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      const pct = (p) => sorted[Math.floor((sorted.length - 1) * p)];
      return {
        n: sorted.length,
        mean: +(sum / sorted.length).toFixed(1),
        p50: +pct(0.5).toFixed(1),
        p95: +pct(0.95).toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1),
      };
    };
    return {
      baseline: stats(baseline),
      during: stats(during),
      total: stats(all.map((s) => s.rtt)),
    };
  }, baselineSplit);

  report.config = {
    searchRoot: SEARCH_ROOT,
    queries: QUERY_PREFIXES,
    pingIntervalMs: PING_INTERVAL_MS,
    keyIntervalMs: KEY_INTERVAL_MS,
    postHoldMs: POST_HOLD_MS,
    driveDurationMs: Math.round(driveEnd - driveStart),
  };

  const outDir = featureDir || path.join(process.cwd(), "screenshots", "repo-explorer-search-perf");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "perf.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[probe] perf report saved to ${outPath}`);
  console.log(`[probe] BASELINE (idle):           ${JSON.stringify(report.baseline)}`);
  console.log(`[probe] DURING + after typing:     ${JSON.stringify(report.during)}`);

  await screenshot("after-perf");
}
