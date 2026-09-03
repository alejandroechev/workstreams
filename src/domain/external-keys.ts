/**
 * Shortcuts the app documents to users but does not dispatch itself.
 *
 * Everything here is owned by a third party — Monaco's own keybindings, a
 * browser/OS gesture, or a tile's local handler — so none of it reaches
 * {@link parseKeyAction} in `./keyboard`. They still belong in the user-facing
 * cheat sheet: a reader does not care which layer implements a key, only that
 * pressing it works. Keeping them in a registry rather than only in prose is
 * what stops the reference from drifting out of date.
 *
 * {@link EXTERNAL_KEY_BINDINGS} is the single source of truth for these keys,
 * and user-facing shortcut documentation is generated from it, so every entry
 * must carry a description written for a reader, not a restatement of the
 * combo.
 *
 * The shape deliberately mirrors `KeyBinding` in `./keyboard` and
 * `WalkthroughKeyBinding` in `./walkthrough-keys`, plus a {@link
 * ExternalKeyBinding.surface} field so the generated reference can group the
 * entries and make clear they are not dispatched by `parseKeyAction`.
 */

/** The component that owns and implements an external shortcut. */
export type ExternalKeySurface =
  | "Monaco editor"
  | "Repo Explorer"
  | "File editor"
  | "Tile shell";

/** One documented shortcut that some surface other than the app handles. */
export interface ExternalKeyBinding {
  /** Stable identifier, used to reference the entry from generated docs. */
  id: string;
  /** Human-readable combo label, e.g. `"Ctrl+Shift+F"`. */
  combo: string;
  /** Equivalent combo on macOS, when it differs from {@link combo}. */
  macCombo?: string;
  /** User-facing description of what pressing the combo does. */
  description: string;
  /** The surface that owns the key; used to group the generated reference. */
  surface: ExternalKeySurface;
}

export const EXTERNAL_KEY_BINDINGS: readonly ExternalKeyBinding[] = [
  {
    id: "save-file",
    combo: "Ctrl+S",
    macCombo: "Cmd+S",
    description:
      "Save the file you are editing, whether that is a file editor tab or an unstaged diff edit, straight to the working file",
    surface: "File editor",
  },
  {
    id: "quick-open-filename",
    combo: "Ctrl+P",
    description:
      "Jump to a file by typing part of its name, without walking the folder tree",
    surface: "Repo Explorer",
  },
  {
    id: "find-in-file",
    combo: "Ctrl+F",
    description: "Find and highlight text inside the file currently open in the editor",
    surface: "Monaco editor",
  },
  {
    id: "search-all-files",
    combo: "Ctrl+Shift+F",
    description:
      "Search the whole repository for a string, with optional case-sensitive or regular expression matching",
    surface: "Repo Explorer",
  },
  {
    id: "toggle-markdown-preview",
    combo: "Ctrl+Shift+V",
    description:
      "Flip a markdown file between the rendered preview and the raw editor, matching VS Code",
    surface: "File editor",
  },
  {
    id: "dismiss-overlay",
    combo: "Escape",
    description:
      "Leave fullscreen, close the open modal, dismiss a context menu or search overlay, or release focus from a terminal",
    surface: "Tile shell",
  },
];
