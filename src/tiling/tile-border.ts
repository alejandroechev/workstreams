/**
 * Pure helper to compute the tile border style.
 *
 * Border priority:
 * 1. Fullscreen → yellow (takes precedence; user needs to know it's fullscreen)
 * 2. Focused → blue
 * 3. Default → grey thin
 *
 * Activity / "working" state is intentionally NOT reflected in the border.
 * It's surfaced via the in-header status badge (colored dot + label).
 */
export interface TileBorderState {
  isFullscreen: boolean;
  isFocused: boolean;
}

export const TILE_BORDER_FULLSCREEN = "#f9e2af";
export const TILE_BORDER_FOCUSED = "#89b4fa";
export const TILE_BORDER_IDLE = "#313244";

export function computeTileBorder(state: TileBorderState): string {
  if (state.isFullscreen) {
    return `2px solid ${TILE_BORDER_FULLSCREEN}`;
  }
  if (state.isFocused) {
    return `2px solid ${TILE_BORDER_FOCUSED}`;
  }
  return `1px solid ${TILE_BORDER_IDLE}`;
}
