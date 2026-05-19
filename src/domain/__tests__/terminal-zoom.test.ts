import { describe, it, expect } from "vitest";
import {
  nextFontSize,
  keyToZoomAction,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_MIN_FONT_SIZE,
  TERMINAL_MAX_FONT_SIZE,
} from "../terminal-zoom";

describe("terminal-zoom", () => {
  describe("keyToZoomAction", () => {
    it.each([
      ["=", "inc"],
      ["+", "inc"],
      ["-", "dec"],
      ["_", "dec"],
      ["0", "reset"],
    ] as const)("maps %s to %s", (key, expected) => {
      expect(keyToZoomAction(key)).toBe(expected);
    });

    it("returns null for unrelated keys", () => {
      expect(keyToZoomAction("a")).toBeNull();
      expect(keyToZoomAction("Enter")).toBeNull();
      expect(keyToZoomAction("1")).toBeNull();
    });
  });

  describe("nextFontSize", () => {
    it("increments by 1", () => {
      expect(nextFontSize(13, "inc")).toBe(14);
      expect(nextFontSize(20, "inc")).toBe(21);
    });

    it("decrements by 1", () => {
      expect(nextFontSize(13, "dec")).toBe(12);
      expect(nextFontSize(10, "dec")).toBe(9);
    });

    it("clamps at max", () => {
      expect(nextFontSize(TERMINAL_MAX_FONT_SIZE, "inc")).toBe(TERMINAL_MAX_FONT_SIZE);
      expect(nextFontSize(99, "inc")).toBe(TERMINAL_MAX_FONT_SIZE);
    });

    it("clamps at min", () => {
      expect(nextFontSize(TERMINAL_MIN_FONT_SIZE, "dec")).toBe(TERMINAL_MIN_FONT_SIZE);
      expect(nextFontSize(0, "dec")).toBe(TERMINAL_MIN_FONT_SIZE);
    });

    it("reset returns the default regardless of current value", () => {
      expect(nextFontSize(8, "reset")).toBe(TERMINAL_DEFAULT_FONT_SIZE);
      expect(nextFontSize(28, "reset")).toBe(TERMINAL_DEFAULT_FONT_SIZE);
      expect(nextFontSize(13, "reset")).toBe(TERMINAL_DEFAULT_FONT_SIZE);
    });

    it("falls back to default if current is NaN", () => {
      expect(nextFontSize(NaN, "inc")).toBe(TERMINAL_DEFAULT_FONT_SIZE + 1);
    });
  });
});
