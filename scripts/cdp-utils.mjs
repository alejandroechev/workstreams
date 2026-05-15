// Shared helpers for CDP feature validation.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Default to port 9222 (matches tauri.conf.dev.json — dev-only).
// Prod releases ship without CDP enabled at all, so prod and dev cannot
// conflict on this port. Override via CDP_PORT env if needed.
export const CDP_PORT = Number(process.env.CDP_PORT) || 9222;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

export async function isCdpAlive(timeoutMs = 1500) {
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(`http://${host}:${CDP_PORT}/json/version`, { signal: ac.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      // try next host
    }
  }
  return false;
}

export async function waitForCdp({ timeoutMs = 360_000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isCdpAlive()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`CDP did not become ready on port ${CDP_PORT} within ${timeoutMs}ms`);
}

export async function connect() {
  // Try both IPv4 and IPv6 — WebView2 sometimes binds only one.
  let lastErr;
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const browser = await chromium.connectOverCDP(`http://${host}:${CDP_PORT}`);
      const contexts = browser.contexts();
      const ctx = contexts[0] ?? (await browser.newContext());
      const pages = ctx.pages();
      const page = pages[0] ?? (await ctx.newPage());
      return { browser, ctx, page };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Could not connect to CDP");
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
