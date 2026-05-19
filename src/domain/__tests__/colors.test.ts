import { describe, it, expect } from "vitest";
import { PROJECT_PRESET_COLORS, isCustomProjectColor } from "../colors";

describe("project colors", () => {
  it("exposes at least 12 swatches", () => {
    expect(PROJECT_PRESET_COLORS.length).toBeGreaterThanOrEqual(12);
  });

  it("all entries have valid 7-char hex codes", () => {
    for (const c of PROJECT_PRESET_COLORS) {
      expect(c.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("all names are unique", () => {
    const names = PROJECT_PRESET_COLORS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all hex values are unique", () => {
    const hexes = PROJECT_PRESET_COLORS.map((c) => c.hex.toLowerCase());
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  describe("isCustomProjectColor", () => {
    it("returns false for preset hex (case-insensitive)", () => {
      for (const c of PROJECT_PRESET_COLORS) {
        expect(isCustomProjectColor(c.hex)).toBe(false);
        expect(isCustomProjectColor(c.hex.toUpperCase())).toBe(false);
      }
    });

    it("returns true for non-preset hex", () => {
      expect(isCustomProjectColor("#000000")).toBe(true);
      expect(isCustomProjectColor("#abcdef")).toBe(true);
    });
  });
});
