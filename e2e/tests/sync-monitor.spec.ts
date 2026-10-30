/**
 * Sync server monitoring (ADR 040) in the browser build: the in-memory backend
 * plays the sync server, and the page clock steps through the two-minute
 * checks. Covers AT-1 to AT-5 of files/features/sync-monitor/acceptance.md.
 */
import { test, expect, type Page } from "@playwright/test";
import type { MemoryBackend } from "../../src/backend/memory-backend";
import type { SyncCheck, SyncEvent, SyncVitals } from "../../src/domain/sync-monitor";
import { cpu, vitals } from "../../src/sync-monitor/__tests__/fixtures";

type W = { __WS_BACKEND__: MemoryBackend };
const TWO_MIN = 2 * 60_000;

async function start(page: Page, server: { monitorKey?: string; vitals?: SyncVitals; key?: string; checks?: SyncCheck[] } = {}) {
  await page.clock.install({ time: new Date("2026-10-30T12:00:00Z") });
  await page.addInitScript(() => {
    Object.assign(window, { __WS_INVOKE_HANDLERS__: { get_setting: () => null, set_setting: () => null } });
  });
  await page.goto("/");
  await page.evaluate(async (s) => {
    const b = (window as unknown as W).__WS_BACKEND__;
    b.seedSyncServer({ url: "https://sync.example", monitorKey: s.monitorKey ?? null, vitals: s.vitals ?? null });
    if (s.key) await b.syncMonitorSetKey(s.key);
    if (s.checks) b.seedSyncChecks(s.checks);
  }, server);
  await check(page);
}

/** One two-minute step, and the check it triggers. */
async function check(page: Page, steps = 1) {
  for (let i = 0; i < steps; i++) {
    await page.clock.runFor(TWO_MIN);
    await page.waitForTimeout(50);
  }
}

const backend = <T,>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => {
    const b = (window as unknown as W).__WS_BACKEND__ as unknown as Record<string, (...a: unknown[]) => unknown>;
    return b[fn](...args);
  }, { fn, args }) as Promise<T>;

const dot = (page: Page) => page.getByTestId("sync-status-button");
const notified = (page: Page) => backend<SyncEvent[]>(page, "syncNotifications");

test("AT-1: an unreachable server raises one alert, then resolves", async ({ page }) => {
  await start(page);
  await expect(dot(page)).toHaveAttribute("data-level", "ok");
  await backend(page, "setSyncHealth", "down");
  await check(page);
  expect(await notified(page)).toEqual([]);
  await expect(dot(page)).toHaveAttribute("data-level", "ok");
  await check(page);
  await expect(dot(page)).toHaveAttribute("data-level", "critical");
  expect((await notified(page)).map((e) => [e.kind, e.event])).toEqual([["unreachable", "started"]]);
  await check(page, 3);
  expect(await notified(page)).toHaveLength(1);
  await page.getByTestId("pr-inbox-button").click();
  const events = page.locator("[data-testid^='sync-event-']:not([data-testid*='hint'])");
  await expect(events).toHaveCount(1);
  await expect(page.locator("[data-testid^='sync-event-hint-']").first()).toContainText("docker compose ps");
  await page.keyboard.press("Escape");
  await backend(page, "setSyncHealth", "ok");
  await check(page);
  await expect(dot(page)).toHaveAttribute("data-level", "ok");
  expect((await notified(page)).map((e) => e.event)).toEqual(["started", "resolved"]);
});

test("AT-2: vitals over a threshold alert once and name the app", async ({ page }) => {
  await start(page, { monitorKey: "m", key: "m", vitals: vitals() });
  const grow = (percent: number) => ({ ...cpu(percent), docs: [{ docId: "2kBad", appName: "Workstreams companion", sizeBytes: 1.5e6, growthBytes24h: 1.4 * 2 ** 20, modifiedAt: "" }] });
  await backend(page, "setSyncVitals", grow(92));
  await check(page);
  await backend(page, "setSyncVitals", grow(95));
  await check(page);
  expect((await notified(page)).map((e) => e.kind)).toEqual(["doc_growth:2kBad"]);
  await backend(page, "setSyncVitals", grow(405));
  await check(page);
  const kinds = (await notified(page)).map((e) => e.kind);
  expect(kinds).toEqual(["doc_growth:2kBad", "cpu"]);
  expect((await notified(page))[0].message).toContain("Workstreams companion");
  await check(page, 2);
  expect(await notified(page)).toHaveLength(2);

  await backend(page, "setSyncVitals", {
    ...vitals(),
    disk: { freeBytes: 1.5 * 2 ** 30, totalBytes: 23 * 2 ** 30 },
    rejectedLogins: { last5Minutes: 25 },
    docs: [{ docId: "zzz", appName: null, sizeBytes: 3 * 2 ** 20, growthBytes24h: 0, modifiedAt: "" }],
  });
  await check(page);
  const events = await notified(page);
  const fresh = events.slice(2);
  expect(fresh.filter((e) => e.event === "started").map((e) => e.kind).sort()).toEqual(["disk", "doc_size:zzz", "logins"]);
  expect(fresh.find((e) => e.kind === "doc_size:zzz")?.message).toContain("unknown app");
  expect(fresh.filter((e) => e.event === "resolved").map((e) => e.kind).sort()).toEqual(["cpu", "doc_growth:2kBad"]);
});

test("AT-3: the status panel shows the server at a glance", async ({ page }) => {
  const at = (min: number, percent: number): SyncCheck => ({
    at: Date.parse("2026-10-30T12:00:00Z") - min * 60_000, reachable: true, latency_ms: 80, error: null, vitals: cpu(percent), vitals_error: null,
  });
  await start(page, { monitorKey: "m", key: "m", vitals: vitals(), checks: [at(25 * 60, 2), at(300, 95), at(298, 96), at(296, 97), at(294, 3), at(10, 2)] });
  // A past incident, recorded when it happened.
  const t = (min: number) => Date.parse("2026-10-30T12:00:00Z") - min * 60_000;
  await backend(page, "syncMonitorApply", [], [
    { id: "cpu-started", kind: "cpu", event: "started", at: t(296), message: "Sync server CPU high (97%)", hint: "h", is_read: false },
    { id: "cpu-resolved", kind: "cpu", event: "resolved", at: t(294), message: "Resolved: Sync server CPU high (97%)", hint: "Back to normal.", is_read: false },
  ], []);
  await check(page);
  await dot(page).click();
  const values = page.getByTestId("sync-vitals-values");
  for (const text of ["CPU 2%", "Memory 540 MB free", "Swap", "Disk 5.6 GB free", "Rejected logins 0 / 5 min"]) await expect(values).toContainText(text);
  await expect(page.getByTestId("sync-doc-4RGYp")).toContainText("Pagos+");
  await expect(page.getByTestId("sync-spark-cpu")).toHaveAttribute("data-points", "7");
  await expect(page.getByTestId("sync-recent-alerts")).toContainText("CPU high");
  await expect(page.getByTestId("sync-recent-alerts")).toContainText("Resolved");
  await page.keyboard.press("Escape");
  await dot(page).click();
  await expect(page.getByTestId("sync-spark-cpu")).toHaveAttribute("data-points", "7");
});

test("AT-4: the monitor key is optional, and thresholds are editable", async ({ page }) => {
  await start(page, { monitorKey: "m", vitals: cpu(85) });
  await dot(page).click();
  await expect(page.getByTestId("sync-vitals-missing")).toContainText("Add a monitor key");
  await page.getByTestId("sync-key-input").fill("m");
  await page.getByTestId("sync-key-save").click();
  await expect(page.getByTestId("sync-vitals-values")).toContainText("CPU 85%");
  await page.getByTestId("sync-threshold-cpuPercent").fill("90");
  await page.getByTestId("sync-thresholds-save").click();
  await page.keyboard.press("Escape");
  await check(page, 3);
  expect(await notified(page)).toEqual([]);
  await dot(page).click();
  await page.getByTestId("sync-threshold-cpuPercent").fill("80");
  await page.getByTestId("sync-thresholds-save").click();
  await expect.poll(async () => (await notified(page)).map((e) => e.kind)).toEqual(["cpu"]);
});

test("AT-5: muting a problem kind for 24 hours", async ({ page }) => {
  await start(page, { monitorKey: "m", key: "m", vitals: cpu(95) });
  await check(page, 2);
  expect((await notified(page)).map((e) => e.kind)).toEqual(["cpu"]);
  await dot(page).click();
  await page.getByTestId("sync-mute-cpu").click();
  await expect(page.getByTestId("sync-muted-cpu")).toBeVisible();
  await page.keyboard.press("Escape");
  await backend(page, "setSyncVitals", vitals());
  await check(page);
  await backend(page, "setSyncVitals", cpu(95));
  await check(page, 3);
  expect(await notified(page)).toHaveLength(1);
  await expect(dot(page)).toHaveAttribute("data-level", "critical");
  await backend(page, "setSyncVitals", vitals());
  await page.clock.fastForward(24 * 60 * 60_000);
  await page.waitForTimeout(100);
  await backend(page, "setSyncVitals", cpu(95));
  await check(page, 3);
  expect((await notified(page)).filter((e) => e.event === "started")).toHaveLength(2);
});
