// PTY throughput probe: open a Terminal tile, hook xterm Terminal.write via
// a React-fiber walk, run a noisy PowerShell command, count writes and bytes.
// Then compare to raw spawn-pwsh chunk count.

import { connect } from "./cdp-utils.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";

const NOISY_CMD =
  "1..2000 | ForEach-Object { Write-Host \"line $_ : the quick brown fox jumps over the lazy dog\" -ForegroundColor Cyan }";

async function inAppMeasurement() {
  console.log("[perf] connecting to dev app via CDP...");
  const { browser, page } = await connect();

  await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const ws = document.querySelector('[data-workstream-id][data-active="true"]');
    const wsId = ws?.getAttribute("data-workstream-id");
    if (!wsId) throw new Error("No active workstream");
    const tiles = await invoke("list_tiles", { workstreamId: wsId });
    const existing = tiles.find((t) => t.tile_type === "terminal" && /perf-bench/.test(t.title));
    if (!existing) {
      await invoke("create_tile", {
        workstreamId: wsId,
        tileType: "terminal",
        title: "perf-bench-term",
        configJson: JSON.stringify({ cwd: "C:\\\\Local\\\\Code\\\\ai-tools\\\\workstreams" }),
      });
    }
  });
  await page.waitForTimeout(4000);

  const tileId = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const ws = document.querySelector('[data-workstream-id][data-active="true"]');
    const wsId = ws?.getAttribute("data-workstream-id");
    const tiles = await invoke("list_tiles", { workstreamId: wsId });
    const t = tiles.find((x) => x.tile_type === "terminal" && /perf-bench/.test(x.title));
    return t?.id;
  });
  console.log("[perf] bench tile id:", tileId);
  if (!tileId) {
    await browser.close();
    throw new Error("bench tile not created");
  }

  const hookResult = await page.evaluate(() => {
    let instance = null;
    const allEls = document.querySelectorAll(".xterm");
    for (const el of allEls) {
      const fibers = Object.keys(el).filter((k) => k.startsWith("__reactFiber"));
      for (const fk of fibers) {
        let f = el[fk];
        let safety = 0;
        while (f && safety < 50) {
          if (f.memoizedState) {
            let h = f.memoizedState;
            let g = 0;
            while (h && g < 100) {
              const v = h.memoizedState;
              if (v && typeof v === "object" && v && v.current && typeof v.current.write === "function" && v.current.cols !== undefined) {
                instance = v.current;
                break;
              }
              h = h.next;
              g++;
            }
          }
          if (instance) break;
          f = f.return;
          safety++;
        }
        if (instance) break;
      }
      if (instance) break;
    }
    if (!instance) return { ok: false, reason: "no Terminal instance found via fiber walk" };
    window.__ptyBench = { events: 0, bytes: 0, firstTs: 0, lastTs: 0 };
    const origWrite = instance.write.bind(instance);
    instance.write = function (data, cb) {
      window.__ptyBench.events++;
      window.__ptyBench.bytes += typeof data === "string" ? data.length : (data?.byteLength || 0);
      const now = performance.now();
      if (!window.__ptyBench.firstTs) window.__ptyBench.firstTs = now;
      window.__ptyBench.lastTs = now;
      return origWrite(data, cb);
    };
    window.__ptyBenchInstance = instance;
    return { ok: true, cols: instance.cols, rows: instance.rows };
  });
  console.log("[perf] hook result:", hookResult);
  if (!hookResult.ok) {
    await browser.close();
    throw new Error(`could not hook xterm: ${hookResult.reason}`);
  }

  await page.evaluate(async (tileId) => {
    window.__ptyBench = { events: 0, bytes: 0, firstTs: 0, lastTs: 0 };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke("write_to_pty", {
      tileId,
      data: "1..2000 | ForEach-Object { Write-Host \"line $_ : the quick brown fox jumps over the lazy dog\" -ForegroundColor Cyan }\r",
    });
  }, tileId);

  let last = 0;
  let stableMs = 0;
  const startWait = Date.now();
  while (Date.now() - startWait < 60000) {
    await page.waitForTimeout(300);
    const cur = await page.evaluate(() => window.__ptyBench.events);
    if (cur === last) {
      stableMs += 300;
      if (stableMs > 2000) break;
    } else {
      stableMs = 0;
      last = cur;
    }
  }

  const result = await page.evaluate(() => ({
    ...window.__ptyBench,
    durationMs: window.__ptyBench.lastTs - window.__ptyBench.firstTs,
  }));
  console.log("[in-app] events:", result.events);
  console.log("[in-app] bytes:", result.bytes);
  console.log("[in-app] duration ms:", Math.round(result.durationMs));
  if (result.durationMs > 0) {
    console.log("[in-app] events/sec:", (result.events * 1000 / result.durationMs).toFixed(1));
    console.log("[in-app] MB/sec:", (result.bytes / 1024 / 1024 * 1000 / result.durationMs).toFixed(2));
    console.log("[in-app] avg bytes/event:", (result.bytes / Math.max(1, result.events)).toFixed(1));
  }

  await browser.close();
  return result;
}

async function rawPwshMeasurement() {
  console.log("[perf] spawning pwsh directly to compare...");
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = 0;
    const start = Date.now();
    const child = spawn(
      "pwsh.exe",
      ["-NoProfile", "-NoLogo", "-Command", NOISY_CMD],
      { windowsHide: true },
    );
    child.stdout.on("data", (b) => { bytes += b.length; chunks++; });
    child.stderr.on("data", (b) => { bytes += b.length; chunks++; });
    child.on("close", () => {
      const ms = Date.now() - start;
      console.log("[raw] chunks:", chunks);
      console.log("[raw] bytes:", bytes);
      console.log("[raw] duration ms:", ms);
      console.log("[raw] chunks/sec:", (chunks * 1000 / ms).toFixed(1));
      console.log("[raw] MB/sec:", (bytes / 1024 / 1024 * 1000 / ms).toFixed(2));
      console.log("[raw] avg bytes/chunk:", (bytes / Math.max(1, chunks)).toFixed(1));
      resolve({ chunks, bytes, durationMs: ms });
    });
    child.on("error", reject);
  });
}

async function main() {
  const raw = await rawPwshMeasurement();
  const inApp = await inAppMeasurement();
  fs.writeFileSync(
    "screenshots/perf-pty-bench.json",
    JSON.stringify({ inApp, raw, capturedAt: new Date().toISOString() }, null, 2),
  );
  console.log("[perf] wrote screenshots/perf-pty-bench.json");
}

main().catch((e) => { console.error("[perf] fatal:", e); process.exit(1); });
