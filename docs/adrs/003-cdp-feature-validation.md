# ADR-003: Per-Feature CDP Visual Validation

## Status

Accepted — 2026-05

## Context

The AGENTS.md discipline flow requires every feature todo to be visually validated
on the real Tauri app via CDP (Chrome DevTools Protocol). Previously this was
nominal: a `<id>-visual` sub-todo existed, but nothing enforced that a screenshot
of the running app was actually captured. The agent could close the todo without
running anything.

Additionally, validating against the production database polluted user data and
required the user to close their working session.

## Decision

1. **Dev DB isolation.** The Rust backend resolves its SQLite path via
   `db::resolve_db_path()`:
   - `WORKSTREAMS_DB_PATH` env var (if set and non-empty) wins.
   - Otherwise, in debug builds → `./.dev/workstreams-dev.db` (gitignored).
   - Otherwise, release builds → `<data_local_dir>/copilot-desktop/copilot-desktop.db`.

2. **Dev fixtures via `scripts/dev-seed.mjs`.** Idempotently creates a "Showcase"
   workstream and `.dev/showcase/README.md` with markdown content exercising
   every supported feature (headings, lists, tables, code, blockquotes, mermaid).
   Runs only if no workstreams exist yet.

3. **CDP runner — `scripts/cdp-feature.mjs <feature-id>`.** Reuses an existing
   `cargo tauri dev` on CDP :9222 when present; otherwise cold-spawns it with
   `WORKSTREAMS_DB_PATH=.dev/workstreams-dev.db`. Connects Playwright via
   `chromium.connectOverCDP`, runs a protocol, captures console + page errors,
   and writes a screenshot to `screenshots/<feature-id>/<timestamp>.png`
   (gitignored).

4. **Per-feature protocols.** `e2e/features/<feature-id>.mjs` exports
   `run({ page, screenshot })`. If absent, the generic `_generic.mjs` is used
   (screenshot current view). Protocols address elements via `data-testid`
   attributes adopted across tiles and the shared `MarkdownView`/`MermaidDiagram`.

5. **Visual proof recording.** Successful runs insert into the dev DB's
   `visual_proofs(todo_id, feature_id, screenshot_path, console_error_count,
   captured_at)` table. The discipline-guardian extension blocks
   `UPDATE todos SET status='done'` on `*-visual` rows unless a matching
   `visual_proofs` row exists with a screenshot file on disk.

6. **Invocable `cdp-validate` skill.** The agent invokes it autonomously per
   feature to close the loop — no manual user step required.

## Consequences

### Positive

- Dev and production data are completely isolated by default.
- Visual validation is a real gate, not a checkbox.
- The runner is fast on the warm path (Vite HMR keeps the dev process useful
  across many runs).
- Adding a new feature's protocol is a single file in `e2e/features/`.

### Negative

- First `cargo tauri dev` cold start is slow (~5 min). Mitigated by reuse.
- Screenshots are gitignored, so PR reviewers cannot view them directly.
  Acceptable for solo dev; revisit if collaboration grows.
- Filesystem checks live in the extension hook (SQLite triggers cannot read FS).

## Alternatives considered

- **`cfg!(debug_assertions)` only**: rigid (can't override DB path per test
  run). Combined with env var instead.
- **Always cold-spawn**: maximally reproducible but slow. Reuse is the
  pragmatic default; `--cold` flag remains available.
- **Commit baseline screenshots in git**: rejected for repo size; can be
  re-enabled per-feature later.
