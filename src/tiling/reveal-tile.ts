/** The layout bits of a workstream's state that decide which tile is visible. */
export interface RevealableState {
  tileOrder: string[];
  focusedIndex: number;
  fullscreenTileId: string | null;
  selectedForSideBySide: Set<string>;
  sideBySideTileIds: string[] | null;
  sbsSelectionMode: boolean;
}

/**
 * Focuses `tileId` and leaves fullscreen and side-by-side, which could
 * otherwise hide it (ADR 041: opening an agent message). Null when the tile
 * isn't in this workstream.
 */
export function revealTile<S extends RevealableState>(state: S, tileId: string): S | null {
  const index = state.tileOrder.indexOf(tileId);
  if (index < 0) return null;
  return {
    ...state,
    focusedIndex: index,
    fullscreenTileId: null,
    selectedForSideBySide: new Set<string>(),
    sideBySideTileIds: null,
    sbsSelectionMode: false,
  };
}
