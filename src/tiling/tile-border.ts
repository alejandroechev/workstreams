/**
 * Pure helper to compute the tile border style based on tile state.
 *
 * Border priority:
 * 1. Fullscreen → yellow (visually distinct, takes precedence)
 * 2. Focused + working → green thick
 * 3. Focused → blue thick
 * 4. Working (unfocused) → green thin
 * 5. Default → grey thin
 */
export interface TileBorderState {
  isFullscreen: boolean;
  isFocused: boolean;
  isWorking: boolean;
}

export const TILE_BORDER_FULLSCREEN = "#f9e2af";
export const TILE_BORDER_FOCUSED = "#89b4fa";
export const TILE_BORDER_WORKING = "#a6e3a1";
export const TILE_BORDER_IDLE = "#313244";

export function computeTileBorder(state: TileBorderState): string {
  if (state.isFullscreen) {
    return `2px solid ${TILE_BORDER_FULLSCREEN}`;
  }
  if (state.isFocused) {
    return `2px solid ${state.isWorking ? TILE_BORDER_WORKING : TILE_BORDER_FOCUSED}`;
  }
  return `1px solid ${state.isWorking ? TILE_BORDER_WORKING : TILE_BORDER_IDLE}`;
}
