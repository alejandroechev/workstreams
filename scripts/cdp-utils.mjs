// Shared helpers for CDP feature validation.
// Pure ESM, only depends on `playwright` (already a devDep via @playwright/test).

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const CDP_URL = "http://localhost:9222";

export async function isCdpAlive(timeoutMs = 1500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${CDP_URL}/json/version`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForCdp({ timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isCdpAlive()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`CDP did not become ready within ${timeoutMs}ms`);
}

export async function connect() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  const ctx = contexts[0] ?? (await browser.newContext());
  const pages = ctx.pages();
  const page = pages[0] ?? (await ctx.newPage());
  return { browser, ctx, page };
}

export function captureErrors(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push({ kind: "console", text: msg.text() });
  });
  page.on("pageerror", (err) => {
    errors.push({ kind: "pageerror", text: err.message });
  });
  return errors;
}

export function screenshotPath(featureId, screenshotsDir = "screenshots") {
  const dir = path.join(screenshotsDir, featureId);
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${featureId}-${ts}.png`);
}

/** Helper passed to feature protocols. */
export function makeApi({ page, featureId, screenshotsDir }) {
  let lastPath = null;
  return {
    page,
    async screenshot(name) {
      const file = name
        ? path.join(screenshotsDir, featureId, `${name}.png`)
        : screenshotPath(featureId, screenshotsDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: false });
      lastPath = file;
      return file;
    },
    getLastScreenshotPath() {
      return lastPath;
    },
  };
}
