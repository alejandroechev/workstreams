/**
 * Pure state transitions for the per-workstream tile layout mode (focus,
 * fullscreen, side-by-side). Kept free of React so the mode logic can be
 * unit-tested without rendering the tile tree.
 *
 * Each function returns a *new* object with the same shape as the input,
 * preserving any extra fields the caller's state carries (tiles, etc.).
 */

export interface TileLayoutModeSlice {
  tileOrder: string[];
  focusedIndex: number;
  fullscreenTileId: string | null;
  selectedForSideBySide: Set<string>;
  sideBySideTileIds: string[] | null;
  sbsSelectionMode: boolean;
}

/**
 * Toggle fullscreen for a specific tile. Re-selecting the already-fullscreen
 * tile exits fullscreen; selecting any other tile enters fullscreen for it,
 * focuses it, and clears any active/pending side-by-side so the modes don't
 * conflict.
 */
export function toggleFullscreenForTile<T extends TileLayoutModeSlice>(state: T, tileId: string): T {
  if (state.fullscreenTileId === tileId) {
    return { ...state, fullscreenTileId: null };
  }
  const idx = state.tileOrder.indexOf(tileId);
  return {
    ...state,
    fullscreenTileId: tileId,
    focusedIndex: idx >= 0 ? idx : state.focusedIndex,
    sideBySideTileIds: null,
    selectedForSideBySide: new Set<string>(),
    sbsSelectionMode: false,
  };
}

/**
 * Shift-click on a tile → enter side-by-side with the currently-focused
 * tile (left pane) and the shift-clicked tile (right pane). Order follows
 * `tileOrder` so the earlier-in-order tile is always the left pane.
 *
 * If the clicked tile is the focused one (or there's no valid focus), this
 * is just a focus change — no side-by-side is entered.
 */
export function shiftSelectTile<T extends TileLayoutModeSlice>(state: T, tileId: string): T {
  const focusedTileId = state.tileOrder[state.focusedIndex];
  if (!focusedTileId || focusedTileId === tileId) {
    const idx = state.tileOrder.indexOf(tileId);
    return { ...state, focusedIndex: idx >= 0 ? idx : state.focusedIndex };
  }
  const ids = state.tileOrder.filter((id) => id === focusedTileId || id === tileId);
  if (ids.length !== 2) return state;
  return {
    ...state,
    sideBySideTileIds: ids,
    selectedForSideBySide: new Set<string>(),
    sbsSelectionMode: false,
    fullscreenTileId: null,
  };
}
