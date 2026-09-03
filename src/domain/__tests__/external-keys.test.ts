import { describe, it, expect } from "vitest";
import { EXTERNAL_KEY_BINDINGS } from "../external-keys";

describe("EXTERNAL_KEY_BINDINGS", () => {
  it("is non-empty", () => {
    expect(EXTERNAL_KEY_BINDINGS.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = EXTERNAL_KEY_BINDINGS.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique combos", () => {
    const combos = EXTERNAL_KEY_BINDINGS.map((binding) => binding.combo);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it("gives every entry a non-empty description and owning surface", () => {
    for (const binding of EXTERNAL_KEY_BINDINGS) {
      expect(binding.description.trim().length).toBeGreaterThan(0);
      expect(binding.surface.trim().length).toBeGreaterThan(0);
    }
  });

  it("describes each entry for a user rather than restating the combo", () => {
    for (const binding of EXTERNAL_KEY_BINDINGS) {
      expect(binding.description).not.toBe(binding.combo);
      expect(binding.description).not.toBe(binding.id);
    }
  });

  it.each([
    "Ctrl+S",
    "Ctrl+P",
    "Ctrl+F",
    "Ctrl+Shift+F",
    "Ctrl+Shift+V",
    "Escape",
  ])("documents %s", (combo) => {
    expect(EXTERNAL_KEY_BINDINGS.map((binding) => binding.combo)).toContain(combo);
  });

  it("records the macOS equivalent for the save shortcut", () => {
    const save = EXTERNAL_KEY_BINDINGS.find((binding) => binding.combo === "Ctrl+S");
    expect(save?.macCombo).toBe("Cmd+S");
  });

  it("groups entries under a small set of owning surfaces", () => {
    const surfaces = new Set(EXTERNAL_KEY_BINDINGS.map((binding) => binding.surface));
    expect(surfaces.has("Monaco editor")).toBe(true);
    expect(surfaces.has("Repo Explorer")).toBe(true);
    expect(surfaces.has("Tile shell")).toBe(true);
  });
});
