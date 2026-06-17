import { describe, it, expect } from "vitest";
import {
  toggleFullscreenForTile,
  shiftSelectTile,
  type TileLayoutModeSlice,
} from "../tile-layout-mode";

function baseState(overrides: Partial<TileLayoutModeSlice> = {}): TileLayoutModeSlice {
  return {
    tileOrder: ["a", "b", "c"],
    focusedIndex: 0,
    fullscreenTileId: null,
    selectedForSideBySide: new Set<string>(),
    sideBySideTileIds: null,
    sbsSelectionMode: false,
    ...overrides,
  };
}

describe("toggleFullscreenForTile", () => {
  it("enters fullscreen for a tile and focuses it", () => {
    const next = toggleFullscreenForTile(baseState(), "c");
    expect(next.fullscreenTileId).toBe("c");
    expect(next.focusedIndex).toBe(2);
  });

  it("exits fullscreen when toggling the already-fullscreen tile", () => {
    const next = toggleFullscreenForTile(baseState({ fullscreenTileId: "b" }), "b");
    expect(next.fullscreenTileId).toBeNull();
  });

  it("switches fullscreen to a different tile", () => {
    const next = toggleFullscreenForTile(baseState({ fullscreenTileId: "a" }), "c");
    expect(next.fullscreenTileId).toBe("c");
  });

  it("clears any active or pending side-by-side", () => {
    const next = toggleFullscreenForTile(
      baseState({
        sideBySideTileIds: ["a", "b"],
        selectedForSideBySide: new Set(["a", "b"]),
        sbsSelectionMode: true,
      }),
      "c",
    );
    expect(next.sideBySideTileIds).toBeNull();
    expect(next.selectedForSideBySide.size).toBe(0);
    expect(next.sbsSelectionMode).toBe(false);
  });

  it("keeps focus unchanged when the tile id is unknown", () => {
    const next = toggleFullscreenForTile(baseState({ focusedIndex: 1 }), "zzz");
    expect(next.fullscreenTileId).toBe("zzz");
    expect(next.focusedIndex).toBe(1);
  });

  it("does not mutate the input state", () => {
    const state = baseState();
    const next = toggleFullscreenForTile(state, "c");
    expect(state.fullscreenTileId).toBeNull();
    expect(next).not.toBe(state);
  });
});

describe("shiftSelectTile", () => {
  it("enters side-by-side with the focused tile and the clicked tile", () => {
    const next = shiftSelectTile(baseState({ focusedIndex: 0 }), "c");
    expect(next.sideBySideTileIds).toEqual(["a", "c"]);
    expect(next.fullscreenTileId).toBeNull();
    expect(next.sbsSelectionMode).toBe(false);
  });

  it("orders panes by tileOrder regardless of which was focused", () => {
    // Focused = c (index 2), shift-click a (index 0) → left should be a.
    const next = shiftSelectTile(baseState({ focusedIndex: 2 }), "a");
    expect(next.sideBySideTileIds).toEqual(["a", "c"]);
  });

  it("is a focus change (no SBS) when clicking the focused tile", () => {
    const next = shiftSelectTile(baseState({ focusedIndex: 1 }), "b");
    expect(next.sideBySideTileIds).toBeNull();
    expect(next.focusedIndex).toBe(1);
  });

  it("exits fullscreen when entering side-by-side", () => {
    const next = shiftSelectTile(baseState({ focusedIndex: 0, fullscreenTileId: "a" }), "b");
    expect(next.sideBySideTileIds).toEqual(["a", "b"]);
    expect(next.fullscreenTileId).toBeNull();
  });

  it("focuses the clicked tile when no valid focus exists", () => {
    const next = shiftSelectTile(baseState({ tileOrder: [], focusedIndex: 0 }), "x");
    expect(next.sideBySideTileIds).toBeNull();
  });

  it("does not mutate the input state", () => {
    const state = baseState();
    const next = shiftSelectTile(state, "c");
    expect(state.sideBySideTileIds).toBeNull();
    expect(next).not.toBe(state);
  });
});
