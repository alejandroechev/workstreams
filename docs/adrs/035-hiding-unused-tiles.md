---
id: "035"
status: Accepted
date: 2026-10-09
---

# ADR 035: Hiding the Code Review, Code Walkthrough and Goal Loop tiles

## Status

Accepted (2026-10-09). Hidden, not deleted. Extends the sunset-flag pattern of
[ADR 028](028-sunsetting-the-task-board.md) and amends
[ADR 010](010-feature-flags.md).

## Context

The owner does not use three of the tiles: Code Review
([ADR 014](014-code-review-tile.md)), Code Walkthrough, and Goal Loop
([ADR 021](021-manual-coding-goal-loop.md)). They still cost space in the add-tile
menu and keep three shortcuts live.

The Settings modal also still showed a **Devlog export** tab, although the task
board it exports from has been hidden since ADR 028.

Code Walkthrough was already behind the `debug-walkthrough` flag. But that flag
was governed by `VITE_ENABLE_OPTIONAL_FEATURES`, which the owner's `.env.local`
sets to 1, so it was on for the one person who wanted it off. ADR 028 calls this
exact trap the reason sunset flags exist.

## Decision

- **One sunset flag per tile**, each with its own variable and off by default
  everywhere:

  | Flag | Variable | Tile |
  |---|---|---|
  | `code-review` | `VITE_ENABLE_CODE_REVIEW` | `code_review` |
  | `debug-walkthrough` | `VITE_ENABLE_WALKTHROUGH` | `debug_walkthrough` |
  | `goal-loop` | `VITE_ENABLE_GOAL_LOOP` | `loop_control` |

  `debug-walkthrough` moves from the master toggle to its own variable.
  `isTileTypeEnabled(tileType)` in `src/domain/feature-flags.ts` maps each tile
  type to its flag.
- **No way to create one.** The add-tile menu does not list them. `addTile` in
  `App.tsx` refuses a hidden type, so their shortcuts (`Alt+A`, `Alt+D`,
  `Alt+L`) and any other path add nothing. The keymap reference still lists the
  shortcuts, marked with their flag.
- **Saved tiles explain themselves.** A hidden tile already in a saved layout
  renders the disabled-feature placeholder, saying why it is empty and how to
  bring it back. It keeps its close button and never mounts the real tile.
- **Devlog export follows Tasks.** Its settings tab appears only when the
  `tasks` flag is on. The setting itself is kept.

## Consequences

- Nothing is deleted. Code, tests, Rust commands, review comments, loop
  definitions and runs, and the devlog setting all stay. To bring a feature
  back, set its variable to 1 in `.env.local` and rebuild.
- Unit and E2E suites still exercise the hidden tiles: specs force flags on
  through `__WS_FEATURE_FLAGS__`, as the task-board specs do.
  `e2e/tests/hidden-tiles.spec.ts` covers the shipped default (no menu entry,
  shortcuts inert, saved tiles show the placeholder).
- With every current flag now a sunset flag, `VITE_ENABLE_OPTIONAL_FEATURES`
  governs nothing today. It is kept for the next unfinished feature.
- Skills that drive these tiles (for example the project's `code-review` skill)
  have nothing to drive while the flags are off.
