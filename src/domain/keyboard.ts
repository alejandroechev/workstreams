import { getMonacoIfLoaded } from "../files/loadMonaco";
import { shortcutLabel } from "./platform";
import type { TileType, Direction } from "./types";

/**
 * Identifier of an entry in the status bar's "+ Add tile" menu.
 *
 * Binding these to the shortcut registry keeps the in-app cheat sheet from
 * drifting away from the generated shortcut reference.
 */
export type StatusBarMenuKey =
  | "session"
  | "terminal"
  | "wsl"
  | "explorer"
  | "meta"
  | "workbench"
  | "plan"
  | "code-review"
  | "walkthrough"
  | "loop";

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
  /**
   * Physical key identifier (`KeyboardEvent.code`, e.g. `"KeyT"`). Optional so
   * existing callers/tests that only pass `key` keep working.
   *
   * Required for correctness on macOS: Option+<letter> applies the special
   * character layer before the event is dispatched, so Option+T arrives with
   * `key === "†"`, not `"t"`. `code` is layout-independent.
   */
  code?: string;
  activeElement: Element | null;
}

/**
 * The letter a shortcut should be matched against.
 *
 * Prefers the physical key (`code`) whenever Alt is held, because macOS
 * rewrites `key` for every Option+<letter> combination. Falls back to `key`
 * so Windows/Linux behaviour — and any caller that doesn't supply `code` —
 * is unchanged.
 */
export function shortcutKey(opts: {
  altKey: boolean;
  key: string;
  code?: string;
}): string {
  if (opts.altKey && opts.code) {
    const physical = /^Key([A-Z])$/.exec(opts.code);
    if (physical) return physical[1].toLowerCase();
  }
  return opts.key;
}

type MonacoTextFocusEditor = {
  hasTextFocus?: () => boolean;
};

type MonacoEditorRegistry = {
  getEditors?: () => MonacoTextFocusEditor[];
};

/**
 * One app-level keyboard shortcut.
 *
 * `key` is matched against the value produced by {@link shortcutKey}, which on
 * macOS resolves Option+<letter> back to the physical letter. Keying the
 * registry on the produced character instead would break every shortcut there.
 */
export interface KeyBinding {
  /** Key to match, as normalised by {@link shortcutKey} (e.g. `"t"`, `"ArrowLeft"`, `"Escape"`). */
  key: string;
  /** True when Alt (Option on macOS) must be held. */
  altKey: boolean;
  /** Human-readable combo label, e.g. `"Alt+T"`. */
  combo: string;
  /** User-facing description of what the shortcut does. */
  description: string;
  /** The action dispatched when the combo fires. */
  action: KeyAction;
  /** True for shortcuts that create a tile; these are suppressed while Monaco has text focus. */
  tileCreation?: boolean;
  /**
   * The "+ Add tile" menu entry this shortcut belongs to. Set on every
   * tile-creation binding so the menu can read its label from here.
   */
  menuKey?: StatusBarMenuKey;
  /**
   * Feature flag gating the equivalent menu entry. Per ADR 010 the keyboard
   * handler stays active even when the menu item is hidden, so this is
   * documentation metadata only — it never suppresses the binding.
   */
  featureFlag?: string;
}

/**
 * The single source of truth for the app's keyboard shortcuts. User-facing
 * shortcut documentation is generated from this list, so every entry must
 * carry a description written for a reader, not a restatement of the action.
 */
export const APP_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    key: "Escape",
    altKey: false,
    combo: "Escape",
    description: "Dismiss the open overlay or clear the current selection",
    action: { type: "escape" },
  },
  {
    key: "ArrowLeft",
    altKey: true,
    combo: "Alt+ArrowLeft",
    description: "Move focus to the tile on the left",
    action: { type: "navigate", direction: "left" },
  },
  {
    key: "ArrowRight",
    altKey: true,
    combo: "Alt+ArrowRight",
    description: "Move focus to the tile on the right",
    action: { type: "navigate", direction: "right" },
  },
  {
    key: "ArrowUp",
    altKey: true,
    combo: "Alt+ArrowUp",
    description: "Move focus to the tile above",
    action: { type: "navigate", direction: "up" },
  },
  {
    key: "ArrowDown",
    altKey: true,
    combo: "Alt+ArrowDown",
    description: "Move focus to the tile below",
    action: { type: "navigate", direction: "down" },
  },
  {
    key: "t",
    altKey: true,
    combo: "Alt+T",
    description: "Add a terminal tile running your default shell",
    action: { type: "addTile", tileType: "terminal" },
    tileCreation: true,
    menuKey: "terminal",
  },
  {
    key: "w",
    altKey: true,
    combo: "Alt+W",
    description: "Add a terminal tile running WSL (Windows only)",
    action: { type: "addTile", tileType: "terminal", extraConfig: { shell: "wsl" } },
    tileCreation: true,
    menuKey: "wsl",
  },
  {
    key: "c",
    altKey: true,
    combo: "Alt+C",
    description: "Add a Copilot session tile to chat with the agent",
    action: { type: "addTile", tileType: "copilot_session" },
    tileCreation: true,
    menuKey: "session",
  },
  {
    key: "r",
    altKey: true,
    combo: "Alt+R",
    description: "Add a Repo Explorer tile to browse and open project files",
    action: { type: "addTile", tileType: "file_explorer" },
    tileCreation: true,
    menuKey: "explorer",
  },
  {
    key: "m",
    altKey: true,
    combo: "Alt+M",
    description: "Add a session metadata tile showing details of the active session",
    action: { type: "addTile", tileType: "session_meta" },
    tileCreation: true,
    menuKey: "meta",
  },
  {
    key: "b",
    altKey: true,
    combo: "Alt+B",
    description: "Add a workbench tile for scratch notes and quick actions",
    action: { type: "addTile", tileType: "workbench" },
    tileCreation: true,
    menuKey: "workbench",
  },
  {
    key: "p",
    altKey: true,
    combo: "Alt+P",
    description: "Add a plan tile to track the steps of the current piece of work",
    action: { type: "addTile", tileType: "plan" },
    tileCreation: true,
    menuKey: "plan",
    featureFlag: "plan-tile",
  },
  {
    key: "a",
    altKey: true,
    combo: "Alt+A",
    description: "Add a code review tile to inspect pending changes",
    action: { type: "addTile", tileType: "code_review" },
    tileCreation: true,
    menuKey: "code-review",
  },
  {
    key: "d",
    altKey: true,
    combo: "Alt+D",
    description: "Add a debug walkthrough tile to step through a recorded trace",
    action: { type: "addTile", tileType: "debug_walkthrough" },
    tileCreation: true,
    menuKey: "walkthrough",
    featureFlag: "debug-walkthrough",
  },
  {
    key: "l",
    altKey: true,
    combo: "Alt+L",
    description: "Add a loop control tile to drive an automated agent loop",
    action: { type: "addTile", tileType: "loop_control" },
    tileCreation: true,
    menuKey: "loop",
  },
  {
    key: "q",
    altKey: true,
    combo: "Alt+Q",
    description: "Close the focused tile",
    action: { type: "closeTile" },
  },
  {
    key: "f",
    altKey: true,
    combo: "Alt+F",
    description: "Expand the focused tile to fill the workspace, or restore it",
    action: { type: "toggleFullscreen" },
  },
  {
    key: "s",
    altKey: true,
    combo: "Alt+S",
    description: "Show the two selected tiles side by side, or restore the layout",
    action: { type: "toggleSideBySide" },
  },
];

const tileCreationShortcutKeys = new Set(
  APP_KEY_BINDINGS.filter((binding) => binding.tileCreation).map((binding) => binding.key),
);

/** Every "+ Add tile" menu entry, in the order the menu renders them. */
export const STATUS_BAR_MENU_KEYS: readonly StatusBarMenuKey[] = [
  "session",
  "terminal",
  "wsl",
  "explorer",
  "meta",
  "workbench",
  "plan",
  "code-review",
  "walkthrough",
  "loop",
];

const bindingsByMenuKey = new Map<StatusBarMenuKey, KeyBinding>(
  APP_KEY_BINDINGS.filter((binding) => binding.menuKey).map((binding) => [
    binding.menuKey as StatusBarMenuKey,
    binding,
  ]),
);

/**
 * The platform-formatted shortcut label for a "+ Add tile" menu entry, e.g.
 * `"Alt+C"` on Windows and `"⌥C"` on macOS.
 *
 * The menu reads its labels from here so the in-app cheat sheet cannot drift
 * from the generated shortcut reference.
 */
export function shortcutForMenuKey(menuKey: StatusBarMenuKey): string | undefined {
  const binding = bindingsByMenuKey.get(menuKey);
  if (!binding) return undefined;
  return shortcutLabel(binding.key.toUpperCase());
}

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
 * On macOS the same combos are typed with Option. Because Option+<letter>
 * rewrites `event.key` into a special character ("†" for Option+T), matching
 * goes through `shortcutKey`, which prefers the layout-independent
 * `event.code`.
 *
 * Tile-creation shortcuts are suppressed while a Monaco editor has text focus,
 * so typing in a file editor never spawns a tile.
 *
 * The combos themselves are not listed here: {@link APP_KEY_BINDINGS} is the
 * single source of truth, and user-facing shortcut documentation is generated
 * from it.
 */
export function parseKeyAction(opts: ParseKeyActionOpts): KeyAction | null {
  const { altKey } = opts;
  const key = shortcutKey(opts);

  if (isAltTileCreationShortcut(altKey, key) && isMonacoFocused(opts.activeElement)) {
    return null;
  }

  const binding = APP_KEY_BINDINGS.find(
    // Alt-free bindings (Escape) fire whatever the Alt state, as before.
    (candidate) => candidate.key === key && (!candidate.altKey || altKey),
  );
  return binding ? binding.action : null;
}

export interface PlainEnterCommitOpts {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** True while an IME candidate window is open; Enter then picks a candidate. */
  isComposing?: boolean;
}

/**
 * True when Enter on a single-line input should commit its value.
 *
 * Any modifier disqualifies it: Shift+Enter is a deliberate "don't submit"
 * gesture, and Cmd/Ctrl/Alt+Enter belong to other commands. IME composition
 * disqualifies it too, because that Enter is choosing a candidate, not
 * finishing the entry.
 */
export function isPlainEnterCommit(opts: PlainEnterCommitOpts): boolean {
  if (opts.key !== "Enter") return false;
  if (opts.isComposing) return false;
  return !opts.shiftKey && !opts.metaKey && !opts.ctrlKey && !opts.altKey;
}
