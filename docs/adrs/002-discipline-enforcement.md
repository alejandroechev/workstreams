# ADR-002: Discipline Enforcement via 5-Layer Defense

**Date**: 2026-05-12
**Status**: Accepted

## Context

The AGENTS.md describes strict workflow rules: TDD, ≥90% coverage, E2E tests, CLI scenarios, docs sync, ADRs for major decisions. In practice, the agent (Copilot CLI) routinely drifted during dogfooding — prioritizing velocity over discipline. By the end of weeks of intensive feature work, many new modules lacked tests, no ADRs had been written, no visual validation had been performed.

The honest assessment: **rules in markdown are not enforcement**. We need mechanisms that make compliance the path of least resistance, and non-compliance harder than compliance.

## Decision

Implement a 5-layer defense for dev discipline that combines:

1. **CDP-based visual validation** — Programmatic screenshots of the running Tauri app
2. **Native git hooks** — Block at commit/push boundaries
3. **Copilot CLI extension** — Real-time nudges via lifecycle hooks
4. **SQLite triggers** — Automatic todo enforcement at the data layer
5. **Session-start audit** — Periodic self-check on every CLI session

Each layer is designed to be independently useful even if others fail or are bypassed.

## Architecture

### Layer 1: CDP Visual Validation

**Script**: `scripts/cdp-validate.mjs`

Uses Playwright's `chromium.connectOverCDP("http://localhost:9222")` to:
- Connect to the running Tauri app (requires `--remote-debugging-port=9222` in `tauri.conf.json`)
- Take a screenshot to `screenshots/<feature>-<timestamp>.png`
- Capture page console errors and `pageerror` events
- Exit 0 on clean console, 2 on console errors, 1 on connection failure

**Usage**: Run before claiming a UI feature is done. Invoked by pre-push hook for UI changes.

### Layer 2: Git Hooks (Hard Gates)

**Pre-commit** (`.git/hooks/pre-commit`): Fast checks (~10s total)
- `tsc --noEmit`
- `eslint src`
- `vitest run --coverage` (90% threshold)
- `cargo check` (warnings = errors)
- `cargo fmt --check`
- `scripts/check-test-files.mjs` — every staged source file needs a test

**Pre-push** (`.git/hooks/pre-push`): Slower, more thorough
- `cargo clippy`
- **Smart doc gate**: >200 lines of `src/` or `src-tauri/src/` changed without a touch to `README.md`, `docs/system-diagram.md`, or `docs/adrs/` → block (bypass: `[no-docs: <reason>]` commit footer)
- **CDP visual validation**: changes in `src/tiles/`, `src/tiling/`, or `src/workstream/` require Tauri running on CDP port 9222 and clean console (bypass: `[no-cdp: <reason>]`)
- Playwright E2E if `tests/e2e/*.spec.ts` exist

### Layer 3: Copilot CLI Extension

**Location**: `.github/extensions/discipline-guardian/`

Auto-loaded by Copilot CLI from project's `.github/extensions/`. Implements:

| Hook | Purpose |
|------|---------|
| `onSessionStart` | (1) Run `install-triggers.py` to install SQLite triggers in `session.db`. (2) Run `scripts/discipline-audit.mjs` and inject the report as `additionalContext` so the agent sees status at session start. |
| `onPostToolUse` (edit/create) | Track source vs test vs doc edits. Inject warnings when ratios degrade (>5 source edits per test edit; >10 source edits without doc updates). |
| `onUserPromptSubmitted` | Match done/complete/finished/ready keywords → inject Definition of Done checklist as `additionalContext`. |
| `onPostToolUse` (bash/powershell with `git commit`) | Inject reminder to run `cdp-validate.mjs` for UI commits. |

**Why extension over conscience rule**: Programmatic, auto-runs at session start, lives in repo, version-controlled, can install database triggers as a side effect of session start.

**Note on `onPreToolUse` limitation**: This hook does NOT fire reliably for `powershell` tool calls (verified empirically). Use `onPostToolUse` for edit/create — those fire reliably.

### Layer 4: SQLite Triggers (auto-installed by Layer 3)

Installed in `~/.copilot/session-state/<sessionId>/session.db` by the extension's `onSessionStart`:

**Trigger 1: auto_inject_feature_todos**
```sql
AFTER INSERT ON todos
WHEN NEW.category = 'feature' AND NEW.parent_id IS NULL
BEGIN
  -- Insert 3 sub-todos: <id>-test, <id>-visual, <id>-docs
  -- Insert todo_deps linking parent → 3 children
END
```

**Trigger 2: block_done_with_pending_children**
```sql
BEFORE UPDATE OF status ON todos
WHEN NEW.status = 'done' AND child status != 'done'
BEGIN
  SELECT RAISE(ABORT, 'Cannot mark done: children pending');
END
```

**Convention**: Plan-mode feature todos use `category='feature'`. The triggers handle the rest automatically. Non-feature todos default to `category='impl'` and are not subject to auto-injection or done-blocking.

**Why triggers over scripts**: Database-level enforcement is unbypassable from the SQL tool. The agent cannot work around it without external manual intervention.

**Constraint**: The MCP `sql` tool splits multi-statement SQL on `;`, so triggers cannot be created via that interface. The extension installs them via `python -c` which has no such limitation. This is the reason for `install-triggers.py`.

### Layer 4b: Plan tracking schema + auto-rollover (added 2026-05-13)

Building on Layer 4's triggers, we added first-class plan tracking. Previously, todos accumulated as a flat list without grouping. The model now has:

**Schema additions** (in `install-triggers.py`, idempotent):

```sql
CREATE TABLE plans (
  id TEXT PRIMARY KEY,                 -- e.g., "plan-2026-05-13 15:48:44"
  title TEXT,
  status TEXT CHECK(status IN ('active', 'superseded', 'completed', 'abandoned')),
  created_at TEXT,
  superseded_at TEXT,
  superseded_by TEXT REFERENCES plans(id),
  plan_md_snapshot TEXT
);

CREATE TABLE current_plan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  plan_id TEXT NOT NULL REFERENCES plans(id)
);

ALTER TABLE todos ADD COLUMN plan_id TEXT REFERENCES plans(id);
-- Status CHECK constraint updated to include 'archived'
```

**Trigger 3: auto_tag_plan_id** — Every INSERT into todos gets its `plan_id` automatically set to whatever `current_plan` points to (if not specified by the caller).

**Trigger 4: maybe_rollover_plan** — Detects plan boundaries from activity patterns instead of relying on external signals. Fires AFTER INSERT when:
1. The current plan has at least one `done` todo (i.e., real work happened), AND
2. The last activity in the current plan was >15 minutes before the new INSERT's `created_at`

When both conditions hold, the trigger:
- Marks the current plan as `superseded`
- Archives the old plan's pending/in_progress todos (`status='archived'`)
- Creates a new plan with id derived from `NEW.created_at`
- Updates `current_plan` pointer
- Tags the just-inserted todo with the new plan

**Why activity-gap heuristic over `[[PLAN]]` detection**: The DB has no access to user prompts. Activity patterns are reliable signals. After the first rollover in a batch, the new current_plan has no `done` todos, so the WHEN clause goes false and subsequent INSERTs in the same batch don't trigger duplicate rollovers.

**Plan.md archival** is handled separately by the extension's `start-plan.py` script when it detects the `[[PLAN]]` prefix. The two systems are deliberately decoupled — DB handles structural data, extension handles prose files.

### Layer 5: Session-Start Audit

Same `onSessionStart` hook in the extension. Runs `scripts/discipline-audit.mjs` and injects its output as `additionalContext`. The audit reports:

- Source files changed in the last 7 days without corresponding test changes
- Source files changed without doc updates
- Time since last CDP screenshot
- Uncommitted source files without test changes
- Open feature todos with pending children

**Why session-start over `manage_schedule`**: More deterministic. Fires on `startup`, `resume`, `new` session events without depending on a scheduled job that may not survive CLI restarts.

## Consequences

### Positive
- Drift becomes harder than compliance
- Multiple reinforcing layers — even partial bypass leaves trace through other layers
- Feature todos enforce themselves via the database
- Visual validation becomes routine, not exceptional
- Documentation gets touched (or the agent has to explicitly bypass)

### Negative
- Initial overhead: extension load + audit script run on every session start (~2s)
- Pre-push slowness: cargo clippy + CDP validation can add 30-60s
- Friction for non-feature work: developers must remember to use `category='impl'` (the default) or `category='feature'` deliberately

### Bypass Discipline
The intent is **rare, explicit, justified bypass**, not common shortcut:

- `[no-docs: <reason>]` — for refactors that genuinely don't need docs
- `[no-cdp: <reason>]` — for backend-only changes that don't affect UI
- `// @test-skip: <reason>` — for files where unit testing isn't meaningful

All bypasses leave a trace in commit history or source code, making patterns auditable.

## Validation

The first test of this system is the **fullscreen tile yellow border** feature (see `plan.md`). It's deliberately small, UI-visible, and exercises every layer:

1. Insert todo with `category='feature'` → Layer 4 auto-creates 3 children
2. Edit `src/tiling/Tile.tsx` → Layer 3 tracks edit; Layer 2 pre-commit demands test file
3. Write test → Layer 2 pre-commit demands ≥90% coverage
4. Try to mark feature done while children pending → Layer 4 blocks
5. Run `cdp-validate.mjs` → captures screenshot of yellow border
6. Mark all children done → Layer 4 permits marking feature done
7. Push → Layer 2 runs clippy, checks doc gate, runs CDP validation
8. Next session → Layer 5 audit reports clean state

If any layer fails to enforce, the ADR's claims are wrong and the layer needs fixing.

## References

- AGENTS.md — Updated to document the layered enforcement
- `.github/extensions/discipline-guardian/` — Extension implementation
- `scripts/cdp-validate.mjs` — Visual validation script
- `scripts/discipline-audit.mjs` — Audit script
- `.git/hooks/pre-commit` and `.git/hooks/pre-push` — Git hook implementations
