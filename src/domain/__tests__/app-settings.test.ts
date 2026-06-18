import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock invoke to a controllable in-memory key/value store. Re-imported per
// test via dynamic import below so module-level state stays clean.
const sqlStore = new Map<string, string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_setting") {
      const key = args?.key as string;
      return sqlStore.has(key) ? sqlStore.get(key)! : null;
    }
    if (cmd === "set_setting") {
      const key = args?.key as string;
      const value = args?.value as string;
      sqlStore.set(key, value);
      return undefined;
    }
    throw new Error(`unmocked invoke: ${cmd}`);
  }),
}));

import {
  DEFAULT_SETTINGS,
  MARKDOWN_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TEXT_FONT_SIZE_MAX,
  TEXT_FONT_SIZE_MIN,
  _resetAppSettingsCacheForTests,
  createWheelLineAccumulator,
  getAppSettings,
  hydrateAppSettings,
  resetAppSettings,
  sanitize,
  setAppSettings,
  subscribeAppSettings,
  wheelDeltaToLines,
} from "../app-settings";

beforeEach(() => {
  sqlStore.clear();
  globalThis.localStorage?.clear?.();
  _resetAppSettingsCacheForTests();
});

describe("app-settings sanitize", () => {
  it("returns full defaults when input is null/undefined/non-object", () => {
    expect(sanitize(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitize(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps scroll speed into [min, max] and falls back on garbage", () => {
    expect(sanitize({ terminalScrollSpeed: 10 }).terminalScrollSpeed).toBe(SCROLL_SPEED_MAX);
    expect(sanitize({ terminalScrollSpeed: 0 }).terminalScrollSpeed).toBe(SCROLL_SPEED_MIN);
    expect(sanitize({ terminalScrollSpeed: Number.NaN }).terminalScrollSpeed).toBe(
      DEFAULT_SETTINGS.terminalScrollSpeed,
    );
  });

  it("clamps + rounds each font size and falls back on garbage", () => {
    expect(sanitize({ textFontSize: 100 }).textFontSize).toBe(TEXT_FONT_SIZE_MAX);
    expect(sanitize({ textFontSize: 1 }).textFontSize).toBe(TEXT_FONT_SIZE_MIN);
    expect(sanitize({ textFontSize: 13.7 }).textFontSize).toBe(14);
    expect(sanitize({ textFontSize: "x" as unknown as number }).textFontSize).toBe(
      DEFAULT_SETTINGS.textFontSize,
    );

    expect(sanitize({ markdownFontSize: 9 }).markdownFontSize).toBe(MARKDOWN_FONT_SIZE_MIN);
    expect(sanitize({ markdownFontSize: 30 }).markdownFontSize).toBe(MARKDOWN_FONT_SIZE_MAX);

    expect(sanitize({ terminalFontSize: 7 }).terminalFontSize).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(sanitize({ terminalFontSize: 99 }).terminalFontSize).toBe(TERMINAL_FONT_SIZE_MAX);
  });

  it("copilotCommand: keeps trimmed string, falls back on empty / non-string", () => {
    expect(sanitize({ copilotCommand: "  copilot --yolo  " }).copilotCommand).toBe("copilot --yolo");
    expect(sanitize({ copilotCommand: "" }).copilotCommand).toBe(DEFAULT_SETTINGS.copilotCommand);
    expect(sanitize({ copilotCommand: "   " }).copilotCommand).toBe(DEFAULT_SETTINGS.copilotCommand);
    expect(sanitize({ copilotCommand: 42 as unknown as string }).copilotCommand).toBe(
      DEFAULT_SETTINGS.copilotCommand,
    );
  });
});

describe("app-settings hydration", () => {
  it("hydrate reads each known key from SQLite and applies it to the cache", async () => {
    sqlStore.set("app.terminal_scroll_speed", "1.25");
    sqlStore.set("app.font.text", "16");
    sqlStore.set("app.font.markdown", "18");
    sqlStore.set("app.font.terminal", "12");
    const result = await hydrateAppSettings();
    expect(result.terminalScrollSpeed).toBe(1.25);
    expect(result.textFontSize).toBe(16);
    expect(result.markdownFontSize).toBe(18);
    expect(result.terminalFontSize).toBe(12);
    expect(getAppSettings()).toEqual(result);
  });

  it("hydrate is idempotent (subsequent calls return the cached snapshot)", async () => {
    sqlStore.set("app.font.text", "20");
    const first = await hydrateAppSettings();
    sqlStore.set("app.font.text", "22"); // changed AFTER hydrate
    const second = await hydrateAppSettings();
    expect(first).toEqual(second);
    expect(second.textFontSize).toBe(20);
  });

  it("hydrate notifies subscribers", async () => {
    sqlStore.set("app.font.text", "16");
    const events: number[] = [];
    subscribeAppSettings((s) => events.push(s.textFontSize));
    await hydrateAppSettings();
    expect(events).toEqual([16]);
  });

  it("hydrate falls back to defaults when no SQL rows exist", async () => {
    const result = await hydrateAppSettings();
    expect(result).toEqual(DEFAULT_SETTINGS);
  });
});

describe("app-settings legacy migration", () => {
  it("migrates terminalScrollSpeed from legacy localStorage blob when no SQL row exists", async () => {
    globalThis.localStorage?.setItem(
      "ws.app-settings.v1",
      JSON.stringify({ terminalScrollSpeed: 1.75, mermaidFontSize: 20 }),
    );
    const result = await hydrateAppSettings();
    expect(result.terminalScrollSpeed).toBe(1.75);
    // legacy blob removed unconditionally
    expect(globalThis.localStorage?.getItem("ws.app-settings.v1")).toBeNull();
    // mermaidFontSize silently dropped (no key on the new shape)
    expect(result).not.toHaveProperty("mermaidFontSize");
    // value persisted to SQL so we never re-migrate
    expect(sqlStore.get("app.terminal_scroll_speed")).toBe("1.75");
  });

  it("SQL value wins over legacy blob when both exist", async () => {
    sqlStore.set("app.terminal_scroll_speed", "0.25");
    globalThis.localStorage?.setItem(
      "ws.app-settings.v1",
      JSON.stringify({ terminalScrollSpeed: 4 }),
    );
    const result = await hydrateAppSettings();
    expect(result.terminalScrollSpeed).toBe(0.25);
    // SQL value unchanged (no re-migrate)
    expect(sqlStore.get("app.terminal_scroll_speed")).toBe("0.25");
  });
});

describe("app-settings mutate", () => {
  it("setAppSettings updates cache, notifies subscribers, and writes through to SQLite", async () => {
    const events: number[] = [];
    subscribeAppSettings((s) => events.push(s.textFontSize));
    setAppSettings({ textFontSize: 16 });
    expect(getAppSettings().textFontSize).toBe(16);
    expect(events).toEqual([16]);
    // Allow the queued microtask write to flush
    await Promise.resolve();
    expect(sqlStore.get("app.font.text")).toBe("16");
  });

  it("setAppSettings clamps out-of-range writes", () => {
    setAppSettings({ markdownFontSize: 99 });
    expect(getAppSettings().markdownFontSize).toBe(MARKDOWN_FONT_SIZE_MAX);
    setAppSettings({ markdownFontSize: 1 });
    expect(getAppSettings().markdownFontSize).toBe(MARKDOWN_FONT_SIZE_MIN);
  });

  it("setAppSettings only writes keys that actually changed", async () => {
    setAppSettings({ textFontSize: 16, markdownFontSize: 18 });
    await Promise.resolve();
    sqlStore.clear(); // simulate no further writes
    setAppSettings({ textFontSize: 16 }); // unchanged
    await Promise.resolve();
    expect(sqlStore.size).toBe(0);
  });

  it("resetAppSettings restores every default and persists each one", async () => {
    setAppSettings({ textFontSize: 20, markdownFontSize: 18, terminalFontSize: 18 });
    await Promise.resolve();
    resetAppSettings();
    await Promise.resolve();
    expect(getAppSettings()).toEqual(DEFAULT_SETTINGS);
    expect(sqlStore.get("app.font.text")).toBe(String(DEFAULT_SETTINGS.textFontSize));
    expect(sqlStore.get("app.font.markdown")).toBe(String(DEFAULT_SETTINGS.markdownFontSize));
    expect(sqlStore.get("app.font.terminal")).toBe(String(DEFAULT_SETTINGS.terminalFontSize));
  });

  it("subscribeAppSettings returns an unsubscribe", () => {
    const events: number[] = [];
    const unsub = subscribeAppSettings((s) => events.push(s.terminalFontSize));
    setAppSettings({ terminalFontSize: 16 });
    unsub();
    setAppSettings({ terminalFontSize: 18 });
    expect(events).toEqual([16]);
  });

  it("setAppSettings persists copilotCommand changes to SQLite", async () => {
    setAppSettings({ copilotCommand: "copilot --yolo" });
    await Promise.resolve();
    expect(getAppSettings().copilotCommand).toBe("copilot --yolo");
    expect(sqlStore.get("app.copilot_command")).toBe("copilot --yolo");
  });
});

describe("app-settings copilotCommand hydration", () => {
  it("hydrate reads app.copilot_command from SQLite", async () => {
    sqlStore.set("app.copilot_command", "copilot --yolo");
    const result = await hydrateAppSettings();
    expect(result.copilotCommand).toBe("copilot --yolo");
  });

  it("hydrate ignores blank/whitespace-only copilot_command rows", async () => {
    sqlStore.set("app.copilot_command", "   ");
    const result = await hydrateAppSettings();
    expect(result.copilotCommand).toBe(DEFAULT_SETTINGS.copilotCommand);
  });
});

describe("wheelDeltaToLines", () => {
  it("scales with scroll speed and never returns less than 1", () => {
    expect(wheelDeltaToLines(120, 1)).toBe(1);
    expect(wheelDeltaToLines(240, 1)).toBe(2);
    expect(wheelDeltaToLines(120, 0.5)).toBe(1); // floored to 1
    expect(wheelDeltaToLines(480, 0.5)).toBe(2);
    expect(wheelDeltaToLines(-360, 0.5)).toBe(2);
    expect(wheelDeltaToLines(120, 2)).toBe(2);
  });
});

describe("createWheelLineAccumulator", () => {
  it("returns 0 for small ticks at low speed, accumulates fractional progress", () => {
    let speed = 0.1;
    const acc = createWheelLineAccumulator(() => speed);
    let lines = 0;
    for (let i = 0; i < 5; i++) lines += acc(30);
    expect(lines).toBe(0);
    for (let i = 0; i < 50; i++) lines += acc(30);
    expect(lines).toBeGreaterThanOrEqual(1);
    expect(lines).toBeLessThanOrEqual(3);
  });

  it("differentiates min vs max speed", () => {
    let minLines = 0;
    let speedMin = SCROLL_SPEED_MIN;
    const accMin = createWheelLineAccumulator(() => speedMin);
    for (let i = 0; i < 20; i++) minLines += accMin(30);
    let maxLines = 0;
    let speedMax = SCROLL_SPEED_MAX;
    const accMax = createWheelLineAccumulator(() => speedMax);
    for (let i = 0; i < 20; i++) maxLines += accMax(30);
    expect(maxLines).toBeGreaterThan(minLines * 5);
  });

  it("preserves direction (signed result)", () => {
    const acc = createWheelLineAccumulator(() => 1);
    expect(acc(120)).toBe(1);
    expect(acc(-240)).toBe(-2);
  });

  it("flips sign of accumulator on direction change", () => {
    const acc = createWheelLineAccumulator(() => 0.5);
    acc(60);
    acc(60);
    const out = acc(-240);
    expect(out).toBeLessThan(0);
  });

  it("sanitize defaults noVerifyBlockingEnabled to true when missing or invalid", () => {
    expect(sanitize({}).noVerifyBlockingEnabled).toBe(true);
    expect(sanitize(null).noVerifyBlockingEnabled).toBe(true);
    expect(sanitize({ noVerifyBlockingEnabled: "yes" as unknown as boolean }).noVerifyBlockingEnabled)
      .toBe(true);
  });

  it("sanitize preserves explicit noVerifyBlockingEnabled=false", () => {
    expect(sanitize({ noVerifyBlockingEnabled: false }).noVerifyBlockingEnabled).toBe(false);
    expect(sanitize({ noVerifyBlockingEnabled: true }).noVerifyBlockingEnabled).toBe(true);
  });

  it("setAppSettings toggles noVerifyBlockingEnabled and persists to SQL store", async () => {
    setAppSettings({ noVerifyBlockingEnabled: false });
    expect(getAppSettings().noVerifyBlockingEnabled).toBe(false);
    await Promise.resolve();
    expect(sqlStore.get("app.no_verify_blocking_enabled")).toBe("false");
  });
});
