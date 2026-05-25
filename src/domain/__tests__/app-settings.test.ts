import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS,
  MERMAID_FONT_SIZE_MAX,
  MERMAID_FONT_SIZE_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  _resetAppSettingsCacheForTests,
  createWheelLineAccumulator,
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

  it("createWheelLineAccumulator returns 0 for small ticks at low speed, accumulates fractional progress", () => {
    let speed = 0.1;
    const acc = createWheelLineAccumulator(() => speed);
    // 30px per tick — typical precision touchpad. At speed 0.1, baseLines=0.25,
    // scaled=0.025, so we need ~40 ticks to scroll 1 line. The bug pre-fix:
    // every tick returned 1 line regardless of speed.
    let lines = 0;
    for (let i = 0; i < 5; i++) lines += acc(30);
    expect(lines).toBe(0); // small ticks at min speed must NOT each force 1 line
    for (let i = 0; i < 50; i++) lines += acc(30);
    expect(lines).toBeGreaterThanOrEqual(1);
    expect(lines).toBeLessThanOrEqual(3);
  });

  it("createWheelLineAccumulator differentiates min vs max speed", () => {
    // Same wheel input -> very different line counts depending on speed.
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

  it("createWheelLineAccumulator preserves direction (signed result)", () => {
    const acc = createWheelLineAccumulator(() => 1);
    expect(acc(120)).toBe(1);
    expect(acc(-240)).toBe(-2);
  });

  it("createWheelLineAccumulator flips sign of accumulator on direction change", () => {
    const acc = createWheelLineAccumulator(() => 0.5);
    // Build up some upward partial credit, then scroll the other way; the
    // partial credit must not "swallow" the new direction.
    acc(60); // 0.25 lines pending
    acc(60); // 0.5 lines pending
    const out = acc(-240); // 1 line pending downward → discard pending up
    expect(out).toBeLessThan(0);
  });

  it("sanitize clamps and rounds mermaid font size", () => {
    expect(sanitize({ mermaidFontSize: 100 }).mermaidFontSize).toBe(MERMAID_FONT_SIZE_MAX);
    expect(sanitize({ mermaidFontSize: 2 }).mermaidFontSize).toBe(MERMAID_FONT_SIZE_MIN);
    expect(sanitize({ mermaidFontSize: 13.7 }).mermaidFontSize).toBe(14);
    expect(sanitize({}).mermaidFontSize).toBe(DEFAULT_SETTINGS.mermaidFontSize);
  });
});
