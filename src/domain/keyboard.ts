import type { TileType, Direction } from "./types";

export type KeyAction =
  | { type: "escape" }
  | { type: "switchWorkstream"; index: number }
  | { type: "navigate"; direction: Direction }
  | { type: "addTile"; tileType: TileType }
  | { type: "closeTile" }
  | { type: "toggleFullscreen" }
  | { type: "focusTile"; index: number };

/**
 * Returns true if the active element is an input, textarea, select, or xterm terminal.
 * When true, keyboard shortcuts should not be intercepted (except Escape and Ctrl combos).
 */
export function shouldSwallowKeyEvent(activeElement: Element | null): boolean {
  if (!activeElement) return false;
  const tag = activeElement.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (activeElement.closest(".xterm")) return true;
  return false;
}

export interface ParseKeyActionOpts {
  ctrlKey: boolean;
  key: string;
  activeElement: Element | null;
}

/**
 * Maps a keyboard event to a semantic action.
 * Returns null if the key combination doesn't map to any action.
 * Pure function with no side effects.
 */
export function parseKeyAction(opts: ParseKeyActionOpts): KeyAction | null {
  const { ctrlKey, key, activeElement } = opts;

  // Escape always works — blurs terminal focus
  if (key === "Escape") {
    return { type: "escape" };
  }

  // Ctrl+1-9 switches workstreams (works even when input is focused)
  if (ctrlKey && key >= "1" && key <= "9") {
    return { type: "switchWorkstream", index: parseInt(key) - 1 };
  }

  // Ctrl+Arrow navigates between tiles (works even when input/terminal is focused)
  if (ctrlKey) {
    switch (key) {
      case "ArrowLeft":
        return { type: "navigate", direction: "left" };
      case "ArrowRight":
        return { type: "navigate", direction: "right" };
      case "ArrowUp":
        return { type: "navigate", direction: "up" };
      case "ArrowDown":
        return { type: "navigate", direction: "down" };
    }
  }

  // All remaining shortcuts are suppressed when an input or terminal is focused
  if (shouldSwallowKeyEvent(activeElement)) {
    return null;
  }

  switch (key) {
    case "n":
      return { type: "addTile", tileType: "terminal" };
    case "v":
      return { type: "addTile", tileType: "file_viewer" };
    case "e":
      return { type: "addTile", tileType: "file_explorer" };
    case "x":
      return { type: "closeTile" };
    case "f":
      return { type: "toggleFullscreen" };
    default:
      if (key >= "1" && key <= "9") {
        return { type: "focusTile", index: parseInt(key) - 1 };
      }
      return null;
  }
}
