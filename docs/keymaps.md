<!--
  AUTO-GENERATED — do not edit by hand.
  Sources of truth: src/domain/keyboard.ts, src/domain/walkthrough-keys.ts,
  src/domain/external-keys.ts
  Regenerate: node scripts/gen-keymaps.mjs
-->

# Keyboard shortcuts

Every keyboard shortcut the app documents, generated from the binding
registries. Edit the registries, not this file.

<!-- BEGIN GENERATED KEYMAPS -->

## Application shortcuts

Dispatched by `parseKeyAction` in `src/domain/keyboard.ts`. On macOS the `Alt+`
combos are typed with Option.

| Keys | Description | Action |
| --- | --- | --- |
| `Escape` | Dismiss the open overlay or clear the current selection | `escape` |
| `Alt+ArrowLeft` | Move focus to the tile on the left | `navigate (left)` |
| `Alt+ArrowRight` | Move focus to the tile on the right | `navigate (right)` |
| `Alt+ArrowUp` | Move focus to the tile above | `navigate (up)` |
| `Alt+ArrowDown` | Move focus to the tile below | `navigate (down)` |
| `Alt+T` | Add a terminal tile running your default shell | `addTile (terminal)` |
| `Alt+W` | Add a terminal tile running WSL (Windows only) | `addTile (terminal) [shell: wsl]` |
| `Alt+C` | Add a Copilot session tile to chat with the agent | `addTile (copilot_session)` |
| `Alt+R` | Add a Repo Explorer tile to browse and open project files | `addTile (file_explorer)` |
| `Alt+M` | Add a session metadata tile showing details of the active session | `addTile (session_meta)` |
| `Alt+B` | Add a workbench tile for scratch notes and quick actions | `addTile (workbench)` |
| `Alt+P` | Add a plan tile to track the steps of the current piece of work _(feature-flagged: `plan-tile`)_ | `addTile (plan)` |
| `Alt+A` | Add a code review tile to inspect pending changes | `addTile (code_review)` |
| `Alt+D` | Add a debug walkthrough tile to step through a recorded trace _(feature-flagged: `debug-walkthrough`)_ | `addTile (debug_walkthrough)` |
| `Alt+L` | Add a loop control tile to drive an automated agent loop | `addTile (loop_control)` |
| `Alt+Q` | Close the focused tile | `closeTile` |
| `Alt+F` | Expand the focused tile to fill the workspace, or restore it | `toggleFullscreen` |
| `Alt+S` | Show the two selected tiles side by side, or restore the layout | `toggleSideBySide` |

## Walkthrough navigation

Unmodified keys, active only while a debug walkthrough tile has focus.

| Keys | Description | Action |
| --- | --- | --- |
| `ArrowDown / ArrowRight / Space` | Advance to the next step of the walkthrough | `next` |
| `J / N` | Advance to the next step without leaving the home row | `next` |
| `ArrowUp / ArrowLeft` | Go back to the previous step of the walkthrough | `prev` |
| `K / P` | Go back to the previous step without leaving the home row | `prev` |
| `Home` | Jump back to the first step of the walkthrough | `first` |
| `End` | Jump ahead to the last step of the walkthrough | `last` |
| `O` | Step out of the current function, as a debugger would | `out` |
| `R` | Re-sync the editor with the step you are currently on | `resync` |

## Externally-owned shortcuts

Documented for the reader but implemented by another surface — Monaco, a
tile's own handler, or the OS — so they never reach `parseKeyAction`.

| Keys | macOS | Description | Owning surface |
| --- | --- | --- | --- |
| `Ctrl+S` | `Cmd+S` | Save the file you are editing, whether that is a file editor tab or an unstaged diff edit, straight to the working file | File editor |
| `Ctrl+P` | — | Jump to a file by typing part of its name, without walking the folder tree | Repo Explorer |
| `Ctrl+F` | — | Find and highlight text inside the file currently open in the editor | Monaco editor |
| `Ctrl+Shift+F` | — | Search the whole repository for a string, with optional case-sensitive or regular expression matching | Repo Explorer |
| `Ctrl+Shift+V` | — | Flip a markdown file between the rendered preview and the raw editor, matching VS Code | File editor |
| `Escape` | — | Leave fullscreen, close the open modal, dismiss a context menu or search overlay, or release focus from a terminal | Tile shell |

<!-- END GENERATED KEYMAPS -->
