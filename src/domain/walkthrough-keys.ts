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
 *
 * {@link WALKTHROUGH_KEY_BINDINGS} is the single source of truth for these
 * keys, and user-facing shortcut documentation is generated from it.
 */

export type WalkthroughKeyAction = "next" | "prev" | "out" | "first" | "last" | "resync";

export interface WalkthroughKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * One walkthrough step command, together with every key that triggers it.
 *
 * `letter` entries are matched case-insensitively so Caps Lock doesn't
 * silently disable them; literal keys such as `"Home"` are matched exactly as
 * the browser reports them.
 */
export interface WalkthroughKeyBinding {
  /** Keys that trigger the action; letter keys are listed lowercase. */
  keys: readonly string[];
  /** True when the keys are letters and should be matched case-insensitively. */
  letter?: boolean;
  /** Human-readable combo label for documentation, e.g. `"ArrowDown / Space / J / N"`. */
  combo: string;
  /** User-facing description of what pressing the key does. */
  description: string;
  /** The step action dispatched when one of the keys fires. */
  action: WalkthroughKeyAction;
}

export const WALKTHROUGH_KEY_BINDINGS: readonly WalkthroughKeyBinding[] = [
  {
    keys: ["ArrowDown", "ArrowRight", " "],
    combo: "ArrowDown / ArrowRight / Space",
    description: "Advance to the next step of the walkthrough",
    action: "next",
  },
  {
    keys: ["j", "n"],
    letter: true,
    combo: "J / N",
    description: "Advance to the next step without leaving the home row",
    action: "next",
  },
  {
    keys: ["ArrowUp", "ArrowLeft"],
    combo: "ArrowUp / ArrowLeft",
    description: "Go back to the previous step of the walkthrough",
    action: "prev",
  },
  {
    keys: ["k", "p"],
    letter: true,
    combo: "K / P",
    description: "Go back to the previous step without leaving the home row",
    action: "prev",
  },
  {
    keys: ["Home"],
    combo: "Home",
    description: "Jump back to the first step of the walkthrough",
    action: "first",
  },
  {
    keys: ["End"],
    combo: "End",
    description: "Jump ahead to the last step of the walkthrough",
    action: "last",
  },
  {
    keys: ["o"],
    letter: true,
    combo: "O",
    description: "Step out of the current function, as a debugger would",
    action: "out",
  },
  {
    keys: ["r"],
    letter: true,
    combo: "R",
    description: "Re-sync the editor with the step you are currently on",
    action: "resync",
  },
];

const literalKeyActions = new Map<string, WalkthroughKeyAction>();
const letterKeyActions = new Map<string, WalkthroughKeyAction>();
for (const binding of WALKTHROUGH_KEY_BINDINGS) {
  const target = binding.letter ? letterKeyActions : literalKeyActions;
  for (const key of binding.keys) target.set(key, binding.action);
}

export function parseWalkthroughKey(event: WalkthroughKeyEvent): WalkthroughKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  return literalKeyActions.get(event.key) ?? letterKeyActions.get(event.key.toLowerCase()) ?? null;
}
