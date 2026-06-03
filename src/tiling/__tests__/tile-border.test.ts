import { describe, it, expect } from "vitest";
import { computeTileBorder } from "../tile-border";

describe("computeTileBorder", () => {
  it("returns yellow border for fullscreen tile", () => {
    expect(computeTileBorder({ isFullscreen: true, isFocused: true })).toBe("2px solid #f9e2af");
  });

  it("returns yellow border for fullscreen even when not focused", () => {
    expect(computeTileBorder({ isFullscreen: true, isFocused: false })).toBe("2px solid #f9e2af");
  });

  it("fullscreen takes precedence over side-by-side", () => {
    expect(computeTileBorder({ isFullscreen: true, isFocused: false, isSideBySide: true })).toBe("2px solid #f9e2af");
  });

  it("returns mauve border for a side-by-side tile", () => {
    expect(computeTileBorder({ isFullscreen: false, isFocused: false, isSideBySide: true })).toBe("2px solid #cba6f7");
  });

  it("side-by-side takes precedence over focused", () => {
    expect(computeTileBorder({ isFullscreen: false, isFocused: true, isSideBySide: true })).toBe("2px solid #cba6f7");
  });

  it("returns blue border when focused (regardless of activity)", () => {
    expect(computeTileBorder({ isFullscreen: false, isFocused: true })).toBe("2px solid #89b4fa");
  });

  it("returns grey thin border when not focused (regardless of activity)", () => {
    expect(computeTileBorder({ isFullscreen: false, isFocused: false })).toBe("1px solid #313244");
  });
});
