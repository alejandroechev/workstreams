# ADR 010 — Feature flags for optional tiles

## Status

Accepted (2026-06-08).

## Context

Some tiles depend on user-specific Copilot CLI infrastructure that is not part
of the public release path:

- **Diff Review tile** — relies on the user-level `diff-grok` skill (only
  installed under `~/.copilot/skills/diff-grok/`), plus an MCP bridge that
  speaks back to the Tauri app. Other users of the app don't have either.
- **Plan tile** — reads the linked Copilot session's `plans` / `todos` /
  `todo_deps` tables, which are populated by the `discipline-guardian`
  extension (also user-level). Without that extension, the plan tab just
  shows empty rows.

We need a way to ship the app to other users with these tiles hidden, while
keeping them fully functional in the maintainer's local builds.

## Decision

A **build-time** feature-flag module keyed off a Vite env var.

- `src/domain/feature-flags.ts` exposes `isFeatureEnabled(id)` /
  `featureDescriptor(id)` with two flags today: `"diff-review"` and
  `"plan-tile"`.
- The master toggle is `VITE_ENABLE_OPTIONAL_FEATURES`. `"1"` enables every
  optional flag; anything else disables them all.
- Local dev/release builds set the var in `.env.local` (gitignored;
  `.env.local.example` ships as a template).
- CI release pipeline doesn't set the var, so the public NSIS/MSI shipped
  from `ci-release.yml` defaults to all optional features off.

## Where flags are consulted

| Surface | Behavior when off |
|---|---|
| `StatusBar` Add Tile menu | Plan / Diff Review entries filtered out entirely. |
| `Tile.tsx` render path | If a workstream layout still has a persisted plan / diff_review tile, the tile renders a `DisabledFeaturePlaceholder` body (yellow heading + grey note) instead of mounting `PlanTile` / `DiffReviewTile`. The tile chrome (title bar, close button) stays intact so the user can dismiss it. |
| Keyboard shortcuts (`Alt+P`, `Alt+G`) | Left active. Advanced users who know the shortcut can still type it; the spawned tile renders the same placeholder. Trade-off chosen to keep `keyboard.ts` agnostic of features. |
| `diff-grok` skill auto-spawn path | Left active. If the skill is installed and plans a review, it can still pop a tile — this only fails in the placeholder path if the user happens to not have the skill anyway. |

## What's intentionally not done

- **No runtime toggle** in Settings. We considered adding a SQLite-backed
  switch users could flip after install, but the goal is to ship a clean
  release where the features simply don't exist — not to surface a "you're
  missing infrastructure" preference in the UI.
- **No Cargo `--features`**. The Rust backend commands these tiles use
  (`list_session_plans`, `query_session_db_table`, etc.) are harmless on
  their own and used by other tiles too. Compile-time elimination would
  cost more in test/dev complexity than it saves in binary size.
- **No per-flag overrides** at runtime. `isFeatureEnabled` is a single
  master toggle today. The `_setFeatureFlagOverrideForTests` helper exists
  only so unit tests can flip both states. If we ever need per-flag user
  overrides, the registry already supports it structurally — just extend
  `isFeatureEnabled` to consult per-id state.

## Adding a new flag

1. Add a new id to the `FeatureId` union + `FEATURES` map in
   `src/domain/feature-flags.ts`.
2. Wherever the gated UI is mounted, call `isFeatureEnabled("your-flag")`.
3. If it's a tile type, also add a guard in `Tile.tsx` that renders
   `DisabledFeaturePlaceholder` when off, and filter the StatusBar menu
   entry the same way Plan / Diff Review are filtered.

## Consequences

- Public release defaults to a smaller surface area (8 tile types) without
  losing any code paths — the gated tiles' modules are still imported and
  bundled, just unreachable. Bundle-size impact is small (~50–100 KB) and
  worth the simplicity.
- Maintainer's local releases are unchanged: drop a one-line `.env.local`
  and everything works as before.
- Existing layouts that persist a `plan` / `diff_review` tile across a
  user upgrading to a gated build don't crash — the placeholder pattern
  keeps state intact and reversible.
