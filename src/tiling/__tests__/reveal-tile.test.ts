import { describe, it, expect } from "vitest";
import { revealTile } from "../reveal-tile";

const state = {
  tileOrder: ["a", "b", "c"],
  focusedIndex: 0,
  fullscreenTileId: "a",
  selectedForSideBySide: new Set(["a", "b"]),
  sideBySideTileIds: ["a", "b"],
  sbsSelectionMode: true,
};

describe("revealing a tile", () => {
  it("focuses it and leaves fullscreen and side-by-side, so it is visible", () => {
    const next = revealTile(state, "c")!;
    expect(next).toMatchObject({ focusedIndex: 2, fullscreenTileId: null, sideBySideTileIds: null, sbsSelectionMode: false });
    expect(next.selectedForSideBySide.size).toBe(0);
  });

  it("returns null for a tile that isn't in the workstream", () => {
    expect(revealTile(state, "nope")).toBeNull();
  });
});
