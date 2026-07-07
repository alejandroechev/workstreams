#!/usr/bin/env node
/**
 * UI component harness runner.
 *
 * Reproduces/verifies real-Monaco UI bugs (layout / z-index / pointer-events)
 * that jsdom unit tests cannot see, by driving the isolated harness route
 * (`?harness=<case>`) served by the dev:e2e Vite server in real Chromium.
 *
 * Usage:
 *   npm run harness              # run all cases
 *   npm run harness -- <case>    # run one case (e.g. comment-zone)
 *
 * It reuses a dev:e2e server already listening on :5177 (fast inner loop), or
 * cold-starts one and leaves it running. For each case it proves the target
 * button is *actually clickable* (not just present): a DOM hit-test
 * (`elementFromPoint`) for a diagnostic, then a real click that must produce a
 * state change. Writes a screenshot per case to `.dev/harness/` and exits
 * non-zero on any failure.
 *
 * This is the agent-facing loop. The durable CI gate is
 * `e2e/tests/comment-interactivity.spec.ts`.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const PORT = 5177;
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = path.resolve(".dev", "harness");

/**
 * Case registry mirrors src/harness/cases.tsx. Each entry names the target
 * button and the state change a real click must produce.
 */
const CASES = {
  "comment-zone": {
    describe: "Repo Explorer file-comment Edit button opens the inline composer",
    button: '[data-testid="comment-edit-c1"]',
    // Clicking Edit must open the composer.
    expectVisible: '[data-testid="comment-composer"]',
  },
  "review-thread": {
    describe: "Code Review thread Resolve button flips the status to Resolved",
    button: '[data-testid="resolve"]',
    // Clicking Resolve must flip the thread status.
    expectText: { selector: '[data-testid="thread-status"]', text: "Resolved" },
  },
};

async function serverUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverUp()) return { started: false };
  console.log("harness: cold-starting dev:e2e server on :" + PORT + " …");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npm, ["run", "dev:e2e"], { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await serverUp()) {
      console.log("harness: server is up.");
      return { started: true };
    }
  }
  throw new Error("dev:e2e server did not come up within 90s");
}

/** Probe one case in an already-open page. Returns { ok, reason }. */
async function probeCase(page, id, cfg) {
  await page.goto(`${BASE}/?harness=${id}`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector('[data-testid="harness-case"]', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll(".monaco-editor").length > 0, null, {
    timeout: 30_000,
  });

  // Wait for the target button to render inside its inline view zone.
  try {
    await page.waitForSelector(cfg.button, { timeout: 15_000, state: "attached" });
  } catch {
    return { ok: false, reason: `button ${cfg.button} never rendered` };
  }

  // Hit-test: is the button's center actually the top element? (diagnostic — the
  // whole bug is "present but occluded by a Monaco layer").
  const hit = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(cx, cy);
    const covered = !(top && (el === top || el.contains(top) || top.contains(el)));
    const topDesc = top ? `${top.tagName.toLowerCase()}.${String(top.className || "").trim().split(/\s+/).join(".")}` : "none";
    return { present: true, covered, topDesc };
  }, cfg.button);
  if (hit.present && hit.covered) {
    console.log(`  hit-test: button is COVERED by <${hit.topDesc}> (occlusion bug)`);
  } else if (hit.present) {
    console.log("  hit-test: button center is the top element (clickable)");
  }

  // Authoritative check: a real click must produce the state change.
  let clickErr = null;
  try {
    await page.click(cfg.button, { timeout: 5_000 });
  } catch (e) {
    clickErr = e instanceof Error ? e.message.split("\n")[0] : String(e);
  }

  if (cfg.expectVisible) {
    try {
      await page.waitForSelector(cfg.expectVisible, { timeout: 4_000, state: "visible" });
    } catch {
      return {
        ok: false,
        reason: `click did not reveal ${cfg.expectVisible}` +
          (hit.covered ? ` (button covered by <${hit.topDesc}>)` : "") +
          (clickErr ? ` [click error: ${clickErr}]` : ""),
      };
    }
  }
  if (cfg.expectText) {
    try {
      await page.waitForFunction(
        ({ selector, text }) => document.querySelector(selector)?.textContent?.trim() === text,
        cfg.expectText,
        { timeout: 4_000 },
      );
    } catch {
      const actual = await page
        .locator(cfg.expectText.selector)
        .first()
        .textContent()
        .catch(() => null);
      return {
        ok: false,
        reason: `expected ${cfg.expectText.selector} = "${cfg.expectText.text}", got "${actual}"` +
          (hit.covered ? ` (button covered by <${hit.topDesc}>)` : "") +
          (clickErr ? ` [click error: ${clickErr}]` : ""),
      };
    }
  }
  return { ok: true };
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const ids = requested.length > 0 ? requested : Object.keys(CASES);
  const unknown = ids.filter((id) => !CASES[id]);
  if (unknown.length > 0) {
    console.error(`Unknown case(s): ${unknown.join(", ")}. Known: ${Object.keys(CASES).join(", ")}`);
    process.exit(2);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  await ensureServer();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const results = [];
  try {
    for (const id of ids) {
      console.log(`\n▶ ${id} — ${CASES[id].describe}`);
      let res;
      try {
        res = await probeCase(page, id, CASES[id]);
      } catch (e) {
        res = { ok: false, reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
      }
      const shot = path.join(OUT_DIR, `${id}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      console.log(`  ${res.ok ? "✅ PASS" : "❌ FAIL"}${res.ok ? "" : " — " + res.reason}`);
      console.log(`  screenshot: ${shot}`);
      results.push({ id, ...res });
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} cases passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
