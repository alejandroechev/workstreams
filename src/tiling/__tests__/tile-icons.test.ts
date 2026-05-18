import { describe, it, expect } from "vitest";
import { TILE_ICONS, defaultIconForType, resolveTileIcon } from "../tile-icons";
import type { TileType } from "../../domain/types";

describe("tile-icons", () => {
  it("exports a Heroicon component for every TileIconKey", () => {
    for (const key of Object.keys(TILE_ICONS) as Array<keyof typeof TILE_ICONS>) {
      expect(typeof TILE_ICONS[key]).toBe("object"); // forwardRef components are objects
    }
  });

  it.each<[TileType, string]>([
    ["copilot_session", "session"],
    ["terminal", "terminal"],
    ["file_explorer", "folder"],
    ["file_viewer", "document"],
    ["doc_viewer", "document"],
    ["code_viewer", "code"],
    ["session_meta", "info"],
    ["workbench", "beaker"],
  ])("defaultIconForType(%s) = %s", (type, expected) => {
    expect(defaultIconForType(type)).toBe(expected);
  });

  it("resolveTileIcon uses config override when valid", () => {
    expect(resolveTileIcon("copilot_session", "bug")).toBe(TILE_ICONS.bug);
  });

  it("resolveTileIcon falls back to default for invalid override", () => {
    expect(resolveTileIcon("copilot_session", "nonexistent")).toBe(TILE_ICONS.session);
  });

  it("resolveTileIcon falls back to default when override is null/undefined", () => {
    expect(resolveTileIcon("terminal", undefined)).toBe(TILE_ICONS.terminal);
    expect(resolveTileIcon("terminal", null)).toBe(TILE_ICONS.terminal);
  });
});
