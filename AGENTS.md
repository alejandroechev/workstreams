# Workstreams

## Description

Workstream manager with tiling compositor for Copilot CLI — manage projects, persist sessions, embed terminals with adaptive tiling layouts, code viewers, and doc viewers.

## Code Implementation Flow

### Pre-Development
- **Read ADRs** Before starting any development work, read all Architecture Decision Records in `docs/adrs/` to understand existing design decisions and constraints. Do not contradict or duplicate existing ADRs without explicit user approval.

### ⚠️ Process safety — never kill by name
- The dev build (`cargo tauri dev`) and the production build both ship as
  `workstreams.exe` (Cargo derives the binary name from the package name).
  The user usually has the production app running locally.
- **Never** run `Stop-Process -Name workstreams`, `taskkill /IM workstreams.exe`,
  or any other name-based termination. Doing so will kill the user's
  production app and any work in flight there.
- To stop the dev instance spawned by `scripts/cdp-feature.mjs`, run
  `npm run dev:kill`. It reads `.dev/dev.pids` and uses `taskkill /T /PID`
  on that specific PID only after verifying CDP :9223 is alive.
- The same rule applies to `cargo`, `cargo-tauri`, `rustc`, and `link.exe`:
  always kill by explicit PID, never by name.

### Architecture
- **TypeScript + Rust** Use TypeScript for the frontend (React) and Rust for the backend (Tauri). Domain logic that doesn't need native APIs should live in TypeScript.
- **Domain Logic Separation** Separate domain logic from UI. Core workstream/tile/session management should be testable without rendering.
- **CLI** Always implement a CLI with feature parity to UI layer. This is a tool for you as an agent to validate your work.
- **Tauri** Desktop app built with Tauri v2 framework.
- **Language Convention** UI text visible to users is in English. All code (variables, functions, types, comments), documentation, and test descriptions must be in English.
- **UI Iconography** For web/desktop interfaces, use **Heroicons** via `@heroicons/react` instead of emoji or raw Unicode glyphs for buttons, navigation, banners, and status chips. Keep icon choices consistent through a shared `src/ui/components/icons.tsx` mapping/helper.
- **In-Memory Stubs for External Integrations** For every external service integration (databases, APIs, third-party services), implement an in-memory stub that conforms to the same interface. Use a provider/factory that auto-selects the real implementation when credentials are configured, and falls back to the in-memory stub when they are not. This ensures E2E tests, CLI validation, and local development work fully offline without external dependencies.

### Git Workflow
- **Work directly on master** — solo developer, no branch overhead
- **Commit after every completed unit of work** — never leave working code uncommitted
- **Push after each work session** — remote backup is non-negotiable. Remote for this repo at https://github.com/alejandroechev/workstreams.git
- **Tag milestones**: `git tag v0.1.0-mvp` when deploying or reaching a checkpoint
- **Branch only for risky experiments** you might discard — delete after merge or abandon

### Coding — TDD Workflow (strict, per-function)

1. **RED** — Write a failing test FIRST. Run it. Confirm it fails. Show the failure output.
2. **GREEN** — Write the MINIMUM implementation code to make the test pass. Run the test. Confirm it passes.
3. **REFACTOR** — Clean up if needed. Run the test again to confirm it still passes.
4. Repeat for the next behavior/function.

### Coding — E2E and CLI Tests (per-feature, not batched)

For every user-facing feature, before considering it complete:
- **E2E Test** — Write a Playwright E2E test that exercises the feature end-to-end. Run it. Confirm it passes.
- **CLI Scenario** — Write a CLI scenario AND execute it using the CLI. Confirm the output matches expectations.

### Testing Pyramid (all three levels required)

```
┌─────────────────────────────┐
│  CDP + Playwright on Tauri  │  ← Catches real runtime bugs
│  (Desktop)                  │    (white screens, plugin issues)
├─────────────────────────────┤
│  Playwright on Dev Server   │  ← Fast CI, tests React UI flows
│  (localhost:1420)           │    (90%+ coverage of user interactions)
├─────────────────────────────┤
│  Vitest Unit Tests          │  ← Domain logic, store ops,
│  (InMemoryStore)            │    components, hooks (≥90% coverage)
└─────────────────────────────┘
```

### Validation — Automated Enforcement (5-Layer Defense)

See `docs/adrs/002-discipline-enforcement.md` for the full design rationale.

1. **CDP visual validation** — `scripts/cdp-validate.mjs` connects to Tauri via port 9222, screenshots, fails on console errors. Used by pre-push and as `npm run validate-feature <name>`.

2. **Git hooks** (`.git/hooks/`):
   - **Pre-commit (fast)**: `tsc --noEmit` + `eslint` + `vitest run --coverage` (90% threshold) + `cargo check` (warnings=errors) + `cargo fmt --check` + test-file-exists
   - **Pre-push (slow)**: `cargo clippy` + smart doc gate (>200 lines source → require doc touch or `[no-docs: reason]` bypass) + CDP visual validation for UI changes (require Tauri running + clean console, or `[no-cdp: reason]` bypass) + Playwright E2E

3. **Discipline Guardian extension** (`.github/extensions/discipline-guardian/`):
   - `onSessionStart`: Installs SQLite triggers + runs `scripts/discipline-audit.mjs` and injects results
   - `onPostToolUse` (edit/create): Tracks source/test/doc edit ratios, injects warnings when ratio degrades
   - `onUserPromptSubmitted`: Intercepts done/complete/finished keywords, injects Definition of Done checklist
   - `onPostToolUse` (git commit): Reminds to run CDP validation after UI commits

4. **SQLite triggers** (auto-installed by extension):
   - `auto_inject_feature_todos`: Inserting a todo with `category='feature'` auto-creates test/visual/docs sub-todos + dependencies
   - `block_done_with_pending_children`: Marking a parent `done` is blocked while child deps are not all done
   - `auto_tag_plan_id`: Every new todo automatically gets the current `plan_id` from `current_plan`
   - `maybe_rollover_plan`: Detects plan boundaries from activity patterns (>15min gap + completed work in old plan). Auto-supersedes the old plan and archives its pending todos.

**Plan tracking model**: The `plans` and `current_plan` tables track which todos belong to which plan. Use `INSERT INTO todos (...)` as normal — `plan_id` is auto-populated. When you start a meaningfully new plan after a work gap, the rollover trigger fires automatically. Plan.md snapshots are archived to `~/.copilot/session-state/<id>/plan-history/` by the extension when it detects `[[PLAN]]` in your prompt.

5. **Session-start audit**: Same extension runs `scripts/discipline-audit.mjs` at every session start. Reports missing tests, missing docs, stale screenshots, pending feature children.

**Test file requirement**: Every changed source file must have a corresponding test (`__tests__/X.test.ts(x)` for TS, `#[cfg(test)]` block for Rust). Skip exceptions: type-only files, configs, CSS, `__tests__/` themselves, `main.rs`, or `// @test-skip: <reason>` marker in first 5 lines.

**Feature todo convention**: When planning new feature work, insert the todo with `category='feature'`. The SQLite trigger automatically creates 3 sub-todos:
- `<id>-test` — TDD: write failing test first
- `<id>-visual` — CDP screenshot + clean console
- `<id>-docs` — README / system-diagram / ADR if applicable

The trigger also blocks marking the parent `done` until all 3 sub-todos are done.

**Bypass mechanisms** (use sparingly):
- `[no-docs: <reason>]` in a commit message → skips smart doc gate
- `[no-cdp: <reason>]` in a commit message → skips CDP visual validation
- `// @test-skip: <reason>` in first 5 lines of source → skips test-file-exists check

### Documentation
- **Docs hierarchy**: ADRs are the source of truth for architecture decisions, README is the public summary that links back to ADRs, and AGENTS.md contains process rules only.
- **README** Update readme file with any relevant public change to the app
- **System Diagram** Keep always up to date a mermaid system level diagram of the app architecture in docs/system-diagram.md
- **ADR** For every major design and architecture decision add an Architecture Decision Record in docs/adrs
- **Docs sync** After every feature or fix, review `git diff --stat` against README.md, `docs/system-diagram.md`, and `docs/adrs/`. Update only what is stale.

### Commit Checklist

Before running `git commit`, verify:
- ⚡ Source files have corresponding test files?
- ⚡ All tests pass with ≥ 90% statement coverage?
- ⚡ Zero type/lint errors?
- [ ] Every new function/component was built with TDD (red → green → refactor)?
- [ ] E2E tests exist for every new user-facing feature?
- [ ] CLI scenarios exist and have been executed for every new feature?
- [ ] **Docs sync** completed?
- [ ] README updated (if public-facing change)?
- [ ] System diagram updated (if architecture changed)?
- [ ] ADR written (if major design decision)?
