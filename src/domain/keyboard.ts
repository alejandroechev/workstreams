import { getMonacoIfLoaded } from "../files/loadMonaco";
import type { TileType, Direction } from "./types";

export type KeyAction =
  | { type: "escape" }
  | { type: "navigate"; direction: Direction }
  | { type: "addTile"; tileType: TileType; extraConfig?: Record<string, string> }
  | { type: "closeTile" }
  | { type: "toggleFullscreen" }
  | { type: "toggleSideBySide" }
  | { type: "focusTile"; index: number };

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

type MonacoTextFocusEditor = {
  hasTextFocus?: () => boolean;
};

type MonacoEditorRegistry = {
  getEditors?: () => MonacoTextFocusEditor[];
};

const tileCreationShortcutKeys = new Set(["b", "c", "g", "m", "p", "r", "t", "w"]);

function isAltTileCreationShortcut(altKey: boolean, key: string): boolean {
  return altKey && tileCreationShortcutKeys.has(key.toLowerCase());
}

function isMonacoFocused(activeElement: Element | null): boolean {
  const monaco = getMonacoIfLoaded();
  const editorRegistry = monaco?.editor as MonacoEditorRegistry | undefined;
  if (editorRegistry?.getEditors) {
    try {
      for (const editor of editorRegistry.getEditors()) {
        if (editor.hasTextFocus?.()) return true;
      }
    } catch {
      // Fall through to the DOM containment check.
    }
  }

  let el: Element | null = activeElement ?? document.activeElement;
  while (el) {
    if (el.classList?.contains("monaco-editor")) return true;
    if ((el as HTMLElement).dataset?.fileEditorRoot === "true") return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Maps a keyboard event to a semantic action.
 * All app-level commands use Alt+ prefix to avoid conflicts with
 * terminal (Ctrl+C/V/etc) and editor (Ctrl+F/P/etc) shortcuts.
 *
 * Tile-creation shortcuts:
 *   Alt+C  copilot_session
 *   Alt+T  terminal (PowerShell)
 *   Alt+W  terminal with shell=wsl
 *   Alt+R  file_explorer (Repo Explorer)
 *   Alt+M  session_meta
 *   Alt+B  workbench
 *   Alt+P  plan
 *   Alt+G  diff_review
 *
 * Tile management:
 *   Alt+Q  close focused tile
 *   Alt+F  toggle fullscreen
 *   Alt+S  toggle side-by-side (when exactly 2 tiles are selected)
 *   Alt+ArrowKeys  navigate between tiles
 */
export function parseKeyAction(opts: ParseKeyActionOpts): KeyAction | null {
  const { altKey, key } = opts;

  if (isAltTileCreationShortcut(altKey, key) && isMonacoFocused(opts.activeElement)) {
    return null;
  }

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
      case "t":
        return { type: "addTile", tileType: "terminal" };
      case "w":
        return { type: "addTile", tileType: "terminal", extraConfig: { shell: "wsl" } };
      case "c":
        return { type: "addTile", tileType: "copilot_session" };
      case "r":
        return { type: "addTile", tileType: "file_explorer" };
      case "m":
        return { type: "addTile", tileType: "session_meta" };
      case "b":
        return { type: "addTile", tileType: "workbench" };
      case "p":
        return { type: "addTile", tileType: "plan" };
      case "g":
        return { type: "addTile", tileType: "diff_review" };
      // Tile management
      case "q":
        return { type: "closeTile" };
      case "f":
        return { type: "toggleFullscreen" };
      case "s":
        return { type: "toggleSideBySide" };
    }
  }

  return null;
}
