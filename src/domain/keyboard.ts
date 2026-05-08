import type { TileType, Direction } from "./types";

export type KeyAction =
  | { type: "escape" }
  | { type: "switchWorkstream"; index: number }
  | { type: "navigate"; direction: Direction }
  | { type: "addTile"; tileType: TileType }
  | { type: "closeTile" }
  | { type: "toggleFullscreen" }
  | { type: "focusTile"; index: number }
  | { type: "quickSearch" };

/**
 * Returns true if the active element is an input, textarea, select, or xterm terminal.
 */
export function shouldSwallowKeyEvent(activeElement: Element | null): boolean {
  if (!activeElement) return false;
  const tag = activeElement.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (activeElement.closest(".xterm")) return true;
  return false;
}

export interface ParseKeyActionOpts {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  activeElement: Element | null;
}

/**
 * Maps a keyboard event to a semantic action.
 * All app-level commands use Alt+ prefix to avoid conflicts with
 * terminal (Ctrl+C/V/etc) and editor (Ctrl+F/P/etc) shortcuts.
 */
export function parseKeyAction(opts: ParseKeyActionOpts): KeyAction | null {
  const { altKey, key } = opts;

  // Escape always works
  if (key === "Escape") {
    return { type: "escape" };
  }

  // All app commands use Alt+ — works even when terminal/input is focused
  if (altKey) {
    switch (key) {
      // Navigation
      case "ArrowLeft":
        return { type: "navigate", direction: "left" };
      case "ArrowRight":
        return { type: "navigate", direction: "right" };
      case "ArrowUp":
        return { type: "navigate", direction: "up" };
      case "ArrowDown":
        return { type: "navigate", direction: "down" };
      // Tile creation
      case "n":
        return { type: "addTile", tileType: "terminal" };
      case "s":
        return { type: "addTile", tileType: "copilot_session" };
      case "e":
        return { type: "addTile", tileType: "file_explorer" };
      // Tile management
      case "w":
        return { type: "closeTile" };
      case "f":
        return { type: "toggleFullscreen" };
      case "p":
        return { type: "quickSearch" };
    }

    // Alt+1-9 switches workstreams
    if (key >= "1" && key <= "9") {
      return { type: "switchWorkstream", index: parseInt(key) - 1 };
    }
  }

  return null;
}
