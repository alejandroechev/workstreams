import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  _resetAppSettingsCacheForTests,
  getAppSettings,
  sanitize,
  setAppSettings,
  subscribeAppSettings,
  wheelDeltaToLines,
} from "../app-settings";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  _resetAppSettingsCacheForTests();
});

describe("app-settings", () => {
  it("returns defaults when storage is empty", () => {
    expect(getAppSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("sanitize clamps scroll speed into range and falls back on garbage", () => {
    expect(sanitize({ terminalScrollSpeed: 10 }).terminalScrollSpeed).toBe(SCROLL_SPEED_MAX);
    expect(sanitize({ terminalScrollSpeed: 0 }).terminalScrollSpeed).toBe(SCROLL_SPEED_MIN);
    expect(sanitize({ terminalScrollSpeed: Number.NaN }).terminalScrollSpeed).toBe(
      DEFAULT_SETTINGS.terminalScrollSpeed,
    );
    expect(sanitize(null).terminalScrollSpeed).toBe(DEFAULT_SETTINGS.terminalScrollSpeed);
  });

  it("setAppSettings persists and notifies subscribers", () => {
    const events: number[] = [];
    const unsub = subscribeAppSettings((s) => events.push(s.terminalScrollSpeed));
    setAppSettings({ terminalScrollSpeed: 1.5 });
    expect(getAppSettings().terminalScrollSpeed).toBe(1.5);
    expect(events).toEqual([1.5]);
    unsub();
    setAppSettings({ terminalScrollSpeed: 2 });
    expect(events).toEqual([1.5]);
  });

  it("setAppSettings round-trips through storage on cache reset", () => {
    setAppSettings({ terminalScrollSpeed: 1.25 });
    _resetAppSettingsCacheForTests();
    expect(getAppSettings().terminalScrollSpeed).toBe(1.25);
  });

  it("setAppSettings clamps out-of-range writes", () => {
    setAppSettings({ terminalScrollSpeed: 99 });
    expect(getAppSettings().terminalScrollSpeed).toBe(SCROLL_SPEED_MAX);
  });

  it("wheelDeltaToLines scales with scroll speed and never returns less than 1", () => {
    expect(wheelDeltaToLines(120, 1)).toBe(1);
    expect(wheelDeltaToLines(240, 1)).toBe(2);
    expect(wheelDeltaToLines(120, 0.5)).toBe(1); // floored to 1
    expect(wheelDeltaToLines(480, 0.5)).toBe(2);
    expect(wheelDeltaToLines(-360, 0.5)).toBe(2);
    expect(wheelDeltaToLines(120, 2)).toBe(2);
  });
});
