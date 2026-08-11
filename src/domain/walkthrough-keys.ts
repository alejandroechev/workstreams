/**
 * Keyboard control for stepping a code walkthrough.
 *
 * These are *unmodified* keys, active only while the walkthrough tile has
 * focus. That is deliberate: the app's own commands all use `Alt+<key>`, so a
 * bare key cannot collide with them, and requiring focus means the shortcuts
 * never fire while the user is typing in another tile.
 *
 * Any modifier disqualifies a key outright. `Alt+Arrows` moves focus between
 * tiles and `Cmd+R` reloads — stealing either would break navigation the user
 * relies on everywhere else in the app.
 */

export type WalkthroughKeyAction = "next" | "prev" | "out" | "first" | "last" | "resync";

export interface WalkthroughKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function parseWalkthroughKey(event: WalkthroughKeyEvent): WalkthroughKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  switch (event.key) {
    case "ArrowDown":
    case "ArrowRight":
    case " ":
      return "next";
    case "ArrowUp":
    case "ArrowLeft":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      break;
  }

  // Letter keys are matched case-insensitively so Caps Lock doesn't silently
  // disable them. Vim-style j/k sit alongside n/p for step next/previous.
  switch (event.key.toLowerCase()) {
    case "j":
    case "n":
      return "next";
    case "k":
    case "p":
      return "prev";
    case "o":
      // "out", matching the debugger convention users already know.
      return "out";
    case "r":
      return "resync";
    default:
      return null;
  }
}
