/**
 * Pure state transitions for the per-workstream tile layout mode (focus,
 * fullscreen, side-by-side). Kept free of React so the mode logic can be
 * unit-tested without rendering the tile tree.
 *
 * Each function returns a *new* object with the same shape as the input,
 * preserving any extra fields the caller's state carries (tiles, etc.).
 */

/**
 * How side-by-side splits the space: `vertical` puts the two tiles next to
 * each other (a vertical divider), `horizontal` stacks them (a horizontal one).
 */
export type SideBySideOrientation = "vertical" | "horizontal";

/** The first tile's share of the space, kept so neither tile can vanish. */
export const MIN_SPLIT = 0.15;
export const MAX_SPLIT = 0.85;
export const DEFAULT_SPLIT = 0.5;

export interface TileLayoutModeSlice {
  tileOrder: string[];
  focusedIndex: number;
  fullscreenTileId: string | null;
  selectedForSideBySide: Set<string>;
  sideBySideTileIds: string[] | null;
  sbsSelectionMode: boolean;
  /** Absent means vertical, the original mode. */
  sideBySideOrientation?: SideBySideOrientation;
  /** The first tile's share; absent means an even split. Kept across entries. */
  sideBySideSplit?: number;
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
export function shiftSelectTile<T extends TileLayoutModeSlice>(
  state: T,
  tileId: string,
  orientation: SideBySideOrientation = "vertical",
): T {
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
    sideBySideOrientation: orientation,
    selectedForSideBySide: new Set<string>(),
    sbsSelectionMode: false,
    fullscreenTileId: null,
  };
}

/**
 * A side-by-side button (one per orientation). Pressing the button of the
 * active split exits it; the other button switches the active split to its
 * orientation. With no split, it toggles picking two tiles in its orientation
 * (the other button while picking just changes the orientation).
 */
export function toggleSideBySideMode<T extends TileLayoutModeSlice>(state: T, orientation: SideBySideOrientation): T {
  const current = state.sideBySideOrientation ?? "vertical";
  if (state.sideBySideTileIds) {
    if (current === orientation) {
      return { ...state, sideBySideTileIds: null, selectedForSideBySide: new Set<string>(), sbsSelectionMode: false };
    }
    return { ...state, sideBySideOrientation: orientation };
  }
  if (state.sbsSelectionMode && current === orientation) {
    return { ...state, sbsSelectionMode: false, selectedForSideBySide: new Set<string>() };
  }
  return { ...state, sbsSelectionMode: true, sideBySideOrientation: orientation };
}

export function clampSplit(split: number): number {
  if (!Number.isFinite(split)) return DEFAULT_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split));
}

/** Dragging the divider: the first tile's new share. */
export function resizeSideBySide<T extends TileLayoutModeSlice>(state: T, split: number): T {
  return { ...state, sideBySideSplit: clampSplit(split) };
}

/** The split for a pointer at `pointer` in a container starting at `start`, `size` long. */
export function splitFromPointer(pointer: number, start: number, size: number): number {
  if (!(size > 0)) return DEFAULT_SPLIT;
  return clampSplit((pointer - start) / size);
}

/**
 * The side-by-side a click on a tile asks for: Shift-click puts it next to
 * the focused tile, Option(Alt)-click above/below it. Both modifiers together
 * are ambiguous, so neither.
 */
export function sideBySideForClick(e: { shiftKey: boolean; altKey: boolean }): SideBySideOrientation | null {
  if (e.shiftKey === e.altKey) return null;
  return e.shiftKey ? "vertical" : "horizontal";
}
