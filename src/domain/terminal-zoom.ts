/**
 * Pure helpers for terminal-tile font-size zooming.
 *
 * Keyboard shortcuts handled by the host tile:
 *   Ctrl+=   → increase by 1
 *   Ctrl+-   → decrease by 1
 *   Ctrl+0   → reset to default
 *
 * The range and default are deliberately conservative — xterm.js scales
 * fine outside this band but the FitAddon math gets noisy and ergonomics
 * suffer.
 */

export const TERMINAL_DEFAULT_FONT_SIZE = 13;
export const TERMINAL_MIN_FONT_SIZE = 8;
export const TERMINAL_MAX_FONT_SIZE = 28;

export type ZoomAction = "inc" | "dec" | "reset";

/**
 * Map a `Ctrl+<key>` event to a zoom action, or null when the keystroke
 * isn't one of ours. `key` is `KeyboardEvent.key`. Both `=` and `+` map
 * to "inc" so users don't have to hold Shift on a US layout.
 */
export function keyToZoomAction(key: string): ZoomAction | null {
  if (key === "=" || key === "+") return "inc";
  if (key === "-" || key === "_") return "dec";
  if (key === "0") return "reset";
  return null;
}

/**
 * Compute the next font size for a given action, clamped to the allowed
 * range. Pure and deterministic — used by both Terminal and Copilot
 * Session tiles so the zoom behaves the same way in both.
 */
export function nextFontSize(current: number, action: ZoomAction): number {
  const safe = Number.isFinite(current) ? current : TERMINAL_DEFAULT_FONT_SIZE;
  switch (action) {
    case "inc":
      return Math.min(TERMINAL_MAX_FONT_SIZE, safe + 1);
    case "dec":
      return Math.max(TERMINAL_MIN_FONT_SIZE, safe - 1);
    case "reset":
      return TERMINAL_DEFAULT_FONT_SIZE;
  }
}
