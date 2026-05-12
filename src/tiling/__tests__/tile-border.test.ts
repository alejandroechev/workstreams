import { describe, it, expect } from "vitest";
import { computeTileBorder } from "../tile-border";

describe("computeTileBorder", () => {
  it("returns yellow border for fullscreen tile", () => {
    const border = computeTileBorder({ isFullscreen: true, isFocused: true, isWorking: false });
    expect(border).toBe("2px solid #f9e2af");
  });

  it("returns yellow border for fullscreen even when not focused", () => {
    const border = computeTileBorder({ isFullscreen: true, isFocused: false, isWorking: false });
    expect(border).toBe("2px solid #f9e2af");
  });

  it("returns yellow border for fullscreen even when working", () => {
    // Fullscreen takes precedence — user needs to know it's fullscreen
    const border = computeTileBorder({ isFullscreen: true, isFocused: true, isWorking: true });
    expect(border).toBe("2px solid #f9e2af");
  });

  it("returns blue border when focused and not working", () => {
    const border = computeTileBorder({ isFullscreen: false, isFocused: true, isWorking: false });
    expect(border).toBe("2px solid #89b4fa");
  });

  it("returns green border when focused and working", () => {
    const border = computeTileBorder({ isFullscreen: false, isFocused: true, isWorking: true });
    expect(border).toBe("2px solid #a6e3a1");
  });

  it("returns grey thin border when not focused and not working", () => {
    const border = computeTileBorder({ isFullscreen: false, isFocused: false, isWorking: false });
    expect(border).toBe("1px solid #313244");
  });

  it("returns green thin border when not focused but working", () => {
    const border = computeTileBorder({ isFullscreen: false, isFocused: false, isWorking: true });
    expect(border).toBe("1px solid #a6e3a1");
  });
});
