---
name: cdp-validate
description: >-
  Validate a workstreams feature against the real running Tauri app via CDP
  (Chrome DevTools Protocol). Spawns or reuses cargo tauri dev with an
  isolated dev DB, runs a Playwright protocol, captures console errors and a
  screenshot, and records a visual proof row. Use when a feature's
  <id>-visual sub-todo needs to be closed. Trigger phrases: "cdp validate",
  "visual validate", "validate feature visually", "run cdp on <feature>".
---

# CDP Validate — Per-Feature Visual Validation

Runs a feature's visual validation protocol against the running Tauri app and
produces a recorded screenshot proof. The discipline system uses this proof
to allow the `<feature-id>-visual` sub-todo to be marked done.

## When to invoke

- After implementing a feature, before marking its `<id>-visual` sub-todo done.
- When the user asks "did you verify this visually?" / "run CDP on X".
- When the discipline audit warns about a stale screenshot for a recently
  modified UI area.

## Prerequisites

This skill assumes you are in the `workstreams` repo (or one set up the same
way). Required:

1. `scripts/cdp-feature.mjs`, `scripts/cdp-utils.mjs`, `scripts/dev-seed.mjs`
2. `e2e/features/` folder with at least `_generic.mjs`
3. `better-sqlite3` installed (`npm install` does this)
4. Rust + Tauri toolchain installed (only required when cold-spawning)
5. `WORKSTREAMS_DB_PATH` env support in the Rust backend (`db::resolve_db_path`)
6. `src-tauri/tauri.conf.dev.json` overlay that enables `additionalBrowserArgs`
   with `--remote-debugging-port=9222` (CDP is dev-only — production builds
   omit it entirely so dev and prod never conflict)

## Standard protocol

### 1. Identify the feature id

The feature id is the SQL todo id (e.g. `markdown-mermaid`,
`md-view-component`). For multi-todo features, use the parent feature todo id.

### 2. Check for a feature-specific protocol

Look at `e2e/features/<feature-id>.mjs`. If absent:

- For simple "open file + screenshot" features, the generic protocol is fine.
- For features requiring interaction (clicks, typing, navigation), scaffold a
  new protocol file using the example below.

Protocol contract:

```js
// e2e/features/<feature-id>.mjs
export async function run({ page, screenshot }) {
  // page: Playwright Page connected to the live Tauri app
  // screenshot(name?): captures into screenshots/<feature-id>/
  await page.locator('[data-testid="tile-explorer"]').first().waitFor();
  // ... interact ...
  await screenshot();
}
```

Available data-testids in the workstreams app:

| testid | element |
|---|---|
| `workstream-item` | sidebar workstream row (also `data-workstream-id`) |
| `tile-explorer` | Explorer tile container |
| `file-tree-item` | file/folder row (also `data-path`) |
| `markdown-content` | MarkdownView root |
| `mermaid-diagram` | MermaidDiagram wrapper |

### 3. Run the runner

```bash
node scripts/cdp-feature.mjs <feature-id> [--cold] [--no-seed] --todo-id <feature-id>-visual
```

Or via npm:

```bash
npm run cdp:feature -- <feature-id> --todo-id <feature-id>-visual
```

Flags:

- `--cold`: kill any reused dev instance and respawn (slow but reproducible).
- `--no-seed`: skip the dev DB / showcase seeder.
- `--todo-id <id>`: insert a `visual_proofs` row keyed to that todo id (this is
  what unblocks the discipline gate). Usually `<feature-id>-visual`.

### 4. Interpret the result

The runner prints a summary:

```
Feature: markdown-mermaid
Screenshot: screenshots/markdown-mermaid/markdown-mermaid.png
Console errors: 0
Page errors: 0
Result: ✅ PASS
```

- **PASS (exit 0)**: a screenshot was saved, zero console + page errors.
  The runner inserts a `visual_proofs` row, and you can now mark the
  `<feature-id>-visual` todo done.
- **FAIL (exit 1)**: errors captured, or no screenshot taken. Investigate the
  error list printed before the summary, fix the issue, rerun.

### 5. Close the visual sub-todo

```sql
UPDATE todos SET status='done' WHERE id='<feature-id>-visual';
```

The discipline-guardian hook verifies a matching `visual_proofs` row exists
and that the referenced screenshot file is present on disk.

## Troubleshooting

**Cold start hangs**: first `cargo tauri dev` takes ~5 minutes. The runner
polls for 6 minutes before timing out. Watch the `cargo tauri dev` output for
real errors. Subsequent runs reuse the live process.

**Reuse failure (page unresponsive)**: rerun with `--cold` to respawn.

**Stale dev DB after schema migration**: `npm run dev:reset` removes the
entire `.dev/` folder.

**Port :9222 in use by Chrome**: close Chrome with remote debugging or pick a
different port (currently hardcoded — extend cdp-utils.mjs if needed).

**Selector not found**: the feature relies on a `data-testid` that doesn't
exist yet. Add the testid to the relevant component, then rerun.

## Notes for agents

- Do **not** test against the production app (default DB path). Always run
  via `WORKSTREAMS_DB_PATH=.dev/workstreams-dev.db` — the runner does this
  automatically for cold spawns; reused dev instances already have it.
- A passing CDP run is the **only** way to legitimately close a
  `<id>-visual` sub-todo. The discipline hook will block manual UPDATE
  attempts otherwise.
- Screenshots accumulate in `screenshots/<feature-id>/`. They are
  gitignored — clean up locally as needed (`npm run dev:reset` does not
  touch them; remove the folder manually if desired).
